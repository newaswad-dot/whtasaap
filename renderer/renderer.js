const $ = (id) => document.getElementById(id);
const logBox = $('log');
let nameListsModel = [];

function log(message){
  if (!logBox) return;
  const tm = new Date().toLocaleTimeString();
  logBox.textContent += `[${tm}] ${message}\n`;
  logBox.scrollTop = logBox.scrollHeight;
}

window.api.onLog((line) => log(line));

function fmtTs(ts){
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(); } catch { return '—'; }
}

function getBacklogStartTs(){
  const el = $('backlogDate');
  if (!el || !el.value) return null;
  const dt = new Date(el.value);
  return Number.isNaN(dt.getTime()) ? null : dt.getTime();
}

async function refreshStatus(){
  const s = await window.api.getStatus();
  $('pill-ready').textContent = s.isReady ? 'متصل' : 'غير متصل';
  $('pill-running').textContent = s.running ? 'شغّال' : 'متوقف';
}

async function showQR(){
  const box = $('qr-box');
  if (!box) return;
  box.style.display = 'block';
  box.innerHTML = '<div class="muted">جارِ جلب QR…</div>';
  const r = await window.api.getQR();
  if(r.qr){
    const img = new Image();
    img.src = r.qr;
    box.innerHTML = '';
    box.appendChild(img);
  }else{
    box.innerHTML = `<div class="muted">${r.message || r.error || 'QR غير جاهز'}</div>`;
  }
}

function renderGroups(list, selectedSet, lastMap){
  const box = $('groups');
  if (!box) return;
  box.innerHTML = '';
  list.forEach(g => {
    const row = document.createElement('div');
    row.className = 'group';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = g.id;
    cb.checked = selectedSet.has(g.id);
    const name = document.createElement('div');
    name.style.flex = '1';
    name.innerHTML = `<strong>${g.name}</strong> <span class="muted">(${g.count||0})</span>`;
    const last = document.createElement('div');
    last.className = 'muted last-col';
    last.textContent = `آخر معالجة: ${fmtTs(lastMap[g.id])}`;
    row.append(cb, name, last);
    box.append(row);
  });
}

async function fetchGroups(){
  const box = $('groups');
  if (box) box.innerHTML = '<div class="muted">جارِ جلب المجموعات…</div>';
  try{
    const [list, saved, lastMap] = await Promise.all([
      window.api.fetchGroups(),
      window.api.getSavedGroups(),
      window.api.getLastChecked()
    ]);
    renderGroups(list, new Set(saved || []), lastMap || {});
    log(`تم جلب المجموعات: ${list.length}`);
  }catch(e){
    if (box) box.innerHTML='تعذر الجلب';
    log('تعذر جلب المجموعات: ' + (e.message || e));
  }
}

async function saveGroups(){
  const ids = [...$('groups').querySelectorAll('input[type=checkbox]:checked')].map(i=>i.value);
  const r = await window.api.saveGroups(ids);
  log(`حُفظت المجموعات: ${r.count}`);
}

async function saveClients(){
  const raw = $('clientsText').value;
  const r = await window.api.saveClients(raw);
  if(r.ok) log(`حُفظ العملاء: ${r.count}`); else log(`فشل حفظ العملاء: ${r.error}`);
}
async function loadClients(){
  const arr = await window.api.getClients();
  $('clientsText').value = (arr || []).map(c => (c.emoji ? `${c.name}|${c.emoji}` : c.name)).join('\n');
  log(`تم تحميل العملاء (${arr.length})`);
}

async function saveSettings(){
  const s = await window.api.setSettings({
    emoji: $('settings-emoji').value.trim() || '✅',
    ratePerMinute: Number($('settings-rpm').value || 20),
    cooldownSec: Number($('settings-cooldown').value || 3),
    normalizeArabic: $('settings-normalize').checked,
    mode: $('settings-mode-text').checked ? 'text' : 'emoji',
    replyText: $('settings-reply-text').value.trim() || 'تم ✅'
  });
  log('حُفظت الإعدادات');
}
async function loadSettings(){
  const s = await window.api.getSettings();
  $('settings-emoji').value = s.emoji || '✅';
  $('settings-rpm').value = s.ratePerMinute ?? 20;
  $('settings-cooldown').value = s.cooldownSec ?? 3;
  $('settings-reply-text').value = s.replyText || 'تم ✅';
  $('settings-normalize').checked = s.normalizeArabic !== false;
  if (s.mode === 'text') {
    $('settings-mode-text').checked = true;
  } else {
    $('settings-mode-emoji').checked = true;
  }
}

