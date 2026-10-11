// 手機網頁的純邏輯（不碰畫面、不連網路），瀏覽器與 node 測試共用。
(function (root) {
  'use strict';
  const OFFLINE_MINUTES = 15;
  const SAFE_ID = /^[\w-]+$/;

  const statusLabel = (job) => {
    if (job.status === 'queued') return `排隊第 ${job.position}`;
    if (job.status === 'running') return job.progress ? `剪輯中・${job.progress}` : '剪輯中';
    if (job.status === 'done') return '剪好了';
    if (job.status === 'stopped') return { limit: '額度用完，稍後會繼續', auth: '電腦上的剪輯帳號要重新登入' }[job.reason] || '已中止';
    return '沒剪成';
  };

  const minutesSince = (mac, nowMs) => {
    const seen = Date.parse(mac && mac.lastSeen);
    return Number.isNaN(seen) ? Infinity : (nowMs - seen) / 60000;
  };

  const isOffline = (mac, nowMs) => minutesSince(mac, nowMs) > OFFLINE_MINUTES;

  const offlineText = (mac, nowMs) => {
    const minutes = minutesSince(mac, nowMs);
    if (!Number.isFinite(minutes)) return '電腦離線';
    const ago = minutes < 60 ? `${Math.round(minutes)} 分鐘前` : minutes < 1440 ? `${Math.round(minutes / 60)} 小時前` : `${Math.floor(minutes / 1440)} 天前`;
    return `電腦離線，最後上線 ${ago}`;
  };

  // 只有 401 是登入過期。403 是權限不足（共用成檢視者）或 Drive 限流，重新登入會無限循環。
  const needsSignIn = (status) => status === 401;
  // 清單上每一支的更新時間。
  const ago = (iso, nowMs) => {
    const at = Date.parse(iso);
    if (Number.isNaN(at)) return '';
    const minutes = (nowMs - at) / 60000;
    if (minutes < 1) return '剛剛';
    if (minutes < 60) return `${Math.round(minutes)} 分鐘前`;
    if (minutes < 1440) return `${Math.round(minutes / 60)} 小時前`;
    return `${Math.floor(minutes / 1440)} 天前`;
  };
  // 選擇電腦的清單：最近上線的排前面，每一台寫最後上線時間（同名的電腦也分得出來）。
  const computerRows = (computers, nowMs) => [...(computers || [])]
    .sort((a, b) => (Date.parse(b.lastSeen) || 0) - (Date.parse(a.lastSeen) || 0))
    .map((c) => { const when = ago(c.lastSeen, nowMs); return { folderId: c.folderId, name: c.name, seen: when ? `${when}上線` : '' }; });
  const forbiddenText = () => '沒有權限：請 Ekko 電腦的主人把資料夾共用給你時選「編輯者」，或稍後再試';
  // 推播公鑰：每台電腦一把，寫在它的 mac.json；舊版電腦沒有時用設定檔的。
  const pushKey = (mac, config) => (mac && mac.pushKey) || (config && config.vapidKey) || '';

  const deviceRecord = (previous, changes, nowMs) => {
    const next = { follow: [], ...(previous || {}), ...changes, updatedAt: nowMs };
    next.follow = [...new Set((next.follow || []).filter((id) => typeof id === 'string' && SAFE_ID.test(id)))];
    return next;
  };

  // expectedState：這一頁發出登入時記下的亂數。不一樣就不收，免得被人用連結登進別人的雲端硬碟。
  const readReturnedToken = (hash, nowMs, expectedState) => {
    const params = new URLSearchParams((hash || '').replace(/^#/, ''));
    if (!params.get('error') && !params.get('access_token')) return null;
    if (!expectedState || params.get('state') !== expectedState) return { error: 'state' };
    if (params.get('error')) return { error: params.get('error') };
    return { token: params.get('access_token'), expiresAt: nowMs + Number(params.get('expires_in') || 3600) * 1000 };
  };

  const jobFromHash = (hash) => {
    const id = new URLSearchParams((hash || '').replace(/^#/, '')).get('job');
    return id && SAFE_ID.test(id) ? id : null;
  };

  // Google 雲端硬碟的資料夾編號：英數、底線、減號，20 個字以上。
  const FOLDER_ID = /^[\w-]{20,}$/;
  const readPair = (search) => {
    const params = new URLSearchParams(search || '');
    const folder = params.get('pair');
    return folder && FOLDER_ID.test(folder) ? { folder, mac: params.get('mac') || '' } : null;
  };
  // 手動貼上的連結碼：整個連結或只有編號。
  const parsePairCode = (input) => {
    const text = String(input || '').trim();
    if (FOLDER_ID.test(text)) return { folder: text, mac: '' };
    const at = text.indexOf('?');
    return at >= 0 ? readPair(text.slice(at)) : null;
  };

  const AUTO_SIGN_IN_GAP = 60000;
  const shouldAutoSignIn = ({ account, lastAuto }, nowMs) => !!account && nowMs - (lastAuto || 0) > AUTO_SIGN_IN_GAP;

  const isIOS = (ua) => /iPhone|iPad|iPod/.test(ua || '');
  const needsHomeScreen = (ua, standalone) => isIOS(ua) && standalone === false;

  const defaultDeviceName = (person, ua) => {
    const device = isIOS(ua) ? (/iPad/.test(ua) ? 'iPad' : 'iPhone') : /Android/.test(ua || '') ? 'Android 手機' : '手機';
    return person ? `${person}的 ${device}` : `我的 ${device}`;
  };

  // 版本清單：新的在上。不是接著上一版改的（岔出去的）才寫「從 vN 改」。舊格式只有檔名，當成有小檔。
  const versionLines = (job) => {
    const versions = (job && job.versions) || [];
    return versions.map((v, i) => {
      const previous = i > 0 ? versions[i - 1].id : null;
      const branched = v.parent != null && v.parent !== previous;
      const summary = v.summary || '';
      return { id: v.id, ready: v.ready !== false, lines: v.lines === true, text: branched ? `從 v${v.parent} 改：${summary}` : summary };
    }).reverse();
  };
  const pendingLines = (pending) => (pending || []).map((p, i) =>
    p.building ? `剪輯中：${p.summary}` : `排隊中：${p.summary}${i >= 2 ? `（前面還有 ${i} 筆）` : ''}`);

  // 電腦寫下的時間（手機的當地時間），例如 14:32:05。
  const clockText = (iso) => {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    const two = (n) => String(n).padStart(2, '0');
    return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
  };
  // 這筆修改在 index 裡的樣子（電腦有帶修改編號才認得出來）；認不出來回 undefined，已經不在隊伍裡回 null。
  // index 不比回覆新（電腦收件後還沒重寫 index，或同一秒分不出先後）就不算，免得把剛排進去的說成剪完了。
  // indexAt 是電腦在主執行緒拍下任務狀態的時間，和收件同一條執行緒，晚一秒以上就一定包含這筆。
  const mine = (reply, job, indexAt) => {
    if (!(Date.parse(indexAt) > Date.parse(reply.at))) return undefined;
    const pending = job && Array.isArray(job.pending) ? job.pending : null;
    if (!pending || reply.id == null || (pending.length && !pending.some((p) => p.id != null))) return undefined;
    const at = pending.findIndex((p) => p.id === reply.id);
    return at < 0 ? null : { at, building: !!pending[at].building };
  };
  // 送出修改後的狀態：沒回覆＝還在雲端等電腦接手；回覆的時間就是電腦收到的那一刻。
  // 有 job（index 最新的樣子、indexAt 是 index 寫出的時間）就用它，沒有才用電腦收件當下的情況。
  const sendStatus = (reply, job, indexAt) => {
    if (!reply) return '已送到雲端，等電腦接手…';
    if (reply.status === 'rejected') return `沒送成：${reply.reason || '請再送一次'}`;
    const clock = clockText(reply.at);
    const got = clock ? `電腦 ${clock} 收到` : '電腦收到';
    if (reply.status === 'held') return `${got}了，但這支在電腦上被中止，要在電腦按「繼續」才會開始`;
    const found = mine(reply, job, indexAt);
    if (found === null) return `${got}・這筆已經剪完`;
    if (found) {
      if (found.building) return `${got}，開始剪了`;
      if (found.at > 0) return `${got}・這支前面還有 ${found.at} 筆修改`;
      if (job.status === 'queued') return `${got}・等電腦先剪別支影片（排隊第 ${job.position}）`;
      return `${got}・排隊中`;
    }
    if (reply.started) return `${got}，開始剪了`;
    if (reply.position > 0) return `${got}・這支前面還有 ${reply.position} 筆修改`;
    if (reply.paused) return `${got}・電腦的排隊暫停中，恢復後才會開始`;
    if (reply.others > 0) return `${got}・前面還有 ${reply.others} 支影片，輪到就開始`;
    return `${got}・排隊中`;
  };
  // 送出後要不要常常看：還沒回覆、或收到了但還沒開始剪。
  const waitingForComputer = (reply, job, indexAt) => {
    if (!reply) return true;
    if (reply.status !== 'queued') return false;
    const found = mine(reply, job, indexAt);
    if (found === undefined) return !reply.started;
    return !!found && !found.building;
  };
  const inboxName = (device, nowMs) => `${device}-${nowMs}.json`;
  // ---- 自己的播放器 ----
  // 手指在進度條上的位置換成 0～1。
  const scrubFraction = (x, left, width) => (width > 0 ? Math.min(1, Math.max(0, (x - left) / width)) : 0);
  const percent = (seconds, duration) => Math.min(100, Math.max(0, Math.round((seconds / duration) * 1000) / 10));
  // 修改單每一筆在進度條上的位置（百分比）；還不知道片長就不畫。
  // draft：卡片上正在改、還沒記下來的那一句：有選改法就換成空心點（pending），全部取消就先拿掉那句的點。
  const sheetMarks = (sheet, duration, draft) => {
    if (!(duration > 0)) return [];
    const marks = (sheet || []).filter((e) => !(draft && sameLine(e, draft))).map((e) => ({ text: e.text, at: e.at, left: percent(e.at, duration) }));
    if (draft && (draft.cut || draft.broll || draft.note)) marks.push({ text: draft.text, at: draft.at, left: percent(draft.at, duration), pending: true });
    return marks.sort((a, b) => a.at - b.at);
  };
  // 正在改的那一句在進度條上的範圍（百分比）。
  const lineBand = (line, duration) => {
    if (!line || !(duration > 0)) return null;
    const left = percent(line.at, duration);
    return { left, width: Math.round((percent(Math.min(line.end, duration), duration) - left) * 10) / 10 };
  };
  // 卡片往下滑超過自己高度的四分之一就收起。
  const dragClose = (dy, height) => height > 0 && dy > height / 4;
  const timeText = (current, duration) => (Number.isFinite(duration) && duration > 0 ? `${clock(current)} / ${clock(duration)}` : clock(current));
  // 鍵盤跳出來時卡片要墊多高：畫面高度（innerHeight）減掉看得到的那一塊（visualViewport 的高度加上被往上推的距離）。
  const keyboardInset = (innerHeight, viewHeight, viewTop) => Math.max(0, Math.round(innerHeight - viewHeight - viewTop));
  // 自動換新版：網站上的版本（latest）和正在跑的（mine）不同才重新載入；讀不到版本檔不動；同一個新版本只試一次（tried）。
  const shouldReload = (mine, latest, tried) => !!latest && latest !== mine && tried !== latest;

  // ---- 修改頁：邊看邊記 ----
  const clock = (seconds) => {
    const whole = Math.max(0, Math.floor(seconds || 0));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  };
  // 按下「這裡要改」那一刻對到哪一句：最後一句開頭不晚於那一刻的；在第一句之前就是第一句。
  const lineAt = (lines, seconds) => {
    if (!lines || !lines.length) return -1;
    let found = 0;
    lines.forEach((line, i) => { if (line.at <= seconds + 0.05) found = i; });
    return found;
  };
  const brollNow = (line) => (line && line.broll === 'footage' ? '有畫面' : line && line.broll === 'animation' ? '有動畫' : '沒有');
  const sameLine = (a, b) => a.text === b.text && Math.abs(a.at - b.at) < 0.05;
  // 整理成一筆：移除和換畫面只留一個（移除優先）；移除時不留說明（卡片上說明欄也停用）。三樣都沒有回傳 null。
  const tidy = (entry) => {
    const next = { text: entry.text, at: entry.at };
    if (entry.cut) next.cut = true;
    else if (entry.broll) { next.broll = entry.broll; if (entry.current) next.current = entry.current; }
    if (entry.note && !entry.cut) next.note = entry.note;
    return next.cut || next.broll || next.note ? next : null;
  };
  // 記進修改單：同一句合成一筆。replace（卡片「記下來」）整句換成這次的選擇；否則移除／換畫面以這次為準、說明接在後面。
  const putSheet = (sheet, entry) => {
    const rest = (sheet || []).filter((e) => !sameLine(e, entry));
    const old = (sheet || []).find((e) => sameLine(e, entry));
    let merged = { ...entry };
    if (old && !entry.replace) {
      const choice = entry.cut ? { cut: true } : entry.broll ? { broll: entry.broll, current: entry.current } : old.cut ? { cut: true } : { broll: old.broll, current: old.current };
      merged = { text: old.text, at: old.at, ...choice, note: [old.note, entry.note].filter(Boolean).join('；') };
    } else if (old) {
      merged = { ...entry, text: old.text, at: old.at };
    }
    const next = tidy(merged);
    return (next ? [...rest, next] : rest).sort((a, b) => a.at - b.at);
  };
  const dropSheet = (sheet, entry) => (sheet || []).filter((e) => !sameLine(e, entry));
  // 一次最多 30 項（電腦也這樣擋）；已經記過的那一句可以改。
  const SHEET_MAX = 30;
  const canAddToSheet = (sheet, entry) => (sheet || []).length < SHEET_MAX || (sheet || []).some((e) => sameLine(e, entry));
  // 收件檔超過 64KB 電腦會略過、不回覆：留一點空間，60KB 以上就不送。
  const tooBigToSend = (body) => new TextEncoder().encode(JSON.stringify(body)).length > 60 * 1024;
  // 收件格式：移除只帶文字與秒數（說明不送，和電腦版一樣）。
  const sheetItems = (sheet) => (sheet || []).map((e) => {
    if (e.cut) return { kind: 'cut', text: e.text, at: e.at };
    const item = { kind: 'line', text: e.text, at: e.at };
    if (e.broll) item.broll = e.broll;
    if (e.broll && e.current) item.current = e.current;
    if (e.note) item.note = e.note;
    return item;
  });
  const BROLL_WORD = { footage: '畫面', animation: '動畫' };
  const sheetLine = (e) => {
    const quote = e.text.length > 8 ? `${e.text.slice(0, 7)}…` : e.text;
    const what = e.cut ? '移除這句'
      : e.broll === 'remove' ? '不要畫面'
      : e.broll && e.broll === e.current ? `重做${BROLL_WORD[e.broll]}`
      : e.broll ? `換成${BROLL_WORD[e.broll]}` : '';
    const tail = e.cut ? what : [what, e.note].filter(Boolean).join('：');
    return `${clock(e.at)}「${quote}」${tail}`;
  };
  // 沒送成：放回送出的那份；現在的修改單已經記了同一句就以現在的為準。
  const restoreSheet = (current, sent) => {
    const now = current || [];
    const back = (sent || []).filter((e) => !now.some((c) => sameLine(c, e)));
    return [...now, ...back].sort((a, b) => a.at - b.at);
  };

  const api = { lineBand, dragClose, scrubFraction, sheetMarks, timeText, keyboardInset, computerRows, shouldReload, lineAt, putSheet, dropSheet, canAddToSheet, tooBigToSend, sheetItems, sheetLine, restoreSheet, brollNow, clock, versionLines, pendingLines, sendStatus, clockText, waitingForComputer, inboxName, readPair, parsePairCode, shouldAutoSignIn, needsHomeScreen, defaultDeviceName, statusLabel, ago, isOffline, offlineText, needsSignIn, forbiddenText, pushKey, deviceRecord, readReturnedToken, jobFromHash };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EkkoLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
