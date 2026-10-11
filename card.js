// Ekko 手機版的看片零件：自己的播放器、「改這裡」修改卡片、修改單（進度條上的點與清單）。
// 和 app.js 共用全域（classic script）：用到 app.js 的 el、$、L、toast、readSheet、saveSheet。
'use strict';
// ---- 看片 ----
// 「這裡要改」的卡片：當下那一句、現在有沒有畫面、三種改法。卡片開著時不重畫看片頁（refreshList 看 .line-card）。
// 開著時影片縮小貼在上面（body.marking），記下來只更新修改單那幾行，影片不重新載入。
function openLineCard(jobId, version, lines, at, player) {
  // 已經開著一張：照「取消」完整收掉（拆掉監聽），不然每換一句就多一組在背景跑，越用越卡。
  const opened = document.querySelector('.line-card');
  if (opened) { if (opened.close) opened.close(); else opened.remove(); }
  // 補充、排隊選單的小面板開著：先收起（連同半透明遮罩）。
  document.querySelectorAll('.bottom-panel, .panel-shade').forEach((n) => n.remove());
  const card = el('div', 'line-card');
  document.body.classList.add('marking');
  // 鍵盤跳出來時卡片貼在鍵盤正上方。
  const vv = window.visualViewport;
  // 捲動、鍵盤進出時 visualViewport 會一直發事件：一格畫面最多處理一次，值沒變就不動（免得每格都重排版，iPhone 會卡）。
  let lifting = 0, lastBottom = '', lastMax = '', resizeWatch = null;
  const lift = () => {
    if (lifting) return;
    lifting = requestAnimationFrame(() => {
      lifting = 0;
      const bottom = vv ? `${L.keyboardInset(window.innerHeight, vv.height, vv.offsetTop)}px` : '0px';
      // 卡片最高到看得到的範圍（鍵盤打開時變矮），太高就可以捲。
      const max = `${(vv ? vv.height : window.innerHeight) - 24}px`;
      if (bottom === lastBottom && max === lastMax) return;
      lastBottom = bottom;
      lastMax = max;
      card.style.bottom = bottom;
      card.style.maxHeight = max;
      refit();
      // 全螢幕時進度條移到卡片正上方，改的時候看得到。
      const controls = document.querySelector('.stage-full .stage-controls');
      if (controls) controls.style.bottom = `${Math.max(0, window.innerHeight - card.getBoundingClientRect().top)}px`;
    });
  };
  if (vv) { vv.addEventListener('resize', lift); vv.addEventListener('scroll', lift); }
  const finish = (play) => {
    if (!card.isConnected && !play) return;
    card.querySelector('.trim-panel')?.stop();
    if (vv) { vv.removeEventListener('resize', lift); vv.removeEventListener('scroll', lift); }
    cancelAnimationFrame(lifting);
    resizeWatch?.disconnect();
    card.remove();
    document.body.classList.remove('marking');
    player.style.maxHeight = '';
    const controls = document.querySelector('.stage-controls');
    if (controls) controls.style.bottom = '';
    paintBand(null);
    paintSheet(jobId, version, lines);
    if (play) player.play().catch(() => {});
  };
  // 平常時影片縮到卡片上方放得下的高度，再捲到最上面：整個畫面都看得到。卡片變高（多出延伸、來源）時再算一次。
  let fitted = 0;
  const fit = () => {
    if (!card.isConnected || document.querySelector('.stage-full')) return;
    player.style.maxHeight = `${Math.max(160, card.getBoundingClientRect().top - 24)}px`;
    window.scrollTo({ top: Math.max(0, $('stage').getBoundingClientRect().top + window.scrollY - 8) });
  };
  function refit() {
    if (!card.isConnected) return;
    // 卡片比螢幕高（例如展開剪點）：改成可以上下捲（這時往下滑收起卡片不作用，用「取消」）。
    card.classList.toggle('tall', card.scrollHeight > (window.visualViewport ? window.visualViewport.height : window.innerHeight) - 24);
    if (card.offsetHeight !== fitted) { fitted = card.offsetHeight; fit(); }
  }
  // 跳到那一句：影片還沒準備好（iPhone 常見）就等準備好再跳，沒跳成再試一次，免得卡片寫這句、影片停在別句。
  const seekTo = (t) => {
    const go = () => { try { player.currentTime = t; } catch (_) {} };
    if (player.readyState >= 1) go(); else player.addEventListener('loadedmetadata', go, { once: true });
    setTimeout(() => { if (Math.abs(player.currentTime - t) > 0.3) go(); }, 500);
  };
  const render = (i) => {
    const line = lines[i];
    const saved = readSheet(jobId, version).find((e) => e.text === line.text && Math.abs(e.at - line.at) < 0.05) || {};
    let files = saved.files || [];
    let trim = saved.trim || null;
    let cut = !!saved.cut, broll = saved.broll || null, source = saved.source || '', linkPrev = !!saved.prev, linkNext = !!saved.next;
    seekTo(line.at);
    // 點字選範圍（只做這幾個字）：先點開頭、再點結尾；同一個字點兩次清掉。a、b 是 tokens 的位置。
    const tokens = L.wordTokens(line.text);
    let partA = null, partB = null;
    if (saved.part) {
      for (let x = 0; x < tokens.length && partA == null; x++) for (let y = x; y < tokens.length; y++) if (tokens[x].word && L.partText(tokens, x, y) === saved.part) { partA = x; partB = y; break; }
    }
    const part = () => (partA == null ? '' : L.partText(tokens, partA, partB));
    const nav = el('div', 'card-nav');
    const prev = el('button', 'quiet-button', '‹ 上一句');
    const next = el('button', 'quiet-button', '下一句 ›');
    prev.disabled = i === 0;
    next.disabled = i === lines.length - 1;
    // 換上一句／下一句前先把這一句記下來，打到一半的說明不會不見。
    const move = (to) => { if (remember()) render(to); };
    prev.onclick = () => move(i - 1);
    next.onclick = () => move(i + 1);
    // 中間「▶ 0:00–0:07」：只播這一句（連到上下句時播整段），播完就停，看清楚要改的是哪裡。
    const playSpan = el('button', 'quiet-button card-play', `▶ ${L.rangeLabel(line)}`);
    playSpan.onclick = () => {
      const span = L.changeSpan(lines, i, { prev: linkPrev, next: linkNext });
      seekTo(span.at);
      player.play().catch(() => {});
      const stop = () => { if (player.currentTime >= span.end - 0.05) player.pause(); };
      player.addEventListener('timeupdate', stop);
      player.addEventListener('pause', () => player.removeEventListener('timeupdate', stop), { once: true });
    };
    nav.append(prev, playSpan, next);
    const quote = el('p', 'card-quote');
    const tokenEls = tokens.map((t, k) => {
      const span = el('span', t.word ? 'word' : null, t.text);
      if (t.word) span.onclick = () => {
        if (partA == null || partA !== partB) { partA = k; partB = k; }
        else if (k === partA) { partA = null; partB = null; }
        else partB = k;
        paint();
      };
      return span;
    });
    quote.append('「', ...tokenEls, '」');
    const partRow = el('div', 'card-part');
    const explain = el('p', 'card-explain');
    // 一列選完：移除這句｜換畫面／換動畫（原本就有的叫「重做」）／不要畫面。
    const choiceRow = el('div', 'card-choices');
    const cutButton = el('button', 'pill', '移除這句');
    choiceRow.append(cutButton, el('span', 'card-divider'));
    const choices = [['footage', '畫面'], ['animation', '動畫'], ...(line.broll ? [['remove', '不要畫面']] : [])];
    const chips = choices.map(([key, label]) => {
      const chip = el('button', 'pill', key === 'remove' ? label : line.broll === key ? `重做${label}` : `換${label}`);
      chip.onclick = () => { broll = broll === key ? null : key; cut = false; paint(); };
      choiceRow.append(chip);
      return [key, chip];
    });
    // 換畫面／換動畫才有：畫面延伸到上一句、下一句（片頭片尾沒有那一邊）；換畫面再多選從哪裡找（同電腦版的條件）。
    const toggle = (label, on, flip) => {
      const pill = el('button', 'pill', label);
      pill.onclick = () => { flip(); paint(); };
      return [pill, on];
    };
    const links = [];
    if (L.neighborOf(lines, i, 'prev')) links.push(toggle('連到上一句', () => linkPrev, () => { linkPrev = !linkPrev; }));
    if (L.neighborOf(lines, i, 'next')) links.push(toggle('連到下一句', () => linkNext, () => { linkNext = !linkNext; }));
    const linkRow = el('div', 'card-choices card-extra');
    linkRow.append(el('span', 'card-label', '延伸'), ...links.map(([pill]) => pill));
    const job = ((state.index && state.index.jobs) || []).find((j) => j.id === jobId) || {};
    const sources = [['', '自動'], ...((job.sources || {}).mine ? [['mine', '我的素材']] : []), ...((job.sources || {}).stock ? [['stock', '圖庫']] : [])];
    if (!sources.some(([key]) => key === source)) source = '';
    const sourceRow = el('div', 'card-choices card-extra');
    const sourceChips = sources.map(([key, label]) => {
      const chip = el('button', 'pill', label);
      chip.onclick = () => { source = key; paint(); };
      return [key, chip];
    });
    sourceRow.append(el('span', 'card-label', '來源'), ...sourceChips.map(([, chip]) => chip));
    // 說明平常收成一行，要寫才展開（卡片比較矮）。
    const note = el('textarea', 'revise-input card-note');
    note.rows = 2;
    note.maxLength = 500;
    note.placeholder = '寫說明（可以用語音輸入）';
    note.value = saved.note || '';
    const addNote = el('button', 'quiet-button card-add-note', '＋ 加說明');
    const showNote = (focus) => { addNote.hidden = true; note.hidden = false; if (focus) note.focus(); };
    note.hidden = !note.value;
    addNote.hidden = !!note.value;
    addNote.onclick = () => showNote(true);
    note.oninput = () => paint();
    const paint = () => {
      // 進度條即時跟著：選了改法先出現空心點（亮的那一段在下面算）。
      paintMarks(jobId, version, lines, { text: line.text, at: line.at, cut, broll, note: note.value.trim() });
      // 移除這句時不用寫說明：收起說明，免得寫了以為有送。
      note.disabled = cut;
      addNote.disabled = cut;
      cutButton.classList.toggle('on', cut);
      cutButton.setAttribute('aria-pressed', String(cut));
      chips.forEach(([key, chip]) => { chip.classList.toggle('on', broll === key); chip.setAttribute('aria-pressed', String(broll === key)); });
      linkRow.hidden = !links.length || !(broll === 'footage' || broll === 'animation');
      links.forEach(([pill, on]) => { pill.classList.toggle('on', on()); pill.setAttribute('aria-pressed', String(on())); });
      sourceRow.hidden = sources.length < 2 || broll !== 'footage';
      sourceChips.forEach(([key, chip]) => { chip.classList.toggle('on', source === key); chip.setAttribute('aria-pressed', String(source === key)); });
      // 選到的字亮起來；下面一行寫這次會改哪一段、改成什麼。
      const lo = partA == null ? -1 : Math.min(partA, partB), hi = partA == null ? -2 : Math.max(partA, partB);
      tokenEls.forEach((span, k) => span.classList.toggle('picked', k >= lo && k <= hi));
      const withBroll = broll === 'footage' || broll === 'animation';
      if (part()) {
        const clear = el('button', 'quiet-button', '清除');
        clear.onclick = () => { partA = null; partB = null; paint(); };
        partRow.replaceChildren(el('span', 'muted small', `只做「${part()}」`), clear);
      } else {
        partRow.replaceChildren(...(withBroll ? [el('span', 'muted small', '只要做幾個字：點開頭的字、再點結尾的字')] : []));
      }
      const what = L.changeText(lines, i, { cut, broll, prev: linkPrev, next: linkNext, part: withBroll ? part() : '' });
      explain.textContent = what || `現在${L.brollNow(line) === '沒有' ? '沒有畫面' : L.brollNow(line)}`;
      explain.classList.toggle('muted', !what);
      // 進度條標出整段（連到上下句時跨過去）。
      paintBand(withBroll ? L.changeSpan(lines, i, { prev: linkPrev, next: linkNext }) : line);
      // 只有卡片高度變了才重算（打字、鍵盤跳出時不動影片）。
      refit();
    };
    cutButton.onclick = () => { cut = !cut; if (cut) broll = null; paint(); };
    const actions = el('div', 'revise-actions');
    const cancel = el('button', 'quiet-button', '取消');
    const keep = el('button', 'primary-button small', '記下來');
    cancel.onclick = () => finish(false);
    // 記進修改單；超過 30 項不記，回傳 false。
    const remember = () => {
      const entry = { text: line.text, at: line.at, cut, broll, current: line.broll || null, note: note.value.trim(), replace: true, files,
                      source, prev: linkPrev ? L.neighborOf(lines, i, 'prev') : null, next: linkNext ? L.neighborOf(lines, i, 'next') : null, part: part(), trim };
      const sheet = readSheet(jobId, version);
      if ((cut || broll || entry.note || files.length || trim) && !L.canAddToSheet(sheet, entry)) { toast('修改單一次最多 30 項，先送出這些再記'); return false; }
      saveSheet(jobId, version, L.putSheet(sheet, entry));
      return true;
    };
    keep.onclick = () => { if (remember()) finish(true); };
    actions.append(cancel, keep);
    paint();
    // 這一句的附件（移除這句時不帶）。
    const attach = attachField(files, (next) => { files = next; refit(); });
    // 剪點：平常收成一顆「✂ 剪點」，按了才展開音波（那一版有電腦做好的音波才有）。
    const trimBox = el('div', 'trim-box');
    const trimToggle = el('button', 'quiet-button card-add-note', trim ? `✂ 剪點：${L.trimText(trim)}` : '✂ 剪點');
    trimToggle.hidden = !line.clip;
    trimToggle.onclick = () => {
      if (trimBox.firstChild) { trimBox.firstChild.stop(); trimBox.replaceChildren(); refit(); return; }
      trimBox.replaceChildren(buildTrimPanel({ jobId, version, k: i, clip: line.clip, trim, onReady: refit, onChange: (next) => {
        trim = next;
        trimToggle.textContent = trim ? `✂ 剪點：${L.trimText(trim)}` : '✂ 剪點';
      } }));
      refit();
    };
    card.replaceChildren(el('div', 'card-handle'), nav, quote, partRow, choiceRow, explain, linkRow, sourceRow, trimToggle, trimBox, addNote, note, attach, actions);
    refit();
  };
  render(Math.max(0, at));
  // 往下滑收起卡片（和「取消」一樣）；拉不夠放開就彈回去。點按鈕不受影響：移動超過 8 點才算在拉。
  let drag = null;
  card.addEventListener('pointerdown', (event) => {
    if (event.target.closest('textarea, .trim-wave')) return;
    drag = { id: event.pointerId, y: event.clientY, dy: 0, pulling: false };
  });
  card.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag.dy = Math.max(0, event.clientY - drag.y);
    if (!drag.pulling && drag.dy > 8) {
      drag.pulling = true;
      card.setPointerCapture(event.pointerId);
      card.classList.add('dragging');
    }
    if (drag.pulling) card.style.transform = `translateY(${drag.dy}px)`;
  });
  const release = () => {
    const done = drag;
    drag = null;
    if (!done || !done.pulling) return;
    card.classList.remove('dragging');
    if (L.dragClose(done.dy, card.offsetHeight)) finish(false);
    else card.style.transform = '';
  };
  card.addEventListener('pointerup', release);
  card.addEventListener('pointercancel', release);
  card.close = () => finish(false);
  document.body.append(card);
  // 卡片內容變高變矮（展開剪點、音波畫好、加附件）都重新檢查能不能捲、影片要縮多少。
  resizeWatch = window.ResizeObserver ? new ResizeObserver(() => refit()) : null;
  resizeWatch?.observe(card);
  lift();
  // 全螢幕時卡片半透明疊在影片下半部；平常時影片縮到卡片上方放得下的高度，再捲到最上面：整個畫面都看得到。
  if (document.querySelector('.stage-full')) { card.classList.add('over-video'); return; }
  fitted = card.offsetHeight;
  fit();
}

