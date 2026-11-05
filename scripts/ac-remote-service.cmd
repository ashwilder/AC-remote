@echo off
rem Keeps AC Remote running: restarts it if it ever stops. Output goes to the log file.
setlocal
cd /d "%~dp0.."
set "LOGDIR=%LOCALAPPDATA%\ACRemote"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
:loop
echo [%date% %time%] starting AC Remote>> "%LOGDIR%\ac-remote.log"
node src\server.mjs >> "%LOGDIR%\ac-remote.log" 2>&1
echo [%date% %time%] AC Remote stopped (code %errorlevel%), restarting in 5 seconds>> "%LOGDIR%\ac-remote.log"
timeout /t 5 /nobreak > nul
goto loop
