/*!
 * qrbeam — 接收端解码 Worker
 *
 * 一帧里最多要对 8 个分区跑 jsQR，单帧耗时可达上百毫秒；放在主线程会让取景
 * 画面卡成幻灯片。这里把"裁剪 + 识别"整个搬进 Worker：主线程只做一次
 * drawImage(video) + transferToImageBitmap（零拷贝），因此取景始终顺滑。
 */
/* global QB, importScripts, OffscreenCanvas */

importScripts('lib/jsQR.js', 'lib/scan.js');

var scanner = null;
var canvas = null;
var ctx = null;

function ensureCanvas(w, h) {
  if (!canvas) {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  } else if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function samplerFor(bitmap) {
  return function (x, y, w, h, outW, outH) {
    ensureCanvas(outW, outH);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(bitmap, x, y, w, h, 0, 0, outW, outH);
    return ctx.getImageData(0, 0, outW, outH);
  };
}

self.onmessage = function (e) {
  var msg = e.data;
  if (!msg) return;

  if (msg.type === 'config') {
    scanner = new QB.GridScanner(msg.cols, msg.rows, msg.options || {});
    self.postMessage({ type: 'ready' });
    return;
  }

  if (msg.type !== 'frame') return;
  if (!scanner) {
    if (msg.bitmap && msg.bitmap.close) msg.bitmap.close();
    return;
  }

  var t0 = Date.now();
  var res = null;
  var error = null;
  try {
    res = scanner.align(msg.width, msg.height, samplerFor(msg.bitmap), msg.roi);
  } catch (ex) {
    error = String(ex && ex.message ? ex.message : ex);
  }
  if (msg.bitmap && msg.bitmap.close) msg.bitmap.close();

  var records = res ? res.records : [];
  var slots = [];
  for (var i = 0; i < records.length; i++) slots.push(records[i].slot);

  self.postMessage({
    type: 'result',
    seq: msg.seq,
    records: records,
    hits: slots,
    roi: res ? res.roi : null,
    version: res ? res.version : 0,
    samples: res ? res.samples : 0,
    ms: Date.now() - t0,
    error: error,
  });
};
