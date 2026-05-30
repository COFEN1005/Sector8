@echo off
cd /d "%~dp0"
set "GIT=git -c http.sslBackend=openssl --git-dir=gitstore --work-tree=."

echo Staging changes...
%GIT% add -A

%GIT% diff --cached --quiet
if errorlevel 1 (
    echo Creating commit...
    %GIT% commit -m "Update Sector8"
) else (
    echo No file changes to commit.
)

echo Pushing to GitHub...
%GIT% push -u origin main
pause
