@echo off
cd /d "%~dp0"
echo Starting Sector8 online server...
echo.
node server.js
echo.
echo Server stopped. Press any key to close.
pause > nul
