@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==========================================
echo   Update album: encrypt photos - build - push
echo ==========================================
echo.
call npm run album:deploy
if errorlevel 1 goto fail
echo.
echo Done. https://themarter.github.io/album/  (live in about one minute)
goto end
:fail
echo.
echo Failed. Read the message above.
:end
echo.
pause
