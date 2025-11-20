// bot.js — FIFO صارم + lastChecked per group + backlog + منع تكرار + تطبيع عربي قوي

const EventEmitter = require('events');
const fs = require('fs');
const qrcode = require('qrcode');
const Store = require('electron-store');
const { Client, LocalAuth } = require('whatsapp-web.js');
const puppeteer = require('puppeteer');

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
    this.rawClients = [];
    this.nameLists = []; // [{id,label,emoji,targetGroupId,forward,items:[{name,_norm,_rx}]}]
    this.rawNameLists = [];
    this.settings = {
      emoji: '✅',
      replyText: 'تم ✅',
      mode: 'emoji',                 // 'emoji' | 'text'
      ratePerMinute: 20,             // حد عام/دقيقة
      cooldownSec: 3,                // مهلة لكل جروب (ثواني)
      normalizeArabic: true
    };
    this.lastActivityTs = 0;

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

  normalizeArabic(text = '') {
    if (!text) return '';
    let out = String(text);
    out = out.replace(/[\u200c\u200d\u200e\u200f\u202a-\u202e]/g, '');
    out = out.replace(/[\u064B-\u0652\u0670]/g, '').replace(/\u0640/g, '');
    out = out
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه')
      .replace(/ؤ/g, 'و')
      .replace(/ئ/g, 'ي');
    const arDigits = '٠١٢٣٤٥٦٧٨٩';
    const enDigits = '0123456789';
    out = out.replace(/[٠-٩]/g, (d) => enDigits[arDigits.indexOf(d)]);
    out = out.replace(/[^\p{L}\p{N}\s]/gu, ' ');
    out = out.replace(/\s+/g, ' ').trim().toLowerCase();
    return out;
  }
  escapeRegex(s=''){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  buildNameRegex(normName) {
    const tokens = (normName || '').split(' ').filter(Boolean);
    if (!tokens.length) return null;
    const pattern = tokens.map(tok => this.escapeRegex(tok)).join('[\\s\\p{P}]*');
    try { return new RegExp(pattern, 'iu'); } catch { return null; }
  }

  _normalizeMaybe(text = '') {
    if (!text) return '';
    if (this.settings.normalizeArabic) return this.normalizeArabic(text);
    return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  _msgId(m){
    try { return m?.id?._serialized || m?.id?.id || null; } catch { return null; }
  }
  _isDone(msgId){ return !!(msgId && this.state.get(`done.${msgId}`)); }
  _markDone(msgId){ if (msgId) this.state.set(`done.${msgId}`, Date.now()); }

  async _respectCooldown(chatId) {
    const cd = Math.max(0, Number(this.settings.cooldownSec || 0));
    if (!cd) return;
    const last = this.state.get(`cool.${chatId}`, 0);
    const diff = Date.now() - last;
    if (diff < cd * 1000) {
      await this.wait(cd * 1000 - diff);
    }
  }

  async _respectRateLimit() {
    const rpm = Math.max(1, Number(this.settings.ratePerMinute || 1));
    while (this.minuteCount >= rpm) {
      this.log('⏳ امتلأ حد الرد بالدقيقة — انتظار قصير…');
      await this.wait(1500);
    }
  }

  _findMatch(normBody) {
    if (!normBody) return null;
    for (const list of this.nameLists) {
      for (const item of list.items) {
        if (item._rx?.test(normBody)) {
          return { type: 'nameList', list, item };
        }
      }
    }
    for (const client of this.clients) {
      if (client._rx?.test(normBody)) {
        return { type: 'client', client };
      }
    }
    return null;
  }

  _pickEmoji(match) {
    if (!match) return this.settings.emoji || '✅';
    if (match.type === 'nameList') {
      return match.list.emoji || this.settings.emoji || '✅';
    }
    if (match.type === 'client') {
      return match.client.emoji || this.settings.emoji || '✅';
    }
    return this.settings.emoji || '✅';
  }

  _recordNameListHit(list, item, chatId) {
    if (!list?.id || !item?._norm) return;
    const stats = this.state.get('nameListStats') || {};
    if (!stats[list.id]) stats[list.id] = {};
    const prev = stats[list.id][item._norm] || {};
    stats[list.id][item._norm] = {
      name: item.name || prev.name || '',
      count: (prev.count || 0) + 1,
      lastAt: Date.now(),
      lastChatId: chatId
    };
    this.state.set('nameListStats', stats);
  }

  setClients(arr = []) {
    this.rawClients = Array.isArray(arr) ? arr : [];
    this._rebuildClients();
  }

  _rebuildClients() {
    const list = Array.isArray(this.rawClients) ? this.rawClients : [];
    this.clients = list.map((c) => {
      const name = typeof c === 'string' ? c : (c.name || '');
      const emoji = typeof c === 'string' ? '✅' : (c.emoji || '✅');
      const norm = this._normalizeMaybe(name);
      const rx = this.buildNameRegex(norm);
      return { name, emoji, _norm: norm, _rx: rx };
    }).filter((x) => x.name && x._rx);
    this.log(`clients loaded: ${this.clients.length}`);
  }

  setNameLists(arr = []) {
    this.rawNameLists = Array.isArray(arr) ? arr : [];
    this._rebuildNameLists();
  }

  _rebuildNameLists() {
    const lists = Array.isArray(this.rawNameLists) ? this.rawNameLists : [];
    let idx = 0;
    this.nameLists = lists.map((l) => {
      const id = String(l.id || `list-${idx++}`);
      const label = l.label || id;
      const emoji = l.emoji || '';
      const targetGroupId = l.targetGroupId || null;
      const forward = !!l.forward;
      const namesArr = Array.isArray(l.names) ? l.names : [];
      const items = namesArr.map((name) => {
        const value = typeof name === 'string' ? name : (name?.name || '');
        const norm = this._normalizeMaybe(value);
        const rx = this.buildNameRegex(norm);
        return rx ? { name: value, _norm: norm, _rx: rx } : null;
      }).filter(Boolean);
      return { id, label, emoji, targetGroupId, forward, items };
    }).filter((l) => l.items.length > 0);
    this.log(`name lists loaded: ${this.nameLists.length}`);
  }

  setSettings(s = {}) {
    this.settings = Object.assign({}, this.settings, s);
    this.log(`[settings] mode=${this.settings.mode} rpm=${this.settings.ratePerMinute} cooldown=${this.settings.cooldownSec}s normalize=${!!this.settings.normalizeArabic}`);
    this._rebuildClients();
    this._rebuildNameLists();
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
      authStrategy: new LocalAuth({ clientId: 'main-session', dataPath: this.sessionsDir }),
      puppeteer: {
        headless: true,
        executablePath: puppeteer.executablePath(),
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
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

    this.client.on('auth_failure', (msg) => {
      this.log('⚠️ auth_failure: ' + (msg || ''));
    });

    this.client.on('change_state', (state) => {
      this.log('ℹ️ state changed: ' + (state || 'unknown'));
    });

    this.client.on('disconnected', (r) => {
      this.isReady = false;
      this.running = false;
      this.log('❌ تم قطع الاتصال: ' + r);
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
    const cleanText = (text || '').trim();
    if (!cleanText) {
      this.setLastChecked(chatId, tsMs);
      return;
    }

    const normBody = this._normalizeMaybe(cleanText);
    const match = this._findMatch(normBody);
    if (!match) {
      this.setLastChecked(chatId, tsMs);
      return;
    }

    await this._respectCooldown(chatId);
    await this._respectRateLimit();

    const emoji = this._pickEmoji(match);
    const replyText = this.settings.replyText || 'تم ✅';

    try {
      if (this.settings.mode === 'text') {
        await msgObj.reply(replyText);
      } else {
        await msgObj.react(emoji);
      }
    } catch (e) {
      this.log('⚠️ react/reply error: ' + (e.message || e));
    }

    if (match.type === 'nameList') {
      this._recordNameListHit(match.list, match.item, chatId);
      if (match.list.forward && match.list.targetGroupId) {
        try {
          await msgObj.forward(match.list.targetGroupId);
        } catch (e) {
          this.log(`⚠️ forward error (${match.list.id}): ${e.message || e}`);
        }
      }
    }

    this.minuteCount += 1;
    this.state.set(`cool.${chatId}`, Date.now());
    this._markDone(mid);
    this.lastActivityTs = Date.now();

    const label = match.type === 'nameList'
      ? `${match.list.label || match.list.id} → ${match.item.name}`
      : (match.client.name || 'client');
    this.log(`↩️ ${chatName} → ${label}`);

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
      queueSize: this.queue.length,
      lastActivityTs: this.lastActivityTs,
      nameListsCount: this.nameLists.length
    };
  }
  async getQR() {
    if (this.qrDataUrl) return { qr: this.qrDataUrl };
    if (this.isReady) return { message: 'Already connected' };
    return { error: 'QR not available yet' };
  }
  async fetchGroups() {
    if (!this.client) throw new Error('WhatsApp client not initialized');
    if (!this.isReady) throw new Error('WhatsApp not ready');
    try {
      const chats = await this.client.getChats();
      const groups = chats.filter(c => c.isGroup).map(c => ({
        id: c.id._serialized,
        name: c.name,
        count: Array.isArray(c.participants) ? c.participants.length : 0
      }));
      this.log(`📥 تم جلب المجموعات: ${groups.length}`);
      return groups;
    } catch (err) {
      this.log(`⚠️ fetchGroups error: ${err.message || err}`);
      throw err;
    }
  }

  // فحص الأرشيف بدون إرسال ردود — يرجّع أرقام فقط
  async processBacklog({ startAtMs = null, limitPerChat = 800 } = {}) {
    if (!this.client) throw new Error('WhatsApp client not initialized');
    if (!this.isReady) throw new Error('WhatsApp not ready');

    let chats;
    try {
      chats = await this.client.getChats();
    } catch (err) {
      this.log(`⚠️ processBacklog chats error: ${err.message || err}`);
      throw err;
    }

    const groups = chats.filter(
      (c) => c.isGroup && (this.selectedGroupIds.length ? this.selectedGroupIds.includes(c.id._serialized) : true)
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

        const ordered = msgs.slice().reverse();
        for (const m of ordered) {
          const tsMs = (m.timestamp || 0) * 1000;
          if (tsMs <= since) continue;
          if (m.fromMe) continue;

          const mid = this._msgId(m);
          if (this._isDone(mid)) continue;

          const text = (m.body || m.caption || '').trim();
          if (!text) continue;

          const normBody = this._normalizeMaybe(text);
          const match = this._findMatch(normBody);
          if (match) count += 1;
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

  getNameListsStats() {
    const stats = this.state.get('nameListStats') || {};
    return this.nameLists.map((list) => {
      const listStats = stats[list.id] || {};
      const items = list.items.map((item) => {
        const entry = listStats[item._norm] || {};
        return {
          name: entry.name || item.name,
          count: entry.count || 0,
          lastAt: entry.lastAt || null,
          lastChatId: entry.lastChatId || null
        };
      });
      return {
        id: list.id,
        label: list.label,
        emoji: list.emoji,
        targetGroupId: list.targetGroupId,
        forward: list.forward,
        items
      };
    });
  }
}

module.exports = { Bot };
