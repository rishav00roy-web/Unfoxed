'use strict';

/* The Keys tab: change what a key or the knob does.
   Uses $, api, toast, same, clone, S and renderKeyboard from app.js.

   A key's function is three bytes, kept here as one number:
     0x20 MM UU   keyboard key: MM = modifier bits, UU = HID usage
     0x30 LL HH   media key: 16-bit consumer usage, low byte first
     0xA0 .. ..   the Fn key (left alone)                                  */

const KEY_TYPE = 0x20;
const MEDIA_TYPE = 0x30;
const FN_TYPE = 0xa0;
const DISABLED = 0x200000;

const MODIFIERS = [
  [0x01, 'Ctrl', 'ControlLeft'], [0x02, 'Shift', 'ShiftLeft'], [0x04, 'Alt', 'AltLeft'], [0x08, 'Win', 'MetaLeft'],
  [0x10, 'Right Ctrl', 'ControlRight'], [0x20, 'Right Shift', 'ShiftRight'],
  [0x40, 'Right Alt', 'AltRight'], [0x80, 'Right Win', 'MetaRight'],
];

/* HID usage, the browser's name for the key, and what to call it. */
const USAGES = [
  ...[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c, i) => [0x04 + i, `Key${c}`, c]),
  ...[...'123456789'].map((c, i) => [0x1e + i, `Digit${c}`, c]),
  [0x27, 'Digit0', '0'], [0x28, 'Enter', 'Enter'], [0x29, 'Escape', 'Esc'], [0x2a, 'Backspace', 'Backspace'],
  [0x2b, 'Tab', 'Tab'], [0x2c, 'Space', 'Space'], [0x2d, 'Minus', '-'], [0x2e, 'Equal', '='],
  [0x2f, 'BracketLeft', '['], [0x30, 'BracketRight', ']'], [0x31, 'Backslash', '\\'],
  [0x33, 'Semicolon', ';'], [0x34, 'Quote', "'"], [0x35, 'Backquote', '`'], [0x36, 'Comma', ','],
  [0x37, 'Period', '.'], [0x38, 'Slash', '/'], [0x39, 'CapsLock', 'Caps Lock'],
  ...Array.from({ length: 12 }, (_, i) => [0x3a + i, `F${i + 1}`, `F${i + 1}`]),
  [0x46, 'PrintScreen', 'Print Screen'], [0x47, 'ScrollLock', 'Scroll Lock'], [0x48, 'Pause', 'Pause'],
  [0x49, 'Insert', 'Insert'], [0x4a, 'Home', 'Home'], [0x4b, 'PageUp', 'Page Up'], [0x4c, 'Delete', 'Delete'],
  [0x4d, 'End', 'End'], [0x4e, 'PageDown', 'Page Down'], [0x4f, 'ArrowRight', 'Right arrow'],
  [0x50, 'ArrowLeft', 'Left arrow'], [0x51, 'ArrowDown', 'Down arrow'], [0x52, 'ArrowUp', 'Up arrow'],
  [0x53, 'NumLock', 'Num Lock'], [0x54, 'NumpadDivide', 'Num /'], [0x55, 'NumpadMultiply', 'Num *'],
  [0x56, 'NumpadSubtract', 'Num -'], [0x57, 'NumpadAdd', 'Num +'], [0x58, 'NumpadEnter', 'Num Enter'],
  ...[...'123456789'].map((c, i) => [0x59 + i, `Numpad${c}`, `Num ${c}`]),
  [0x62, 'Numpad0', 'Num 0'], [0x63, 'NumpadDecimal', 'Num .'], [0x65, 'ContextMenu', 'Menu'],
  ...Array.from({ length: 12 }, (_, i) => [0x68 + i, `F${i + 13}`, `F${i + 13}`]),
];
const USAGE_NAME = Object.fromEntries(USAGES.map(([u, , name]) => [u, name]));
const CODE_USAGE = Object.fromEntries(USAGES.map(([u, code]) => [code, u]));
const MODIFIER_BIT = Object.fromEntries(MODIFIERS.map(([bit, , code]) => [code, bit]));

