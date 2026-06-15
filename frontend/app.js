// =============================================================
// app.js — Không Gian Chung: Frontend Game Logic
// =============================================================
//
// KIẾN TRÚC FRONTEND:
//   - Stateless UI: Frontend không tự tính toán game logic.
//   - Chỉ RENDER kết quả mà Server (Durable Object) gửi về.
//   - Gửi "ý định" lên Server: chat, move, lucky_grab, flash_answer.
//
// MESSAGE FLOW:
//   Server → Client: welcome, game_state, player_moved, chat,
//                    flash_event, flash_result, flash_expired
//   Client → Server: chat, move, lucky_grab
//
// =============================================================

// ---------------------------------------------------------------
// ⚙️ CONFIGURATION — Thay bằng URL Worker của bạn sau khi deploy
// ---------------------------------------------------------------
const BACKEND_URL = 'wss://khong-gian-chung-backend.huynhphongdat2005.workers.dev/api/room';

// ---------------------------------------------------------------
// 🗂️ APPLICATION STATE
// ---------------------------------------------------------------
let ws            = null;   // WebSocket connection
let currentUser   = '';     // Username của người dùng hiện tại
let myState       = null;   // PlayerState của chính mình (từ server)
let allPlayers    = [];     // Mảng toàn bộ player (cập nhật từ game_state)
let chatMsgCount  = 0;      // Đếm tin nhắn

// Flash event state (mirror từ server để render UI)
let activeFlash   = null;   // { type, question, expiresAt, reward }
let flashTimerId  = null;   // ID của requestAnimationFrame cho timer bar

// Avatar color palette (gán theo index để nhất quán)
const AVATAR_COLORS = [
  '#7c3aed', '#db2777', '#0891b2', '#059669',
  '#d97706', '#dc2626', '#4f46e5', '#0284c7',
];

// Cache DOM references một lần để tránh query nhiều lần
const $ = (id) => document.getElementById(id);

const DOM = {
  loginScreen:    $('login-screen'),
  spaceScreen:    $('space-screen'),
  joinForm:       $('join-form'),
  usernameInput:  $('username-input'),
  joinBtn:        $('join-btn'),

  // HUD
  statusDot:      $('status-dot'),
  connectionStatus: $('connection-status'),
  myHp:           $('my-hp'),
  myCoins:        $('my-coins'),
  hudHpBar:       $('hud-hp-bar'),
  onlineCount:    $('online-count'),

  // Flash event
  flashBanner:    $('flash-banner'),
  flashQuestion:  $('flash-question'),
  flashInput:     $('flash-input'),
  flashSubmit:    $('flash-submit'),
  luckyGrabBtn:   $('lucky-grab-btn'),
  flashTimerBar:  $('flash-timer-bar'),
  flashReward:    $('flash-reward'),

  // Universe
  universe:       $('universe'),

  // Chat
  chatMessages:   $('chat-messages'),
  chatCount:      $('chat-count'),
  chatInput:      $('chat-input'),
  chatSend:       $('chat-send'),

  // Toast
  toastContainer: $('toast-container'),
};

// ---------------------------------------------------------------
// 🚀 INITIALIZATION
// ---------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  // Form đăng nhập
  DOM.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = DOM.usernameInput.value.trim();
    if (name) initiateConnection(name);
  });

  // Chat: gửi bằng Enter hoặc nút GỬI
  DOM.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });
  DOM.chatSend.addEventListener('click', sendChat);

  // Flash event: gửi đáp án
  DOM.flashInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitFlashAnswer();
  });
  DOM.flashSubmit.addEventListener('click', submitFlashAnswer);

  // Lucky grab button
  DOM.luckyGrabBtn.addEventListener('click', () => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'lucky_grab' }));
    }
  });

  // Click-to-move: click vào vùng universe để di chuyển avatar
  DOM.universe.addEventListener('click', handleUniverseClick);
});

