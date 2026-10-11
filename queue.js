// Ekko 手機版看片頁的「管排隊與剪輯」：取消／拿回自己送的排隊修改、中止、繼續、重試、補充一句話、重送退回的修改、引擎回報。
// 指令和修改單一樣寫進 inbox/（多一個 action），電腦做完回覆在 outbox/ 同檔名。指令紀錄存在 commands（和修改單的 sends 分開）。
// 和 app.js 共用全域：el、$、L、state、store、toast、api、listFolder、readJSON、createJSON、ensureFolder、deviceId、
// registerDevice、loadFolder、showJob、readSheet、saveSheet。
'use strict';

const commands = () => (store.get('commands') || []).filter((one) => Date.now() - one.at < 86400000);

async function sendCommand(jobId, action, extra, local) {
  await registerDevice();
  const file = L.inboxName(deviceId(), Date.now());
  await createJSON(await ensureFolder('inbox'), file, L.commandBody(action, jobId, extra));
  store.set('commands', [...commands(), { file, job: jobId, action, at: Date.now(), reply: null, ...(local || {}) }]);
  toast(L.commandStatus(null));
}

// 送出修改後電腦回了編號：記下那份修改單，「拿回來重改」時放回去（7 天）。
function keepSentSheet(send) {
  if (!send.reply || send.reply.id == null || send.from == null) return;
  const kept = Object.fromEntries(Object.entries(store.get('sentSheets') || {}).filter(([, v]) => Date.now() - v.at < 7 * 86400000));
  // 附件電腦收下後就從手機刪了：留著的這份不帶附件，拿回來時提醒要重新附。
  const stripped = L.withoutFiles(send.sheet || []);
  kept[`${send.job}#${send.reply.id}`] = { from: send.from, sheet: stripped.sheet, text: send.text || '', hadFiles: stripped.dropped || !!(send.overall && send.overall.length), at: Date.now() };
  store.set('sentSheets', kept);
}

// 拿回來重改：電腦取消成功後，把那份修改單與整支意見放回這支手機。
function takeBack(one) {
  const kept = (store.get('sentSheets') || {})[`${one.job}#${one.id}`];
  if (!kept) return toast('修改內容沒存在這支手機，請重新記');
  saveSheet(one.job, kept.from, L.restoreSheet(readSheet(one.job, kept.from), kept.sheet));
  if (kept.text) store.set(`draft-${one.job}`, L.draftBack(store.get(`draft-${one.job}`), kept.text));
  toast(kept.hadFiles ? `已放回 v${kept.from} 的修改單；附件要重新附` : `已放回 v${kept.from} 的修改單`);
}

// 讀電腦對指令的回覆：收到就跳一行狀態、讀完刪掉回覆檔。回傳有沒有新回覆。
// 同一時間只讀一輪；寫回時重新讀紀錄、只補上這輪讀到的回覆，不會蓋掉讀的期間新送的指令。
let readingCommands = false;
async function readCommandReplies() {
  if (readingCommands || !state.files.outbox || !commands().some((one) => !one.reply)) return false;
  readingCommands = true;
  try {
    const files = await listFolder(state.files.outbox).catch(() => []);
    const got = {};
    for (const one of commands().filter((c) => !c.reply)) {
      const found = files.find((f) => f.name === one.file);
      const reply = found && await readJSON(found.id).catch(() => null);
      if (!reply) continue;
      got[one.file] = reply;
      // 「下載附件中」不刪（電腦之後在同一個檔名寫正式回覆）。
      if (reply.status !== 'downloading') api(`files/${found.id}`, {}, { method: 'DELETE' }).catch(() => {});
    }
    if (!Object.keys(got).length) return false;
    const all = commands();
    for (const one of all) {
      if (one.reply || !got[one.file]) continue;
      // 附件還在同步：還不算結果。
      if (got[one.file].status === 'downloading') { if (!one.downloading) toast('電腦正在下載附件…'); one.downloading = true; continue; }
      one.reply = got[one.file];
      toast(L.commandStatus(one.reply));
      // 補充的附件：收下或被拒都刪（補充被拒不放回）。
      if (one.fids && one.fids.length) dropFiles(one.fids);
      if (one.reply.status === 'done' && one.takeBack) takeBack(one);
    }
    store.set('commands', all);
    return true;
  } finally {
    readingCommands = false;
  }
}

