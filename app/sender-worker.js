/*!
 * qrbeam — 发送端渲染 Worker
 *
 * 把"文本 → 二维码位图"这段最耗 CPU 的工作（每个码要做 8 次掩码评估）挪出
 * 主线程，主线程只负责把 ImageBitmap 贴到可见画布上。这样即使每帧要生成 4~6 个
 * 高版本二维码，刷新节奏也不会被渲染卡顿打乱。
 */
/* global QB, importScripts, OffscreenCanvas */

importScripts('lib/qrcode.js', 'lib/render.js');

var canvas = null;

self.onmessage = function (e) {
  var msg = e.data;
  if (!msg || msg.type !== 'render') return;

  var lay = msg.layout;
  try {
    if (!canvas || canvas.width !== lay.width || canvas.height !== lay.height) {
      canvas = new OffscreenCanvas(lay.width, lay.height);
    }
    var bitmap = QB.qrRenderFrameToBitmap(canvas, msg.texts, lay, msg.opts);
    self.postMessage({ type: 'frame', id: msg.id, bitmap: bitmap }, [bitmap]);
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err && err.message ? err.message : err) });
  }
};
