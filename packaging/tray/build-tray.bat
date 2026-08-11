@echo off
rem ============================================================
rem 编译 DockemberManager 系统托盘程序
rem 输出: packaging\tray\TrayApp.exe
rem ============================================================
setlocal

set "CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
set "SRC=%~dp0TrayApp.cs"
set "OUT=%~dp0TrayApp.exe"

if not exist "%CSC%" (
    echo [ERROR] 未找到 C# 编译器: %CSC%
    exit /b 1
)

echo 正在编译托盘程序...
"%CSC%" /nologo /target:winexe /out:"%OUT%" /r:System.Windows.Forms.dll /r:System.Drawing.dll "%SRC%"

if exist "%OUT%" (
    echo [OK] 托盘程序已生成: %OUT%
    exit /b 0
) else (
    echo [ERROR] 托盘程序编译失败
    exit /b 1
)
