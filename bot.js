// bot.js — FIFO صارم + lastChecked per group + backlog + منع تكرار + تطبيع عربي قوي

const EventEmitter = require('events');
const fs = require('fs');
const qrcode = require('qrcode');
const Store = require('electron-store');
const { Client, LocalAuth } = require('whatsapp-web.js');

class Bot {
  constructor({ sessionsDir }) {
    this.emitter = new EventEmitter();
    this.sessionsDir = sessionsDir;
    this.client = null;

    this.qrDataUrl = null;
    this.isReady = false;
    this.running = false;

    this.selectedGroupIds = [];
    this.clients = []; // [{name, emoji, _norm, _rx}]
    this.settings = {
      emoji: '✅',
      replyText: 'تم ✅',
      mode: 'emoji',                 // 'emoji' | 'text'
      ratePerMinute: 20,             // حد عام/دقيقة
      cooldownSec: 3,                // مهلة لكل جروب (ثواني)
      normalizeArabic: true
    };

    // تخزين دائم
    this.state = new Store.default({ name: 'wbot-state' });

    this.queue = [];
    this.workerRunning = false;

    this.minuteCount = 0;
    setInterval(() => (this.minuteCount = 0), 60_000);
  }

  // ========= Utilities =========
  onLog(cb) { this.emitter.on('log', cb); }
  log(line) { try { this.emitter.emit('log', line); } catch {} }
  wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  normalizeArabic(s = '') {
    if (!s) return '';
    let t = s;
    t = t.replace(/[\u200c\u200d\u200e\u200f\u202a-\u202e]/g, ''); // محارف خفية/اتجاه
    t = t.replace(/[\u064B-\u0652\u0670]/g, '').replace(/\u0640/g, ''); // تشكيل+ألف خنجرية+تطويل
    t = t.replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي');
    const ar = '٠١٢٣٤٥٦٧٨٩', en = '0123456789';
    t = t.replace(/[٠-٩]/g, d => en[ar.indexOf(d)]);
    t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ');
    t = t.replace(/\s+/g, ' ').trim().toLowerCase();
    return t;
  }
  escapeRegex(s=''){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  buildNameRegex(normName) {
    const tokens = (normName || '').split(' ').filter(w => w.length >= 2);
    if (!tokens.length) return null;
    const pattern = tokens.map(tok => this.escapeRegex(tok)).join('[\\s\\p{P}]*');
    try { return new RegExp(`(?:^|\\s)${pattern}(?:\\s|$)`, 'u'); } catch { return null; }
  }

  _msgId(m){
    try { return m?.id?._serialized || m?.id?.id || null; } catch { return null; }
  }
  _isDone(msgId){ return !!(msgId && this.state.get(`done.${msgId}`)); }
  _markDone(msgId){ if (msgId) this.state.set(`done.${msgId}`, Date.now()); }

  setClients(arr = []) {
    const list = Array.isArray(arr) ? arr : [];
    this.clients = list.map(c => {
      const name = typeof c === 'string' ? c : (c.name || '');
      const emoji = typeof c === 'string' ? '✅' : (c.emoji || '✅');
      const norm = this.settings.normalizeArabic ? this.normalizeArabic(name) : (name || '').toLowerCase();
      const rx = this.buildNameRegex(norm);
      return { name, emoji, _norm: norm, _rx: rx };
    }).filter(x => x.name && x._rx);
    this.log(`clients loaded: ${this.clients.length}`);
  }

  setSettings(s = {}) {
    this.settings = Object.assign({}, this.settings, s);
    this.log(`[settings] mode=${this.settings.mode} rpm=${this.settings.ratePerMinute} cooldown=${this.settings.cooldownSec}s normalize=${!!this.settings.normalizeArabic}`);
    const raw = this.clients.map(({name, emoji}) => ({name, emoji}));
    this.setClients(raw); // إعادة بناء Regex لو تغيّر normalize
  }

  setSelectedGroups(ids = []) { this.selectedGroupIds = Array.isArray(ids) ? ids : []; }
  getSelectedGroups() { return this.selectedGroupIds; }

  getLastChecked(chatId) { return this.state.get(`lastChecked.${chatId}`, 0); }
  setLastChecked(chatId, tsMs) {
    const prev = this.getLastChecked(chatId) || 0;
    if (tsMs > prev) this.state.set(`lastChecked.${chatId}`, tsMs);
  }
  getLastCheckedMap() {
    const out = {};
    const all = this.state.store?.lastChecked || {};
    for (const [chatId, ts] of Object.entries(all)) out[chatId] = ts;
    return out;
  }

  // ========= WhatsApp init =========
  async init() {
    if (!fs.existsSync(this.sessionsDir)) fs.mkdirSync(this.sessionsDir, { recursive: true });

    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: this.sessionsDir }),
      puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    this.client.on('qr', async (qr) => {
      this.qrDataUrl = await qrcode.toDataURL(qr);
      this.isReady = false;
      this.log('[QR] جاهز — امسحه من WhatsApp');
    });

