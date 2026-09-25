/*!
 * 端到端测试：文件 → 喷泉编码 → 线格式 → QR 渲染 → 模拟屏摄 → jsQR 识别
 * → 喷泉解码 → 重组文件。整条光信道在没有真实摄像头的情况下被完整验证。
 *
 * 运行：node --test test/e2e.test.mjs
 *
 * 规模刻意压小（版本 10、每模块 3 像素），因为每帧都要真实地跑一遍 QR 掩码
 * 评估和 jsQR 识别，这是整个仓库里最慢的测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderScreen, blur, addNoise, scaleImage, samplerFor, placeOnCanvas } from './sim.mjs';

const require = createRequire(import.meta.url);
const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), '../app/lib');

const B = require(path.join(lib, 'base45.js'));
const R = require(path.join(lib, 'rand.js'));
const W = require(path.join(lib, 'wire.js'));
const S = require(path.join(lib, 'stream.js'));
const SC = require(path.join(lib, 'scan.js'));
const CAP = require(path.join(lib, 'qrcap.js')).QR_CAPACITY;

const VER = 10;
const ECL = 'L';
const CELL_PX = 3;
const MAX_FRAMES = 600;

function align4(n) {
  return n & ~3;
}

function blockPayloadFor(version, ecl) {
  const maxChars = CAP[ecl][version];
  return { maxChars, L: align4(B.base45PayloadBytesForChars(maxChars) - W.DATA_OVERHEAD) };
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

function newSender(fileBytes, slots, segKStd, name = 'payload.bin') {
  const { maxChars, L } = blockPayloadFor(VER, ECL);
  return new S.StreamSender({
    fileBytes,
    fileId: 0x5a5a,
    blockPayload: L,
    segKStd,
    slots,
    maxChars,
    sha256: new Uint8Array(32),
    nameUtf8: new TextEncoder().encode(name),
  });
}

/**
 * 跑完一次完整传输。
 * @returns {{receiver, frames, decodedSlots, totalSlots}}
 */
function transmit(opts) {
  const {
    fileBytes,
    cols = 1,
    rows = 1,
    segKStd = 32,
    cellPx = CELL_PX,
    lossRate = 0,
    noiseSigma = 0,
    blurRadius = 0,
    scaleFactor = 1,
    maxFrames = MAX_FRAMES,
    seed = 7,
    autoAlign = false,
    misalignPx = 0,
    name = 'payload.bin',
  } = opts;

  const slots = cols * rows;
  const sender = newSender(fileBytes, slots, segKStd, name);
  const receiver = new S.StreamReceiver();
  const scanner = new SC.GridScanner(cols, rows);
  const rng = R.splitmix32(seed);

  let frames = 0;
  let decodedSlots = 0;
  let totalSlots = 0;
  let roi = null;

  for (let f = 0; f < maxFrames; f++) {
    const texts = sender.buildFrame(f);
    frames++;
    if (lossRate > 0 && (rng() >>> 0) / 4294967296 < lossRate) continue;

    let img = renderScreen(texts, { cols, rows, version: VER, ecl: ECL, cellPx });
    if (blurRadius) blur(img, blurRadius);
    if (noiseSigma) addNoise(img, noiseSigma, f + 1);
    if (scaleFactor !== 1) img = scaleImage(img, scaleFactor);

    // 模拟"相机画面比画布更大"以及用户粗对带来的偏移
    if (misalignPx > 0) {
      const padX = misalignPx;
      const padY = Math.round(misalignPx * 0.5);
      // 故意做不对称的留白：这样"把整帧等分"就不成立，必须靠自动对齐找回网格
      const frame = placeOnCanvas(img, img.width + padX * 2 + 41, img.height + padY * 2 + 67, padX, padY);
      const sampler = samplerFor(frame);
      // 用户粗对：以为画布就在这儿，实际差了几十像素
      const hint = { x: padX - 24, y: padY - 16, w: img.width + 48, h: img.height + 32 };

      if (autoAlign) {
        const a = scanner.align(frame.width, frame.height, sampler, hint);
        if (a) {
          roi = a.roi;
          for (const rec of a.records) receiver.acceptText(rec.code);
        }
      }
      const results = scanner.scan(frame.width, frame.height, sampler, autoAlign ? roi : hint);
      totalSlots += results.length;
      for (const t of results) {
        if (!t) continue;
        decodedSlots++;
        receiver.acceptText(t);
      }
    } else {
      const results = scanner.scan(img.width, img.height, samplerFor(img));
      totalSlots += results.length;
      for (const t of results) {
        if (!t) continue;
        decodedSlots++;
        receiver.acceptText(t);
      }
    }
    if (receiver.isComplete()) break;
  }

  return { receiver, frames, decodedSlots, totalSlots };
}

