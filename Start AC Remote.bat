@echo off
rem Starts AC Remote in the background (it also starts by itself when you sign in).
wscript.exe "%~dp0scripts\run-hidden.vbs"
timeout /t 5 /nobreak > nul
start "" http://localhost:8080
