// Ekko 手機版修改卡片的「剪點」：開頭、結尾各一段音波（剪點前後各 1.5 秒，電腦先做好放在 trim-v<N>.json），
// 手指在音波上左右拖，剪點就跟到手指的位置（上下滑是捲動卡片）；點一下也能把剪點移到那裡；‹ › 一次移 0.04 秒；
// ▶ 聽：開頭從新剪點往後聽 2 秒、結尾聽到新剪點為止。灰色是會剪掉的部分。
// 送出的是毛片秒數，和電腦版一樣（電腦補上毛片路徑，照這個秒數剪）。
// 和 app.js 共用全域：el、L、readJSON、jobFiles、listFolder、shareToken、toast。
'use strict';

// 記住剪點資料（音波）本身；聲音檔要播時才去 trim/ 子資料夾找（資料檔常比聲音檔先同步到）。
const trimCache = new Map();
async function loadTrim(jobId, version) {
  const key = `${jobId}#${version}`;
  if (!trimCache.has(key)) {
    trimCache.set(key, (async () => {
      const files = await jobFiles(jobId).catch(() => ({}));
      const fileId = files[`trim-v${version}.json`];
      return fileId ? readJSON(fileId).catch(() => null) : null;
    })());
  }
  const data = await trimCache.get(key);
  if (!data) trimCache.delete(key);
  return data;
}
async function trimAudioId(jobId, name) {
  const folderId = (await jobFiles(jobId).catch(() => ({}))).trim;
  if (!folderId) return null;
  const hit = (await listFolder(folderId).catch(() => [])).find((f) => f.name === name);
  return hit ? hit.id : null;
}

