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
      return { id: v.id, ready: v.ready !== false, text: branched ? `從 v${v.parent} 改：${summary}` : summary };
    }).reverse();
  };
  const pendingLines = (pending) => (pending || []).map((p, i) =>
    p.building ? `剪輯中：${p.summary}` : `排隊中：${p.summary}${i >= 2 ? `（前面還有 ${i} 筆）` : ''}`);

  // 送出修改後的狀態（電腦寫的 outbox 回覆）。
  const sendStatus = (reply) => {
    if (!reply) return '已送出，等電腦收到…';
    if (reply.status === 'rejected') return `沒送成：${reply.reason || '請再送一次'}`;
    if (reply.status === 'held') return '電腦收到了，但這支在電腦上被中止，要在電腦按「繼續」才會開始';
    return reply.position > 0 ? `電腦收到了，排隊中・前面還有 ${reply.position} 筆` : '電腦收到了，馬上開始改';
  };
  const inboxName = (device, nowMs) => `${device}-${nowMs}.json`;

  const api = { versionLines, pendingLines, sendStatus, inboxName, readPair, parsePairCode, shouldAutoSignIn, needsHomeScreen, defaultDeviceName, statusLabel, ago, isOffline, offlineText, needsSignIn, forbiddenText, pushKey, deviceRecord, readReturnedToken, jobFromHash };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EkkoLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