// ---------------------------------------------------------------------
// 基本可行性：alphanumeric 模式 + 高版本 QR 能被 jsQR 读出
// ---------------------------------------------------------------------

test('jsQR 能读出版本 20 / 纠错 L 的 alphanumeric 码（理想条件）', () => {
  const maxChars = CAP['L'][20];
  const L = align4(B.base45PayloadBytesForChars(maxChars) - W.DATA_OVERHEAD);
  const sender = new S.StreamSender({
    fileBytes: makeFile(L * 8, 1),
    fileId: 0x1234,
    blockPayload: L,
    segKStd: 8,
    slots: 1,
    maxChars,
    sha256: new Uint8Array(32),
    nameUtf8: new TextEncoder().encode('a.bin'),
  });
  const text = sender.recordFor(1, 0);
  assert.equal(text.length, B.base45EncodedLength(W.DATA_OVERHEAD + L));

  const img = renderScreen([text], { cols: 1, rows: 1, version: 20, ecl: 'L', cellPx: 4 });
  const scanner = new SC.GridScanner(1, 1);
  const res = scanner.scan(img.width, img.height, samplerFor(img));
  assert.ok(res[0], 'jsQR 应能识别');
  const rec = W.parseRecord(res[0]);
  assert.ok(rec, '记录应通过 CRC');
  assert.equal(rec.type, 'data');
  assert.equal(rec.fileId, 0x1234);
});

test('逐级加压：从 60% 填到容量上限，码都能被识别且净荷一致', () => {
  for (const fill of [0.6, 0.8, 1.0]) {
    const maxChars = CAP['L'][20];
    const chars = Math.floor(maxChars * fill) & ~1;
    const bytes = B.base45PayloadBytesForChars(chars);
    const L = align4(bytes - W.DATA_OVERHEAD);
    const payload = makeFile(L, 42);
    const text = W.buildDataRecord(9, 0, 4, 123456, payload);
    assert.ok(text.length <= maxChars);
    const img = renderScreen([text], { cols: 1, rows: 1, version: 20, ecl: 'L', cellPx: 4 });
    const scanner = new SC.GridScanner(1, 1);
    const res = scanner.scan(img.width, img.height, samplerFor(img));
    assert.ok(res[0], `填充率 ${fill} 时应可识别`);
    const rec = W.parseRecord(res[0]);
    assert.ok(rec);
    assert.deepEqual(Array.from(rec.payload), Array.from(payload), `填充率 ${fill} 净荷应一致`);
  }
});

// ---------------------------------------------------------------------
// 完整传输
// ---------------------------------------------------------------------

test('端到端：单码 1×1', () => {
  const L = blockPayloadFor(VER, ECL).L;
  const file = makeFile(L * 96, 11);
  const r = transmit({ fileBytes: file, cols: 1, rows: 1, segKStd: 32 });
  assert.ok(r.receiver.isComplete(), `未完成，已跑 ${r.frames} 帧`);
  assert.ok(bytesEqual(r.receiver.assemble(), file), '内容应逐字节一致');
});

test('端到端：2×2 多码 + 多段', () => {
  const L = blockPayloadFor(VER, ECL).L;
  const file = makeFile(L * 160, 12);
  const r = transmit({ fileBytes: file, cols: 2, rows: 2, segKStd: 32 });
  assert.ok(r.receiver.isComplete(), `未完成，已跑 ${r.frames} 帧`);
  assert.equal(r.receiver.segCount(), 5);
  assert.ok(bytesEqual(r.receiver.assemble(), file));
});

test('端到端：2×3 六码并行', () => {
  const L = blockPayloadFor(VER, ECL).L;
  const file = makeFile(L * 150, 13);
  const r = transmit({ fileBytes: file, cols: 3, rows: 2, segKStd: 64 });
  assert.ok(r.receiver.isComplete(), `未完成，已跑 ${r.frames} 帧`);
  assert.ok(bytesEqual(r.receiver.assemble(), file));
});

// ---------------------------------------------------------------------
// 抗丢帧 / 抗干扰
// ---------------------------------------------------------------------

test('端到端：30% 整帧丢失仍能完成', () => {
  const L = blockPayloadFor(VER, ECL).L;
  const file = makeFile(L * 96, 14);
  const r = transmit({ fileBytes: file, cols: 2, rows: 2, segKStd: 32, lossRate: 0.3 });
  assert.ok(r.receiver.isComplete(), `未完成，已跑 ${r.frames} 帧`);
  assert.ok(bytesEqual(r.receiver.assemble(), file));
});

