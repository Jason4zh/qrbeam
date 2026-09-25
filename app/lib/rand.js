/*!
 * qrbeam — 确定性伪随机数发生器（splitmix32）
 *
 * 喷泉码的每个编码块只带一个 24 位 seed，发送端和接收端用同一份 PRNG
 * 从 seed 复现出"这个块由哪些源块异或而来"。因此 PRNG 必须完全确定、
 * 跨平台一致（只用 32 位整数运算），且相邻 seed 的输出不能相关。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.QB = root.QB || {};
    for (var k in api) root.QB[k] = api[k];
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * splitmix32：雪崩性好、无乘法溢出陷阱（用的是 Math.imul 的 32 位乘法）。
   * @param {number} seed 任意 32 位整数
   * @returns {function(): number} 每次调用返回 [0, 2^32) 的整数
   */
  function splitmix32(seed) {
    var a = seed | 0;
    return function () {
      a = (a + 0x9e3779b9) | 0;
      var t = a ^ (a >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t = t ^ (t >>> 15);
      t = Math.imul(t, 0x735a2d97);
      t = t ^ (t >>> 15);
      return t >>> 0;
    };
  }

  /** 32 位混合函数，用于把线性递增的块序号打散成互不相关的 seed。 */
  function mix32(x) {
    x = (x | 0) ^ 0x9e3779b9;
    x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
    x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
    return (x ^ (x >>> 15)) >>> 0;
  }

  return { splitmix32: splitmix32, mix32: mix32 };
});
