#!/usr/bin/env node
/**
 * Fidelity check: runs the hand-written vanilla engine (thinking-orbs.js)
 * and compares every frame numerically against the original library's
 * spec/orbs-golden.json — dot by dot, line by line.
 *
 * Usage: node verify.js [path-to-golden.json]
 *   default golden path: ../thinking-orbs/spec/orbs-golden.json
 *
 * Exit code 0 = all cases within tolerance, 1 = any mismatch.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HERE = __dirname;
const SOURCE = path.join(HERE, 'thinking-orbs.js');
const GOLDEN = process.argv[2] || path.join(HERE, '..', 'thinking-orbs', 'spec', 'orbs-golden.json');

function loadEngine() {
  const code = fs.readFileSync(SOURCE, 'utf8');
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'thinking-orbs.js' });
  const api = sandbox.window.ThinkingOrbs;
  if (!api) throw new Error('ThinkingOrbs global not exposed by ' + SOURCE);
  return api;
}

const api = loadEngine();
const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
const tol = golden.tolerance;

let checked = 0;
let resolvedOk = 0;
const failures = [];

function framesMatch(f, g) {
  if (f.dots.length !== g.dotCount) {
    return `dot count ${f.dots.length} != ${g.dotCount}`;
  }
  if (f.lines.length !== g.lineCount) {
    return `line count ${f.lines.length} != ${g.lineCount}`;
  }
  for (let i = 0; i < f.dots.length; i++) {
    const d = f.dots[i];
    const vals = [d.x, d.y, d.z, d.r, d.white, d.a === undefined ? 1 : d.a];
    for (let v = 0; v < 6; v++) {
      const exp = g.dots[i * 6 + v];
      if (Math.abs(vals[v] - exp) > tol) {
        return `dot ${i}[:${v}] ${vals[v]} != ${exp} (Δ ${Math.abs(vals[v] - exp)})`;
      }
    }
  }
  for (let i = 0; i < f.lines.length; i++) {
    const l = f.lines[i];
    const vals = [l.x1, l.y1, l.x2, l.y2, l.white, l.a === undefined ? 1 : l.a, l.w];
    for (let v = 0; v < 7; v++) {
      const exp = g.lines[i * 7 + v];
      if (Math.abs(vals[v] - exp) > tol) {
        return `line ${i}[:${v}] ${vals[v]} != ${exp} (Δ ${Math.abs(vals[v] - exp)})`;
      }
    }
  }
  return null;
}

// 1. geometry cases — 9 states × 2 sizes × 4 timestamps
for (const c of golden.cases) {
  let f;
  try {
    f = api.frame(c.state, c.size, c.t);
  } catch (err) {
    failures.push(`${c.key}: threw ${err.message}`);
    continue;
  }
  const problem = framesMatch(f, c);
  if (problem) failures.push(`${c.key}: ${problem}`);
  else checked++;
}

// 2. resolved presets — helper the golden ships for verifying scaling
for (const key of Object.keys(golden.resolved)) {
  const exp = golden.resolved[key];
  const [state, size] = key.split('-');
  const got = api.resolve(state, Number(size));
  if (got.mode !== exp.mode) {
    failures.push(`resolve ${key}: mode ${got.mode} != ${exp.mode}`);
    continue;
  }
  if (Math.abs(got.speed - exp.speed) > tol) {
    failures.push(`resolve ${key}: speed ${got.speed} != ${exp.speed}`);
    continue;
  }
  const gO = exp.opts;
  const gKeys = Object.keys(gO);
  const vKeys = Object.keys(got.opts);
  if (gKeys.length !== vKeys.length) {
    failures.push(`resolve ${key}: opts keys ${vKeys.length} != ${gKeys.length} ${gKeys}`);
    continue;
  }
  let bad = false;
  for (const k of gKeys) {
    if (got.opts[k] === undefined || Math.abs(got.opts[k] - gO[k]) > tol) {
      failures.push(`resolve ${key}: opts[${k}] ${got.opts[k]} != ${gO[k]}`);
      bad = true;
    }
  }
  if (!bad) resolvedOk++;
}

// 3. cross-check arbitrary-size interpolation stays finite (sanity)
for (const state of ['working', 'searching', 'solving', 'listening', 'connecting', 'weaving', 'composing', 'breathing', 'shaping']) {
  for (const size of [8, 48, 96, 128]) {
    const f = api.frame(state, size, 0.6);
    for (const d of f.dots) {
      if (!isFinite(d.x) || !isFinite(d.y) || !isFinite(d.r)) {
        failures.push(`interp ${state}@${size}: non-finite dot`);
        break;
      }
    }
  }
}

console.log(
  `\nthinking-orbs.js vs ${path.basename(GOLDEN)} (${golden.sourceLibrary.name}@${golden.sourceLibrary.version}, tolerance ${tol})`
);
console.log(`  geometry cases     : ${checked} / ${golden.cases.length} passed`);
console.log(`  resolved presets   : ${resolvedOk} / ${Object.keys(golden.resolved).length} passed`);

if (failures.length) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const f of failures.slice(0, 40)) console.log('  - ' + f);
  if (failures.length > 40) console.log(`  … and ${failures.length - 40} more`);
  process.exit(1);
}
console.log('\nAll 72 geometry cases + 18 resolved presets match the golden spec.');