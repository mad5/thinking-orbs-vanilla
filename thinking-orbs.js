/*!
 * thinking-orbs vanillajs — dotted thought-orb loading indicators
 * -------------------------------------------------------------
 * A hand-written port of the thinking-orbs web library (MIT, Jakub Antalik).
 * Nine animated states, two tuned sizes (64, 20) plus interpolated arbitrary
 * sizes, auto dark/light theme, reduced-motion support.
 *
 * No dependencies. Drop the file in with a <script> tag; canvas elements
 * carrying a `data-thinking-orb` attribute start automatically once the DOM
 * is ready. Everything is reachable through the global `ThinkingOrbs`.
 *
 * The geometry is a faithful transcription of the original TS engine and is
 * verified numerically against spec/orbs-golden.json (see verify.html).
 *   Copyright (c) 2026
 *   MIT License — see ../thinking-orbs/LICENSE
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------
  // 0. Core primitives
  // ------------------------------------------------------------------

  function lerp(a, b, f) {
    return a + (b - a) * f;
  }

  function frac(x) {
    return x - Math.floor(x);
  }

  /** Deterministic hash in [0, 1). */
  function hashD(a, b) {
    var h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return h - Math.floor(h);
  }

  /** Value noise on a 2D lattice — smooth, deterministic, cheap. */
  function vnoise(x, y) {
    var xi = Math.floor(x);
    var yi = Math.floor(y);
    var fx = x - xi;
    var fy = y - yi;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    var a = hashD(xi, yi);
    var b = hashD(xi + 1, yi);
    var c = hashD(xi, yi + 1);
    var d = hashD(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  /** Stable directions on a unit sphere (Fibonacci lattice). */
  function fibDir(i, n) {
    var golden = Math.PI * (3 - Math.sqrt(5));
    var y = 1 - (2 * (i + 0.5)) / n;
    var rad = Math.sqrt(1 - y * y);
    var a = i * golden;
    return [rad * Math.cos(a), y, rad * Math.sin(a)];
  }

  /** Shortest signed angular distance, wrapped to (-π, π]. */
  function angleDelta(a, b) {
    return Math.atan2(Math.sin(a - b), Math.cos(a - b));
  }

  /** Shared spin + tilt + orthographic projection. */
  function makeProj(yaw, tilt, cx, cy, scale) {
    var st = Math.sin(tilt);
    var ct = Math.cos(tilt);
    var sy = Math.sin(yaw);
    var cyw = Math.cos(yaw);
    return function (x, y, z) {
      var x1 = x * cyw + z * sy;
      var z1 = -x * sy + z * cyw;
      var y1 = y * ct - z1 * st;
      var z2 = y * st + z1 * ct;
      return [cx + x1 * scale, cy - y1 * scale, z2];
    };
  }

  /** Dot radii were tuned for a 300pt frame; sub-linear scaling keeps small
   *  spinners legible. Lower pow = radii shrink less with size. */
  function radiusScale(size, pow) {
    return Math.pow(size / 300, pow);
  }

  /**
   * Turn raw mode output into a finished frame: drop invisible marks, clamp
   * radii to the mode's floor, and z-sort far→near into draw order.
   */
  function finalizeFrame(dots, lines, rMin) {
    var visible = [];
    for (var i = 0; i < dots.length; i++) {
      var d = dots[i];
      if ((d.a === undefined ? 1 : d.a) < 0.02) continue;
      d.r = Math.max(rMin, d.r);
      visible.push(d);
    }
    visible.sort(function (a, b) {
      return a.z - b.z;
    });
    var visLines = [];
    for (var j = 0; j < lines.length; j++) {
      var l = lines[j];
      if ((l.a === undefined ? 1 : l.a) >= 0.02) visLines.push(l);
    }
    return { dots: visible, lines: visLines };
  }

  /** Matte grayscale dots. On dark substrates the ink value is mirrored. */
  function paint(ctx, dots, dark) {
    for (var i = 0; i < dots.length; i++) {
      var d = dots[i];
      var alpha = d.a === undefined ? 1 : d.a;
      var w = Math.min(1, Math.max(0, d.white));
      var g = Math.round((dark ? 1 - w : w) * 255);
      ctx.fillStyle = 'rgba(' + g + ',' + g + ',' + g + ',' + alpha + ')';
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Stroke pass for edge-based modes. Runs before paint so nodes sit on top. */
  function paintLines(ctx, lines, dark) {
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      var alpha = l.a === undefined ? 1 : l.a;
      var w = Math.min(1, Math.max(0, l.white));
      var g = Math.round((dark ? 1 - w : w) * 255);
      ctx.strokeStyle = 'rgba(' + g + ',' + g + ',' + g + ',' + alpha + ')';
      ctx.lineWidth = l.w;
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
    }
  }

  /** Paint a finished frame. Lines first, so nodes sit on top of their edges. */
  function paintFrame(ctx, frame, dark) {
    if (frame.lines.length) paintLines(ctx, frame.lines, dark);
    paint(ctx, frame.dots, dark);
  }

  // ------------------------------------------------------------------
  // 1. Density profiles + the multiplier machinery that scales them
  // ------------------------------------------------------------------

  var COUNT_PAIRS = [
    ['latRings', 'lonDensity'],
    ['rings', 'lonDensity'],
    ['lanes', 'segs']
  ];
  var COUNT_KEYS = ['orbitN', 'ghostN', 'nodeN', 'strandN', 'signals'];
  var ICON_DENSITY_KEYS = ['iconD'];
  var RADIUS_KEYS = [
    'rBase',
    'rDepth',
    'rActive',
    'rDot',
    'ghostR',
    'partR',
    'partRDepth',
    'nodeR',
    'nodeRDepth'
  ];

  function cloneOpts(opts) {
    var out = {};
    for (var k in opts) {
      if (Object.prototype.hasOwnProperty.call(opts, k)) out[k] = opts[k];
    }
    return out;
  }

  /** 2-D lattices scale as pairs (each side × √scale, total × scale);
   *  flat lists scale linearly; an explicit 0 opts out of a layer entirely. */
  function scaleCounts(opts, scale) {
    var out = cloneOpts(opts);
    var done = {};
    var rt = Math.sqrt(scale);
    for (var pi = 0; pi < COUNT_PAIRS.length; pi++) {
      var a = COUNT_PAIRS[pi][0];
      var b = COUNT_PAIRS[pi][1];
      var va = out[a];
      var vb = out[b];
      if (va != null && vb != null && !done[a] && !done[b]) {
        out[a] = Math.max(2, Math.round(va * rt));
        out[b] = Math.max(2, Math.round(vb * rt));
        done[a] = done[b] = true;
      }
    }
    for (var ci = 0; ci < COUNT_KEYS.length; ci++) {
      var ck = COUNT_KEYS[ci];
      var cv = out[ck];
      if (cv != null && cv !== 0 && !done[ck]) out[ck] = Math.max(1, Math.round(cv * scale));
    }
    for (var di = 0; di < ICON_DENSITY_KEYS.length; di++) {
      var dk = ICON_DENSITY_KEYS[di];
      var dv = out[dk];
      if (dv != null) out[dk] = Math.max(0.02, dv * scale);
    }
    return out;
  }

  function scaleRadii(opts, scale) {
    var out = cloneOpts(opts);
    for (var i = 0; i < RADIUS_KEYS.length; i++) {
      var rk = RADIUS_KEYS[i];
      var v = out[rk];
      if (v != null) out[rk] = v * scale;
    }
    out.rSizeMul = (out.rSizeMul === undefined ? 1 : out.rSizeMul) * scale;
    return out;
  }

  /** Base (fine) profiles per mode, before preset multipliers. */
  var BASE_PROFILES = {
    globe: {
      latRings: 17,
      lonDensity: 44,
      rBase: 0.6,
      rDepth: 1.7,
      rBoost: 1,
      inkFar: 0.62,
      inkSpan: 0.54,
      rsPow: 0.6,
      rMin: 0.3
    },
    orbits: {
      orbitN: 12,
      ghostN: 40,
      ghostR: 0.9,
      ghostA: 0.5,
      particles: 3,
      partR: 1.2,
      partRDepth: 1.6,
      rsPow: 0.6,
      rMin: 0.3
    },
    rubik: {
      latRings: 15,
      lonDensity: 40,
      moveCount: 14,
      rBase: 0.6,
      rDepth: 1.7,
      rActive: 0.3,
      inkFar: 0.62,
      inkSpan: 0.54,
      rsPow: 0.6,
      rMin: 0.3
    },
    wave: {
      rings: 15,
      lonDensity: 40,
      rBase: 0.6,
      rDepth: 1.7,
      rsPow: 0.6,
      rMin: 0.3
    },
    web: {
      nodeN: 30,
      thr: 0.72,
      signals: 5,
      nodeR: 1.4,
      nodeRDepth: 1.8,
      lineW: 0.8,
      rsPow: 0.6,
      rMin: 0.3
    },
    braid: {
      strandN: 52,
      turns: 3,
      ghostN: 150,
      rBase: 1.2,
      rDepth: 1.8,
      rsPow: 0.6,
      rMin: 0.3
    },
    ribbon: {
      lanes: 5,
      segs: 88,
      ghostN: 150,
      rBase: 1.1,
      rDepth: 1.7,
      rsPow: 0.6,
      rMin: 0.3
    },
    ring: {
      lanes: 5,
      segs: 88,
      ghostN: 0,
      faceOn: 1,
      rBase: 1.1,
      rDepth: 1.7,
      rsPow: 0.6,
      rMin: 0.3
    },
    morph: {
      rDot: 0.021,
      iconD: 1,
      rMin: 0.25
    }
  };

  // ------------------------------------------------------------------
  // 2. Presets + resolution (with interpolation for arbitrary sizes)
  // ------------------------------------------------------------------

  var STATE_TO_MODE = {
    working: 'orbits',
    searching: 'globe',
    solving: 'rubik',
    listening: 'wave',
    connecting: 'web',
    weaving: 'braid',
    composing: 'ribbon',
    breathing: 'ring',
    shaping: 'morph'
  };

  /** Tuned presets: 64 (chat-avatar scale) and 20 (inline-text scale). */
  var PRESETS = {
    orbits: {
      20: { speed: 3.9, count: 0.238, size: 2.4 },
      64: { speed: 1.885, count: 1, size: 1 }
    },
    globe: {
      20: { speed: 2.665, count: 0.105, size: 1.75, extra: { scanMul: 4.335, dimBase: 0.45 } },
      64: { speed: 2.015, count: 0.42, size: 1.15, extra: { scanMul: 4.08, dimBase: 0.45 } }
    },
    rubik: {
      20: { speed: 1.95, count: 0.088, size: 1.9 },
      64: { speed: 1.82, count: 0.35, size: 1.05 }
    },
    wave: {
      20: { speed: 3.998, count: 0.105, size: 1.6 },
      64: { speed: 4.388, count: 0.341, size: 1 }
    },
    web: {
      20: { speed: 6.63, count: 0.25, size: 1.52 },
      64: { speed: 3.315, count: 1.35, size: 0.95 }
    },
    braid: {
      20: { speed: 2.75, count: 0.1125, size: 1.36 },
      64: { speed: 1.625, count: 0.5, size: 1 }
    },
    ribbon: {
      20: { speed: 3.12, count: 0.051, size: 1.073, extra: { spin: 0, bandMul: 4.94, wobMul: 1 } },
      64: { speed: 2.34, count: 0.25, size: 0.85, extra: { spin: 0, bandMul: 3.9, wobMul: 1 } }
    },
    ring: {
      20: { speed: 3.78, count: 0.028, size: 1.622, extra: { spin: 0, bandMul: 3.968, wobMul: 0.565 } },
      64: { speed: 3.24, count: 0.25, size: 0.956, extra: { spin: 0, bandMul: 3.627, wobMul: 0.368 } }
    },
    morph: {
      20: { speed: 2.08, count: 0.53, size: 1.011, extra: { spread: 1.45 } },
      64: { speed: 2.405, count: 0.702, size: 0.395, extra: { spread: 1.45 } }
    }
  };

  var LABELS = {
    working: 'Working…',
    searching: 'Searching…',
    solving: 'Solving…',
    listening: 'Listening…',
    connecting: 'Connecting…',
    weaving: 'Weaving…',
    composing: 'Composing…',
    breathing: 'Thinking…',
    shaping: 'Shaping…'
  };

  /**
   * Resolve a (state, size) pair to its mode + fully-scaled draw options.
   * Sizes other than the two tuned presets (64, 20) are interpolated
   * linearly between the presets (extrapolated outside [20, 64]); each
   * preset dimension ships independently because the presets are separate
   * designs, not a scale factor — interpolation is the closest affine
   * approximation and keeps viewports at any pixel size sensible.
   */
  var presetCache = Object.create(null);

  function resolvePreset(state, size) {
    var key = state + '@' + size;
    var hit = presetCache[key];
    if (hit) return hit;

    var mode = STATE_TO_MODE[state];
    var p20 = PRESETS[mode][20];
    var p64 = PRESETS[mode][64];
    var preset;
    if (size === 64) preset = p64;
    else if (size === 20) preset = p20;
    else {
      var f = (size - 20) / 44;
      preset = {
        speed: lerp(p20.speed, p64.speed, f),
        count: lerp(p20.count, p64.count, f),
        size: lerp(p20.size, p64.size, f)
      };
      var eKeys = new Set();
      if (p20.extra) for (var k in p20.extra) eKeys.add(k);
      if (p64.extra) for (var k2 in p64.extra) eKeys.add(k2);
      if (eKeys.size) {
        preset.extra = {};
        eKeys.forEach(function (ek) {
          var v20 = p20.extra ? p20.extra[ek] : undefined;
          var v64 = p64.extra ? p64.extra[ek] : undefined;
          preset.extra[ek] =
            v20 === undefined ? v64 : v64 === undefined ? v20 : lerp(v20, v64, f);
        });
      }
    }

    var opts = cloneOpts(BASE_PROFILES[mode]);
    if (preset.count !== 1) opts = scaleCounts(opts, preset.count);
    if (preset.size !== 1) opts = scaleRadii(opts, preset.size);
    if (preset.extra) {
      for (var xk in preset.extra) opts[xk] = preset.extra[xk];
    }

    var resolved = { mode: mode, speed: preset.speed, opts: opts };
    presetCache[key] = resolved;
    return resolved;
  }

  // ------------------------------------------------------------------
  // 3. Mode geometry — pure math over (size, t, opts), no rendering surface
  // ------------------------------------------------------------------

  // --- Orbits: particles on tilted orbits — the "working" state ---------

  function frameOrbits(size, t, o) {
    var cx = size / 2;
    var cy = size / 2;
    var R = (size / 2) * 0.82;
    var pt = makeProj(t * 0.12, 0.3, cx, cy, 1);
    var rs = radiusScale(size, o.rsPow === undefined ? 0.6 : o.rsPow);

    var dots = [];
    var orbitN = o.orbitN === undefined ? 12 : o.orbitN;
    var ghostN = o.ghostN === undefined ? 40 : o.ghostN;
    var particles = o.particles === undefined ? 3 : o.particles;

    for (var orb = 0; orb < orbitN; orb++) {
      var h1 = hashD(orb, 1.7);
      var h2 = hashD(orb, 5.2);
      var h3 = hashD(orb, 8.9);
      var ro = R * (0.45 + 0.52 * h1);
      var th = h1 * 2 * Math.PI;
      var phi = Math.acos(2 * h2 - 1);
      var nx = Math.sin(phi) * Math.cos(th);
      var ny = Math.cos(phi);
      var nz = Math.sin(phi) * Math.sin(th);
      var ux = -ny;
      var uy = nx;
      var uz = 0;
      var ul = Math.max(1e-6, Math.sqrt(ux * ux + uy * uy));
      ux /= ul;
      uy /= ul;
      var vx = ny * uz - nz * uy;
      var vy = nz * ux - nx * uz;
      var vz = nx * uy - ny * ux;
      var speed = (0.25 + 0.55 * h3) * (h3 > 0.5 ? 1 : -1);

      for (var k = 0; k < ghostN; k++) {
        var a = (k / ghostN) * 2 * Math.PI;
        var pr = pt(
          (ux * Math.cos(a) + vx * Math.sin(a)) * ro,
          (uy * Math.cos(a) + vy * Math.sin(a)) * ro,
          (uz * Math.cos(a) + vz * Math.sin(a)) * ro
        );
        var depth = (pr[2] / ro + 1) / 2;
        dots.push({
          x: pr[0],
          y: pr[1],
          z: pr[2],
          r: (o.ghostR === undefined ? 0.9 : o.ghostR) * rs,
          white: 0.72,
          a: (o.ghostA === undefined ? 0.5 : o.ghostA) * (0.4 + 0.6 * depth)
        });
      }
      for (var m = 0; m < particles; m++) {
        var a2 = t * speed + (m / particles) * 2 * Math.PI + h2 * 6;
        var pr2 = pt(
          (ux * Math.cos(a2) + vx * Math.sin(a2)) * ro,
          (uy * Math.cos(a2) + vy * Math.sin(a2)) * ro,
          (uz * Math.cos(a2) + vz * Math.sin(a2)) * ro
        );
        var depth2 = (pr2[2] / ro + 1) / 2;
        dots.push({
          x: pr2[0],
          y: pr2[1],
          z: pr2[2],
          r: ((o.partR === undefined ? 1.2 : o.partR) + (o.partRDepth === undefined ? 1.6 : o.partRDepth) * depth2) * rs,
          white: 0.3 - 0.22 * depth2
        });
      }
    }
    return finalizeFrame(dots, [], o.rMin === undefined ? 0.3 : o.rMin);
  }

  // --- shared solver heartbeat (rubik) -----------------------------------

  function solveCycle(time, count, slotDur, rest) {
    var cyc = 2 * count * slotDur + rest;
    var tc = time % cyc;
    var amount = new Array(count);
    for (var i = 0; i < count; i++) amount[i] = 0;
    var active = -1;
    if (tc < 2 * count * slotDur) {
      var slot = Math.floor(tc / slotDur);
      var p = (tc - slot * slotDur) / slotDur;
      var cl = Math.min(1, p / 0.7);
      var ep = 1 - Math.pow(1 - cl, 3);
      if (slot < count) {
        for (var i2 = 0; i2 < slot; i2++) amount[i2] = 1;
        amount[slot] = ep;
        active = slot;
      } else {
        var u = 2 * count - 1 - slot;
        for (var i3 = 0; i3 < u; i3++) amount[i3] = 1;
        amount[u] = 1 - ep;
        active = u;
      }
    }
    return { amount: amount, active: active };
  }

  function applyMoves(pt3, moves, sc) {
    var x = pt3[0];
    var y = pt3[1];
    var z = pt3[2];
    var inActive = false;
    for (var i = 0; i < moves.length; i++) {
      if (sc.amount[i] <= 0) continue;
      var mv = moves[i];
      var coord = mv.axis === 0 ? x : mv.axis === 1 ? y : z;
      if (coord < mv.lo || coord >= mv.hi) continue;
      if (i === sc.active) inActive = true;
      var a = mv.ang * sc.amount[i];
      var ca = Math.cos(a);
      var sa = Math.sin(a);
      if (mv.axis === 0) {
        var y2 = y * ca - z * sa;
        z = y * sa + z * ca;
        y = y2;
      } else if (mv.axis === 1) {
        var x2 = x * ca + z * sa;
        z = -x * sa + z * ca;
        x = x2;
      } else {
        var x3 = x * ca - y * sa;
        y = x * sa + y * ca;
        x = x3;
      }
    }
    return [x, y, z, inActive];
  }

  function makeMoves(count) {
    var moves = [];
    for (var i = 0; i < count; i++) {
      var axis = Math.min(2, Math.floor(hashD(i, 2.3) * 3));
      var lo = -1.0 + 0.5 * Math.min(3, Math.floor(hashD(i, 5.9) * 4));
      var dir = hashD(i, 7.7) < 0.5 ? 1 : -1;
      moves.push({ axis: axis, lo: lo, hi: lo + 0.5, ang: (dir * Math.PI) / 2 });
    }
    return moves;
  }

  // --- globe: lat/long field, a scan meridian sweeps — searching --------

  function frameGlobe(size, t, o) {
    var spin = 0.5;
    var cx = size / 2;
    var cy = size / 2;
    var radius = (size / 2) * 0.82;
    var tilt = 0.4 + 0.06 * Math.sin(t * 0.35);
    var pt = makeProj(t * spin, tilt, cx, cy, radius);
    var scan = t * (spin + (1.7 - spin) * (o.scanMul === undefined ? 1 : o.scanMul));
    var rs = radiusScale(size, o.rsPow === undefined ? 0.6 : o.rsPow);
    var dimBase = o.dimBase === undefined ? 1 : o.dimBase;

    var dots = [];
    var latRings = o.latRings === undefined ? 17 : o.latRings;
    var lonDensity = o.lonDensity === undefined ? 44 : o.lonDensity;
    for (var li = 0; li <= latRings; li++) {
      var lat = -Math.PI / 2 + (li / latRings) * Math.PI;
      var cosLat = Math.cos(lat);
      var sinLat = Math.sin(lat);
      var lonCount = Math.max(1, Math.round(Math.abs(cosLat) * lonDensity));
      for (var lj = 0; lj < lonCount; lj++) {
        var lon = (lj / lonCount) * 2 * Math.PI;
        var pr = pt(cosLat * Math.cos(lon), sinLat, cosLat * Math.sin(lon));
        var depth = (pr[2] + 1) / 2;
        var d = angleDelta(lon + t * spin, scan);
        var boost = Math.exp(-(d * d) / 0.18) * Math.max(0, pr[2]);
        dots.push({
          x: pr[0],
          y: pr[1],
          z: pr[2],
          r: ((o.rBase === undefined ? 0.6 : o.rBase) + (o.rDepth === undefined ? 1.7 : o.rDepth) * depth + (o.rBoost === undefined ? 1 : o.rBoost) * boost) * rs,
          white: (o.inkFar === undefined ? 0.62 : o.inkFar) - (o.inkSpan === undefined ? 0.54 : o.inkSpan) * depth,
          a: dimBase + (1 - dimBase) * Math.min(1, boost)
        });
      }
    }
    return finalizeFrame(dots, [], o.rMin === undefined ? 0.3 : o.rMin);
  }

  // --- rubik: bands twist in quarter turns, scramble → solve — solving ---

  function frameRubik(size, t, o) {
    var cx = size / 2;
    var cy = size / 2;
    var R = (size / 2) * 0.82;
    var pt = makeProj(t * 0.55, 0.35 + 0.1 * Math.sin(t * 0.9), cx, cy, R);
    var rs = radiusScale(size, o.rsPow === undefined ? 0.6 : o.rsPow);
    var moveCount = o.moveCount === undefined ? 14 : o.moveCount;
    var moves = makeMoves(moveCount);
    var sc = solveCycle(t, moveCount, 0.42, 1.2);

    var dots = [];
    var latRings = o.latRings === undefined ? 15 : o.latRings;
    var lonDensity = o.lonDensity === undefined ? 40 : o.lonDensity;
    for (var li = 0; li <= latRings; li++) {
      var lat = -Math.PI / 2 + (li / latRings) * Math.PI;
      var cosLat = Math.cos(lat);
      var sinLat = Math.sin(lat);
      var lonCount = Math.max(1, Math.round(Math.abs(cosLat) * lonDensity));
      for (var lj = 0; lj < lonCount; lj++) {
        var lon = (lj / lonCount) * 2 * Math.PI;
        var ap = applyMoves([cosLat * Math.cos(lon), sinLat, cosLat * Math.sin(lon)], moves, sc);
        var pr = pt(ap[0], ap[1], ap[2]);
        var depth = (pr[2] + 1) / 2;
        dots.push({
          x: pr[0],
          y: pr[1],
          z: pr[2],
          r: ((o.rBase === undefined ? 0.6 : o.rBase) + (o.rDepth === undefined ? 1.7 : o.rDepth) * depth + (ap[3] ? o.rActive === undefined ? 0.3 : o.rActive : 0)) * rs,
          white: (o.inkFar === undefined ? 0.62 : o.inkFar) - (o.inkSpan === undefined ? 0.54 : o.inkSpan) * depth - (ap[3] ? 0.14 : 0)
        });
      }
    }
    return finalizeFrame(dots, [], o.rMin === undefined ? 0.3 : o.rMin);
  }

  // --- wave: a waveform rolls through the rings — listening -------------

  function frameWave(size, t, o) {
    var cx = size / 2;
    var cy = size / 2;
    var R = (size / 2) * 0.874;
    var pt = makeProj(t * 0.18, 0.38, cx, cy, 1);
    var rs = radiusScale(size, o.rsPow === undefined ? 0.6 : o.rsPow);

    var dots = [];
    var rings = o.rings === undefined ? 15 : o.rings;
    var lonDensity = o.lonDensity === undefined ? 40 : o.lonDensity;
    for (var ri = 0; ri <= rings; ri++) {
      var lat = -Math.PI / 2 + (ri / rings) * Math.PI;
      var cosLat = Math.cos(lat);
      var sinLat = Math.sin(lat);
      var w = 0.62 * Math.sin(t * 2.1 - ri * 0.52) + 0.38 * Math.sin(t * 1.27 + ri * 0.83);
      var rr = R * (0.88 + 0.105 * w);
      var lonCount = Math.max(1, Math.round(Math.abs(cosLat) * lonDensity));
      for (var lj = 0; lj < lonCount; lj++) {
        var lon = (lj / lonCount) * 2 * Math.PI;
        var pr = pt(cosLat * Math.cos(lon) * rr, sinLat * rr, cosLat * Math.sin(lon) * rr);
        var depth = (pr[2] / R + 1) / 2;
        var crest = Math.max(0, w);
        dots.push({
          x: pr[0],
          y: pr[1],
          z: pr[2],
          r: ((o.rBase === undefined ? 0.6 : o.rBase) + (o.rDepth === undefined ? 1.7 : o.rDepth) * depth) * (1 + 0.4 * crest) * rs,
          white: 0.66 - 0.56 * depth - 0.1 * crest
        });
      }
    }
    return finalizeFrame(dots, [], o.rMin === undefined ? 0.3 : o.rMin);
  }

  // --- web: a constellation wires itself — connecting -------------------

  function frameWeb(size, t, o) {
    var cx = size / 2;
    var cy = size / 2;
    var R = (size / 2) * 0.8 * (o.spread === undefined ? 1 : o.spread);
    var pt = makeProj(t * 0.12, 0.32, cx, cy, R);
    var rs = radiusScale(size, o.rsPow === undefined ? 0.6 : o.rsPow);

    var nodeN = o.nodeN === undefined ? 30 : o.nodeN;
    var thr = o.thr === undefined ? 0.72 : o.thr;
    var nodeR = o.nodeR === undefined ? 1.4 : o.nodeR;
    var nodeRDepth = o.nodeRDepth === undefined ? 1.8 : o.nodeRDepth;

    var nodes = [];
    for (var i = 0; i < nodeN; i++) {
      var d = fibDir(i, nodeN);
      var x = d[0] + 0.3 * (vnoise(i * 0.31 + 9, t * 0.24) - 0.5) * 2;
      var y = d[1] + 0.3 * (vnoise(i * 0.53 + 27, t * 0.21) - 0.5) * 2;
      var z = d[2] + 0.3 * (vnoise(i * 0.77 + 55, t * 0.27) - 0.5) * 2;
      var l = Math.sqrt(x * x + y * y + z * z);
      nodes.push([x / l, y / l, z / l]);
    }

    var lines = [];
    var dots = [];

    for (var i2 = 0; i2 < nodeN; i2++) {
      for (var j = i2 + 1; j < nodeN; j++) {
        var dx = nodes[i2][0] - nodes[j][0];
        var dy = nodes[i2][1] - nodes[j][1];
        var dz = nodes[i2][2] - nodes[j][2];
        var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist >= thr) continue;
        var p1 = pt(nodes[i2][0], nodes[i2][1], nodes[i2][2]);
        var p2 = pt(nodes[j][0], nodes[j][1], nodes[j][2]);
        var depth = ((p1[2] + p2[2]) / 2 + 1) / 2;
        lines.push({
          x1: p1[0],
          y1: p1[1],
          x2: p2[0],
          y2: p2[1],
          white: 0.42,
          a: (1 - dist / thr) * (0.3 + 0.55 * depth),
          w: Math.max(0.6, (o.lineW === undefined ? 0.8 : o.lineW) * rs)
        });
      }
    }

    for (var i3 = 0; i3 < nodeN; i3++) {
      var pp = pt(nodes[i3][0], nodes[i3][1], nodes[i3][2]);
      var dep = (pp[2] + 1) / 2;
      var pulse = 1 + 0.25 * Math.sin(t * 1.4 + i3 * 2.7);
      dots.push({
        x: pp[0],
        y: pp[1],
        z: pp[2],
        r: (nodeR + nodeRDepth * dep) * pulse * rs,
        white: 0.55 - 0.45 * dep
      });
    }

    var signals = o.signals === undefined ? 5 : o.signals;
    for (var s = 0; s < signals; s++) {
      var seg = Math.floor(t * 0.55 + s * 7.31);
      var a = Math.floor(hashD(seg, s * 3.1 + 1.7) * nodeN);
      var b = Math.floor(hashD(seg, s * 5.7 + 4.2) * nodeN);
      if (a === b) continue;
      var f = frac(t * 0.55 + s * 7.31);
      var sx = lerp(nodes[a][0], nodes[b][0], f);
      var sy = lerp(nodes[a][1], nodes[b][1], f);
      var sz = lerp(nodes[a][2], nodes[b][2], f);
      var sl = Math.max(1e-6, Math.sqrt(sx * sx + sy * sy + sz * sz));
      var sp = pt(sx / sl, sy / sl, sz / sl);
      var sd = (sp[2] + 1) / 2;
      dots.push({
        x: sp[0],
        y: sp[1],
        z: sp[2],
        r: (nodeR * 1.5 + nodeRDepth * sd) * rs,
        white: 0.05,
        a: 0.5 + 0.5 * sd
      });
    }

    return finalizeFrame(dots, lines, o.rMin === undefined ? 0.3 : o.rMin);
  }

  // --- braid: three strands plait around the sphere — weaving -----------

  function frameBraid(size, t, o) {
    var cx = size / 2;
    var cy = size / 2;
    var R = (size / 2) * 0.76;
    var pt = makeProj(t * 0.4, 0.3, cx, cy, 1);
    var rs = radiusScale(size, o.rsPow === undefined ? 0.6 : o.rsPow);

    var dots = [];
    var ghostN = o.ghostN === undefined ? 150 : o.ghostN;
    for (var i = 0; i < ghostN; i++) {
      var d = fibDir(i, ghostN);
      var pr = pt(d[0] * R, d[1] * R, d[2] * R);
      var depth = (pr[2] / R + 1) / 2;
      dots.push({ x: pr[0], y: pr[1], z: pr[2], r: 0.8 * rs, white: 0.78, a: 0.1 + 0.22 * depth });
    }

    var strandN = o.strandN === undefined ? 52 : o.strandN;
    var turns = o.turns === undefined ? 3 : o.turns;
    for (var s = 0; s < 3; s++) {
      var phase = (s / 3) * 2 * Math.PI;
      for (var i2 = 0; i2 < strandN; i2++) {
        var u = (frac(i2 / strandN + t * 0.045) * 2 - 1) * 0.96;
        var surf = Math.sqrt(Math.max(0, 1 - u * u));
        var endFade = Math.min(1, (1 - Math.abs(u)) / 0.1);
        var a = u * Math.PI * turns + phase;
        var weave = 1 + 0.075 * Math.sin(u * Math.PI * turns * 2 + phase * 2 + t * 0.8);
        var rr = surf * R * weave;
        var pr2 = pt(Math.cos(a) * rr, u * R * weave, Math.sin(a) * rr);
        var depth2 = (pr2[2] / R + 1) / 2;
        dots.push({
          x: pr2[0],
          y: pr2[1],
          z: pr2[2],
          r: ((o.rBase === undefined ? 1.2 : o.rBase) + (o.rDepth === undefined ? 1.8 : o.rDepth) * depth2) * rs,
          white: 0.55 - 0.45 * depth2,
          a: endFade * (0.45 + 0.55 * depth2)
        });
      }
    }
    return finalizeFrame(dots, [], o.rMin === undefined ? 0.3 : o.rMin);
  }

  // --- ribbon: undulating sash (composing); face-on ring (breathing) ----

  function frameRibbon(size, t, o) {
    var cx = size / 2;
    var cy = size / 2;
    var R = (size / 2) * 0.78;
    var spin = o.spin === undefined ? 1 : o.spin;
    var camTilt = 0.3;
    var pt = makeProj(t * 0.1 * spin, camTilt, cx, cy, 1);
    var rs = radiusScale(size, o.rsPow === undefined ? 0.6 : o.rsPow);

    var dots = [];
    var ghostN = o.ghostN === undefined ? 150 : o.ghostN;
    for (var i = 0; i < ghostN; i++) {
      var d = fibDir(i, ghostN);
      var pr = pt(d[0] * R, d[1] * R, d[2] * R);
      var depth = (pr[2] / R + 1) / 2;
      dots.push({ x: pr[0], y: pr[1], z: pr[2], r: 0.8 * rs, white: 0.78, a: 0.1 + 0.22 * depth });
    }

    var ya = t * 0.24 * spin;
    var ta = o.faceOn ? -camTilt : 0.55 + 0.3 * Math.sin(t * 0.18) * spin;
    var ux = Math.cos(ya);
    var uy = 0;
    var uz = Math.sin(ya);
    var vx = -uz * Math.sin(ta);
    var vy = Math.cos(ta);
    var vz = ux * Math.sin(ta);
    var nx = uy * vz - uz * vy;
    var ny = uz * vx - ux * vz;
    var nz = ux * vy - uy * vx;

    var wobAmp = 0.23 * (o.wobMul === undefined ? 1 : o.wobMul);
    var baseR = o.faceOn ? R / (1 + 0.85 * wobAmp) : R;

    var baseLanes = o.lanes === undefined ? 5 : o.lanes;
    var segs = o.segs === undefined ? 88 : o.segs;
    var lanes = Math.max(1, Math.round(baseLanes * (o.bandMul === undefined ? 1 : o.bandMul)));
    for (var w = 0; w < lanes; w++) {
      var laneOff = (w - (lanes - 1) / 2) * 0.075;
      var edge = Math.abs(w - (lanes - 1) / 2) / Math.max(1, (lanes - 1) / 2);
      for (var k = 0; k < segs; k++) {
        var a = (k / segs) * 2 * Math.PI;
        var wob =
          (0.16 * Math.sin(a * 3 - t * 1.7 + w * 0.22) + 0.07 * Math.sin(a * 5 + t * 1.1)) *
          (o.wobMul === undefined ? 1 : o.wobMul);
        var radial = o.faceOn ? 1 + wob : 1;
        var off = o.faceOn ? laneOff : laneOff + wob;
        var x = ux * Math.cos(a) + vx * Math.sin(a) + nx * off;
        var y = uy * Math.cos(a) + vy * Math.sin(a) + ny * off;
        var z = uz * Math.cos(a) + vz * Math.sin(a) + nz * off;
        var l = Math.sqrt(x * x + y * y + z * z);
        var rr = baseR * radial;
        var pr2 = pt((x / l) * rr, (y / l) * rr, (z / l) * rr);
        var depth2 = (pr2[2] / R + 1) / 2;
        dots.push({
          x: pr2[0],
          y: pr2[1],
          z: pr2[2],
          r: ((o.rBase === undefined ? 1.1 : o.rBase) + (o.rDepth === undefined ? 1.7 : o.rDepth) * depth2) * (1 - 0.25 * edge) * rs,
          white: 0.52 - 0.44 * depth2 + 0.18 * edge,
          a: 0.4 + 0.6 * depth2
        });
      }
    }
    return finalizeFrame(dots, [], o.rMin === undefined ? 0.3 : o.rMin);
  }

  // --- morph: dotted outline, circle → triangle → square — shaping ------

  function smoothE(x) {
    return x * x * (3 - 2 * x);
  }

  function polyPath(verts) {
    var V = verts.length;
    var L = [];
    var total = 0;
    for (var i = 0; i < V; i++) {
      var a = verts[i];
      var b = verts[(i + 1) % V];
      var l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      L.push(l);
      total += l;
    }
    return function (f) {
      var target = f * total;
      var i2 = 0;
      while (target > L[i2] && i2 < V - 1) {
        target -= L[i2];
        i2++;
      }
      var a2 = verts[i2];
      var b2 = verts[(i2 + 1) % V];
      var ff = L[i2] ? Math.min(1, target / L[i2]) : 0;
      return [a2[0] + (b2[0] - a2[0]) * ff, a2[1] + (b2[1] - a2[1]) * ff];
    };
  }

  var CIRCLE = function (f) {
    var a = -Math.PI / 2 + f * 2 * Math.PI;
    return [Math.cos(a) * 0.24, Math.sin(a) * 0.24];
  };
  var TRIANGLE = polyPath([
    [0.0, -0.26],
    [0.24, 0.16],
    [-0.24, 0.16]
  ]);
  var SQUARE = polyPath([
    [0, -0.2],
    [0.2, -0.2],
    [0.2, 0.2],
    [-0.2, 0.2],
    [-0.2, -0.2]
  ]);
  var CYCLE = [CIRCLE, TRIANGLE, SQUARE];

  function morphN(d) {
    return Math.max(6, Math.round(34 * d));
  }

  var MORPH_HOLD = 1.4;
  var MORPH_MORPH = 0.9;
  var MORPH_SEG = MORPH_HOLD + MORPH_MORPH;

  function frameMorph(size, t, o) {
    var K = CYCLE.length;
    var tc = t % (MORPH_SEG * K);
    var k = Math.floor(tc / MORPH_SEG);
    var local = tc - k * MORPH_SEG;
    var m = local > MORPH_HOLD ? smoothE((local - MORPH_HOLD) / MORPH_MORPH) : 0;
    var sprd = o.spread === undefined ? 1 : o.spread;

    var pA = CYCLE[k];
    var pB = CYCLE[(k + 1) % K];
    var M = 160;
    var pts = [];
    for (var i = 0; i < M; i++) {
      var f = i / M;
      var a = pA(f);
      var b = pB(f);
      pts.push([(a[0] + (b[0] - a[0]) * m) * sprd, (a[1] + (b[1] - a[1]) * m) * sprd]);
    }
    var L = [];
    var total = 0;
    for (var i2 = 0; i2 < M; i2++) {
      var a2 = pts[i2];
      var b2 = pts[(i2 + 1) % M];
      var l = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
      L.push(l);
      total += l;
    }

    var n = morphN(o.iconD === undefined ? 1 : o.iconD);
    var re = (o.rDot === undefined ? 0.021 : o.rDot) * 1.35 * sprd;
    var pulse = 1 + 0.02 * Math.sin(local * 3.1);

    var dots = [];
    var c2 = size / 2;
    var seg = 0;
    var acc = 0;
    for (var k2 = 0; k2 < n; k2++) {
      var target = (k2 / n) * total;
      while (acc + L[seg] < target && seg < M - 1) {
        acc += L[seg];
        seg++;
      }
      var a3 = pts[seg];
      var b3 = pts[(seg + 1) % M];
      var f2 = L[seg] ? Math.min(1, (target - acc) / L[seg]) : 0;
      var x = (a3[0] + (b3[0] - a3[0]) * f2) * pulse;
      var y = (a3[1] + (b3[1] - a3[1]) * f2) * pulse;
      dots.push({
        x: c2 + x * size,
        y: c2 + y * size,
        z: 0,
        r: Math.max(0.35, re * size),
        white: 0.1
      });
    }
    return finalizeFrame(dots, [], o.rMin === undefined ? 0.25 : o.rMin);
  }

  var MODE_FRAMES = {
    orbits: frameOrbits,
    globe: frameGlobe,
    rubik: frameRubik,
    wave: frameWave,
    web: frameWeb,
    braid: frameBraid,
    ribbon: frameRibbon,
    ring: frameRibbon,
    morph: frameMorph
  };

  // ------------------------------------------------------------------
  // 4. Theme helpers
  // ------------------------------------------------------------------

  /** First ancestor (or self) carrying data-theme or a dark/light class. */
  function ancestorTheme(el) {
    var node = el;
    while (node && node.getAttribute) {
      var attr = node.getAttribute('data-theme');
      if (attr === 'dark') return true;
      if (attr === 'light') return false;
      if (node.classList) {
        if (node.classList.contains('dark')) return true;
        if (node.classList.contains('light')) return false;
      }
      node = node.parentElement;
    }
    return null;
  }

  function systemDark() {
    return typeof matchMedia === 'undefined' || matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function supportsMatchMedia() {
    return typeof matchMedia !== 'undefined' && typeof matchMedia('x').addEventListener === 'function';
  }

  // ------------------------------------------------------------------
  // 5. Orb instance
  // ------------------------------------------------------------------

  /**
   * Create a ThinkingOrb. `canvas` may be a real <canvas> or any container
   * element (a canvas is created inside it). Options:
   *
   *   state  'working'|'searching'|'solving'|'listening'|'connecting'
   *          |'weaving'|'composing'|'breathing'|'shaping'   (default 'working')
   *   size   CSS px — 64 and 20 are the tuned presets; any other value is
   *          interpolated between them                          (default 64)
   *   theme  'auto'|'dark'|'light'                             (default 'auto')
   *   speed  multiplier on the preset's baked speed            (default 1)
   *   paused freeze on the current frame                       (default false)
   *   label  overrides the per-state aria-label
   *
   * Returns an instance with setState / setSize / setTheme / setSpeed /
   * setPaused / destroy.
   */
  function createOrb(canvas, opts) {
    opts = opts || {};
    var self = this instanceof createOrb ? this : Object.create(createOrb.prototype);
    self.canvas = canvas;
    self.created = false;
    if (!canvas || typeof canvas.appendChild !== 'function') {
      throw new Error('ThinkingOrb: a <canvas> element or container element is required');
    }
    if (typeof canvas.getContext !== 'function') {
      var c = document.createElement('canvas');
      canvas.appendChild(c);
      canvas = c;
      self.created = true;
    }
    self.canvas = canvas;

    self.state = (STATE_TO_MODE[opts.state] && opts.state) || 'working';
    self.size = opts.size === undefined ? 64 : Number(opts.size);
    if (!(self.size > 0)) self.size = 64;
    self.themeMode = opts.theme === 'dark' || opts.theme === 'light' ? opts.theme : 'auto';
    self.speedMul = opts.speed === undefined ? 1 : Number(opts.speed);
    self.pausedFlag = !!opts.paused;
    self.label = opts.label || null;

    self.dpr = Math.min(2, (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1);
    self.ctx = canvas.getContext('2d');
    if (!self.ctx) throw new Error('ThinkingOrb: could not get a 2d context');
    self._running = false;
    self._raf = 0;
    self._visible = true;
    self._io = null;

    self._resize();
    self._relabel();
    self._resolveDark();

    var reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)');
    self.reduced = !!reduced.matches;
    self._onMotionPref = function (e) {
      self.reduced = e.matches;
      if (self.reduced) {
        self._stop();
        self._drawStatic();
      } else if (!self.pausedFlag) {
        self._start();
      }
    };
    if (reduced && reduced.addEventListener) {
      reduced.addEventListener('change', self._onMotionPref);
      self._motionQuery = reduced;
    }

    var mq = supportsMatchMedia() ? matchMedia('(prefers-color-scheme: dark)') : null;
    self._onSystemTheme = function () {
      self._resolveDark();
      self._repaint();
    };
    if (mq && mq.addEventListener) {
      mq.addEventListener('change', self._onSystemTheme);
      self._themeQuery = mq;
    }

    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      self._mo = new MutationObserver(function () {
        if (self.themeMode !== 'auto') return;
        var prev = self.dark;
        self._resolveDark();
        if (prev !== self.dark) self._repaint();
      });
      self._mo.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-theme'],
        subtree: true
      });
    }

    if (typeof IntersectionObserver !== 'undefined') {
      self._io = new IntersectionObserver(function (entries) {
        self._visible = !!entries[0].isIntersecting;
        if (self._visible && document.visibilityState !== 'hidden') self._start();
        else self._stop();
      });
      self._io.observe(self.canvas);
    }
    self._onVis = function () {
      if (document.visibilityState === 'hidden') self._stop();
      else if (self._visible) self._start();
    };
    document.addEventListener('visibilitychange', self._onVis);

    if (self.reduced) self._drawStatic();
    else {
      self._drawNow();
      if (!self._io) self._start();
    }

    return self;
  }

  createOrb.prototype._resize = function () {
    var s = this.size > 0 ? this.size : 64;
    this.canvas.width = Math.round(s * this.dpr);
    this.canvas.height = Math.round(s * this.dpr);
    this.canvas.style.width = s + 'px';
    this.canvas.style.height = s + 'px';
    this.canvas.style.display = 'block';
  };

  createOrb.prototype._relabel = function () {
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', this.label || LABELS[this.state]);
  };

  createOrb.prototype._resolveDark = function () {
    var th = this.themeMode;
    if (th === 'dark') this.dark = true;
    else if (th === 'light') this.dark = false;
    else {
      var fromTree = ancestorTheme(this.canvas);
      this.dark = fromTree !== null ? fromTree : systemDark();
    }
  };

  createOrb.prototype._frame = function (t) {
    var resolved = resolvePreset(this.state, this.size);
    return MODE_FRAMES[resolved.mode](this.size, t, resolved.opts);
  };

  createOrb.prototype._drawStatic = function () {
    // reduced motion: one deterministic frame, exactly like the original
    // (raw t = 0.6, no speed multiplication)
    this._paint(0.6);
  };

  createOrb.prototype._drawNow = function () {
    this._paint((performance.now() / 1000) * resolvePreset(this.state, this.size).speed * this.speedMul);
  };

  createOrb.prototype._repaint = function () {
    if (this.reduced) this._drawStatic();
    else this._drawNow();
  };

  createOrb.prototype._paint = function (t) {
    var ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.size, this.size);
    var resolved = resolvePreset(this.state, this.size);
    paintFrame(ctx, MODE_FRAMES[resolved.mode](this.size, t, resolved.opts), this.dark);
  };

  createOrb.prototype._start = function () {
    if (this._running || this.pausedFlag) return;
    if (this.reduced) {
      this._drawStatic();
      return;
    }
    this._running = true;
    var orb = this;
    orb._raf = requestAnimationFrame(function loop() {
      orb._paint((performance.now() / 1000) * resolvePreset(orb.state, orb.size).speed * orb.speedMul);
      if (orb._running) orb._raf = requestAnimationFrame(loop);
    });
  };

  createOrb.prototype._stop = function () {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  };

  createOrb.prototype.setState = function (state) {
    if (STATE_TO_MODE[state]) {
      this.state = state;
      this._relabel();
      this._repaint();
    }
    return this;
  };

  createOrb.prototype.setSize = function (size) {
    var s = Number(size);
    if (s > 0) {
      this.size = s;
      this._resize();
      this._repaint();
    }
    return this;
  };

  createOrb.prototype.setTheme = function (theme) {
    this.themeMode = theme === 'dark' || theme === 'light' ? theme : 'auto';
    this._resolveDark();
    this._repaint();
    return this;
  };

  createOrb.prototype.setSpeed = function (speed) {
    this.speedMul = Number(speed) >= 0 ? Number(speed) : 1;
    return this;
  };

  createOrb.prototype.setPaused = function (paused) {
    this.pausedFlag = !!paused;
    if (this.pausedFlag) this._stop();
    else if (this._visible && document.visibilityState !== 'hidden') this._start();
    return this;
  };

  createOrb.prototype.destroy = function () {
    this._stop();
    if (this._io) this._io.disconnect();
    if (this._mo) this._mo.disconnect();
    if (this._motionQuery) this._motionQuery.removeEventListener('change', this._onMotionPref);
    if (this._themeQuery) this._themeQuery.removeEventListener('change', this._onSystemTheme);
    document.removeEventListener('visibilitychange', this._onVis);
    if (this.created && this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  };

  // ------------------------------------------------------------------
  // 6. Auto-init via data attributes + public API
  // ------------------------------------------------------------------

  var STATES = [
    'working',
    'searching',
    'solving',
    'listening',
    'connecting',
    'weaving',
    'composing',
    'breathing',
    'shaping'
  ];

  /** Start every element carrying a `data-thinking-orb` attribute. */
  function init() {
    if (typeof document === 'undefined') return;
    var nodes = document.querySelectorAll('[data-thinking-orb]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.__thinkingOrb) continue;
      var opts = {};
      var state = el.getAttribute('data-state');
      if (state && STATE_TO_MODE[state]) opts.state = state;
      var size = parseFloat(el.getAttribute('data-size'));
      if (!isNaN(size)) opts.size = size;
      var theme = el.getAttribute('data-theme');
      if (theme === 'dark' || theme === 'light' || theme === 'auto') opts.theme = theme;
      var speed = parseFloat(el.getAttribute('data-speed'));
      if (!isNaN(speed)) opts.speed = speed;
      if (el.getAttribute('data-paused') === 'true') opts.paused = true;
      var label = el.getAttribute('data-label');
      if (label) opts.label = label;
      try {
        el.__thinkingOrb = createOrb(el, opts);
      } catch (err) {
        if (typeof console !== 'undefined') console.error('ThinkingOrb init failed:', err);
      }
    }
  }

  /** Debug / verification surface: the raw dot/line list for a frame. */
  function frame(state, size, t) {
    return createOrb.prototype._frame.call({ state: state, size: size }, t);
  }

  function onReady(fn) {
    if (typeof document === 'undefined') return;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  var ThinkingOrbs = {
    version: '0.1.0',
    states: STATES.slice(),
    create: createOrb,
    frame: frame,
    init: init,
    resolve: resolvePreset
  };

  // graceful dedupe if loaded twice
  if (global.ThinkingOrbs) {
    global.__ThinkingOrbsPrev = global.ThinkingOrbs;
  }
  global.ThinkingOrbs = ThinkingOrbs;

  onReady(init);
})(typeof window !== 'undefined' ? window : this);