'use strict';

const TOKEN = document.querySelector('meta[name="token"]').content;
const $ = (id) => document.getElementById(id);

/* ---- what the keyboard can do ------------------------------------------ */

const MODE_CUSTOM = 0x14;

/* Which controls each effect has, read out of the vendor app's own rules.
   dir: what the two directions mean for that effect. */
const MODES = [
  { id: 6, name: 'Static', group: 'Ambient', color: true },
  { id: 5, name: 'Breathing', group: 'Ambient', speed: true, color: true },
  { id: 4, name: 'Spectrum', group: 'Ambient', speed: true },
  { id: 1, name: 'Wave', group: 'Ambient', speed: true, dir: 'lr', color: true },
  { id: 2, name: 'Cloud', group: 'Ambient', speed: true, dir: 'lr', color: true },
  { id: 3, name: 'Serpentine', group: 'Ambient', speed: true, dir: 'cw', color: true },
  { id: 12, name: 'Roll', group: 'Ambient', speed: true, dir: 'ud' },
  { id: 18, name: 'Speed', group: 'Ambient', dir: 'io' },
  { id: 10, name: 'Stars', group: 'Ambient', speed: true, color: true },
  { id: 15, name: 'Rain', group: 'Ambient', speed: true, color: true },
  { id: 16, name: 'Scan', group: 'Ambient', color: true },
  { id: 11, name: 'Flowers', group: 'Ambient', speed: true },
  { id: 13, name: 'Wave bars', group: 'Ambient', speed: true, color: true },
  { id: 14, name: 'Cartoon', group: 'Ambient', speed: true, color: true },
  { id: 17, name: 'Surmount', group: 'Ambient', variant: true },
  { id: MODE_CUSTOM, name: 'Per-key layout', group: 'Ambient' },
  { id: 7, name: 'Reactive', group: 'Reacts to typing', speed: true, color: true },
  { id: 8, name: 'Ripple', group: 'Reacts to typing', speed: true, color: true },
  { id: 9, name: 'Traverse', group: 'Reacts to typing', speed: true, color: true },
];

/* Direction value 1 is the first label, 0 the second. */
const DIRECTIONS = {
  lr: ['To the left', 'To the right'],
  ud: ['Upward', 'Downward'],
  cw: ['Clockwise', 'Anticlockwise'],
  io: ['Inward', 'Outward'],
};

const SWATCHES = [
  ['Red', [255, 45, 45]],
  ['Orange', [255, 138, 31]],
  ['Yellow', [255, 214, 10]],
  ['Green', [43, 217, 107]],
  ['Cyan', [25, 211, 230]],
  ['Blue', [47, 107, 255]],
  ['Violet', [139, 71, 255]],
  ['Pink', [255, 62, 165]],
  ['White', [255, 255, 255]],
];

const VARIANTS = 4;   // Surmount comes in four fixed variants

const BRIGHTNESS_LABELS = ['Off', '25%', '50%', '75%', '100%'];
const SPEED_LABELS = ['Slowest', 'Slow', 'Medium', 'Fast', 'Fastest'];
const SPEED_MAX = 4;
const GLOW = [0, 0.3, 0.5, 0.7, 0.9];
const CUSTOM_SETS = 7;
const KEY_NAMES = { '↑': 'Up arrow', '↓': 'Down arrow', '←': 'Left arrow', '→': 'Right arrow' };

const usage = (key) => (key.code & 0xff00 ? 0 : key.code & 0xff);
const GROUPS = [
  ['All keys', () => true],
  ['Letters', (k) => usage(k) >= 0x04 && usage(k) <= 0x1d],
  ['Numbers', (k) => usage(k) >= 0x1e && usage(k) <= 0x27],
  ['F keys', (k) => usage(k) >= 0x3a && usage(k) <= 0x45],
  ['WASD', (k) => [0x1a, 0x04, 0x16, 0x07].includes(usage(k))],
  ['Arrows', (k) => usage(k) >= 0x4f && usage(k) <= 0x52],
  ['Modifiers', (k) => (k.code & 0xff00) !== 0 || k.code >>> 16 === 0xa0],
];

