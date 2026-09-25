/*!
 * 一个够用的 canvas 桩，让 app/lib/render.js（浏览器里真正跑的那段渲染代码）
 * 能在 Node 下被测试。只实现 render.js 用到的那几个 API，缩放按
 * imageSmoothingEnabled = false 的最近邻语义来做。
 */

function parseColor(s) {
  if (typeof s !== 'string') return [0, 0, 0];
  var t = s.trim().toLowerCase();
  if (t === '#fff' || t === '#ffffff' || t === 'white') return [255, 255, 255];
  if (t === '#000' || t === '#000000' || t === 'black') return [0, 0, 0];
  var m = /^#([0-9a-f]{6})$/.exec(t);
  if (m) {
    var v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  return [255, 255, 255];
}

export function createCanvas(width, height) {  var canvas = {
    _w: width || 1,
    _h: height || 1,
    data: new Uint8ClampedArray((width || 1) * (height || 1) * 4),
    _ctx: null,
  };

  Object.defineProperty(canvas, 'width', {
    get: function () {
      return canvas._w;
    },
    set: function (v) {
      v = Math.max(1, v | 0);
      canvas._w = v;
      canvas.data = new Uint8ClampedArray(v * canvas._h * 4);
    },
  });
  Object.defineProperty(canvas, 'height', {
    get: function () {
      return canvas._h;
    },
    set: function (v) {
      v = Math.max(1, v | 0);
      canvas._h = v;
      canvas.data = new Uint8ClampedArray(canvas._w * v * 4);
    },
  });

  canvas.getContext = function () {
    if (!canvas._ctx) canvas._ctx = makeCtx(canvas);
    return canvas._ctx;
  };

  return canvas;
}

function makeCtx(canvas) {
  var ctx = {
    canvas: canvas,
    imageSmoothingEnabled: true,
    fillStyle: '#ffffff',
  };

  ctx.createImageData = function (w, h) {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  };

  ctx.fillRect = function (x, y, w, h) {
    var c = parseColor(ctx.fillStyle);
    var x0 = Math.max(0, Math.round(x));
    var y0 = Math.max(0, Math.round(y));
    var x1 = Math.min(canvas._w, Math.round(x + w));
    var y1 = Math.min(canvas._h, Math.round(y + h));
    for (var yy = y0; yy < y1; yy++) {
      for (var xx = x0; xx < x1; xx++) {
        var o = (yy * canvas._w + xx) * 4;
        canvas.data[o] = c[0];
        canvas.data[o + 1] = c[1];
        canvas.data[o + 2] = c[2];
        canvas.data[o + 3] = 255;
      }
    }
  };

  ctx.putImageData = function (img, dx, dy) {
    dx = Math.round(dx);
    dy = Math.round(dy);
    for (var y = 0; y < img.height; y++) {
      var ty = dy + y;
      if (ty < 0 || ty >= canvas._h) continue;
      for (var x = 0; x < img.width; x++) {
        var tx = dx + x;
        if (tx < 0 || tx >= canvas._w) continue;
        var so = (y * img.width + x) * 4;
        var to = (ty * canvas._w + tx) * 4;
        canvas.data[to] = img.data[so];
        canvas.data[to + 1] = img.data[so + 1];
        canvas.data[to + 2] = img.data[so + 2];
        canvas.data[to + 3] = img.data[so + 3];
      }
    }
  };

  // render.js 只用 drawImage(src, dx, dy, dw, dh) 这一种签名
  ctx.drawImage = function (src, dx, dy, dw, dh) {
    var sw = src.width;
    var sh = src.height;
    var sd = src.data || (src.getContext && src.getContext('2d').canvas.data);
    if (!sd) sd = src._data;
    dx = Math.round(dx);
    dy = Math.round(dy);
    dw = Math.round(dw);
    dh = Math.round(dh);
    for (var y = 0; y < dh; y++) {
      var ty = dy + y;
      if (ty < 0 || ty >= canvas._h) continue;
      var sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
      for (var x = 0; x < dw; x++) {
        var tx = dx + x;
        if (tx < 0 || tx >= canvas._w) continue;
        var sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw));
        var so = (sy * sw + sx) * 4;
        var to = (ty * canvas._w + tx) * 4;
        canvas.data[to] = sd[so];
        canvas.data[to + 1] = sd[so + 1];
        canvas.data[to + 2] = sd[so + 2];
        canvas.data[to + 3] = sd[so + 3];
      }
    }
  };

  // ---- 下面这些只是为了记录调用，不做真正的栅格化 --------------------
  // 叠加层（#overlay）只需要"画出框"，测试要验证的正是这些框的几何。

  ctx.calls = { strokeRect: [], fillRect: [], fillText: [] };
  ctx.setLineDash = function (dash) {
    ctx.lineDash = dash || [];
  };
  ctx.setTransform = function () {};
  ctx.save = function () {};
  ctx.restore = function () {};
  ctx.clearRect = function () {};
  ctx.beginPath = function () {};
  ctx.closePath = function () {};
  ctx.moveTo = function () {};
  ctx.lineTo = function () {};
  ctx.stroke = function () {};
  ctx.arc = function () {};
  ctx.measureText = function (text) {
    // 够用的近似：中文按一个全角宽，其余按半角宽
    var w = 0;
    for (var i = 0; i < text.length; i++) {
      w += text.charCodeAt(i) > 0x2000 ? 14 : 8;
    }
    return { width: w };
  };

  ctx.strokeRect = function (x, y, w, h) {
    ctx.calls.strokeRect.push({ x: x, y: y, w: w, h: h, style: ctx.strokeStyle, dash: ctx.lineDash });
  };

  var rawFillRect = ctx.fillRect;
  ctx.fillRect = function (x, y, w, h) {
    ctx.calls.fillRect.push({ x: x, y: y, w: w, h: h, style: ctx.fillStyle });
    rawFillRect(x, y, w, h);
  };

  ctx.fillText = function (text, x, y) {
    ctx.calls.fillText.push({ text: text, x: x, y: y });
  };

  return ctx;
}
