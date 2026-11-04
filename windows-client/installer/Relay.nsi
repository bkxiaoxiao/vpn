Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!ifndef APP_DIR
 !error "APP_DIR is required"
!endif
!ifndef OUT_FILE
 !error "OUT_FILE is required"
!endif
!ifndef UNINSTALL_MANIFEST
 !error "UNINSTALL_MANIFEST is required"
!endif
Name "Relay 企业连接"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Relay Enterprise"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ManifestDPIAware true
BrandingText "Relay Enterprise 0.1.2"
VIProductVersion "0.1.2.0"
VIAddVersionKey /LANG=2052 "ProductName" "Relay 企业连接"
VIAddVersionKey /LANG=2052 "FileDescription" "Relay Enterprise Windows 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "0.1.2"
VIAddVersionKey /LANG=2052 "LegalCopyright" "Relay Enterprise contributors"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\RelayEnterprise.exe"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
Function .onInit
 SetShellVarContext current
 SetRegView 64
 ${IfNot} ${RunningX64}
  MessageBox MB_ICONSTOP "此安装包需要 Windows x64。"
  Abort
 ${EndIf}
 ${IfNot} ${AtLeastWin10}
  MessageBox MB_ICONSTOP "此安装包需要 Windows 10 或更新系统。"
  Abort
 ${EndIf}
 check_running:
 FindWindow $0 "" "Relay 企业连接"
 StrCmp $0 0 ready
 MessageBox MB_RETRYCANCEL|MB_ICONINFORMATION "请先退出 Relay 企业连接，等待系统代理恢复后再继续安装。" IDRETRY check_running
 Abort
 ready:
FunctionEnd
Section "Relay 企业连接"
 SetOutPath "$INSTDIR"
 File /r "${APP_DIR}/*"
 WriteUninstaller "$INSTDIR\Uninstall.exe"
 WriteRegStr HKCU "Software\Classes\relay-enterprise" "" "URL:Relay Enterprise Login"
 WriteRegStr HKCU "Software\Classes\relay-enterprise" "URL Protocol" ""
 WriteRegStr HKCU "Software\Classes\relay-enterprise\shell\open\command" "" '$\"$INSTDIR\RelayEnterprise.exe$\" $\"%1$\"'
 CreateDirectory "$SMPROGRAMS\Relay Enterprise"
 CreateShortcut "$SMPROGRAMS\Relay Enterprise\Relay 企业连接.lnk" "$INSTDIR\RelayEnterprise.exe"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayEnterprise" "DisplayName" "Relay 企业连接"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayEnterprise" "DisplayVersion" "0.1.2"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayEnterprise" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayEnterprise" "InstallLocation" "$INSTDIR"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayEnterprise" "DisplayIcon" "$INSTDIR\RelayEnterprise.exe"
 WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayEnterprise" "NoModify" 1
 WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayEnterprise" "NoRepair" 1
SectionEnd
Function un.onInit
 SetShellVarContext current
 SetRegView 64
 check_running:
 FindWindow $0 "" "Relay 企业连接"
 StrCmp $0 0 ready
 MessageBox MB_RETRYCANCEL|MB_ICONINFORMATION "请先退出 Relay，等待系统代理恢复后再卸载。" IDRETRY check_running
 Abort
 ready:
FunctionEnd
Section "Uninstall"
 ReadRegStr $0 HKCU "Software\Classes\relay-enterprise\shell\open\command" ""
 StrCmp $0 '$\"$INSTDIR\RelayEnterprise.exe$\" $\"%1$\"' 0 keep_protocol
 DeleteRegKey HKCU "Software\Classes\relay-enterprise"
 keep_protocol:
 DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayEnterprise"
 Delete "$SMPROGRAMS\Relay Enterprise\Relay 企业连接.lnk"
 RMDir "$SMPROGRAMS\Relay Enterprise"
 !include "${UNINSTALL_MANIFEST}"
 ; Keep user settings and any crash-recovery record for a future reinstall.
SectionEnd
