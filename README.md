
# thinking-orbs / vanilla

Small, animated orbs that show what an interface is currently doing — thinking,
searching, listening, composing — instead of a generic spinner. This repo packs
the nine animations into one plain JavaScript file you can drop into any page:
no build step, no framework, no dependencies. Add a `<canvas>` with a
`data-state` attribute and the animation runs.

A handwritten, dependency-free single JS file that recreates the nine
`thinking-orbs` loading animations in plain vanilla JavaScript.
Include one file, set the parameters — done.

Numerically **exact** to the original: the geometry is a 1:1 transcription of
the pure TS engine and is checked dot-for-dot against the golden spec from the
original repo (72 cases).

Thank you to [Jakub Antalik](https://github.com/Jakubantalik) and the original [thinking-orbs](https://github.com/Jakubantalik/thinking-orbs) project, from which this vanilla port is derived. The animations, states, and visual language originate there; this repository is a dependency-free reimplementation for plain HTML/JS.


## Demo

Live example: [https://mad5.de/thinking-orbs-vanilla/](https://mad5.de/thinking-orbs-vanilla/)

## Include

```html
<canvas data-thinking-orb data-state="searching" data-size="20"></canvas>
<script src="thinking-orbs.js"></script>
```

Canvas elements with `data-thinking-orb` start automatically once the DOM is
ready — no further code required.

## Attributes

| Attribute         | Values                                             | Default   |
| ----------------- | -------------------------------------------------- | --------- |
| `data-state`      | `working` `searching` `solving` `listening` `connecting` `weaving` `composing` `breathing` `shaping` | `working` |
| `data-size`       | Number in CSS px (tuned presets: `64`, `20`)       | `64`      |
| `data-theme`      | `auto` `dark` `light`                              | `auto`    |
| `data-speed`      | Multiplier on the baked speed                      | `1`       |
| `data-paused`     | `true` freezes the current frame                   | `false`   |
| `data-label`      | Overrides the `aria-label`                         | State title |

## Programmatic API

```js
const orb = ThinkingOrbs.create(element, {
  state: 'composing',   // one of the 9 states
  size: 64,             // 64 and 20 are tuned; other sizes are interpolated
  theme: 'auto',        // 'auto' | 'dark' | 'light'
  speed: 1,
  paused: false,
  label: 'Composing…'   // optional
});

orb.setState('searching').setSize(48).setTheme('dark').setSpeed(1.5);
orb.setPaused(true);
orb.destroy();
```

`element` may be a `<canvas>` **or** any container (a canvas is then created
to match the size).

Further surface: `ThinkingOrbs.init()` (re-scans `[data-thinking-orb]`),
`ThinkingOrbs.frame(state, size, t)` (raw geometry for tests),
`ThinkingOrbs.resolve(state, size)` (resolved presets).

## Size scaling

The original library ships two tuned designs (64 = chat-avatar scale,
20 = inline-text) — **separate designs, not a scale factor**. For other
sizes this port interpolates linearly between the two presets
(extrapolates below 20 / above 64) and runs the result through the same
count/radius scaling machinery as the original.

## Behavior (identical to the original)

- **Shared clock**: every instance uses `performance.now()` — in phase.
- **DPR cap 2**; plain 2D canvas circle fills, no filters, no WebGL.
- **Auto theme**: `data-theme`/`.dark`/`.light` on an ancestor (live via
  `MutationObserver`) → otherwise `prefers-color-scheme` (live via `matchMedia`).
- **Offscreen pause** (`IntersectionObserver`) + **hidden-tab pause**
  (`visibilitychange`).
- **`prefers-reduced-motion`**: static frame at `t = 0.6`, no loop.
- **A11y**: `role="img"` + per-state `aria-label`.

## Verification

```bash
node verify.js   # 72 geometry cases + 18 presets against spec/orbs-golden.json
node smoke.js    # DOM/component layer against a minimal DOM shim
```

`verify.js` compares every point and every line numerically (tolerance 1e-4)
against the original’s golden spec (`../thinking-orbs/spec/orbs-golden.json`).

## License

MIT — based on [thinking-orbs](https://github.com/Jakubantalik/thinking-orbs) by Jakub Antalik. The file header of `thinking-orbs.js` contains the full copyright/license notice.
