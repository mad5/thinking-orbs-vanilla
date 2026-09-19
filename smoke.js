#!/usr/bin/env node
/**
 * Smoke test: validates the DOM/component layer of thinking-orbs.js
 * (theme resolution, observers, rAF loop control, container handling,
 * public API) against a minimal DOM shim. The geometry itself is verified
 * separately by verify.js.
 *
 * Usage: node smoke.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, 'thinking-orbs.js');
const code = fs.readFileSync(SOURCE, 'utf8');

/* ---------- minimal DOM/context shim ---------- */

let now = 1000;
const rafQueue = [];

const noop = () => {};
const ctx2d = () => ({
  setTransform: noop,
  clearRect: noop,
  beginPath: noop,
  arc: noop,
  fill: noop,
  moveTo: noop,
  lineTo: noop,
  stroke: noop,
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1
});

function makeEl(tag) {
  const el = {
    tagName: (tag || 'canvas').toUpperCase(),
    style: {},
    attributes: {},
    children: [],
    classList: { contains: () => false },
    parentElement: null,
    parentNode: null,
    setAttribute(k, v) {
      this.attributes[k] = String(v);
    },
    getAttribute(k) {
      return this.attributes[k] === undefined ? null : this.attributes[k];
    },
    appendChild(c) {
      c.parentElement = this;
      c.parentNode = this;
      this.children.push(c);
      return c;
    },
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      if (c.parentNode === this) c.parentNode = null;
    },
    getContext: tag === 'canvas' ? ctx2d : undefined
  };
  return el;
}

const listeners = {};
const documentShim = {
  readyState: 'complete',
  visibilityState: 'visible',
  documentElement: makeEl('html'),
  createElement(tag) {
    return makeEl(tag);
  },
  querySelectorAll() {
    return [];
  },
  addEventListener(type, fn) {
    (listeners[type] = listeners[type] || []).push(fn);
  },
  removeEventListener(type, fn) {
    listeners[type] = (listeners[type] || []).filter((x) => x !== fn);
  }
};

class ObsModule {
  constructor(cb) {
    this.cb = cb;
    this.els = [];
    ObsModule.instances.push(this);
  }
  observe(el) {
    this.els.push(el);
  }
  disconnect() {}
}
ObsModule.instances = [];

const sandbox = {
  window: {},
  document: documentShim,
  performance: {
    now: () => {
      now += 16.7;
      return now;
    }
  },
  requestAnimationFrame(cb) {
    rafQueue.push(cb);
    return rafQueue.length;
  },
  cancelAnimationFrame() {},
  devicePixelRatio: 2,
  matchMedia() {
    return { matches: false, addEventListener: noop, removeEventListener: noop };
  },
  IntersectionObserver: ObsModule,
  MutationObserver: ObsModule,
  console
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'thinking-orbs.js' });

const ThinkingOrbs = sandbox.window.ThinkingOrbs;
let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log('  ok   ' + msg);
  } else {
    fail++;
    console.log('  FAIL ' + msg);
  }
}

/* ---------- tests ---------- */

// public surface
assert(typeof ThinkingOrbs.create === 'function', 'create is exposed');
assert(typeof ThinkingOrbs.init === 'function', 'init is exposed');
assert(typeof ThinkingOrbs.frame === 'function', 'frame is exposed');
assert(ThinkingOrbs.states.length === 9, '9 states listed');
assert(ThinkingOrbs.version, 'version string present');

// auto-init runs without exploding (no elements) and is idempotent
ThinkingOrbs.init();
ThinkingOrbs.init();
assert(true, 'init() idempotent on empty DOM');

// create on a real canvas shim
const canvas = makeEl('canvas');
const orb = ThinkingOrbs.create(canvas, { state: 'solving', size: 64, theme: 'auto' });
assert(orb.canvas === canvas, 'create() uses the given canvas');
assert(canvas.attributes['role'] === 'img', 'role=img set');
assert(canvas.attributes['aria-label'] === 'Solving…', 'per-state aria-label');
assert(canvas.style.display === 'block', 'canvas is block');
assert(orb.dark === false, 'auto theme resolves light (shim prefers-color-scheme is light)');
assert(canvas.getAttribute('data-size') === null, 'no data-size written back');

// container creates a canvas inside
const container = makeEl('div');
const orb2 = ThinkingOrbs.create(container, { state: 'shaping', size: 20 });
assert(orb2.created === true, 'container mode creates a canvas');
assert(container.children.length === 1, 'canvas appended into container');
assert(container.children[0].tagName === 'CANVAS', 'appended child is a canvas');
assert(orb2.canvas.parentNode === container, 'canvas parented to container');

// setters
orb2.setState('searching');
assert(orb2.state === 'searching', 'setState works');
assert(container.children[0].attributes['aria-label'] === 'Searching…', 'label follows state');
orb2.setSize(12);
assert(orb2.size === 12 && orb2.canvas.style.width === '12px', 'setSize works');
orb2.setTheme('light');
assert(orb2.dark === false, 'setTheme light resolves dark=false');
orb2.setTheme('auto');
assert(orb2.dark === false, 'setTheme auto re-resolves to light');
orb2.setSpeed(1.5);
assert(orb2.speedMul === 1.5, 'setSpeed works');
orb2.setPaused(true);
assert(orb2.pausedFlag === true, 'setPaused(true) freezes loop');
orb2.setPaused(false);
assert(orb2.pausedFlag === false, 'setPaused(false) resumes');
orb2.setPaused(true);
orb2.destroy();
assert(true, 'destroy() no-op error on container-mode canvas');
orb2.setPaused(false);
assert(orb2.pausedFlag === false, 'state intact after destroy');

// offscreen visibility gating (IntersectionObserver delivered entry)
const orb3 = ThinkingOrbs.create(makeEl('canvas'), { state: 'working' });
const io = ObsModule.instances[ObsModule.instances.length - 1];
if (io instanceof ObsModule && io.els.length) {
  sandbox.document.visibilityState = 'hidden';
  io.cb([{ isIntersecting: true }]); // hidden → should stop, not start
  assert(orb3._running === false, 'hidden tab + visible → stays stopped');
  sandbox.document.visibilityState = 'visible';
  io.cb([{ isIntersecting: true }]);
  assert(orb3._running === true, 'visible + visible → running');
  orb3.setPaused(true);
  assert(orb3._running === false, 'pause stops running loop');
  orb3.destroy();
} else {
  assert(false, 'IntersectionObserver intercepted');
}

// frame() purity — no DOM needed, returns z-sorted draw-order dot list
const f = ThinkingOrbs.frame('composing', 64, 2.0);
assert(Array.isArray(f.dots) && f.dots.length > 100, 'frame() returns a dot list');
let zAscending = true;
for (let i = 1; i < f.dots.length; i++) if (f.dots[i].z < f.dots[i - 1].z) zAscending = false;
assert(zAscending, 'frame() dots are z-sorted far→near (draw order)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);