// 自己的播放器（內建的控制列和全螢幕加不了東西）：播放鍵、進度條（修改單每一筆一個點，點了回到那一句）、時間、全螢幕；
// 影片上方顯示現在播到哪一句，右下浮一顆「✎ 改這裡」。點影片也能播放／暫停。
function buildStage(jobId, version, sentences, player) {
  const stage = el('div', 'stage');
  stage.id = 'stage';
  const caption = el('div', 'stage-caption');
  const mark = el('button', 'stage-mark', '✎ 改這裡');
  const controls = el('div', 'stage-controls');
  const play = el('button', 'stage-button', '▶');
  const scrub = el('div', 'stage-scrub');
  const fill = el('div', 'stage-fill');
  const band = el('div', 'stage-band');
  band.hidden = true;
  const marks = el('div', 'stage-marks');
  const time = el('span', 'stage-time', '0:00');
  const full = el('button', 'stage-button', '⤢');
  play.setAttribute('aria-label', '播放');
  full.setAttribute('aria-label', '全螢幕');
  scrub.setAttribute('role', 'slider');
  scrub.setAttribute('aria-label', '播放位置');
  scrub.append(band, fill, marks);
  controls.append(play, scrub, time, full);
  const sync = () => {
    const duration = player.duration;
    fill.style.width = `${duration > 0 ? (player.currentTime / duration) * 100 : 0}%`;
    time.textContent = L.timeText(player.currentTime, duration);
    play.textContent = player.paused ? '▶' : '❚❚';
    play.setAttribute('aria-label', player.paused ? '播放' : '暫停');
    const at = L.lineAt(sentences, player.currentTime);
    caption.textContent = at >= 0 ? sentences[at].text : '';
  };
  ['timeupdate', 'play', 'pause', 'loadedmetadata', 'durationchange', 'seeked'].forEach((name) => player.addEventListener(name, sync));
  player.addEventListener('loadedmetadata', () => paintMarks(jobId, version, sentences));
  const toggle = () => (player.paused ? player.play().catch(() => {}) : player.pause());
  play.onclick = toggle;
  player.onclick = toggle;
  // 進度條：按住拖到哪就跳到哪。
  const seek = (event) => {
    const box = scrub.getBoundingClientRect();
    if (player.duration > 0) player.currentTime = L.scrubFraction(event.clientX, box.left, box.width) * player.duration;
  };
  scrub.addEventListener('pointerdown', (event) => { scrub.setPointerCapture(event.pointerId); seek(event); });
  scrub.addEventListener('pointermove', (event) => { if (scrub.hasPointerCapture(event.pointerId)) seek(event); });
  full.onclick = () => {
    const on = !stage.classList.contains('stage-full');
    stage.classList.toggle('stage-full', on);
    document.body.classList.toggle('stage-open', on);
    full.textContent = on ? '⤡' : '⤢';
    full.setAttribute('aria-label', on ? '離開全螢幕' : '全螢幕');
  };
  if (sentences.length) {
    mark.onclick = () => { player.pause(); openLineCard(jobId, version, sentences, L.lineAt(sentences, player.currentTime), player); };
  } else {
    mark.hidden = true;
    caption.hidden = true;
  }
  stage.append(player, caption, mark, controls);
  sync();
  return stage;
}

