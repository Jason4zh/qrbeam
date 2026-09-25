/*!
 * qrbeam — 二维码画布渲染
 *
 * 设计要点：
 *  1. 每个码先画成"1 像素 = 1 模块"的小位图，再用关闭插值的 drawImage 整数倍
 *     放大。位图小到可以复用一个 canvas，放大由浏览器原生完成，比逐模块
 *     fillRect 快一个数量级。
 *  2. 每模块的像素数取整，并让画布尺寸恰好等于整片网格，不留任何额外留白 ——
 *     接收端的等分切分和自动对齐都依赖这个前提。
 *  3. 渲染函数不碰 DOM 之外的任何东西，因此同一份代码可以在主线程和 Worker
 *     （OffscreenCanvas）里跑。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var qrcode = isNode ? require('./qrcode.js') : root.qrcode;
  var api = factory(qrcode);
  if (isNode) {
    module.exports = api;
  } else {
    root.QB = root.QB || {};
    for (var k in api) root.QB[k] = api[k];
  }
})(typeof self !== 'undefined' ? self : this, function (qrcode) {
  'use strict';

  var DEFAULT_QUIET = 4;

  /** 一个可复用的 1 像素/模块 位图。drawImage 会同步拷贝，所以全局复用一个就够。 */
  var tile = null;

  function createCanvas() {
    if (typeof document !== 'undefined' && document.createElement) {
      return document.createElement('canvas');
    }
    return new OffscreenCanvas(1, 1);
  }

  function getTile(side) {
    if (tile && tile.side === side) return tile;
    var canvas = createCanvas();
    canvas.width = side;
    canvas.height = side;
    var ctx = canvas.getContext('2d');
    tile = {
      side: side,
      canvas: canvas,
      ctx: ctx,
      imageData: ctx.createImageData(side, side),
    };
    // 一次性把整块填成不透明白色，之后只需覆盖黑色模块
    tile.imageData.data.fill(255);
    return tile;
  }

  /**
   * 计算一屏的布局。
   * @returns {{moduleCount:number, side:number, moduleScale:number,
   *            width:number, height:number, cols:number, rows:number}}
   */
  function layout(opts) {
    var version = opts.version;
    var quiet = opts.quiet === undefined ? DEFAULT_QUIET : opts.quiet;
    var cols = opts.cols;
    var rows = opts.rows;
    var moduleCount = version * 4 + 17;
    var side = moduleCount + 2 * quiet;

    var scale = opts.moduleScale;
    if (!scale || scale < 1) {
      scale = Math.floor(Math.min(opts.availW / (cols * side), opts.availH / (rows * side)));
    }
    if (scale < 1) scale = 1;

    return {
      cols: cols,
      rows: rows,
      quiet: quiet,
      version: version,
      moduleCount: moduleCount,
      side: side,
      moduleScale: scale,
      width: cols * side * scale,
      height: rows * side * scale,
      cellSize: side * scale,
    };
  }

  /**
   * 把一帧的文本渲染到 ctx。
   * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
   * @param {string[]} texts   长度必须等于 cols*rows
   * @param {object} lay       layout() 的返回值
   * @param {object} opts      {ecl, bg, fg}
   */
  function renderFrame(ctx, texts, lay, opts) {
    opts = opts || {};
    var ecl = opts.ecl || 'L';
    var quiet = lay.quiet;
    var side = lay.side;
    var moduleCount = lay.moduleCount;
    var cell = lay.cellSize;

    if (ctx.canvas) {
      ctx.canvas.width = lay.width;
      ctx.canvas.height = lay.height;
    }
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = opts.bg || '#ffffff';
    ctx.fillRect(0, 0, lay.width, lay.height);
    ctx.fillStyle = opts.fg || '#000000';

    var t = getTile(side);
    var data = t.imageData.data;

    for (var i = 0; i < texts.length; i++) {
      var qr = qrcode(lay.version, ecl);
      qr.addData(texts[i], 'Alphanumeric');
      qr.make();

      // 复位成纯白，再写入黑色模块（1 像素 = 1 模块）
      data.fill(255);
      for (var my = 0; my < moduleCount; my++) {
        for (var mx = 0; mx < moduleCount; mx++) {
          if (!qr.isDark(my, mx)) continue;
          var off = ((my + quiet) * side + (mx + quiet)) * 4;
          data[off] = 0;
          data[off + 1] = 0;
          data[off + 2] = 0;
        }
      }
      t.ctx.putImageData(t.imageData, 0, 0);

      var col = i % lay.cols;
      var row = (i / lay.cols) | 0;
      ctx.drawImage(t.canvas, col * cell, row * cell, cell, cell);
    }
  }

  /** 给 Worker 用：渲染一帧并返回 ImageBitmap。 */
  function renderFrameToBitmap(canvas, texts, lay, opts) {
    var ctx = canvas.getContext('2d');
    renderFrame(ctx, texts, lay, opts);
    return canvas.transferToImageBitmap();
  }

  return {
    QR_DEFAULT_QUIET: DEFAULT_QUIET,
    qrLayout: layout,
    qrRenderFrame: renderFrame,
    qrRenderFrameToBitmap: renderFrameToBitmap,
  };
});
