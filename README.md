# Unfoxed

An unofficial, open replacement for the EvoFox keyboard and mouse software, in
one app. It talks to the devices directly, so the vendor apps do not need to be
installed.

Not affiliated with or endorsed by EvoFox or Amkette.

## Supported devices

| Device | USB ID | Status |
|---|---|---|
| EvoFox Ronin Wireless keyboard (2.4G receiver) | `320F:5055` | Lighting, profiles, per-key colours |
| EvoFox Blaze 2 mouse | `30FA:1440` | DPI, polling rate, button functions |

Other keyboards built on the same Evision chip and "V2" protocol may work, but
only the Ronin has been tested, and the key layout is the Ronin's.

## What it does

Keyboard:

- **Effects**: all 18 built-in lighting effects, with the brightness, speed,
  direction and colour controls each effect actually has
- **Animated preview**: an on-screen keyboard that simulates the chosen effect.
  Effects that react to typing respond to your key presses
- **Per-key colours**: paint keys by clicking or dragging, fill groups (WASD,
  arrows, F keys and so on), watch the real keyboard follow live, then save to
  one of seven layouts stored on the keyboard
- **Profiles**: switch between the keyboard's three onboard profiles
- **Keys**: change what any key or the volume knob does, by pressing the new
  key or combination, or by picking a media key from a list

Mouse:

- **DPI**: six slots, each from 200 to 12800 DPI, switched on or off one by
  one, and a choice of which slot is in use
- **Polling rate**: 125, 250, 500 or 1000 Hz
- **Buttons**: give each of the eight buttons a function (clicks, back and
  forward, DPI up, down and cycle, double click, rapid fire, lighting cycle,
  or disabled)

Everything is stored on the devices, so settings stay after the app is closed.

Not there yet: macros, mouse lighting.

## Download

Get `Unfoxed.exe` from the
[latest release](https://github.com/rishav00roy-web/Unfoxed/releases/latest)
and double-click it. Nothing to install; Python is not needed.

Windows may warn that the file is from an unknown publisher, because it is not
code-signed. Choose **More info**, then **Run anyway**.

Close the vendor app first. Two programs talking to the keyboard at once
confuse each other.

## Run from source

Windows, Python 3.10 or newer.

    pip install -r requirements.txt
    python app.py

Or double-click `Unfoxed.bat`.

To build the `.exe` yourself, `pip install pyinstaller` and run `build.bat`.
The result is `dist\Unfoxed.exe`.

## How it works

- `evision.py` is the driver. It speaks the Evision "V2" HID protocol on the
  receiver's vendor interface (usage page `0xFF1C`). The packet format and the
  layout of the keyboard's memory are documented at the top of the file.
- `mouse.py` is the mouse driver. It reads and writes the mouse's settings
  memory with 8-byte feature reports; the commands and the memory map are
  documented at the top of the file.
- `app.py` serves the UI on a loopback-only port and opens it in a native window.
- `ui/` is the interface. `ui/effects.js` holds the preview simulations.
- `layout.json` maps each key to its position and LED slot.

The effect previews are reconstructions. The firmware cannot be read, so each
one is rebuilt from the effect's name and controls. They show what a setting
does; they are not a frame-accurate copy of the keyboard.

## Credits

The protocol was worked out with the help of the
[OpenRGB](https://gitlab.com/CalcProgrammer1/OpenRGB) project's Evision
keyboard notes, plus probing this keyboard directly.
