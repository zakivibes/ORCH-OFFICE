@echo off
cd /d "%~dp0"
title ORCH OFFICE
echo ====================================================
echo             ORCH OFFICE - Windows Baslatici
echo ====================================================
echo.
echo Dashboard baslatiliyor: http://localhost:4747
echo Tarayiciniz acilacak...
echo.

start "" "http://localhost:4747"
npm run office
pause
