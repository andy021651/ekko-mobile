// Ekko 手機版看片頁「這一版 ⋯」：調音量（電腦重新混音做成新的一版）、存字幕檔（手機自己做）、原畫質（電腦放到雲端，從雲端硬碟打開）。
// 和 app.js、queue.js 共用全域：el、$、L、state、store、toast、listFolder、sendCommand、bottomPanel、menuButton。
'use strict';

const EXPORT_LINK = (fileId) => `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;

// 狀態列上的「⋯」：少用的都收在這裡（調音量、字幕檔、原畫質；剪輯中的中止；剪好通知我）。version 是看得到的這一版（沒有就只有通知、中止）。
function versionToolsButton(job, version, sentences) {
  const more = el('button', 'pill', '⋯');
  more.setAttribute('aria-label', '更多選項');
  more.onclick = () => openVersionTools(job, version, sentences);
  return more;
}

function openVersionTools(job, version, sentences) {
  const busy = job.status === 'running' || job.status === 'queued';
  const can = L.jobActions(job, state.index && state.index.paused);
  bottomPanel((close) => {
    const items = [el('p', 'muted small', version ? `v${version.id}` : job.title)];
    if (version && version.mixable && !busy) items.push(menuButton('調音量', () => { close(); openMixPanel(job, version); }));
    if (version && sentences.length) items.push(menuButton('存字幕檔', () => { close(); saveSubtitles(job, version, sentences); }));
    if (version) items.push(menuButton('原畫質', () => { close(); openExportPanel(job, version); }));
    // 剪好通知我：送出修改時會自動打開，這裡可以關或手動開。
    const on = following(job.id);
    items.push(menuButton(on ? '剪好時不要通知我' : '剪好時通知我', () => { close(); toggleFollow(job.id).then(() => toast(on ? '不會通知了' : '剪好會通知你')).catch((e) => toast(e.message)); }));
    // 中止帶著按下時剪輯中那一筆的編號：電腦晚收到、已經換剪下一筆時不會誤停。
    if (can.stop) {
      const building = (job.pending || []).find((p) => p.building);
      items.push(menuButton('中止剪輯', () => {
        close();
        if (confirm('中止後這一輪的修改會退回，確定中止？')) sendCommand(job.id, 'stop', building && building.id != null ? { id: building.id } : {}).catch((e) => toast(e.message));
      }, 'danger'));
    }
    items.push(menuButton('關閉', close, 'muted'));
    return items;
  });
}

// 三條滑桿（-24～+12 dB），送出後電腦重新混音做成新的一版；手機上沒有分軌，不能先試聽。
function openMixPanel(job, version) {
  const gains = { voice: 0, music: 0, sfx: 0 };
  const names = { voice: '人聲', music: '音樂', sfx: '音效' };
  bottomPanel((close) => {
    const rows = Object.keys(gains).map((kind) => {
      const row = el('label', 'mix-row');
      const value = el('span', 'mix-value', L.gainText(0));
      const slider = el('input', 'mix-slider');
      Object.assign(slider, { type: 'range', min: -24, max: 12, step: 1, value: 0 });
      slider.setAttribute('aria-label', `${names[kind]}音量`);
      slider.oninput = () => { gains[kind] = Number(slider.value); value.textContent = L.gainText(gains[kind]); };
      row.append(el('span', 'mix-name', names[kind]), slider, value);
      return row;
    });
    const actions = el('div', 'revise-actions');
    const cancel = el('button', 'quiet-button', '取消');
    const send = el('button', 'primary-button small', '做成新的一版');
    cancel.onclick = close;
    send.onclick = () => {
      if (!gains.voice && !gains.music && !gains.sfx) return toast('三軌都沒調');
      close();
      sendCommand(job.id, 'remix', { version: version.id, gains }).catch((e) => toast(e.message));
    };
    actions.append(cancel, send);
    return [el('p', 'card-quote', `調 v${version.id} 的音量`), el('p', 'muted small', '電腦重新混音做成新的一版，不經剪輯引擎、不花額度。手機上不能先試聽。'), ...rows, actions];
  });
}

// 字幕檔：用這一版的逐句清單做 SRT，能分享就叫出系統分享（存到檔案、AirDrop），不行就直接下載。
async function saveSubtitles(job, version, sentences) {
  const name = `${job.title || job.id}-v${version.id}.srt`;
  // 用 text/plain：手機的分享選單比較願意收（字幕檔本來就是純文字）。
  const file = new File([L.subtitleSRT(sentences)], name, { type: 'text/plain' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) return await navigator.share({ files: [file] });
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  const link = el('a');
  link.href = URL.createObjectURL(file);
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

// 原畫質：雲端 exports/ 已經有就給「在雲端硬碟打開」；沒有就請電腦放上去（同步要一點時間，回來再點一次「原畫質」）。
async function openExportPanel(job, version) {
  const name = `${job.id}-v${version.id}.mp4`;
  const found = await findExport(name);
  bottomPanel((close) => {
    const items = [el('p', 'card-quote', `v${version.id} 原畫質`)];
    if (found) {
      const open = el('a', 'panel-item link', '在雲端硬碟打開');
      open.href = EXPORT_LINK(found);
      open.target = '_blank';
      open.rel = 'noopener';
      open.onclick = close;
      items.push(el('p', 'muted small', '在雲端硬碟裡可以下載到手機或分享。放 3 天後會自動清掉，電腦裡的成片不受影響。'), open);
    } else if (waitingExport(name)) {
      items.push(el('p', 'muted small', '電腦正在放上雲端，同步完成後再點一次「原畫質」。'),
        menuButton('重新看一次', () => { close(); openExportPanel(job, version); }));
    } else {
      items.push(el('p', 'muted small', '請電腦把原畫質放到雲端硬碟（檔案比較大，同步要幾分鐘），3 天後自動清掉。'),
        menuButton('放到雲端', () => { close(); sendCommand(job.id, 'export', { version: version.id }, { exportName: name }).catch((e) => toast(e.message)); }));
    }
    items.push(menuButton('關閉', close, 'muted'));
    return items;
  });
}

// 還在等的原畫質：送出 10 分鐘內還沒回覆（電腦中途關掉就不會回），或電腦說放好了、雲端還在同步。
const waitingExport = (name) => commands().some((one) => one.exportName === name
  && ((!one.reply && Date.now() - one.at < 600000) || (one.reply && one.reply.status === 'done')));

async function findExport(name) {
  if (!state.files.exports) await loadFolder().catch(() => {});
  if (!state.files.exports) return null;
  const files = await listFolder(state.files.exports).catch(() => []);
  const hit = files.find((f) => f.name === name);
  return hit ? hit.id : null;
}
