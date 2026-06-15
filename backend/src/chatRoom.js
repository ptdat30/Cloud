// =============================================================
// src/chatRoom.js - Durable Object Class: ChatRoom
// =============================================================
//
// *** GIẢI THÍCH KHÁI NIỆM: DURABLE OBJECT LÀ GÌ? ***
//
// Trong mô hình Serverless thông thường, mỗi Worker request là
// STATELESS - tức là không có bộ nhớ chung giữa các request.
// Ví dụ: Request 1 không biết gì về Request 2.
//
// Durable Object giải quyết vấn đề này bằng cách:
//   1. STATE IN-MEMORY: Class này có thể lưu dữ liệu (vd: Map, Set)
//      và dữ liệu đó TỒN TẠI xuyên suốt vòng đời của object.
//   2. SINGLE INSTANCE: Mọi request đến "main-room" đều đi vào
//      CÙNG MỘT instance của class này → state được chia sẻ.
//   3. GEOGRAPHIC COLOCATION: Instance này được "ghim" (pinned) vào
//      một data center cụ thể để đảm bảo tính nhất quán (consistency).
//
// *** GIẢI THÍCH: WEBSOCKET LÀ GÌ? ***
//
// HTTP là giao thức request-response: Client hỏi → Server trả lời → Đóng.
// WebSocket là giao thức kết nối FULL-DUPLEX và LIÊN TỤC:
//   - Bắt đầu bằng HTTP Upgrade Handshake (101 Switching Protocols)
//   - Sau đó kết nối luôn mở, cả client và server đều có thể
//     gửi message BẤT KỲ LÚC NÀO mà không cần "hỏi trước".
//   - Lý tưởng cho các ứng dụng real-time: chat, game, live feed.
//
// =============================================================

export class ChatRoom {
  /**
   * Constructor của Durable Object.
   * @param {DurableObjectState} state - Cung cấp storage API và WebSocket hibernation.
   * @param {object} env               - Bindings (giống trong Worker).
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;

    // ----------------------------------------------------------------
    // Map<WebSocket, string> - Lưu trữ STATE trong bộ nhớ của Durable Object.
    // Key:   WebSocket connection object (đại diện cho một tab trình duyệt)
    // Value: username của người dùng đó
    //
    // Tại sao dùng Map thay vì Array?
    //   → Tra cứu và xóa theo key (websocket) là O(1), hiệu quả hơn.
    //   → Tránh duplicate dễ dàng hơn.
    // ----------------------------------------------------------------
    this.sessions = new Map();
  }

  /**
   * Phương thức fetch() của Durable Object.
   * Cloudflare sẽ route request đến đây sau khi Worker gọi stub.fetch(request).
   */
  async fetch(request) {
    const url = new URL(request.url);
    const username = url.searchParams.get('username')?.trim();

    if (!username) {
      return new Response('Thiếu username', { status: 400 });
    }

    // ----------------------------------------------------------------
    // WebSocket Pair - Cơ chế WebSocket của Cloudflare Workers
    // ----------------------------------------------------------------
    // Không giống Node.js (dùng thư viện ws), Cloudflare dùng
    // WebSocketPair để tạo 2 đầu kết nối liên kết với nhau:
    //   - client: Đầu gửi về cho trình duyệt (thông qua HTTP 101 response)
    //   - server: Đầu giữ lại ở Durable Object để gửi/nhận message
    // ----------------------------------------------------------------
    const [client, server] = Object.values(new WebSocketPair());

    // Kích hoạt "server" end để bắt đầu lắng nghe sự kiện
    this.handleWebSocketSession(server, username);

    // Trả về HTTP 101 Switching Protocols để hoàn tất WebSocket handshake
    // Đây là "upgrade" từ HTTP sang WebSocket protocol
    return new Response(null, {
      status: 101, // Switching Protocols
      webSocket: client,
    });
  }

