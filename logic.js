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

  // 版本清單裡排隊中的修改：mine＝這支手機送的（只有自己的能取消、拿回來重改；剪輯中那筆不行）。
  const pendingRows = (pending, device) => (pending || []).map((p, i) => ({
    id: p.id, building: !!p.building, mine: !p.building && !!device && p.device === device,
    text: p.building ? `剪輯中：${p.summary}` : `排隊中：${p.summary}${i >= 2 ? `（前面還有 ${i} 筆）` : ''}`,
  }));
  // 看片頁狀態列上能按的：剪輯中「中止」；剪輯中或排隊中「補充」；中止後排隊停住「繼續」；沒剪成（不含額度、登入）「重試」。
  // 電腦整台暫停排隊只顯示文字（那是電腦主人的決定）。
  const jobActions = (job, macPaused) => {
    const running = job.status === 'running', queued = job.status === 'queued';
    const ended = job.status === 'failed' || (job.status === 'stopped' && (job.reason || 'stopped') === 'stopped');
    return { stop: running, late: running || queued, resume: !!job.held, retry: ended && !job.held && !!job.canContinue, pausedNote: !!macPaused && queued };
  };
  const commandBody = (action, jobId, extra) => ({ action, job: jobId, ...(extra || {}) });
  const COMMAND_DONE = { unqueue: '已取消這筆修改', stop: '電腦已中止', resume: '已繼續，排隊的修改開始剪', retry: '已重新開始剪', late: '已記下補充，這一輪剪完會接著改', requeue: '已重新排進修改', remix: '已做成新的一版', export: '原畫質已放上雲端，同步完就能打開' };
  const commandStatus = (reply) => {
    if (!reply) return '已送到電腦，等電腦接手…';
    if (reply.status === 'rejected') return `沒做成：${reply.reason || '請再試一次'}`;
    if (reply.action === 'remix' && reply.version != null) return `已做成 v${reply.version}`;
    return COMMAND_DONE[reply.action] || '電腦做好了';
  };
  // 字幕檔：和電腦 EkkoSubtitleSRT 同樣格式（只放有字、結束晚於開始的句子，照時間排）。
  const srtClock = (seconds) => {
    const total = Math.round(Math.max(0, seconds) * 1000);
    const two = (n) => String(n).padStart(2, '0');
    return `${two(Math.floor(total / 3600000))}:${two(Math.floor(total / 60000) % 60)}:${two(Math.floor(total / 1000) % 60)},${String(total % 1000).padStart(3, '0')}`;
  };
  const subtitleSRT = (lines) => (lines || [])
    .filter((l) => String(l.text || '').trim() && l.end > l.at)
    .sort((a, b) => a.at - b.at)
    .map((l, i) => `${i + 1}\n${srtClock(l.at)} --> ${srtClock(l.end)}\n${String(l.text).trim()}\n\n`).join('');
  const gainText = (db) => (db > 0 ? `+${db} dB` : `${db} dB`);

  // ---- 卡片寫清楚改哪裡、點字選範圍 ----
  // 一句切成可以點的字：英文一個字一格（數字連在一起）、中文一個字一格；空白與標點也留著（接回來一字不差），但不能點。
  const wordTokens = (text) => (String(text || '').match(/[A-Za-z0-9'’]+|[\u3400-\u9fff\uf900-\ufaff]|\s+|[^\sA-Za-z0-9'’\u3400-\u9fff\uf900-\ufaff]+/g) || [])
    .map((t) => ({ text: t, word: /[A-Za-z0-9\u3400-\u9fff\uf900-\ufaff]/.test(t) }));
  const partText = (tokens, a, b) => tokens.slice(Math.min(a, b), Math.max(a, b) + 1).map((t) => t.text).join('').trim();
  const rangeLabel = (line) => `${clock(line.at)}–${clock(line.end)}`;
  // 卡片上引用相鄰那句：英文取前 4 個字、中文取前 10 個字。
  const quoteShort = (text) => {
    if (text.length <= 12) return text;
    return /\s/.test(text) ? `${text.split(/\s+/).slice(0, 4).join(' ')}…` : `${text.slice(0, 10)}…`;
  };
  // 改的範圍：連到上一句從上一句開頭、連到下一句到下一句結尾。
  const changeSpan = (lines, i, c) => ({ at: (c.prev && lines[i - 1] ? lines[i - 1] : lines[i]).at, end: (c.next && lines[i + 1] ? lines[i + 1] : lines[i]).end });
  // 卡片上的一行說明：這次會改哪一段、改成什麼。c = { cut, broll, prev, next, part }。
  const changeText = (lines, i, c) => {
    const line = lines[i];
    if (!line) return '';
    if (c.cut) return `${rangeLabel(line)} 整句拿掉`;
    if (c.broll === 'remove') return `${rangeLabel(line)} 拿掉畫面，回到主畫面`;
    if (c.broll !== 'footage' && c.broll !== 'animation') return '';
    const kind = BROLL_WORD[c.broll];
    const redo = line.broll === c.broll;
    const action = redo ? `重做${kind}（換掉現在的${kind}）` : line.broll ? `換成新的${kind}` : `加上新的${kind}`;
    const prev = c.prev && lines[i - 1], next = c.next && lines[i + 1];
    // 只做幾個字：沒連上下句就只蓋那幾個字；連了就從那幾個字開始（或結束），和電腦版一樣。
    if (c.part && next && !prev) return `${action}：從這句的「${c.part}」開始，一路連到下一句「${quoteShort(next.text)}」`;
    if (c.part && prev && !next) return `${action}：從上一句「${quoteShort(prev.text)}」開始，連到這句的「${c.part}」為止`;
    if (c.part && !prev && !next) return `只在「${c.part}」這幾個字${action}`;
    const span = changeSpan(lines, i, c);
    const label = `${clock(span.at)}–${clock(span.end)}`;
    if (!prev && !next) return redo ? `${label} 這句的${kind}重做（換掉現在的${kind}）` : `${label} ${action}`;
    const link = prev && next ? `從上一句「${quoteShort(prev.text)}」連到下一句「${quoteShort(next.text)}」`
      : prev ? `從上一句「${quoteShort(prev.text)}」開始` : `一路連到下一句「${quoteShort(next.text)}」`;
    return `${label} ${action}，${link}`;
  };

  // ---- 附件 ----
  const ATTACH_EXT = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'mov', 'mp4', 'm4v', 'm4a', 'mp3', 'wav', 'aac'];
  const MB = 1024 * 1024;
  const extOf = (name) => { const m = String(name || '').match(/\.([A-Za-z0-9]{2,4})$/); return m ? m[1].toLowerCase() : ''; };
  // 再加一個檔行不行：副檔名、單檔 500MB、最多 10 個、合計 2GB（電腦也這樣擋）。
  const attachProblem = (list, file) => {
    if (!(file.size > 0)) return '這個檔是空的';
    if (!ATTACH_EXT.includes(extOf(file.name))) return '只能附照片、影片、錄音（jpg、png、heic、mov、mp4、m4a…）';
    if (file.size > 500 * MB) return '單一檔案最多 500MB';
    if ((list || []).length >= 10) return '一次最多附 10 個檔案';
    if ((list || []).reduce((sum, f) => sum + f.size, 0) + file.size > 2048 * MB) return '一次最多 2GB';
    return null;
  };
  // 上傳到雲端的檔名：序號-安全字元.副檔名（電腦只認這個格式）。
  const safeUploadName = (i, name) => {
    const ext = extOf(name);
    const base = String(name).slice(0, String(name).length - ext.length - 1).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
    return `${i}-${base}.${ext}`;
  };
  // 整張單（逐句＋整支）合起來：最多 10 個、2GB（電腦也這樣擋，先擋免得白傳）。
  const planProblem = (plan) => {
    const files = (plan && plan.files) || [];
    if (files.length > 10) return '整張修改單最多附 10 個檔案，請拿掉幾個';
    if (files.reduce((sum, f) => sum + f.size, 0) > 2048 * MB) return '整張修改單的附件最多 2GB，請拿掉幾個';
    return null;
  };
  // 拿掉修改單的附件（留著「拿回來重改」用：附件電腦收下後就從手機刪了）；只剩附件的那筆整筆拿掉。
  const withoutFiles = (sheet) => {
    let dropped = false;
    const kept = (sheet || []).map((e) => { if (!e.files) return e; dropped = true; const { files, ...rest } = e; return rest; })
      .filter((e) => isOrder(e) || isRestore(e) || e.cut || e.broll || e.note);
    return { sheet: kept, dropped };
  };
  const sizeText = (bytes) => (bytes >= MB ? `${Math.round((bytes / MB) * 10) / 10} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
  // 送出前排好要傳的檔：修改單逐句的附件在前、整支的在後，依序編號。
  const uploadPlan = (sheet, overall) => {
    const files = [];
    const names = {};
    const add = (f) => { if (names[f.fid]) return; names[f.fid] = safeUploadName(files.length + 1, f.name); files.push({ fid: f.fid, name: names[f.fid], size: f.size, original: f.name }); };
    (sheet || []).forEach((e) => { if (!e.cut && e.files) e.files.forEach(add); });
    (overall || []).forEach(add);
    return { files, items: sheetItems(sheet, names), overall: (overall || []).map((f) => ({ name: names[f.fid], size: f.size })) };
  };

  // 引擎回報先顯示前 3 行（或 120 字），其餘點「更多」。
  const reportPreview = (text, lines = 3) => {
    const all = String(text || '');
    const rows = all.split('\n');
    let head = rows.slice(0, lines).join('\n');
    if (head.length > 120) head = head.slice(0, 120);
    const more = head.length < all.length;
    return { text: more ? `${head}…` : head, more };
  };

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
  // downloading：電腦回了「附件還在同步」，還不算收下。
  const sendStatus = (reply, job, indexAt, downloading) => {
    if (!reply) return downloading ? '已送到雲端，電腦正在下載附件…' : '已送到雲端，等電腦接手…';
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
    const marks = (sheet || []).filter((e) => !isOrder(e) && !isRestore(e) && !(draft && sameLine(e, draft))).map((e) => ({ text: e.text, at: e.at, left: percent(e.at, duration) }));
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
  // 修改單裡「調整順序」那一筆：{ text: '', at: -1, order: [{text, at}] }，排在最前面、不畫在進度條上，一張單只有一筆。
  const isOrder = (e) => !!e && Array.isArray(e.order);
  // 修改單裡「加回」的一筆：{ restore: {id, text, src, start}, text, at: 1e6 + id }，排在逐句後面、不畫在進度條上。
  const isRestore = (e) => !!e && !!e.restore;
  const restoreEntry = (d) => ({ restore: { id: d.id, text: d.text, src: d.src, start: d.start }, text: d.text, at: 1e6 + d.id });
  const sameLine = (a, b) => {
    if (isOrder(a) || isOrder(b)) return isOrder(a) && isOrder(b);
    if (isRestore(a) || isRestore(b)) return isRestore(a) && isRestore(b) && a.restore.id === b.restore.id;
    return a.text === b.text && Math.abs(a.at - b.at) < 0.05;
  };
  const droppedLabel = (d) => `毛片 ${d.src + 1}・${clock(d.start)}`;
  const bare = (line) => ({ text: line.text, at: line.at });
  // 第 i 句往上（-1）或往下（+1）移；超出頭尾不動。
  const moveLine = (order, i, step) => {
    const to = i + step;
    if (i < 0 || i >= order.length || to < 0 || to >= order.length) return order.slice();
    const next = order.slice();
    [next[i], next[to]] = [next[to], next[i]];
    return next;
  };
  // 調好的順序記成一筆；和原本一樣就不記（回傳 null）。
  const orderEntry = (lines, order) => (order.length === lines.length && order.every((l, i) => sameLine(l, lines[i])) ? null : { text: '', at: -1, order: order.map(bare) });
  const orderOf = (sheet, lines) => { const found = (sheet || []).find(isOrder); return found ? found.order : (lines || []).map(bare); };
  const neighborOf = (lines, i, side) => { const line = (lines || [])[side === 'prev' ? i - 1 : i + 1]; return line ? bare(line) : null; };
  // 這版改過的句子：上一版沒有這段字，或畫面不一樣。上一版沒有逐句清單就不標。
  const changedLines = (prev, lines) => {
    const found = new Set();
    if (!prev || !prev.length) return found;
    (lines || []).forEach((line, i) => {
      const old = prev.find((p) => p.text === line.text);
      if (!old || (old.broll || '') !== (line.broll || '')) found.add(i);
    });
    return found;
  };
  // 被拒時整支意見放回文字框：已經又打了新字就接在後面；已經在裡面就不重複。
  const draftBack = (current, sent) => (!sent || (current || '').includes(sent) ? current || '' : [current, sent].filter(Boolean).join('\n'));
  // 整理成一筆：移除和換畫面只留一個（移除優先）；移除時不留說明（卡片上說明欄也停用）。三樣都沒有回傳 null。
  // 畫面來源只跟「畫面」；連到上一句／下一句只跟畫面、動畫（不要畫面時不連）。
  const tidy = (entry) => {
    if (isRestore(entry)) return restoreEntry(entry.restore);
    if (isOrder(entry)) return entry.order.length > 1 ? { text: '', at: -1, order: entry.order.map(bare) } : null;
    const next = { text: entry.text, at: entry.at };
    if (entry.cut) next.cut = true;
    else if (entry.broll) {
      next.broll = entry.broll;
      if (entry.current) next.current = entry.current;
      if (entry.broll === 'footage' && (entry.source === 'mine' || entry.source === 'stock')) next.source = entry.source;
      if (entry.broll !== 'remove') { if (entry.prev) next.prev = bare(entry.prev); if (entry.next) next.next = bare(entry.next); }
    }
    if (entry.note && !entry.cut) next.note = entry.note;
    // 只做這幾個字（part）：跟著畫面、動畫或說明；選到整句等於沒選；移除這句、不要畫面不帶。
    const part = typeof entry.part === 'string' ? entry.part.trim() : '';
    if (part && part !== entry.text && !entry.cut && entry.broll !== 'remove' && (next.broll || next.note)) next.part = part;
    // 附件（第 4 批）：只附檔也算一筆；移除這句不帶附件。
    if (!entry.cut && entry.files && entry.files.length) next.files = entry.files;
    return next.cut || next.broll || next.note || next.files ? next : null;
  };
  // 記進修改單：同一句合成一筆。replace（卡片「記下來」）整句換成這次的選擇；否則移除／換畫面以這次為準、說明接在後面。
  const putSheet = (sheet, entry) => {
    if (isOrder(entry)) {
      const others = (sheet || []).filter((e) => !isOrder(e));
      const order = tidy(entry);
      return order ? [order, ...others] : others;
    }
    if (isRestore(entry)) return [...(sheet || []).filter((e) => !sameLine(e, entry)), tidy(entry)].sort((a, b) => a.at - b.at);
    const rest = (sheet || []).filter((e) => !sameLine(e, entry));
    const old = (sheet || []).find((e) => sameLine(e, entry));
    let merged = { ...entry };
    if (old && !entry.replace) {
      const pick = (e) => ({ broll: e.broll, current: e.current, source: e.source, prev: e.prev, next: e.next, part: e.part });
      const choice = entry.cut ? { cut: true } : entry.broll ? pick(entry) : old.cut ? { cut: true } : pick(old);
      merged = { text: old.text, at: old.at, ...choice, note: [old.note, entry.note].filter(Boolean).join('；'), files: [...(old.files || []), ...(entry.files || [])] };
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
  // 順序拿掉同一張單移除的句子，剩不到兩句就不送順序。
  // names：附件 fid → 上傳時的檔名（uploadPlan 給的）；沒給就不帶附件。
  const sheetItems = (sheet, names) => {
    const cuts = (sheet || []).filter((e) => e.cut);
    return (sheet || []).flatMap((e) => {
      if (isOrder(e)) {
        const lines = e.order.filter((l) => !cuts.some((c) => sameLine(c, l))).map(bare);
        return lines.length > 1 ? [{ kind: 'order', lines }] : [];
      }
      if (isRestore(e)) return [{ kind: 'restore', id: e.restore.id, text: e.restore.text }];
      if (e.cut) return [{ kind: 'cut', text: e.text, at: e.at }];
      const item = { kind: 'line', text: e.text, at: e.at };
      if (e.broll) item.broll = e.broll;
      if (e.broll && e.current) item.current = e.current;
      if (e.source) item.source = e.source;
      // 連到的那一句在同一張單被移除了就不連。
      const kept = (ref) => ref && !cuts.some((c) => sameLine(c, ref));
      if (kept(e.prev)) item.prev = bare(e.prev);
      if (kept(e.next)) item.next = bare(e.next);
      if (e.part) item.part = { text: e.part };
      if (e.note) item.note = e.note;
      if (names && e.files && e.files.length) item.files = e.files.map((f) => ({ name: names[f.fid], size: f.size }));
      return [item];
    });
  };
  const BROLL_WORD = { footage: '畫面', animation: '動畫' };
  const SOURCE_WORD = { mine: '我的素材', stock: '圖庫' };
  const sheetLine = (e) => {
    if (isOrder(e)) return `調整順序（${e.order.length} 句）`;
    if (isRestore(e)) return `加回「${e.text.length > 10 ? `${e.text.slice(0, 9)}…` : e.text}」`;
    const quote = e.text.length > 8 ? `${e.text.slice(0, 7)}…` : e.text;
    const what = e.cut ? '移除這句'
      : e.broll === 'remove' ? '不要畫面'
      : e.broll && e.broll === e.current ? `重做${BROLL_WORD[e.broll]}`
      : e.broll ? `換成${BROLL_WORD[e.broll]}` : '';
    const extra = (e.source ? `（${SOURCE_WORD[e.source]}）` : '') + (e.prev ? '・連到上一句' : '') + (e.next ? '・連到下一句' : '') + (e.part ? `・只做「${e.part}」` : '');
    const attached = !e.cut && e.files && e.files.length ? `${what + extra ? '・' : ''}附 ${e.files.length} 個檔` : '';
    const tail = e.cut ? what : [what + extra + attached, e.note].filter(Boolean).join('：');
    return `${clock(e.at)}「${quote}」${tail}`;
  };
  // 沒送成：放回送出的那份；現在的修改單已經記了同一句就以現在的為準。
  const restoreSheet = (current, sent) => {
    const now = current || [];
    const back = (sent || []).filter((e) => !now.some((c) => sameLine(c, e)));
    return [...now, ...back].sort((a, b) => a.at - b.at);
  };

  const api = { wordTokens, partText, rangeLabel, changeSpan, changeText, planProblem, withoutFiles, attachProblem, safeUploadName, sizeText, uploadPlan, isRestore, restoreEntry, droppedLabel, subtitleSRT, gainText, pendingRows, jobActions, commandBody, commandStatus, reportPreview, isOrder, moveLine, orderEntry, orderOf, neighborOf, changedLines, draftBack, sameLine, lineBand, dragClose, scrubFraction, sheetMarks, timeText, keyboardInset, computerRows, shouldReload, lineAt, putSheet, dropSheet, canAddToSheet, tooBigToSend, sheetItems, sheetLine, restoreSheet, brollNow, clock, versionLines, pendingLines, sendStatus, clockText, waitingForComputer, inboxName, readPair, parsePairCode, shouldAutoSignIn, needsHomeScreen, defaultDeviceName, statusLabel, ago, isOffline, offlineText, needsSignIn, forbiddenText, pushKey, deviceRecord, readReturnedToken, jobFromHash };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EkkoLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
