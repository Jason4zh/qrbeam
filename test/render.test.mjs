/*!
 * 浏览器渲染路径的验证：直接调用 app/lib/render.js（页面里真正在跑的那份渲染代码），
 * 把它的输出交给 app/lib/scan.js 去解码，确认这两段前端代码能严丝合缝地对接。
 *
 * 为此给 canvas 做了一个最小桩（test/canvas-stub.mjs），不需要浏览器。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createCanvas } from './canvas-stub.mjs';

const require = createRequire(import.meta.url);
const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), '../app/lib');

// render.js 在没有 document 时会退回 OffscreenCanvas，这里给它一个 canvas 桩
globalThis.document = {
  createElement: function () {
    return createCanvas();
  },
};

const B = require(path.join(lib, 'base45.js'));
const R = require(path.join(lib, 'rand.js'));
const W = require(path.join(lib, 'wire.js'));
const S = require(path.join(lib, 'stream.js'));
const SC = require(path.join(lib, 'scan.js'));
const RN = require(path.join(lib, 'render.js'));
const CAP = require(path.join(lib, 'qrcap.js')).QR_CAPACITY;

function blockPayloadFor(version, level) {
  const maxChars = CAP[level][version];
  return { maxChars, L: (B.base45PayloadBytesForChars(maxChars) - W.DATA_OVERHEAD) & ~3 };
}

function makeFile(n, seed) {
  const rng = R.splitmix32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rng() & 0xff;
  return out;
}

function bytesEqual(a, b) {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
    Buffer.from(b.buffer, b.byteOffset, b.byteLength)
  );
}

/** 从 canvas 桩的 RGBA 缓冲里裁剪并缩放，喂给 jsQR。 */
function rgbaSampler(canvas) {
  return function (x, y, w, h, outW, outH) {
    const out = new Uint8ClampedArray(outW * outH * 4);
    const W0 = canvas.width;
    const H0 = canvas.height;
    for (let oy = 0; oy < outH; oy++) {
      const sy = Math.min(H0 - 1, Math.max(0, Math.floor(y + ((oy + 0.5) * h) / outH)));
      for (let ox = 0; ox < outW; ox++) {
        const sx = Math.min(W0 - 1, Math.max(0, Math.floor(x + ((ox + 0.5) * w) / outW)));
        const so = (sy * W0 + sx) * 4;
        const to = (oy * outW + ox) * 4;
        out[to] = canvas.data[so];
        out[to + 1] = canvas.data[so + 1];
        out[to + 2] = canvas.data[so + 2];
        out[to + 3] = 255;
      }
    }
    return { data: out, width: outW, height: outH };
  };
}

function newSender(fileBytes, cols, rows, version, level, segKStd) {
  const info = blockPayloadFor(version, level);
  return new S.StreamSender({
    fileBytes,
    fileId: 0x2b2b,
    blockPayload: info.L,
    segKStd,
    slots: cols * rows,
    maxChars: info.maxChars,
    sha256: new Uint8Array(32),
    nameUtf8: new TextEncoder().encode('render.bin'),
  });
}

test('qrLayout 把画布算成整片网格，且每模块像素为整数', () => {
  for (const [cols, rows, version] of [[1, 1, 20], [2, 2, 15], [3, 2, 12], [4, 2, 8]]) {
    const lay = RN.qrLayout({ version, cols, rows, availW: 1000, availH: 700, quiet: 4 });
    const side = version * 4 + 17 + 8;
    assert.equal(lay.side, side, 'side 应含两侧静区');
    assert.ok(Number.isInteger(lay.moduleScale) && lay.moduleScale >= 1, '每模块像素应为正整数');
    assert.equal(lay.width, cols * side * lay.moduleScale);
    assert.equal(lay.height, rows * side * lay.moduleScale);
    assert.ok(lay.width <= 1000 && lay.height <= 700, '画布不应超出可用空间');
  }
});

