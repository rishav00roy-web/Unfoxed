@echo off
rem Builds dist\Unfoxed.exe: one file, no Python needed to run it.
rem Needs: pip install -r requirements.txt pyinstaller
cd /d "%~dp0"
python -m PyInstaller --noconfirm --clean --onefile --windowed --name Unfoxed ^
  --icon assets\icon.ico ^
  --add-data "ui;ui" --add-data "layout.json;." ^
  app.py