const MEDIA = [
  [0xe9, 'Volume up'], [0xea, 'Volume down'], [0xe2, 'Mute'], [0xcd, 'Play / pause'],
  [0xb5, 'Next track'], [0xb6, 'Previous track'], [0xb7, 'Stop'],
  [0x183, 'Media player'], [0x192, 'Calculator'], [0x18a, 'Mail'], [0x223, 'Browser home'],
];
const MEDIA_NAME = Object.fromEntries(MEDIA);

/* Keys the browser cannot capture, or that are not on this keyboard. */
const EXTRA_KEYS = [0x29, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4d, 0x65, ...Array.from({ length: 12 }, (_, i) => 0x68 + i)];

const keyCode = (usage, mods = 0) => (KEY_TYPE << 16) | (mods << 8) | usage;
const mediaCode = (usage) => (MEDIA_TYPE << 16) | ((usage & 0xff) << 8) | (usage >> 8);

function describe(code) {
  const type = code >>> 16;
  if (type === FN_TYPE) return 'Fn';
  if (type === MEDIA_TYPE) {
    return MEDIA_NAME[((code & 0xff) << 8) | ((code >> 8) & 0xff)] || 'Media key';
  }
  if (type !== KEY_TYPE) return 'Special function';
  const mods = (code >> 8) & 0xff;
  const usage = code & 0xff;
  if (!mods && !usage) return 'Disabled';
  const parts = MODIFIERS.filter(([bit]) => mods & bit).map(([, name]) => name);
  if (usage) parts.push(USAGE_NAME[usage] || `Key ${usage}`);
  return parts.join(' + ');
}

/* ---- state ------------------------------------------------------------- */

const K = {
  profile: -1,
  saved: null,        // function of every slot, as the keyboard has it
  draft: null,
  targets: [],        // everything that can be changed: keys, then the knob
  selected: -1,
  capturing: false,
  busy: false,
  retryAt: 0,         // after a failed read, wait before trying again
};

const keysDirty = () => !!K.saved && !same(K.saved, K.draft);
const changedSlots = () => K.targets.filter((t) => K.draft[t.slot] !== K.saved[t.slot]).map((t) => t.slot);

/* ---- building ---------------------------------------------------------- */

function buildKeys() {
  K.targets = [
    ...S.layout.keys.map((key, index) => ({
      slot: key.slot, name: `${KEY_NAMES[key.label] || key.label} key`, default: key.code, index,
    })),
    ...S.layout.extras.map((extra) => ({ slot: extra.slot, name: extra.label, default: extra.code, index: -1 })),
  ];

  K.targets.forEach((target, n) => {
    if (target.index >= 0) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip knob-target';
    chip.dataset.target = n;
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => selectTarget(n));
    $('knob-targets').append(chip);
  });

  const pick = $('key-pick');
  pick.append(new Option('Choose…', ''));
  const group = (label, entries) => {
    const el = document.createElement('optgroup');
    el.label = label;
    for (const [code, text] of entries) el.append(new Option(text, code));
    pick.append(el);
  };
  group('Media', MEDIA.map(([usage, name]) => [mediaCode(usage), name]));
  group('Other keys', EXTRA_KEYS.map((usage) => [keyCode(usage), USAGE_NAME[usage]]));
  group('Off', [[DISABLED, 'Disabled']]);
  pick.addEventListener('change', () => {
    if (pick.value !== '') assign(Number(pick.value));
    pick.value = '';
  });

  $('key-capture').addEventListener('click', () => setCapturing(!K.capturing));
  $('key-default').addEventListener('click', () => assign(K.targets[K.selected].default));
  $('keys-revert').addEventListener('click', () => {
    K.draft = clone(K.saved);
    renderKeys();
  });
  $('keys-save').addEventListener('click', saveKeys);

  // Capture the next key press (or combination) as the new function.
  window.addEventListener('keydown', (e) => {
    if (!K.capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code in MODIFIER_BIT) return;           // wait for the key that goes with it
    const usage = CODE_USAGE[e.code];
    if (usage === undefined) {
      toast('That key cannot be read here. Choose it from the list instead.');
      return;
    }
    const mods = (e.ctrlKey ? 0x01 : 0) | (e.shiftKey ? 0x02 : 0) | (e.altKey ? 0x04 : 0) | (e.metaKey ? 0x08 : 0);
    assign(keyCode(usage, mods));
  }, true);
  window.addEventListener('keyup', (e) => {
    // A modifier pressed and let go on its own is the modifier key itself.
    if (!K.capturing || !(e.code in MODIFIER_BIT)) return;
    e.preventDefault();
    assign(keyCode(0, MODIFIER_BIT[e.code]));
  }, true);
}