/* ---- state ------------------------------------------------------------- */

const S = {
  connected: false,
  profile: 0,
  lighting: null,
  layout: null,
  keyEls: [],
  tab: 'effects',
  seq: 0,           // bumped on every local change, so stale replies are dropped
  writing: 0,
  lastWrite: 0,
  paint: { set: 0, tool: 'paint', brush: [255, 138, 31], saved: {}, work: {} },
};

/* ---- helpers ----------------------------------------------------------- */

async function api(path, body) {
  const init = { headers: { 'X-Token': TOKEN } };
  if (body !== undefined) {
    init.method = 'POST';
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('Unfoxed stopped running. Close this window and open it again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const toHex = (rgb) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const css = (rgb) => `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`;
const isOff = (rgb) => !rgb || rgb[0] + rgb[1] + rgb[2] === 0;
const modeDef = (id) => MODES.find((m) => m.id === id) || MODES[0];

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

/* ---- building the page ------------------------------------------------- */

function buildKeyboard() {
  const host = $('kb-keys');
  S.keyEls = S.layout.keys.map((key, i) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'key';
    el.style.setProperty('--x', key.x);
    el.style.setProperty('--y', key.y);
    el.style.setProperty('--w', key.w);
    el.dataset.index = i;
    el.tabIndex = i === 0 ? 0 : -1;
    el.setAttribute('aria-label', KEY_NAMES[key.label] || key.label);
    const cap = document.createElement('span');
    cap.className = 'cap';
    const text = document.createElement('span');
    text.textContent = key.label;
    cap.append(text);
    el.append(cap);
    host.append(el);
    return el;
  });
}

function buildEffects() {
  const host = $('effects');
  for (const group of [...new Set(MODES.map((m) => m.group))]) {
    const section = document.createElement('section');
    const title = document.createElement('h2');
    title.textContent = group;
    const grid = document.createElement('div');
    grid.className = 'effect-grid';
    for (const mode of MODES.filter((m) => m.group === group)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'effect';
      btn.dataset.mode = mode.id;
      btn.textContent = mode.name;
      btn.setAttribute('aria-pressed', 'false');
      grid.append(btn);
    }
    section.append(title, grid);
    host.append(section);
  }
}

/* A row of colour buttons, optionally ending in a free colour picker. */
function buildSwatches(host, list, onPick, withPicker) {
  const buttons = list.map(([name, rgb], index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch';
    btn.style.setProperty('--c', css(rgb));
    btn.setAttribute('aria-label', name);
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => onPick(rgb, index));
    host.append(btn);
    return btn;
  });
  let picker = null;
  if (withPicker) {
    const label = document.createElement('label');
    label.className = 'swatch swatch-custom';
    picker = document.createElement('input');
    picker.type = 'color';
    picker.setAttribute('aria-label', 'Custom colour');
    picker.addEventListener('input', () => onPick(fromHex(picker.value), -1));
    label.append(picker);
    host.append(label);
  }
  return (current) => {
    buttons.forEach((btn, i) => {
      const hit = typeof current === 'number' ? current === i : same(current, list[i][1]);
      btn.setAttribute('aria-pressed', String(hit));
    });
    if (picker && Array.isArray(current)) picker.value = toHex(current);
  };
}

/* ---- keyboard drawing -------------------------------------------------- */

let keyBase = [42, 45, 49];
function readKeyBase() {
  const hex = getComputedStyle(document.documentElement).getPropertyValue('--key').trim();
  if (/^#[0-9a-f]{6}$/i.test(hex)) keyBase = fromHex(hex);
}

function paintKeyEl(el, rgb, glow, strength) {
  const k = glow * strength;
  if (isOff(rgb) || k <= 0.02) {
    if (el.hasAttribute('data-lit')) {
      el.removeAttribute('data-lit');
      el.removeAttribute('data-ink');
    }
    return;
  }
  const stamp = (rgb[0] << 16 | rgb[1] << 8 | rgb[2]) * 128 + Math.round(strength * 100);
  if (el.stamp === stamp && el.hasAttribute('data-lit')) return;
  el.stamp = stamp;
  el.style.setProperty('--c', css(rgb));
  el.style.setProperty('--k', strength.toFixed(2));
  el.setAttribute('data-lit', '');
  const mix = [0, 1, 2].map((i) => rgb[i] * k + keyBase[i] * (1 - k));
  const luminance = 0.2126 * mix[0] + 0.7152 * mix[1] + 0.0722 * mix[2];
  const ink = luminance > 140 ? 'dark' : 'light';
  if (el.dataset.ink !== ink) el.dataset.ink = ink;
}

/* Colours for the cases that do not move: painting, a saved layout, lights off. */
function stillColors() {
  const keys = S.layout.keys;
  const L = S.lighting;
  if (!S.connected || !L) return keys.map(() => null);
  if (S.tab === 'paint') {
    const work = S.paint.work[S.paint.set];
    return keys.map((k) => (work ? work[k.slot] : null));
  }
  if (L.brightness === 0) return keys.map(() => null);
  const saved = S.paint.saved[L.custom_set];
  if (!saved) loadSet(L.custom_set, true);
  return keys.map((k) => (saved ? saved[k.slot] : null));
}

const animated = () => S.tab === 'effects' && S.connected && !!S.lighting
  && S.lighting.brightness > 0 && S.lighting.mode !== MODE_CUSTOM;

function renderKeyboard() {
  if (!S.layout) return;
  const L = S.lighting;
  const painting = S.tab === 'paint';
  const moving = animated();
  S.glow = painting || !L ? GLOW[4] : GLOW[L.brightness];
  $('kb-inner').style.setProperty('--glow', S.glow);
  if (moving) {
    drawFrame(performance.now());
    if (!frameId && !reducedMotion.matches) frameId = requestAnimationFrame(tick);
  } else {
    cancelAnimationFrame(frameId);
    frameId = 0;
    const colors = stillColors();
    S.keyEls.forEach((el, i) => paintKeyEl(el, colors[i], S.glow, 1));
  }
  $('kb').dataset.mode = S.tab;
  $('kb-keys').inert = !painting || !S.connected;
  $('kb-screen-text').textContent = `P${S.profile + 1}`;
  $('stage-note').textContent = !S.connected
    ? ''
    : painting
      ? 'Click or drag across keys to paint. The keyboard follows as you go.'
      : !moving
        ? ''
        : Effects.isReactive(L.mode)
          ? 'Simulated preview. Type to try it.'
          : 'Simulated preview.';
}

/* ---- animated preview -------------------------------------------------- */

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const presses = [];           // recent key presses, real or simulated
let frameId = 0, lastFrame = 0, lastTyped = -10, lastGhost = 0;

function tick(now) {
  frameId = animated() ? requestAnimationFrame(tick) : 0;
  if (!frameId || now - lastFrame < 30) return;
  lastFrame = now;
  drawFrame(now);
}

function drawFrame(nowMs) {
  const L = S.lighting;
  const now = reducedMotion.matches ? 1.3 : nowMs / 1000;
  if (Effects.isReactive(L.mode)) {
    // Nobody typing: show the effect with a few simulated presses.
    const gap = 0.42 / Effects.rate(L.mode, L);
    if (now - lastTyped > 2.5 && now - lastGhost > gap) {
      lastGhost = now;
      press(Math.floor(Math.random() * S.layout.keys.length), now);
    }
    while (presses.length && now - presses[0].at > 4) presses.shift();
  }
  const frame = Effects.frame(L.mode, L, S.geo, now, presses);
  S.keyEls.forEach((el, i) => paintKeyEl(el, frame[i], S.glow, frame[i][3]));
}

function press(index, at) {
  const g = S.geo.keys[index];
  presses.push({ i: index, cx: g.cx, cy: g.cy, at, hue: Math.random() });
  if (presses.length > 24) presses.shift();
}

/* ---- effects tab ------------------------------------------------------- */

let syncSwatches, syncBrush;

function setOff(field, off) {
  field.toggleAttribute('data-off', off);
  if (field.tagName === 'FIELDSET') field.disabled = off;
  else field.querySelectorAll('input').forEach((input) => { input.disabled = off; });
}

function syncControls() {
  const L = S.lighting;
  if (!L) return;
  const mode = modeDef(L.mode);

  document.querySelectorAll('.effect').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.mode) === L.mode));
  });

  $('brightness').value = L.brightness;
  $('brightness-out').textContent = BRIGHTNESS_LABELS[L.brightness];

  const speed = Math.min(L.speed, SPEED_MAX);
  $('speed').value = SPEED_MAX - speed;
  $('speed-out').textContent = mode.speed ? SPEED_LABELS[SPEED_MAX - speed] : 'Fixed';
  setOff($('field-speed'), !mode.speed);

  const labels = DIRECTIONS[mode.dir || 'lr'];
  $('dir-a').textContent = labels[0];
  $('dir-b').textContent = labels[1];
  document.querySelectorAll('input[name="direction"]').forEach((input) => {
    input.checked = !!mode.dir && Number(input.value) === L.direction;
  });
  setOff($('field-direction'), !mode.dir);

  $('field-variant').hidden = !mode.variant;
  $('field-color').hidden = !!mode.variant;
  setOff($('field-color'), !mode.color);
  $('rainbow').checked = L.random;
  document.querySelectorAll('#variants .chip').forEach((chip, i) => {
    chip.setAttribute('aria-pressed', String(i === L.ledmode % VARIANTS));
  });
  // Picking a colour turns Rainbow off, so the swatches stay usable.
  syncSwatches(L.random ? -1 : L.color);
}