// 剪點面板。k：這一句在逐句清單的位置；clip：{start, end}（毛片秒數）；trim：記過的剪點；onChange(新的 trim 或 null)；
// onReady：音波畫好（卡片變高了）。
function buildTrimPanel({ jobId, version, k, clip, trim, onChange, onReady }) {
  const box = el('div', 'trim-panel');
  box.append(el('p', 'muted small', '讀取音波…'));
  let start = trim && trim.start ? trim.start.to : clip.start;
  let end = trim && trim.end ? trim.end.to : clip.end;
  const audio = el('audio');
  audio.preload = 'auto';
  let audioId = null, watching = 0;
  const stopWatching = () => { cancelAnimationFrame(watching); watching = 0; };
  box.stop = () => { stopWatching(); audio.pause(); };

  loadTrim(jobId, version).then(async (data) => {
    const row = data && (data.lines || []).find((r) => r.k === k);
    // 秒數要和現在的逐句清單一樣（清單重寫過就不用舊的音波）。
    if (!row || Math.abs(row.start - clip.start) > 0.005 || Math.abs(row.end - clip.end) > 0.005) {
      box.replaceChildren(el('p', 'muted small', '這一句的音波還沒準備好（電腦開著時會補做），稍後再試'));
      if (onReady) onReady();
      return;
    }
    await shareToken().catch(() => {});
    // 播一段：還沒載入（iPhone 常見）就先開始播、載入後再跳到正確位置；每一格畫面檢查，到了就停（不等 timeupdate，免得多播到會剪掉的字）。
    const play = async (from, to) => {
      if (!audioId) audioId = await trimAudioId(jobId, row.audio.file);
      if (!audioId) return toast('這一句的聲音還沒同步到，稍後再試');
      const src = `drive-media/${audioId}`;
      if (!audio.src.endsWith(src)) audio.src = src;
      stopWatching();
      const at = Math.max(0, from - row.audio.from), stop = to - row.audio.from;
      const seek = () => { try { audio.currentTime = at; } catch (_) {} };
      if (audio.readyState >= 1) seek(); else audio.addEventListener('loadedmetadata', seek, { once: true });
      audio.play().catch(() => toast('播不出聲音，請確認手機不是靜音'));
      const watch = () => {
        if (audio.currentTime >= stop - 0.02 && audio.currentTime >= at) { audio.pause(); watching = 0; return; }
        watching = requestAnimationFrame(watch);
      };
      watching = requestAnimationFrame(watch);
    };
    const changed = () => onChange(L.makeTrim(clip, start, end));
    const side = (name) => {
      const win = row[name === 'start' ? 'head' : 'tail'];
      const from = win.from, to = from + win.peaks.length / row.perSecond;
      const original = name === 'start' ? clip.start : clip.end;
      const wrap = el('div', 'trim-row');
      const label = el('span', 'trim-label');
      const canvas = el('canvas', 'trim-wave');
      const draw = () => {
        const now = name === 'start' ? start : end;
        const delta = now - original;
        label.textContent = `${name === 'start' ? '開頭' : '結尾'}${Math.abs(delta) < 0.005 ? '・原本' : `・${delta < 0 ? '往前' : '往後'} ${Math.abs(delta).toFixed(2)} 秒`}`;
        const width = canvas.clientWidth || 300, height = 56, ratio = window.devicePixelRatio || 1;
        canvas.width = width * ratio;
        canvas.height = height * ratio;
        const g = canvas.getContext('2d');
        g.scale(ratio, ratio);
        const css = getComputedStyle(document.documentElement);
        const cutX = L.xAtTime(now, width, from, to), originalX = L.xAtTime(original, width, from, to);
        // 會剪掉的那邊畫灰色。
        g.fillStyle = 'rgba(255,255,255,0.06)';
        if (name === 'start') g.fillRect(0, 0, cutX, height); else g.fillRect(cutX, 0, width - cutX, height);
        win.peaks.forEach((p, i) => {
          const x = (i / win.peaks.length) * width, h = Math.max(1, p * (height - 6));
          const kept = name === 'start' ? x >= cutX : x <= cutX;
          g.fillStyle = kept ? (css.getPropertyValue('--text').trim() || '#eee') : 'rgba(236,238,242,0.25)';
          g.fillRect(x, (height - h) / 2, Math.max(1, width / win.peaks.length - 0.5), h);
        });
        g.fillStyle = 'rgba(236,238,242,0.35)';
        g.fillRect(originalX - 0.5, 0, 1, height);
        g.fillStyle = css.getPropertyValue('--accent').trim() || '#93A6C0';
        g.fillRect(cutX - 1.5, 0, 3, height);
      };
      const move = (value) => {
        if (name === 'start') start = L.clampCut('start', value, clip, end); else end = L.clampCut('end', value, clip, start);
        draw();
        changed();
      };
      const timeAt = (event) => { const r = canvas.getBoundingClientRect(); return L.timeAtX(event.clientX - r.left, r.width, from, to); };
      // 左右移動超過 6 點才算拖剪點；上下滑是捲動卡片；沒移動的點一下把剪點移到那裡。
      let touch = null;
      canvas.addEventListener('pointerdown', (event) => { touch = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false }; });
      canvas.addEventListener('pointermove', (event) => {
        if (!touch || event.pointerId !== touch.id) return;
        const dx = event.clientX - touch.x, dy = event.clientY - touch.y;
        if (!touch.dragging && Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) {
          touch.dragging = true;
          canvas.setPointerCapture(event.pointerId);
        }
        if (touch.dragging) move(timeAt(event));
      });
      canvas.addEventListener('pointerup', (event) => {
        if (touch && !touch.dragging && Math.abs(event.clientX - touch.x) < 6 && Math.abs(event.clientY - touch.y) < 6) move(timeAt(event));
        touch = null;
      });
      canvas.addEventListener('pointercancel', () => { touch = null; });
      const buttons = el('div', 'trim-buttons');
      const earlier = el('button', 'pill', '‹');
      const later = el('button', 'pill', '›');
      const listen = el('button', 'pill', '▶ 聽');
      earlier.setAttribute('aria-label', `${name === 'start' ? '開頭' : '結尾'}往前一點`);
      later.setAttribute('aria-label', `${name === 'start' ? '開頭' : '結尾'}往後一點`);
      earlier.onclick = () => move((name === 'start' ? start : end) - 0.04);
      later.onclick = () => move((name === 'start' ? start : end) + 0.04);
      listen.onclick = () => (name === 'start' ? play(start, start + 2) : play(Math.max(start, end - 2), end));
      buttons.append(earlier, later, listen);
      wrap.append(label, canvas, buttons);
      return { wrap, draw };
    };
    const head = side('start'), tail = side('end');
    const reset = el('button', 'quiet-button', '還原剪點');
    reset.onclick = () => { start = clip.start; end = clip.end; head.draw(); tail.draw(); changed(); };
    box.replaceChildren(el('p', 'muted small', '在音波上左右拖，灰色是會剪掉的部分'), head.wrap, tail.wrap, reset, audio);
    requestAnimationFrame(() => { head.draw(); tail.draw(); if (onReady) onReady(); });
  });
  return box;
}
