/*!
 * 页面初始化验证
 *
 * sender.js / receiver.js 是直接操作 DOM 的脚本，跑起来才知道有没有问题。
 * 这里从 send.html / receive.html 里把真实存在的 id 集合抽出来，据此造一个
 * DOM 桩，然后真的把这两个脚本执行一遍：
 *
 *   - 脚本向 getElementById 要了 HTML 里不存在的 id → 立刻能发现；
 *   - 初始化逻辑抛异常 → 立刻能发现；
 *   - 下拉框选项、默认值之类也可以顺带断言。
 *
 * 这比"跑一遍浏览器截图"更能精准定位问题，而且不需要浏览器。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from './canvas-stub.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = path.join(root, 'app/lib');
const require = createRequire(import.meta.url);

/** 在 Node 下复现浏览器里的全局 QB 命名空间。 */
function installNamespace() {
  const g = globalThis;
  const saved = g.QB;
  const ns = {};
  ['rand.js', 'base45.js', 'crc16.js', 'qrcap.js', 'fountain.js', 'wire.js', 'stream.js', 'render.js', 'scan.js']
    .forEach((f) => Object.assign(ns, require(path.join(lib, f))));
  g.QB = ns;
  return function restore() {
    if (saved === undefined) delete g.QB;
    else g.QB = saved;
  };
}

// ---------------------------------------------------------------------
// DOM 桩
// ---------------------------------------------------------------------

function idsIn(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const ids = new Set();
  for (const m of html.matchAll(/id="([^"]+)"/g)) ids.add(m[1]);
  return ids;
}

function makeElement(id, tag, value) {
  const node = tag === 'canvas' ? createCanvas(300, 150) : {};
  node.id = id || '';
  node.tagName = (tag || 'div').toUpperCase();
  node.style = {};
  node.dataset = {};
  node.children = [];
  node.files = [];
  node.value = value == null ? '' : value;
  node.disabled = false;
  node.textContent = '';
  node.innerHTML = '';
  node.clientWidth = 1200;
  node.clientHeight = 760;
  node._listeners = {};
  node.classList = {
    _s: new Set(),
    add(c) { this._s.add(c); },
    remove(c) { this._s.delete(c); },
    toggle(c, on) {
      if (on === undefined) this._s.has(c) ? this._s.delete(c) : this._s.add(c);
      else if (on) this._s.add(c);
      else this._s.delete(c);
    },
    contains(c) { return this._s.has(c); },
  };
  node.addEventListener = function (type, fn) {
    (node._listeners[type] = node._listeners[type] || []).push(fn);
  };
  node.removeEventListener = function () {};
  node.appendChild = function (child) {
    node.children.push(child);
    return child;
  };
  node.removeChild = function (child) {
    const i = node.children.indexOf(child);
    if (i >= 0) node.children.splice(i, 1);
    return child;
  };
  node.querySelectorAll = function () { return []; };
  node.getBoundingClientRect = function () {
    return { x: 0, y: 0, width: node.clientWidth, height: node.clientHeight, top: 0, left: 0 };
  };
  node.click = function () {
    (node._listeners.click || []).forEach((fn) => fn({ preventDefault() {} }));
  };
  return node;
}

/** 只暴露 HTML 里真实存在的 id；要了别的就记进 missing。 */
function installDom(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const known = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  // 记录每个 id 所在标签的名字与 value 属性（和浏览器解析出来的一致）
  const meta = Object.create(null);
  for (const m of html.matchAll(/<(\w+)([^>]*)>/g)) {
    const idm = /\bid="([^"]+)"/.exec(m[2]);
    if (!idm) continue;
    const vm = /\bvalue="([^"]*)"/.exec(m[2]);
    meta[idm[1]] = { tag: m[1], value: vm ? vm[1] : null };
  }

  const byId = Object.create(null);
  const missing = new Set();
  // 页面里所有元素一开始就存在，和真实 DOM 一致
  known.forEach(function (id) {
    const info = meta[id] || {};
    byId[id] = makeElement(id, info.tag || 'div', info.value);
  });

  const document = {
    hidden: false,
    _listeners: {},
    getElementById(id) {
      if (!known.has(id)) missing.add(id);
      if (!byId[id]) byId[id] = makeElement(id, tags[id] || 'div');
      return byId[id];
    },
    createElement(tag) {
      return tag === 'canvas' ? createCanvas(300, 150) : makeElement('', tag);
    },
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    removeEventListener() {},
    body: makeElement('body', 'body'),
  };

  const window = {
    devicePixelRatio: 2,
    isSecureContext: true,
    _listeners: {},
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    removeEventListener() {},
    crypto: globalThis.crypto,
  };

  const g = globalThis;
  const saved = {};
  function defineGlobal(k, v) {
    saved[k] = Object.getOwnPropertyDescriptor(g, k);
    Object.defineProperty(g, k, { value: v, writable: true, configurable: true, enumerable: true });
  }

  // Node 的 navigator/location 是只读 getter，只能这样覆盖
  defineGlobal('document', document);
  defineGlobal('window', window);
  defineGlobal('navigator', { hardwareConcurrency: 4, userAgent: 'node' });
  defineGlobal('location', { protocol: 'https:', href: 'https://example.test/' });
  defineGlobal('requestAnimationFrame', function () { return 1; });
  defineGlobal('cancelAnimationFrame', function () {});

  return {
    byId,
    missing,
    restore() {
      Object.keys(saved).forEach((k) => {
        if (saved[k]) Object.defineProperty(g, k, saved[k]);
        else delete g[k];
      });
    },
  };
}

