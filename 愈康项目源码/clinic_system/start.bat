@echo off
title YuKang Cloud Clinic System
cd /d "%~dp0"

:: ================================================
::  端口配置：以后改端口只改这里一个地方
:: ================================================
set PORT=3002
set "YUKONG_APP_DIR=%~dp0"
:: ================================================

echo ========================================
echo     YuKang Cloud Clinic - Quick Start
echo ========================================
echo.

:: Use bundled portable Node.js
set "NODE_EXE=%~dp0node\node.exe"
set "NPM_CMD=%~dp0node\npm.cmd"

:: 1. Check bundled node.exe
echo [1/4] Checking bundled Node.js...
if not exist "%NODE_EXE%" (
    echo   [FAIL] node.exe not found in node\ folder!
    echo   Please ensure the node folder is included.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('"%NODE_EXE%" -v') do set NODE_VER=%%i
echo   [OK] Node.js version: %NODE_VER%
echo.

:: 2. Check and prepare dependencies
echo [2/4] Checking dependencies...

set "DEPS_DIR=D:\CodexApps\YuKangClinicDeps"

:: Prefer the D-drive runtime so installs never grow on C drive.
set "DEPS_OK=1"
for %%D in (express cors qrcode xlsx @fortawesome\fontawesome-free) do (
    if not exist "%DEPS_DIR%\node_modules\%%D\package.json" set "DEPS_OK=0"
)
if "%DEPS_OK%"=="1" goto dependencies_from_d

echo   D drive runtime is incomplete. Checking bundled local dependencies...
set "DEPS_OK=1"
for %%D in (express cors qrcode xlsx @fortawesome\fontawesome-free) do (
    if not exist "node_modules\%%D\package.json" set "DEPS_OK=0"
)
if "%DEPS_OK%"=="1" goto dependencies_local

echo   Installing missing runtime dependencies to D drive...
set "INSTALL_NPM=%NPM_CMD%"
if not exist "%INSTALL_NPM%" set "INSTALL_NPM=npm"
call "%INSTALL_NPM%" install --prefix "%DEPS_DIR%" --omit=dev --no-audit --no-fund --no-package-lock express@4.21.2 cors@2.8.5 qrcode@1.5.4 xlsx@0.18.5 @fortawesome/fontawesome-free@6.7.2
if errorlevel 1 goto dependencies_fail

:dependencies_from_d
set "DEPS_OK=1"
for %%D in (express cors qrcode xlsx @fortawesome\fontawesome-free) do (
    if not exist "%DEPS_DIR%\node_modules\%%D\package.json" set "DEPS_OK=0"
)
if "%DEPS_OK%"=="0" goto dependencies_fail

set "NODE_PATH=%DEPS_DIR%\node_modules"
set "YUKONG_VENDOR_DIR=%DEPS_DIR%\node_modules"
echo   [OK] D drive runtime dependencies ready
goto dependencies_ready

:dependencies_local
echo   [OK] Bundled local dependencies ready
goto dependencies_ready

:dependencies_fail
echo   [FAIL] Missing runtime dependencies or npm is unavailable.
echo   Please check D:\CodexApps\YuKangClinicDeps and the system npm command.
echo.
pause
exit /b 1

:dependencies_ready
echo   [OK] Dependencies ready
echo.

:: 3. Init data directory
echo [3/4] Initializing data directory...
if not exist "clinic_database" (
    mkdir clinic_database
    echo   [OK] Created: clinic_database\
) else (
    echo   [OK] Data directory exists
)
echo.

:: 4. Start server
echo [4/4] Starting server...
echo.
echo ========================================
echo   电脑本机访问: http://localhost:%PORT%
echo   手机扫码访问: 登录后在系统设置里查看
echo ========================================
echo.
echo   浏览器将自动打开（防缓存模式）
echo   按 Ctrl+C 停止服务器
echo.

:: Optional local RAG worker. Node falls back to keyword retrieval if unavailable.
if exist "D:\CodexEnvs\yukang-rag\Scripts\python.exe" (
    start "YuKang Local RAG" /min cmd /c "%~dp0start_rag.bat"
)

:: Browser opens from server.js only after the HTTP listener is ready.
"%NODE_EXE%" --disable-warning=ExperimentalWarning server.js

echo.
echo Server stopped.
pause