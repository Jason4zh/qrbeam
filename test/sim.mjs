/*!
 * 测试用屏摄模拟器：把"屏幕上的 QR 网格"渲染成一张灰度照片，
 * 可加模糊 / 噪声 / 缩放 / 亮度梯度，用来在没有摄像头的情况下
 * 端到端验证整条光信道。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), '../app/lib');
const qrcode = require(path.join(lib, 'qrcode.js'));
const R = require(path.join(lib, 'rand.js'));

/** 一个模块矩阵（真=黑）。 */
export function qrMatrix(text, version, ecl) {
  const q = qrcode(version, ecl || 'L');
  q.addData(text, 'Alphanumeric');
  q.make();
  const n = q.getModuleCount();
  const rows = new Array(n);
  for (let y = 0; y < n; y++) {
    const row = new Uint8Array(n);
    for (let x = 0; x < n; x++) row[x] = q.isDark(y, x) ? 1 : 0;
    rows[y] = row;
  }
  return rows;
}

/**
 * 把若干文本渲染成一屏 cols×rows 的二维码"照片"。
 * @returns {{gray: Uint8Array, width: number, height: number}}
 */
export function renderScreen(texts, opts) {
  const o = Object.assign(
    {
      cols: 1,
      rows: 1,
      version: 20,
      ecl: 'L',
      cellPx: 4,   // 每个 QR 模块占几个像素
      quiet: 4,    // QR 静区（模块数）
      gap: 0,      // 码与码之间的像素间隙（发送端把码紧铺，便于接收端等分/自动对齐）
      margin: 0,   // 画布外边框
      bg: 255,
      fg: 0,
    },
    opts
  );

  const n = o.version * 4 + 17;
  const side = (n + o.quiet * 2) * o.cellPx;
  const width = o.margin * 2 + o.cols * side + (o.cols - 1) * o.gap;
  const height = o.margin * 2 + o.rows * side + (o.rows - 1) * o.gap;
  const gray = new Uint8Array(width * height).fill(o.bg);

  for (let i = 0; i < texts.length; i++) {
    const c = i % o.cols;
    const r = Math.floor(i / o.cols);
    const x0 = o.margin + c * (side + o.gap);
    const y0 = o.margin + r * (side + o.gap);
    const m = qrMatrix(texts[i], o.version, o.ecl);
    for (let my = 0; my < n; my++) {
      for (let mx = 0; mx < n; mx++) {
        if (!m[my][mx]) continue;
        const px = x0 + (mx + o.quiet) * o.cellPx;
        const py = y0 + (my + o.quiet) * o.cellPx;
        for (let dy = 0; dy < o.cellPx; dy++) {
          const rowOff = (py + dy) * width + px;
          for (let dx = 0; dx < o.cellPx; dx++) gray[rowOff + dx] = o.fg;
        }
      }
    }
  }
  return { gray, width, height };
}

/** 分离式盒式模糊（近似镜头/对焦失焦）。 */
export function blur(img, radius) {
  if (!radius) return img;
  const { gray, width, height } = img;
  const tmp = new Uint8Array(gray.length);
  boxPassH(gray, tmp, width, height, radius);
  boxPassV(tmp, gray, width, height, radius);
  return img;
}

function boxPassH(src, dst, w, h, r) {
  const div = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const off = y * w;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[off + clamp(i, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      dst[off + x] = (sum / div) | 0;
      sum -= src[off + clamp(x - r, 0, w - 1)];
      sum += src[off + clamp(x + r + 1, 0, w - 1)];
    }
  }
}
function boxPassV(src, dst, w, h, r) {
  const div = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[clamp(i, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = (sum / div) | 0;
      sum -= src[clamp(y - r, 0, h - 1) * w + x];
      sum += src[clamp(y + r + 1, 0, h - 1) * w + x];
    }
  }
}
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 叠加高斯白噪声（sigma 就是标准差，单位是灰度级）。 */
export function addNoise(img, sigma, seed) {
  if (!sigma) return img;
  const rng = R.splitmix32(seed || 1);
  const g = img.gray;
  // Irwin–Hall(4)：4 个均匀分布之和，标准差 sqrt(4/12) = 0.577，乘 1.732 让 std == sigma
  const k = sigma * 1.732;
  for (let i = 0; i < g.length; i++) {
    let s = 0;
    for (let j = 0; j < 4; j++) s += (rng() >>> 0) / 4294967296 - 0.5;
    const v = Math.round(g[i] + s * k);
    g[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return img;
}

/** 整体缩放（模拟手机离屏幕的远近）。 */
export function scaleImage(img, factor) {
  const ow = Math.max(1, Math.round(img.width * factor));
  const oh = Math.max(1, Math.round(img.height * factor));
  return { gray: resampleGray(img, 0, 0, img.width, img.height, ow, oh), width: ow, height: oh };
}

/**
 * 从 gray 图上取一块并（可选）缩放到 outW×outH，返回 jsQR 需要的 RGBA。
 * 与浏览器端 canvas.drawImage 的语义一致。
 */
export function cropScaleToRGBA(img, x, y, w, h, outW, outH) {
  const g = resampleGray(img, x, y, w, h, outW, outH);
  const rgba = new Uint8ClampedArray(outW * outH * 4);
  for (let i = 0, o = 0; i < g.length; i++, o += 4) {
    const v = g[i];
    rgba[o] = v;
    rgba[o + 1] = v;
    rgba[o + 2] = v;
    rgba[o + 3] = 255;
  }
  return { data: rgba, width: outW, height: outH };
}

function resampleGray(img, x, y, w, h, outW, outH) {
  const src = img.gray;
  const W = img.width;
  const H = img.height;
  const out = new Uint8Array(outW * outH);
  const sx = w / outW;
  const sy = h / outH;
  for (let oy = 0; oy < outH; oy++) {
    const fy = y + (oy + 0.5) * sy - 0.5;
    for (let ox = 0; ox < outW; ox++) {
      const fx = x + (ox + 0.5) * sx - 0.5;
      out[oy * outW + ox] = bilinear(src, W, H, fx, fy);
    }
  }
  return out;
}

function bilinear(src, W, H, fx, fy) {
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const x1 = clamp(x0 + 1, 0, W - 1);
  const y1 = clamp(y0 + 1, 0, H - 1);
  const cx0 = clamp(x0, 0, W - 1);
  const cy0 = clamp(y0, 0, H - 1);
  const a = src[cy0 * W + cx0];
  const b = src[cy0 * W + x1];
  const c = src[y1 * W + cx0];
  const d = src[y1 * W + x1];
  return Math.round(
    a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty
  );
}

/** 给 GridScanner 用的采样器。 */
export function samplerFor(img) {
  return (x, y, w, h, outW, outH) => cropScaleToRGBA(img, x, y, w, h, outW, outH);
}

/**
 * 把"屏幕画布"贴到一张更大的"相机画面"上（可选偏移），
 * 用来模拟手机取景框比画布大、以及用户对不准的真实情形。
 */
export function placeOnCanvas(screen, frameW, frameH, offsetX, offsetY, bg = 246) {
  const gray = new Uint8Array(frameW * frameH).fill(bg);
  for (let y = 0; y < screen.height; y++) {
    const dy = y + offsetY;
    if (dy < 0 || dy >= frameH) continue;
    for (let x = 0; x < screen.width; x++) {
      const dx = x + offsetX;
      if (dx < 0 || dx >= frameW) continue;
      gray[dy * frameW + dx] = screen.gray[y * screen.width + x];
    }
  }
  return { gray, width: frameW, height: frameH };
}