test('端到端：55% 整帧丢失仍能完成', () => {
  const L = blockPayloadFor(VER, ECL).L;
  const file = makeFile(L * 96, 15);
  const r = transmit({ fileBytes: file, cols: 2, rows: 2, segKStd: 32, lossRate: 0.55 });
  assert.ok(r.receiver.isComplete(), `未完成，已跑 ${r.frames} 帧`);
  assert.ok(bytesEqual(r.receiver.assemble(), file));
});

test('端到端：明显噪声下仍能完成', () => {
  const L = blockPayloadFor(VER, ECL).L;
  const file = makeFile(L * 80, 16);
  const r = transmit({
    fileBytes: file, cols: 2, rows: 2, segKStd: 32, cellPx: 4, noiseSigma: 28,
  });
  assert.ok(r.receiver.isComplete(), `未完成，已跑 ${r.frames} 帧`);
  assert.ok(bytesEqual(r.receiver.assemble(), file));
});

test('端到端：失焦（每模块 5 像素 + 1 像素模糊）仍能完成', () => {
  const L = blockPayloadFor(VER, ECL).L;
  const file = makeFile(L * 64, 24);
  const r = transmit({
    fileBytes: file, cols: 2, rows: 2, segKStd: 32, cellPx: 5, blurRadius: 1,
  });
  assert.ok(r.receiver.isComplete(), `未完成，已跑 ${r.frames} 帧`);
  assert.ok(bytesEqual(r.receiver.assemble(), file));
});

test('端到端：手机离得较远（画面缩到 70%）仍能完成', () => {
  const L = blockPayloadFor(VER, ECL).L;
  const file = makeFile(L * 64, 17);
  const r = transmit({ fileBytes: file, cols: 2, rows: 2, segKStd: 32, scaleFactor: 0.7 });
  assert.ok(r.receiver.isComplete(), `未完成，已跑 ${r.frames} 帧`);
  assert.ok(bytesEqual(r.receiver.assemble(), file));
});

// ---------------------------------------------------------------------
// 自动对齐：用户只需把画布大致放进画面
// ---------------------------------------------------------------------

test('自动对齐：画布只占画面一部分且用户对偏时仍能完成', () => {
  const L = blockPayloadFor(VER, ECL).L;
  const file = makeFile(L * 96, 20);
  const r = transmit({
    fileBytes: file, cols: 2, rows: 2, segKStd: 32,
    misalignPx: 140,   // 画布四周各留 140 像素，用户不可能手对得准
    autoAlign: true,
  });
  assert.ok(r.receiver.isComplete(), `未完成，已跑 ${r.frames} 帧`);
  assert.ok(bytesEqual(r.receiver.assemble(), file));
});

test('自动对齐：能反推出正确的网格原点与格距', () => {
  const L = blockPayloadFor(VER, ECL).L;
  const sender = newSender(makeFile(L * 40, 21), 4, 32);
  const img = renderScreen(sender.buildFrame(1), {
    cols: 2, rows: 2, version: VER, ecl: ECL, cellPx: CELL_PX,
  });
  const padX = 143;
  const padY = 71;
  const frame = placeOnCanvas(img, img.width + padX * 2, img.height + padY * 2, padX, padY);
  const sampler = samplerFor(frame);
  const scanner = new SC.GridScanner(2, 2);

  const a = scanner.align(frame.width, frame.height, sampler, null);
  assert.ok(a, '应能对齐');
  assert.equal(a.version, VER);
  assert.equal(a.modules, VER * 4 + 17);
  assert.equal(a.records.length, 4, '四个格子都应识别出来');
  // 网格应回到画布的真实位置与尺寸（允许 2 像素的重建误差）
  assert.ok(Math.abs(a.roi.x - padX) < 2, `roi.x=${a.roi.x} 应接近 ${padX}`);
  assert.ok(Math.abs(a.roi.y - padY) < 2, `roi.y=${a.roi.y} 应接近 ${padY}`);
  assert.ok(Math.abs(a.roi.w - img.width) < 4, `roi.w=${a.roi.w} 应接近 ${img.width}`);
  assert.ok(Math.abs(a.roi.h - img.height) < 4, `roi.h=${a.roi.h} 应接近 ${img.height}`);
  // 格距应约等于每模块 3 像素 × (n + 2·quiet)
  const expectCell = CELL_PX * (VER * 4 + 17 + 8);
  assert.ok(Math.abs(a.roi.w / 2 - expectCell) < 4, `格距 ${a.roi.w / 2} 应接近 ${expectCell}`);
});

