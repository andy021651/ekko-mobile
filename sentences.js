// Ekko 手機版看片頁的「全部句子」：不用邊播邊找，直接點一句打開修改卡片；這版改過的句子打藍點；
// 「調整順序」用 ↑ ↓ 換位置，完成後記成修改單的一筆。平常收成一列，展開與否記在這支手機上。
// 和 app.js、card.js 共用全域：el、$、L、store、toast、readSheet、saveSheet、openLineCard、paintSheet。
'use strict';

// previous：上一版的逐句清單（標出這版改過的句子），沒有就是空陣列。dropped：被剪掉的句子（「被剪掉的」分頁，可以加回）。
function buildSentences({ jobId, version, sentences, previous, player, dropped = [] }) {
  const box = el('div', 'group sentences');
  box.id = 'sentences';
  const changed = L.changedLines(previous, sentences);
  let open = !!store.get('sentencesOpen');
  let ordering = null;   // 調整順序中：目前排好的句子（{text, at}）
  let tab = dropped.length && store.get('sentencesTab') === 'dropped' ? 'dropped' : 'kept';

  const head = () => {
    const row = el('div', 'sentences-head');
    const toggle = el('button', 'sentences-toggle', `全部句子・${sentences.length} 句`);
    toggle.append(el('span', 'muted', open ? ' ⌃' : ' ›'));
    toggle.setAttribute('aria-expanded', String(open));
    toggle.onclick = () => { open = !open; ordering = null; store.set('sentencesOpen', open); paint(); };
    row.append(toggle);
    if (open && !ordering && tab === 'kept' && sentences.length > 1) {
      const order = el('button', 'quiet-button', '調整順序');
      order.onclick = () => startOrdering();
      row.append(order);
    }
    return row;
  };

  const lineRow = (line, i, sheet) => {
    const row = el('button', 'sentence');
    row.append(el('span', 'sentence-time', L.clock(line.at)), el('span', 'sentence-text', line.text));
    const tags = el('span', 'sentence-tags');
    if (changed.has(i)) { const dot = el('span', 'changed-dot'); dot.title = '這版改過'; dot.setAttribute('aria-label', '這版改過'); tags.append(dot); }
    if (line.broll) tags.append(el('span', 'tag', line.broll === 'animation' ? '動畫' : '畫面'));
    if (sheet.some((e) => !L.isOrder(e) && L.sameLine(e, line))) tags.append(el('span', 'tag on', '已記'));
    row.append(tags);
    row.onclick = () => { player.pause(); openLineCard(jobId, version, sentences, i, player); };
    return row;
  };

  // 「留下的／被剪掉的」分頁（有被剪掉的句子才有）。
  const tabs = () => {
    const row = el('div', 'segmented sentences-tabs');
    row.setAttribute('role', 'tablist');
    for (const [key, label] of [['kept', `留下的・${sentences.length}`], ['dropped', `被剪掉的・${dropped.length}`]]) {
      const b = el('button', 'pill' + (tab === key ? ' on' : ''), label);
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(tab === key));
      b.onclick = () => { tab = key; store.set('sentencesTab', key); paint(); };
      row.append(b);
    }
    return row;
  };

  // 被剪掉的句子：照毛片順序，聽不到原音（毛片不傳到手機），只看文字；「加回」記進修改單，已記的再按一次拿掉。
  const droppedRow = (line, sheet) => {
    const row = el('div', 'sentence');
    const entry = L.restoreEntry(line);
    const queued = sheet.some((e) => L.sameLine(e, entry));
    row.append(el('span', 'sentence-time wide', L.droppedLabel(line)), el('span', 'sentence-text', line.text));
    const toggle = el('button', 'pill' + (queued ? ' on' : ''), queued ? '已記' : '加回');
    toggle.setAttribute('aria-pressed', String(queued));
    toggle.onclick = () => {
      const now = readSheet(jobId, version);
      if (!queued && !L.canAddToSheet(now, entry)) return toast('修改單一次最多 30 項，先送出這些再記');
      saveSheet(jobId, version, queued ? L.dropSheet(now, entry) : L.putSheet(now, entry));
      paintSheet(jobId, version, sentences);
    };
    row.append(toggle);
    return row;
  };

  const orderRows = (sheet) => {
    const cuts = sheet.filter((e) => e.cut);
    return ordering.map((line, i) => {
      const row = el('div', 'sentence ordering' + (cuts.some((c) => L.sameLine(c, line)) ? ' cut' : ''));
      row.append(el('span', 'sentence-time', `${i + 1}`), el('span', 'sentence-text', line.text));
      const up = el('button', 'icon-button move', '↑');
      const down = el('button', 'icon-button move', '↓');
      up.setAttribute('aria-label', '往上移');
      down.setAttribute('aria-label', '往下移');
      up.disabled = i === 0;
      down.disabled = i === ordering.length - 1;
      up.onclick = () => { ordering = L.moveLine(ordering, i, -1); paint(); };
      down.onclick = () => { ordering = L.moveLine(ordering, i, 1); paint(); };
      row.append(up, down);
      return row;
    });
  };

  const orderActions = () => {
    const actions = el('div', 'revise-actions');
    const cancel = el('button', 'quiet-button', '取消');
    const done = el('button', 'primary-button small', '完成');
    cancel.onclick = () => { ordering = null; paint(); };
    done.onclick = () => {
      const sheet = readSheet(jobId, version);
      const entry = L.orderEntry(sentences, ordering);
      if (entry && !L.canAddToSheet(sheet, entry)) return toast('修改單一次最多 30 項，先送出這些再調');
      // 調回原本的順序：拿掉修改單裡的順序。
      saveSheet(jobId, version, entry ? L.putSheet(sheet, entry) : sheet.filter((e) => !L.isOrder(e)));
      ordering = null;
      paintSheet(jobId, version, sentences);
      if (entry) toast('已記進修改單');
    };
    actions.append(cancel, done);
    return actions;
  };

  const paint = () => {
    const sheet = readSheet(jobId, version);
    const parts = [head()];
    if (open && !ordering && dropped.length) parts.push(tabs());
    if (open && !ordering && tab === 'dropped') parts.push(el('p', 'muted small pad-x', '手機聽不到原音，照毛片順序列出。加回後新的一版會放回原本的位置。'), ...dropped.map((line) => droppedRow(line, sheet)));
    else if (open && ordering) parts.push(el('p', 'muted small pad-x', '用 ↑ ↓ 排好，按「完成」記進修改單。移除的句子送出時會拿掉。'), ...orderRows(sheet), orderActions());
    else if (open) parts.push(...sentences.map((line, i) => lineRow(line, i, sheet)));
    box.replaceChildren(...parts);
  };

  const startOrdering = () => {
    open = true;
    tab = 'kept';
    ordering = L.orderOf(readSheet(jobId, version), sentences).slice();
    paint();
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // 修改單變了（記下來、刪掉）時 paintSheet 叫這個更新「已記」；調整順序中不打斷。
  box.repaint = () => { if (!ordering) paint(); };
  box.startOrdering = startOrdering;
  box.showDropped = () => { open = true; ordering = null; tab = 'dropped'; paint(); box.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  paint();
  return box;
}
