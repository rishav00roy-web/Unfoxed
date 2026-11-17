"""Driver for EVision "V2" protocol keyboards (EvoFox Ronin Wireless, 320F:5055).

Protocol: 64-byte HID reports on the vendor interface (usage page 0xFF1C).

    byte 0      report id (4)
    byte 1..2   checksum, little endian: sum of bytes 3..63
    byte 3      command
    byte 4      payload size (max 56)
    byte 5..6   offset, little endian
    byte 7      status in replies (0 = ok)
    byte 8..63  payload

The keyboard echoes every packet back, with the payload filled in for reads.

Device memory, as seen through CMD_READ_CONFIG:

    0x000           active profile (0..2)
    0x001 + p*0x40  lighting block of profile p
    0x0C0 + p*0x200 key map of profile p, 3 bytes per matrix slot:
                    20 MM UU keyboard key (modifier bits, HID usage),
                    30 LL HH media key (consumer usage), A0 .. .. the Fn key
    (custom colour sets are reached through their own commands)

Matrix slots run column-major, 8 per column: slot = column * 8 + row.
"""

import threading
import time

import hid

VID = 0x320F
PID = 0x5055
USAGE_PAGE = 0xFF1C

REPORT_ID = 4
PACKET = 64
PAYLOAD = PACKET - 8

CMD_BEGIN = 0x01
CMD_END = 0x02
CMD_READ_CAPS = 0x03
CMD_READ_CONFIG = 0x05
CMD_WRITE_CONFIG = 0x06
CMD_READ_CUSTOM = 0x0A
CMD_WRITE_CUSTOM = 0x0B
CMD_DIRECT = 0x12
CMD_DIRECT_END = 0x13

OFF_PROFILE = 0x00
OFF_KEYMAP = 0xC0
KEYMAP_STRIDE = 0x200
KEY_FN = 0xA0          # type byte of the Fn key
OFF_LIGHTING = 0x01
PROFILE_STRIDE = 0x40
PROFILES = 3

P_MODE = 0x00
P_BRIGHTNESS = 0x01
P_SPEED = 0x02
P_DIRECTION = 0x03
P_RANDOM = 0x04
P_COLOR = 0x05
P_LEDMODE = 0x11
P_CUSTOM_SET = 0x19

MODE_CUSTOM = 0x14
CUSTOM_SETS = 7
CUSTOM_STRIDE = 512

BRIGHTNESS_MAX = 4
SPEED_SLOWEST = 4


class DeviceError(Exception):
    """The keyboard is missing, asleep, or answered with an error."""