function renderNameLists(){
  const container = $('nameListsContainer');
  if (!container) return;
  if (!nameListsModel.length){
    container.classList.add('muted');
    container.textContent = 'لا توجد قوائم بعد.';
    return;
  }
  container.classList.remove('muted');
  container.innerHTML = '';
  nameListsModel.forEach((list, idx) => {
    const block = document.createElement('div');
    block.className = 'name-list-item';
    block.dataset.persistedId = list.id || '';

    const header = document.createElement('h4');
    const title = document.createElement('span');
    title.textContent = list.label || list.id || `#${idx + 1}`;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'danger';
    removeBtn.textContent = 'حذف';
    removeBtn.onclick = () => {
      syncNameListsFromDom();
      nameListsModel.splice(idx, 1);
      renderNameLists();
    };
    header.append(title, removeBtn);
    block.appendChild(header);

    const row1 = document.createElement('div');
    row1.className = 'row3';
    row1.style.gap = '10px';

    const idWrap = document.createElement('div');
    idWrap.innerHTML = '<label>المعرف (id)</label>';
    const idInput = document.createElement('input');
    idInput.type = 'text';
    idInput.className = 'nl-id';
    idInput.value = list.id || '';
    idWrap.appendChild(idInput);

    const labelWrap = document.createElement('div');
    labelWrap.innerHTML = '<label>الاسم الظاهر</label>';
    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'nl-label';
    labelInput.value = list.label || '';
    labelWrap.appendChild(labelInput);

    const emojiWrap = document.createElement('div');
    emojiWrap.innerHTML = '<label>الإيموجي</label>';
    const emojiInput = document.createElement('input');
    emojiInput.type = 'text';
    emojiInput.className = 'nl-emoji';
    emojiInput.maxLength = 8;
    emojiInput.value = list.emoji || '';
    emojiWrap.appendChild(emojiInput);

    row1.append(idWrap, labelWrap, emojiWrap);
    block.appendChild(row1);

    const row2 = document.createElement('div');
    row2.style.display = 'grid';
    row2.style.gridTemplateColumns = '2fr 1fr';
    row2.style.gap = '10px';
    row2.style.marginTop = '10px';

    const targetWrap = document.createElement('div');
    targetWrap.innerHTML = '<label>مجموعة الهدف (اختياري)</label>';
    const targetInput = document.createElement('input');
    targetInput.type = 'text';
    targetInput.className = 'nl-target';
    targetInput.value = list.targetGroupId || '';
    targetWrap.appendChild(targetInput);

    const forwardWrap = document.createElement('div');
    forwardWrap.className = 'chk';
    forwardWrap.style.marginTop = '28px';
    const forwardInput = document.createElement('input');
    forwardInput.type = 'checkbox';
    forwardInput.className = 'nl-forward';
    forwardInput.checked = !!list.forward;
    const forwardLabel = document.createElement('label');
    forwardLabel.textContent = 'إعادة التوجيه بعد التطابق';
    forwardWrap.append(forwardInput, forwardLabel);

    row2.append(targetWrap, forwardWrap);
    block.appendChild(row2);

    const namesWrap = document.createElement('div');
    namesWrap.style.marginTop = '10px';
    const namesLabel = document.createElement('label');
    namesLabel.textContent = 'الأسماء (سطر لكل اسم)';
    const namesTextarea = document.createElement('textarea');
    namesTextarea.className = 'nl-names';
    namesTextarea.value = (list.names || []).join('\n');
    namesWrap.append(namesLabel, namesTextarea);

    block.appendChild(namesWrap);
    container.appendChild(block);
  });
}

function syncNameListsFromDom(){
  const container = $('nameListsContainer');
  if (!container) return;
  const blocks = [...container.querySelectorAll('.name-list-item')];
  if (!blocks.length){
    nameListsModel = [];
    return;
  }
  nameListsModel = blocks.map((block, order) => {
    const persisted = block.dataset.persistedId || '';
    const id = block.querySelector('.nl-id')?.value?.trim() || persisted || `list-${order + 1}`;
    const label = block.querySelector('.nl-label')?.value?.trim() || '';
    const emoji = block.querySelector('.nl-emoji')?.value?.trim() || '';
    const targetGroupId = block.querySelector('.nl-target')?.value?.trim() || '';
    const forward = block.querySelector('.nl-forward')?.checked || false;
    const namesText = block.querySelector('.nl-names')?.value || '';
    const names = namesText.split(/\r?\n/).map(n => n.trim()).filter(Boolean);
    return { id, label, emoji, targetGroupId, forward, names };
  });
}

