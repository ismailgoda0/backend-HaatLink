@echo off
setlocal
cd /d "%~dp0"

if not exist "src\cloudflare\worker.ts" (
  echo ERROR: Run this BAT from the backend repository root.
  pause
  exit /b 1
)

copy /Y "worker.ts" "src\cloudflare\worker.ts" >nul
if errorlevel 1 (
  echo ERROR: Failed to update src\cloudflare\worker.ts
  pause
  exit /b 1
)

echo.
echo CORS/session Worker patch applied.
echo.
echo Next:
echo   git add src/cloudflare/worker.ts
echo   git commit -m "fix: harden worker cors and session errors"
echo   git push origin main
echo.
echo Then wait for Cloudflare to deploy and test:
echo   https://backend-haatlink.ismailgoda0.workers.dev/api/cors-debug
echo.
pause