// 正在改的那一句在進度條上亮一段；line 是 null 就收起來。
function paintBand(line) {
  const stage = $('stage');
  const band = stage && stage.querySelector('.stage-band');
  const player = stage && stage.querySelector('video');
  if (!band || !player) return;
  const range = line ? L.lineBand(line, player.duration) : null;
  band.hidden = !range;
  if (range) { band.style.left = `${range.left}%`; band.style.width = `${range.width}%`; }
}

// 進度條上的點：修改單每一筆一個，點了停下來打開那一句的卡片。
function paintMarks(jobId, version, sentences, draft) {
  const stage = $('stage');
  const marks = stage && stage.querySelector('.stage-marks');
  const player = stage && stage.querySelector('video');
  if (!marks || !player) return;
  marks.replaceChildren(...L.sheetMarks(readSheet(jobId, version), player.duration, draft).map((m) => {
    const dot = el('button', 'stage-dot' + (m.pending ? ' pending' : ''));
    dot.style.left = `${m.left}%`;
    dot.setAttribute('aria-label', `修改單：${L.clock(m.at)}`);
    dot.addEventListener('pointerdown', (event) => event.stopPropagation());
    dot.onclick = () => {
      const at = sentences.findIndex((l) => l.text === m.text && Math.abs(l.at - m.at) < 0.05);
      if (at >= 0) { player.pause(); openLineCard(jobId, version, sentences, at, player); }
    };
    return dot;
  }));
}

