/*!
 * qrbeam — Base45 codec (RFC 9285)
 *
 * 为什么用 Base45：它的 45 个字符集与 QR Code 的 Alphanumeric 模式字符表
 * 完全相同（0-9 A-Z 空格 $ % * + - . / :），因此编码结果可以走 5.5 bit/字符
 * 的 Alphanumeric 模式，而不必退化为 8 bit/字符的 Byte 模式。相比 Base64+Byte
 * 的方案，同样一屏内容能少用约 31% 的模块，直接换来更高的有效吞吐。
 *
 *   2 字节 -> 3 字符 : n = c + 45*d + 45^2*e
 *   1 字节 -> 2 字符 : n = c + 45*d
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

  var ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  var A45 = 45;
  var A45SQ = 45 * 45; // 2025

  // 反向查表：ASCII 0..127 -> 0..44，其余 -1
  var DECODE = new Int16Array(128);
  for (var i = 0; i < 128; i++) DECODE[i] = -1;
  for (var j = 0; j < 45; j++) DECODE[ALPHABET.charCodeAt(j)] = j;

  /** 编码 byteLength 个字节后得到的字符数。 */
  function encodedLength(byteLength) {
    var pairs = byteLength >>> 1;
    return pairs * 3 + (byteLength & 1 ? 2 : 0);
  }

  /**
   * 给定可用的字符数，能容纳的最大字节数。
   * 与 encodedLength 互为逆运算：base45PayloadBytesForChars(encodedLength(n)) === n。
   */
  function payloadBytesForChars(chars) {
    // 3m   <= chars -> 2m   字节
    // 3m+2 <= chars -> 2m+1 字节
    var m = (chars / 3) | 0;
    if (3 * m + 2 <= chars) return 2 * m + 1;
    return 2 * m;
  }

  /** 把 charCode 数组转成字符串（分块调用，避免超出 apply 的参数上限）。 */
  function codesToString(codes) {
    if (codes.length <= 4096) return String.fromCharCode.apply(null, codes);
    var out = '';
    for (var i = 0; i < codes.length; i += 4096) {
      out += String.fromCharCode.apply(null, codes.slice(i, i + 4096));
    }
    return out;
  }

  /**
   * @param {Uint8Array} bytes
   * @returns {string} 只包含 Alphanumeric 字符表内的字符
   */
  function encode(bytes) {
    var n = bytes.length;
    var out = new Array(encodedLength(n));
    var o = 0;
    var even = n - (n & 1);
    var i = 0;
    for (; i < even; i += 2) {
      var v = (bytes[i] << 8) | bytes[i + 1];
      var c = v % A45;
      v = (v - c) / A45;
      var d = v % A45;
      v = (v - d) / A45;
      out[o++] = ALPHABET.charCodeAt(c);
      out[o++] = ALPHABET.charCodeAt(d);
      out[o++] = ALPHABET.charCodeAt(v);
    }
    if (i < n) {
      var b = bytes[i];
      var c1 = b % A45;
      out[o++] = ALPHABET.charCodeAt(c1);
      out[o++] = ALPHABET.charCodeAt((b - c1) / A45);
    }
    return codesToString(out);
  }

  /**
   * @param {string} str
   * @returns {Uint8Array|null} 非法输入返回 null（长度余 1、字符越界、数值溢出）
   */
  function decode(str) {
    var n = str.length;
    var triples = (n / 3) | 0;
    var rest = n - triples * 3;
    if (rest === 1) return null;

    var out = new Uint8Array(triples * 2 + (rest === 2 ? 1 : 0));
    var o = 0;
    var i = 0;
    for (var t = 0; t < triples; t++) {
      var a = str.charCodeAt(i);
      var b = str.charCodeAt(i + 1);
      var c = str.charCodeAt(i + 2);
      i += 3;
      a = a < 128 ? DECODE[a] : -1;
      b = b < 128 ? DECODE[b] : -1;
      c = c < 128 ? DECODE[c] : -1;
      if (a < 0 || b < 0 || c < 0) return null;
      var v = a + b * A45 + c * A45SQ;
      if (v > 0xffff) return null;
      out[o++] = v >> 8;
      out[o++] = v & 0xff;
    }
    if (rest === 2) {
      var a2 = str.charCodeAt(i);
      var b2 = str.charCodeAt(i + 1);
      a2 = a2 < 128 ? DECODE[a2] : -1;
      b2 = b2 < 128 ? DECODE[b2] : -1;
      if (a2 < 0 || b2 < 0) return null;
      var v2 = a2 + b2 * A45;
      if (v2 > 0xff) return null;
      out[o++] = v2;
    }
    return out;
  }

  return {
    BASE45_ALPHABET: ALPHABET,
    base45Encode: encode,
    base45Decode: decode,
    base45EncodedLength: encodedLength,
    base45PayloadBytesForChars: payloadBytesForChars,
  };
});
