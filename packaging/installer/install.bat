@echo off
rem ============================================================
rem  DockerManager install batch (ASCII-safe to avoid encoding issues)
rem  Registers Windows service, auto-start, shortcuts and tray
rem  Run as Administrator (right click -> Run as administrator)
rem ============================================================
setlocal enabledelayedexpansion

rem Check for administrator rights
net session >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Please run this script as Administrator.
    pause
    exit /b 1
)

rem Install dir = directory of this script
set "INSTALL_DIR=%~dp0"
set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"

set "SERVICE_NAME=DockerManager"
set "NODE_EXE=node.exe"
set "SERVER_DIR=%INSTALL_DIR%\server"
set "APP_DIR=%SERVER_DIR%"
set "NSSM=%INSTALL_DIR%\nssm.exe"
set "LOG_DIR=%INSTALL_DIR%\logs"
set "STATIC_DIR=%INSTALL_DIR%\static"
set "PORT=9528"

echo ============================================
echo   DockerManager install
echo   Install dir : %INSTALL_DIR%
echo   Service     : %SERVICE_NAME%
echo   Web port    : %PORT%
echo ============================================

rem Verify required files
if not exist "%NSSM%" ( echo [ERROR] nssm.exe missing & pause & exit /b 1 )
if not exist "%SERVER_DIR%\dist\index.js" ( echo [ERROR] backend dist\index.js missing & pause & exit /b 1 )
if not exist "%STATIC_DIR%\index.html" ( echo [ERROR] frontend static\index.html missing & pause & exit /b 1 )

rem Create log dir
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

rem Remove any existing service first
"%NSSM%" stop %SERVICE_NAME% >nul 2>&1
"%NSSM%" remove %SERVICE_NAME% confirm >nul 2>&1

echo.
echo [1/4] Registering Windows service...

rem Register service: node.exe dist\index.js
"%NSSM%" install %SERVICE_NAME% "%NODE_EXE%" "dist\index.js"
if errorlevel 1 ( echo [ERROR] service register failed & pause & exit /b 1 )

rem Set working directory
"%NSSM%" set %SERVICE_NAME% AppDirectory "%APP_DIR%"

rem System data dir (writable path, in case install dir is Program Files)
set "DATA_DIR=%PROGRAMDATA%\DockerManager\data"
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"

rem Set user env (production mode, port, static dir, data dir)
"%NSSM%" set %SERVICE_NAME% AppEnvironmentExtra "NODE_ENV=production" "PORT=%PORT%" "STATIC_DIR=%STATIC_DIR%" "DOCKERMANAGER_DATA=%DATA_DIR%"

rem Auto restart on abnormal exit
"%NSSM%" set %SERVICE_NAME% AppExit Default Restart
"%NSSM%" set %SERVICE_NAME% AppRestartDelay 5000

rem Log redirection
"%NSSM%" set %SERVICE_NAME% AppStdout "%LOG_DIR%\service.log"
"%NSSM%" set %SERVICE_NAME% AppStderr "%LOG_DIR%\service-error.log"
"%NSSM%" set %SERVICE_NAME% AppRotateFiles 1
"%NSSM%" set %SERVICE_NAME% AppRotateOnline 1
"%NSSM%" set %SERVICE_NAME% AppRotateBytes 10485760

rem Description and auto start
"%NSSM%" set %SERVICE_NAME% Description "Docker management panel backend (http://localhost:%PORT%/)"
"%NSSM%" set %SERVICE_NAME% Start SERVICE_AUTO_START

echo [2/4] Starting service...
"%NSSM%" start %SERVICE_NAME%
if errorlevel 1 ( echo [ERROR] service start failed, check logs & pause & exit /b 1 )

echo [3/4] Creating shortcuts...
rem Start menu shortcut (web panel)
set "SHORTCUT_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs"
if not exist "%SHORTCUT_DIR%" mkdir "%SHORTCUT_DIR%"
powershell -NoProfile -Command "$sh=$env:APPDATA+'\Microsoft\Windows\Start Menu\Programs\DockerManager.lnk';$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut($sh);$s.TargetPath='http://localhost:%PORT%/';$s.Save()"

rem Startup shortcut (tray autostart)
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
if not exist "%STARTUP_DIR%" mkdir "%STARTUP_DIR%"
if exist "%INSTALL_DIR%\TrayApp.exe" (
    powershell -NoProfile -Command "$sh=Join-Path ([Environment]::GetFolderPath('Startup')) 'DockerManagerTray.lnk';$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut($sh);$s.TargetPath='%INSTALL_DIR%\TrayApp.exe';$s.WorkingDirectory='%INSTALL_DIR%';$s.Save()"
    echo       Tray autostart enabled
)

echo [4/4] Starting tray application (system tray icon)...
if exist "%INSTALL_DIR%\TrayApp.exe" start "" "%INSTALL_DIR%\TrayApp.exe"

echo.
echo ============================================
echo   Install success
echo   Service   : %SERVICE_NAME%  (auto start)
echo   Web panel : http://localhost:%PORT%/
echo   Tray icon : on system tray
echo ============================================
pause
endlocal
