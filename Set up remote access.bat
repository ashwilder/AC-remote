@echo off
rem Lets you control the AC from outside home, privately, using Tailscale.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\remote-access.ps1"
