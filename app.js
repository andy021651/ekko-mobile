// Ekko 手機版：用 Google 登入，讀共用給自己的「Ekko 手機」資料夾，看任務清單、播放成片、收剪好通知。
// 主要路徑：任務清單 → 點進去看片。設定（帳號、通知、登出）收在右上角。
// 連線：在電腦 Ekko「更多 → 在手機上用 Ekko…」掃 QR Code（網址帶 ?pair=資料夾編號），或貼上連結碼。
'use strict';
const L = window.EkkoLogic;
const CONFIG = window.EKKO_CONFIG;
const DRIVE = 'https://www.googleapis.com/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive';
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const store = {
  get(key) { try { return JSON.parse(localStorage.getItem('ekko-' + key)); } catch (_) { return null; } },
  set(key, value) { try { localStorage.setItem('ekko-' + key, JSON.stringify(value)); } catch (_) {} },
  drop(key) { try { localStorage.removeItem('ekko-' + key); } catch (_) {} },
};
// 本機檢查畫面用：localhost 加 ?local=1 時，從 ./local-data/（指到一個「Ekko 手機」資料夾）讀，不登入、不連 Google。
const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has('local');
if (LOCAL) {
  window.fetch = ((real) => async (url, init) => {
    const u = String(url);
    if (!u.includes('googleapis.com')) return real(url, init);
    const q = new URL(u).searchParams.get('q') || '';
    if (u.includes('/about')) return new Response(JSON.stringify({ user: { emailAddress: 'local@example.com' } }));
    if (q.includes("name='mac.json'")) return new Response(JSON.stringify({ files: [{ id: 'mac.json', parents: ['root'] }] }));
    const listed = q.match(/'([^']+)' in parents/);
    if (listed) {
      const dir = listed[1] === 'root' ? '' : listed[1] + '/';
      const names = await (await real(`local-data/${dir}?list`)).json().catch(() => []);
      return new Response(JSON.stringify({ files: names.map((n) => ({ id: dir + n, name: n })) }));
    }
    const media = u.match(/files\/([^?]+)\?.*alt=media/);
    if (media) return real(`local-data/${decodeURIComponent(media[1])}`, init);
    return new Response(JSON.stringify({ files: [] }));
  })(window.fetch);
  localStorage.setItem('ekko-token', JSON.stringify({ token: 'local', expiresAt: Date.now() + 3600000 }));
}

const state = { token: null, account: '', person: '', folder: null, folders: [], files: {}, index: null, mac: null, deviceFileId: null, device: null };

// ---- 登入（同一頁跳轉，不開彈出視窗） ----
function signIn(prompt) {
  const params = new URLSearchParams({ client_id: CONFIG.clientId, redirect_uri: location.origin + location.pathname,
    response_type: 'token', scope: SCOPE, include_granted_scopes: 'true' });
  if (prompt) params.set('prompt', prompt);
  // 這一頁發出的登入才收：跳回來時核對這個亂數。
  const nonce = crypto.randomUUID();
  store.set('authState', nonce);
  params.set('state', nonce);
  const hint = store.get('account');
  if (hint && !prompt) params.set('login_hint', hint);
  location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + params);
}

function signOut() {
  ['token', 'account', 'folder', 'lastAuto'].forEach(store.drop);
  location.replace(location.pathname);
}