class Keyboard:
    def __init__(self):
        self._dev = None
        self._lock = threading.RLock()
        self.slots = 128
        self.product = ""

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
                raise DeviceError("Keyboard receiver not found")
            dev = hid.device()
            try:
                dev.open_path(path)
            except OSError as exc:
                raise DeviceError(f"Could not open the keyboard: {exc}") from exc
            self._dev = dev
            try:
                self.product = dev.get_product_string() or ""
                caps = self._read(CMD_READ_CAPS, 0, 7)
                if caps[0] != 0xAA or caps[1] != 0x55:
                    raise DeviceError("Unexpected reply from the keyboard")
                self.slots = caps[5] or 128
            except Exception:
                self.close()
                raise

    def close(self):
        with self._lock:
            if self._dev is not None:
                try:
                    self._dev.close()
                except Exception:
                    pass
                self._dev = None

    # ---- transport --------------------------------------------------------

    def _query(self, cmd, offset=0, size=0, data=b""):
        if self._dev is None:
            raise DeviceError("Keyboard not connected")
        buf = bytearray(PACKET)
        buf[0] = REPORT_ID
        buf[3] = cmd
        buf[4] = size
        buf[5] = offset & 0xFF
        buf[6] = (offset >> 8) & 0xFF
        buf[8:8 + len(data)] = data
        checksum = sum(buf[3:]) & 0xFFFF
        buf[1] = checksum & 0xFF
        buf[2] = checksum >> 8
        try:
            self._dev.write(bytes(buf))
            deadline = time.monotonic() + 1.0
            while time.monotonic() < deadline:
                reply = self._dev.read(PACKET, 250)
                if not reply:
                    continue
                if reply[0] == REPORT_ID and reply[3] == cmd \
                        and reply[5] == buf[5] and reply[6] == buf[6]:
                    if reply[7] != 0:
                        raise DeviceError(f"Keyboard rejected command {cmd:#04x} (status {reply[7]})")
                    return bytes(reply)
        except (OSError, ValueError) as exc:
            self.close()
            raise DeviceError(f"Lost the keyboard: {exc}") from exc
        raise DeviceError("Keyboard did not answer. Is it switched on?")

    def _read(self, cmd, offset, size):
        out = bytearray()
        while size > 0:
            reply = self._query(cmd, offset, min(size, PAYLOAD))
            got = reply[4]
            if got == 0 or got > PAYLOAD:
                raise DeviceError("Short read from the keyboard")
            out += reply[8:8 + got]
            offset += got
            size -= got
        return bytes(out)

    def _write(self, cmd, offset, data):
        data = bytes(data)
        pos = 0
        while pos < len(data):
            chunk = data[pos:pos + PAYLOAD]
            self._query(cmd, offset + pos, len(chunk), chunk)
            pos += len(chunk)

    # ---- profiles and lighting -------------------------------------------

    def get_profile(self):
        with self._lock:
            profile = self._read(CMD_READ_CONFIG, OFF_PROFILE, 1)[0]
            return profile if profile < PROFILES else 0

    def set_profile(self, profile):
        if not 0 <= profile < PROFILES:
            raise ValueError("profile out of range")
        with self._lock:
            self._query(CMD_BEGIN)
            try:
                self._write(CMD_WRITE_CONFIG, OFF_PROFILE, bytes([profile]))
            finally:
                self._query(CMD_END)

    def get_lighting(self, profile):
        with self._lock:
            base = OFF_LIGHTING + profile * PROFILE_STRIDE
            raw = self._read(CMD_READ_CONFIG, base, P_CUSTOM_SET + 1)
        return {
            "mode": raw[P_MODE],
            "brightness": min(raw[P_BRIGHTNESS], BRIGHTNESS_MAX),
            "speed": min(raw[P_SPEED], SPEED_SLOWEST),
            "direction": 1 if raw[P_DIRECTION] else 0,
            "random": bool(raw[P_RANDOM]),
            "color": [raw[P_COLOR], raw[P_COLOR + 1], raw[P_COLOR + 2]],
            "ledmode": raw[P_LEDMODE],
            "custom_set": raw[P_CUSTOM_SET] if raw[P_CUSTOM_SET] < CUSTOM_SETS else 0,
        }

    def set_lighting(self, profile, cfg):
        """Write the effect parameters of one profile. Only the bytes we
        understand are touched; the rest of the block is left as it is."""
        head = bytes([
            cfg["mode"] & 0xFF,
            max(0, min(BRIGHTNESS_MAX, cfg["brightness"])),
            max(0, min(SPEED_SLOWEST, cfg["speed"])),
            1 if cfg["direction"] else 0,
            1 if cfg["random"] else 0,
            cfg["color"][0] & 0xFF, cfg["color"][1] & 0xFF, cfg["color"][2] & 0xFF,
        ])
        base = OFF_LIGHTING + profile * PROFILE_STRIDE
        with self._lock:
            self._query(CMD_BEGIN)
            try:
                self._write(CMD_WRITE_CONFIG, base, head)
                if cfg["mode"] == MODE_CUSTOM:
                    self._write(CMD_WRITE_CONFIG, base + P_CUSTOM_SET,
                                bytes([cfg.get("custom_set", 0) % CUSTOM_SETS]))
                elif "ledmode" in cfg:
                    self._write(CMD_WRITE_CONFIG, base + P_LEDMODE, bytes([cfg["ledmode"] & 0xFF]))
            finally:
                self._query(CMD_END)

    # ---- per-key colours --------------------------------------------------

    def get_custom(self, index):
        with self._lock:
            raw = self._read(CMD_READ_CUSTOM, CUSTOM_STRIDE * index, 3 * self.slots)
        return [list(raw[i:i + 3]) for i in range(0, len(raw), 3)]

    def set_custom(self, index, colors):
        data = self._pack(colors)
        with self._lock:
            self._query(CMD_BEGIN)
            try:
                self._write(CMD_WRITE_CUSTOM, CUSTOM_STRIDE * index, data)
            finally:
                self._query(CMD_END)

    def direct(self, colors):
        """Show colours straight away without saving them."""
        with self._lock:
            self._write(CMD_DIRECT, 0, self._pack(colors))

    def direct_end(self):
        with self._lock:
            self._query(CMD_DIRECT_END)

    def _pack(self, colors):
        data = bytearray(3 * self.slots)
        for slot, rgb in enumerate(colors[:self.slots]):
            data[slot * 3:slot * 3 + 3] = bytes(c & 0xFF for c in rgb)
        return bytes(data)

    # ---- key map ----------------------------------------------------------

    def get_keymap(self, profile):
        with self._lock:
            raw = self._read(CMD_READ_CONFIG, OFF_KEYMAP + profile * KEYMAP_STRIDE, 3 * self.slots)
        return [int.from_bytes(raw[i:i + 3], "big") for i in range(0, len(raw), 3)]

    def set_keys(self, profile, changes):
        """Give matrix slots a new function. `changes` maps slot -> 3-byte code."""
        base = OFF_KEYMAP + profile * KEYMAP_STRIDE
        with self._lock:
            current = self.get_keymap(profile)
            for slot in changes:
                if not 0 <= slot < self.slots:
                    raise ValueError("slot out of range")
                if current[slot] >> 16 == KEY_FN:
                    raise ValueError("The Fn key cannot be changed")
            self._query(CMD_BEGIN)
            try:
                for slot, code in changes.items():
                    self._write(CMD_WRITE_CONFIG, base + slot * 3, code.to_bytes(3, "big"))
            finally:
                self._query(CMD_END)
            after = self.get_keymap(profile)
            if any(after[slot] != code for slot, code in changes.items()):
                raise DeviceError("The keyboard did not keep the new key functions")