// ---------------------------------------------------------------
// 🔌 WebSocket Connection
// ---------------------------------------------------------------
function initiateConnection(username) {
  currentUser = username;
  switchScreen('space');

  DOM.connectionStatus.textContent = 'Đang kết nối...';
  DOM.statusDot.classList.remove('online');

  const url = `${BACKEND_URL}?username=${encodeURIComponent(username)}`;
  ws = new WebSocket(url);

  ws.onopen = onWsOpen;
  ws.onmessage = onWsMessage;
  ws.onclose = onWsClose;
  ws.onerror = (err) => console.error('[WS Error]', err);
}

function onWsOpen() {
  DOM.connectionStatus.textContent = 'Đã kết nối';
  DOM.statusDot.classList.add('online');
  $('online-dot')?.classList.add('online');
  showToast('Đã kết nối tới Không Gian Chung!', 'info');
}

function onWsClose() {
  DOM.connectionStatus.textContent = 'Mất kết nối. Tải lại trang.';
  DOM.statusDot.classList.remove('online');
  showToast('Kết nối bị ngắt. Hãy tải lại trang!', 'error');
}

// ---------------------------------------------------------------
// 📨 Message Dispatcher
// ---------------------------------------------------------------
function onWsMessage(event) {
  let data;
  try { data = JSON.parse(event.data); } catch { return; }

  switch (data.type) {
    case 'welcome':      handleWelcome(data);      break;
    case 'game_state':   handleGameState(data);    break;
    case 'player_moved': handlePlayerMoved(data);  break;
    case 'chat':         handleChat(data);         break;
    case 'flash_event':  handleFlashEvent(data);   break;
    case 'flash_result': handleFlashResult(data);  break;
    case 'flash_expired':handleFlashExpired();     break;
  }
}

// ---------------------------------------------------------------
// 🎮 Message Handlers
// ---------------------------------------------------------------

// Server gửi welcome khi vừa kết nối (chứa state của chính mình)
function handleWelcome({ player, activeFlashEvent }) {
  myState = player;
  updateMyHUD();

  // Nếu server đang có flash event active, hiện lên ngay
  if (activeFlashEvent) {
    activeFlash = activeFlashEvent;
    showFlashBanner(activeFlashEvent);
  }

  // Thông báo chat hệ thống
  appendSystemMessage(`🔗 Bạn đã vào Không Gian Chung với ${player.coins}$`);
}

// Cập nhật toàn bộ danh sách player (khi ai vào/rời/thay đổi state)
function handleGameState({ players, count }) {
  allPlayers = players;
  DOM.onlineCount.textContent = count;
  renderPlayers(players);
}

// Lightweight position update — chỉ update vị trí 1 player
function handlePlayerMoved({ username, x, y }) {
  // Cập nhật trong mảng local
  const p = allPlayers.find((pl) => pl.username === username);
  if (p) { p.x = x; p.y = y; }

  // Update DOM trực tiếp → CSS transition sẽ animate trượt mượt
  const el = document.querySelector(`[data-username="${CSS.escape(username)}"]`);
  if (el) {
    el.style.left = `${x}%`;
    el.style.top  = `${y}%`;
  }

  // Nếu là mình di chuyển, update myState
  if (username === currentUser && myState) {
    myState.x = x;
    myState.y = y;
  }
}

// Tin nhắn chat từ một user
function handleChat({ username, message, timestamp }) {
  appendChatMessage(username, message, timestamp);
}

// Flash event mới xuất hiện
function handleFlashEvent({ event }) {
  activeFlash = event;
  showFlashBanner(event);
  appendSystemMessage(`⚡ Flash Event! ${event.question}`);
  showToast('⚡ Flash Event bắt đầu!', 'gold');
}

// Ai đó đã giải được flash event
function handleFlashResult({ winner, reward, correct }) {
  hideFlashBanner();
  activeFlash = null;

  const isMe = winner === currentUser;
  const msg  = isMe
    ? `🏆 BẠN thắng Flash Event! +${reward}$`
    : `🏆 "${winner}" vừa thắng +${reward}$!`;

  appendSystemMessage(msg);
  showToast(msg, isMe ? 'success' : 'info');

  // Nếu mình thắng → server sẽ gửi game_state mới kèm coins mới
  // HUD sẽ tự cập nhật qua handleGameState → renderPlayers
}

