"""Live effects: lighting the app draws itself, frame by frame, while it runs.

    ripple   a steady colour, with a ring spreading from every key you press
    music    bars that move with whatever the PC is playing
    screen   each key takes the colour of the part of the screen above it

The keyboard is driven with its direct-colour command, which is not saved to
the keyboard, so nothing is written to its flash. When the effect stops the
keyboard goes back to its own saved effect.

With "mouse follows" on, the mouse shows the same colour, using the mouse's
live colour command (also not saved). Stopping reloads the mouse's saved
lighting.
"""

import ctypes
import json
import math
import os
import threading
import time
from pathlib import Path

import evision
import mouse
from evision import DeviceError
from mouse import MouseError

EFFECTS = ("ripple", "music", "screen")
FPS = 30
SETTINGS_FILE = Path(os.environ.get("APPDATA", ".")) / "Unfoxed" / "live.json"

DEFAULTS = {
    "effect": None,
    "base": [30, 70, 255],
    "brightness": 100,
    "vivid": True,
    "accent": [255, 140, 40],
    "rainbow": False,
    "mouse_follows": False,
}

# HID usage -> Windows virtual-key code, for spotting key presses.
_VK = {0x28: 0x0D, 0x29: 0x1B, 0x2A: 0x08, 0x2B: 0x09, 0x2C: 0x20, 0x2D: 0xBD, 0x2E: 0xBB,
       0x2F: 0xDB, 0x30: 0xDD, 0x31: 0xDC, 0x33: 0xBA, 0x34: 0xDE, 0x35: 0xC0, 0x36: 0xBC,
       0x37: 0xBE, 0x38: 0xBF, 0x39: 0x14, 0x4B: 0x21, 0x4C: 0x2E, 0x4E: 0x22,
       0x4F: 0x27, 0x50: 0x25, 0x51: 0x28, 0x52: 0x26, 0x27: 0x30}
_VK.update({0x04 + i: 0x41 + i for i in range(26)})          # A-Z
_VK.update({0x1E + i: 0x31 + i for i in range(9)})           # 1-9
_VK.update({0x3A + i: 0x70 + i for i in range(12)})          # F1-F12
_MOD_VK = {0x01: 0xA2, 0x02: 0xA0, 0x04: 0xA4, 0x08: 0x5B, 0x10: 0xA3, 0x20: 0xA1, 0x40: 0xA5, 0x80: 0x5C}


def vk_for(code):
    """Virtual-key code for a layout key code (0x20MMUU), or None (Fn)."""
    if code >> 16 != 0x20:
        return None
    mods = (code >> 8) & 0xFF
    if mods:
        return _MOD_VK.get(mods)
    return _VK.get(code & 0xFF)


def hue(h):
    h = (h % 1.0) * 6
    i = int(h)
    f = h - i
    q, t = int(255 * (1 - f)), int(255 * f)
    return [(255, t, 0), (q, 255, 0), (0, 255, t), (0, q, 255), (t, 0, 255), (255, 0, q)][i % 6]


def vivid(rgb):
    """Richer colour at the same brightness. LEDs make mixed and averaged
    colours look washed out, so push the channels apart, then apply a curve
    that deepens the weaker channels, and scale back to the original peak."""
    peak = max(rgb)
    if peak == 0:
        return rgb
    grey = sum(rgb) / 3
    spread = [max(0.0, min(255.0, grey + (c - grey) * 1.6)) for c in rgb]
    curved = [(c / 255) ** 1.8 for c in spread]
    top = max(curved) or 1
    return [int(min(255, c / top * peak)) for c in curved]


def mix(a, b, k):
    return [int(a[i] + (b[i] - a[i]) * k) for i in range(3)]