let pushTimer;
function changeLighting(patch) {
  if (!S.lighting) return;
  Object.assign(S.lighting, patch);
  S.seq += 1;
  syncControls();
  renderKeyboard();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushLighting, 180);
}

async function pushLighting() {
  const L = S.lighting;
  const body = {
    mode: L.mode, brightness: L.brightness, speed: L.speed,
    direction: L.direction, random: L.random, color: L.color,
  };
  if (modeDef(L.mode).variant) body.ledmode = L.ledmode;
  if (L.mode === MODE_CUSTOM) body.custom_set = L.custom_set;
  await write('/api/lighting', body);
}

/* Send a change to the keyboard and take its answer as the new truth,
   unless the person has changed something else in the meantime. */
async function write(path, body) {
  const seq = S.seq;
  S.writing += 1;
  try {
    const state = await api(path, body);
    S.lastWrite = Date.now();
    applyState(state, seq);
    return true;
  } catch (err) {
    toast(err.message);
    refresh(true);
    return false;
  } finally {
    S.writing -= 1;
  }
}

/* ---- per-key tab ------------------------------------------------------- */

async function loadSet(index, quiet) {
  const p = S.paint;
  if (!p.saved[index]) {
    if (loadSet.pending === index) return;
    loadSet.pending = index;
    try {
      const data = await api(`/api/custom?set=${index}`);
      p.saved[index] = data.colors;
      p.work[index] = clone(data.colors);
    } catch (err) {
      if (!quiet) toast(err.message);
      return;
    } finally {
      loadSet.pending = null;
    }
  }
  renderKeyboard();
  if (S.tab === 'paint') {
    syncPaint();
    sendPreview();
  }
}

