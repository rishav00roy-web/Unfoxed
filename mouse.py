"""Driver for the EvoFox Blaze 2 mouse (Instant chip, USB 30FA:1440).

The mouse takes 8-byte HID feature reports on its vendor interface (usage page
0xFF01, report id 7). Command 0x18 reads and writes its settings memory:

    07 18 <flags> <index> <addr lo> <addr hi> <data> <length - 1>

    flags 0x05  read: then a GET feature report returns the byte at [1]
    flags 0x03  write one byte
    flags 0x09  commit the bytes just written
    flags 0x10  reload settings from memory
    flags 0x00  end of the exchange

Settings memory, as far as it is mapped:

    0x00  header (never written here)
    0x08  8 button codes, one per physical button
    0x10  DPI of the six slots, as sensor steps:
            [3] bit n   = bit 4 of slot n's step
            [5] [6] [7] = low nibbles, two slots per byte
    0x18  [0] bits 0-2  current DPI slot
          [1] bits 0-5  which slots are enabled
          [4] bits 4-6  lighting effect, bits 0-2 its cycle time (bits 7, 3 kept)
          [6]           polling interval in ms, minus one
    0x44, 0x50, 0x60  the button table again, for the other modes
"""

import threading
import time

import hid

VID = 0x30FA
PID = 0x1440
USAGE_PAGE = 0xFF01
REPORT_ID = 7

CMD_MEMORY = 0x18
F_READ = 0x05
F_WRITE = 0x03
F_COMMIT = 0x09
F_RELOAD = 0x10

ADDR_BUTTONS = 0x08
ADDR_DPI = 0x10
ADDR_SETTINGS = 0x18
BUTTON_MIRRORS = (0x44, 0x50, 0x60)

SLOTS = 6
BUTTONS = 8

# Sensor step -> DPI. Step 11 does not exist.
STEP_DPI = {
    1: 200, 2: 400, 3: 600, 4: 800, 5: 1000, 6: 1200, 7: 1400, 8: 1600, 9: 1800, 10: 2000,
    12: 2400, 13: 3200, 14: 4000, 15: 4800, 16: 5600, 17: 6400, 18: 7200, 19: 8000,
    20: 8800, 21: 9600, 22: 10400, 23: 11200, 24: 12800,
}
DPI_STEP = {dpi: step for step, dpi in STEP_DPI.items()}
DPI_VALUES = sorted(DPI_STEP)

POLLING = {0: 1000, 1: 500, 3: 250, 7: 125}     # stored byte -> Hz

# Lighting effects, in the vendor's order. Effect 2 (solid) is confirmed on the
# mouse; the other names are the vendor app's labels for the same numbers.
LIGHT_EFFECTS = [
    "DPI colour breathing", "Colour cycle breathing", "Solid", "Flowing water",
    "Single light flowing", "Comet", "Neon", "Ambilight",
]
LIGHT_TIME_MAX = 7
POLLING_BYTE = {hz: byte for byte, hz in POLLING.items()}

# Button functions this app can set, by the low five bits of the button code.
FUNCTIONS = {
    0x01: "Left click",
    0x02: "Right click",
    0x03: "Middle click",
    0x04: "Back",
    0x05: "Forward",
    0x06: "DPI cycle",
    0x0B: "DPI up",
    0x0C: "DPI down",
    0x08: "Double click",
    0x09: "Rapid fire",
    0x15: "Lighting cycle",
    0x00: "Disabled",
}
CODE_MASK = 0x1F
LEFT_CLICK = 0x01


class MouseError(Exception):
    """The mouse is missing or did not take a setting."""


