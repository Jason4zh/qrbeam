/*!
 * 基础库测试：Base45 / CRC16 / wire 线格式 / LT 喷泉码。
 * 运行：node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), '../app/lib');

const B = require(path.join(lib, 'base45.js'));
const C = require(path.join(lib, 'crc16.js'));
const R = require(path.join(lib, 'rand.js'));
const F = require(path.join(lib, 'fountain.js'));
const W = require(path.join(lib, 'wire.js'));
const S = require(path.join(lib, 'stream.js'));

function randBytes(n, seed) {
  const rng = R.splitmix32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rng() & 0xff;
  return out;
}

test('base45 字符集与 QR Alphanumeric 字符表一致', () => {
  assert.equal(B.BASE45_ALPHABET, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:');
  assert.equal(B.BASE45_ALPHABET.length, 45);
});

test('base45 往返：各种长度', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 7, 8, 16, 255, 256, 1000, 1201]) {
    const src = randBytes(n, 1234 + n);
    const text = B.base45Encode(src);
    assert.equal(text.length, B.base45EncodedLength(n), `encodedLength(${n})`);
    const back = B.base45Decode(text);
    assert.ok(back, 'decode 应成功');
    assert.equal(back.length, n, `长度往返 ${n}`);
    assert.deepEqual(Array.from(back), Array.from(src), `内容往返 ${n}`);
  }
});

test('base45 只产生 Alphanumeric 字符表内的字符', () => {
  const src = randBytes(4096, 7);
  const text = B.base45Encode(src);
  for (const ch of text) {
    assert.ok(B.BASE45_ALPHABET.includes(ch), `越界字符 ${JSON.stringify(ch)}`);
  }
});

test('base45 字符数 <-> 字节数 是双射（接收端可无歧义反推）', () => {
  for (let n = 0; n < 600; n++) {
    const chars = B.base45EncodedLength(n);
    assert.equal(B.base45PayloadBytesForChars(chars), n, `n=${n} chars=${chars}`);
  }
});

test('base45 拒绝非法输入', () => {
  assert.equal(B.base45Decode('A'), null, '长度余 1');
  assert.equal(B.base45Decode('abc'), null, '小写字母不在字符表内');
  assert.equal(B.base45Decode(':::'), null, '3 字符数值溢出 65535');
  assert.equal(B.base45Decode('!'), null, '字符表外');
});

test('base45 单字节边界（程序化生成向量，避免手算）', () => {
  for (const v of [0, 1, 44, 45, 46, 90, 100, 200, 254, 255]) {
    const c = B.BASE45_ALPHABET[v % 45];
    const d = B.BASE45_ALPHABET[Math.floor(v / 45)];
    assert.deepEqual(Array.from(B.base45Decode(c + d)), [v], `value=${v}`);
  }
  // 最小的溢出值 256 -> 1 + 5*45? 直接程序化取 256 的编码应被拒
  const overflow = B.BASE45_ALPHABET[256 % 45] + B.BASE45_ALPHABET[Math.floor(256 / 45)];
  assert.equal(B.base45Decode(overflow), null, '256 应被拒绝');
});

test('crc16 已知向量与损坏检测', () => {
  // CRC-16/CCITT-FALSE("123456789") = 0x29B1
  const v = C.crc16(new Uint8Array([...'123456789'].map((c) => c.charCodeAt(0))));
  assert.equal(v, 0x29b1);
  const buf = randBytes(64, 99);
  const a = C.crc16(buf);
  buf[10] ^= 1;
  assert.notEqual(C.crc16(buf), a);
});

test('wire：DATA 记录往返', () => {
  const payload = randBytes(1187, 5);
  const text = W.buildDataRecord(0xbeef, 3000, 512, 0xabcdef, payload);
  const rec = W.parseRecord(text);
  assert.ok(rec);
  assert.equal(rec.type, 'data');
  assert.equal(rec.fileId, 0xbeef);
  assert.equal(rec.segStart, 3000);
  assert.equal(rec.segK, 512);
  assert.equal(rec.seed, 0xabcdef);
  assert.deepEqual(Array.from(rec.payload), Array.from(payload));
});

test('wire：META 记录往返（含中文文件名）', () => {
  const nameUtf8 = new TextEncoder().encode('设计稿-final v2.pdf');
  const text = W.buildMetaRecord(
    {
      fileId: 0x1234,
      totalSize: 1234567,
      chunkCount: 1024,
      blockPayload: 1187,
      segKStd: 512,
      sha256: randBytes(32, 3),
      nameUtf8,
    },
    null
  );
  const rec = W.parseRecord(text);
  assert.ok(rec);
  assert.equal(rec.type, 'meta');
  assert.equal(rec.totalSize, 1234567);
  assert.equal(rec.chunkCount, 1024);
  assert.equal(rec.blockPayload, 1187);
  assert.equal(rec.segKStd, 512);
  assert.equal(new TextDecoder().decode(rec.nameUtf8), '设计稿-final v2.pdf');
});

test('wire：CRC 损坏的记录被拒绝', () => {
  const payload = randBytes(200, 11);
  const text = W.buildDataRecord(1, 0, 8, 42, payload);
  // 改一个字符（仍落在合法字符表内）
  const bad = (text[3] === 'A' ? 'B' : 'A') + text.slice(1);
  assert.equal(W.parseRecord(bad), null);
});

test('wire：META 文件名按 UTF-8 边界截断', () => {
  const long = new TextEncoder().encode('文'.repeat(300));
  const text = W.buildMetaRecord(
    {
      fileId: 1,
      totalSize: 1,
      chunkCount: 1,
      blockPayload: 4,
      segKStd: 1,
      sha256: randBytes(32, 1),
      nameUtf8: long,
    },
    null
  );
  const rec = W.parseRecord(text);
  assert.ok(rec);
  assert.ok(rec.nameUtf8.length <= W.MAX_NAME_BYTES);
  const s = new TextDecoder('utf-8', { fatal: true }).decode(rec.nameUtf8);
  assert.equal(s, '文'.repeat(rec.nameUtf8.length / 3));
});

// ---------------------------------------------------------------------
// 喷泉码
// ---------------------------------------------------------------------

function makeSource(K, L, seed) {
  const bytes = randBytes(K * L, seed);
  return { bytes, words: new Uint32Array(bytes.buffer, 0, (K * L) >> 2) };
}

function fountainRoundTrip(K, L, lossRate, label) {
  const { words } = makeSource(K, L, 4000 + K);
  const enc = new F.LtEncoder(K, L);
  const dec = new F.LtDecoder(K, L);

  const dst = new Uint32Array(L >> 2);
  const rng = R.splitmix32(777);
  let sent = 0;
  let dropped = 0;
  let complete = false;

  // 最多尝试 K*3 个块，模拟屏幕一直循环播撒
  for (let counter = 0; counter < K * 3 && !complete; counter++) {
    const seed = R.mix32(counter) & 0xffffff;
    enc.encode(seed, words, dst);
    sent++;
    if ((rng() >>> 0) / 4294967296 < lossRate) {
      dropped++;
      continue;
    }
    const payload = new Uint8Array(dst.buffer.slice(0));
    complete = dec.add(seed, payload) === 'complete';
  }

  assert.equal(complete, true, `${label}: 应能解出（发出 ${sent} 块，丢 ${dropped} 块）`);
  // 校验每个源块
  for (let i = 0; i < K; i++) {
    const got = dec.sourceBlock(i);
    const expect = words.subarray(i * (L >> 2), (i + 1) * (L >> 2));
    assert.deepEqual(Array.from(got), Array.from(expect), `${label}: 源块 ${i}`);
  }
  return { sent, dropped };
}

test('喷泉码：K=512 L=1188 无丢包', () => {
  const { sent } = fountainRoundTrip(512, 1188, 0, 'no-loss');
  // 即使一块不丢，随机线性组合之间也会偶尔线性相关，需要略多于 K 个块才满秩。
  assert.ok(sent <= 512 * 1.05, `无丢包开销过高: ${sent}/512`);
});

test('喷泉码：K=512 L=1188 丢包 30%', () => {
  const r = fountainRoundTrip(512, 1188, 0.3, 'loss30');
  // 开销应该远小于 K（喷泉码的意义所在）
  assert.ok(r.sent < 512 * 1.6, `开销过高: ${r.sent}`);
});

test('喷泉码：K=512 L=1188 丢包 50%', () => {
  const r = fountainRoundTrip(512, 1188, 0.5, 'loss50');
  assert.ok(r.sent < 512 * 2.2, `开销过高: ${r.sent}`);
});

test('喷泉码：退化情形 K=1 / K=2 / K=3', () => {
  fountainRoundTrip(1, 64, 0, 'K1');
  fountainRoundTrip(2, 64, 0.2, 'K2');
  fountainRoundTrip(3, 128, 0.3, 'K3');
});

test('喷泉码：非 4 对齐长度应报错', () => {
  const dec = new F.LtDecoder(4, 100);
  const enc = new F.LtEncoder(4, 100);
  const { words } = makeSource(4, 100, 1);
  const dst = new Uint32Array(25);
  enc.encode(9, words, dst);
  assert.throws(() => dec.add(9, new Uint8Array(99)), /bad block length/);
});

test('喷泉码：重复块的秩不增长', () => {
  const K = 8;
  const L = 32;
  const dec = new F.LtDecoder(K, L);
  const payload = new Uint8Array(L);
  assert.equal(dec.add(12345, payload), 'ok');
  assert.equal(dec.add(12345, payload), 'redundant', '同一个 seed 再来一次应为冗余');
  assert.equal(dec.rank, 1);
});

// ---------------------------------------------------------------------
// 接收端的自我防护
// ---------------------------------------------------------------------

function metaText(overrides) {
  return W.buildMetaRecord(
    Object.assign(
      {
        fileId: 1,
        totalSize: 12345,
        chunkCount: 13,
        blockPayload: 1000,
        segKStd: 512,
        sha256: new Uint8Array(32),
        nameUtf8: new TextEncoder().encode('x.bin'),
      },
      overrides
    ),
    null
  );
}

test('接收端拒绝自相矛盾的 META', () => {
  // chunkCount 必须恰好等于 ceil(totalSize / blockPayload)
  const bad = new S.StreamReceiver();
  bad.acceptText(metaText({ totalSize: 12345, chunkCount: 999 }));
  assert.equal(bad.meta, null, 'chunkCount 与 totalSize 不符应被拒绝');

  const bad2 = new S.StreamReceiver();
  bad2.acceptText(metaText({ totalSize: 10000, chunkCount: 13 })); // ceil(10) = 10 ≠ 13
  assert.equal(bad2.meta, null);

  const ok = new S.StreamReceiver();
  ok.acceptText(metaText({ totalSize: 12345, chunkCount: 13 })); // ceil(12.345) = 13
  assert.ok(ok.meta, '自洽的 META 应被接受');
  assert.equal(ok.meta.totalSize, 12345);
});

test('接收端拒绝非法的 blockPayload', () => {
  for (const bad of [0, 1, 2, 3, 5, 1001]) {
    const r = new S.StreamReceiver();
    r.acceptText(metaText({ blockPayload: bad, totalSize: bad * 4, chunkCount: 4 }));
    assert.equal(r.meta, null, `blockPayload=${bad} 应被拒绝`);
  }
});

test('接收端拒绝大得离谱的 totalSize', () => {
  const r = new S.StreamReceiver();
  const L = 1000;
  const huge = 512 * 1024 * 1024;
  r.acceptText(metaText({ totalSize: huge, chunkCount: Math.ceil(huge / L), blockPayload: L }));
  assert.equal(r.meta, null, '超过上限的总大小应被拒绝');
});

test('接收端限制在途的源块总数，避免被大量伪造段打爆内存', () => {
  const r = new S.StreamReceiver();
  const L = 8;
  const K = 512;
  let created = 0;
  // 每个段用不同的 segStart 伪造出来，真实发送端不会这样
  for (let i = 0; i < 4000; i++) {
    const text = W.buildDataRecord(1, i * K, K, i + 1, new Uint8Array(L));
    if (r.acceptText(text)) created++;
  }
  assert.ok(created > 0, '前若干个段应被接受');
  assert.ok(created <= 128, `在途块数应有上限，实际接受了 ${created} 段`);
});

test('发送端拒绝会溢出线格式（24 位块号）的文件', () => {
  const base = {
    fileId: 1,
    blockPayload: 8,
    segKStd: 512,
    slots: 1,
    maxChars: 4000,
    sha256: new Uint8Array(32),
    nameUtf8: new TextEncoder().encode('big.bin'),
  };
  const limit = 0xffffff;
  // 构造函数只读 fileBytes.length，用一个"只有长度"的替身就够了
  assert.doesNotThrow(() => {
    new S.StreamSender(Object.assign({ fileBytes: { length: limit * 8 } }, base));
  }, '刚好到上限应通过');
  assert.throws(() => {
    new S.StreamSender(Object.assign({ fileBytes: { length: (limit + 1) * 8 } }, base));
  }, /文件太大/);
});

test('接收端能从任意一条记录开始（无需 META 先行）', () => {
  const r = new S.StreamReceiver();
  const L = 16;
  const payload = new Uint8Array(L).fill(7);
  r.acceptText(W.buildDataRecord(42, 0, 4, 999, payload));
  assert.equal(r.L, L, '净荷长度应自描述地确定下来');
  assert.equal(r.fileId, 42);
  assert.equal(r.meta, null, '此时还没有 META');
});
