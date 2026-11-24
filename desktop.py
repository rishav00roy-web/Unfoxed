"""Windows desktop pieces: one running copy, the tray icon, start with Windows."""

import ctypes
import os
import sys
import winreg
from ctypes import wintypes
from pathlib import Path

APP_NAME = "Unfoxed"
WINDOW_TITLE = "Unfoxed"
MUTEX_NAME = "Local\\UnfoxedSingleInstance"
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
ERROR_ALREADY_EXISTS = 183
SW_SHOW = 5
SW_RESTORE = 9

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
kernel32.CreateMutexW.restype = wintypes.HANDLE
user32.FindWindowW.restype = wintypes.HWND

_mutex = None


def claim_single_instance():
    """True if this is the only copy running. Otherwise bring the open copy forward."""
    global _mutex
    _mutex = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if kernel32.GetLastError() != ERROR_ALREADY_EXISTS:
        return True
    show_existing_window()
    return False


def show_existing_window():
    hwnd = user32.FindWindowW(None, WINDOW_TITLE)
    if hwnd:
        user32.ShowWindow(hwnd, SW_SHOW)
        user32.ShowWindow(hwnd, SW_RESTORE)
        user32.SetForegroundWindow(hwnd)


# ---- start with Windows ----------------------------------------------------

def launch_command():
    """The command Windows runs at sign-in: start hidden, in the tray."""
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}" --tray'
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    exe = pythonw if pythonw.exists() else Path(sys.executable)
    script = Path(__file__).resolve().with_name("app.py")
    return f'"{exe}" "{script}" --tray'


def starts_with_windows():
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            value, _ = winreg.QueryValueEx(key, APP_NAME)
            return bool(value)
    except OSError:
        return False


def set_start_with_windows(on):
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
        if on:
            winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, launch_command())
        else:
            try:
                winreg.DeleteValue(key, APP_NAME)
            except FileNotFoundError:
                pass


# ---- tray icon ----------------------------------------------------------------

def start_tray(icon_path, on_open, on_quit):
    """Show the tray icon. Returns the pystray icon, or None if pystray is missing."""
    try:
        import pystray
        from PIL import Image
    except ImportError:
        return None

    def toggle_start(icon, item):
        set_start_with_windows(not starts_with_windows())

    menu = pystray.Menu(
        pystray.MenuItem("Open Unfoxed", lambda icon, item: on_open(), default=True),
        pystray.MenuItem("Start with Windows", toggle_start, checked=lambda item: starts_with_windows()),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", lambda icon, item: on_quit()),
    )
    image = Image.open(icon_path) if os.path.exists(icon_path) else Image.new("RGB", (64, 64), (255, 139, 61))
    icon = pystray.Icon(APP_NAME, image, APP_NAME, menu)
    icon.run_detached()
    return icon