function addNameList(){
  syncNameListsFromDom();
  nameListsModel.push({ id: '', label: '', emoji: '', targetGroupId: '', forward: false, names: [] });
  renderNameLists();
}

async function saveNameLists(){
  syncNameListsFromDom();
  const payload = nameListsModel.map((list, idx) => ({
    id: list.id || `list-${idx + 1}`,
    label: list.label || '',
    emoji: list.emoji || '',
    targetGroupId: list.targetGroupId || null,
    forward: !!list.forward,
    names: (list.names || []).filter(Boolean)
  }));
  const res = await window.api.saveNameLists(payload);
  nameListsModel = payload.map((l) => ({ ...l, targetGroupId: l.targetGroupId || '' }));
  renderNameLists();
  log(`حُفظت قوائم الأسماء (${res.count || payload.length})`);
  refreshNameListStats();
}

async function loadNameLists(){
  const lists = await window.api.getNameLists();
  nameListsModel = (lists || []).map((l, idx) => ({
    id: l.id || `list-${idx + 1}`,
    label: l.label || '',
    emoji: l.emoji || '',
    targetGroupId: l.targetGroupId || '',
    forward: !!l.forward,
    names: Array.isArray(l.names) ? l.names : []
  }));
  renderNameLists();
  log(`تم تحميل قوائم الأسماء (${nameListsModel.length})`);
}

async function refreshNameListStats(){
  const box = $('nameListsStats');
  if (!box) return;
  box.textContent = 'جارِ تحديث الإحصائيات…';
  try {
    const stats = await window.api.getNameListsStats();
    if (!stats.length){
      box.textContent = 'لا توجد بيانات بعد.';
      return;
    }
    box.innerHTML = stats.map((list) => {
      const header = `<div><strong>${list.label || list.id}</strong> ${list.emoji || ''}</div>`;
      const items = (list.items || []).map((item) => `<div>- ${item.name || '—'}: ${item.count || 0} (آخر: ${fmtTs(item.lastAt)})</div>`).join('');
      return `<div style="margin-bottom:8px">${header}${items || '<div class="muted">لا عناصر</div>'}</div>`;
    }).join('');
  } catch (e) {
    box.textContent = 'تعذر تحميل الإحصائيات';
    log('فشل جلب إحصاءات القوائم: ' + (e.message || e));
  }
}

function renderBacklogResults(res){
  const box = $('backlogResults');
  if (!box) return;
  if (!res){
    box.textContent = 'لا يوجد فحص بعد.';
    return;
  }
  const lines = [`المجموع: ${res.total || 0}`];
  (res.byGroup || []).forEach((g) => lines.push(`${g.name || g.id}: ${g.count || 0}`));
  box.innerHTML = lines.map((line) => `<div>${line}</div>`).join('');
}

$('btn-show-qr').onclick = showQR;
$('btn-fetch-groups').onclick = fetchGroups;
$('btn-save-groups').onclick = saveGroups;
$('btn-save-clients').onclick = saveClients;
$('btn-load-clients').onclick = loadClients;
$('btn-save-settings').onclick = saveSettings;
$('btn-load-settings').onclick = loadSettings;
$('btn-refresh-status').onclick = refreshStatus;
$('btn-add-name-list').onclick = addNameList;
$('btn-save-name-lists').onclick = saveNameLists;
$('btn-load-name-lists').onclick = loadNameLists;
$('btn-refresh-stats').onclick = refreshNameListStats;
$('btn-start').onclick = async () => { await window.api.startBot(); await refreshStatus(); log('بدء التفاعل'); };
$('btn-stop').onclick  = async () => { await window.api.stopBot();  await refreshStatus(); log('إيقاف التفاعل'); };
$('btn-check-backlog').onclick = async ()=>{
  const startAtMs = getBacklogStartTs();
  log('جارِ فحص الأرشيف…');
  try{
    const res = await window.api.checkBacklog({ startAtMs, limitPerChat: 800 });
    renderBacklogResults(res);
    log(`نتيجة الفحص: ${res.total} رسالة مرشّحة`);
  }catch(e){
    log('فشل فحص الأرشيف: ' + (e.message || e));
  }
};

(async function init(){
  await refreshStatus();
  await loadSettings();
  await loadClients();
  await loadNameLists();
  await refreshNameListStats();
  try {
    const saved = await window.api.getSavedGroups();
    if(saved && saved.length) {
      const [list, lastMap] = await Promise.all([window.api.fetchGroups(), window.api.getLastChecked()]);
      renderGroups(list, new Set(saved || []), lastMap || {});
    }
  } catch{}
})();