async function api(path, params = {}, init = {}) {
  const query = new URLSearchParams({ supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', ...params });
  const url = path.startsWith('http') ? path : `${DRIVE}/${path}?${query}`;
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${state.token}`, ...(init.headers || {}) } });
  if (L.needsSignIn(r.status)) { signIn(); throw new Error('登入過期，重新登入中'); }
  if (r.status === 403) throw new Error(L.forbiddenText(403));
  if (!r.ok) throw new Error(`雲端硬碟回應 ${r.status}`);
  return params.alt === 'media' ? r : r.json();
}

async function listFolder(folderId) {
  return (await api('files', { q: `'${folderId}' in parents and trashed=false`, fields: 'files(id,name,mimeType)', pageSize: '1000' })).files;
}

async function readJSON(fileId) { return (await api(`files/${fileId}`, { alt: 'media' })).json(); }

// ---- 找資料夾：共用給這個帳號、裡面有 mac.json 的資料夾就是一台電腦 ----
async function findComputers() {
  const marks = await api('files', { q: "name='mac.json' and trashed=false", fields: 'files(id,parents)', pageSize: '20' });
  const computers = [];
  for (const mark of marks.files) {
    const folderId = mark.parents && mark.parents[0];
    if (!folderId) continue;
    const mac = await readJSON(mark.id).catch(() => null);
    computers.push({ folderId, name: (mac && mac.name) || '電腦', lastSeen: mac && mac.lastSeen });
  }
  return computers;
}

async function loadFolder() {
  const files = await listFolder(state.folder);
  const named = Object.fromEntries(files.map((f) => [f.name, f]));
  state.mac = named['mac.json'] ? await readJSON(named['mac.json'].id).catch(() => null) : null;
  state.index = named['index.json'] ? await readJSON(named['index.json'].id).catch(() => null) : { jobs: [] };
  state.files = { jobs: named.jobs && named.jobs.id, devices: named.devices && named.devices.id, inbox: named.inbox && named.inbox.id, outbox: named.outbox && named.outbox.id };
  // 每次重新整理只列一次 jobs/，各任務的檔案用到才列、這一輪內重複用。
  state.jobFolders = state.files.jobs ? Object.fromEntries((await listFolder(state.files.jobs)).map((f) => [f.name, f.id])) : {};
  state.jobFiles = {};
}

async function jobFiles(jobId) {
  const folderId = (state.jobFolders || {})[jobId];
  if (!folderId) return {};
  if (!state.jobFiles[jobId]) state.jobFiles[jobId] = listFolder(folderId).then((files) => Object.fromEntries(files.map((f) => [f.name, f.id])));
  return state.jobFiles[jobId];
}

// ---- 裝置檔（只寫自己的 devices/<裝置 id>.json） ----
function deviceId() {
  let id = store.get('device');
  if (!id) { id = crypto.randomUUID().replace(/-/g, ''); store.set('device', id); }
  return id;
}

// 「Ekko 手機」底下的子資料夾（devices、inbox）：沒有就建。
async function ensureFolder(name) {
  if (state.files[name]) return state.files[name];
  const created = await api('files', { fields: 'id' }, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [state.folder] }) });
  state.files[name] = created.id;
  return created.id;
}

async function createJSON(folderId, name, value) {
  const boundary = 'ekko' + Date.now();
  const meta = JSON.stringify({ name, parents: [folderId], mimeType: 'application/json' });
  const multipart = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(value)}\r\n--${boundary}--`;
  return api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id', {},
    { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
}

// ---- 送修改：寫一份到 inbox/，電腦每 10 秒收一次，回覆寫在 outbox/ 同檔名 ----
const sends = () => (store.get('sends') || []).filter((one) => Date.now() - one.at < 86400000);
async function sendRevision(jobId, from, text, sheet) {
  const file = L.inboxName(deviceId(), Date.now());
  const items = L.sheetItems(sheet);
  await createJSON(await ensureFolder('inbox'), file, { job: jobId, from, text, items, device: deviceId() });
  // 記下送出的修改單：電腦說沒送成時放回去。
  store.set('sends', [...sends(), { file, job: jobId, from, sheet: sheet || [], at: Date.now(), reply: null }]);
  // 送出的人剪好要收到通知：還沒按「通知我」就順手打開（沒允許通知就算了）。
  if (!following(jobId)) await toggleFollow(jobId).catch(() => {});
}

// 讀電腦的回覆，讀完就刪掉自己的那份。
async function readReplies() {
  const waiting = sends().filter((one) => !one.reply);
  if (!waiting.length || !state.files.outbox) return;
  const files = await listFolder(state.files.outbox).catch(() => []);
  const all = sends();
  for (const one of all) {
    const found = !one.reply && files.find((f) => f.name === one.file);
    if (!found) continue;
    one.reply = await readJSON(found.id).catch(() => null);
    if (one.reply && one.reply.status === 'rejected' && one.sheet && one.sheet.length && one.from != null && !one.restored) {
      saveSheet(one.job, one.from, L.restoreSheet(readSheet(one.job, one.from), one.sheet));
      one.restored = true;
    }
    if (one.reply) api(`files/${found.id}`, {}, { method: 'DELETE' }).catch(() => {});
  }
  store.set('sends', all);
}
const latestSend = (jobId) => sends().filter((one) => one.job === jobId).pop() || null;
// 修改單：每一支、每一版各一份，存在這支手機上。
const sheetKey = (jobId, version) => `sheet-${jobId}-v${version}`;
const readSheet = (jobId, version) => store.get(sheetKey(jobId, version)) || [];
const saveSheet = (jobId, version, sheet) => (sheet.length ? store.set(sheetKey(jobId, version), sheet) : store.drop(sheetKey(jobId, version)));

async function ensureDevicesFolder() { return ensureFolder('devices'); }

async function loadDevice() {
  const folder = await ensureDevicesFolder();
  const name = `${deviceId()}.json`;
  const found = await api('files', { q: `'${folder}' in parents and name='${name}' and trashed=false`, fields: 'files(id)' });
  state.deviceFileId = found.files[0] ? found.files[0].id : null;
  state.device = state.deviceFileId ? await readJSON(state.deviceFileId).catch(() => null) : null;
}

async function saveDevice(changes) {
  const name = (state.device && state.device.name) || L.defaultDeviceName(state.person, navigator.userAgent);
  const record = L.deviceRecord(state.device, { name, account: state.account, ...changes }, Date.now());
  const body = JSON.stringify(record);
  if (state.deviceFileId) {
    await api(`https://www.googleapis.com/upload/drive/v3/files/${state.deviceFileId}?uploadType=media&supportsAllDrives=true`, {},
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
  } else {
    const boundary = 'ekko' + Date.now();
    const meta = JSON.stringify({ name: `${deviceId()}.json`, parents: [await ensureDevicesFolder()], mimeType: 'application/json' });
    const multipart = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    const created = await api(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id`, {},
      { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
    state.deviceFileId = created.id;
  }
  state.device = record;
}

// ---- 推播 ----
async function enablePush() {
  if (!('PushManager' in window)) throw new Error('要先「加入主畫面」，再從主畫面打開 Ekko 才能開通知');
  if (await Notification.requestPermission() !== 'granted') throw new Error('沒有允許通知，可以到 iPhone 設定 → 通知 → Ekko 打開');
  const registration = await navigator.serviceWorker.ready;
  const publicKey = L.pushKey(state.mac, CONFIG);
  if (!publicKey) throw new Error('這台電腦的 Ekko 版本太舊，還不能發通知，請先更新電腦上的 Ekko');
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await saveDevice({ subscription: subscription.toJSON() });
}

// 「剪好通知我」：第一次按時順便要通知權限。
async function toggleFollow(jobId) {
  if (!state.device || !state.device.subscription) await enablePush();
  const follow = new Set((state.device && state.device.follow) || []);
  follow.has(jobId) ? follow.delete(jobId) : follow.add(jobId);
  await saveDevice({ follow: [...follow] });
}
const following = (jobId) => !!(state.device && (state.device.follow || []).includes(jobId));

async function shareToken() {
  const registration = await navigator.serviceWorker.ready;
  registration.active && registration.active.postMessage({ type: 'token', token: state.token });
}

// ---- 畫面零件 ----
const ICONS = {
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8"/></svg>',
  add: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/></svg>',
};

function header(title, { back, settings, bare } = {}) {
  $('title').textContent = title || '';
  // SVG 沒有 hidden 屬性可以直接設，要用 attribute。
  $('brand').toggleAttribute('hidden', !!title || !!bare);
  $('back').hidden = !back;
  $('back').onclick = back || null;
  $('openSettings').hidden = !settings;
  $('openSettings').onclick = settings ? showSettings : null;
}

let toastTimer = null;
function toast(text) {
  const box = $('toast');
  box.textContent = text;
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 3200);
}

function logoLarge() {
  const svg = $('brand').cloneNode(true);
  svg.removeAttribute('id');
  svg.removeAttribute('hidden');
  svg.classList.add('logo-large');
  return svg;
}

// 置中的單一畫面：一個主要按鈕，其他都是次要。
function hero({ title, text, action, quiet, note, extra = [] }) {
  // 進場畫面中間已經有大 LOGO，頂列不再放小的。
  header('', { bare: true });
  const box = el('section', 'hero');
  box.append(logoLarge());
  if (title) box.append(el('h2', null, title));
  if (text) box.append(el('p', null, text));
  box.append(...extra);
  if (action) { const b = el('button', 'primary-button', action.label); b.onclick = action.run; box.append(b); }
  if (quiet) { const b = el('button', 'quiet-button', quiet.label); b.onclick = quiet.run; box.append(b); }
  if (note) box.append(el('p', 'note', note));
  $('view').replaceChildren(box);
}

function loading(text) { hero({ text }); }

function offlineNotice() {
  if (!L.isOffline(state.mac, Date.now())) return null;
  const box = el('div', 'notice');
  box.append(el('span', 'dot'), el('span', null, L.offlineText(state.mac, Date.now()) + '，剪輯會等電腦開機後繼續'));
  return box;
}

// ---- 進場：加入主畫面、登入、連結電腦、沒有權限 ----
function showHomeScreenHint() {
  const steps = el('div', 'steps');
  const one = el('div', 'step'); one.innerHTML = '<b>1</b><span>點下方的分享按鈕</span>' + ICONS.share;
  const two = el('div', 'step'); two.innerHTML = '<b>2</b><span>選「加入主畫面」，再從主畫面打開 Ekko</span>' + ICONS.add;
  steps.append(one, two);
  hero({ title: '先加到主畫面', text: '從主畫面打開才收得到「剪好了」的通知，也只要登入一次。', extra: [steps],
         quiet: { label: '先在瀏覽器看看', run: () => { store.set('skipHomeScreen', true); start(); } } });
}

function showSignIn(returnedError) {
  const pair = store.get('pair');
  hero({
    title: returnedError ? '登入沒有完成' : pair && pair.mac ? `連到「${pair.mac}」` : '在手機看剪輯',
    text: returnedError ? '再試一次就好。' : '用 Google 帳號登入，看剪輯進度、收剪好通知、在手機上看成片。',
    action: { label: '用 Google 登入', run: () => signIn(store.get('account') ? '' : 'select_account') },
    note: '登入時會看到「Google 尚未驗證這個應用程式」，按「繼續」就好。如果顯示「存取遭封鎖」，請把你的 Gmail 交給 Ekko 管理員加進登入名單',
  });
}

function showPairing(problem) {
  const input = el('input', 'code-input');
  input.placeholder = '貼上連結碼';
  input.autocomplete = 'off';
  input.spellcheck = false;
  hero({ title: '連結電腦', text: problem || '在電腦 Ekko 打開「更多 → 在手機上用 Ekko…」，用相機掃 QR Code；或複製連結碼貼在這裡。', extra: [input],
    action: { label: '連結', run: () => {
      const pair = L.parsePairCode(input.value);
      if (!pair) return toast('看不懂這個連結碼，請從電腦上複製完整的連結');
      store.set('pair', pair);
      store.drop('folder');
      start();
    } },
    quiet: { label: '換個 Google 帳號', run: () => signIn('select_account') } });
}

function showNoAccess() {
  const account = el('div', 'account');
  const copy = el('button', 'quiet-button', '複製');
  copy.onclick = () => navigator.clipboard.writeText(state.account).then(() => toast('已複製，傳給 Ekko 電腦的主人')).catch(() => toast(state.account));
  account.append(el('span', null, state.account), copy);
  hero({ title: '還沒拿到權限', text: '請 Ekko 電腦的主人在雲端硬碟把「Ekko 手機」資料夾共用給這個帳號（編輯者）。', extra: [account],
    action: { label: '重試', run: start }, quiet: { label: '換個 Google 帳號', run: () => signIn('select_account') } });
}

// ---- 任務清單 ----
async function showList() {
  state.viewing = null;
  header('', { settings: true });
  const view = [];
  const notice = offlineNotice();
  if (notice) view.push(notice);
  const jobs = (state.index && state.index.jobs) || [];
  if (!jobs.length) view.push(el('p', 'empty', '還沒有任務。在電腦上的 Ekko 開始剪輯後，會出現在這裡。'));
  const list = el('div', 'jobs');
  for (const job of jobs) {
    const row = el('div', 'job' + (job.status === 'running' ? ' live' : ''));
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    const thumb = el('div', 'thumb');
    const text = el('div', 'job-text');
    const status = el('div', `job-status ${job.status}`);
    const when = L.ago(job.updatedAt, Date.now());
    status.append(el('span', 'dot'), el('span', null, when ? `${L.statusLabel(job)}・${when}` : L.statusLabel(job)));
    text.append(el('div', 'job-title', job.title), status);
    row.append(thumb, text);
    // 剪輯中、排隊中：清單上直接按「通知我」，不用點進去。
    if (job.status === 'running' || job.status === 'queued') {
      const on = following(job.id);
      const pill = el('button', 'pill' + (on ? ' on' : ''), on ? '會通知' : '通知我');
      pill.setAttribute('aria-pressed', String(on));
      pill.onclick = (event) => {
        event.stopPropagation();
        toggleFollow(job.id).then(showList).catch((e) => toast(e.message));
      };
      row.append(pill);
    }
    row.onclick = () => showJob(job.id);
    row.onkeydown = (event) => { if (event.key === 'Enter') showJob(job.id); };
    list.append(row);
    if (job.poster && (state.jobFolders || {})[job.id]) posterURL(job.id).then((url) => { if (url) { const img = el('img'); img.alt = ''; img.src = url; thumb.replaceChildren(img); } });
  }
  view.push(list);
  $('view').replaceChildren(...view);
}

// 縮圖照檔案 id 快取：同一張不重複下載；換了新的（新版本）才下載，舊的網址釋放掉。
const posters = new Map();
async function posterURL(jobId) {
  const files = await jobFiles(jobId).catch(() => ({}));
  const fileId = files['poster.jpg'];
  if (!fileId) return null;
  let cached = posters.get(jobId);
  if (!cached || cached.fileId !== fileId) {
    const blob = await api(`files/${fileId}`, { alt: 'media' }).then((r) => r.blob()).catch(() => null);
    if (!blob) return null;
    if (cached) URL.revokeObjectURL(cached.url);
    cached = { fileId, url: URL.createObjectURL(blob) };
    posters.set(jobId, cached);
  }
  return cached.url;
}

// ---- 看片 ----
// 「這裡要改」的卡片：當下那一句、現在有沒有畫面、三種改法。卡片開著時不重畫看片頁（refreshList 看 .line-card）。
function openLineCard(jobId, version, lines, at, player) {
  document.querySelector('.line-card')?.remove();
  const card = el('div', 'line-card');
  // 取消：收起卡片；換句時可能已經記下幾筆，重畫讓修改單跟上（不自動播放）。
  const close = () => { card.remove(); showJob(jobId, version); };
  const render = (i) => {
    const line = lines[i];
    const saved = readSheet(jobId, version).find((e) => e.text === line.text && Math.abs(e.at - line.at) < 0.05) || {};
    let cut = !!saved.cut, broll = saved.broll || null;
    player.currentTime = line.at;
    const nav = el('div', 'card-nav');
    const prev = el('button', 'quiet-button', '‹ 上一句');
    const next = el('button', 'quiet-button', '下一句 ›');
    prev.disabled = i === 0;
    next.disabled = i === lines.length - 1;
    // 換上一句／下一句前先把這一句記下來，打到一半的說明不會不見。
    const move = (to) => { if (remember()) render(to); };
    prev.onclick = () => move(i - 1);
    next.onclick = () => move(i + 1);
    nav.append(prev, el('span', 'muted small', L.clock(line.at)), next);
    const quote = el('p', 'card-quote', `「${line.text}」`);
    const now = el('p', 'muted small', `現在：${L.brollNow(line)}`);
    const cutButton = el('button', 'pill', '移除這句');
    const choices = [['footage', '畫面'], ['animation', '動畫'], ...(line.broll ? [['remove', '不要畫面']] : [])];
    const brollRow = el('div', 'card-choices');
    brollRow.append(el('span', 'muted small', '換畫面'));
    const chips = choices.map(([key, label]) => {
      const chip = el('button', 'pill', line.broll === key ? `重做${label}` : label);
      chip.onclick = () => { broll = broll === key ? null : key; cut = false; paint(); };
      brollRow.append(chip);
      return [key, chip];
    });
    const note = el('textarea', 'revise-input card-note');
    note.rows = 2;
    note.maxLength = 500;
    note.placeholder = '寫說明（可以用語音輸入）';
    note.value = saved.note || '';
    const paint = () => {
      // 移除這句時不用寫說明：停用說明欄，免得寫了以為有送。
      note.disabled = cut;
      note.placeholder = cut ? '移除這句時不用寫說明' : '寫說明（可以用語音輸入）';
      cutButton.classList.toggle('on', cut);
      cutButton.setAttribute('aria-pressed', String(cut));
      chips.forEach(([key, chip]) => { chip.classList.toggle('on', broll === key); chip.setAttribute('aria-pressed', String(broll === key)); });
    };
    cutButton.onclick = () => { cut = !cut; if (cut) broll = null; paint(); };
    const actions = el('div', 'revise-actions');
    const cancel = el('button', 'quiet-button', '取消');
    const keep = el('button', 'primary-button small', '記下來');
    cancel.onclick = close;
    // 記進修改單；超過 30 項不記，回傳 false。
    const remember = () => {
      const entry = { text: line.text, at: line.at, cut, broll, current: line.broll || null, note: note.value.trim(), replace: true };
      const sheet = readSheet(jobId, version);
      if ((cut || broll || entry.note) && !L.canAddToSheet(sheet, entry)) { toast('修改單一次最多 30 項，先送出這些再記'); return false; }
      saveSheet(jobId, version, L.putSheet(sheet, entry));
      return true;
    };
    keep.onclick = () => {
      if (!remember()) return;
      card.remove();
      showJob(jobId, version, { resumeAt: line.at });
    };
    actions.append(cancel, keep);
    paint();
    card.replaceChildren(nav, quote, now, cutButton, brollRow, note, actions);
  };
  render(Math.max(0, at));
  document.body.append(card);
}

async function showJob(jobId, chosen, opts = {}) {
  state.viewing = { id: jobId, chosen };
  const job = ((state.index && state.index.jobs) || []).find((j) => j.id === jobId);
  if (!job) return showList();
  history.replaceState(null, '', `${location.pathname}${location.search}#job=${jobId}`);
  header(job.title, { back: () => { history.replaceState(null, '', location.pathname + location.search); showList(); } });
  const view = [];
  const notice = offlineNotice();
  if (notice) view.push(notice);
  await readReplies().catch(() => {});
  const files = await jobFiles(jobId).catch(() => ({}));
  const lines = L.versionLines(job);
  const playable = lines.filter((v) => v.ready && files[`v${v.id}.mp4`]);
  // 預設看最新一版（有手機用小檔的）；送修改就改正在看的這一版。
  const current = lines.find((v) => v.id === chosen) || playable[0] || lines[0] || null;
  const linesFile = current && current.lines && files[`lines-v${current.id}.json`];
  const sentences = linesFile ? ((await readJSON(linesFile).catch(() => null)) || {}).lines || [] : [];

  if (current && files[`v${current.id}.mp4`]) {
    const player = el('video', 'player');
    player.controls = true;
    player.playsInline = true;
    player.preload = 'metadata';
    // 記下一筆後重畫：從停住的地方接著播。
    if (opts.resumeAt != null) player.addEventListener('loadedmetadata', () => { player.currentTime = opts.resumeAt; player.play().catch(() => {}); }, { once: true });
    posterURL(jobId).then((url) => { if (url) player.poster = url; });
    shareToken().then(() => { player.src = `drive-media/${files[`v${current.id}.mp4`]}`; });
    view.push(player);
    if (sentences.length) {
      const mark = el('button', 'primary-button mark-button', '這裡要改');
      mark.onclick = () => { player.pause(); openLineCard(jobId, current.id, sentences, L.lineAt(sentences, player.currentTime), player); };
      view.push(mark);
    }
  } else if (job.status === 'done') {
    view.push(el('p', 'muted pad', '手機用的檔案還在準備，稍後再看。'));
  }
  const meta = el('div', 'meta');
  const status = el('div', `job-status ${job.status}`);
  status.append(el('span', 'dot'), el('span', null, L.statusLabel(job)));
  meta.append(status);
  view.push(meta);

  // 版本清單：點一行換那一版。
  if (lines.length) {
    const list = el('div', 'group versions-list');
    for (const v of lines) {
      const row = el('button', 'version' + (current && v.id === current.id ? ' on' : ''));
      row.append(el('b', null, `v${v.id}`), el('span', 'version-text', v.text || '—'));
      if (!(v.ready && files[`v${v.id}.mp4`])) row.append(el('span', 'version-wait', '準備中'));
      row.onclick = () => {
        if (!(v.ready && files[`v${v.id}.mp4`])) return toast('這一版手機用的檔案還在準備');
        if (current && v.id !== current.id && readSheet(jobId, current.id).length) toast(`v${current.id} 的修改單先收起來，切回 v${current.id} 還在`);
        showJob(jobId, v.id);
      };
      list.append(row);
    }
    for (const text of L.pendingLines(job.pending)) {
      const row = el('div', 'version pending');
      row.append(el('span', 'dot'), el('span', 'version-text', text));
      list.append(row);
    }
    view.push(list);
  }

  // 修改框：寫好送回電腦，電腦照著改出新的一版。
  const box = el('div', 'revise');
  const input = el('textarea', 'revise-input');
  input.rows = 3;
  input.maxLength = 2000;
  const version = current ? current.id : null;
  const sheet = version != null ? readSheet(jobId, version) : [];
  input.placeholder = sheet.length ? '整支影片的意見（可以不寫）' : '想改哪裡？例如：第二句字幕放大、結尾音樂小聲一點';
  const draftKey = `draft-${jobId}`;
  input.value = store.get(draftKey) || '';
  input.oninput = () => store.set(draftKey, input.value);
  const actions = el('div', 'revise-actions');
  actions.append(el('span', 'muted small', current ? `改 v${current.id}` : ''));
  const send = el('button', 'primary-button small', '送出修改');
  send.onclick = async () => {
    const text = input.value.trim();
    const sending = version != null ? readSheet(jobId, version) : [];
    if (!text && !sending.length) return toast('請寫要改哪裡');
    if (L.tooBigToSend({ text, items: L.sheetItems(sending) })) return toast('修改單太長了，請刪掉幾項或縮短說明，分兩次送');
    send.disabled = true;
    try {
      await sendRevision(jobId, version, text, sending);
      store.drop(draftKey);
      if (version != null) saveSheet(jobId, version, []);
      toast('已送到雲端');
      showJob(jobId, version);
    } catch (e) {
      send.disabled = false;
      toast(e.message);
    }
  };
  actions.append(send);
  // 修改單：邊看邊記的每一筆，點一筆回到那一句改，× 刪掉。
  if (sheet.length) {
    const list = el('div', 'sheet-list');
    list.id = 'sheet';
    list.append(el('p', 'muted small', `修改單・${sheet.length} 項`));
    sheet.forEach((entry) => {
      const row = el('div', 'sheet-row');
      const jump = el('button', 'sheet-text', L.sheetLine(entry));
      jump.onclick = () => {
        const player = document.querySelector('video');
        const at = sentences.findIndex((l) => l.text === entry.text && Math.abs(l.at - entry.at) < 0.05);
        if (player && at >= 0) { player.pause(); openLineCard(jobId, version, sentences, at, player); }
      };
      const drop = el('button', 'icon-button', '×');
      drop.setAttribute('aria-label', '刪掉這一筆');
      drop.onclick = () => { saveSheet(jobId, version, L.dropSheet(readSheet(jobId, version), entry)); showJob(jobId, version); };
      row.append(jump, drop);
      list.append(row);
    });
    box.append(list);
  }
  box.append(input, actions);
  const last = latestSend(jobId);
  if (last) {
    const line = el('p', 'revise-status');
    line.id = 'reviseStatus';
    box.append(line);
    paintSendStatus(line, last, job);
  }
  if (L.isOffline(state.mac, Date.now())) box.append(el('p', 'muted small', '電腦離線中，開機後才會開始改'));
  view.push(box);
  if (sheet.length) {
    const bar = el('button', 'sheet-bar');
    bar.append(el('span', null, `修改單・${sheet.length} 項`), el('span', null, '送出 ›'));
    bar.onclick = () => $('sheet').scrollIntoView({ behavior: 'smooth', block: 'center' });
    view.push(bar);
  }

  if (job.status === 'queued' || job.status === 'running') {
    const on = following(jobId);
    const row = el('div', 'follow');
    const pill = el('button', 'pill' + (on ? ' on' : ''), on ? '會通知' : '通知我');
    pill.setAttribute('aria-pressed', String(on));
    pill.onclick = () => toggleFollow(jobId).then(() => showJob(jobId, current && current.id)).catch((e) => toast(e.message));
    row.append(el('span', null, '剪好時通知'), pill);
    view.push(row);
  }
  $('view').replaceChildren(...view);
}

// 送出後的狀態一行：電腦收到的時間、前面還有幾筆、開始剪了沒。
function paintSendStatus(line, send, job) {
  line.textContent = L.sendStatus(send.reply, job, state.index && state.index.updated);
  line.classList.toggle('alert', !!(send.reply && send.reply.status === 'rejected'));
}

// 剛送出修改、看片頁開著：還沒收到回覆每 5 秒看一次回覆，收到了但還沒開始剪每 15 秒看一次任務清單，
// 只改狀態那一行（不重畫、不打斷播放與打字）。送出 10 分鐘後回到平常 30 秒一次。
let watchTick = 0;
async function watchSend() {
  const line = $('reviseStatus');
  const send = state.viewing && latestSend(state.viewing.id);
  if (!line || !send || Date.now() - send.at > 600000) return;
  const find = () => ((state.index && state.index.jobs) || []).find((j) => j.id === state.viewing.id);
  if (!L.waitingForComputer(send.reply, find(), state.index && state.index.updated)) return;
  watchTick++;
  if (!send.reply) await readReplies().catch(() => {});
  else if (watchTick % 3 === 0) await loadFolder().catch(() => {});
  const now = state.viewing && latestSend(state.viewing.id);
  if (!now || now.file !== send.file || $('reviseStatus') !== line) return;
  // 沒送成、修改單放回來了：整頁重畫讓修改單出現（卡片開著或正在打字時等下一輪）。
  const busy = document.querySelector('.line-card') || (document.activeElement && document.activeElement.classList.contains('revise-input'));
  if (now.restored && !send.reply && !busy) return showJob(state.viewing.id, state.viewing.chosen);
  paintSendStatus(line, now, find());
}
setInterval(() => { if (!document.hidden) watchSend(); }, 5000);

// ---- 自動換新版 ----
// 網站更新後手機常會沿用舊檔好幾分鐘（iPhone 主畫面的網頁 App 更久）。打開、切回前景時看一次 version.json（不走快取），
// 版本不同就把網頁重新抓一次再重新載入。程式檔的網址帶版本號（index.html 的 ?v=），換版後一定抓到新的。
const RUNNING = new URLSearchParams((document.querySelector('script[src^="app.js"]')?.getAttribute('src') || '').split('?')[1] || '').get('v') || '';
let lastVersionCheck = 0;
async function checkForUpdate() {
  if (LOCAL || Date.now() - lastVersionCheck < 60000) return;
  lastVersionCheck = Date.now();
  const latest = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' }).then((r) => r.json()).then((j) => j.v).catch(() => '');
  let tried = null;
  try { tried = sessionStorage.getItem('ekko-reloaded-for'); } catch (_) {}
  if (!L.shouldReload(RUNNING, latest, tried)) return;
  // 正在記修改或打字時不打斷，下次切回來再換。
  if (document.querySelector('.line-card') || (document.activeElement && document.activeElement.classList.contains('revise-input'))) { lastVersionCheck = 0; return; }
  try { sessionStorage.setItem('ekko-reloaded-for', latest); } catch (_) {}
  await Promise.all([location.pathname, 'index.html'].map((u) => fetch(u, { cache: 'reload' }).catch(() => {})));
  location.reload();
}

// ---- 設定 ----
function showSettings() {
  header('設定', { back: showList });
  const row = (label, value, run, cls = '') => {
    const item = el(run ? 'button' : 'div', 'row ' + cls);
    item.append(el('span', null, label));
    if (value) item.append(el('span', 'value', value));
    if (run) item.onclick = run;
    return item;
  };
  const computer = state.folders.find((f) => f.folderId === state.folder);
  const pair = store.get('pair');
  const mine = el('div', 'group');
  mine.append(
    row('帳號', state.account || '—'),
    row('電腦', (state.mac && state.mac.name) || (computer && computer.name) || (pair && pair.mac) || '—'),
    row('手機名稱', (state.device && state.device.name) || L.defaultDeviceName(state.person, navigator.userAgent), async () => {
      const next = prompt('這支手機的名稱（電腦上會看到）', (state.device && state.device.name) || '');
      if (next) { await saveDevice({ name: next.slice(0, 40) }).catch((e) => toast(e.message)); showSettings(); }
    }),
    row('剪好通知', state.device && state.device.subscription ? '已開啟' : '開啟', () => enablePush().then(() => { toast('通知已開啟'); showSettings(); }).catch((e) => toast(e.message))));
  const more = el('div', 'group');
  more.append(row('連結其他電腦', '', () => showPairing()));
  if (state.folders.length > 1) more.append(row('換一台電腦', '', () => { store.drop('folder'); store.drop('pair'); start(); }));
  // 網頁版本：換新版後這裡的號碼會變，用來確認手機拿到的是不是最新的。
  more.append(row('網頁版本', RUNNING || '—'));
  more.append(row('登出', '', signOut, 'danger'));
  $('view').replaceChildren(mine, more);
}

// ---- 開始 ----
// 順序：登入跳回來 → 記下掃碼帶來的電腦 → iPhone 瀏覽器先教加入主畫面 → 登入（過期就自動重登）→ 讀資料夾。
async function start() {
  const returned = L.readReturnedToken(location.hash, Date.now(), store.get('authState'));
  const jobAfterLogin = store.get('openJob');
  if (returned) {
    history.replaceState(null, '', location.pathname + location.search);
    if (returned.error) return showSignIn(true);
    store.set('token', returned);
  }
  const scanned = L.readPair(location.search);
  if (scanned) { store.set('pair', scanned); store.drop('folder'); }
  if (!LOCAL && L.needsHomeScreen(navigator.userAgent, navigator.standalone) && !store.get('skipHomeScreen') && !store.get('token')) return showHomeScreenHint();
  const saved = store.get('token');
  if (!saved || saved.expiresAt < Date.now() + 60000) {
    const job = L.jobFromHash(location.hash);
    if (job) store.set('openJob', job);
    // 登入過期：記得帳號就自動跳去重登（通常一閃就回來），不用每小時按一次。
    if (L.shouldAutoSignIn({ account: store.get('account'), lastAuto: store.get('lastAuto') }, Date.now())) {
      store.set('lastAuto', Date.now());
      loading('重新連線中…');
      return signIn();
    }
    return showSignIn(false);
  }
  state.token = saved.token;
  loading('讀取中…');
  try {
    const about = await api('about', { fields: 'user(emailAddress,displayName)' });
    state.account = about.user.emailAddress;
    state.person = about.user.displayName || '';
    store.set('account', state.account);
    const pair = store.get('pair');
    if (pair) {
      state.folder = pair.folder;
      state.folders = [{ folderId: pair.folder, name: pair.mac }];
    } else {
      state.folders = await findComputers();
      const remembered = store.get('folder');
      state.folder = state.folders.some((f) => f.folderId === remembered) ? remembered : state.folders.length === 1 ? state.folders[0].folderId : null;
      if (!state.folders.length) return showPairing();
      if (!state.folder) return chooseComputer();
    }
    store.set('folder', state.folder);
    try {
      await loadFolder();
    } catch (e) {
      // 掃碼連到的資料夾讀不到：多半是還沒共用給這個帳號。
      if (pair && /404|權限/.test(e.message)) return showNoAccess();
      throw e;
    }
    await loadDevice().catch(() => {});
    const job = L.jobFromHash(location.hash) || jobAfterLogin;
    store.drop('openJob');
    job ? showJob(job) : showList();
  } catch (e) {
    hero({ title: '讀不到資料', text: e.message, action: { label: '重試', run: start } });
  }
}

function chooseComputer() {
  header('選擇電腦', {});
  const group = el('div', 'group');
  for (const f of L.computerRows(state.folders, Date.now())) {
    const b = el('button', 'row');
    b.append(el('span', null, f.name));
    if (f.seen) b.append(el('span', 'value', f.seen));
    b.onclick = () => { store.set('folder', f.folderId); start(); };
    group.append(b);
  }
  $('view').replaceChildren(group);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
  // service worker 重啟後來要通行證；Drive 說通行證過期時請我們重新登入。
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'need-token' && event.ports[0]) event.ports[0].postMessage(state.token);
    if (event.data && event.data.type === 'signin') signIn();
  });
}
// 清單畫面：開著時每 30 秒更新一次；回到 App（從背景切回來）時、在最上面往下拉時也更新。
const onList = () => state.folder && !$('title').textContent && !$('openSettings').hidden;
const refreshList = () => {
  if (onList()) return loadFolder().then(showList).catch(() => {});
  // 看片頁：更新進度與電腦的回覆；正在打字時不重畫，免得打斷。
  const typing = document.activeElement && document.activeElement.classList.contains('revise-input');
  const video = document.querySelector('video');
  const playing = video && !video.paused;
  const marking = !!document.querySelector('.line-card');
  if (state.viewing && !typing && !playing && !marking) {
    const { id, chosen } = state.viewing;
    loadFolder().then(() => showJob(id, chosen)).catch(() => {});
  }
};
setInterval(() => { if (!document.hidden) refreshList(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkForUpdate(); refreshList(); } });
let pullFrom = null;
window.addEventListener('touchstart', (event) => { pullFrom = window.scrollY <= 0 ? event.touches[0].clientY : null; }, { passive: true });
window.addEventListener('touchend', (event) => {
  if (pullFrom !== null && event.changedTouches[0].clientY - pullFrom > 80) refreshList();
  pullFrom = null;
}, { passive: true });
checkForUpdate();
start();