// 送出指令後 2 分鐘內每 5 秒看一次回覆；有回覆就重新整理這支（卡片開著、正在打字時等下一輪）。
setInterval(async () => {
  // 原畫質要等複製完才回覆，看久一點（10 分鐘）。
  if (document.hidden || !commands().some((one) => !one.reply && Date.now() - one.at < (one.exportName ? 600000 : 120000))) return;
  if (!(await readCommandReplies().catch(() => false))) return;
  const busy = document.querySelector('.line-card, .bottom-panel') || (document.activeElement && document.activeElement.tagName === 'TEXTAREA');
  if (state.viewing && !busy) loadFolder().then(() => showJob(state.viewing.id, state.viewing.chosen)).catch(() => {});
}, 5000);

// 從下方滑出的小面板（選單、補充輸入框）：點外面或「取消」收起。
function bottomPanel(children) {
  // 修改卡片開著：照「取消」收起（影片放大回來、打到一半的說明不記）；已有小面板就先關掉。
  document.querySelector('.line-card .revise-actions .quiet-button')?.click();
  document.querySelectorAll('.bottom-panel, .panel-shade').forEach((n) => n.remove());
  const panel = el('div', 'bottom-panel');
  const shade = el('div', 'panel-shade');
  // 鍵盤跳出來時貼在鍵盤正上方（和修改卡片一樣）。
  const vv = window.visualViewport;
  const lift = () => { panel.style.bottom = vv ? `${L.keyboardInset(window.innerHeight, vv.height, vv.offsetTop)}px` : '0px'; };
  if (vv) { vv.addEventListener('resize', lift); vv.addEventListener('scroll', lift); }
  const close = () => {
    if (vv) { vv.removeEventListener('resize', lift); vv.removeEventListener('scroll', lift); }
    panel.remove();
    shade.remove();
  };
  shade.onclick = close;
  panel.append(el('div', 'card-handle'), ...children(close));
  document.body.append(shade, panel);
  lift();
  return close;
}

function menuButton(label, run, cls = '') {
  const b = el('button', `panel-item ${cls}`, label);
  b.onclick = run;
  return b;
}

// 排隊中自己送的那筆：拿回來重改／取消這筆。
function openPendingMenu(jobId, row) {
  bottomPanel((close) => [
    el('p', 'muted small', row.text),
    menuButton('拿回來重改', () => { close(); sendCommand(jobId, 'unqueue', { id: row.id }, { id: row.id, takeBack: true }); }),
    menuButton('取消這筆', () => { close(); sendCommand(jobId, 'unqueue', { id: row.id }, { id: row.id }); }, 'danger'),
    menuButton('關閉', close, 'muted'),
  ]);
}

