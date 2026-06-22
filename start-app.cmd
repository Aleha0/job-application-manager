@echo off
title Job Application Manager
rem Windows launcher: runs start-app.sh through Git Bash (double-click friendly).

set "DIR=%~dp0"
set "BASH=C:\Program Files\Git\bin\bash.exe"
if not exist "%BASH%" set "BASH=C:\Program Files (x86)\Git\bin\bash.exe"

rem Bail out with a clear message if Git Bash is missing
if not exist "%BASH%" (
  echo Git Bash was not found.
  echo Install Git for Windows: https://git-scm.com/download/win
  pause
  exit /b 1
)

"%BASH%" "%DIR%start-app.sh"