class LiveEngine:
    def __init__(self, keyboard, mouse_dev, layout):
        self.kb = keyboard
        self.ms = mouse_dev
        self.keys = [dict(slot=k["slot"], cx=k["x"] + k["w"] / 2, cy=k["y"] + 0.5, vk=vk_for(k["code"]))
                     for k in layout["keys"]]
        self.width = layout["width"]
        self.height = layout["height"]
        self.slots = 128
        self.settings = dict(DEFAULTS)
        self.error = None
        self._thread = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._presses = []
        self._levels = [0.0] * 16
        self._mouse_live = False
        self._mouse_begun = 0.0
        self.load()

    # ---- settings ---------------------------------------------------------

    def load(self):
        try:
            saved = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            self.settings.update({k: saved[k] for k in DEFAULTS if k in saved})
        except (OSError, ValueError):
            pass

    def save(self):
        try:
            SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
            SETTINGS_FILE.write_text(json.dumps(self.settings), encoding="utf-8")
        except OSError:
            pass

    def state(self):
        return {**self.settings, "running": self.running, "error": self.error}

    @property
    def running(self):
        return self._thread is not None and self._thread.is_alive()

    def configure(self, changes):
        """Update settings; start, switch or stop the effect to match."""
        with self._lock:
            for key in DEFAULTS:
                if key in changes:
                    self.settings[key] = changes[key]
            if self.settings["effect"] not in EFFECTS:
                self.settings["effect"] = None
            self.save()
        if self.settings["effect"] and not self.running:
            self.start()
        elif not self.settings["effect"] and self.running:
            self.stop()
        if self.running and not self.settings["mouse_follows"]:
            self._release_mouse()

    # ---- running ------------------------------------------------------------

    def start(self):
        if self.running:
            return
        self.error = None
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="live-effects", daemon=True)
        self._thread.start()

    def stop(self):
        if not self.running:
            return
        self._stop.set()
        self._thread.join(timeout=2)
        self._thread = None

    def _run(self):
        audio = screen = None
        pressed = set()
        try:
            while not self._stop.is_set():
                started = time.monotonic()
                effect = self.settings["effect"]
                if effect == "music" and audio is None:
                    audio = _AudioMeter(self)
                if effect != "music" and audio is not None:
                    audio.close()
                    audio = None
                if effect == "screen" and screen is None:
                    screen = _ScreenSampler()
                if effect != "screen" and screen is not None:
                    screen.close()
                    screen = None

                now = time.monotonic()
                if effect == "ripple":
                    self._read_presses(pressed, now)
                    colours = self._ripple(now)
                elif effect == "music":
                    colours = self._music(now)
                else:
                    colours = self._screen(screen)

                scale = max(0, min(100, int(self.settings["brightness"]))) / 100
                if self.settings["vivid"]:
                    colours = [vivid(rgb) for rgb in colours]
                colours = [[int(c * scale) for c in rgb] for rgb in colours]
                frame = [[0, 0, 0] for _ in range(self.slots)]
                for key, rgb in zip(self.keys, colours):
                    frame[key["slot"]] = rgb
                try:
                    self.kb.connect()
                    self.kb.direct(frame)
                    self.error = None
                except DeviceError as exc:
                    self.error = str(exc)
                    time.sleep(1)
                if self.settings["mouse_follows"]:
                    self._drive_mouse(colours)

                time.sleep(max(0.0, 1 / FPS - (time.monotonic() - started)))
        finally:
            if audio:
                audio.close()
            if screen:
                screen.close()
            try:
                self.kb.direct_end()
            except DeviceError:
                pass
            self._release_mouse()

    # ---- effects ------------------------------------------------------------

    def _read_presses(self, pressed, now):
        get = ctypes.windll.user32.GetAsyncKeyState
        for i, key in enumerate(self.keys):
            vk = key["vk"]
            if vk is None:
                continue
            down = bool(get(vk) & 0x8000)
            if down and i not in pressed:
                self._presses.append((key["cx"], key["cy"], now, (now * 0.17) % 1))
                pressed.add(i)
            elif not down:
                pressed.discard(i)
        self._presses = [p for p in self._presses if now - p[2] < 1.6][-24:]

    def _ripple(self, now):
        base = self.settings["base"]
        accent = self.settings["accent"]
        out = []
        for key in self.keys:
            best, colour = 0.0, accent
            for x, y, at, h in self._presses:
                r = (now - at) * 11
                d = math.hypot(key["cx"] - x, (key["cy"] - y) * 1.1)
                k = max(0.0, 1 - abs(d - r) / 1.3) * max(0.0, 1 - r / 17)
                if k > best:
                    best, colour = k, (hue(h) if self.settings["rainbow"] else accent)
            out.append(mix(base, colour, best))
        return out

    def _music(self, now):
        levels = self._levels
        rows = 6
        out = []
        for key in self.keys:
            band = min(len(levels) - 1, int(key["cx"] / self.width * len(levels)))
            height = levels[band] * rows
            row_from_bottom = rows - 1 - min(rows - 1, int(key["cy"] - 0.25))
            lit = max(0.0, min(1.0, height - row_from_bottom))
            if self.settings["rainbow"]:
                colour = hue(key["cx"] / self.width * 0.8 + now * 0.05)
            else:
                colour = mix(self.settings["accent"], [255, 40, 40], row_from_bottom / (rows - 1))
            out.append(mix(self.settings["base"], colour, lit))
        return out

    def _screen(self, sampler):
        if sampler is None:
            return [self.settings["base"]] * len(self.keys)
        grid = sampler.grid()
        if grid is None:
            return [self.settings["base"]] * len(self.keys)
        rows, cols = len(grid), len(grid[0])
        out = []
        for key in self.keys:
            c = min(cols - 1, int(key["cx"] / self.width * cols))
            r = min(rows - 1, int(key["cy"] / self.height * rows))
            out.append(grid[r][c])
        return out

    # ---- mouse ----------------------------------------------------------------

    def _drive_mouse(self, colours):
        n = len(colours) or 1
        avg = [sum(c[i] for c in colours) // n for i in range(3)]
        peak = max(colours, key=lambda c: sum(c)) if colours else avg
        rgb = peak if self.settings["effect"] == "ripple" else avg
        if self.settings["vivid"]:
            rgb = vivid(rgb)          # an average of many colours is dull otherwise
        try:
            self.ms.connect()
            now = time.monotonic()
            # Pressing the mouse's lighting button switches it to its next own
            # effect; taking live mode back every second keeps it following.
            if not self._mouse_live or now - self._mouse_begun > 1.0:
                self.ms.live_begin()
                self._mouse_live = True
                self._mouse_begun = now
            self.ms.live_colour(rgb)
        except MouseError:
            self._mouse_live = False

    def _release_mouse(self):
        if self._mouse_live:
            self._mouse_live = False
            try:
                self.ms.live_end()
            except MouseError:
                pass


class _AudioMeter:
    """Loudness in 16 frequency bands of what the PC is playing."""

    def __init__(self, engine):
        self.engine = engine
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="live-audio", daemon=True)
        self._thread.start()

    def _run(self):
        try:
            import numpy as np
            import soundcard as sc
        except ImportError:
            self.engine.error = "Music needs the soundcard and numpy packages"
            return
        rate, block = 44100, 1024
        edges = np.geomspace(40, 12000, 17)
        bins = np.fft.rfftfreq(block, 1 / rate)
        index = [np.where((bins >= edges[i]) & (bins < edges[i + 1]))[0] for i in range(16)]
        window = np.hanning(block)
        peak = [1e-3] * 16
        smooth = [0.0] * 16
        try:
            speaker = sc.default_speaker()
            mic = sc.get_microphone(id=str(speaker.name), include_loopback=True)
            with mic.recorder(samplerate=rate, blocksize=block) as rec:
                while not self._stop.is_set():
                    data = rec.record(numframes=block)
                    mono = data.mean(axis=1) if data.ndim > 1 else data
                    spectrum = np.abs(np.fft.rfft(mono * window))
                    for i, idx in enumerate(index):
                        v = float(spectrum[idx].mean()) if len(idx) else 0.0
                        peak[i] = max(v, peak[i] * 0.995, 1e-3)
                        level = min(1.0, v / peak[i])
                        smooth[i] = max(level, smooth[i] * 0.82)
                    self.engine._levels = list(smooth)
        except Exception as exc:              # sound devices fail in many ways
            self.engine.error = f"Could not listen to the PC's sound: {exc}"

    def close(self):
        self._stop.set()
        self.engine._levels = [0.0] * 16


class _ScreenSampler:
    """Average colours of the main screen, on a coarse grid."""

    COLS, ROWS = 17, 7

    def __init__(self):
        self._sct = None
        try:
            import mss
            self._sct = mss.mss()
        except ImportError:
            pass

    def grid(self):
        if self._sct is None:
            return None
        import numpy as np
        shot = self._sct.grab(self._sct.monitors[1])
        img = np.frombuffer(shot.bgra, dtype=np.uint8).reshape(shot.height, shot.width, 4)[::8, ::8, 2::-1]
        h, w = img.shape[:2]
        out = []
        for r in range(self.ROWS):
            row = []
            for c in range(self.COLS):
                cell = img[r * h // self.ROWS:(r + 1) * h // self.ROWS, c * w // self.COLS:(c + 1) * w // self.COLS]
                rgb = cell.reshape(-1, 3).mean(axis=0)
                top = rgb.max() or 1
                boost = min(2.0, 255 / top)           # keep dark scenes visible
                row.append([int(min(255, v * boost)) for v in rgb])
            out.append(row)
        return out

    def close(self):
        if self._sct is not None:
            self._sct.close()
