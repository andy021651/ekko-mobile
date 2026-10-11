// Ekko 手機版的附件：選照片、影片、錄音，先存在這支手機（IndexedDB，重新整理不會不見），送出時上傳到雲端
// uploads/<裝置 id>-<毫秒>/，電腦等檔案到齊後搬進任務。上傳用 Google Drive 的可續傳上傳，每段 8MB、顯示進度；
// 傳到一半失敗再送一次時，已經傳完的檔不重傳。
// 和 app.js 共用全域：el、L、state、store、toast、api、ensureFolder、deviceId、LOCAL。
'use strict';

const CHUNK_BYTES = 8 * 1024 * 1024;   // 256KB 的倍數（Drive 規定）

// ---- 存在這支手機的附件 ----
const memoryFiles = new Map();   // IndexedDB 不能用時（私密瀏覽）退回記憶體
function attachDB() {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open('ekko-attach', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('files', { keyPath: 'fid' });
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
    } catch (_) { resolve(null); }
  });
}
async function attachStore(mode, run) {
  const db = await attachDB();
  if (!db) return run(null);
  return new Promise((resolve) => {
    const tx = db.transaction('files', mode);
    const request = run(tx.objectStore('files'));
    tx.oncomplete = () => resolve(request && request.result);
    tx.onerror = () => resolve(null);
    // 空間不夠時多半只有 abort：也要結束，不然選了檔畫面沒反應。
    tx.onabort = () => resolve(null);
  });
}
async function keepFile(file) {
  const fid = crypto.randomUUID();
  const record = { fid, blob: file, name: file.name, size: file.size, type: file.type, at: Date.now() };
  const stored = await attachStore('readwrite', (s) => (s ? s.put(record) : null));
  if (stored == null) memoryFiles.set(fid, record);
  return { fid, name: file.name, size: file.size };
}
async function readFile(fid) {
  return memoryFiles.get(fid) || (await attachStore('readonly', (s) => (s ? s.get(fid) : null)));
}
async function dropFiles(fids) {
  fids.forEach((fid) => memoryFiles.delete(fid));
  await attachStore('readwrite', (s) => { if (s) fids.forEach((fid) => s.delete(fid)); return null; });
}

// ---- 選檔與小卡 ----
// 打開系統的選檔（相簿、拍照、檔案），每個檔先檢查再存；onChange 拿到新的清單。
function pickFiles(list, onChange) {
  const input = el('input');
  Object.assign(input, { type: 'file', multiple: true, accept: 'image/*,video/*,audio/*,.heic,.heif,.mov,.m4a' });
  input.onchange = async () => {
    let next = list.slice();
    for (const file of input.files) {
      const problem = L.attachProblem(next, file);
      if (problem) { toast(`${file.name}：${problem}`); continue; }
      next = [...next, await keepFile(file)];
    }
    onChange(next);
  };
  input.click();
}

// 附件小卡：檔名、大小、×（拿掉就從手機刪掉）。
function attachChips(list, onChange) {
  const box = el('div', 'attach-chips');
  for (const f of list) {
    const chip = el('span', 'attach-chip');
    const drop = el('button', 'attach-drop', '×');
    drop.setAttribute('aria-label', `拿掉 ${f.name}`);
    // 只從清單拿掉；手機裡的檔交給 sweepAttachments 清（卡片按「取消」時原本記下的還要用）。
    drop.onclick = () => onChange(list.filter((x) => x.fid !== f.fid));
    chip.append(el('span', 'attach-name', f.name), el('span', 'muted', L.sizeText(f.size)), drop);
    box.append(chip);
  }
  return box;
}

// 一個「附檔」按鈕＋小卡，list 改變時 onChange。
function attachField(list, onChange, label = '附檔') {
  const box = el('div', 'attach-field');
  const paint = (now) => {
    const add = el('button', 'quiet-button attach-add', now.length ? `📎 ${label}（${now.length}）` : `📎 ${label}`);
    add.onclick = () => pickFiles(now, (next) => { onChange(next); paint(next); });
    box.replaceChildren(add, ...(now.length ? [attachChips(now, (next) => { onChange(next); paint(next); })] : []));
  };
  paint(list);
  return box;
}

// 整支影片的附件（每一支一份，存在這支手機）。
const overallFiles = (jobId) => store.get(`overallFiles-${jobId}`) || [];
const saveOverallFiles = (jobId, list) => (list.length ? store.set(`overallFiles-${jobId}`, list) : store.drop(`overallFiles-${jobId}`));

