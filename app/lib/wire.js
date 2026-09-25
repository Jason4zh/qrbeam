/*!
 * qrbeam — 光帧线格式
 *
 * 每一个 QR 码都是一条"自描述"的记录，接收端不需要任何握手或先验状态，
 * 扫到任意一帧就能开始工作（这对单向广播 + 中途加入非常重要）。
 *
 *   DATA 记录（承载喷泉码的一个编码块）
 *     0      type = 1
 *     1..2   fileId      传输会话标识（uint16 LE）
 *     3..5   segStart    本段第一个源块的全局下标（uint24 LE）
 *     6..7   segK        本段源块数量（uint16 LE）
 *     8..10  seed        喷泉码种子（uint24 LE）
 *     11..   payload     segK 个源块的一个随机线性组合
 *     尾 2   CRC16      覆盖本记录除 CRC 外的全部字节
 *
 *   META 记录（文件名、总长、摘要；周期性插播）
 *     0      type = 2
 *     1..2   fileId
 *     3..6   totalSize   文件字节数（uint32 LE）
 *     7..10  chunkCount  源块总数（uint32 LE）
 *     11..12 blockPayload 每个源块的字节数 L（uint16 LE）
 *     13..14 segKStd     标准段大小（uint16 LE）
 *     15..46 sha256      文件摘要前 32 字节
 *     47     nameLen     UTF-8 文件名的字节数
 *     48..   name
 *     尾 2   CRC16
 *
 * L 不需要单独协商：接收端从 Base45 解出的记录长度减去固定开销即可得到，
 * 并且 Base45 的字符数 <-> 字节数是双射，不存在歧义。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var deps = isNode
    ? {
        base45Encode: require('./base45.js').base45Encode,
        base45Decode: require('./base45.js').base45Decode,
        crc16: require('./crc16.js').crc16,
      }
    : {
        base45Encode: root.QB.base45Encode,
        base45Decode: root.QB.base45Decode,
        crc16: root.QB.crc16,
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

  var base45Encode = deps.base45Encode;
  var base45Decode = deps.base45Decode;
  var crc16 = deps.crc16;

  var TYPE_DATA = 1;
  var TYPE_META = 2;

  var DATA_HEADER = 11;
  var CRC_LEN = 2;
  var DATA_OVERHEAD = DATA_HEADER + CRC_LEN; // 13
  var META_FIXED = 48;
  var META_OVERHEAD = META_FIXED + CRC_LEN;

  var MAX_NAME_BYTES = 255;

  function writeU16(buf, off, v) {
    buf[off] = v & 0xff;
    buf[off + 1] = (v >>> 8) & 0xff;
  }
  function readU16(buf, off) {
    return buf[off] | (buf[off + 1] << 8);
  }
  function writeU24(buf, off, v) {
    buf[off] = v & 0xff;
    buf[off + 1] = (v >>> 8) & 0xff;
    buf[off + 2] = (v >>> 16) & 0xff;
  }
  function readU24(buf, off) {
    return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
  }
  function writeU32(buf, off, v) {
    buf[off] = v & 0xff;
    buf[off + 1] = (v >>> 8) & 0xff;
    buf[off + 2] = (v >>> 16) & 0xff;
    buf[off + 3] = (v >>> 24) & 0xff;
  }
  function readU32(buf, off) {
    return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
  }

  function finishRecord(buf, len) {
    var crc = crc16(buf, 0, len);
    buf[len] = crc & 0xff;
    buf[len + 1] = (crc >>> 8) & 0xff;
    return base45Encode(buf.subarray(0, len + CRC_LEN));
  }

  /**
   * 构造一条 DATA 记录并编码成可放进 QR 的字符串。
   * @param {number} fileId
   * @param {number} segStart 全局源块下标
   * @param {number} segK     本段源块数
   * @param {number} seed
   * @param {Uint8Array} payload 长度必须等于全局的 L
   * @param {Uint8Array} [scratch] 复用的缓冲区（长度 >= 13 + L）
   */
  function buildDataRecord(fileId, segStart, segK, seed, payload, scratch) {
    var len = DATA_HEADER + payload.length;
    var need = len + CRC_LEN;
    var buf = scratch && scratch.length >= need ? scratch : new Uint8Array(need);
    buf[0] = TYPE_DATA;
    writeU16(buf, 1, fileId);
    writeU24(buf, 3, segStart);
    writeU16(buf, 6, segK);
    writeU24(buf, 8, seed);
    buf.set(payload, DATA_HEADER);
    return finishRecord(buf, len);
  }

  /**
   * 构造 META 记录。文件名超出剩余容量时会被截断（不切断多字节字符）。
   * @returns {string|null} 容量不足返回 null
   */
  function buildMetaRecord(opts, scratch) {
    var nameBytes = opts.nameUtf8;
    if (nameBytes.length > MAX_NAME_BYTES) nameBytes = truncateUtf8(nameBytes, MAX_NAME_BYTES);
    var len = META_FIXED + nameBytes.length;
    var need = len + CRC_LEN;
    var buf = scratch && scratch.length >= need ? scratch : new Uint8Array(need);
    buf[0] = TYPE_META;
    writeU16(buf, 1, opts.fileId);
    writeU32(buf, 3, opts.totalSize);
    writeU32(buf, 7, opts.chunkCount);
    writeU16(buf, 11, opts.blockPayload);
    writeU16(buf, 13, opts.segKStd);
    buf.set(opts.sha256.subarray(0, 32), 15);
    buf[47] = nameBytes.length;
    buf.set(nameBytes, META_FIXED);
    return finishRecord(buf, len);
  }

  /** 按 UTF-8 边界安全截断。 */
  function truncateUtf8(bytes, max) {
    var n = Math.min(max, bytes.length);
    // 回退掉被切断的续字节（10xxxxxx）
    while (n > 0 && (bytes[n] & 0xc0) === 0x80) n--;
    return bytes.subarray(0, n);
  }

  /**
   * 解析一个 QR 解出的字符串。
   * @returns {object|null} CRC 或格式不合法时返回 null
   */
  function parseRecord(text) {
    var bytes = base45Decode(text);
    if (!bytes || bytes.length < 4) return null;
    var n = bytes.length;
    var len = n - CRC_LEN;
    var crc = bytes[len] | (bytes[len + 1] << 8);
    if (crc16(bytes, 0, len) !== crc) return null;

    var type = bytes[0];
    if (type === TYPE_DATA) {
      if (len < DATA_HEADER) return null;
      var segK = readU16(bytes, 6);
      if (segK < 1) return null;
      return {
        type: 'data',
        fileId: readU16(bytes, 1),
        segStart: readU24(bytes, 3),
        segK: segK,
        seed: readU24(bytes, 8),
        payload: bytes.subarray(DATA_HEADER, len),
      };
    }
    if (type === TYPE_META) {
      if (len < META_FIXED) return null;
      var nameLen = bytes[47];
      if (META_FIXED + nameLen > len) return null;
      return {
        type: 'meta',
        fileId: readU16(bytes, 1),
        totalSize: readU32(bytes, 3),
        chunkCount: readU32(bytes, 7),
        blockPayload: readU16(bytes, 11),
        segKStd: readU16(bytes, 13),
        sha256: bytes.subarray(15, 47),
        nameUtf8: bytes.subarray(META_FIXED, META_FIXED + nameLen),
      };
    }
    return null;
  }

  return {
    DATA_OVERHEAD: DATA_OVERHEAD,
    META_OVERHEAD: META_OVERHEAD,
    MAX_NAME_BYTES: MAX_NAME_BYTES,
    buildDataRecord: buildDataRecord,
    buildMetaRecord: buildMetaRecord,
    parseRecord: parseRecord,
    truncateUtf8: truncateUtf8,
  };
});
