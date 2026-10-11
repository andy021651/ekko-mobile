// Ekko 手機版看片頁的兩個面板（從下方滑出）：
// - 送出：修改單、整支影片的意見、整支的附檔、送出鍵（看片頁只留最下方那一條）。
// - 版本：每一版（點了切換）、排隊中與沒剪成的修改、這一版的剪輯回報。
// 和 app.js、card.js、queue.js 共用全域：el、L、state、store、toast、bottomPanel、menuButton、readSheet、saveSheet、paintSheet、
// overallFiles、saveOverallFiles、attachField、sendRevision、showJob、pendingViews、reportView、following。
'use strict';

function openSendPanel(jobId, version, sentences) {
  bottomPanel((close) => {
    const list = el('div', 'sheet-list');
    list.id = 'sheet';
    const input = el('textarea', 'revise-input');
    input.rows = 3;
    input.maxLength = 2000;
    const draftKey = `draft-${jobId}`;
    input.value = store.get(draftKey) || '';
    input.oninput = () => { store.set(draftKey, input.value); paintSheet(jobId, version, sentences); };
    const notes = [];
    if (L.isOffline(state.mac, Date.now())) notes.push(el('p', 'muted small', '電腦離線中，開機後才會開始改'));
    // 這支手機沒開通知：先講清楚剪好不會跳通知、怎麼打開（從瀏覽器開的收不到，要從主畫面的 Ekko）。
    if (!(state.device && state.device.subscription)) {
      notes.push(el('p', 'muted small', navigator.standalone === false
        ? '從瀏覽器打開的收不到通知：請點主畫面上的 Ekko 圖示打開'
        : '這支手機還沒開通知，剪好不會跳通知（設定 → 剪好通知）'));
    }
    const actions = el('div', 'revise-actions');
    const cancel = el('button', 'quiet-button', '先不送');
    const send = el('button', 'primary-button small', version != null ? `送出修改（改 v${version}）` : '送出修改');
    cancel.onclick = close;
    send.onclick = async () => {
      const text = input.value.trim();
      const sending = version != null ? readSheet(jobId, version) : [];
      const attached = overallFiles(jobId);
      if (!text && !sending.length && !attached.length) return toast('請寫要改哪裡');
      if (L.tooBigToSend({ text, items: L.sheetItems(sending) })) return toast('修改單太長了，請刪掉幾項或縮短說明，分兩次送');
      send.disabled = true;
      try {
        await sendRevision(jobId, version, text, sending, attached);
        store.drop(draftKey);
        saveOverallFiles(jobId, []);
        if (version != null) saveSheet(jobId, version, []);
        toast('已送到雲端');
        close();
        showJob(jobId, version);
      } catch (e) {
        send.disabled = false;
        toast(e.message);
      }
    };
    actions.append(cancel, send);
    setTimeout(() => paintSheet(jobId, version, sentences), 0);
    return [el('p', 'card-quote', '送出修改'), list, input,
      attachField(overallFiles(jobId), (next) => { saveOverallFiles(jobId, next); paintSheet(jobId, version, sentences); }, '附檔給整支'), ...notes, actions];
  }, 'send-panel');
}

function openVersionPanel(job, lines, current, files) {
  bottomPanel((close) => {
    const list = el('div', 'group versions-list');
    for (const v of lines) {
      const row = el('button', 'version' + (current && v.id === current.id ? ' on' : ''));
      row.append(el('b', null, `v${v.id}`), el('span', 'version-text', v.text || '—'));
      if (!(v.ready && files[`v${v.id}.mp4`])) row.append(el('span', 'version-wait', '準備中'));
      row.onclick = () => {
        if (!(v.ready && files[`v${v.id}.mp4`])) return toast('這一版手機用的檔案還在準備');
        if (current && v.id !== current.id && readSheet(job.id, current.id).length) toast(`v${current.id} 的修改單先收起來，切回 v${current.id} 還在`);
        close();
        showJob(job.id, v.id);
      };
      list.append(row);
    }
    list.append(...pendingViews(job));
    const report = reportView(current && (job.versions || []).find((v) => v.id === current.id));
    return [el('p', 'card-quote', '版本'), list, ...(report ? [report] : []), menuButton('關閉', close, 'muted')];
  }, 'version-panel');
}
