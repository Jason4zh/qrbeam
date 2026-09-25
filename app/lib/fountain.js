/*!
 * qrbeam — LT 喷泉码（Luby Transform）
 *
 * 为什么是喷泉码：屏幕→摄像头是纯单向广播，接收端没有任何反向信道可以
 * 请求重传，而且屏摄一定会丢帧（相机帧率与屏幕刷新不同步、瞬时失焦、
 * 运动模糊）。喷泉码让发送端持续播撒"随机线性组合"的编码块，接收端只要
 * 累计到 K 个线性无关的方程就能还原出全部 K 个源块 —— 丢帧不再需要重传，
 * 只是多等几帧而已。这也让接收端可以在任意时刻中途加入。
 *
 * 度分布用标准的 Robust Soliton，配合 GF(2) 上的在线高斯消元解码。
 * 解码器是增量式的：每收到一块就消元一次，因此接收过程中内存和耗时都
 * 是平滑的，不会在末尾出现一次很长的停顿。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var deps = isNode
    ? { splitmix32: require('./rand.js').splitmix32 }
    : { splitmix32: root.QB.splitmix32 };
  var api = factory(deps);
  if (isNode) {
    module.exports = api;
  } else {
    root.QB = root.QB || {};
    for (var k in api) root.QB[k] = api[k];
  }
})(typeof self !== 'undefined' ? self : this, function (deps) {
  'use strict';

  var _splitmix32 = deps.splitmix32;

  var C = 0.03;      // Robust Soliton 的 c
  var DELTA = 0.5;   // 允许的失败概率上界

  var cdfCache = Object.create(null);

  /**
   * Robust Soliton 分布的累积分布函数 cdf[1..K]。
   * 结果按 K 缓存，因为发送端和接收端都只会在少数几个 K 之间切换。
   */
  function robustSolitonCdf(K) {
    var cached = cdfCache[K];
    if (cached) return cached;

    var R = C * Math.log(K / DELTA) * Math.sqrt(K);
    if (!(R > 0)) R = 1;
    var spike = Math.round(K / R);
    if (spike < 1) spike = 1;
    if (spike > K) spike = K;

    var cdf = new Float64Array(K + 1);
    var sum = 0;
    var d;
    for (d = 1; d <= K; d++) {
      var rho = d === 1 ? 1 / K : 1 / (d * (d - 1));
      var tau = 0;
      if (d < spike) {
        tau = R / (d * K);
      } else if (d === spike) {
        tau = Math.max(0, (R * Math.log(R / DELTA)) / K);
      }
      sum += rho + tau;
      cdf[d] = sum;
    }
    for (d = 1; d <= K; d++) cdf[d] /= sum;
    cdf[K] = 1; // 吸收浮点误差

    cdfCache[K] = cdf;
    return cdf;
  }

  /** 从 cdf 里二分采样一个度（1..K）。 */
  function sampleDegree(rng, cdf, K) {
    var r = (rng() >>> 0) / 4294967296;
    var lo = 1;
    var hi = K;
    while (lo < hi) {
      var mid = (lo + hi) >>> 1;
      if (cdf[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * 均匀采样 d 个互不相同的 [0,K) 索引。
   * 用拒绝采样 + 复用标记数组，平均尝试次数 O(K·ln(K/(K-d)))，实测远低于 d 的常数倍。
   */
  function pickNeighbors(rng, K, d, marks, out) {
    if (d > K) d = K;
    for (var i = 0; i < d; i++) {
      var t = rng() % K;
      while (marks[t]) t = rng() % K;
      marks[t] = 1;
      out[i] = t;
    }
    for (var j = 0; j < d; j++) marks[out[j]] = 0;
    return d;
  }

  var WARMUP = 2; // 丢掉前两个输出，切断 seed 与首个随机数的弱相关

  // ---------------------------------------------------------------------
  // 编码端
  // ---------------------------------------------------------------------

  /**
   * @param {number} K       源块数量
   * @param {number} blockLen 每块字节数，必须是 4 的倍数（内部按 Uint32 异或）
   */
  function LtEncoder(K, blockLen) {
    this.reset(K, blockLen);
  }

  LtEncoder.prototype.reset = function (K, blockLen) {
    this.K = K;
    this.blockLen = blockLen;
    this.lWords = blockLen >>> 2;
    this.cdf = robustSolitonCdf(K);
    this._marks = new Uint8Array(K);
    this._idx = new Uint32Array(K);
    this.degree = 0;
    return this;
  };

  /**
   * 生成 seed 对应的一个编码块。
   * @param {number} seed      24 位种子
   * @param {Uint32Array} srcWords  长度 K * lWords
   * @param {Uint32Array} dstWords  长度 lWords（会被覆盖）
   * @returns {number} 该块的度
   */
  LtEncoder.prototype.encode = function (seed, srcWords, dstWords) {
    var rng = _splitmix32(seed);
    for (var w = 0; w < WARMUP; w++) rng();
    var d = sampleDegree(rng, this.cdf, this.K);
    d = pickNeighbors(rng, this.K, d, this._marks, this._idx);

    var lw = this.lWords;
    var idx = this._idx;
    var base = idx[0] * lw;
    dstWords.set(srcWords.subarray(base, base + lw));
    for (var i = 1; i < d; i++) {
      var off = idx[i] * lw;
      for (var k = 0; k < lw; k++) dstWords[k] ^= srcWords[off + k];
    }
    this.degree = d;
    return d;
  };

  // ---------------------------------------------------------------------
  // 解码端
  // ---------------------------------------------------------------------

  function xorWords(a, b) {
    for (var i = 0; i < a.length; i++) a[i] ^= b[i];
  }

  /**
   * @param {number} K
   * @param {number} blockLen 4 的倍数
   */
  function LtDecoder(K, blockLen) {
    this.reset(K, blockLen);
  }

  LtDecoder.prototype.reset = function (K, blockLen) {
    this.K = K;
    this.blockLen = blockLen;
    this.lWords = blockLen >>> 2;
    this.kWords = (K + 31) >>> 5;
    this.cdf = robustSolitonCdf(K);
    this._marks = new Uint8Array(K);
    this._idx = new Uint32Array(K);
    this.pivot = new Array(K);
    for (var i = 0; i < K; i++) this.pivot[i] = null;
    this.rank = 0;
    this.solved = false;
    // 源块缓冲延迟到真正解出时再分配：未完成的段只占方程组的内存。
    this.source = null;
    this.received = 0;
    return this;
  };

  /**
   * 加入一个编码块。
   * @param {number} seed
   * @param {Uint8Array} payload 长度必须等于 blockLen
   * @returns {'ok'|'redundant'|'complete'|'solved'}
   */
  LtDecoder.prototype.add = function (seed, payload) {
    if (this.solved) return 'solved';
    if (payload.length !== this.blockLen) throw new Error('bad block length');

    var K = this.K;
    var kWords = this.kWords;
    var lWords = this.lWords;
    this.received++;

    var bits = new Uint32Array(kWords);
    var data = new Uint32Array(lWords);
    new Uint8Array(data.buffer).set(payload);

    var rng = _splitmix32(seed);
    for (var w = 0; w < WARMUP; w++) rng();
    var d = pickNeighbors(rng, K, sampleDegree(rng, this.cdf, K), this._marks, this._idx);
    for (var i = 0; i < d; i++) {
      var c = this._idx[i];
      bits[c >>> 5] |= 1 << (c & 31);
    }

    // 前向消元：顺序扫描一遍即可。pivot[c] 的最低置位是 c，所以消掉 c 位
    // 不会重新引入 < c 的位，无需回头重扫。
    var piv = this.pivot;
    for (var col = 0; col < K; col++) {
      if (!(bits[col >>> 5] & (1 << (col & 31)))) continue;
      var row = piv[col];
      if (!row) continue;
      xorWords(bits, row.bits);
      xorWords(data, row.data);
    }

    var p = -1;
    for (var w2 = 0; w2 < kWords; w2++) {
      if (bits[w2]) {
        var low = bits[w2];
        p = (w2 << 5) + (31 - Math.clz32(low & -low));
        break;
      }
    }
    if (p < 0) return 'redundant';

    piv[p] = { bits: bits, data: data };
    this.rank++;

    if (this.rank === K) {
      this._solve();
      this.solved = true;
      return 'complete';
    }
    return 'ok';
  };

  /** 回代：从最高的 pivot 列往下，把每行化简成只有一个 1。 */
  LtDecoder.prototype._solve = function () {
    var K = this.K;
    var lWords = this.lWords;
    var kWords = this.kWords;
    var piv = this.pivot;
    if (!this.source) this.source = new Uint32Array(K * lWords);
    var source = this.source;

    for (var c = K - 1; c >= 0; c--) {
      var row = piv[c];
      if (!row) continue;
      var bits = row.bits;
      var data = row.data;
      for (var w = 0; w < kWords; w++) {
        var m = bits[w];
        while (m) {
          var low = m & -m;
          var d = (w << 5) + (31 - Math.clz32(low));
          m ^= low;
          if (d === c) continue;
          var other = piv[d];
          if (!other) continue; // 满秩时不会发生
          xorWords(bits, other.bits);
          xorWords(data, other.data);
          m = bits[w];
        }
      }
      source.set(data, c * lWords);
    }
  };

  /** 解出的第 i 个源块（Uint32Array 视图）。需在 solved 后调用。 */
  LtDecoder.prototype.sourceBlock = function (i) {
    var lw = this.lWords;
    return this.source.subarray(i * lw, (i + 1) * lw);
  };

  return {
    LtEncoder: LtEncoder,
    LtDecoder: LtDecoder,
  };
});
