/*!
 * qrbeam — CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF)
 *
 * 每个光帧都在末尾带 2 字节 CRC。屏摄信道里"读到一半"的帧非常常见，
 * CRC 让接收端能在解码后立刻、廉价地丢掉这些残帧，避免污染喷泉码方程组。
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

  var TABLE = new Uint16Array(256);
  (function () {
    for (var i = 0; i < 256; i++) {
      var crc = i << 8;
      for (var b = 0; b < 8; b++) {
        crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
      }
      TABLE[i] = crc;
    }
  })();

  /**
   * @param {Uint8Array} buf
   * @param {number} [off]
   * @param {number} [len]
   * @returns {number} 0..65535
   */
  function crc16(buf, off, len) {
    if (off === undefined) off = 0;
    if (len === undefined) len = buf.length - off;
    var crc = 0xffff;
    var end = off + len;
    for (var i = off; i < end; i++) {
      crc = ((crc << 8) ^ TABLE[((crc >> 8) ^ buf[i]) & 0xff]) & 0xffff;
    }
    return crc;
  }

  return { crc16: crc16 };
});