function openLatePanel(jobId) {
  const input = el('textarea', 'revise-input card-note');
  input.rows = 3;
  input.maxLength = 500;
  input.placeholder = '剪輯中想到要補的，例如：結尾加上官網網址';
  let files = [];
  bottomPanel((close) => {
    const actions = el('div', 'revise-actions');
    const cancel = el('button', 'quiet-button', '取消');
    const send = el('button', 'primary-button small', '送出補充');
    cancel.onclick = close;
    send.onclick = async () => {
      const text = input.value.trim();
      if (!text && !files.length) return toast('請寫要補充的內容');
      send.disabled = true;
      try {
        // 有附件先上傳；失敗面板不關，再按一次從沒傳完的接著傳。
        const plan = L.uploadPlan([], files);
        const tooMany = L.planProblem(plan);
        if (tooMany) throw new Error(tooMany);
        const upload = plan.files.length ? await uploadAttachments(jobId, plan) : null;
        await sendCommand(jobId, 'late', upload ? { text, upload, files: plan.overall } : { text }, { fids: plan.files.map((f) => f.fid) });
        if (upload) store.drop(`upload-${jobId}`);
        close();
      } catch (e) {
        send.disabled = false;
        toast(e.message);
      }
    };
    actions.append(cancel, send);
    setTimeout(() => input.focus(), 50);
    return [el('p', 'card-quote', '補充一句話'), el('p', 'muted small', '這一輪剪完會接著照這句改。'), input, attachField(files, (next) => { files = next; }), actions];
  });
}

// 狀態列右邊的按鈕：中止、補充、繼續、重試（中止、重試要再確認一次）。
function jobActionBar(job) {
  const can = L.jobActions(job, state.index && state.index.paused);
  const bar = el('div', 'job-actions');
  const add = (label, run, cls = 'pill') => { const b = el('button', cls, label); b.onclick = run; bar.append(b); };
  const run = (action, question, extra) => () => { if (!question || confirm(question)) sendCommand(job.id, action, extra).catch((e) => toast(e.message)); };
  // 中止帶著按下時剪輯中那一筆的編號：電腦晚收到、已經換剪下一筆時不會誤停。
  const building = (job.pending || []).find((p) => p.building);
  if (can.late) add('補充', () => openLatePanel(job.id));
  if (can.stop) add('中止', run('stop', '中止後這一輪的修改會退回，確定中止？', building && building.id != null ? { id: building.id } : {}), 'pill warn');
  if (can.resume) add('繼續', run('resume'));
  if (can.retry) add('重試', run('retry', '從上次停下的地方重新剪，確定？'));
  return bar.children.length ? bar : null;
}

// 排隊暫停、停住的說明（狀態列下方一行）。
function queueNotice(job) {
  const can = L.jobActions(job, state.index && state.index.paused);
  if (can.resume) return el('p', 'muted small queue-note', '中止後排隊的修改停著，按「繼續」才會開始剪。');
  if (can.pausedNote) return el('p', 'muted small queue-note', '電腦的排隊暫停中，要等電腦恢復才會開始。');
  return null;
}

// 版本清單裡的排隊列與退回列。
function pendingViews(job) {
  const rows = [];
  for (const back of job.returned || []) {
    const row = el('div', 'version pending returned');
    row.append(el('span', 'dot'), el('span', 'version-text', `這筆沒剪成：${back.summary}`));
    if (back.again) {
      const again = el('button', 'quiet-button', '再送一次');
      again.onclick = () => sendCommand(job.id, 'requeue', { id: back.id }).catch((e) => toast(e.message));
      row.append(again);
    }
    rows.push(row);
  }
  for (const p of L.pendingRows(job.pending, deviceId())) {
    const row = el('div', 'version pending');
    row.append(el('span', 'dot'), el('span', 'version-text', p.text));
    if (p.mine) {
      const more = el('button', 'icon-button', '⋯');
      more.setAttribute('aria-label', '這筆修改的選項');
      more.onclick = () => openPendingMenu(job.id, p);
      row.append(more);
    }
    rows.push(row);
  }
  return rows;
}

// 目前這版的引擎回報：前 3 行，點「更多」展開。
function reportView(version) {
  if (!version || !version.report) return null;
  const box = el('div', 'report');
  const preview = L.reportPreview(version.report);
  const text = el('p', 'report-text', preview.text);
  box.append(el('p', 'muted small', `v${version.id} 剪輯回報`), text);
  if (preview.more) {
    const more = el('button', 'quiet-button', '更多');
    more.onclick = () => { text.textContent = version.report; more.remove(); };
    box.append(more);
  }
  return box;
}
