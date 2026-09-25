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
   * 发送端把码排成 cols×rows 铺在电脑屏幕上。手机竖着拿的时候，同一片网格在
   * 取景画面里会呈现为转置后的形状，所以这里按取景画面的长宽比自动转置，
   * 用户在两端选同一个布局名即可。
   */
  function applyGrid() {
    var g = selectedGrid();
    var vw = el.cam.videoWidth || 4;
    var vh = el.cam.videoHeight || 3;
    var landscape = vw >= vh;
    var cols = g.cols;
    var rows = g.rows;

    if (cols !== rows) {
      if (!landscape && cols > rows) { var t = cols; cols = rows; rows = t; }
      else if (landscape && rows > cols) { var t2 = cols; cols = rows; rows = t2; }
    }

    if (cols === state.detail.cols && rows === state.detail.rows && state.localScanner) return;
    state.detail = { cols: cols, rows: rows };
    state.roi = null;
    state.missStreak = 0;
    state.slotHit = new Array(cols * rows).fill(false);
    state.localScanner = new QB.GridScanner(cols, rows);
    if (state.worker) {
      state.worker.postMessage({ type: 'config', cols: cols, rows: rows, options: {} });
    }
    el.rotateHint.classList.toggle('show', !landscape);
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
        { type: 'frame', bitmap: bitmap, width: vw, height: vh, roi: state.roi, seq: ++state.seq },
        [bitmap]
      );
      return;
    }

    // 主线程回退路径
    state.busy = true;
    var sampler = mainThreadSampler(v);
    var res = null;
    try {
      res = state.localScanner.align(vw, vh, sampler, state.roi);
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

  function drawOverlay() {
    var now = Date.now();
    var dpr = window.devicePixelRatio || 1;
    var W = el.viewport.clientWidth;
    var H = el.viewport.clientHeight;
    if (el.overlay.width !== Math.round(W * dpr) || el.overlay.height !== Math.round(H * dpr)) {
      el.overlay.width = Math.round(W * dpr);
      el.overlay.height = Math.round(H * dpr);
    }
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, W, H);

    var v = el.cam;
    var vw = v.videoWidth;
    var vh = v.videoHeight;
    if (!vw || !vh) return;

    // object-fit: contain 的显示区域
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

    var cols = state.detail.cols;
    var rows = state.detail.rows;
    var roi = state.roi || { x: 0, y: 0, w: vw, h: vh };
    var cw = roi.w / cols;
    var ch = roi.h / rows;

    octx.lineWidth = 2;
    octx.font = '600 12px ui-monospace, monospace';
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var slot = r * cols + c;
        var x = dx + ((roi.x + c * cw) / vw) * dw;
        var y = dy + ((roi.y + r * ch) / vh) * dh;
        var w = (cw / vw) * dw;
        var h = (ch / vh) * dh;
        var on = state.slotHit[slot];
        octx.strokeStyle = on ? 'rgba(61,220,132,0.95)' : 'rgba(255,255,255,0.35)';
        octx.strokeRect(x + 1, y + 1, w - 2, h - 2);
        if (on) {
          octx.fillStyle = 'rgba(61,220,132,0.95)';
          octx.fillText('✓', x + 6, y + 16);
        }
      }
    }

    // 对齐成功时把整片网格的边界描出来，让用户知道系统锁定了什么
    if (state.roi) {
      octx.strokeStyle = 'rgba(76,141,255,0.9)';
      octx.lineWidth = 2;
      octx.strokeRect(
        dx + (state.roi.x / vw) * dw,
        dy + (state.roi.y / vh) * dh,
        (state.roi.w / vw) * dw,
        (state.roi.h / vh) * dh
      );
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
        window.addEventListener('resize', drawOverlay);
        window.addEventListener('orientationchange', function () {
          setTimeout(function () { applyGrid(); drawOverlay(); }, 350);
        });
      })
      .catch(function (err) {
        showSheet('摄像头启动失败', String(err && err.message ? err.message : err), [
          { label: '重试', primary: true, onClick: startCamera },
        ]);
      });
  }

  function initWorker() {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
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
    '把电脑屏幕上的一整片二维码放进取景框里，尽量横着拿手机、让画面对正屏幕。系统会自动锁定网格位置，两侧的布局选项保持一致即可。',
    [{ label: '开始扫描', primary: true, onClick: startCamera }],
    false
  );
  updateHud(Date.now());
})();