test('自动对齐后按网格精确裁剪，无需任何容差', () => {
  const L = blockPayloadFor(VER, ECL).L;
  const file = makeFile(L * 96, 23);
  const r = transmit({
    fileBytes: file, cols: 2, rows: 2, segKStd: 32,
    misalignPx: 96, autoAlign: true,
  });
  assert.ok(r.receiver.isComplete(), `未完成，已跑 ${r.frames} 帧`);
  assert.ok(bytesEqual(r.receiver.assemble(), file));
  // 对齐后每帧 4 格都应该能读出来（没有容差浪费，也没有邻居干扰）
  assert.ok(
    r.decodedSlots / r.totalSlots > 0.9,
    `解码命中率 ${(r.decodedSlots / r.totalSlots).toFixed(3)} 应接近 1`
  );
});

// ---------------------------------------------------------------------
// 鲁棒性细节
// ---------------------------------------------------------------------

test('接收端可从任意时刻中途加入（丢掉前 40 帧也能完成）', () => {
  const L = blockPayloadFor(VER, ECL).L;
  const file = makeFile(L * 96, 18);
  const sender = newSender(file, 4, 32, 'late.bin');
  const receiver = new S.StreamReceiver();
  const scanner = new SC.GridScanner(2, 2);

  for (let f = 40; f < MAX_FRAMES; f++) {
    const img = renderScreen(sender.buildFrame(f), {
      cols: 2, rows: 2, version: VER, ecl: ECL, cellPx: CELL_PX,
    });
    for (const t of scanner.scan(img.width, img.height, samplerFor(img))) {
      if (t) receiver.acceptText(t);
    }
    if (receiver.isComplete()) break;
  }
  assert.ok(receiver.isComplete(), '中途加入应仍能完成');
  assert.ok(bytesEqual(receiver.assemble(), file));
});

test('接收端忽略 CRC 损坏的记录，不影响最终结果', () => {
  const L = blockPayloadFor(VER, ECL).L;
  const file = makeFile(L * 96, 19);
  const sender = newSender(file, 4, 32, 'crc.bin');
  const receiver = new S.StreamReceiver();
  const scanner = new SC.GridScanner(2, 2);
  const rng = R.splitmix32(77);

  for (let f = 0; f < MAX_FRAMES; f++) {
    const img = renderScreen(sender.buildFrame(f), {
      cols: 2, rows: 2, version: VER, ecl: ECL, cellPx: CELL_PX,
    });
    const results = scanner.scan(img.width, img.height, samplerFor(img));
    for (let i = 0; i < results.length; i++) {
      let t = results[i];
      if (!t) continue;
      // 每个码有 25% 的概率被"篡改"（模拟屏幕残影 / 局部遮挡导致的位翻转）
      if ((rng() >>> 0) / 4294967296 < 0.25) {
        const pos = 5 + (rng() % (t.length - 6));
        t = t.slice(0, pos) + (t[pos] === 'Q' ? 'R' : 'Q') + t.slice(pos + 1);
      }
      receiver.acceptText(t);
    }
    if (receiver.isComplete()) break;
  }
  assert.ok(receiver.isComplete(), '损坏帧应被丢弃而不污染解码');
  assert.ok(bytesEqual(receiver.assemble(), file));
  assert.ok(receiver.stats.badRecord > 0, '应确实丢弃过损坏记录');
});

test('文件长度不是块大小整数倍时的尾块处理', () => {
  const L = blockPayloadFor(VER, ECL).L;
  for (const extra of [1, 7, L - 1, L, L + 1]) {
    const size = L * 20 + extra;
    const file = makeFile(size, 100 + extra);
    const r = transmit({ fileBytes: file, cols: 2, rows: 2, segKStd: 16 });
    assert.ok(r.receiver.isComplete(), `size=${size} 未完成`);
    const out = r.receiver.assemble();
    assert.equal(out.length, size);
    assert.ok(bytesEqual(out, file), `size=${size} 内容应一致`);
  }
});

test('空文件（0 字节）也能走完流程', () => {
  const r = transmit({ fileBytes: new Uint8Array(0), cols: 2, rows: 2, segKStd: 4 });
  assert.ok(r.receiver.isComplete());
  assert.equal(r.receiver.assemble().length, 0);
});

test('META 记录能还原文件名（含中文与斜杠）', () => {
  const L = blockPayloadFor(VER, ECL).L;
  const file = makeFile(L * 40, 22);
  const name = '季度报告-KR/中文名 测试.bin';
  const r = transmit({ fileBytes: file, cols: 2, rows: 2, segKStd: 16, name });
  assert.ok(r.receiver.meta, '应收到 META');
  assert.equal(new TextDecoder().decode(r.receiver.meta.nameUtf8), name);
});