class Mouse:
    def __init__(self):
        self._dev = None
        self._lock = threading.RLock()

    # ---- connection -------------------------------------------------------

    @property
    def connected(self):
        return self._dev is not None

    def connect(self):
        with self._lock:
            if self._dev is not None:
                return
            path = None
            for info in hid.enumerate(VID, PID):
                if info["usage_page"] == USAGE_PAGE:
                    path = info["path"]
                    break
            if path is None:
                raise MouseError("Mouse not found")
            dev = hid.device()
            try:
                dev.open_path(path)
            except OSError as exc:
                raise MouseError(f"Could not open the mouse: {exc}") from exc
            self._dev = dev

    def close(self):
        with self._lock:
            if self._dev is not None:
                try:
                    self._dev.close()
                except Exception:
                    pass
                self._dev = None

    # ---- memory -----------------------------------------------------------

    def _send(self, flags, index=0, addr=0, data=0, last=0):
        packet = bytes([REPORT_ID, CMD_MEMORY, flags, index, addr & 0xFF, addr >> 8, data, last])
        try:
            if self._dev.send_feature_report(packet) < 0:
                raise OSError("report refused")
        except (OSError, ValueError) as exc:
            self.close()
            raise MouseError(f"Lost the mouse: {exc}") from exc

    def read(self, addr, length):
        with self._lock:
            if self._dev is None:
                raise MouseError("Mouse not connected")
            out = bytearray()
            for i in range(length):
                self._send(F_READ, i, addr, 0, length - 1)
                time.sleep(0.003)
                try:
                    reply = self._dev.get_feature_report(REPORT_ID, 8)
                except (OSError, ValueError) as exc:
                    self.close()
                    raise MouseError(f"Lost the mouse: {exc}") from exc
                if len(reply) < 2:
                    raise MouseError("Short reply from the mouse")
                out.append(reply[1])
            self._send(0)
            time.sleep(0.003)
            return bytes(out)

    def write(self, addr, data):
        """Write bytes, commit them, and check they arrived."""
        data = bytes(data)
        with self._lock:
            if self._dev is None:
                raise MouseError("Mouse not connected")
            if addr < ADDR_BUTTONS:
                raise ValueError("refusing to write the header")
            for i, byte in enumerate(data):
                self._send(F_WRITE, i, addr, byte, len(data) - 1)
                time.sleep(0.002)
            time.sleep(0.004)
            self._send(F_COMMIT, 0, addr, 0, len(data) - 1)
            time.sleep(0.004)
            self._send(0, 0, addr)
            time.sleep(0.004)
            if self.read(addr, len(data)) != data:
                raise MouseError("The mouse did not keep the new setting")

    def reload(self):
        """Make the mouse start using what is in its memory."""
        with self._lock:
            self._send(F_RELOAD)
            time.sleep(0.006)
            self._send(0)
            time.sleep(0.004)

    # ---- settings ---------------------------------------------------------

    def get_state(self):
        with self._lock:
            buttons = self.read(ADDR_BUTTONS, 8)
            dpi = self.read(ADDR_DPI, 8)
            settings = self.read(ADDR_SETTINGS, 8)
        steps = self._steps(dpi)
        return {
            "dpi": [STEP_DPI.get(step) for step in steps],
            "enabled": [bool(settings[1] >> n & 1) for n in range(SLOTS)],
            "current": settings[0] & 7,
            "polling": POLLING.get(settings[6]),
            "buttons": [code & CODE_MASK for code in buttons],
            "light_effect": settings[4] >> 4 & 7,
            "light_speed": LIGHT_TIME_MAX - (settings[4] & 7),
        }

    @staticmethod
    def _steps(block):
        low = [block[5] >> 4, block[5] & 0xF, block[6] >> 4, block[6] & 0xF, block[7] >> 4, block[7] & 0xF]
        return [low[n] | ((block[3] >> n & 1) << 4) for n in range(SLOTS)]

    def apply(self, dpi=None, enabled=None, current=None, polling=None, buttons=None,
              light_effect=None, light_speed=None):
        """Change settings. Anything left as None stays as it is."""
        with self._lock:
            old_dpi = self.read(ADDR_DPI, 8)
            old_set = self.read(ADDR_SETTINGS, 8)
            new_dpi = bytearray(old_dpi)
            new_set = bytearray(old_set)

            if dpi is not None:
                if len(dpi) != SLOTS or any(value not in DPI_STEP for value in dpi):
                    raise ValueError("DPI values must be six of the supported steps")
                steps = [DPI_STEP[value] for value in dpi]
                high = sum((step >> 4 & 1) << n for n, step in enumerate(steps))
                new_dpi[3] = (old_dpi[3] & 0xC0) | high
                for n in range(3):
                    new_dpi[5 + n] = (steps[2 * n] & 0xF) << 4 | (steps[2 * n + 1] & 0xF)

            mask = old_set[1] & 0x3F
            if enabled is not None:
                if len(enabled) != SLOTS or not any(enabled):
                    raise ValueError("At least one DPI slot must stay on")
                mask = sum(1 << n for n in range(SLOTS) if enabled[n])
                new_set[1] = (old_set[1] & 0xC0) | mask

            slot = old_set[0] & 7 if current is None else int(current)
            if not 0 <= slot < SLOTS or not mask >> slot & 1:
                # the active slot was switched off: move to the first one still on
                slot = next(n for n in range(SLOTS) if mask >> n & 1)
            new_set[0] = (old_set[0] & 0xF8) | slot

            if polling is not None:
                if polling not in POLLING_BYTE:
                    raise ValueError("Polling rate must be 125, 250, 500 or 1000")
                new_set[6] = POLLING_BYTE[polling]

            if light_effect is not None:
                if not 0 <= light_effect < len(LIGHT_EFFECTS):
                    raise ValueError("Unknown lighting effect")
                new_set[4] = (new_set[4] & 0x8F) | light_effect << 4
            if light_speed is not None:
                if not 0 <= light_speed <= LIGHT_TIME_MAX:
                    raise ValueError("Lighting speed out of range")
                new_set[4] = (new_set[4] & 0xF8) | (LIGHT_TIME_MAX - light_speed)

            changed = False
            if bytes(new_dpi) != old_dpi:
                self.write(ADDR_DPI, new_dpi)
                changed = True
            if bytes(new_set) != old_set:
                self.write(ADDR_SETTINGS, new_set)
                changed = True
            if buttons is not None:
                changed = self._set_buttons(buttons) or changed
            if changed:
                self.reload()

    def _set_buttons(self, codes):
        if len(codes) != BUTTONS:
            raise ValueError("Expected a function for each of the eight buttons")
        old = self.read(ADDR_BUTTONS, 8)
        new = bytearray(old)
        for n, code in enumerate(codes):
            code = int(code)
            if code == old[n] & CODE_MASK:
                continue                    # leave it, including functions this app cannot set
            if code not in FUNCTIONS:
                raise ValueError("Unknown button function")
            new[n] = (old[n] & ~CODE_MASK & 0xFF) | code
        if not any(byte & CODE_MASK == LEFT_CLICK for byte in new):
            raise ValueError("One button has to stay as Left click")
        if bytes(new) == old:
            return False
        # The other modes keep their own copy of the table; keep them in step
        # where they still match, so the buttons act the same in every mode.
        mirrors = [addr for addr in BUTTON_MIRRORS if self.read(addr, 8) == old]
        self.write(ADDR_BUTTONS, new)
        for addr in mirrors:
            self.write(addr, new)
        return True
