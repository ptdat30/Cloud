// =============================================================
// src/chatRoom.js - Durable Object: ChatRoom (Full Game Edition)
// =============================================================

// --- Danh mục vật phẩm Shop ---
const SHOP_ITEMS = {
  fire_aura:   { name: 'Hào quang Lửa',     price: 50,  type: 'aura',       auraId: 'fire' },
  neon_spiral: { name: 'Vòng xoáy Neon',    price: 120, type: 'aura',       auraId: 'neon' },
  ice_shield:  { name: 'Khiên Băng giá',    price: 250, type: 'aura',       auraId: 'ice'  },
  milk_heal:   { name: 'Sữa Đặc Chữa Lành', price: 30,  type: 'consumable', healHp: 20    },
};

const ATTACK_COST    = 5;        // $ mỗi lần tấn công
const ATTACK_DAMAGE  = 15;       // HP bị trừ mỗi đòn
const GHOST_DURATION = 30_000;   // 30 giây ghost mode

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
    this.sessions         = new Map(); // Map<WebSocket, PlayerState>
    this.activeFlashEvent = null;
  }

  // =============================================================
  // fetch() — WebSocket Upgrade
  // =============================================================
  async fetch(request) {
    const url      = new URL(request.url);
    const username = url.searchParams.get('username')?.trim();
    if (!username) return new Response('Thiếu username', { status: 400 });

    const [client, server] = Object.values(new WebSocketPair());
    await this.handleSession(server, username);
    return new Response(null, { status: 101, webSocket: client });
  }

  // =============================================================
  // alarm() — DO Alarms: Flash Event scheduler
  // =============================================================
  async alarm() {
    if (this.sessions.size > 0) this.triggerFlashEvent();
    const next = 45_000 + Math.floor(Math.random() * 45_000);
    await this.state.storage.setAlarm(Date.now() + next);
  }

  // =============================================================
  // handleSession() — Vòng đời một WebSocket session
  // =============================================================
  async handleSession(webSocket, username) {
    webSocket.accept();

    // Load persistent data
    const saved = await this.state.storage.get(`player:${username}`) || {};
    const player = {
      username,
      hp:          saved.hp    ?? 100,
      coins:       saved.coins ?? 50,
      aura:        saved.aura  ?? null,
      x:           8 + Math.random() * 72,
      y:           15 + Math.random() * 65,
      ghostUntil:  0,
      lastChatTime: 0,
      lastMoveTime: 0,
      lastAttackTime: 0,
    };

    this.sessions.set(webSocket, player);

    this.sendJSON(webSocket, {
      type:              'welcome',
      player,
      activeFlashEvent:  this.activeFlashEvent
        ? { type: this.activeFlashEvent.type, question: this.activeFlashEvent.question,
            expiresAt: this.activeFlashEvent.expiresAt, reward: this.activeFlashEvent.reward }
        : null,
    });

    this.broadcastGameState();
    await this.ensureAlarmScheduled();

    webSocket.addEventListener('message', async (evt) => {
      try {
        const data = JSON.parse(evt.data);
        await this.handleMessage(webSocket, player, data);
      } catch { /* ignore bad JSON */ }
    });

    const onDisconnect = async () => {
      if (!this.sessions.has(webSocket)) return;
      this.sessions.delete(webSocket);
      await this.savePlayer(username, player);
      this.broadcastGameState();
    };
    webSocket.addEventListener('close', onDisconnect);
    webSocket.addEventListener('error', onDisconnect);
  }

  // =============================================================
  // handleMessage() — Dispatcher
  // =============================================================
  async handleMessage(webSocket, player, data) {
    const now = Date.now();

    // Auto-expire flash events
    if (this.activeFlashEvent && now > this.activeFlashEvent.expiresAt) {
      if (!this.activeFlashEvent.solved) this.broadcast({ type: 'flash_expired' });
      this.activeFlashEvent = null;
    }

    switch (data.type) {

      // -------------------------------------------------------
      case 'chat': {
        if (now - player.lastChatTime < 500) return;
        player.lastChatTime = now;
        const message = String(data.message ?? '').slice(0, 200).trim();
        if (!message) return;

        // Kiểm tra đáp án Flash Event
        if (this.activeFlashEvent && !this.activeFlashEvent.solved &&
            now < this.activeFlashEvent.expiresAt &&
            (this.activeFlashEvent.type === 'type_phrase' || this.activeFlashEvent.type === 'math_quiz')) {
          if (message.toLowerCase().trim() === this.activeFlashEvent.answer.toLowerCase().trim()) {
            this.activeFlashEvent.solved = true;
            player.coins += this.activeFlashEvent.reward;
            await this.savePlayer(player.username, player);
            this.broadcast({ type: 'flash_result', winner: player.username, reward: this.activeFlashEvent.reward, correct: this.activeFlashEvent.answer });
            this.activeFlashEvent = null;
            this.broadcastGameState();
            return;
          }
        }

        this.broadcast({ type: 'chat', username: player.username, message, timestamp: new Date().toISOString() });
        break;
      }

      // -------------------------------------------------------
      case 'move': {
        if (now - player.lastMoveTime < 300) return;
        player.lastMoveTime = now;
        const x = Math.max(3, Math.min(87, Number(data.x)));
        const y = Math.max(12, Math.min(85, Number(data.y)));
        if (isNaN(x) || isNaN(y)) return;
        player.x = x; player.y = y;
        this.broadcast({ type: 'player_moved', username: player.username, x, y });
        break;
      }

      // -------------------------------------------------------
      // CLICK ĐỂ KIẾM TIỀN: mỗi click = +1$
      // Rate limit 300ms để tránh spam click liên tục
      // Anti-cheat: tính toán ở Server, Frontend chỉ nhận kết quả
      case 'click': {
        if (now - (player.lastClickTime || 0) < 300) return;
        player.lastClickTime = now;

        // Ghost không thể kiếm tiền
        if (now < player.ghostUntil) {
          this.sendJSON(webSocket, { type: 'coin_earned', success: false, error: 'Ghost không thể kiếm tiền!' });
          return;
        }

        player.coins += 1;
        await this.savePlayer(player.username, player);

        // Chỉ gửi riêng cho người click (không broadcast toàn phòng để tránh spam)
        this.sendJSON(webSocket, {
          type:      'coin_earned',
          success:   true,
          newCoins:  player.coins,
          x:         data.x, // Trả lại tọa độ để frontend hiện animation đúng chỗ
          y:         data.y,
        });
        break;
      }


      // -------------------------------------------------------
      case 'lucky_grab': {
        if (!this.activeFlashEvent || this.activeFlashEvent.type !== 'lucky_grab') return;
        if (this.activeFlashEvent.solved || now > this.activeFlashEvent.expiresAt) return;
        this.activeFlashEvent.solved = true;
        player.coins += this.activeFlashEvent.reward;
        await this.savePlayer(player.username, player);
        this.broadcast({ type: 'flash_result', winner: player.username, reward: this.activeFlashEvent.reward, correct: 'lucky_grab' });
        this.activeFlashEvent = null;
        this.broadcastGameState();
        break;
      }

      // -------------------------------------------------------
      // MUA VẬT PHẨM SHOP
      // Anti-cheat: Validate tiền và tính toán HOÀN TOÀN ở Server
      case 'buy': {
        const item = SHOP_ITEMS[data.itemId];
        if (!item) return this.sendJSON(webSocket, { type: 'buy_result', success: false, error: 'Vật phẩm không tồn tại' });
        if (player.coins < item.price) return this.sendJSON(webSocket, { type: 'buy_result', success: false, error: `Không đủ tiền! Cần ${item.price}$, bạn có ${player.coins}$` });

        // Trừ tiền
        player.coins -= item.price;

        if (item.type === 'aura') {
          player.aura = item.auraId;
          await this.savePlayer(player.username, player);
          this.sendJSON(webSocket, { type: 'buy_result', success: true, itemId: data.itemId, newCoins: player.coins, message: `Đã trang bị "${item.name}"!` });
          // Broadcast để mọi người thấy aura mới
          this.broadcastGameState();

        } else if (item.type === 'consumable') {
          // Sữa Đặc: Hồi HP tức thì
          player.hp = Math.min(100, player.hp + item.healHp);
          // Nếu đang ghost và HP > 0 → thoát ghost
          if (player.ghostUntil > 0 && player.hp > 0) player.ghostUntil = 0;
          await this.savePlayer(player.username, player);
          this.sendJSON(webSocket, { type: 'buy_result', success: true, itemId: data.itemId, newCoins: player.coins, message: `+${item.healHp} HP! HP hiện tại: ${player.hp}` });
          this.broadcastGameState();
        }
        break;
      }

      // -------------------------------------------------------
      // TẤN CÔNG NGƯỜI CHƠI KHÁC
      // Pay-to-attack: Tốn ATTACK_COST$, gây ATTACK_DAMAGE HP
      case 'attack': {
        // Rate limit tấn công: 1 giây
        if (now - player.lastAttackTime < 1000) return;

        // Ghost không thể tấn công
        if (now < player.ghostUntil) return this.sendJSON(webSocket, { type: 'attack_result', success: false, error: 'Ghost không thể tấn công!' });

        // Kiểm tra đủ tiền
        if (player.coins < ATTACK_COST) return this.sendJSON(webSocket, { type: 'attack_result', success: false, error: `Không đủ tiền tấn công! Cần ${ATTACK_COST}$` });

        // Tìm mục tiêu
        const targetEntry = [...this.sessions.entries()].find(([, p]) => p.username === data.target);
        if (!targetEntry) return this.sendJSON(webSocket, { type: 'attack_result', success: false, error: 'Mục tiêu không tồn tại' });

        const [targetWs, target] = targetEntry;

        // Ghost không thể bị tấn công
        if (now < target.ghostUntil) return this.sendJSON(webSocket, { type: 'attack_result', success: false, error: 'Mục tiêu đang Ghost, không thể tấn công!' });

        // Không tự tấn công
        if (target.username === player.username) return;

        player.lastAttackTime = now;

        // === Thực hiện tấn công ===
        player.coins -= ATTACK_COST;
        target.hp    -= ATTACK_DAMAGE;
        const killed  = target.hp <= 0;

        if (killed) {
          target.hp        = 0;
          target.ghostUntil = now + GHOST_DURATION; // Ghost 30 giây
        }

        // Lưu state của cả 2
        await this.savePlayer(player.username, player);
        await this.savePlayer(target.username, target);

        // Broadcast kết quả tấn công (kèm vị trí để animate đạn)
        this.broadcast({
          type:     'attack_result',
          success:  true,
          attacker: player.username,
          target:   target.username,
          damage:   ATTACK_DAMAGE,
          targetHp: target.hp,
          killed,
          ghostUntil: target.ghostUntil,
          // Vị trí để frontend animate projectile
          fromX: player.x, fromY: player.y,
          toX:   target.x, toY:   target.y,
        });

        // Broadcast game state mới (HP thay đổi)
        this.broadcastGameState();
        break;
      }
    }
  }

  // =============================================================
  // checkGhostRevivals() — Hồi sinh player hết thời gian ghost
  // Dùng ghostUntil timestamp thay vì setTimeout (DO best practice)
  // =============================================================
  checkGhostRevivals() {
    const now = Date.now();
    for (const [ws, player] of this.sessions) {
      if (player.ghostUntil > 0 && now >= player.ghostUntil) {
        player.ghostUntil = 0;
        player.hp         = 100; // Hồi đầy máu
        // Thông báo riêng cho player được hồi sinh
        this.sendJSON(ws, { type: 'revived', hp: 100 });
        // Lưu HP mới
        this.savePlayer(player.username, player);
      }
    }
  }

  // =============================================================
  // triggerFlashEvent()
  // =============================================================
  triggerFlashEvent() {
    const types = ['type_phrase', 'math_quiz', 'lucky_grab'];
    const type  = types[Math.floor(Math.random() * types.length)];
    let question, answer, reward;

    if (type === 'type_phrase') {
      const phrases = ['Cloud đỉnh chóp', 'Durable Object', 'Edge Computing', 'Không gian chung', 'WebSocket Rules'];
      const chosen  = phrases[Math.floor(Math.random() * phrases.length)];
      question = `⚡ Gõ ngay: "${chosen}" (8 giây!)`;
      answer   = chosen;
      reward   = 10;
    } else if (type === 'math_quiz') {
      const a = Math.floor(Math.random() * 50) + 10;
      const b = Math.floor(Math.random() * 40) + 5;
      const useAdd = Math.random() > 0.5;
      question = useAdd ? `🧮 ${a} + ${b} = ? (8 giây!)` : `🧮 ${a + b} - ${b} = ? (8 giây!)`;
      answer   = String(useAdd ? a + b : a);
      reward   = 15;
    } else {
      question = '🎁 Lì xì! Ai nhanh tay? Ấn NHẬN ngay!';
      answer   = null;
      reward   = 50;
    }

    this.activeFlashEvent = { type, question, answer, reward, expiresAt: Date.now() + 8_000, solved: false };
    this.broadcast({ type: 'flash_event', event: { type, question, reward, expiresAt: this.activeFlashEvent.expiresAt } });
  }

  // =============================================================
  // broadcastGameState()
  // =============================================================
  broadcastGameState() {
    // Kiểm tra hồi sinh trước khi broadcast
    this.checkGhostRevivals();

    const now     = Date.now();
    const players = [...this.sessions.values()].map((p) => ({
      username:   p.username,
      hp:         p.hp,
      coins:      p.coins,
      aura:       p.aura,
      x:          p.x,
      y:          p.y,
      isGhost:    now < p.ghostUntil,
      ghostUntil: p.ghostUntil,
    }));

    this.broadcast({ type: 'game_state', players, count: players.length });
  }

  async ensureAlarmScheduled() {
    const existing = await this.state.storage.getAlarm();
    if (!existing) {
      const delay = 30_000 + Math.floor(Math.random() * 30_000);
      await this.state.storage.setAlarm(Date.now() + delay);
    }
  }

  async savePlayer(username, player) {
    await this.state.storage.put(`player:${username}`, { hp: player.hp, coins: player.coins, aura: player.aura });
  }

  broadcast(data) {
    const message = JSON.stringify(data);
    const dead    = [];
    for (const [ws] of this.sessions) {
      try { ws.send(message); } catch { dead.push(ws); }
    }
    dead.forEach((ws) => this.sessions.delete(ws));
  }

  sendJSON(ws, data) {
    try { ws.send(JSON.stringify(data)); } catch { /* ignore */ }
  }
}
