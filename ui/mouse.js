'use strict';

/* The Mouse view: DPI slots, polling rate and button functions.
   Uses $, api, toast, same, clone and the device-status helpers from app.js. */

/* Named after what each button does out of the box. */
const BUTTON_NAMES = [
  'Left button', 'Right button', 'Wheel click', 'Side button, back',
  'Side button, front', 'Lighting button', 'Fire button', 'DPI button',
];
const LEFT_CLICK = 1;

const M = {
  saved: null,      // what the mouse has
  draft: null,      // what is on screen
  options: null,
  connected: false,
  busy: false,
};

const mouseDirty = () => !!M.saved && !same(M.saved, M.draft);

/* ---- building ---------------------------------------------------------- */

function buildMouse(options) {
  M.options = options;
  const top = options.dpi.length - 1;

  for (let n = 0; n < 6; n += 1) {
    const row = document.createElement('div');
    row.className = 'dpi-row';

    const pick = document.createElement('label');
    pick.className = 'dpi-pick';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'dpi-current';
    radio.value = n;
    const name = document.createElement('span');
    name.textContent = `Slot ${n + 1}`;
    pick.append(radio, name);

    const range = document.createElement('input');
    range.type = 'range';
    range.min = 0;
    range.max = top;
    range.step = 1;
    range.setAttribute('aria-label', `Slot ${n + 1} DPI`);

    const out = document.createElement('output');

    const toggle = document.createElement('label');
    toggle.className = 'switch';
    const box = document.createElement('input');
    box.type = 'checkbox';
    const track = document.createElement('span');
    track.className = 'switch-track';
    track.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'visually-hidden';
    text.textContent = `Slot ${n + 1} on`;
    toggle.append(box, track, text);

    radio.addEventListener('change', () => {
      M.draft.current = n;
      M.draft.enabled[n] = true;      // the slot in use has to be on
      syncMouse();
    });
    range.addEventListener('input', () => {
      M.draft.dpi[n] = options.dpi[Number(range.value)];
      syncMouse();
    });
    box.addEventListener('change', () => {
      const enabled = M.draft.enabled;
      enabled[n] = box.checked;
      if (!enabled.some(Boolean)) {
        enabled[n] = true;
        toast('Keep at least one DPI slot on.');
      } else if (!enabled[M.draft.current]) {
        M.draft.current = enabled.indexOf(true);
      }
      syncMouse();
    });

    row.append(pick, range, out, toggle);
    $('dpi-rows').append(row);
  }

  for (const hz of options.polling) {
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'polling';
    radio.value = hz;
    const text = document.createElement('span');
    text.textContent = `${hz} Hz`;
    label.append(radio, text);
    $('polling').append(label);
  }
  $('polling').addEventListener('change', (e) => {
    M.draft.polling = Number(e.target.value);
    syncMouse();
  });

  BUTTON_NAMES.forEach((name, n) => {
    const row = document.createElement('div');
    row.className = 'field button-row';
    const label = document.createElement('label');
    label.htmlFor = `button-${n}`;
    label.textContent = name;
    const select = document.createElement('select');
    select.id = `button-${n}`;
    for (const [code, text] of options.functions) select.append(new Option(text, code));
    select.addEventListener('change', () => {
      const before = M.draft.buttons[n];
      M.draft.buttons[n] = Number(select.value);
      if (!M.draft.buttons.includes(LEFT_CLICK)) {
        M.draft.buttons[n] = before;
        toast('One button has to stay as Left click.');
      }
      syncMouse();
    });
    row.addEventListener('mouseenter', () => markPart(n));
    row.addEventListener('mouseleave', () => markPart(-1));
    select.addEventListener('focus', () => markPart(n));
    select.addEventListener('blur', () => markPart(-1));
    row.append(label, select);
    $('button-rows').append(row);
  });

  $('mouse-revert').addEventListener('click', () => {
    M.draft = clone(M.saved);
    syncMouse();
  });
  $('mouse-apply').addEventListener('click', applyMouse);
  document.querySelectorAll('.m-part').forEach((part) => {
    part.addEventListener('click', () => $('button-' + part.dataset.n).focus());
  });
}

/* Light up one button on the diagram, or none with -1. */
function markPart(n) {
  document.querySelectorAll('.m-part').forEach((part) => {
    part.toggleAttribute('data-on', Number(part.dataset.n) === n);
  });
}

/* ---- drawing ----------------------------------------------------------- */

function syncMouse() {
  const d = M.draft;
  $('mouse-body').inert = !M.connected;
  if (!d) {
    $('mouse-status').textContent = '';
    return;
  }
  const values = M.options.dpi;
  document.querySelectorAll('.dpi-row').forEach((row, n) => {
    const [radio, range, box] = row.querySelectorAll('input');
    radio.checked = d.current === n;
    range.value = Math.max(0, values.indexOf(d.dpi[n]));
    row.querySelector('output').textContent = d.dpi[n] ?? values[0];
    box.checked = d.enabled[n];
    row.toggleAttribute('data-off', !d.enabled[n]);
  });
  document.querySelectorAll('input[name="polling"]').forEach((radio) => {
    radio.checked = Number(radio.value) === d.polling;
  });
  d.buttons.forEach((code, n) => {
    const select = $(`button-${n}`);
    if (![...select.options].some((o) => Number(o.value) === code)) {
      select.append(new Option('Other (kept as it is)', code));
    }
    select.value = code;
  });
  $('m-dpi').textContent = d.dpi[d.current] + ' DPI';
  $('m-hz').textContent = d.polling ? d.polling + ' Hz' : '';
  const dirty = mouseDirty();
  $('mouse-status').textContent = !M.connected ? '' : dirty ? 'Unsaved changes.' : 'Saved on the mouse.';
  $('mouse-revert').disabled = !dirty || M.busy;
  $('mouse-apply').disabled = !dirty || M.busy;
}

function takeMouseState(state) {
  M.connected = !!state.connected;
  setDeviceStatus('mouse', M.connected, M.connected ? 'Blaze 2 connected' : (state.error || 'Mouse not found'));
  if (!M.options && state.options) buildMouse(state.options);
  if (M.connected) {
    M.saved = {
      dpi: state.dpi.map((v) => v ?? M.options.dpi[0]),
      enabled: state.enabled,
      current: state.current,
      polling: state.polling,
      buttons: state.buttons,
    };
    M.draft = clone(M.saved);
  }
  syncMouse();
}

/* ---- talking to the mouse ---------------------------------------------- */

async function loadMouse() {
  if (M.busy) return;
  M.busy = true;
  try {
    takeMouseState(await api('/api/mouse'));
  } catch (err) {
    takeMouseState({ connected: false, error: err.message });
  }
  M.busy = false;
  syncMouse();
}

async function applyMouse() {
  M.busy = true;
  syncMouse();
  try {
    takeMouseState(await api('/api/mouse', M.draft));
  } catch (err) {
    toast(err.message);
  }
  M.busy = false;
  syncMouse();
}

/* ---- switching device --------------------------------------------------- */

$('devices').addEventListener('change', (e) => {
  showDevice(e.target.value);
  $('view-keyboard').hidden = activeDevice !== 'keyboard';
  $('view-mouse').hidden = activeDevice !== 'mouse';
  $('profiles').hidden = activeDevice !== 'keyboard';
  if (activeDevice === 'mouse') loadMouse();
  else renderKeyboard();
});

setInterval(() => {
  // Follow the mouse (its DPI button changes the slot), unless edits are waiting.
  if (activeDevice === 'mouse' && !document.hidden && !mouseDirty()) loadMouse();
}, 4000);