function syncPaint() {
  const p = S.paint;
  const work = p.work[p.set];
  const dirty = !!work && !same(work, p.saved[p.set]);
  const active = S.lighting && S.lighting.mode === MODE_CUSTOM && S.lighting.custom_set === p.set;
  $('paint-set').value = p.set;
  $('paint-status').textContent = !work
    ? 'Reading layout from the keyboard…'
    : dirty
      ? 'Unsaved changes. The keyboard is showing a preview.'
      : active
        ? 'Saved and showing on the keyboard.'
        : 'Saved on the keyboard, but another effect is active.';
  $('paint-revert').disabled = !dirty;
  $('paint-save').disabled = !work || (!dirty && active);
  syncBrush(p.brush);
}

let previewTimer, previewBusy = false, previewAgain = false;
function sendPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    if (previewBusy) { previewAgain = true; return; }
    const work = S.paint.work[S.paint.set];
    if (S.tab !== 'paint' || !work || !S.connected) return;
    previewBusy = true;
    try {
      await api('/api/preview', { colors: work });
    } catch (err) {
      toast(err.message);
      refresh(true);
    }
    previewBusy = false;
    if (previewAgain) { previewAgain = false; sendPreview(); }
  }, 40);
}

function applyTool(index, fromDrag) {
  const p = S.paint;
  const work = p.work[p.set];
  if (!work) return;
  const slot = S.layout.keys[index].slot;
  if (p.tool === 'pick') {
    if (fromDrag) return;
    if (!isOff(work[slot])) p.brush = [...work[slot]];
    p.tool = 'paint';
    document.querySelector('input[name="tool"][value="paint"]').checked = true;
    syncPaint();
    return;
  }
  const next = p.tool === 'erase' ? [0, 0, 0] : [...p.brush];
  if (same(work[slot], next)) return;
  work[slot] = next;
  paintKeyEl(S.keyEls[index], next, GLOW[4], 1);
  syncPaint();
  sendPreview();
}