    this.client.on('ready', () => {
      this.isReady = true;
      this.qrDataUrl = null;
      this.log('✅ WhatsApp جاهز');
    });

    this.client.on('disconnected', (r) => {
      this.isReady = false;
      this.running = false;
      this.log('❌ تم قطع الاتصال: ' + r);
      try { this.client.initialize(); } catch {}
    });

    // رسائل حيّة → ادفع للـ FIFO queue
    this.client.on('message', async (msg) => {
      try {
        if (!this.running) return;
        if (msg.fromMe) return;

        const chat = await msg.getChat();
        if (!chat.isGroup) return;
        const chatId = chat.id._serialized;
        if (this.selectedGroupIds.length && !this.selectedGroupIds.includes(chatId)) return;

        const tsMs = (msg.timestamp ? msg.timestamp * 1000 : Date.now());
        const text = (msg.body || msg.caption || '').trim();
        const mid  = this._msgId(msg);

        // لو مُعالَجة سابقاً، حدث lastChecked فقط وتجاهل
        if (this._isDone(mid)) {
          this.setLastChecked(chatId, tsMs);
          return;
        }

        this.queue.push({
          kind: 'live',
          chatId,
          chatName: chat.name,
          tsMs,
          exec: async () => {
            await this._processOneMessage({ msgObj: msg, chatId, chatName: chat.name, tsMs, text, mid });
          }
        });

        this._runWorker();
      } catch (e) {
        this.log('⚠️ live message error: ' + (e.message || e));
      }
    });

