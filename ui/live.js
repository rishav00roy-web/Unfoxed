'use strict';

/* The Live tab: effects the app draws itself while it runs.
   Uses $, api, toast, toHex, fromHex from app.js. */

const LIVE_EFFECTS = [
  [null, 'Off', 'The keyboard shows its own saved effect.'],
  ['ripple', 'Solid + ripple', 'A steady colour, with a ring spreading from every key you press.'],
  ['music', 'Music', 'Bars that move with whatever your PC is playing.'],
  ['screen', 'Screen colours', 'Each key copies the colour of the part of the screen above it.'],
];

const L = { state: null, busy: false };

function buildLive() {
  for (const [value, name] of LIVE_EFFECTS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = name;
    chip.dataset.value = value ?? '';
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => sendLive({ effect: value }));
    $('live-effects').append(chip);
  }
  $('live-base').addEventListener('change', (e) => sendLive({ base: fromHex(e.target.value) }));
  $('live-accent').addEventListener('change', (e) => sendLive({ accent: fromHex(e.target.value) }));
  $('live-rainbow').addEventListener('change', (e) => sendLive({ rainbow: e.target.checked }));
  $('live-brightness').addEventListener('input', (e) => { $('live-brightness-out').textContent = `${e.target.value}%`; });
  $('live-brightness').addEventListener('change', (e) => sendLive({ brightness: Number(e.target.value) }));
  $('live-mouse').addEventListener('change', (e) => sendLive({ mouse_follows: e.target.checked }));
}

function renderLive() {
  const st = L.state;
  if (!st) return;
  document.querySelectorAll('#live-effects .chip').forEach((chip) => {
    chip.setAttribute('aria-pressed', String((chip.dataset.value || null) === st.effect));
  });
  const info = LIVE_EFFECTS.find(([value]) => value === st.effect);
  $('live-about').textContent = info ? info[2] : '';
  $('live-base').value = toHex(st.base);
  $('live-accent').value = toHex(st.accent);
  $('live-rainbow').checked = st.rainbow;
  $('live-mouse').checked = st.mouse_follows;
  $('live-brightness').value = st.brightness;
  $('live-brightness-out').textContent = `${st.brightness}%`;
  $('live-colours').hidden = st.effect === 'screen' || !st.effect;
  $('live-status').textContent = st.error
    ? st.error
    : st.running
      ? 'Running. It keeps running when the window is closed to the tray.'
      : '';
}

async function loadLive() {
  try {
    L.state = await api('/api/live');
    renderLive();
  } catch (err) {
    toast(err.message);
  }
}

async function sendLive(changes) {
  if (L.busy) return;
  L.busy = true;
  try {
    L.state = await api('/api/live', changes);
    renderLive();
  } catch (err) {
    toast(err.message);
  }
  L.busy = false;
}
