// =============================================================
// src/index.js - Cloudflare Worker Entry Point
// =============================================================
// Đây là "cổng vào" (Gateway) của toàn bộ backend.
// Cloudflare Worker hoạt động theo mô hình SERVERLESS:
//   - Không có server vật lý nào cần quản lý.
//   - Mỗi HTTP Request sẽ kích hoạt hàm fetch() này.
//   - Worker chạy ở "Edge" - tức là tại data center gần người
//     dùng nhất, giúp response time cực kỳ nhanh (<50ms).
// =============================================================

export { ChatRoom } from './chatRoom.js';

export default {
  /**
   * Hàm fetch() là handler chính, được gọi với mỗi HTTP request
   * đến Worker của chúng ta.
   *
   * @param {Request} request - Object chứa toàn bộ thông tin HTTP Request
   * @param {object}  env     - Bindings: các tài nguyên Cloudflare được inject
   *                            vào (Durable Objects, KV, R2, v.v.)
   * @param {object}  ctx     - Execution context (dùng cho waitUntil, passThroughOnException)
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ----------------------------------------------------------------
    // Xử lý CORS (Cross-Origin Resource Sharing)
    // Frontend (Pages) và Backend (Worker) có domain khác nhau,
    // trình duyệt sẽ chặn request nếu không có CORS headers đúng.
    // ----------------------------------------------------------------
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Upgrade, Connection',
    };

    // Preflight request: trình duyệt gửi OPTIONS trước khi gửi request thật
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ----------------------------------------------------------------
    // Route: GET /api/room?username=<name>
    // Đây là endpoint để client kết nối WebSocket vào Durable Object.
    // ----------------------------------------------------------------
    if (url.pathname === '/api/room') {
      const username = url.searchParams.get('username');

      // Guard clause: từ chối nếu thiếu username
      if (!username || username.trim() === '') {
        return new Response(
          JSON.stringify({ error: 'Thiếu tham số username' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      // Kiểm tra đây có phải WebSocket Upgrade request không
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response(
          JSON.stringify({ error: 'Yêu cầu nâng cấp WebSocket' }),
          { status: 426, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      // ----------------------------------------------------------------
      // *** QUAN TRỌNG - Durable Object Routing ***
      // Chúng ta sử dụng một ID cố định ("main-room") để tất cả
      // người dùng đều kết nối vào CÙNG MỘT instance Durable Object.
      // Đây chính là cơ chế đảm bảo "shared state" (trạng thái chung).
      //
      // Nếu dùng idFromName("room-A") và idFromName("room-B"),
      // chúng ta sẽ có 2 phòng độc lập nhau.
      // ----------------------------------------------------------------
      const roomId = env.CHAT_ROOM.idFromName('main-room');
      const roomStub = env.CHAT_ROOM.get(roomId);

      // Chuyển tiếp toàn bộ request (bao gồm WebSocket upgrade headers)
      // đến Durable Object để nó xử lý tiếp.
      return roomStub.fetch(request);
    }

    // ----------------------------------------------------------------
    // Route: GET / - Health check endpoint
    // ----------------------------------------------------------------
    if (url.pathname === '/') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'Không Gian Chung - Backend',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Fallback: 404 cho các route không xác định
    return new Response(
      JSON.stringify({ error: 'Endpoint không tồn tại' }),
      { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  },
};
