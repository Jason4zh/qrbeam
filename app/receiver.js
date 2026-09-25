/*!
 * qrbeam — 接收端（手机）
 *
 * 取景 → 按网格分区 → jsQR 识别 → 喷泉解码 → 重组文件。
 * 解码在 Worker 里跑，主线程只负责取景与 UI，因此预览不会因为识别而卡顿。
 * 对齐完全自动：从识别出的码的角点反推整片网格的位置，用户只需把屏幕大致放进画面。
 */
/* global QB */

(function () {
  'use strict';

  var GRIDS = [
    { id: '1x1', cols: 1, rows: 1, label: '1 个码' },
    { id: '2x1', cols: 2, rows: 1, label: '2 个码 · 横' },
    { id: '1x2', cols: 1, rows: 2, label: '2 个码 · 竖' },
    { id: '2x2', cols: 2, rows: 2, label: '4 个码' },
    { id: '3x1', cols: 3, rows: 1, label: '3 个码 · 横' },
    { id: '2x3', cols: 2, rows: 3, label: '6 个码 · 竖' },
    { id: '3x2', cols: 3, rows: 2, label: '6 个码 · 横' },
    { id: '4x2', cols: 4, rows: 2, label: '8 个码' },
  ];

  var MISS_LIMIT = 12;      // 连续这么多帧没有几何样本就丢掉对齐结果重新找
  var HIT_WINDOW_MS = 3000;

  var el = {};
  ['cam', 'overlay', 'viewport', 'bar', 'statusLine', 'subLine', 'sheet', 'sheetTitle',
    'sheetText', 'sheetActions', 'grid', 'startBtn', 'realignBtn', 'rotateHint'].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  var state = {
    receiver: new QB.StreamReceiver(),
    stream: null,
    scanning: false,
    busy: false,
    roi: null,
    missStreak: 0,
    seq: 0,
    grid: { cols: 2, rows: 2 },
    detail: { cols: 0, rows: 0 },
    worker: null,
    useWorker: false,
    grabCanvas: null,
    grabCtx: null,
    localScanner: null,
    mainSampler: null,
    viewportObserver: null,
    slotHit: [],
    hits: [],
    rafId: 0,
    lastOverlay: 0,
    done: false,
    error: null,
    startedAt: 0,
  };

  var octx = el.overlay.getContext('2d');

  // ------------------------------------------------------------------
  // 小工具
  // ------------------------------------------------------------------

  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function showSheet(title, text, actions, busy) {
    el.sheetTitle.textContent = title;
    el.sheetText.textContent = text || '';
    el.sheetActions.textContent = '';
    if (busy) {
      var sp = document.createElement('div');
      sp.className = 'spinner';
      el.sheetActions.appendChild(sp);
    }
    (actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.textContent = a.label;
      if (a.primary) b.className = 'primary';
      b.addEventListener('click', a.onClick);
      el.sheetActions.appendChild(b);
    });
    el.sheet.classList.add('show');
  }

  function hideSheet() {
    el.sheet.classList.remove('show');
  }

  // ------------------------------------------------------------------
  // 网格与朝向
  // ------------------------------------------------------------------

  function selectedGrid() {
    var id = el.grid.value;
    for (var i = 0; i < GRIDS.length; i++) if (GRIDS[i].id === id) return GRIDS[i];
    return GRIDS[3];
  }

  /**
   * 取景画面在预览区里的实际显示矩形（对齐 #cam 的 object-fit: contain）。
   * @returns {{W:number,H:number,vw:number,vh:number,dw:number,dh:number,dx:number,dy:number}|null}
   */
  function displayBox() {
    var W = el.viewport.clientWidth;
    var H = el.viewport.clientHeight;
    var vw = el.cam.videoWidth;
    var vh = el.cam.videoHeight;
    if (!W || !H || !vw || !vh) return null;
    var ar = vw / vh;
    var dw, dh, dx, dy;
    if (ar > W / H) {
      dw = W;
      dh = W / ar;
      dx = 0;
      dy = (H - dh) / 2;
    } else {
      dh = H;
      dw = H * ar;
      dy = 0;
      dx = (W - dw) / 2;
    }
    return { W: W, H: H, vw: vw, vh: vh, dw: dw, dh: dh, dx: dx, dy: dy };
  }

  /**
   * 引导框（预览坐标，相对显示矩形左上角）。
   */
  function guideBox(d) {
    return QB.guideRect(d.dw, d.dh, state.detail.cols, state.detail.rows);
  }

  /**
   * 未对齐时，用引导框对应的画面区域作为搜索区；已对齐则用锁定的网格区域。
   * 这样首帧就只需要在用户真正摆放屏幕的那块区域里找，而不必整帧盲扫。
   */
  function searchArea() {
    if (state.roi) return state.roi;
    var d = displayBox();
    if (!d) return null;
    var g = QB.guideRect(d.dw, d.dh, state.detail.cols, state.detail.rows);
    return {
      x: (g.x / d.dw) * d.vw,
      y: (g.y / d.dh) * d.vh,
      w: (g.w / d.dw) * d.vw,
      h: (g.h / d.dh) * d.vh,
    };
  }

  /**
   * 布局直接照搬发送端的 cols×rows，不做任何转置。
   *
   * 曾经按"手机横竖"把网格转置过一次，那是错的：无论怎么持握手机，取景预览
   * 里的画面方向都和人眼看到的一致，电脑屏幕的横向始终对应画面的横向。
   * 转置之后 3×2 会被当成 2×3，每个分区都套不住一个完整的码，画出来的框
   * 也就比实际的码大出一大截。
   */
  function applyGrid() {
    var g = selectedGrid();
    if (g.cols === state.detail.cols && g.rows === state.detail.rows && state.localScanner) {
      updateRotateHint();
      return;
    }
    state.detail = { cols: g.cols, rows: g.rows };
    state.roi = null;
    state.missStreak = 0;
    state.slotHit = new Array(g.cols * g.rows).fill(false);
    state.localScanner = new QB.GridScanner(g.cols, g.rows);
    if (state.worker) {
      state.worker.postMessage({ type: 'config', cols: g.cols, rows: g.rows, options: {} });
    }
    updateRotateHint();
    drawOverlay();
  }

  /**
   * 引导框占取景区域的比例太小，说明当前持握方向在浪费分辨率 —— 横过来更划算。
   * 阈值 0.42 大致对应"竖屏 + 横向网格"这一种情况。
   */
  function updateRotateHint() {
    var d = displayBox();
    if (!d || !state.detail.cols) {
      el.rotateHint.classList.remove('show');
      return;
    }
    var g = guideBox(d);
    var used = (g.w * g.h) / Math.max(1, d.dw * d.dh);
    el.rotateHint.classList.toggle('show', used < 0.42);
  }

  // ------------------------------------------------------------------
  // 取景与识别
  // ------------------------------------------------------------------

  function ensureGrab(vw, vh) {
    if (!state.grabCanvas) {
      state.grabCanvas = document.createElement('canvas');
      state.grabCtx = state.grabCanvas.getContext('2d');
    }
    if (state.grabCanvas.width !== vw || state.grabCanvas.height !== vh) {
      state.grabCanvas.width = vw;
      state.grabCanvas.height = vh;
    }
  }

  function mainThreadSampler(video) {
    if (state.mainSampler) return state.mainSampler;
    var cv = document.createElement('canvas');
    var c = cv.getContext('2d', { willReadFrequently: true });
    state.mainSampler = function (x, y, w, h, outW, outH) {
      if (cv.width !== outW || cv.height !== outH) {
        cv.width = outW;
        cv.height = outH;
      }
      c.imageSmoothingEnabled = true;
      c.drawImage(video, x, y, w, h, 0, 0, outW, outH);
      return c.getImageData(0, 0, outW, outH);
    };
    return state.mainSampler;
  }

  function grabAndScan() {
    if (state.busy || state.done) return;
    var v = el.cam;
    var vw = v.videoWidth;
    var vh = v.videoHeight;
    if (!vw || !vh) return;

    if (state.useWorker) {
      ensureGrab(vw, vh);
      try {
        state.grabCtx.drawImage(v, 0, 0, vw, vh);
        var bitmap = state.grabCanvas.transferToImageBitmap();
      } catch (err) {
        fallbackToMainThread(err);
        return;
      }
      state.busy = true;
      state.worker.postMessage(
        { type: 'frame', bitmap: bitmap, width: vw, height: vh, roi: searchArea(), seq: ++state.seq },
        [bitmap]
      );
      return;
    }

    // 主线程回退路径
    state.busy = true;
    var sampler = mainThreadSampler(v);
    var res = null;
    try {
      res = state.localScanner.align(vw, vh, sampler, searchArea());
    } catch (err) {
      state.error = String(err && err.message ? err.message : err);
    }
    handleResult({
      records: res ? res.records : [],
      hits: res ? res.records.map(function (x) { return x.slot; }) : [],
      roi: res ? res.roi : null,
      samples: res ? res.samples : 0,
      ms: 0,
    });
  }

  function fallbackToMainThread(err) {
    state.error = String(err && err.message ? err.message : err);
    state.useWorker = false;
    state.busy = false;
    if (state.worker) {
      state.worker.terminate();
      state.worker = null;
    }
  }

  function handleResult(r) {
    state.busy = false;
    if (!state.scanning) return;

    var i;
    var hit = new Array(state.detail.cols * state.detail.rows).fill(false);
    if (r.hits) {
      for (i = 0; i < r.hits.length; i++) hit[r.hits[i]] = true;
    }
    state.slotHit = hit;

    var accepted = 0;
    if (r.records) {
      for (i = 0; i < r.records.length; i++) {
        if (state.receiver.acceptText(r.records[i].code)) accepted++;
      }
    }

    if (r.roi) {
      state.roi = r.roi;
      state.missStreak = 0;
    } else {
      state.missStreak++;
      // 手机被挪动了以后旧的对齐会失效，丢掉它重新整帧找
      if (state.missStreak >= MISS_LIMIT && state.roi) {
        state.roi = null;
        state.missStreak = 0;
      }
    }

    var now = Date.now();
    state.hits.push({ t: now, n: accepted, frames: 1, slots: hit.filter(Boolean).length });
    while (state.hits.length && now - state.hits[0].t > HIT_WINDOW_MS) state.hits.shift();

    updateHud(now);
    drawOverlay();

    if (state.receiver.isComplete() && !state.done) finish();
  }

  function scanLoop(ts) {
    if (!state.scanning) return;
    state.rafId = requestAnimationFrame(scanLoop);
    grabAndScan();
  }

  function startScanning() {
    if (state.scanning) return;
    state.scanning = true;
    state.startedAt = Date.now();
    hideSheet();
    el.startBtn.textContent = '暂停';
    el.rafId = requestAnimationFrame(scanLoop);
  }

  function stopScanning() {
    state.scanning = false;
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = 0;
    el.startBtn.textContent = '继续';
  }

  // ------------------------------------------------------------------
  // HUD
  // ------------------------------------------------------------------

  function updateHud(now) {
    var p = state.receiver.progress();
    el.bar.style.width = (p.fraction * 100).toFixed(1) + '%';

    var bytesText = p.totalBytes ? fmtBytes(p.bytes) + ' / ' + fmtBytes(p.totalBytes) : fmtBytes(p.bytes);
    var pct = p.totalBytes ? (p.fraction * 100).toFixed(1) + '%' : '—';
    el.statusLine.textContent = bytesText + '　' + pct;

    var blocks = 0;
    var frames = 0;
    for (var i = 0; i < state.hits.length; i++) {
      blocks += state.hits[i].n;
      frames += state.hits[i].frames;
    }
    var span = state.hits.length ? Math.max(1, (now - state.hits[0].t) / 1000) : 1;
    var bps = blocks / span;
    var L = state.receiver.L || 0;
    var rate = ((blocks * (L + 13)) / span / 1024).toFixed(1);

    var segText = p.totalSegments
      ? p.solvedSegments + '/' + p.totalSegments + ' 段'
      : state.receiver.stats.segmentsSolved + ' 段';
    var name = state.receiver.meta ? decodeName(state.receiver.meta) : '';

    el.subLine.textContent =
      segText +
      '　' + bps.toFixed(0) + ' 块/秒　' + rate + ' KB/s' +
      (name ? '　' + name : '');
  }

  /**
   * 叠加层：未锁定时画"把屏幕铺满这里"的取景引导框，锁定后画真实的网格。
   *
   * 所有几何都以取景画面在预览区里的实际显示矩形为基准，因此框的位置和大小
   * 会随手机屏幕比例、横竖屏、地址栏收展自动跟着变。
   */
  function drawOverlay() {
    var dpr = window.devicePixelRatio || 1;
    var W = el.viewport.clientWidth;
    var H = el.viewport.clientHeight;
    if (!W || !H) return;
    if (el.overlay.width !== Math.round(W * dpr) || el.overlay.height !== Math.round(H * dpr)) {
      el.overlay.width = Math.round(W * dpr);
      el.overlay.height = Math.round(H * dpr);
    }
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, W, H);

    var d = displayBox();
    var cols = state.detail.cols;
    var rows = state.detail.rows;
    if (!d || !cols || !rows) return;

    var locked = !!state.roi;
    var cells = [];
    var outer;
    var r;
    var c;

    if (locked) {
      // 帧坐标 -> 预览坐标
      var ox = d.dx + (state.roi.x / d.vw) * d.dw;
      var oy = d.dy + (state.roi.y / d.vh) * d.dh;
      var sw = (state.roi.w / cols / d.vw) * d.dw;
      var sh = (state.roi.h / rows / d.vh) * d.dh;
      outer = { x: ox, y: oy, w: sw * cols, h: sh * rows };
      for (r = 0; r < rows; r++) {
        for (c = 0; c < cols; c++) {
          cells.push({ x: ox + c * sw, y: oy + r * sh, w: sw, h: sh });
        }
      }
    } else {
      var g = QB.guideRect(d.dw, d.dh, cols, rows);
      var gw = g.w / cols;
      var gh = g.h / rows;
      outer = { x: d.dx + g.x, y: d.dy + g.y, w: g.w, h: g.h };
      for (r = 0; r < rows; r++) {
        for (c = 0; c < cols; c++) {
          cells.push({ x: outer.x + c * gw, y: outer.y + r * gh, w: gw, h: gh });
        }
      }
    }

    var i;
    var cell;
    for (i = 0; i < cells.length; i++) {
      cell = cells[i];
      if (state.slotHit[i]) {
        octx.setLineDash([]);
        octx.fillStyle = 'rgba(61,220,132,0.16)';
        octx.fillRect(cell.x + 1, cell.y + 1, cell.w - 2, cell.h - 2);
        octx.strokeStyle = 'rgba(61,220,132,0.95)';
        octx.lineWidth = 2.5;
        octx.strokeRect(cell.x + 1.25, cell.y + 1.25, cell.w - 2.5, cell.h - 2.5);
      } else {
        octx.setLineDash(locked ? [] : [5, 5]);
        octx.strokeStyle = locked ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.3)';
        octx.lineWidth = 1.5;
        octx.strokeRect(cell.x + 0.75, cell.y + 0.75, cell.w - 1.5, cell.h - 1.5);
      }
    }
    octx.setLineDash([]);

    // 外框 + 四角角标：锁定后是实线，未锁定时是虚线取景框
    octx.lineWidth = 2.5;
    octx.strokeStyle = locked ? 'rgba(76,141,255,0.95)' : 'rgba(76,141,255,0.85)';
    if (!locked) octx.setLineDash([9, 7]);
    octx.strokeRect(outer.x + 1, outer.y + 1, outer.w - 2, outer.h - 2);
    octx.setLineDash([]);

    var arm = Math.max(14, Math.min(26, Math.min(outer.w, outer.h) * 0.12));
    octx.lineWidth = 4;
    octx.strokeStyle = locked ? 'rgba(76,141,255,0.95)' : 'rgba(122,169,255,0.95)';
    var corners = [
      [outer.x, outer.y, 1, 1],
      [outer.x + outer.w, outer.y, -1, 1],
      [outer.x, outer.y + outer.h, 1, -1],
      [outer.x + outer.w, outer.y + outer.h, -1, -1],
    ];
    for (i = 0; i < corners.length; i++) {
      var cx = corners[i][0];
      var cy = corners[i][1];
      var sx = corners[i][2];
      var sy = corners[i][3];
      octx.beginPath();
      octx.moveTo(cx + sx * arm, cy);
      octx.lineTo(cx, cy);
      octx.lineTo(cx, cy + sy * arm);
      octx.stroke();
    }

    // 提示文字：未锁定时告诉用户要做什么
    if (!locked) {
      var label = '把电脑屏幕放进这个框';
      octx.font = '600 14px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      var tw = octx.measureText(label).width;
      var tx = Math.min(Math.max(8, outer.x + (outer.w - tw - 20) / 2), Math.max(8, W - tw - 26));
      var ty = outer.y - 12;
      if (ty < 26) ty = Math.min(H - 12, outer.y + outer.h + 26);
      octx.fillStyle = 'rgba(10,14,20,0.78)';
      octx.fillRect(tx - 10, ty - 17, tw + 20, 25);
      octx.fillStyle = 'rgba(122,169,255,0.98)';
      octx.fillText(label, tx, ty);
    }
  }

  function decodeName(meta) {
    if (!meta || !meta.nameUtf8) return '';
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(meta.nameUtf8);
    } catch (e) {
      return '';
    }
  }

  // ------------------------------------------------------------------
  // 完成
  // ------------------------------------------------------------------

  function finish() {
    state.done = true;
    stopScanning();
    updateHud(Date.now());

    var bytes = state.receiver.assemble();
    if (!bytes) {
      showSheet('重组失败', '数据不完整，请继续扫描。', [{ label: '继续', onClick: function () { state.done = false; startScanning(); } }]);
      return;
    }

    var meta = state.receiver.meta;
    var name = decodeName(meta) || 'qrbeam.bin';
    var expected = meta ? meta.sha256 : null;
    var needCheck = expected && window.crypto && crypto.subtle &&
      expected.some(function (b) { return b !== 0; });

    function present(ok) {
      var text = '已收到 ' + fmtBytes(bytes.length) + '　' + name;
      if (needCheck && !ok) {
        text += '\n校验未通过：内容可能仍有损坏，建议重新扫描。';
      } else if (needCheck) {
        text += '\nSHA-256 校验通过。';
      }
      var actions = [
        {
          label: '保存文件',
          primary: true,
          onClick: function () { download(bytes, name); },
        },
        {
          label: '再传一个',
          onClick: function () { resetAll(); },
        },
      ];
      if (needCheck && !ok) {
        actions.unshift({
          label: '重扫',
          onClick: function () {
            state.receiver.reset(state.receiver.fileId);
            state.done = false;
            startScanning();
          },
        });
      }
      showSheet(ok ? '接收完成' : '接收完成（未通过校验）', text, actions);
    }

    if (!needCheck) {
      present(true);
      return;
    }
    crypto.subtle.digest('SHA-256', bytes).then(function (d) {
      var got = new Uint8Array(d);
      var same = true;
      for (var i = 0; i < got.length && i < 32; i++) {
        if (got[i] !== expected[i]) { same = false; break; }
      }
      present(same);
    }).catch(function () { present(true); });
  }

  function download(bytes, name) {
    var blob = new Blob([bytes], { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  function resetAll() {
    stopScanning();
    state.receiver.reset(-1);
    state.roi = null;
    state.missStreak = 0;
    state.hits = [];
    state.slotHit = new Array(state.detail.cols * state.detail.rows).fill(false);
    state.done = false;
    updateHud(Date.now());
    startScanning();
  }

  // ------------------------------------------------------------------
  // 摄像头
  // ------------------------------------------------------------------

  function cameraAvailable() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function startCamera() {
    if (!cameraAvailable()) {
      showSheet(
        '无法使用摄像头',
        window.isSecureContext === false
          ? '摄像头只能在 HTTPS 页面里使用。请通过 GitHub Pages 的 https 地址打开本页（首次加载后可以离线使用）。'
          : '当前浏览器不支持 getUserMedia。',
        []
      );
      return;
    }
    showSheet('正在启动摄像头', '请在系统弹窗中允许访问摄像头。', [], true);

    navigator.mediaDevices
      .getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      })
      .then(function (stream) {
        state.stream = stream;
        el.cam.srcObject = stream;
        return el.cam.play();
      })
      .then(function () {
        return new Promise(function (resolve) {
          if (el.cam.videoWidth) return resolve();
          el.cam.addEventListener('loadedmetadata', function () { resolve(); }, { once: true });
          setTimeout(resolve, 1500);
        });
      })
      .then(function () {
        initWorker();
        applyGrid();
        updateHud(Date.now());
        startScanning();
        watchViewport();
      })
      .catch(function (err) {
        showSheet('摄像头启动失败', String(err && err.message ? err.message : err), [
          { label: '重试', primary: true, onClick: startCamera },
        ]);
      });
  }

  /**
   * 监听取景区的尺寸变化：地址栏收展、横竖屏切换、分屏都会改变它，
   * 引导框和网格必须跟着重算，否则框就会和画面错位。
   */
  function watchViewport() {
    if (typeof ResizeObserver !== 'undefined') {
      if (state.viewportObserver) state.viewportObserver.disconnect();
      state.viewportObserver = new ResizeObserver(function () {
        updateRotateHint();
        drawOverlay();
      });
      state.viewportObserver.observe(el.viewport);
    } else {
      window.addEventListener('resize', drawOverlay);
    }
    window.addEventListener('orientationchange', function () {
      // 方向切换后视口尺寸要晚一点才稳定下来
      setTimeout(function () {
        applyGrid();
        updateRotateHint();
        drawOverlay();
      }, 350);
    });
  }

  function initWorker() {    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
      state.useWorker = false;
      return;
    }
    if (typeof location !== 'undefined' && location.protocol === 'file:') {
      state.useWorker = false;
      return;
    }
    var w;
    try {
      w = new Worker('app/receiver-worker.js');
    } catch (e) {
      state.useWorker = false;
      return;
    }
    w.onmessage = function (e) {
      var m = e.data;
      if (!m) return;
      if (m.type === 'result') handleResult(m);
    };
    w.onerror = function (e) {
      fallbackToMainThread(new Error((e && e.message) || 'worker 异常'));
    };
    state.worker = w;
    state.useWorker = true;
  }

  // ------------------------------------------------------------------
  // 事件
  // ------------------------------------------------------------------

  el.grid.innerHTML = GRIDS.map(function (g) {
    return '<option value="' + g.id + '">' + g.label + '</option>';
  }).join('');
  el.grid.value = '2x2';

  el.grid.addEventListener('change', function () {
    state.receiver.reset(-1);
    state.hits = [];
    state.roi = null;
    state.done = false;
    applyGrid();
    updateHud(Date.now());
    drawOverlay();
  });

  el.startBtn.addEventListener('click', function () {
    if (state.scanning) stopScanning();
    else startScanning();
  });

  el.realignBtn.addEventListener('click', function () {
    state.roi = null;
    state.missStreak = 0;
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state.scanning) stopScanning();
  });

  // ------------------------------------------------------------------
  // 启动
  // ------------------------------------------------------------------

  showSheet(
    '准备接收',
    '开始后会显示一个与电脑端「布局」同比例的取景框 —— 把电脑屏幕上的二维码铺满它就行，位置和距离不太准也没关系，系统会自动锁定网格。两端的布局选同一个即可。',
    [{ label: '开始扫描', primary: true, onClick: startCamera }],
    false
  );
  updateHud(Date.now());
})();
