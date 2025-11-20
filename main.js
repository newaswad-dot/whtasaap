// main.js — مع دعم الإرسال الجماعي (Bulk) + تحميل تلقائي للإعدادات/العملاء/المجموعات

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { Bot } = require('./bot');

const store = new Store.default();
let win;
let bot;

// ضبط اسم التطبيق ومسارات التخزين إلى الاسم الجديد
app.setName('NovaWhatsBot');
app.setAppUserModelId('com.ahmad.nova-whats-bot');
app.setPath('userData', path.join(app.getPath('appData'), 'nova-whats-bot'));

/* ===== Bulk (إرسال جماعي) — ضعه قبل استخدامه ===== */
const BulkStore = new (require('electron-store').default)({ name: 'bulk-state' });
let bulkState = {
  running: false,
  paused: false,
  groupId: null,
  messages: [],
  index: 0,
  total: 0,
  delaySec: 3,
  rpm: 20,
  lastMinute: { ts: 0, count: 0 }
};
/* ================================================ */

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    title: 'بوت واتساب — سطح المكتب'
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  const sessionsDir = path.join(app.getPath('userData'), 'sessions');
  bot = new Bot({ sessionsDir });

  bot.onLog((line) => { if (win) win.webContents.send('bot-log', line); });

  await bot.init();

  // ✅ حمّل الإعدادات/العملاء/المجموعات تلقائياً عند الإقلاع
  try {
    const initSettings = store.get('settings') || {};
    const initClients  = store.get('clients')  || [];
    const initGroups   = store.get('selectedGroupIds') || [];
    const initNameLists = store.get('nameLists') || [];
    bot.setSettings(initSettings);
    bot.setClients(initClients);
    bot.setNameLists(initNameLists);
    bot.setSelectedGroups(initGroups);
    bot.log('[init] preloaded settings/clients/groups');
  } catch (e) {
    bot.log('[init] preload failed: ' + (e.message || e));
  }

  // استعادة حالة الإرسال الجماعي (إن وُجدت)
  try {
    const cp = BulkStore.get('checkpoint');
    const running = BulkStore.get('running');
    if (cp && running) {
      bulkState.groupId = cp.groupId || null;
      bulkState.messages = Array.isArray(cp.messages) ? cp.messages : [];
      bulkState.total = cp.total || bulkState.messages.length || 0;
      bulkState.index = cp.index || 0;
      bulkState.running = false; // لا نبدأ تلقائياً
    }
  } catch {}

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

/* ============ IPC (القائمة الأساسية) ============ */
ipcMain.handle('get-status', async () => bot.getStatus());
ipcMain.handle('get-qr', async () => bot.getQR());
ipcMain.handle('fetch-groups', async () => bot.fetchGroups());

ipcMain.handle('save-groups', async (_e, ids) => {
  store.set('selectedGroupIds', Array.isArray(ids) ? ids : []);
  bot.setSelectedGroups(store.get('selectedGroupIds') || []);
  return { ok: true, count: bot.getSelectedGroups().length };
});
ipcMain.handle('get-groups-saved', async () => bot.getSelectedGroups());

