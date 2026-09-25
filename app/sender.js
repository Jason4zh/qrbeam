/*!
 * qrbeam — 发送端
 *
 * 屏幕上按网格紧铺若干个二维码，每一帧的每个码都携带一个喷泉编码块。
 * 因为块内容只由 (帧号, 槽位) 决定，发送端没有播放游标，可以放心地提前
 * 预渲染、在 Worker 里并行生成、甚至重放旧帧。
 */
/* global QB */

(function () {
  'use strict';

  var AHEAD = 4;                 // 预渲染缓冲的帧数
  var MIN_MODULE_PX = 3;         // 屏幕上每模块至少几个像素
  var MAX_FILE = 64 * 1024 * 1024;

  var GRIDS = [
    { id: '1x1', cols: 1, rows: 1, label: '1 个码 · 最稳' },
    { id: '2x1', cols: 2, rows: 1, label: '2 个码 · 横排' },
    { id: '1x2', cols: 1, rows: 2, label: '2 个码 · 竖排' },
    { id: '2x2', cols: 2, rows: 2, label: '4 个码 · 推荐' },
    { id: '3x1', cols: 3, rows: 1, label: '3 个码 · 横排' },
    { id: '2x3', cols: 2, rows: 3, label: '6 个码 · 竖排' },
    { id: '3x2', cols: 3, rows: 2, label: '6 个码 · 横排' },
    { id: '4x2', cols: 4, rows: 2, label: '8 个码 · 极速' },
  ];

  var VERSIONS = [8, 10, 12, 15, 20, 25, 30, 35, 40];
  var LEVELS = ['L', 'M', 'Q', 'H'];
  var SEG_KS = [128, 256, 512, 1024];

  var el = {};
  [
    'screen', 'stage', 'dropzone', 'file', 'pick', 'grid', 'version', 'level', 'fps',
    'fpsOut', 'segk', 'start', 'stats', 'banner',
  ].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  var state = {
    fileBytes: null,
    fileName: '',
    fileId: 0,
    sender: null,
    layout: null,
    playing: false,
    nextFrame: 0,
    queue: [],
    inflight: 0,
    shown: 0,
    startedAt: 0,
    ticker: null,
    pumper: null,
    renderer: null,
    lastError: null,
  };

  var ctx = el.screen.getContext('2d');

  // ------------------------------------------------------------------
  // 渲染器：优先用 Worker（不阻塞主线程），不可用时退回主线程
  // ------------------------------------------------------------------

  function makeWorkerRenderer() {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
    // file:// 下 Worker 与 importScripts 会被同源策略拦住，直接用主线程渲染
    if (typeof location !== 'undefined' && location.protocol === 'file:') return null;
    var count = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
    var workers = [];
    var pending = Object.create(null);
    var nextId = 1;
    var rr = 0;

    for (var i = 0; i < count; i++) {
      var w;
      try {
        w = new Worker('app/sender-worker.js');
      } catch (e) {
        if (!workers.length) return null;
        break;
      }
      w.onmessage = function (e) {
        var m = e.data;
        if (!m) return;
        var res = pending[m.id];
        if (!res) return;
        delete pending[m.id];
        if (m.type === 'error') res.reject(new Error(m.message));
        else res.resolve(m.bitmap);
      };
      w.onerror = function () {
        // Worker 挂了：放弃剩下的任务，让 UI 退回主线程
        Object.keys(pending).forEach(function (id) {
          pending[id].reject(new Error('worker failed'));
          delete pending[id];
        });
      };
      workers.push(w);
    }
    if (!workers.length) return null;

    return {
      kind: 'worker',
      render: function (texts, layout, opts) {
        return new Promise(function (resolve, reject) {
          var id = nextId++;
          pending[id] = { resolve: resolve, reject: reject };
          workers[rr++ % workers.length].postMessage({
            type: 'render', id: id, texts: texts, layout: layout, opts: opts,
          });
        });
      },
      destroy: function () {
        workers.forEach(function (w) { w.terminate(); });
      },
    };
  }

  function makeMainRenderer() {
    var pool = [];
    return {
      kind: 'main',
      render: function (texts, layout, opts) {
        return new Promise(function (resolve) {
          var cv = pool.pop() || document.createElement('canvas');
          QB.qrRenderFrame(cv.getContext('2d'), texts, layout, opts);
          resolve(cv);
        });
      },
      release: function (cv) {
        if (pool.length < 4) pool.push(cv);
      },
      destroy: function () {},
    };
  }

  function ensureRenderer() {
    if (state.renderer) return state.renderer;
    state.renderer = makeWorkerRenderer() || makeMainRenderer();
    return state.renderer;
  }

  // ------------------------------------------------------------------
  // 布局与参数
  // ------------------------------------------------------------------

  function currentGrid() {
    var id = el.grid.value;
    for (var i = 0; i < GRIDS.length; i++) if (GRIDS[i].id === id) return GRIDS[i];
    return GRIDS[3];
  }

  function availableBox() {
    return {
      w: Math.max(120, el.stage.clientWidth - 40),
      h: Math.max(120, el.stage.clientHeight - 40),
    };
  }

  /** 在给定布局下，选一个"屏幕上每模块像素足够、同时容量尽量大"的版本。 */
  function recommendVersion() {
    var g = currentGrid();
    var box = availableBox();
    var best = VERSIONS[0];
    for (var i = 0; i < VERSIONS.length; i++) {
      var v = VERSIONS[i];
      var side = v * 4 + 17 + 8;
      var scale = Math.floor(Math.min(box.w / (g.cols * side), box.h / (g.rows * side)));
      if (scale >= MIN_MODULE_PX) best = v;
    }
    return best;
  }

  function computeLayout() {
    var g = currentGrid();
    var box = availableBox();
    return QB.qrLayout({
      version: parseInt(el.version.value, 10),
      cols: g.cols,
      rows: g.rows,
      availW: box.w,
      availH: box.h,
      quiet: QB.QR_DEFAULT_QUIET,
    });
  }

  function blockPayloadFor(version, level) {
    var maxChars = QB.QR_CAPACITY[level][version];
    return {
      maxChars: maxChars,
      payload: (QB.base45PayloadBytesForChars(maxChars) - QB.DATA_OVERHEAD) & ~3,
    };
  }

  // ------------------------------------------------------------------
  // 提示条
  // ------------------------------------------------------------------

  function banner(text, kind) {
    if (!text) {
      el.banner.className = 'banner';
      el.banner.textContent = '';
      return;
    }
    el.banner.className = 'banner show' + (kind ? ' ' + kind : '');
    el.banner.textContent = text;
  }

  // ------------------------------------------------------------------
  // 组装发送器
  // ------------------------------------------------------------------

  function buildSender() {
    if (!state.fileBytes) return null;
    var g = currentGrid();
    var version = parseInt(el.version.value, 10);
    var level = el.level.value;
    var info = blockPayloadFor(version, level);

    if (info.payload < 8) {
      banner('这个二维码容量太小，装不下一个数据块。请提高版本或降低纠错级别。', 'err');
      return null;
    }

    var sender;
    try {
      sender = new QB.StreamSender({
        fileBytes: state.fileBytes,
        fileId: state.fileId,
        blockPayload: info.payload,
        segKStd: parseInt(el.segk.value, 10),
        slots: g.cols * g.rows,
        maxChars: info.maxChars,
        sha256: state.sha256 || new Uint8Array(32),
        nameUtf8: new TextEncoder().encode(state.fileName || 'qrbeam.bin'),
        metaEveryFrames: 15,
      });
    } catch (err) {
      banner('参数不合法：' + err.message, 'err');
      return null;
    }
    return sender;
  }

  function applyLayoutToCanvas(layout) {
    el.screen.width = layout.width;
    el.screen.height = layout.height;
    el.screen.style.width = layout.width + 'px';
    el.screen.style.height = layout.height + 'px';
  }

  function rebuild() {
    stop();
    if (!state.fileBytes) return;
    var sender = buildSender();
    if (!sender) {
      state.sender = null;
      showDropzone(true);
      return;
    }
    state.sender = sender;
    showDropzone(false);
    state.layout = computeLayout();
    state.nextFrame = 0;
    state.queue = [];
    state.inflight = 0;
    state.shown = 0;
    applyLayoutToCanvas(state.layout);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, state.layout.width, state.layout.height);

    var g = currentGrid();
    var modPx = state.layout.moduleScale;
    var msg = '';
    if (modPx < MIN_MODULE_PX) {
      msg = '屏幕装不下这么多码：现在每模块只有 ' + modPx + ' 像素，手机上会很难识别。减少码数或降低版本。';
    } else if (sender.totalSize > 0) {
      msg = '';
    }
    banner(msg, 'warn');
    updateStats();
    renderIdleFrame();
  }

  /** 未开始播放时，先渲染第 0 帧并停在那儿，让用户可以先对准。 */
  function renderIdleFrame() {
    if (!state.sender || !state.layout) return;
    var texts = state.sender.buildFrame(0);
    QB.qrRenderFrame(ctx, texts, state.layout, { ecl: el.level.value });
  }

  // ------------------------------------------------------------------
  // 播放循环
  // ------------------------------------------------------------------

  function pump() {
    if (!state.playing || !state.sender) return;
    var renderer = ensureRenderer();
    var opts = { ecl: el.level.value };
    while (state.queue.length + state.inflight < AHEAD) {
      var idx = state.nextFrame++;
      var texts;
      try {
        texts = state.sender.buildFrame(idx);
      } catch (e) {
        banner('生成数据块失败：' + e.message, 'err');
        stop();
        return;
      }
      state.inflight++;
      renderer
        .render(texts, state.layout, opts)
        .then(function (drawable) {
          state.inflight--;
          state.queue.push(drawable);
        })
        .catch(function (err) {
          state.inflight--;
          if (state.playing && !state.lastError) {
            state.lastError = String(err && err.message ? err.message : err);
            banner('预渲染出错，已退回主线程渲染：' + state.lastError, 'warn');
            if (state.renderer && state.renderer.kind === 'worker') state.renderer.destroy();
            state.renderer = makeMainRenderer();
          }
        });
    }
  }

  function tick() {
    if (!state.playing) return;
    var drawable = state.queue.shift();
    if (drawable) {
      if (drawable.width !== el.screen.width || drawable.height !== el.screen.height) {
        applyLayoutToCanvas({ width: drawable.width, height: drawable.height });
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(drawable, 0, 0);
      if (drawable.close) drawable.close();
      else if (state.renderer && state.renderer.release) state.renderer.release(drawable);
      state.shown++;
    }
    pump();
    updateStats();
  }

  function start() {
    if (!state.sender || state.playing) return;
    state.playing = true;
    state.startedAt = state.startedAt || Date.now();
    state.lastError = null;
    el.start.textContent = '暂停';
    banner('');
    pump();
    state.ticker = setInterval(tick, Math.max(30, Math.round(1000 / parseInt(el.fps.value, 10))));
  }

  function stop() {
    state.playing = false;
    if (state.ticker) clearInterval(state.ticker);
    state.ticker = null;
    el.start.textContent = '开始投射';
    state.queue = [];
    state.inflight = 0;
  }

  // ------------------------------------------------------------------
  // 统计
  // ------------------------------------------------------------------

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function updateStats() {
    var rows = [];
    var sender = state.sender;
    var g = currentGrid();

    if (state.fileBytes) {
      rows.push(['文件', state.fileName]);
      rows.push(['大小', fmtBytes(state.fileBytes.length)]);
    }
    if (sender && state.layout) {
      var fps = parseInt(el.fps.value, 10);
      var perFrame = (sender.L + QB.DATA_OVERHEAD) * g.cols * g.rows;
      var effFps = fps * (1 - 1 / sender.metaEveryFrames);
      var kbps = (perFrame * effFps) / 1024;
      rows.push(['每码字符数', String(sender.maxChars)]);
      rows.push(['每块净荷', sender.L + ' B']);
      rows.push(['源块数', String(sender.chunkCount)]);
      rows.push(['分段数', String(sender.segCount)]);
      rows.push(['屏上每模块', state.layout.moduleScale + ' px']);
      rows.push(['理论速率', kbps.toFixed(1) + ' KB/s']);
      rows.push(['已投射', state.shown + ' 帧']);
    }

    el.stats.textContent = '';
    rows.forEach(function (r) {
      var line = document.createElement('div');
      line.className = 'line';
      var k = document.createElement('span');
      k.textContent = r[0];
      var v = document.createElement('b');
      v.textContent = r[1];
      line.appendChild(k);
      line.appendChild(v);
      el.stats.appendChild(line);
    });
  }

  function showDropzone(show) {
    el.dropzone.style.display = show ? '' : 'none';
    el.start.disabled = show;
  }

  // ------------------------------------------------------------------
  // 文件读取
  // ------------------------------------------------------------------

  function sha256Of(bytes) {
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
      return crypto.subtle
        .digest('SHA-256', bytes)
        .then(function (d) { return new Uint8Array(d); })
        .catch(function () { return new Uint8Array(32); });
    }
    return Promise.resolve(new Uint8Array(32));
  }

  function loadFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE) {
      banner('文件超过 ' + fmtBytes(MAX_FILE) + '，光信道传这么大的文件不现实。', 'err');
      return;
    }
    banner('正在读取文件…');
    file
      .arrayBuffer()
      .then(function (buf) {
        state.fileBytes = new Uint8Array(buf);
        state.fileName = file.name || 'qrbeam.bin';
        state.fileId = Math.floor(Math.random() * 65536);
        state.startedAt = 0;
        return sha256Of(state.fileBytes);
      })
      .then(function (hash) {
        state.sha256 = hash;
        rebuild();
      })
      .catch(function (err) {
        banner('读取失败：' + err.message, 'err');
      });
  }

  // ------------------------------------------------------------------
  // 事件绑定
  // ------------------------------------------------------------------

  function fillSelects() {
    el.grid.innerHTML = GRIDS.map(function (g) {
      return '<option value="' + g.id + '">' + g.label + '</option>';
    }).join('');
    el.grid.value = '2x2';

    el.version.innerHTML = VERSIONS.map(function (v) {
      return '<option value="' + v + '">版本 ' + v + '（' + (v * 4 + 17) + '×' + (v * 4 + 17) + ' 模块）</option>';
    }).join('');

    el.level.innerHTML = LEVELS.map(function (l) {
      var names = { L: 'L · 7%', M: 'M · 15%', Q: 'Q · 25%', H: 'H · 30%' };
      return '<option value="' + l + '">纠错 ' + names[l] + '</option>';
    }).join('');
    el.level.value = 'L';

    el.segk.innerHTML = SEG_KS.map(function (k) {
      return '<option value="' + k + '">' + k + ' 块</option>';
    }).join('');
    el.segk.value = '512';

    el.version.value = String(recommendVersion());
  }

  el.pick.addEventListener('click', function () { el.file.click(); });
  el.file.addEventListener('change', function () {
    if (el.file.files && el.file.files[0]) loadFile(el.file.files[0]);
  });

  ['dragenter', 'dragover'].forEach(function (t) {
    el.stage.addEventListener(t, function (e) {
      e.preventDefault();
      el.dropzone.classList.add('dragging');
      el.dropzone.style.display = '';
    });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    el.stage.addEventListener(t, function (e) {
      e.preventDefault();
      el.dropzone.classList.remove('dragging');
      if (t === 'dragleave' && state.fileBytes) el.dropzone.style.display = 'none';
    });
  });
  el.stage.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
      loadFile(e.dataTransfer.files[0]);
    }
  });

  el.grid.addEventListener('change', function () {
    // 换布局后屏幕上每个码分到的空间变了，顺手给一个装得下的版本
    el.version.value = String(recommendVersion());
    rebuild();
  });

  ['version', 'level', 'segk'].forEach(function (id) {
    el[id].addEventListener('change', rebuild);
  });

  el.fps.addEventListener('input', function () {
    el.fpsOut.textContent = el.fps.value + ' fps';
    if (state.playing) {
      clearInterval(state.ticker);
      state.ticker = setInterval(tick, Math.max(30, Math.round(1000 / parseInt(el.fps.value, 10))));
    }
    updateStats();
  });

  el.start.addEventListener('click', function () {
    if (state.playing) stop();
    else start();
  });

  window.addEventListener('resize', debounce(function () {
    if (!state.sender) return;
    var lay = computeLayout();
    if (lay.width === state.layout.width && lay.height === state.layout.height) return;
    // 画布尺寸变了必须重建；顺手把播放状态保留下来
    var resume = state.playing;
    rebuild();
    if (resume) start();
  }, 250));

  function debounce(fn, ms) {
    var t = 0;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state.playing) stop();
  });

  // ------------------------------------------------------------------
  // 启动
  // ------------------------------------------------------------------

  fillSelects();
  el.fpsOut.textContent = el.fps.value + ' fps';
  showDropzone(true);
  updateStats();
})();
