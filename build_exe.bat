@echo off
REM Builds dist\Ghostpin.exe  (needs Python 3.11 or 3.12 from python.org)
cd /d "%~dp0"
py -3 -m pip install -U pip
py -3 -m pip install -r requirements.txt pyinstaller
py -3 -m PyInstaller --noconfirm --clean --onefile --windowed --name Ghostpin --icon icon.ico ^
  --add-data "web;web" --hidden-import engine --hidden-import classic ^
  --collect-all pymobiledevice3 --collect-all developer_disk_image --collect-all pmd_pytcp ^
  --collect-all pmd_net_addr --collect-all pmd_net_proto --collect-all webview ^
  --collect-submodules qh3 --collect-all opack2 --collect-all pyimg4 --collect-all pytun_pmd3 --collect-all sslpsk_pmd3 ^
  --exclude-module matplotlib --exclude-module tkinter --exclude-module PyQt5 --exclude-module PyQt6 ghostpin.py
echo.
echo Done: dist\Ghostpin.exe
pause
