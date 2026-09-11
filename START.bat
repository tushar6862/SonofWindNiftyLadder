@echo off
setlocal EnableExtensions
title SonOfWind Nifty Ladder
cd /d "%~dp0"

set "PATH=%ProgramFiles%\nodejs;%LocalAppData%\Programs\nodejs;%APPDATA%\npm;%PATH%"
set "BACKEND_DIR=%~dp0backend"
set "VENV_PY=%BACKEND_DIR%\.venv\Scripts\python.exe"
set "FRONTEND_URL=http://127.0.0.1:5174"

echo.
echo  ========================================
echo   SonOfWind Nifty Ladder
echo   Backend  http://127.0.0.1:5000
echo   Frontend http://127.0.0.1:5174
echo  ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js nahi mila. https://nodejs.org se install karo.
  pause
  exit /b 1
)

where pnpm >nul 2>&1
if errorlevel 1 (
  echo [INFO] pnpm nahi mila, globally install kar raha hoon...
  call npm install -g pnpm
  if errorlevel 1 (
    echo [ERROR] pnpm install fail ho gaya.
    pause
    exit /b 1
  )
)

if not exist "node_modules\" (
  echo [INFO] Frontend packages install ho rahe hain...
  call pnpm install
  if errorlevel 1 (
    echo [INFO] esbuild build approve karke retry...
    call pnpm approve-builds esbuild --all
    call pnpm install
  )
  if errorlevel 1 (
    echo [ERROR] pnpm install fail ho gaya.
    pause
    exit /b 1
  )
)

if not exist "%VENV_PY%" (
  echo [INFO] Python venv bana raha hoon...
  py -3 -m venv "%BACKEND_DIR%\.venv"
  if errorlevel 1 python -m venv "%BACKEND_DIR%\.venv"
  if not exist "%VENV_PY%" (
    echo [ERROR] Python venv nahi bana. Python 3 install karo.
    pause
    exit /b 1
  )
  echo [INFO] Backend packages install ho rahe hain...
  "%VENV_PY%" -m pip install --upgrade pip
  "%VENV_PY%" -m pip install -r "%BACKEND_DIR%\requirements.txt"
  if errorlevel 1 (
    echo [ERROR] pip install fail ho gaya.
    pause
    exit /b 1
  )
)

echo.
echo [START] Backend window khul raha hai...
start "SonOfWind Backend" /D "%BACKEND_DIR%" cmd /k ".venv\Scripts\python.exe app.py"

echo [START] Frontend window khul raha hai...
start "SonOfWind Frontend" /D "%~dp0" cmd /k "pnpm dev"

echo [INFO] Browser 5 second mein khulega: %FRONTEND_URL%
timeout /t 5 /nobreak >nul
start "" "%FRONTEND_URL%"

echo.
echo Dono chal rahe hain. Windows band karne se servers stop ho jayenge.
echo Is window ko band kar sakte ho.
echo.
pause
endlocal
