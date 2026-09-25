/*!
 * qrbeam — Service Worker
 *
 * 接收端必须运行在 HTTPS 下才能拿到摄像头权限，而"无需网络"是它的立身之本：
 * 这里把整站资源在首次访问时全部缓存下来，之后断网也能照常打开。
 * 传输本身从头到尾不碰网络，这个缓存只是为了"页面本身能打开"。
 */

var CACHE = 'qrbeam-v1';

var ASSETS = [
  './',
  './index.html',
  './send.html',
  './receive.html',
  './app/style.css',
  './app/sender.js',
  './app/receiver.js',
  './app/sender-worker.js',
  './app/receiver-worker.js',
  './app/lib/rand.js',
  './app/lib/base45.js',
  './app/lib/crc16.js',
  './app/lib/qrcap.js',
  './app/lib/fountain.js',
  './app/lib/wire.js',
  './app/lib/stream.js',
  './app/lib/qrcode.js',
  './app/lib/jsQR.js',
  './app/lib/render.js',
  './app/lib/scan.js',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches
      .open(CACHE)
      .then(function (c) {
        return c.addAll(ASSETS);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (k) {
            return k === CACHE ? null : caches.delete(k);
          })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request)
        .then(function (res) {
          if (res && res.status === 200 && res.type === 'basic') {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) {
              c.put(e.request, copy);
            });
          }
          return res;
        })
        .catch(function () {
          return caches.match('./index.html');
        });
    })
  );
});
