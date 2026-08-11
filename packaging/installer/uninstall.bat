@echo off
rem ============================================================
rem  DockerManager 一键卸载脚本
rem  功能：停止并删除 Windows 服务、移除快捷方式
rem  用法：右键"以管理员身份运行"本脚本
rem ============================================================
setlocal enabledelayedexpansion

net session >nul 2>&1
if errorlevel 1 (
    echo [错误] 请以管理员身份运行本脚本！
    pause
    exit /b 1
)

set "INSTALL_DIR=%~dp0"
set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"
set "SERVICE_NAME=DockerManager"
set "NSSM=%INSTALL_DIR%\nssm.exe"
set "PORT=9528"

echo ============================================
echo   DockerManager 卸载程序
echo ============================================

rem 停止并删除服务
if exist "%NSSM%" (
    echo [1/3] 正在停止服务...
    "%NSSM%" stop %SERVICE_NAME% >nul 2>&1
    echo [2/3] 正在删除服务...
    "%NSSM%" remove %SERVICE_NAME% confirm >nul 2>&1
) else (
    echo [1/3] 未找到 nssm.exe，尝试用 sc 删除服务...
    sc stop %SERVICE_NAME% >nul 2>&1
    sc delete %SERVICE_NAME% >nul 2>&1
)

echo [3/3] 正在清理快捷方式...

rem 移除开始菜单快捷方式
powershell -NoProfile -Command "Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'DockerManager.lnk') -Force -ErrorAction SilentlyContinue"

rem 移除托盘开机自启
powershell -NoProfile -Command "Remove-Item (Join-Path ([Environment]::GetFolderPath('Startup')) 'DockerManagerTray.lnk') -Force -ErrorAction SilentlyContinue"

rem 结束托盘进程
taskkill /f /im TrayApp.exe >nul 2>&1

echo.
echo 卸载完成。服务已移除，程序文件保留在：%INSTALL_DIR%
echo 如需彻底删除，可手动删除该目录。
pause
endlocal
