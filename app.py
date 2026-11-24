"""Unfoxed: a small local app for the EvoFox Ronin Wireless keyboard and Blaze 2 mouse.

Runs a loopback-only HTTP server that serves the UI and talks to the devices,
then shows the UI in a native window.

    python app.py            open the app window
    python app.py --serve    server only (open the printed address in a browser)
"""

import argparse
import json
import secrets
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import desktop
import evision
import live
import mouse
from evision import DeviceError
from mouse import MouseError

# Packaged as a single .exe, the bundled files are unpacked to sys._MEIPASS.
ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
UI = ROOT / "ui"
STATIC = {
    "/theme.css": "text/css",
    "/app.css": "text/css",
    "/app.js": "text/javascript",
    "/effects.js": "text/javascript",
    "/mouse.js": "text/javascript",
    "/keys.js": "text/javascript",
    "/live.js": "text/javascript",
}

LAYOUT = json.loads((ROOT / "layout.json").read_text(encoding="utf-8"))
REMAP_SLOTS = {key["slot"] for key in LAYOUT["keys"]} | {extra["slot"] for extra in LAYOUT["extras"]}

kb = evision.Keyboard()
ms = mouse.Mouse()
engine = live.LiveEngine(kb, ms, LAYOUT)
MOUSE_OPTIONS = {
    "dpi": mouse.DPI_VALUES,
    "polling": sorted(mouse.POLLING_BYTE),
    "functions": [[code, name] for code, name in mouse.FUNCTIONS.items()],
    "light_effects": mouse.LIGHT_EFFECTS,
    "light_speed_max": mouse.LIGHT_TIME_MAX,
    "brightness_max": mouse.BRIGHTNESS_MAX,
}
TOKEN = secrets.token_urlsafe(24)
preview_on = threading.Event()


def read_state():
    try:
        kb.connect()
        profile = kb.get_profile()
        return {
            "connected": True,
            "profile": profile,
            "lighting": kb.get_lighting(profile),
        }
    except DeviceError as exc:
        return {"connected": False, "error": str(exc)}


def read_mouse():
    try:
        ms.connect()
        state = ms.get_state()
        state["connected"] = True
    except MouseError as exc:
        state = {"connected": False, "error": str(exc)}
    state["options"] = MOUSE_OPTIONS
    return state


def clean_mouse(body):
    out = {}
    if body.get("dpi") is not None:
        out["dpi"] = [int(v) for v in body["dpi"]]
    if body.get("enabled") is not None:
        out["enabled"] = [bool(v) for v in body["enabled"]]
    if body.get("current") is not None:
        out["current"] = int(body["current"])
    if body.get("polling") is not None:
        out["polling"] = int(body["polling"])
    if body.get("buttons") is not None:
        out["buttons"] = [int(v) for v in body["buttons"]]
    for key in ("palette", "dpi_colours"):
        if body.get(key) is not None:
            out[key] = body[key]
    for key in ("light_effect", "light_speed", "light_brightness"):
        if body.get(key) is not None:
            out[key] = int(body[key])
    return out


def read_keymap():
    kb.connect()
    profile = kb.get_profile()
    return {"profile": profile, "keys": kb.get_keymap(profile)}


def clean_keys(body):
    changes = {}
    for slot, code in dict(body["changes"]).items():
        slot, code = int(slot), int(code)
        if slot not in REMAP_SLOTS:
            raise ValueError("That key cannot be changed")
        if not 0 <= code <= 0xFFFFFF or code >> 16 not in (0x20, 0x30):
            raise ValueError("Unsupported key function")
        changes[slot] = code
    return changes


def end_preview():
    if preview_on.is_set():
        preview_on.clear()
        try:
            kb.direct_end()
        except DeviceError:
            pass


def clean_colors(value):
    if not isinstance(value, list) or len(value) > 256:
        raise ValueError("colors must be a list")
    return [[int(c) & 0xFF for c in rgb[:3]] for rgb in value]


def clean_lighting(body):
    color = body.get("color", [255, 255, 255])
    cfg = {
        "mode": int(body["mode"]),
        "brightness": int(body["brightness"]),
        "speed": int(body["speed"]),
        "direction": int(body["direction"]),
        "random": bool(body["random"]),
        "color": [int(c) & 0xFF for c in color[:3]],
    }
    if "ledmode" in body:
        cfg["ledmode"] = int(body["ledmode"])
    if "custom_set" in body:
        cfg["custom_set"] = int(body["custom_set"])
    return cfg


