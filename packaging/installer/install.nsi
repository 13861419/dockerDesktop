; ============================================================
; DockerManager 一键安装包脚本 (NSIS)
;
; 打包: 将 dist-release/DockerManager 目录打成 setup.exe
; 编译: makensis /DRELEASE_DIR="...\dist-release\DockerManager" install.nsi
; ============================================================

Unicode true
RequestExecutionLevel admin

!define APP_NAME "DockerManager"
; 版本号默认值；build-installer.js 会通过 /DAPP_VERSION= 注入 package.json 的版本
!ifndef APP_VERSION
!define APP_VERSION "0.1.0"
!endif
!define APP_PUBLISHER "JackOS"
!define REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"

; 默认把保存安装目录放入变量后，通过环境变量 RELEASE_DIR（由 makensis -D 传入）
!ifndef RELEASE_DIR
  !define RELEASE_DIR "..\dist-release\DockerManager"
!endif

Name "${APP_NAME} ${APP_VERSION}"
OutFile "${APP_NAME}-setup-${APP_VERSION}.exe"
InstallDir "$PROGRAMFILES\${APP_NAME}"
InstallDirRegKey HKLM "${REG_KEY}" "InstallLocation"
ShowInstDetails show
ShowUninstDetails show
SetCompressor /SOLID lzma

; ---------- 页面 ----------
Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

; ---------- 安装 ----------
Section "Install"
  SectionIn RO
  ; 备份安装目录位置
  WriteRegStr HKLM "${REG_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${REG_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKLM "${REG_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKLM "${REG_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKLM "${REG_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'

  ; 释放程序文件
  SetOutPath "$INSTDIR"
  File /r "${RELEASE_DIR}\*.*"

  ; 注册服务并启动（需管理员）
  ; 注意：install.bat 是批处理，通过 cmd 调用，并以 /c 执行
  nsExec::ExecToLog 'cmd.exe /c ""$INSTDIR\install.bat""'
  Pop $0

  ; 创建开始菜单快捷方式（打开面板）
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\打开面板.lnk" "http://localhost:9528/"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\卸载${APP_NAME}.lnk" "$INSTDIR\uninstall.exe"

  ; 创建卸载程序
  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

; ---------- 卸载 ----------
Section "Uninstall"
  ; 停止并删除服务、清理快捷方式
  nsExec::ExecToLog 'cmd.exe /c ""$INSTDIR\uninstall.bat""'
  Pop $0

  ; 删除快捷方式
  RMDir /r "$SMPROGRAMS\${APP_NAME}"

  ; 删除注册表
  DeleteRegKey HKLM "${REG_KEY}"

  ; 删除程序目录（含所有文件）
  RMDir /r "$INSTDIR"
SectionEnd