ipcMain.handle('save-clients', async (_e, rawText) => {
  const settings = store.get('settings') || {};
  const fallbackEmoji = settings.emoji || '✅';

  const lines = String(rawText || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const arr = [];
  const seen = new Set();
  for (const line of lines) {
    const [n, e] = line.split('|');
    const name = (n || '').trim();
    const emoji = (e || '').trim() || fallbackEmoji;
    if (!name) continue;
    const key = name + '|' + emoji;
    if (seen.has(key)) continue;
    seen.add(key);
    arr.push({ name, emoji });
  }
  store.set('clients', arr);
  bot.setClients(arr);
  return { ok: true, count: arr.length };
});
ipcMain.handle('get-clients', async () => store.get('clients') || []);

ipcMain.handle('set-settings', async (_e, s) => {
  const defaults = { emoji: '✅', replyText: 'تم ✅', mode: 'emoji', ratePerMinute: 20, cooldownSec: 3, normalizeArabic: true };
  const merged = Object.assign({}, defaults, store.get('settings') || {}, s || {});
  store.set('settings', merged);
  bot.setSettings(merged);
  return merged;
});
ipcMain.handle('get-settings', async () => store.get('settings') || { emoji: '✅', replyText: 'تم ✅', mode: 'emoji', ratePerMinute: 20, cooldownSec: 3, normalizeArabic: true });

ipcMain.handle('save-name-lists', async (_e, lists) => {
  const arr = Array.isArray(lists) ? lists.map((l, idx) => ({
    id: String(l.id || `list-${idx}`),
    label: l.label || '',
    emoji: l.emoji || '',
    targetGroupId: l.targetGroupId || null,
    forward: !!l.forward,
    names: Array.isArray(l.names) ? l.names.filter((n) => typeof n === 'string' && n.trim().length).map((n) => n.trim()) : []
  })) : [];
  store.set('nameLists', arr);
  bot.setNameLists(arr);
  return { ok: true, count: arr.length };
});
ipcMain.handle('get-name-lists', async () => store.get('nameLists') || []);
ipcMain.handle('get-name-lists-stats', async () => bot.getNameListsStats());

ipcMain.handle('start-bot', async () => {
  bot.setSettings(store.get('settings') || {});
  bot.setClients(store.get('clients') || []);
  bot.setNameLists(store.get('nameLists') || []);
  bot.setSelectedGroups(store.get('selectedGroupIds') || []);
  await bot.start();
  return bot.getStatus();
});
ipcMain.handle('stop-bot', async () => { await bot.stop(); return bot.getStatus(); });

ipcMain.handle('get-last-checked', async () => bot.getLastCheckedMap());
ipcMain.handle('check-backlog', async (_e, opts) => {
  const res = await bot.processBacklog(opts || {});
  return res;
});

/* ============ Bulk (إرسال جماعي) ============ */
async function bulkSendLoop() {
  if (!bot || !bot.isReady || !bulkState.running) return;

  const resetMinuteIfNeeded = () => {
    const now = Date.now();
    if (now - bulkState.lastMinute.ts > 60_000) {
      bulkState.lastMinute = { ts: now, count: 0 };
    }
  };
  resetMinuteIfNeeded();

  while (bulkState.running) {
    if (bulkState.paused) { await new Promise(r => setTimeout(r, 500)); continue; }
    if (bulkState.index >= bulkState.total) { bulkState.running = false; break; }

    resetMinuteIfNeeded();
    if (bulkState.lastMinute.count >= bulkState.rpm) {
      const toWait = 60_000 - (Date.now() - bulkState.lastMinute.ts);
      await new Promise(r => setTimeout(r, Math.max(500, toWait)));
      continue;
    }

    const text = bulkState.messages[bulkState.index];
    try {
      await bot.client.sendMessage(bulkState.groupId, text);
      bulkState.index += 1;
      bulkState.lastMinute.count += 1;

      BulkStore.set('checkpoint', {
        groupId: bulkState.groupId,
        index: bulkState.index,
        total: bulkState.total,
        messages: bulkState.messages
      });

      if (bulkState.delaySec > 0) {
        await new Promise(r => setTimeout(r, bulkState.delaySec * 1000));
      }
    } catch (e) {
      if (win) win.webContents.send('bot-log', `⚠️ bulk send error: ${e.message || e}`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  if (win) win.webContents.send('bot-log', '✅ bulk finished');
  bulkState.running = false;
  BulkStore.set('running', false);
}

ipcMain.handle('bulk-start', async (_e, opts) => {
  if (!bot || !bot.isReady) throw new Error('WhatsApp not ready');
  const { groupId, messages, delaySec = 3, rpm = 20 } = opts || {};
  if (!groupId) throw new Error('groupId required');
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages required');

  bulkState = {
    running: true,
    paused: false,
    groupId,
    messages,
    index: 0,
    total: messages.length,
    delaySec: Math.max(0, Number(delaySec)),
    rpm: Math.max(1, Number(rpm)),
    lastMinute: { ts: Date.now(), count: 0 }
  };
  BulkStore.set('running', true);
  BulkStore.set('checkpoint', { groupId, index: 0, total: messages.length, messages });

  bulkSendLoop().catch(() => {});
  return { ok: true };
});
ipcMain.handle('bulk-pause', async () => { bulkState.paused = true; return { ok: true }; });
ipcMain.handle('bulk-resume', async () => {
  if (!bulkState.running) bulkState.running = true;
  bulkState.paused = false;
  bulkSendLoop().catch(() => {});
  return { ok: true };
});
ipcMain.handle('bulk-cancel', async () => {
  bulkState.running = false; bulkState.paused = false;
  BulkStore.set('running', false);
  return { ok: true };
});
ipcMain.handle('bulk-status', async () => {
  const status = bot.getStatus();
  return { ...status, bulk: { running: bulkState.running, paused: bulkState.paused, index: bulkState.index, total: bulkState.total } };
});
ipcMain.handle('bulk-save-draft', async (_e, d) => { BulkStore.set('draft', d || null); return { ok: true }; });
ipcMain.handle('bulk-load-draft', async () => BulkStore.get('draft') || null);
ipcMain.handle('bulk-save-settings', async (_e, s) => { BulkStore.set('settings', s || {}); return { ok: true }; });
ipcMain.handle('bulk-load-settings', async () => BulkStore.get('settings') || { delaySec: 3, rpm: 20 });