// Flash event hết giờ mà không ai trả lời
function handleFlashExpired() {
  hideFlashBanner();
  activeFlash = null;
  appendSystemMessage('⏰ Flash Event đã hết giờ. Chờ event tiếp theo!');
}

// ---------------------------------------------------------------
// 🎨 RENDERING
// ---------------------------------------------------------------

// Render toàn bộ player list trong universe
function renderPlayers(players) {
  const now = Date.now();
  const existingUsernames = new Set();

  players.forEach((player, index) => {
    existingUsernames.add(player.username);
    const isMe    = player.username === currentUser;
    const isGhost = now < (player.ghostUntil || 0);
    const color   = AVATAR_COLORS[hashUsername(player.username) % AVATAR_COLORS.length];
    const initial = player.username[0].toUpperCase();

    // Update myState khi nhận game_state
    if (isMe) {
      myState = { ...myState, ...player };
      updateMyHUD();
    }

    let el = document.querySelector(`[data-username="${CSS.escape(player.username)}"]`);

    if (!el) {
      // Tạo mới element nếu chưa tồn tại
      el = document.createElement('div');
      el.className = 'player-avatar';
      el.dataset.username = player.username;
      el.innerHTML = `
        <div class="avatar-hp-wrap">
          <div class="avatar-hp-bar" style="width:${player.hp}%"></div>
        </div>
        <div class="avatar-circle" style="background: ${color};">
          ${initial}
        </div>
        <div class="avatar-label">
          <span class="avatar-name ${isMe ? 'is-me' : ''}">${player.username}${isMe ? ' (Bạn)' : ''}</span>
          <span class="avatar-coins">💰 ${player.coins}$</span>
        </div>
      `;
      DOM.universe.appendChild(el);
    } else {
      // Cập nhật các trường thay đổi
      const hpBar = el.querySelector('.avatar-hp-bar');
      if (hpBar) hpBar.style.width = `${player.hp}%`;

      const coinEl = el.querySelector('.avatar-coins');
      if (coinEl) coinEl.textContent = `💰 ${player.coins}$`;
    }

    // Cập nhật vị trí
    el.style.left = `${player.x}%`;
    el.style.top  = `${player.y}%`;

    // Cập nhật ghost mode
    if (isGhost) {
      el.classList.add('is-ghost');
    } else {
      el.classList.remove('is-ghost');
    }

    // Cập nhật aura class
    el.classList.remove('aura-fire', 'aura-neon', 'aura-ice');
    if (player.aura) el.classList.add(`aura-${player.aura}`);
  });

  // Xóa các element của player đã rời đi
  document.querySelectorAll('.player-avatar').forEach((el) => {
    if (!existingUsernames.has(el.dataset.username)) {
      el.remove();
    }
  });
}

// Cập nhật HUD (HP và Coins) của người dùng hiện tại
function updateMyHUD() {
  if (!myState) return;
  DOM.myHp.textContent    = myState.hp;
  DOM.myCoins.textContent = myState.coins;
  DOM.hudHpBar.style.width = `${myState.hp}%`;
}

// ---------------------------------------------------------------
// 💬 CHAT
// ---------------------------------------------------------------

function sendChat() {
  const message = DOM.chatInput.value.trim();
  if (!message || ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'chat', message }));
  DOM.chatInput.value = '';
}

function appendChatMessage(username, message, timestamp) {
  const isMe    = username === currentUser;
  const color   = AVATAR_COLORS[hashUsername(username) % AVATAR_COLORS.length];
  const initial = username[0].toUpperCase();
  const time    = timestamp ? new Date(timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '';

  const div = document.createElement('div');
  div.className = `chat-msg${isMe ? ' is-me' : ''}`;
  div.innerHTML = `
    <div class="msg-avatar" style="background: ${color};">${initial}</div>
    <div class="msg-body">
      <div class="msg-username">${isMe ? 'Bạn' : username} · ${time}</div>
      <div class="msg-text">${escapeHtml(message)}</div>
    </div>
  `;

  DOM.chatMessages.appendChild(div);
  chatMsgCount++;
  DOM.chatCount.textContent = chatMsgCount;

  // Auto-scroll xuống cuối
  DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
}

function appendSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'chat-msg system';
  div.innerHTML = `
    <div class="msg-body" style="width:100%">
      <div class="msg-text">${escapeHtml(text)}</div>
    </div>
  `;
  DOM.chatMessages.appendChild(div);
  DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
}

