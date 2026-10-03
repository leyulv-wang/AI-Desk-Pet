@echo off
rem ---------------------------------------------------------------
rem  Stop the desktop pet.  Just double-click this file.
rem
rem  Takes down the pet AND the GPT-SoVITS voice server it started
rem  (that one holds ~2.9 GB of VRAM, so leaving it behind is what
rem  makes people ask "why is my VRAM still full after closing?").
rem
rem  Started the voice server yourself and want to keep it?
rem    scripts\pet-ctl.ps1 stop -KeepVoice
rem
rem  NOTE: keep this file ASCII-only -- see the comment in the
rem  start script (pet-ctl.ps1) for why.
rem ---------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0"

where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "scripts\pet-ctl.ps1" stop %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\pet-ctl.ps1" stop %*
)

if errorlevel 1 pause