// ---- 上傳 ----
// 要傳的檔照 plan 的順序傳到同一個上傳資料夾；同一份計畫重送時沿用資料夾、已傳完的檔跳過。回傳上傳資料夾名。
async function uploadAttachments(jobId, plan) {
  const total = plan.files.reduce((sum, f) => sum + f.size, 0);
  const connection = navigator.connection;
  if (connection && connection.type === 'cellular' && total > 50 * 1024 * 1024 && !confirm(`這次要傳 ${L.sizeText(total)}，確定用行動網路？`)) throw new Error('先不傳');
  const key = `upload-${jobId}`;
  const signature = plan.files.map((f) => `${f.fid}:${f.name}`).join('|');
  let pending = store.get(key);
  // 超過 12 小時的上傳紀錄不再沿用（電腦一天會清掉放棄的上傳資料夾）。
  if (!pending || pending.signature !== signature || !(Date.now() - (pending.at || 0) < 12 * 3600000)) {
    const name = `${deviceId()}-${Date.now()}`;
    const folderId = LOCAL ? name : (await api('files', { fields: 'id' }, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [await ensureFolder('uploads')] }) })).id;
    pending = { signature, name, folderId, done: [], at: Date.now() };
    store.set(key, pending);
  }
  let sent = plan.files.filter((f) => pending.done.includes(f.fid)).reduce((sum, f) => sum + f.size, 0);
  for (const [i, f] of plan.files.entries()) {
    if (pending.done.includes(f.fid)) continue;
    const record = await readFile(f.fid);
    if (!record) throw new Error(`${f.original} 已經不在這支手機上，請拿掉再附一次`);
    const show = (bytes) => toast(`上傳附件 ${i + 1}/${plan.files.length}・${Math.floor(((sent + bytes) / total) * 100)}%`);
    await uploadOne(pending.folderId, f.name, record.blob, show);
    sent += f.size;
    pending.done.push(f.fid);
    store.set(key, pending);
  }
  return pending.name;
}

// 清掉手機裡沒人用的附件：不在任何修改單、整支附件、還在等回覆的送出與上傳紀錄裡，而且放超過一天。
async function sweepAttachments() {
  const used = new Set();
  const addFiles = (list) => (list || []).forEach((f) => f && f.fid && used.add(f.fid));
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith('ekko-sheet-')) (store.get(key.slice(5)) || []).forEach((e) => addFiles(e.files));
      if (key.startsWith('ekko-overallFiles-')) addFiles(store.get(key.slice(5)));
      if (key.startsWith('ekko-upload-')) (store.get(key.slice(5)) || {}).signature?.split('|').forEach((part) => used.add(part.split(':')[0]));
    }
  } catch (_) { return; }
  [...(store.get('sends') || []), ...(store.get('commands') || [])].forEach((one) => (one.fids || []).forEach((fid) => used.add(fid)));
  const all = (await attachStore('readonly', (s) => (s ? s.getAll() : null))) || [];
  const stale = all.filter((r) => !used.has(r.fid) && Date.now() - (r.at || 0) > 86400000).map((r) => r.fid);
  if (stale.length) dropFiles(stale);
}

// Drive 可續傳上傳：先要一個上傳網址，再一段一段 PUT（308＝還要下一段，200／201＝完成）。
async function uploadOne(folderId, name, blob, progress) {
  if (LOCAL) {
    for (let at = 0; at <= blob.size; at += Math.max(1, Math.ceil(blob.size / 4))) { progress(Math.min(at, blob.size)); await new Promise((r) => setTimeout(r, 150)); }
    return;
  }
  const start = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': blob.type || 'application/octet-stream', 'X-Upload-Content-Length': String(blob.size) },
    body: JSON.stringify({ name, parents: [folderId] }),
  });
  const url = start.ok && start.headers.get('Location');
  if (!url) throw new Error(`附件上傳開不起來（${start.status}）`);
  let at = 0;
  while (at < blob.size) {
    const end = Math.min(at + CHUNK_BYTES, blob.size);
    const sent = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const broken = () => reject(new Error('附件沒傳完，網路斷了；再按一次送出會從沒傳完的接著傳'));
      xhr.open('PUT', url);
      xhr.timeout = 120000;
      xhr.setRequestHeader('Content-Range', `bytes ${at}-${end - 1}/${blob.size}`);
      xhr.upload.onprogress = (event) => progress(at + event.loaded);
      xhr.onload = () => resolve({ status: xhr.status, range: xhr.getResponseHeader('Range') });
      xhr.onerror = broken;
      xhr.ontimeout = broken;
      xhr.onabort = broken;
      xhr.send(blob.slice(at, end));
    });
    if (sent.status >= 200 && sent.status < 300) return;
    if (sent.status !== 308) throw new Error(`附件上傳失敗（${sent.status}），再按一次送出會從沒傳完的接著傳`);
    // 308：照伺服器說收到哪裡接著傳（讀不到 Range 就當這段都收到了）。
    const received = sent.range && sent.range.match(/bytes=0-(\d+)/);
    at = received ? Number(received[1]) + 1 : end;
  }
}
