@echo off
rem ---------------------------------------------------------------
rem  Start the desktop pet.  Just double-click this file.
rem
rem  This is only a thin wrapper: the real logic lives in
rem  scripts\pet-ctl.ps1.  Why a .cmd wrapper: double-clicking a
rem  .ps1 does not run it (execution policy), a .cmd does.
rem
rem  NOTE: keep this file ASCII-only.  cmd.exe mis-parses multi-byte
rem  characters inside rem lines and the file blows up with
rem  "'---' is not recognized as an internal or external command".
rem  All the Chinese messages live in pet-ctl.ps1 instead.
rem ---------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0"

where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "scripts\pet-ctl.ps1" start %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\pet-ctl.ps1" start %*
)

rem Keep the window open on failure so the error is readable.
if errorlevel 1 pause