class Handler(BaseHTTPRequestHandler):
    server_version = "Unfoxed"

    def log_message(self, *args):
        pass

    # ---- plumbing ---------------------------------------------------------

    def _send(self, status, body, ctype="application/json"):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", f"{ctype}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _local(self):
        port = self.server.server_address[1]
        return self.headers.get("Host", "") in (f"127.0.0.1:{port}", f"localhost:{port}")

    def _authorised(self):
        return secrets.compare_digest(self.headers.get("X-Token", ""), TOKEN)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 1_000_000:
            raise ValueError("request too large")
        return json.loads(self.rfile.read(length) or b"{}")

    # ---- routes -----------------------------------------------------------

    def do_GET(self):
        if not self._local():
            return self._send(403, {"error": "forbidden"})
        url = urlparse(self.path)
        if url.path in ("/", "/index.html"):
            page = (UI / "index.html").read_text(encoding="utf-8").replace("{{TOKEN}}", TOKEN)
            return self._send(200, page.encode("utf-8"), "text/html")
        if url.path in STATIC:
            return self._send(200, (UI / url.path[1:]).read_bytes(), STATIC[url.path])
        if not url.path.startswith("/api/"):
            return self._send(404, {"error": "not found"})
        if not self._authorised():
            return self._send(403, {"error": "forbidden"})
        try:
            if url.path == "/api/live":
                return self._send(200, engine.state())
            if url.path == "/api/state":
                return self._send(200, read_state())
            if url.path == "/api/mouse":
                return self._send(200, read_mouse())
            if url.path == "/api/keymap":
                return self._send(200, read_keymap())
            if url.path == "/api/layout":
                return self._send(200, (ROOT / "layout.json").read_bytes())
            if url.path == "/api/custom":
                index = int(parse_qs(url.query).get("set", ["0"])[0])
                if not 0 <= index < evision.CUSTOM_SETS:
                    raise ValueError("set out of range")
                kb.connect()
                return self._send(200, {"set": index, "colors": kb.get_custom(index)})
        except (DeviceError, MouseError) as exc:
            return self._send(503, {"error": str(exc)})
        except (ValueError, KeyError, TypeError) as exc:
            return self._send(400, {"error": str(exc)})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._local() or not self._authorised():
            return self._send(403, {"error": "forbidden"})
        try:
            body = self._body()
            if self.path == "/api/mouse":
                ms.connect()
                ms.apply(**clean_mouse(body))
                return self._send(200, read_mouse())
            kb.connect()
            if self.path == "/api/keymap":
                kb.set_keys(kb.get_profile(), clean_keys(body))
                return self._send(200, read_keymap())
            if self.path == "/api/live":
                changes = {k: body[k] for k in ("effect", "base", "accent", "rainbow", "mouse_follows", "brightness") if k in body}
                for key in ("base", "accent"):
                    if key in changes:
                        changes[key] = [int(c) & 0xFF for c in changes[key][:3]]
                engine.configure(changes)
                return self._send(200, engine.state())
            if self.path == "/api/profile":
                end_preview()
                kb.set_profile(int(body["profile"]))
                return self._send(200, read_state())
            if self.path == "/api/lighting":
                end_preview()
                kb.set_lighting(kb.get_profile(), clean_lighting(body))
                return self._send(200, read_state())
            if self.path == "/api/custom":
                index = int(body["set"])
                if not 0 <= index < evision.CUSTOM_SETS:
                    raise ValueError("set out of range")
                kb.set_custom(index, clean_colors(body["colors"]))
                profile = kb.get_profile()
                cfg = kb.get_lighting(profile)
                cfg["mode"] = evision.MODE_CUSTOM
                cfg["custom_set"] = index
                if cfg["brightness"] == 0:
                    cfg["brightness"] = evision.BRIGHTNESS_MAX
                cfg.pop("ledmode", None)
                kb.set_lighting(profile, cfg)
                end_preview()
                return self._send(200, read_state())
            if self.path == "/api/preview":
                engine.stop()             # painting takes over the keys while it runs
                kb.direct(clean_colors(body["colors"]))
                preview_on.set()
                return self._send(200, {"ok": True})
            if self.path == "/api/preview/end":
                end_preview()
                return self._send(200, {"ok": True})
        except (DeviceError, MouseError) as exc:
            return self._send(503, {"error": str(exc)})
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            return self._send(400, {"error": str(exc)})
        return self._send(404, {"error": "not found"})


def say(text):
    """Print, unless there is no console (the packaged app has none)."""
    if sys.stdout is not None:
        print(text, flush=True)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run_window(webview, url, start_hidden):
    """The app window. Closing it hides it to the tray; Quit in the tray ends the app."""
    window = webview.create_window(desktop.WINDOW_TITLE, url, width=1160, height=860,
                                   min_size=(760, 600), background_color="#111213",
                                   hidden=start_hidden)
    quitting = threading.Event()

    def on_open():
        window.show()
        window.restore()

    def on_quit():
        quitting.set()
        if tray:
            tray.stop()
        window.destroy()

    tray = desktop.start_tray(str(ROOT / "assets" / "icon.png"), on_open, on_quit)

    def on_closing():
        if tray and not quitting.is_set():
            window.hide()
            return False            # keep running in the tray
        return True

    window.events.closing += on_closing
    webview.start()
    if tray:
        tray.stop()


def main():
    ap = argparse.ArgumentParser(description="Unfoxed")
    ap.add_argument("--serve", action="store_true", help="run the server without opening a window")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--tray", action="store_true", help="start hidden in the tray")
    args = ap.parse_args()

    if not args.serve and not desktop.claim_single_instance():
        return 0

    if engine.settings["effect"]:
        engine.start()            # carry on with the live effect from last time

    port = args.port or free_port()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    url = f"http://127.0.0.1:{port}/"

    try:
        if args.serve:
            say(f"Unfoxed running at {url}")
            server.serve_forever()
        else:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                import webview
            except ImportError:
                import webbrowser
                webbrowser.open(url)
                say(f"Unfoxed running at {url} (close this window to quit)")
                threading.Event().wait()
            else:
                run_window(webview, url, start_hidden=args.tray)
    except KeyboardInterrupt:
        pass
    finally:
        engine.stop()
        end_preview()
        kb.close()
        ms.close()
        server.server_close()


if __name__ == "__main__":
    sys.exit(main())
