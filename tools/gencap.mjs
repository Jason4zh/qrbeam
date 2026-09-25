/*!
 * 生成 app/lib/qrcap.js —— QR Alphanumeric 模式的容量表。
 *
 * 运行：node tools/gencap.mjs
 *
 * 为什么要固化成表：发送端需要"在选定版本下把每个码塞到多满"，
 * 而这个上限依赖 QR 规范里的 RS 块结构。运行时二分探测要重复跑
 * qrcode-generator 的掩码评估（很慢），预先算好可以做到零开销。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const qrcode = require(path.join(here, '../app/lib/qrcode.js'));

const LEVELS = ['L', 'M', 'Q', 'H'];

function fits(version, level, chars) {
  try {
    const q = qrcode(version, level);
    q.addData('A'.repeat(chars), 'Alphanumeric');
    q.make();
    return true;
  } catch (e) {
    return false;
  }
}

function maxChars(version, level) {
  let lo = 1;
  let hi = 8191; // alphanumeric 长度字段上限
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fits(version, level, mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

const table = {};
for (const level of LEVELS) {
  const row = [0];
  for (let v = 1; v <= 40; v++) row.push(maxChars(v, level));
  table[level] = row;
}

const lines = [];
lines.push('/*!');
lines.push(' * qrbeam — QR Code Alphanumeric 模式容量表（自动生成，请勿手改）');
lines.push(' *');
lines.push(' *   QR_CAPACITY[纠错级][版本] = 单个 QR 码能容纳的最大字符数');
lines.push(' *');
lines.push(' * 由 tools/gencap.mjs 用 qrcode-generator 实测二分得出，构建页面时直接查表，');
lines.push(' * 避免运行时重复跑 QR 掩码评估。');
lines.push(' */');
lines.push('(function (root, factory) {');
lines.push('  var api = factory();');
lines.push("  if (typeof module === 'object' && module.exports) {");
lines.push('    module.exports = api;');
lines.push('  } else {');
lines.push('    root.QB = root.QB || {};');
lines.push('    for (var k in api) root.QB[k] = api[k];');
lines.push('  }');
lines.push("})(typeof self !== 'undefined' ? self : this, function () {");
lines.push("  'use strict';");
lines.push('  var QR_CAPACITY = {');
for (const level of LEVELS) {
  lines.push(`    ${level}: [${table[level].join(', ')}],`);
}
lines.push('  };');
lines.push('  return { QR_CAPACITY: QR_CAPACITY };');
lines.push('});');
lines.push('');

const out = path.join(here, '../app/lib/qrcap.js');
fs.writeFileSync(out, lines.join('\n'), 'utf8');

console.log('wrote', out);
for (const level of LEVELS) {
  console.log(level, 'v1 =', table[level][1], 'v20 =', table[level][20], 'v40 =', table[level][40]);
}