function fillGroup(test) {
  const p = S.paint;
  const work = p.work[p.set];
  if (!work) return;
  const next = p.tool === 'erase' ? [0, 0, 0] : p.brush;
  S.layout.keys.forEach((key) => { if (test(key)) work[key.slot] = [...next]; });
  renderKeyboard();
  syncPaint();
  sendPreview();
}

/* ---- tabs -------------------------------------------------------------- */

async function showTab(name) {
  if (S.tab === name) return;
  S.tab = name;
  for (const tab of ['effects', 'paint']) {
    const on = tab === name;
    $(`tab-${tab}`).setAttribute('aria-selected', String(on));
    $(`tab-${tab}`).tabIndex = on ? 0 : -1;
    $(`panel-${tab}`).hidden = !on;
  }
  if (name === 'paint') {
    if (S.lighting && S.lighting.mode === MODE_CUSTOM) S.paint.set = S.lighting.custom_set;
    renderKeyboard();
    syncPaint();
    loadSet(S.paint.set);
  } else {
    renderKeyboard();
    api('/api/preview/end', {}).catch(() => {});
  }
}

/* ---- connection -------------------------------------------------------- */

function applyState(state, seq) {
  const was = S.connected;
  S.connected = !!state.connected;
  const device = $('device');
  device.dataset.state = S.connected ? 'on' : 'off';
  $('device-text').textContent = S.connected
    ? 'Ronin Wireless connected'
    : (state.error || 'Keyboard not found');
  for (const id of ['panel-effects', 'panel-paint']) $(id).inert = !S.connected;
  $('profiles').disabled = !S.connected;

  if (S.connected && (seq === undefined || seq === S.seq)) {
    S.profile = state.profile;
    S.lighting = state.lighting;
    document.querySelectorAll('input[name="profile"]').forEach((input) => {
      input.checked = Number(input.value) === S.profile;
    });
    syncControls();
  }
  renderKeyboard();
  if (S.tab === 'paint') {
    syncPaint();
    if (S.connected && !was) loadSet(S.paint.set);
  }
}

async function refresh(force) {
  if (!force && (document.hidden || S.writing || Date.now() - S.lastWrite < 1500)) return;
  const seq = S.seq;
  try {
    applyState(await api('/api/state'), seq);
  } catch (err) {
    applyState({ connected: false, error: err.message });
  }
}

/* ---- events ------------------------------------------------------------ */