/* ---- editing ----------------------------------------------------------- */

function setCapturing(on) {
  K.capturing = on;
  $('key-capture').textContent = on ? 'Press a key or a combination…' : 'Press a key…';
  $('key-capture').setAttribute('aria-pressed', String(on));
}

function selectTarget(n) {
  if (!K.draft) return;
  K.selected = n;
  setCapturing(false);
  renderKeys();
}

function selectKey(index) {
  selectTarget(K.targets.findIndex((t) => t.index === index));
}

function assign(code) {
  const target = K.targets[K.selected];
  if (!target || !K.draft) return;
  K.draft[target.slot] = code;
  setCapturing(false);
  renderKeys();
}

/* ---- drawing ----------------------------------------------------------- */

function renderKeys() {
  const ready = !!K.draft && S.connected;
  if (S.tab === 'keys' && S.connected && K.profile !== S.profile && !K.busy && Date.now() >= K.retryAt) loadKeys();

  K.targets.forEach((target, n) => {
    const changed = ready && K.draft[target.slot] !== K.saved[target.slot];
    const selected = S.tab === 'keys' && n === K.selected;
    if (target.index >= 0) {
      const el = S.keyEls[target.index];
      el.toggleAttribute('data-changed', S.tab === 'keys' && changed);
      el.toggleAttribute('data-selected', selected);
      el.title = S.tab === 'keys' && ready ? describe(K.draft[target.slot]) : '';
    } else {
      const chip = document.querySelector(`.knob-target[data-target="${n}"]`);
      chip.textContent = ready ? `${target.name}: ${describe(K.draft[target.slot])}` : target.name;
      chip.setAttribute('aria-pressed', String(selected));
      chip.toggleAttribute('data-changed', changed);
    }
  });

  const target = K.targets[K.selected];
  const locked = ready && target && K.saved[target.slot] >>> 16 === FN_TYPE;
  $('key-title').textContent = target ? target.name : 'Choose a key';
  $('key-now').textContent = !ready
    ? 'Reading keys from the keyboard…'
    : !target
      ? 'Click a key on the keyboard above, or one of the knob actions.'
      : locked
        ? 'The Fn key cannot be changed.'
        : `Does: ${describe(K.draft[target.slot])}`;
  $('key-controls').hidden = !ready || !target || locked;
  if (ready && target) $('key-default').disabled = K.draft[target.slot] === target.default;

  const count = ready ? changedSlots().length : 0;
  $('keys-status').textContent = !ready
    ? ''
    : count
      ? `${count} unsaved ${count === 1 ? 'change' : 'changes'}.`
      : 'Saved on the keyboard.';
  $('keys-revert').disabled = !count || K.busy;
  $('keys-save').disabled = !count || K.busy;
}

/* ---- talking to the keyboard ------------------------------------------- */

function takeKeys(data) {
  K.profile = data.profile;
  K.saved = data.keys;
  K.draft = clone(data.keys);
}

async function loadKeys() {
  if (K.busy) return;
  K.busy = true;
  K.saved = null;
  K.draft = null;
  K.selected = -1;
  setCapturing(false);
  renderKeys();
  try {
    takeKeys(await api('/api/keymap'));
  } catch (err) {
    K.profile = -1;
    K.retryAt = Date.now() + 3000;
    toast(err.message);
  }
  K.busy = false;
  renderKeys();
}

async function saveKeys() {
  const changes = Object.fromEntries(changedSlots().map((slot) => [slot, K.draft[slot]]));
  K.busy = true;
  renderKeys();
  try {
    takeKeys(await api('/api/keymap', { changes }));
  } catch (err) {
    toast(err.message);
  }
  K.busy = false;
  renderKeys();
}