// 修改單那幾行和最下方那一條：記下來、刪掉時只更新這裡，不重畫整頁。
function paintSheet(jobId, version, sentences) {
  const list = $('sheet'), bar = $('sheetBar'), input = document.querySelector('.revise > .revise-input');
  if (!list || !bar) return;
  const sheet = version != null ? readSheet(jobId, version) : [];
  paintMarks(jobId, version, sentences);
  $('sentences')?.repaint();
  list.hidden = bar.hidden = !sheet.length;
  if (input) input.placeholder = sheet.length ? '整支影片的意見（可以不寫）' : '想改哪裡？例如：第二句字幕放大、結尾音樂小聲一點';
  bar.replaceChildren(el('span', null, `修改單・${sheet.length} 項`), el('span', null, '送出 ›'));
  list.replaceChildren(el('p', 'muted small', `修改單・${sheet.length} 項`));
  for (const entry of sheet) {
    const row = el('div', 'sheet-row');
    const jump = el('button', 'sheet-text', L.sheetLine(entry));
    jump.onclick = () => {
      // 調整順序那一筆：打開句子區的調整順序。
      if (L.isOrder(entry)) return $('sentences')?.startOrdering();
      if (L.isRestore(entry)) return $('sentences')?.showDropped();
      const player = document.querySelector('video');
      const at = sentences.findIndex((l) => l.text === entry.text && Math.abs(l.at - entry.at) < 0.05);
      if (player && at >= 0) { player.pause(); openLineCard(jobId, version, sentences, at, player); }
    };
    const drop = el('button', 'icon-button', '×');
    drop.setAttribute('aria-label', '刪掉這一筆');
    drop.onclick = () => { saveSheet(jobId, version, L.dropSheet(readSheet(jobId, version), entry)); paintSheet(jobId, version, sentences); };
    row.append(jump, drop);
    list.append(row);
  }
}