function bind() {
  $('effects').addEventListener('click', (e) => {
    const btn = e.target.closest('.effect');
    if (!btn || !S.lighting) return;
    const patch = { mode: Number(btn.dataset.mode) };
    if (S.lighting.brightness === 0) patch.brightness = 4;
    changeLighting(patch);
  });

  $('brightness').addEventListener('input', (e) => changeLighting({ brightness: Number(e.target.value) }));
  $('speed').addEventListener('input', (e) => changeLighting({ speed: SPEED_MAX - Number(e.target.value) }));
  $('field-direction').addEventListener('change', (e) => changeLighting({ direction: Number(e.target.value) }));
  $('rainbow').addEventListener('change', (e) => changeLighting({ random: e.target.checked }));
  $('controls').addEventListener('submit', (e) => e.preventDefault());

  $('profiles').addEventListener('change', async (e) => {
    S.seq += 1;
    await write('/api/profile', { profile: Number(e.target.value) });
    if (S.tab === 'paint') sendPreview();
  });

  // tabs
  const tabs = [$('tab-effects'), $('tab-paint')];
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => showTab(tab.id.slice(4)));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      showTab(next.id.slice(4));
    });
  });

  // painting with the pointer
  const host = $('kb-keys');
  let dragging = false;
  let last = null;
  const keyAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const key = el && el.closest('.key');
    return key ? Number(key.dataset.index) : -1;
  };
  host.addEventListener('pointerdown', (e) => {
    if (S.tab !== 'paint' || e.button !== 0) return;
    const index = keyAt(e.clientX, e.clientY);
    if (index < 0) return;
    dragging = true;
    last = [e.clientX, e.clientY];
    focusKey(index);
    applyTool(index, false);
    e.preventDefault();
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // A fast drag reports only a few points, so walk the line between them.
    const [x0, y0] = last;
    const steps = Math.max(1, Math.ceil(Math.hypot(e.clientX - x0, e.clientY - y0) / 6));
    for (let i = 1; i <= steps; i += 1) {
      const index = keyAt(x0 + ((e.clientX - x0) * i) / steps, y0 + ((e.clientY - y0) * i) / steps);
      if (index >= 0) applyTool(index, true);
    }
    last = [e.clientX, e.clientY];
  });
  window.addEventListener('pointerup', () => { dragging = false; });
  window.addEventListener('pointercancel', () => { dragging = false; });

  // painting with the keyboard: arrows move, Enter or Space paints
  host.addEventListener('keydown', (e) => {
    const key = e.target.closest('.key');
    if (!key) return;
    const index = Number(key.dataset.index);
    if (e.key === 'Enter' || e.key === ' ') {
      applyTool(index, false);
      e.preventDefault();
    } else if (e.key.startsWith('Arrow')) {
      const next = neighbour(index, e.key.slice(5));
      if (next >= 0) focusKey(next);
      e.preventDefault();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.repeat || !animated() || !Effects.isReactive(S.lighting.mode)) return;
    const index = S.codeIndex[e.code];
    if (index === undefined) return;
    lastTyped = reducedMotion.matches ? 1.3 : performance.now() / 1000;
    press(index, lastTyped);
  });
  reducedMotion.addEventListener('change', renderKeyboard);

  $('tools').addEventListener('change', (e) => { S.paint.tool = e.target.value; });
  $('paint-set').addEventListener('change', (e) => {
    S.paint.set = Number(e.target.value);
    renderKeyboard();
    syncPaint();
    loadSet(S.paint.set);
  });
  $('paint-revert').addEventListener('click', () => {
    const p = S.paint;
    p.work[p.set] = clone(p.saved[p.set]);
    renderKeyboard();
    syncPaint();
    sendPreview();
  });
  $('paint-save').addEventListener('click', async () => {
    const p = S.paint;
    const index = p.set;
    const colors = clone(p.work[index]);
    $('paint-save').disabled = true;
    S.seq += 1;
    if (await write('/api/custom', { set: index, colors })) p.saved[index] = colors;
    syncPaint();
  });

  window.addEventListener('pagehide', () => {
    fetch('/api/preview/end', {
      method: 'POST', keepalive: true, body: '{}',
      headers: { 'X-Token': TOKEN, 'Content-Type': 'application/json' },
    }).catch(() => {});
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    readKeyBase();
    renderKeyboard();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

function focusKey(index) {
  S.keyEls.forEach((el, i) => { el.tabIndex = i === index ? 0 : -1; });
  S.keyEls[index].focus({ preventScroll: true });
}

/* Nearest key in a direction, by key centres. */
function neighbour(index, direction) {
  const keys = S.layout.keys;
  const centre = (k) => [k.x + k.w / 2, k.y + 0.5];
  const [x, y] = centre(keys[index]);
  let best = -1, bestScore = Infinity;
  keys.forEach((k, i) => {
    if (i === index) return;
    const [cx, cy] = centre(k);
    const along = { Right: cx - x, Left: x - cx, Down: cy - y, Up: y - cy }[direction];
    const across = direction === 'Right' || direction === 'Left' ? Math.abs(cy - y) : Math.abs(cx - x);
    if (along < 0.4 || across > 1.2) return;
    const score = along + across * 2.5;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}

/* The browser's name (KeyboardEvent.code) for one of the keyboard's key codes. */
function eventCode(code) {
  const modifiers = {
    0x0100: 'ControlLeft', 0x0200: 'ShiftLeft', 0x0400: 'AltLeft', 0x0800: 'MetaLeft',
    0x2000: 'ShiftRight', 0x4000: 'AltRight',
  };
  if (code >>> 16 !== 0x20) return null;
  if (code & 0xff00) return modifiers[code & 0xff00] || null;
  const u = code & 0xff;
  if (u >= 0x04 && u <= 0x1d) return `Key${String.fromCharCode(61 + u)}`;
  if (u >= 0x1e && u <= 0x26) return `Digit${u - 0x1d}`;
  if (u >= 0x3a && u <= 0x45) return `F${u - 0x39}`;
  return {
    0x27: 'Digit0', 0x28: 'Enter', 0x29: 'Escape', 0x2a: 'Backspace', 0x2b: 'Tab', 0x2c: 'Space',
    0x2d: 'Minus', 0x2e: 'Equal', 0x2f: 'BracketLeft', 0x30: 'BracketRight', 0x31: 'Backslash',
    0x33: 'Semicolon', 0x34: 'Quote', 0x35: 'Backquote', 0x36: 'Comma', 0x37: 'Period', 0x38: 'Slash',
    0x39: 'CapsLock', 0x4b: 'PageUp', 0x4c: 'Delete', 0x4e: 'PageDown',
    0x4f: 'ArrowRight', 0x50: 'ArrowLeft', 0x51: 'ArrowDown', 0x52: 'ArrowUp',
  }[u] || null;
}

/* ---- start ------------------------------------------------------------- */

async function start() {
  readKeyBase();
  buildEffects();
  syncSwatches = buildSwatches($('swatches'), SWATCHES, (rgb) => changeLighting({ color: [...rgb], random: false }), true);
  for (let i = 0; i < VARIANTS; i += 1) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = String(i + 1);
    chip.setAttribute('aria-label', `Variant ${i + 1}`);
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => changeLighting({ ledmode: i }));
    $('variants').append(chip);
  }
  syncBrush = buildSwatches($('brush-swatches'), SWATCHES, (rgb) => {
    S.paint.brush = [...rgb];
    if (S.paint.tool !== 'paint') {
      S.paint.tool = 'paint';
      document.querySelector('input[name="tool"][value="paint"]').checked = true;
    }
    syncPaint();
  }, true);

  for (const [name, test] of GROUPS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = name;
    chip.addEventListener('click', () => fillGroup(test));
    $('groups').append(chip);
  }
  for (let i = 0; i < CUSTOM_SETS; i += 1) {
    $('paint-set').append(new Option(`Layout ${i + 1}`, i));
  }

  try {
    S.layout = await api('/api/layout');
  } catch (err) {
    toast(err.message);
    return;
  }
  S.geo = Effects.geometry(S.layout);
  S.codeIndex = {};
  S.layout.keys.forEach((key, i) => {
    const code = eventCode(key.code);
    if (code) S.codeIndex[code] = i;
  });
  buildKeyboard();
  bind();
  await refresh(true);
  setInterval(refresh, 3000);
}

start();