test('render.js 渲染出的画布能被 scan.js 逐格解出', () => {
  const version = 15;
  const level = 'L';
  const info = blockPayloadFor(version, level);
  const sender = newSender(makeFile(info.L * 40, 5), 2, 2, version, level, 32);

  const lay = RN.qrLayout({ version, cols: 2, rows: 2, availW: 640, availH: 640, quiet: 4 });
  const canvas = createCanvas();
  const ctx = canvas.getContext('2d');
  const texts = sender.buildFrame(1);
  RN.qrRenderFrame(ctx, texts, lay, { ecl: level });

  assert.equal(canvas.width, lay.width);
  assert.equal(canvas.height, lay.height);

  const scanner = new SC.GridScanner(2, 2);
  const res = scanner.align(canvas.width, canvas.height, rgbaSampler(canvas), null);
  assert.ok(res, '应能对齐');
  assert.equal(res.records.length, 4, '四个格子都应被识别');
  assert.equal(res.version, version);

  // 每条记录都要能通过 CRC，并且就是发送端放进去的那些字
  const got = res.records.map((r) => r.code).sort();
  const want = texts.slice().sort();
  assert.deepEqual(got, want, '解出的文本应与渲染时的输入逐条一致');
});

test('render.js + scan.js：整条前端链路的完整传输', () => {
  const version = 15;
  const level = 'L';
  const info = blockPayloadFor(version, level);
  const file = makeFile(info.L * 96, 6);
  const sender = newSender(file, 2, 2, version, level, 32);

  const lay = RN.qrLayout({ version, cols: 2, rows: 2, availW: 640, availH: 640, quiet: 4 });
  const canvas = createCanvas();
  const ctx = canvas.getContext('2d');

  const receiver = new S.StreamReceiver();
  const scanner = new SC.GridScanner(2, 2);
  const sampler = rgbaSampler(canvas);

  let frames = 0;
  for (let f = 0; f < 400; f++) {
    frames++;
    RN.qrRenderFrame(ctx, sender.buildFrame(f), lay, { ecl: level });
    const res = scanner.align(canvas.width, canvas.height, sampler, null);
    if (res && res.records) {
      for (const rec of res.records) receiver.acceptText(rec.code);
    }
    if (receiver.isComplete()) break;
  }

  assert.ok(receiver.isComplete(), `未完成，已渲染 ${frames} 帧`);
  assert.ok(bytesEqual(receiver.assemble(), file), '内容应逐字节一致');
});

test('render.js 的位图是纯黑纯白（没有灰边，保护识别率）', () => {
  const version = 10;
  const level = 'L';
  const info = blockPayloadFor(version, level);
  const sender = newSender(makeFile(info.L * 8, 8), 1, 1, version, level, 8);
  const lay = RN.qrLayout({ version, cols: 1, rows: 1, moduleScale: 4, availW: 800, availH: 800, quiet: 4 });
  const canvas = createCanvas();
  RN.qrRenderFrame(canvas.getContext('2d'), sender.buildFrame(1), lay, { ecl: level });

  const set = new Set();
  for (let i = 0; i < canvas.data.length; i += 4) {
    set.add(canvas.data[i]);
    if (canvas.data[i + 3] !== 255) throw new Error('存在半透明像素');
  }
  assert.deepEqual(Array.from(set).sort((a, b) => a - b), [0, 255], '只应有纯黑与纯白');
});

test('render.js 会复用小位图，连续渲染多帧内容仍然各不相同', () => {
  const version = 12;
  const level = 'L';
  const info = blockPayloadFor(version, level);
  const sender = newSender(makeFile(info.L * 40, 9), 1, 1, version, level, 16);
  const lay = RN.qrLayout({ version, cols: 1, rows: 1, moduleScale: 3, availW: 400, availH: 400, quiet: 4 });
  const canvas = createCanvas();
  const ctx = canvas.getContext('2d');

  const sigs = new Set();
  for (let f = 0; f < 6; f++) {
    RN.qrRenderFrame(ctx, sender.buildFrame(f), lay, { ecl: level });
    let sum = 0;
    for (let i = 0; i < canvas.data.length; i += 4) sum = (sum * 31 + canvas.data[i]) >>> 0;
    sigs.add(sum);
  }
  assert.equal(sigs.size, 6, '每一帧的图案都应不同（说明位图复用没有串帧）');
});