    await this.client.initialize();
  }

  // ========= العامل: يضمن FIFO صارم =========
  async _runWorker() {
    if (this.workerRunning) return;
    this.workerRunning = true;

    while (this.running && this.queue.length > 0) {
      const item = this.queue.shift();
      try {
        await item.exec();
      } catch (e) {
        this.log(`[worker-error] ${e.message || e}`);
      }
    }

    this.workerRunning = false;
  }

  async _processOneMessage({ msgObj, chatId, chatName, tsMs, text, mid }) {
    // كوول داون لكل جروب
    const cd = Math.max(0, Number(this.settings.cooldownSec || 0));
    const lastCool = this.state.get(`cool.${chatId}`, 0);
    const since = Date.now() - lastCool;
    if (cd > 0 && since < cd * 1000) {
      await this.wait(cd * 1000 - since);
    }

    // حد/دقيقة عام
    const rpm = Math.max(1, Number(this.settings.ratePerMinute || 1));
    if (this.minuteCount >= rpm) {
      this.log('⏳ امتلأ حد الرد بالدقيقة — انتظار قصير…');
      await this.wait(4000);
    }

    // مطابقة اسم عميل
    const normBody = this.settings.normalizeArabic ? this.normalizeArabic(text) : (text || '').toLowerCase();
    let matched = null;
    for (const c of this.clients) { if (c._rx && c._rx.test(normBody)) { matched = c; break; } }

    if (matched) {
      try {
        if (this.settings.mode === 'text' && this.settings.replyText) {
          await msgObj.reply(this.settings.replyText);
        } else {
          await msgObj.react(matched.emoji || this.settings.emoji || '✅');
        }
        this.minuteCount += 1;
        this.state.set(`cool.${chatId}`, Date.now());
        this._markDone(mid);
        this.log(`↩️ ${chatName} → ${matched.name}`);
      } catch (e) {
        this.log('⚠️ react/reply error: ' + (e.message || e));
      }
    }

    // ✅ دوّن آخر نقطة دائماً
    this.setLastChecked(chatId, tsMs);
  }

  // ========= API =========
  async start() {
    if (!this.isReady) throw new Error('WhatsApp not ready');
    this.running = true;
    this.log('🚀 بدأ التفاعل');
    this._runWorker();
  }
  async stop() {
    this.running = false;
    this.log('🛑 تم الإيقاف');
  }

  getStatus() {
    return {
      isReady: this.isReady,
      running: this.running,
      selectedGroupIds: this.selectedGroupIds,
      clients: this.clients.map(({name, emoji}) => ({name, emoji})),
      settings: this.settings,
      queueSize: this.queue.length
    };
  }
  async getQR() {
    if (this.qrDataUrl) return { qr: this.qrDataUrl };
    if (this.isReady) return { message: 'Already connected' };
    return { error: 'QR not available yet' };
  }
  async fetchGroups() {
    if (!this.isReady) throw new Error('WhatsApp not ready');
    const chats = await this.client.getChats();
    const groups = chats.filter(c => c.isGroup).map(c => ({
      id: c.id._serialized,
      name: c.name,
      count: Array.isArray(c.participants) ? c.participants.length : 0
    }));
    this.log(`📥 تم جلب المجموعات: ${groups.length}`);
    return groups;
  }

  // أرشيف: نحترم since + نتجنب الرسائل المعالجة سابقاً + FIFO
  async processBacklog({ startAtMs = null, limitPerChat = 800 } = {}) {
    if (!this.client || !this.isReady) throw new Error('WhatsApp not ready');

    const chats = await this.client.getChats();
    const groups = chats.filter(
      c => c.isGroup && (this.selectedGroupIds.length ? this.selectedGroupIds.includes(c.id._serialized) : true)
    );

    for (const chat of groups) {
      const chatId = chat.id._serialized;
      const since = startAtMs ?? this.getLastChecked(chatId) ?? 0;
      this.log(`[backlog] ${chat.name} since ${since ? new Date(since).toLocaleString() : '—'}`);

      let fetched = 0;
      let cursor = null;
      const batch = 200;

      while (fetched < limitPerChat) {
        const msgs = await chat.fetchMessages({ limit: Math.min(batch, limitPerChat - fetched), before: cursor || undefined });
        if (!msgs.length) break;

        const ordered = msgs.slice().reverse(); // أقدم → أحدث
        for (const m of ordered) {
          const tsMs = (m.timestamp || 0) * 1000;
          if (tsMs <= since) continue;
          if (m.fromMe) continue;
          const mid = this._msgId(m);
          if (this._isDone(mid)) { this.setLastChecked(chatId, tsMs); continue; }

          const text = (m.body || m.caption || '').trim();
          this.queue.push({
            kind: 'backlog',
            chatId,
            chatName: chat.name,
            tsMs,
            exec: async () => {
              await this._processOneMessage({ msgObj: m, chatId, chatName: chat.name, tsMs, text, mid });
            }
          });
        }

        fetched += msgs.length;
        cursor = msgs[msgs.length - 1];
        if (msgs.length < batch) break;
      }
    }

    this._runWorker();
  }

  // فحص الأرشيف: عدد الرسائل "المطابقة" فقط (إن ما في عملاء، يرجّع 0)
  async countBacklog({ startAtMs = null, limitPerChat = 800 } = {}) {
    if (!this.client || !this.isReady) throw new Error('WhatsApp not ready');

    const chats = await this.client.getChats();
    const groups = chats.filter(
      c => c.isGroup && (this.selectedGroupIds.length ? this.selectedGroupIds.includes(c.id._serialized) : true)
    );

    let total = 0;
    const byGroup = [];

    for (const chat of groups) {
      const chatId = chat.id._serialized;
      const since = startAtMs ?? this.getLastChecked(chatId) ?? 0;

      let fetched = 0;
      let cursor = null;
      const batch = 200;
      let count = 0;

      while (fetched < limitPerChat) {
        const msgs = await chat.fetchMessages({ limit: Math.min(batch, limitPerChat - fetched), before: cursor || undefined });
        if (!msgs.length) break;

        const ordered = msgs.slice().reverse(); // أقدم → أحدث
        for (const m of ordered) {
          const tsMs = (m.timestamp || 0) * 1000;
          if (tsMs <= since) continue;
          if (m.fromMe) continue;

          const mid = this._msgId(m);
          if (this._isDone(mid)) continue;

          const text = (m.body || m.caption || '').trim();
          if (!text) continue;

          if (this.clients && this.clients.length) {
            const normBody = this.settings.normalizeArabic ? this.normalizeArabic(text) : text.toLowerCase();
            const match = this.clients.some(c => c._rx && c._rx.test(normBody));
            if (match) count++;
          }
        }

        fetched += msgs.length;
        cursor = msgs[msgs.length - 1];
        if (msgs.length < batch) break;
      }

      byGroup.push({ id: chatId, name: chat.name, count });
      total += count;
    }

    return { total, byGroup };
  }
}

module.exports = { Bot };