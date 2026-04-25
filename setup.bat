@echo off
echo ============================================
echo  VaultX Casino Backend - Setup
echo ============================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

echo [1/3] Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)

if not exist .env (
    echo [2/3] Creating .env from template...
    copy .env.example .env
    echo.
    echo  !! IMPORTANT: Edit casino-backend\.env before going live !!
    echo  !! Set your crypto private keys, API keys, and secrets   !!
    echo.
) else (
    echo [2/3] .env already exists, skipping.
)

echo [3/3] Starting server...
echo.
echo  Casino will be available at: http://localhost:3001
echo  Open games.html or visit http://localhost:3001
echo.
node server.js
pause
