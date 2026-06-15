// =============================================================
// stress-test.js - Script kiểm tra tải WebSocket
// =============================================================
// Mô phỏng nhiều user kết nối đồng thời vào Durable Object
// và đo thời gian phản hồi của hệ thống.
//
// Cách chạy: node stress-test.js [số_user] [giây]
// Ví dụ:     node stress-test.js 50 10
// =============================================================

import { WebSocket } from 'ws';

// ----------------------------------------------------------------
// Cấu hình
// ----------------------------------------------------------------
const WORKER_URL = 'wss://khong-gian-chung-backend.huynhphongdat2005.workers.dev/api/room';
const NUM_USERS  = parseInt(process.argv[2]) || 20;   // Số user mô phỏng
const DURATION_S = parseInt(process.argv[3]) || 10;   // Thời gian test (giây)

// ----------------------------------------------------------------
// Metrics tracking
// ----------------------------------------------------------------
const metrics = {
  connected:    0,
  failed:       0,
  messagesRecv: 0,
  latencies:    [],   // Mảng lưu độ trễ từng message (ms)
};

console.log(`\n🚀 BẮT ĐẦU STRESS TEST`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`👥 Số user mô phỏng  : ${NUM_USERS}`);
console.log(`⏱️  Thời gian test    : ${DURATION_S}s`);
console.log(`🌐 Worker URL        : ${WORKER_URL}`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

const sockets = [];

// ----------------------------------------------------------------
// Tạo N kết nối WebSocket đồng thời
// ----------------------------------------------------------------
for (let i = 0; i < NUM_USERS; i++) {
  const username   = `TestUser_${i + 1}`;
  const connectUrl = `${WORKER_URL}?username=${encodeURIComponent(username)}`;
  const startTime  = Date.now();

  const ws = new WebSocket(connectUrl);

  ws.on('open', () => {
    metrics.connected++;
    process.stdout.write(`\r✅ Đã kết nối: ${metrics.connected}/${NUM_USERS} users`);
  });

  ws.on('message', (data) => {
    // Tính latency: thời gian từ lúc kết nối đến khi nhận message đầu tiên
    const latency = Date.now() - startTime;
    metrics.latencies.push(latency);
    metrics.messagesRecv++;
  });

  ws.on('error', (err) => {
    metrics.failed++;
    // Không log từng lỗi để tránh làm rối output
  });

  sockets.push(ws);

  // Thêm delay nhỏ giữa mỗi kết nối để tránh flood đột ngột
  await new Promise((resolve) => setTimeout(resolve, 50));
}

// ----------------------------------------------------------------
// Chờ hết thời gian test, rồi đóng tất cả kết nối và in kết quả
// ----------------------------------------------------------------
await new Promise((resolve) => setTimeout(resolve, DURATION_S * 1000));

// Đóng tất cả socket
sockets.forEach((ws) => ws.close());

// ----------------------------------------------------------------
// Tính toán và in kết quả
// ----------------------------------------------------------------
const sorted  = [...metrics.latencies].sort((a, b) => a - b);
const avg     = sorted.length ? (sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(1) : 'N/A';
const p50     = sorted[Math.floor(sorted.length * 0.50)] ?? 'N/A';
const p95     = sorted[Math.floor(sorted.length * 0.95)] ?? 'N/A';
const p99     = sorted[Math.floor(sorted.length * 0.99)] ?? 'N/A';
const minLat  = sorted[0] ?? 'N/A';
const maxLat  = sorted[sorted.length - 1] ?? 'N/A';

console.log(`\n\n📊 KẾT QUẢ STRESS TEST`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`✅ Kết nối thành công : ${metrics.connected}/${NUM_USERS}`);
console.log(`❌ Kết nối thất bại   : ${metrics.failed}`);
console.log(`📨 Tổng messages nhận : ${metrics.messagesRecv}`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`⏱️  Latency (response time đến message đầu tiên):`);
console.log(`   Min  : ${minLat}ms`);
console.log(`   Avg  : ${avg}ms`);
console.log(`   P50  : ${p50}ms   (50% requests nhanh hơn mức này)`);
console.log(`   P95  : ${p95}ms   (95% requests nhanh hơn mức này)`);
console.log(`   P99  : ${p99}ms   (99% requests nhanh hơn mức này)`);
console.log(`   Max  : ${maxLat}ms`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

// Đánh giá sức khỏe hệ thống
const successRate = ((metrics.connected / NUM_USERS) * 100).toFixed(1);
console.log(`\n🏥 ĐÁNH GIÁ:`);
if (successRate >= 95 && p95 < 500)  console.log(`   🟢 XUẤT SẮC  - ${successRate}% success, P95 < 500ms`);
else if (successRate >= 80 && p95 < 1000) console.log(`   🟡 TỐT       - ${successRate}% success, P95 < 1s`);
else console.log(`   🔴 CẦN CẢI THIỆN - Tỉ lệ thành công ${successRate}%`);
console.log(`\n`);

process.exit(0);
