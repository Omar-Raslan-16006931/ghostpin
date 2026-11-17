@echo off
cd /d "%~dp0"
py -3 -m pip install -q -r requirements.txt
py -3 ghostpin.py