  // ----------------------------------------------------------------
  // handleWebSocketSession - Xử lý toàn bộ vòng đời của một WebSocket session
  // ----------------------------------------------------------------
  handleWebSocketSession(webSocket, username) {
    // Kích hoạt server-side WebSocket để có thể gửi/nhận message
    webSocket.accept();

    // *** SỰ KIỆN: Kết nối mới ***
    // Thêm user vào danh sách sessions và broadcast cho tất cả
    this.sessions.set(webSocket, username);
    console.log(`[ChatRoom] User "${username}" đã tham gia. Tổng: ${this.sessions.size} người`);

    // Gửi thông báo chào mừng riêng cho người mới vào
    this.sendJSON(webSocket, {
      type: 'welcome',
      message: `Chào mừng "${username}" đến Không Gian Chung!`,
      username,
    });

    // Broadcast danh sách user mới nhất cho TẤT CẢ người đang online
    this.broadcastUserList();

    // ----------------------------------------------------------------
    // *** SỰ KIỆN: Nhận message từ client ***
    // Client có thể gửi message chat lên server
    // ----------------------------------------------------------------
    webSocket.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'chat') {
          // Broadcast tin nhắn chat cho tất cả mọi người
          this.broadcast({
            type: 'chat',
            username,
            message: data.message,
            timestamp: new Date().toISOString(),
          });
        }
      } catch {
        // Bỏ qua message không hợp lệ (không phải JSON)
        console.warn(`[ChatRoom] Message không hợp lệ từ "${username}"`);
      }
    });

    // ----------------------------------------------------------------
    // *** SỰ KIỆN: Ngắt kết nối ***
    // Xảy ra khi user đóng tab, mất mạng, hoặc tắt trình duyệt.
    // Đây là nơi chúng ta "dọn dẹp" state.
    // ----------------------------------------------------------------
    const handleClose = () => {
      // Xóa user khỏi danh sách sessions
      this.sessions.delete(webSocket);
      console.log(`[ChatRoom] User "${username}" đã rời đi. Còn lại: ${this.sessions.size} người`);

      // Broadcast danh sách đã được cập nhật (không còn user này nữa)
      this.broadcastUserList();
    };

    webSocket.addEventListener('close', handleClose);
    webSocket.addEventListener('error', (err) => {
      console.error(`[ChatRoom] Lỗi WebSocket cho "${username}":`, err);
      handleClose();
    });
  }

  // ----------------------------------------------------------------
  // broadcastUserList - Gửi danh sách user hiện tại cho TẤT CẢ client
  // ----------------------------------------------------------------
  // Đây là cốt lõi của tính năng "real-time presence":
  // Mỗi khi ai vào hoặc rời, toàn bộ danh sách được đồng bộ lại.
  // ----------------------------------------------------------------
  broadcastUserList() {
    const userList = [...this.sessions.values()]; // Lấy tất cả usernames
    this.broadcast({
      type: 'user_list',
      users: userList,
      count: userList.length,
    });
  }

  // ----------------------------------------------------------------
  // broadcast - Gửi một object JSON cho TẤT CẢ WebSocket đang kết nối
  // ----------------------------------------------------------------
  broadcast(data) {
    const message = JSON.stringify(data);
    const closedSockets = [];

    for (const [ws] of this.sessions) {
      try {
        ws.send(message);
      } catch {
        // WebSocket đã đóng nhưng chưa kịp kích hoạt sự kiện 'close'
        // Đánh dấu để xóa sau
        closedSockets.push(ws);
      }
    }

    // Dọn dẹp các zombie connections (kết nối đã chết)
    for (const ws of closedSockets) {
      this.sessions.delete(ws);
    }

    // Nếu có zombie bị xóa, broadcast lại danh sách đã clean
    if (closedSockets.length > 0) {
      this.broadcastUserList();
    }
  }

  // ----------------------------------------------------------------
  // sendJSON - Gửi JSON đến một WebSocket cụ thể (private message)
  // ----------------------------------------------------------------
  sendJSON(webSocket, data) {
    try {
      webSocket.send(JSON.stringify(data));
    } catch {
      // Bỏ qua nếu socket đã đóng
    }
  }
}
