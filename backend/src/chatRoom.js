// =============================================================
// src/chatRoom.js - Durable Object: ChatRoom (Game Edition)
// =============================================================
//
// KIẾN TRÚC ANTI-CHEAT:
//   Toàn bộ logic game (cộng coin, kiểm tra đáp án, ghost mode)
//   đều tính toán tại ĐÂY (Backend). Frontend chỉ render kết quả.
//   → Người dùng không thể dùng DevTools hack tiền/HP.
//
// STATE PERSISTENCE:
//   Dùng Transactional Storage API (state.storage.put/get) để
//   lưu {hp, coins, aura} của từng player xuống ổ đĩa Edge.
//   → Dữ liệu tồn tại kể cả khi Durable Object bị evict khỏi RAM.
//
// FLASH EVENTS (DO Alarms):
//   Thay vì setInterval (tốn CPU nền), dùng state.storage.setAlarm()
//   để DO tự "đánh thức" chính nó sau mỗi 45–90 giây.
//   → Hiệu quả hơn, đúng với mô hình Serverless.
//
// =============================================================

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    // Map<WebSocket, PlayerState> — lưu tất cả session đang kết nối
    // PlayerState: { username, hp, coins, aura, x, y, ghostUntil, lastChatTime, lastMoveTime }
    this.sessions = new Map();

    // Flash event đang active (null nếu không có)
    // { type, question, answer, reward, expiresAt, solved }
    this.activeFlashEvent = null;
  }

  // =============================================================
  // fetch() — Xử lý WebSocket Upgrade từ Worker
  // =============================================================
  async fetch(request) {
    const url = new URL(request.url);
    const username = url.searchParams.get('username')?.trim();

    if (!username) return new Response('Thiếu username', { status: 400 });

    const [client, server] = Object.values(new WebSocketPair());

    // Await để đảm bảo player data được load xong trước khi trả 101
    await this.handleSession(server, username);

    return new Response(null, { status: 101, webSocket: client });
  }

  // =============================================================
  // alarm() — DO Alarms callback: tự động kích hoạt Flash Event
  // =============================================================
  // Cloudflare gọi hàm này khi đồng hồ báo thức (alarm) kích hoạt.
  // Không tốn tài nguyên chờ đợi như setInterval — DO chỉ "thức dậy"
  // đúng lúc cần thiết rồi lại ngủ.
  async alarm() {
    // Chỉ bắn event khi có người đang online
    if (this.sessions.size > 0) {
      this.triggerFlashEvent();
    }

    // Lập lịch lần tiếp theo: 45–90 giây ngẫu nhiên
    const nextDelay = 45_000 + Math.floor(Math.random() * 45_000);
    await this.state.storage.setAlarm(Date.now() + nextDelay);
  }

  // =============================================================
  // handleSession() — Quản lý vòng đời một WebSocket session
  // =============================================================
  async handleSession(webSocket, username) {
    webSocket.accept();

    // --- Load dữ liệu bền vững từ Storage API ---
    const saved = await this.state.storage.get(`player:${username}`) || {};

    const player = {
      username,
      hp:       saved.hp    ?? 100,
      coins:    saved.coins ?? 50,
      aura:     saved.aura  ?? null,
      // Vị trí ngẫu nhiên khi vào (% của màn hình, tránh rìa)
      x: 8 + Math.random() * 72,
      y: 15 + Math.random() * 65,
      // Ghost mode: timestamp khi nào hết ghost (0 = không ghost)
      ghostUntil: 0,
      // Rate limiting timestamps
      lastChatTime: 0,
      lastMoveTime: 0,
    };

    this.sessions.set(webSocket, player);
    console.log(`[+] "${username}" vào. Tổng: ${this.sessions.size}`);

    // Gửi thông tin chào mừng riêng cho người mới (kèm state hiện tại)
    this.sendJSON(webSocket, {
      type: 'welcome',
      player,
      activeFlashEvent: this.activeFlashEvent
        ? {
            type:      this.activeFlashEvent.type,
            question:  this.activeFlashEvent.question,
            expiresAt: this.activeFlashEvent.expiresAt,
            reward:    this.activeFlashEvent.reward,
          }
        : null,
    });

    // Broadcast game state đầy đủ cho TẤT CẢ (bao gồm cả người mới)
    this.broadcastGameState();

    // Đảm bảo alarm flash event đã được lập lịch
    await this.ensureAlarmScheduled();

    // --- Lắng nghe message từ client ---
    webSocket.addEventListener('message', async (evt) => {
      try {
        const data = JSON.parse(evt.data);
        await this.handleMessage(webSocket, player, data);
      } catch {
        // Bỏ qua JSON không hợp lệ
      }
    });

    // --- Dọn dẹp khi ngắt kết nối ---
    const onDisconnect = async () => {
      if (!this.sessions.has(webSocket)) return; // Tránh double-cleanup
      this.sessions.delete(webSocket);
      console.log(`[-] "${username}" rời. Còn: ${this.sessions.size}`);

      // Lưu state cuối cùng của player xuống storage
      await this.savePlayer(username, player);

      // Thông báo cho mọi người
      this.broadcastGameState();
    };

    webSocket.addEventListener('close', onDisconnect);
    webSocket.addEventListener('error', onDisconnect);
  }

  // =============================================================
  // handleMessage() — Dispatcher xử lý các loại message từ client
  // =============================================================
  async handleMessage(webSocket, player, data) {
    const now = Date.now();

    // Kiểm tra flash event hết hạn → tự động xóa
    if (this.activeFlashEvent && now > this.activeFlashEvent.expiresAt) {
      // Broadcast thông báo hết hạn nếu chưa được giải
      if (!this.activeFlashEvent.solved) {
        this.broadcast({ type: 'flash_expired' });
      }
      this.activeFlashEvent = null;
    }

    switch (data.type) {

      // -------------------------------------------------------
      case 'chat': {
        // Rate limit: không cho phép spam (< 500ms giữa 2 tin nhắn)
        if (now - player.lastChatTime < 500) return;
        player.lastChatTime = now;

        const message = String(data.message ?? '').slice(0, 200).trim();
        if (!message) return;

        // === Kiểm tra có phải đáp án Flash Event không ===
        if (
          this.activeFlashEvent &&
          !this.activeFlashEvent.solved &&
          now < this.activeFlashEvent.expiresAt &&
          (this.activeFlashEvent.type === 'type_phrase' || this.activeFlashEvent.type === 'math_quiz')
        ) {
          const evt = this.activeFlashEvent;
          if (message.toLowerCase().trim() === evt.answer.toLowerCase().trim()) {
            // --- Đúng đáp án! ---
            evt.solved = true;
            player.coins += evt.reward;
            await this.savePlayer(player.username, player);

            this.broadcast({
              type: 'flash_result',
              winner:  player.username,
              reward:  evt.reward,
              correct: evt.answer,
            });
            this.activeFlashEvent = null;
            this.broadcastGameState(); // Cập nhật coins mới
            return; // Không broadcast như tin nhắn thường
          }
        }

        // Tin nhắn chat thông thường
        this.broadcast({
          type:      'chat',
          username:  player.username,
          message,
          timestamp: new Date().toISOString(),
        });
        break;
      }

      // -------------------------------------------------------
      // Click-to-move: client gửi tọa độ đích (% của màn hình)
      // Rate limit: 300ms để tránh spam position updates
      case 'move': {
        if (now - player.lastMoveTime < 300) return;
        player.lastMoveTime = now;

        // Clamp tọa độ trong vùng an toàn (tránh ra ngoài rìa)
        const x = Math.max(3, Math.min(87, Number(data.x)));
        const y = Math.max(12, Math.min(85, Number(data.y)));
        if (isNaN(x) || isNaN(y)) return;

        player.x = x;
        player.y = y;

        // Gửi lightweight position update (không cần full game_state)
        this.broadcast({
          type:     'player_moved',
          username: player.username,
          x, y,
        });
        break;
      }

      // -------------------------------------------------------
      // Lucky Grab: Ai nhấn trước thì thắng
      case 'lucky_grab': {
        if (!this.activeFlashEvent)                                     return;
        if (this.activeFlashEvent.type !== 'lucky_grab')                return;
        if (this.activeFlashEvent.solved)                               return;
        if (now > this.activeFlashEvent.expiresAt)                      return;

        this.activeFlashEvent.solved = true;
        player.coins += this.activeFlashEvent.reward;
        await this.savePlayer(player.username, player);

        this.broadcast({
          type:    'flash_result',
          winner:  player.username,
          reward:  this.activeFlashEvent.reward,
          correct: 'lucky_grab',
        });
        this.activeFlashEvent = null;
        this.broadcastGameState();
        break;
      }
    }
  }

  // =============================================================
  // triggerFlashEvent() — Tạo ngẫu nhiên một Flash Event mới
  // =============================================================
  triggerFlashEvent() {
    const types = ['type_phrase', 'math_quiz', 'lucky_grab'];
    const type  = types[Math.floor(Math.random() * types.length)];

    let question, answer, reward;

    if (type === 'type_phrase') {
      const phrases = [
        'Cloud đỉnh chóp',
        'Durable Object',
        'Edge Computing',
        'Không gian chung',
        'WebSocket Rules',
      ];
      const chosen = phrases[Math.floor(Math.random() * phrases.length)];
      question = `⚡ Sự kiện! Gõ ngay: "${chosen}" (8 giây!)`;
      answer   = chosen;
      reward   = 10;

    } else if (type === 'math_quiz') {
      const a  = Math.floor(Math.random() * 50) + 10;
      const b  = Math.floor(Math.random() * 40) + 5;
      const useAdd = Math.random() > 0.5;
      question = useAdd
        ? `🧮 Giải nhanh: ${a} + ${b} = ? (8 giây!)`
        : `🧮 Giải nhanh: ${a + b} - ${b} = ? (8 giây!)`;
      answer   = String(useAdd ? a + b : a);
      reward   = 15;

    } else {
      question = '🎁 Lì xì! Ai nhanh tay? Ấn nút NHẬN ngay!';
      answer   = null;
      reward   = 50;
    }

    this.activeFlashEvent = {
      type,
      question,
      answer,
      reward,
      expiresAt: Date.now() + 8_000,
      solved:    false,
    };

    // Broadcast event cho tất cả (không gửi `answer` để tránh cheat)
    this.broadcast({
      type:  'flash_event',
      event: {
        type,
        question,
        reward,
        expiresAt: this.activeFlashEvent.expiresAt,
      },
    });
  }

  // =============================================================
  // broadcastGameState() — Gửi toàn bộ game state cho mọi client
  // =============================================================
  broadcastGameState() {
    const now     = Date.now();
    const players = [...this.sessions.values()].map((p) => ({
      username:  p.username,
      hp:        p.hp,
      coins:     p.coins,
      aura:      p.aura,
      x:         p.x,
      y:         p.y,
      isGhost:   now < p.ghostUntil,
      ghostUntil: p.ghostUntil,
    }));

    this.broadcast({
      type: 'game_state',
      players,
      count: players.length,
    });
  }

  // =============================================================
  // ensureAlarmScheduled() — Đảm bảo có alarm cho Flash Event
  // =============================================================
  async ensureAlarmScheduled() {
    const existing = await this.state.storage.getAlarm();
    if (!existing) {
      // Flash event đầu tiên sau 30–60 giây
      const delay = 30_000 + Math.floor(Math.random() * 30_000);
      await this.state.storage.setAlarm(Date.now() + delay);
      console.log(`[Alarm] Flash event đầu tiên sau ${Math.round(delay / 1000)}s`);
    }
  }

  // =============================================================
  // savePlayer() — Lưu state bền vững vào Transactional Storage
  // =============================================================
  // Chỉ lưu các trường cần persist (không lưu position hay timestamps)
  async savePlayer(username, player) {
    await this.state.storage.put(`player:${username}`, {
      hp:    player.hp,
      coins: player.coins,
      aura:  player.aura,
    });
  }

  // =============================================================
  // broadcast() — Gửi JSON đến TẤT CẢ client đang kết nối
  // =============================================================
  broadcast(data) {
    const message    = JSON.stringify(data);
    const deadSockets = [];

    for (const [ws] of this.sessions) {
      try {
        ws.send(message);
      } catch {
        deadSockets.push(ws);
      }
    }

    // Dọn dẹp zombie connections
    deadSockets.forEach((ws) => this.sessions.delete(ws));
  }

  // =============================================================
  // sendJSON() — Gửi JSON đến một WebSocket cụ thể
  // =============================================================
  sendJSON(webSocket, data) {
    try { webSocket.send(JSON.stringify(data)); } catch { /* bỏ qua */ }
  }
}
