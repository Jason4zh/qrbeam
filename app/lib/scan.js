/*!
 * qrbeam — 分区扫码器
 *
 * 屏幕上并排显示 cols×rows 个二维码，手机画面用同一套网格切分，每块单独交给
 * jsQR 识别。每块向外扩一圈 padding，这样用户不必把二维码对得像素级精准，
 * 只要每个码完整落在某一块内即可（jsQR 自己会在块内搜索定位图案）。
 *
 * 采样器是可注入的：浏览器里用 canvas.drawImage（硬件加速缩放），测试里用
 * 纯 JS 的双线性采样，因此这条管线不需要 DOM 就能端到端跑通。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var jsQR = isNode ? require('./jsQR.js') : root.jsQR;
  var api = factory(jsQR);
  if (isNode) {
    module.exports = api;
  } else {
    root.QB = root.QB || {};
    for (var k in api) root.QB[k] = api[k];
  }
})(typeof self !== 'undefined' ? self : this, function (jsQR) {
  'use strict';

  var DEFAULT_PADDING = 0.02;
  var DEFAULT_ALIGN_PADDING = 0.03;
  var DEFAULT_TARGET = 560;

  /**
   * @param {number} cols
   * @param {number} rows
   * @param {object} [opts]
   * @param {number} [opts.padding=0.02] 每块向外扩展的比例（相对块尺寸）。
   *        上限约 4.7%：格子里二维码内容到格子边界只留了 4 个模块的静区
   *        （4/(n+8)），再往外扩就会把邻码的定位图案拉进来，jsQR 会锁错码。
   * @param {number} [opts.targetSize=560] 每块缩放后的最长边（像素）
   * @param {string} [opts.inversionAttempts='dontInvert'] 我们的码永远是黑底白码
   */
  function GridScanner(cols, rows, opts) {
    opts = opts || {};
    this.cols = Math.max(1, cols | 0);
    this.rows = Math.max(1, rows | 0);
    this.padding = opts.padding === undefined ? DEFAULT_PADDING : opts.padding;
    this.alignPadding = opts.alignPadding === undefined ? DEFAULT_ALIGN_PADDING : opts.alignPadding;
    this.targetSize = opts.targetSize === undefined ? DEFAULT_TARGET : opts.targetSize;
    this.inversionAttempts = opts.inversionAttempts || 'dontInvert';
    // 发送端在二维码四周保留的静区模块数（必须与渲染端一致，用于自动对齐反推格距）
    this.quiet = opts.quiet === undefined ? 4 : opts.quiet;
    this.lastStats = null;
  }

  GridScanner.prototype.slotCount = function () {
    return this.cols * this.rows;
  };

  /**
   * 自动对齐：从各分区的识别结果反推出整片网格的精确位置。
   *
   * 这里刻意不复用"整帧扫一次"的做法：jsQR 在画面里同时存在多个二维码时
   * 会锁错定位图案组合（实测 2×2 时全部分区都读不出来，单格则完全正常）。
   * 因此对齐建立在分区扫描之上 —— 每格本来就只有一码。
   *
   * 原理：jsQR 会返回码的四个角点，据此得到码在帧中的边长；发送端把码居中
   * 放在自己的格子里，格子边长 = 码边长 × (n + 2·quiet)/n，于是格距 g 已知。
   * 再用"这个码落在第几格"解出网格原点，多个样本取中位数抗离群。
   *
   * @param {number} frameW
   * @param {number} frameH
   * @param {function} sampler
   * @param {{x:number,y:number,w:number,h:number}} [area] 搜索区域，缺省为整帧
   * @returns {{roi:object, records:{slot:number,code:string}[], version:number,
   *            modules:number, cellPx:number, samples:number}|null}
   */
  GridScanner.prototype.align = function (frameW, frameH, sampler, area) {
    var baseX = area ? area.x : 0;
    var baseY = area ? area.y : 0;
    var baseW = area ? area.w : frameW;
    var baseH = area ? area.h : frameH;
    if (baseW < 32 || baseH < 32) return null;

    var cw = baseW / this.cols;
    var ch = baseH / this.rows;
    var padX = this.alignPadding * cw;
    var padY = this.alignPadding * ch;

    var gxs = [];
    var gys = [];
    var oxs = [];
    var oys = [];
    var records = [];
    var version = 0;
    var modules = 0;
    for (var r = 0; r < this.rows; r++) {
      for (var c = 0; c < this.cols; c++) {
        var x = Math.max(baseX, baseX + c * cw - padX);
        var y = Math.max(baseY, baseY + r * ch - padY);
        var w = Math.min(baseX + baseW - x, cw + 2 * padX);
        var h = Math.min(baseY + baseH - y, ch + 2 * padY);
        if (w < 16 || h < 16) continue;

        var scale = Math.min(1, this.targetSize / Math.max(w, h));
        var ow = Math.max(16, Math.round(w * scale));
        var oh = Math.max(16, Math.round(h * scale));

        var img = null;
        var res = null;
        try {
          img = sampler(x, y, w, h, ow, oh);
          res = jsQR(img.data, ow, oh, { inversionAttempts: this.inversionAttempts });
        } catch (e) {
          continue;
        }
        if (!res) continue;

        // 只要能解出内容就先收下，几何信息缺失不影响这条数据
        if (res.data) records.push({ slot: r * this.cols + c, code: res.data });
        if (!res.location || !res.version) continue;

        var loc = res.location;
        var tlc = loc.topLeftCorner;
        var trc = loc.topRightCorner;
        var blc = loc.bottomLeftCorner;
        var brc = loc.bottomRightCorner;
        if (!tlc || !trc || !blc || !brc) continue;

        var kx = w / ow;
        var ky = h / oh;
        var minX = Math.min(tlc.x, trc.x, blc.x, brc.x);
        var maxX = Math.max(tlc.x, trc.x, blc.x, brc.x);
        var minY = Math.min(tlc.y, trc.y, blc.y, brc.y);
        var maxY = Math.max(tlc.y, trc.y, blc.y, brc.y);

        var m = res.version * 4 + 17;
        var ratio = (m + 2 * this.quiet) / m;
        var codeW = (maxX - minX) * kx;
        var codeH = (maxY - minY) * ky;
        if (codeW < 8 || codeH < 8) continue;

        var gx = codeW * ratio;
        var gy = codeH * ratio;
        var cx = x + ((minX + maxX) / 2) * kx;
        var cy = y + ((minY + maxY) / 2) * ky;

        gxs.push(gx);
        gys.push(gy);
        oxs.push(cx - (c + 0.5) * gx);
        oys.push(cy - (r + 0.5) * gy);

        if (!version) {
          version = res.version;
          modules = m;
        }
      }
    }

    if (gxs.length === 0) {
      // 没拿到任何可用于定位的样本，但可能已经解出了内容
      return records.length
        ? { roi: null, records: records, version: 0, modules: 0, cellPx: 0, samples: 0 }
        : null;
    }

    var gxMed = median(gxs);
    var gyMed = median(gys);
    if (!(gxMed > 0) || !(gyMed > 0)) return null;

    var ox = median(oxs);
    var oy = median(oys);
    var perCell = version * 4 + 17 + 2 * this.quiet;

    return {
      roi: { x: ox, y: oy, w: gxMed * this.cols, h: gyMed * this.rows },
      records: records,
      version: version,
      modules: modules,
      cellPx: ((gxMed + gyMed) / 2) / perCell,
      samples: records.length,
    };
  };

  function median(arr) {
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  /**
   * 扫描一帧。
   * @param {number} frameW
   * @param {number} frameH
   * @param {function(number,number,number,number,number,number): {data: Uint8ClampedArray, width: number, height: number}} sampler
   *        sampler(x, y, w, h, outW, outH) 返回缩放到 outW×outH 的 RGBA 图像
   * @param {{x:number,y:number,w:number,h:number}} [roi] 只在这一区域内切分网格
   * @returns {(string|null)[]} 每个槽位的文本（未识别为 null）
   */
  GridScanner.prototype.scan = function (frameW, frameH, sampler, roi) {
    var baseX = roi ? roi.x : 0;
    var baseY = roi ? roi.y : 0;
    var baseW = roi ? roi.w : frameW;
    var baseH = roi ? roi.h : frameH;
    var cw = baseW / this.cols;
    var ch = baseH / this.rows;
    var padX = this.padding * cw;
    var padY = this.padding * ch;
    var out = new Array(this.cols * this.rows);
    var hits = 0;
    var t0 = Date.now();

    var i = 0;
    for (var r = 0; r < this.rows; r++) {
      for (var c = 0; c < this.cols; c++, i++) {
        var x = Math.max(baseX, baseX + c * cw - padX);
        var y = Math.max(baseY, baseY + r * ch - padY);
        var w = Math.min(baseX + baseW - x, cw + 2 * padX);
        var h = Math.min(baseY + baseH - y, ch + 2 * padY);
        if (w < 16 || h < 16) {
          out[i] = null;
          continue;
        }
        var scale = Math.min(1, this.targetSize / Math.max(w, h));
        var ow = Math.max(16, Math.round(w * scale));
        var oh = Math.max(16, Math.round(h * scale));

        var img;
        try {
          img = sampler(x, y, w, h, ow, oh);
        } catch (e) {
          out[i] = null;
          continue;
        }

        var res = null;
        try {
          res = jsQR(img.data, ow, oh, { inversionAttempts: this.inversionAttempts });
        } catch (e) {
          res = null;
        }
        out[i] = res && res.data ? res.data : null;
        if (out[i]) hits++;
      }
    }

    this.lastStats = { slots: out.length, hits: hits, ms: Date.now() - t0 };
    return out;
  };

  /**
   * 取景引导框：在 W×H 的取景区域里，取一个宽高比恰为 cols:rows 的最大内接矩形。
   *
   * 发送端的画布就是 cols×rows 个正方形格子紧铺成的，所以它的外形比例正好是
   * cols:rows。把同比例的框画在预览上，用户只要把电脑屏幕铺满它就行。
   *
   * 这个框天然随手机屏幕比例自适应：竖屏拿时它会变成中间一条横向的扁框
   * （顺带提示用户这样是在浪费分辨率），横屏拿时它才会撑满。
   *
   * @param {number} W 取景区域宽（像素）
   * @param {number} H 取景区域高（像素）
   * @param {number} cols
   * @param {number} rows
   * @param {number} [margin=0.06] 四周留白（相对短边的比例）
   * @returns {{x:number,y:number,w:number,h:number}}
   */
  function guideRect(W, H, cols, rows, margin) {
    if (!(W > 0) || !(H > 0)) return { x: 0, y: 0, w: 0, h: 0 };
    if (margin === undefined) margin = 0.06;
    var inset = margin * Math.min(W, H) * 2;
    // 留白绝不能吃掉整块区域：这里只保底到 1px，而不是硬撑一个最小值，
    // 否则在窄小的取景区里框会算得比容器本身还大。
    var availW = Math.max(1, W - inset);
    var availH = Math.max(1, H - inset);
    var ar = cols / rows;
    var w, h;
    if (availW / availH > ar) {
      // 取景区域比网格更"宽"，以高度为准
      h = availH;
      w = h * ar;
    } else {
      w = availW;
      h = w / ar;
    }
    return { x: (W - w) / 2, y: (H - h) / 2, w: w, h: h };
  }

  return { GridScanner: GridScanner, guideRect: guideRect };
});