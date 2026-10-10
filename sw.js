// 1. 影片請求 ./drive-media/<檔案 id> 轉送到 Google Drive，補上登入標頭。
//    Drive 的跨網域規則不讓網頁讀 Content-Range，所以先查檔案大小、每次取最多 2MB、Content-Range 自己算（第 0 步實測）。
// 2. 收推播就顯示通知（iPhone 規定每則都要顯示），點通知打開那支任務。
const CHUNK = 2 * 1024 * 1024;
const sizes = new Map();
let accessToken = null;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => { if (event.data && event.data.type === 'token') accessToken = event.data.token; });

self.addEventListener('fetch', (event) => {
  const match = new URL(event.request.url).pathname.match(/\/drive-media\/([\w-]+)$/);
  if (match) event.respondWith(proxyDrive(match[1], event.request));
});

async function fileSize(fileId, auth) {
  if (!sizes.has(fileId)) {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=size&supportsAllDrives=true`, { headers: auth });
    if (r.status === 401) { accessToken = null; tellPagesToSignIn(); }
    if (!r.ok) throw Object.assign(new Error(`查不到檔案大小（${r.status}）`), { status: r.status });
    sizes.set(fileId, Number((await r.json()).size));
  }
  return sizes.get(fileId);
}

// iPhone 閒置一會就結束 service worker，記憶體裡的通行證會不見：沒有時向開著的頁面要一次。
async function askPageForToken() {
  for (const client of await self.clients.matchAll({ type: 'window' })) {
    const token = await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => resolve(event.data);
      client.postMessage({ type: 'need-token' }, [channel.port2]);
      setTimeout(() => resolve(null), 2000);
    });
    if (token) return token;
  }
  return null;
}

async function tellPagesToSignIn() {
  for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage({ type: 'signin' });
}

async function proxyDrive(fileId, request) {
  if (!accessToken) accessToken = await askPageForToken();
  if (!accessToken) return new Response('還沒登入', { status: 401 });
  const auth = { Authorization: `Bearer ${accessToken}` };
  try {
    const size = await fileSize(fileId, auth);
    const asked = (request.headers.get('Range') || 'bytes=0-').match(/bytes=(\d*)-(\d*)/) || [];
    const start = Number(asked[1] || 0);
    if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    const end = Math.min(asked[2] ? Number(asked[2]) : start + CHUNK - 1, start + CHUNK - 1, size - 1);
    const upstream = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
      { headers: { ...auth, Range: `bytes=${start}-${end}` } });
    // 通行證過期：清掉，請頁面重新登入。
    if (upstream.status === 401) { accessToken = null; tellPagesToSignIn(); }
    if (!upstream.ok) return new Response(`Drive 回應 ${upstream.status}`, { status: upstream.status });
    const body = await upstream.arrayBuffer();
    return new Response(body, { status: 206, headers: {
      'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
      'Content-Length': String(body.byteLength), 'Content-Range': `bytes ${start}-${start + body.byteLength - 1}/${size}`,
    } });
  } catch (e) {
    return new Response(e.message, { status: e.status || 502 });
  }
}

self.addEventListener('push', (event) => {
  let data = { title: 'Ekko', body: '有一支影片剪好了', url: './' };
  try { data = { ...data, ...event.data.json() }; } catch (_) {}
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, data: { url: data.url } }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(new URL(event.notification.data?.url || './', self.registration.scope).href));
});