/** 脚本是 IIFE，重复 require 会命中缓存，先清掉再加载。 */
function loadScript(rel) {
  const abs = path.join(root, rel);
  delete require.cache[require.resolve(abs)];
  require(abs);
}

function optionsOf(selectStub) {
  return [...selectStub.innerHTML.matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
}

const EXPECTED_GRIDS = ['1x1', '2x1', '1x2', '2x2', '3x1', '2x3', '3x2', '4x2'];

// ---------------------------------------------------------------------
// 发送端
// ---------------------------------------------------------------------

test('send.html：sender.js 能找到它用到的每个元素并完成初始化', () => {
  const undoNs = installNamespace();
  const dom = installDom(path.join(root, 'send.html'));
  try {
    assert.doesNotThrow(() => loadScript('app/sender.js'), 'sender.js 初始化不应抛错');
    assert.deepEqual(Array.from(dom.missing), [], 'sender.js 引用了 HTML 里不存在的 id');

    assert.equal(dom.byId.grid.value, '2x2', '默认布局应为 4 个码');
    assert.deepEqual(optionsOf(dom.byId.grid), EXPECTED_GRIDS, '布局下拉的选项集');
    assert.ok(parseInt(dom.byId.version.value, 10) >= 8, '版本应有默认值');
    assert.match(dom.byId.version.innerHTML, /版本 20/);
    assert.equal(dom.byId.level.value, 'L', '默认纠错级别为 L');
    assert.match(dom.byId.level.innerHTML, /纠错 L · 7%/);
    assert.ok(parseInt(dom.byId.segk.value, 10) > 0);
    assert.equal(dom.byId.start.disabled, true, '没选文件时不能开始投射');
    assert.equal(dom.byId.fpsOut.textContent, '10 fps');
  } finally {
    dom.restore();
    undoNs();
  }
});

test('send.html：屏幕很大时自动选一个容量更大但仍放得下的版本', () => {
  const undoNs = installNamespace();
  const dom = installDom(path.join(root, 'send.html'));
  try {
    dom.byId.stage.clientWidth = 2560;
    dom.byId.stage.clientHeight = 1400;
    loadScript('app/sender.js');
    const chosen = parseInt(dom.byId.version.value, 10);
    assert.ok(chosen >= 20, `大屏应选不低于 v20，实际 v${chosen}`);
  } finally {
    dom.restore();
    undoNs();
  }
});

test('send.html：屏幕很小时自动退到低版本', () => {
  const undoNs = installNamespace();
  const dom = installDom(path.join(root, 'send.html'));
  try {
    dom.byId.stage.clientWidth = 520;
    dom.byId.stage.clientHeight = 420;
    loadScript('app/sender.js');
    const chosen = parseInt(dom.byId.version.value, 10);
    assert.ok(chosen <= 15, `小屏应退到低版本，实际 v${chosen}`);
  } finally {
    dom.restore();
    undoNs();
  }
});

// ---------------------------------------------------------------------
// 接收端
// ---------------------------------------------------------------------

test('receive.html：receiver.js 能找到它用到的每个元素并完成初始化', () => {
  const undoNs = installNamespace();
  const dom = installDom(path.join(root, 'receive.html'));
  try {
    assert.doesNotThrow(() => loadScript('app/receiver.js'), 'receiver.js 初始化不应抛错');
    assert.deepEqual(Array.from(dom.missing), [], 'receiver.js 引用了 HTML 里不存在的 id');

    assert.equal(dom.byId.grid.value, '2x2', '默认布局应为 4 个码');
    assert.deepEqual(optionsOf(dom.byId.grid), EXPECTED_GRIDS, '两端的布局命名必须一致');
    assert.match(dom.byId.sheetTitle.textContent, /准备接收/);
    assert.ok(dom.byId.startBtn._listeners.click, '开始/暂停按钮应已绑定事件');
    assert.ok(dom.byId.realignBtn._listeners.click, '重新对齐按钮应已绑定事件');
  } finally {
    dom.restore();
    undoNs();
  }
});

// ---------------------------------------------------------------------
// 交叉核对
// ---------------------------------------------------------------------

test('两端脚本引用的元素在各自页面里都存在', () => {
  const send = idsIn(path.join(root, 'send.html'));
  const recv = idsIn(path.join(root, 'receive.html'));
  for (const id of ['screen', 'stage', 'dropzone', 'file', 'pick', 'grid', 'version', 'level', 'fps', 'fpsOut', 'segk', 'start', 'stats', 'banner']) {
    assert.ok(send.has(id), `send.html 缺少 #${id}`);
  }
  for (const id of ['cam', 'overlay', 'viewport', 'bar', 'statusLine', 'subLine', 'sheet', 'sheetTitle', 'sheetText', 'sheetActions', 'grid', 'startBtn', 'realignBtn', 'rotateHint']) {
    assert.ok(recv.has(id), `receive.html 缺少 #${id}`);
  }
});

test('页面按依赖顺序加载脚本', () => {
  const orderOf = (rel) => {
    const html = fs.readFileSync(path.join(root, rel), 'utf8');
    return [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  };
  const send = orderOf('send.html');
  assert.ok(send.indexOf('app/lib/wire.js') < send.indexOf('app/lib/stream.js'), 'stream.js 依赖 wire.js');
  assert.ok(send.indexOf('app/lib/fountain.js') < send.indexOf('app/lib/stream.js'), 'stream.js 依赖 fountain.js');
  assert.ok(send.indexOf('app/lib/rand.js') < send.indexOf('app/lib/fountain.js'), 'fountain.js 依赖 rand.js');
  assert.ok(send.indexOf('app/lib/qrcode.js') < send.indexOf('app/lib/render.js'), 'render.js 依赖 qrcode.js');
  assert.ok(send.indexOf('app/lib/render.js') < send.indexOf('app/sender.js'), 'sender.js 依赖 render.js');

  const recv = orderOf('receive.html');
  assert.ok(recv.indexOf('app/lib/jsQR.js') < recv.indexOf('app/lib/scan.js'), 'scan.js 依赖 jsQR');
  assert.ok(recv.indexOf('app/lib/stream.js') < recv.indexOf('app/receiver.js'));
});

test('页面里引用的本地资源都存在（含首页的跳转链接）', () => {
  for (const page of ['index.html', 'send.html', 'receive.html']) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((u) => !/^(https?:|data:|#|mailto:|javascript:)/.test(u));
    assert.ok(refs.length > 0, `${page} 应引用了资源`);
    for (const ref of refs) {
      assert.ok(fs.existsSync(path.join(root, ref)), `${page} 引用了不存在的资源：${ref}`);
    }
  }
});

test('Worker 的 importScripts 路径都存在', () => {
  for (const worker of ['app/sender-worker.js', 'app/receiver-worker.js']) {
    const src = fs.readFileSync(path.join(root, worker), 'utf8');
    const call = /importScripts\(([^)]*)\)/.exec(src);
    assert.ok(call, `${worker} 应有 importScripts`);
    const paths = [...call[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(paths.length > 0, `${worker} 应加载依赖`);
    for (const rel of paths) {
      // importScripts 的相对路径是相对 worker 脚本自身的
      assert.ok(fs.existsSync(path.join(root, 'app', rel)), `${worker} 引用了不存在的脚本：${rel}`);
    }
  }
});

test('sw.js 预缓存的资源全部存在于仓库里', () => {  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const rels = [...sw.matchAll(/'(\.\/[^']+)'/g)].map((m) => m[1]);
  assert.ok(rels.length > 15, `应列出全部资源，实际 ${rels.length} 条`);
  for (const rel of rels) {
    if (rel === './') continue;
    const p = path.join(root, rel.replace(/^\.\//, ''));
    assert.ok(fs.existsSync(p), `Service Worker 列出了不存在的资源：${rel}`);
  }
  // 页面本体必须被缓存，否则断网后根本打不开
  for (const must of ['./index.html', './send.html', './receive.html', './app/receiver-worker.js', './app/sender-worker.js']) {
    assert.ok(rels.includes(must), `Service Worker 漏了 ${must}`);
  }
});
