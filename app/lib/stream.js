/*!
 * qrbeam — 流式传输的收发核心（与 DOM 无关，可在 Node 下测试）
 *
 * 发送端把文件切成 L 字节的源块，每 K 个源块组成一个"段"，段内做 LT 喷泉编码；
 * 屏幕上每一帧渲染 slots 个二维码，按段轮流取块，因此有效载荷在屏幕上均匀摊开，
 * 接收端无论何时把摄像头对准屏幕都能立刻开始推进所有段。
 *
 * 接收端完全无状态依赖：扫到任意一帧都能开始，靠记录头里的 fileId / segStart /
 * segK / seed 自描述地把自己接进正确的段。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  function dep(name, file) {
    return isNode ? require(file)[name] : root.QB[name];
  }
  var deps = {
    mix32: dep('mix32', './rand.js'),
    LtEncoder: dep('LtEncoder', './fountain.js'),
    LtDecoder: dep('LtDecoder', './fountain.js'),
    base45EncodedLength: dep('base45EncodedLength', './base45.js'),
    base45PayloadBytesForChars: dep('base45PayloadBytesForChars', './base45.js'),
    buildDataRecord: dep('buildDataRecord', './wire.js'),
    buildMetaRecord: dep('buildMetaRecord', './wire.js'),
    parseRecord: dep('parseRecord', './wire.js'),
    truncateUtf8: dep('truncateUtf8', './wire.js'),
    DATA_OVERHEAD: dep('DATA_OVERHEAD', './wire.js'),
    META_OVERHEAD: dep('META_OVERHEAD', './wire.js'),
    MAX_NAME_BYTES: dep('MAX_NAME_BYTES', './wire.js'),
  };
  var api = factory(deps);
  if (isNode) {
    module.exports = api;
  } else {
    root.QB = root.QB || {};
    for (var k in api) root.QB[k] = api[k];
  }
})(typeof self !== 'undefined' ? self : this, function (deps) {
  'use strict';

  var mix32 = deps.mix32;
  var LtEncoder = deps.LtEncoder;
  var LtDecoder = deps.LtDecoder;

  /** 单个发送会话同时保留的活跃段上限（防止异常输入打爆内存）。 */
  var MAX_ACTIVE_SEGMENTS = 2048;
  /** 活跃段里"尚在收集中的源块"总数上限：决定着方程组的常驻内存。 */
  var MAX_INFLIGHT_BLOCKS = 1 << 16;
  /** 单次传输允许的最大文件字节数。 */
  var MAX_TRANSFER_BYTES = 256 * 1024 * 1024;

  // =====================================================================
  // 发送端
  // =====================================================================

  /**
   * @param {object} opts
   * @param {Uint8Array} opts.fileBytes
   * @param {number} opts.fileId        0..65535
   * @param {number} opts.blockPayload  L，每源块字节数，必须是 4 的倍数
   * @param {number} opts.segKStd       标准段大小（源块数）
   * @param {number} opts.slots         每帧渲染的二维码数量
   * @param {number} opts.maxChars      单个二维码能容纳的字符数（由版本+纠错级决定）
   * @param {Uint8Array} [opts.sha256]  32 字节文件摘要
   * @param {Uint8Array} [opts.nameUtf8]
   * @param {number} [opts.metaEveryFrames=15] 每隔多少帧插播一次 META
   */
  function StreamSender(opts) {
    this.fileBytes = opts.fileBytes;
    this.fileId = opts.fileId & 0xffff;
    this.L = opts.blockPayload;
    this.segKStd = opts.segKStd;
    this.slots = Math.max(1, opts.slots | 0);
    this.maxChars = opts.maxChars;
    this.sha256 = opts.sha256 || new Uint8Array(32);
    this.nameUtf8 = opts.nameUtf8 || new Uint8Array(0);
    this.metaEveryFrames = opts.metaEveryFrames || 15;

    if (this.L < 4 || (this.L & 3) !== 0) throw new Error('blockPayload 必须是 >=4 且 4 的倍数');
    if (deps.base45EncodedLength(deps.DATA_OVERHEAD + this.L) > this.maxChars) {
      throw new Error('blockPayload 超过所选二维码容量');
    }

    this.totalSize = this.fileBytes.length;
    this.chunkCount = Math.max(1, Math.ceil(this.totalSize / this.L));
    this.segCount = Math.ceil(this.chunkCount / this.segKStd);
    // 线格式里段起始块号是 24 位，这是硬上限
    if (this.chunkCount > 0xffffff) {
      throw new Error('文件太大：源块数超过线格式上限（16777215 块）');
    }

    this._dst = new Uint32Array(this.L >> 2);
    this._payloadView = new Uint8Array(this._dst.buffer);
    this._encoders = Object.create(null);
    this._tail = null;
    this._dataScratch = new Uint8Array(deps.DATA_OVERHEAD + this.L);
    this._metaScratch = null;
    this._metaRecord = this._prepareMeta();
  }

  /** META 记录只需构造一次（内容恒定），同时按容量截断文件名。 */
  StreamSender.prototype._prepareMeta = function () {
    var budget = deps.base45PayloadBytesForChars(this.maxChars) - deps.META_OVERHEAD;
    if (budget < 0) throw new Error('二维码容量太小，放不下 META 记录');
    var nameBytes = this.nameUtf8;
    var limit = Math.min(budget, deps.MAX_NAME_BYTES);
    if (nameBytes.length > limit) nameBytes = deps.truncateUtf8(nameBytes, limit);
    this._nameBytes = nameBytes;
    var need = deps.META_OVERHEAD + nameBytes.length;
    this._metaScratch = new Uint8Array(need);
    return deps.buildMetaRecord({
      fileId: this.fileId,
      totalSize: this.totalSize,
      chunkCount: this.chunkCount,
      blockPayload: this.L,
      segKStd: this.segKStd,
      sha256: this.sha256,
      nameUtf8: nameBytes,
    }, this._metaScratch);
  };

  /**
   * 取某一帧里第 slot 个码的文本。
   *
   * 这里是纯函数式的：块内容只由 (frameIndex, slot) 决定，发送端不保存任何
   * 播放游标。因此渲染队列可以乱序预渲染、重复渲染同一帧（掉帧重绘）而不会
   * 破坏接收端的解码 —— 重放同一帧只是又给接收端一个线性相关的方程，无害。
   */
  StreamSender.prototype.recordFor = function (frameIndex, slot) {
    if (this.metaEveryFrames > 0 && slot === 0 && frameIndex % this.metaEveryFrames === 0) {
      return this._metaRecord;
    }
    return this._dataRecord(frameIndex * this.slots + slot);
  };

  /** 一整帧（slots 个二维码）的文本。 */
  StreamSender.prototype.buildFrame = function (frameIndex) {
    var out = new Array(this.slots);
    for (var i = 0; i < this.slots; i++) out[i] = this.recordFor(frameIndex, i);
    return out;
  };

  StreamSender.prototype._dataRecord = function (blockId) {
    var s = blockId % this.segCount;
    var segStart = s * this.segKStd;
    var k = Math.min(this.segKStd, this.chunkCount - segStart);
    var seed = mix32(blockId) & 0xffffff;

    var enc = this._encoders[k];
    if (!enc) enc = this._encoders[k] = new LtEncoder(k, this.L);
    enc.encode(seed, this._sourceWords(segStart, k), this._dst);

    return deps.buildDataRecord(
      this.fileId, segStart, k, seed, this._payloadView, this._dataScratch
    );
  };

  /**
   * 段在本段源块视图。文件内部段可以直接零拷贝映射到文件缓冲区；
   * 只有末尾不足一整段时才需要一次零填充拷贝（结果缓存复用）。
   */
  StreamSender.prototype._sourceWords = function (segStart, k) {
    var L = this.L;
    var off = segStart * L;
    var need = k * L;
    var fb = this.fileBytes;

    if (off + need <= this.totalSize) {
      var abs = fb.byteOffset + off;
      if ((abs & 3) === 0 && abs + need <= fb.buffer.byteLength) {
        return new Uint32Array(fb.buffer, abs, need >> 2);
      }
      var copy = new Uint8Array(need);
      copy.set(fb.subarray(off, off + need));
      return new Uint32Array(copy.buffer);
    }

    if (!this._tail || this._tail.start !== segStart) {
      var buf = new Uint8Array(need);
      var avail = Math.min(need, Math.max(0, this.totalSize - off));
      if (avail > 0) buf.set(fb.subarray(off, off + avail));
      this._tail = { start: segStart, words: new Uint32Array(buf.buffer) };
    }
    return this._tail.words;
  };

  /** 每帧的净荷字节数（用于向用户估算吞吐）。 */
  StreamSender.prototype.frameStats = function () {
    var dataSlots = this.slots;
    if (this.metaEveryFrames > 0) dataSlots = this.slots - 1 / this.metaEveryFrames;
    return {
      slots: this.slots,
      charsPerSlot: this.maxChars,
      payloadPerSlot: this.L,
      usefulBytesPerFrame: dataSlots * (this.L + deps.DATA_OVERHEAD),
      chunkCount: this.chunkCount,
      segCount: this.segCount,
      totalSize: this.totalSize,
    };
  };

  // =====================================================================
  // 接收端
  // =====================================================================

  function StreamReceiver() {
    this.onSegmentSolved = null;
    this.reset(-1);
  }

  StreamReceiver.prototype.reset = function (fileId) {
    this.fileId = typeof fileId === 'number' ? fileId : -1;
    this.meta = null;
    this.L = 0;
    this.segments = new Map();
    this.framesDecoded = 0;
    this._inflightBlocks = 0;
    this.stats = {
      records: 0,
      badRecord: 0,
      accepted: 0,
      redundant: 0,
      metaSeen: 0,
      segmentsSolved: 0,
    };
  };

  /**
   * 喂入一个 QR 码解出的文本（未识别的字符串会被安全忽略）。
   * @returns {boolean} 是否被采纳为有效记录
   */
  StreamReceiver.prototype.acceptText = function (text) {
    var rec = deps.parseRecord(text);
    this.stats.records++;
    if (!rec) {
      this.stats.badRecord++;
      return false;
    }

    if (rec.type === 'meta') {
      if (this.fileId !== rec.fileId) this.reset(rec.fileId);
      if (rec.blockPayload < 4 || (rec.blockPayload & 3) !== 0 || rec.segKStd < 1) {
        this.stats.badRecord++;
        return false;
      }
      // META 里的三组数字必须自洽，否则一个伪造的 totalSize 就能让接收端去分配
      // 一块巨大的缓冲区。chunkCount 由 totalSize 唯一决定，这里要求完全吻合。
      if (rec.totalSize > MAX_TRANSFER_BYTES) {
        this.stats.badRecord++;
        return false;
      }
      var expectedChunks = Math.max(1, Math.ceil(rec.totalSize / rec.blockPayload));
      if (expectedChunks !== rec.chunkCount) {
        this.stats.badRecord++;
        return false;
      }
      this.meta = rec;
      this.stats.metaSeen++;
      return true;
    }

    if (this.fileId !== rec.fileId) this.reset(rec.fileId);
    if (this.L === 0) {
      this.L = rec.payload.length;
    } else if (this.L !== rec.payload.length) {
      this.stats.badRecord++;
      return false;
    }

    var seg = this.segments.get(rec.segStart);
    if (!seg) {
      if (this.segments.size >= MAX_ACTIVE_SEGMENTS ||
          this._inflightBlocks + rec.segK > MAX_INFLIGHT_BLOCKS) {
        this.stats.badRecord++;
        return false;
      }
      seg = { k: rec.segK, decoder: new LtDecoder(rec.segK, this.L), data: null, solved: false };
      this.segments.set(rec.segStart, seg);
      this._inflightBlocks += rec.segK;
    } else if (seg.k !== rec.segK && !seg.solved) {
      // 发送端换了段参数，重建该段的解码器
      this._inflightBlocks += rec.segK - seg.k;
      seg.k = rec.segK;
      seg.decoder = new LtDecoder(rec.segK, this.L);
    }

    if (seg.solved) {
      this.stats.redundant++;
      return false;
    }

    var res = seg.decoder.add(rec.seed, rec.payload);
    if (res === 'redundant') {
      this.stats.redundant++;
      return false;
    }
    this.stats.accepted++;
    if (res === 'complete') {
      seg.data = new Uint8Array(seg.decoder.source.buffer);
      seg.decoder = null;
      seg.solved = true;
      this._inflightBlocks -= seg.k;
      this.stats.segmentsSolved++;
      if (this.onSegmentSolved) this.onSegmentSolved(rec.segStart);
    }
    return true;
  };

  StreamReceiver.prototype.segCount = function () {
    if (!this.meta) return 0;
    return Math.ceil(this.meta.chunkCount / this.meta.segKStd);
  };

  StreamReceiver.prototype.isComplete = function () {
    if (!this.meta || this.L === 0) return false;
    var total = this.segCount();
    for (var s = 0; s < total; s++) {
      var seg = this.segments.get(s * this.meta.segKStd);
      if (!seg || !seg.solved) return false;
    }
    return true;
  };

  /** 进度：已确认收货的字节数 / 总字节数。 */
  StreamReceiver.prototype.progress = function () {
    var L = this.L;
    var totalBytes = this.meta ? this.meta.totalSize : 0;
    var bytes = 0;
    var solvedSegments = 0;
    var totalSegments = 0;

    if (this.meta && L > 0) {
      totalSegments = this.segCount();
      for (var s = 0; s < totalSegments; s++) {
        var start = s * this.meta.segKStd;
        var seg = this.segments.get(start);
        if (!seg || !seg.solved) continue;
        solvedSegments++;
        var from = start * L;
        var to = Math.min((start + seg.k) * L, totalBytes);
        if (to > from) bytes += to - from;
      }
    }

    return {
      bytes: bytes,
      totalBytes: totalBytes,
      solvedSegments: solvedSegments,
      totalSegments: totalSegments,
      fraction: totalBytes > 0 ? bytes / totalBytes : 0,
    };
  };

  /**
   * 当前仍在收集中的各段完成度，用于显示"正在推进"的细节。
   * @returns {{active:number, bestFraction:number, rank:number, k:number}[]}
   */
  StreamReceiver.prototype.segmentDetail = function () {
    var out = [];
    this.segments.forEach(function (seg) {
      if (seg.solved || !seg.decoder) return;
      out.push({ k: seg.k, rank: seg.decoder.rank, fraction: seg.k ? seg.decoder.rank / seg.k : 0 });
    });
    out.sort(function (a, b) { return b.fraction - a.fraction; });
    return out.slice(0, 4);
  };

  /** 拼装完整文件；未完成时返回 null。 */
  StreamReceiver.prototype.assemble = function () {
    if (!this.isComplete()) return null;
    var meta = this.meta;
    var L = this.L;
    var out = new Uint8Array(meta.totalSize);
    this.segments.forEach(function (seg, start) {
      if (!seg.solved || !seg.data) return;
      var off = start * L;
      var room = meta.totalSize - off;
      if (room <= 0) return;
      out.set(seg.data.subarray(0, Math.min(seg.data.length, room)), off);
    });
    return out;
  };

  return {
    StreamSender: StreamSender,
    StreamReceiver: StreamReceiver,
  };
});