// ---------------------------------------------------------------
// ⚡ FLASH EVENT UI
// ---------------------------------------------------------------

function showFlashBanner(event) {
  DOM.flashQuestion.textContent = event.question;
  DOM.flashReward.textContent   = event.reward;
  DOM.flashBanner.classList.remove('hidden');

  // Hiển thị đúng control tùy loại event
  const isLucky = event.type === 'lucky_grab';
  DOM.flashInput.classList.toggle('hidden', isLucky);
  DOM.flashSubmit.classList.toggle('hidden', isLucky);
  DOM.luckyGrabBtn.classList.toggle('hidden', !isLucky);

  // Bắt đầu countdown timer bar
  startFlashTimer(event.expiresAt);
}

function hideFlashBanner() {
  DOM.flashBanner.classList.add('hidden');
  DOM.flashInput.value = '';
  if (flashTimerId) {
    cancelAnimationFrame(flashTimerId);
    flashTimerId = null;
  }
}

function startFlashTimer(expiresAt) {
  const totalDuration = expiresAt - Date.now();
  if (totalDuration <= 0) { hideFlashBanner(); return; }

  const tick = () => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      DOM.flashTimerBar.style.width = '0%';
      return;
    }
    const pct = (remaining / totalDuration) * 100;
    DOM.flashTimerBar.style.width = `${pct}%`;
    flashTimerId = requestAnimationFrame(tick);
  };

  flashTimerId = requestAnimationFrame(tick);
}

function submitFlashAnswer() {
  const answer = DOM.flashInput.value.trim();
  if (!answer || ws?.readyState !== WebSocket.OPEN) return;
  // Gửi đáp án qua chat — Backend sẽ kiểm tra đây có phải đáp án đúng không
  ws.send(JSON.stringify({ type: 'chat', message: answer }));
  DOM.flashInput.value = '';
}

// ---------------------------------------------------------------
// 🖱️ CLICK-TO-MOVE
// ---------------------------------------------------------------

function handleUniverseClick(e) {
  // Bỏ qua nếu click vào một player avatar
  if (e.target.closest('.player-avatar')) return;

  const rect = DOM.universe.getBoundingClientRect();
  const xPct = ((e.clientX - rect.left) / rect.width)  * 100;
  const yPct = ((e.clientY - rect.top)  / rect.height) * 100;

  // Clamp an toàn (tránh ra rìa màn hình)
  const x = Math.max(3, Math.min(87, xPct));
  const y = Math.max(12, Math.min(85, yPct));

  // Hiệu ứng ripple tại điểm click
  spawnRipple(e.clientX - rect.left, e.clientY - rect.top);

  // Gửi lệnh di chuyển lên Server
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'move', x, y }));
  }

  // Cập nhật vị trí local ngay lập tức (không chờ server echo)
  // CSS transition sẽ animate mượt mà
  if (myState) {
    const myEl = document.querySelector(`[data-username="${CSS.escape(currentUser)}"]`);
    if (myEl) {
      myEl.style.left = `${x}%`;
      myEl.style.top  = `${y}%`;
    }
  }
}

function spawnRipple(x, y) {
  const ripple = document.createElement('div');
  ripple.className = 'click-ripple';
  ripple.style.left = `${x}px`;
  ripple.style.top  = `${y}px`;
  DOM.universe.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove());
}

// ---------------------------------------------------------------
// 🔔 TOAST NOTIFICATIONS
// ---------------------------------------------------------------

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  DOM.toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

// ---------------------------------------------------------------
// 🔧 UTILITIES
// ---------------------------------------------------------------

function switchScreen(to) {
  DOM.loginScreen.classList.remove('active');
  DOM.spaceScreen.classList.remove('active');
  if (to === 'space') DOM.spaceScreen.classList.add('active');
  else                DOM.loginScreen.classList.add('active');
}

// Hash đơn giản để gán màu nhất quán cho mỗi username
function hashUsername(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

// Escape HTML để tránh XSS
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
