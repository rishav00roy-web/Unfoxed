'use strict';

/* On-screen simulations of the keyboard's built-in effects.

   The firmware cannot be read, so each one is rebuilt from the effect's name
   and the controls the keyboard gives it. They show what a setting does; they
   are not a frame-accurate copy.

   Effects.frame(mode, lighting, geo, seconds, presses) returns one
   [r, g, b, strength] per key, strength 0..1. */

const Effects = (() => {
  const TAU = Math.PI * 2;
  /* Device speed 0 is fastest, 4 slowest. */
  const RATE = [2.1, 1.55, 1.1, 0.75, 0.5];
  const SURMOUNT = [[255, 45, 45], [255, 214, 10], [43, 217, 107], [25, 211, 230]];

  const frac = (x) => x - Math.floor(x);
  const clamp = (x) => Math.max(0, Math.min(1, x));

  /* Stable pseudo-random 0..1 from two numbers. */
  function rand(a, b = 0) {
    return frac(Math.sin(a * 127.1 + b * 311.7) * 43758.5453);
  }

  function hue(turns) {
    const h = frac(turns) * 360;
    const f = (n) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  }

  /* The effect's colour: the chosen one, or a hue when Rainbow is on. */
  const tint = (c, turns) => (c.L.random ? hue(turns) : c.L.color);
  const lit = (rgb, k) => [rgb[0], rgb[1], rgb[2], clamp(k)];

  /* Strongest reaction to recent key presses, shaped by `shape(key, press, age)`. */
  function react(c, key, shape) {
    let best = 0, bestHue = 0;
    for (const p of c.presses) {
      const k = shape(key, p, (c.now - p.at) * c.rate);
      if (k > best) { best = k; bestHue = p.hue; }
    }
    return lit(tint(c, bestHue), best);
  }

  const MODES = {
    // Wave: narrow bands running sideways
    1: (c, k) => {
      const p = (k.cx / c.W) * 2 + (c.L.direction ? c.T : -c.T) * 0.8;
      return c.L.random ? lit(hue(p), 1) : lit(c.L.color, 0.12 + 0.88 * (0.5 + 0.5 * Math.cos(TAU * p)));
    },
    // Cloud: one wide, slow, slightly tilted band
    2: (c, k) => {
      const p = (k.cx / c.W) * 0.7 + (k.cy / c.H) * 0.25 + (c.L.direction ? c.T : -c.T) * 0.45;
      return c.L.random ? lit(hue(p), 1) : lit(c.L.color, 0.12 + 0.88 * (0.5 + 0.5 * Math.cos(TAU * p)));
    },
    // Serpentine: colour turning around the middle of the board
    3: (c, k) => {
      const angle = Math.atan2(k.cy - c.my, (k.cx - c.mx) * (c.H / c.W) * 1.6) / TAU;
      const p = angle + (c.L.direction ? -c.T : c.T) * 0.4;
      return c.L.random ? lit(hue(p), 1) : lit(c.L.color, 0.1 + 0.9 * (0.5 + 0.5 * Math.cos(TAU * p)));
    },
    // Spectrum: the whole board drifts through the colours together
    4: (c) => lit(hue(c.T * 0.16), 1),
    // Breathing
    5: (c) => {
      const cycle = c.T * 0.4;
      const k = Math.sin(Math.PI * frac(cycle)) ** 2;
      return lit(tint(c, Math.floor(cycle) * 0.19), k);
    },
    // Static
    6: (c, k) => lit(tint(c, (k.cx / c.W) * 0.83), 1),
    // Reactive: a pressed key lights and fades
    7: (c, k) => react(c, k, (key, p, age) => (p.i === key.i ? 1 - age * 1.1 : 0)),
    // Ripple: a ring spreads from the pressed key
    8: (c, k) => react(c, k, (key, p, age) => {
      const d = Math.hypot(key.cx - p.cx, (key.cy - p.cy) * 1.15);
      const r = age * 9;
      return Math.max(0, 1 - Math.abs(d - r) / 1.1) * Math.max(0, 1 - r / 16);
    }),
    // Traverse: light runs out along the pressed key's row
    9: (c, k) => react(c, k, (key, p, age) => {
      if (Math.abs(key.cy - p.cy) > 0.6) return 0;
      const r = age * 13;
      return Math.max(0, 1 - Math.abs(Math.abs(key.cx - p.cx) - r) / 1.2) * Math.max(0, 1 - r / 17);
    }),
    // Stars: keys twinkle on their own
    10: (c, k) => {
      const period = 1.6 + rand(k.i, 1) * 2.4;
      const s = c.T / period + rand(k.i, 2);
      const phase = frac(s);
      const glow = phase < 0.4 ? Math.sin((Math.PI * phase) / 0.4) : 0;
      return lit(tint(c, rand(k.i, Math.floor(s))), glow);
    },
    // Flowers: soft petals of colour opening from the middle
    11: (c, k) => {
      const dx = k.cx - c.mx, dy = (k.cy - c.my) * 1.6;
      const petals = Math.sin(Math.atan2(dy, dx) * 3) * 0.08;
      return lit(hue(Math.hypot(dx, dy) * 0.07 + petals - c.T * 0.22), 1);
    },
    // Roll: rainbow rolling up or down the rows
    12: (c, k) => lit(hue((k.cy / c.H) * 0.9 + (c.L.direction ? c.T : -c.T) * 0.5), 1),
    // Wave bars: columns rise and fall like a travelling wave
    13: (c, k) => {
      const height = (0.5 + 0.5 * Math.sin((k.cx / c.W) * TAU * 1.5 - c.T * 2.6)) * (c.H + 0.4);
      return lit(tint(c, (k.cx / c.W) * 0.83), (height - (c.H - k.cy)) * 1.6 + 0.6);
    },
    // Cartoon: keys light one by one until the board is full, then clear
    14: (c, k) => {
      const s = c.T / 5;
      const round = Math.floor(s);
      const fill = frac(s) * 1.3;
      return lit(tint(c, rand(k.i, round + 9)), (fill - rand(k.i, round)) * 12);
    },
    // Rain: drops fall down the columns
    15: (c, k) => {
      const col = Math.floor(k.cx);
      const head = frac(c.T * 0.35 * (0.6 + rand(col, 1)) + rand(col, 3)) * (c.H + 4) - 1;
      const behind = head - k.cy;
      return lit(tint(c, rand(col, 5)), behind >= 0 ? 1 - behind / 2.6 : 0);
    },
    // Scan: two bars sweep across and pass each other
    16: (c, k) => {
      const pos = frac(c.T * 0.3) * c.W;
      const k1 = 1 - Math.abs(k.cx - pos) / 1.2;
      const k2 = 1 - Math.abs(k.cx - (c.W - pos)) / 1.2;
      return lit(tint(c, pos / c.W), Math.max(k1, k2));
    },
    // Surmount: light climbs the rows, then starts again
    17: (c, k) => {
      const level = frac(c.T * 0.4) * (c.H + 2.5);
      return lit(SURMOUNT[c.L.ledmode % 4], (level - (c.H - k.cy)) * 1.4);
    },
    // Speed: tight rainbow rings racing in or out
    18: (c, k) => {
      const d = Math.hypot(k.cx - c.mx, (k.cy - c.my) * 1.6);
      return lit(hue(d * 0.16 + (c.L.direction ? c.T : -c.T) * 1.3), 1);
    },
  };

  const HAS_SPEED = new Set([1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const REACTIVE = new Set([7, 8, 9]);

  function geometry(layout) {
    return {
      W: layout.width,
      H: layout.height,
      mx: 7.5,
      my: 3.3,
      keys: layout.keys.map((key, i) => ({ i, cx: key.x + key.w / 2, cy: key.y + 0.5 })),
    };
  }

  function frame(mode, L, geo, now, presses) {
    const fn = MODES[mode];
    if (!fn) return geo.keys.map(() => [0, 0, 0, 0]);
    const rate = HAS_SPEED.has(mode) ? RATE[Math.min(L.speed, 4)] : 1;
    const c = { L, now, rate, T: now * rate, presses, W: geo.W, H: geo.H, mx: geo.mx, my: geo.my };
    return geo.keys.map((key) => fn(c, key));
  }

  return { frame, geometry, rate: (mode, L) => (HAS_SPEED.has(mode) ? RATE[Math.min(L.speed, 4)] : 1), isReactive: (mode) => REACTIVE.has(mode), SURMOUNT };
})();
