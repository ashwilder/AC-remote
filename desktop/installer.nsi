; AC Remote installer for Windows 10/11 (64-bit).
; Built by desktop/build.sh with: makensis -DVERSION=x.y.z -DSRC=<win-unpacked> -DOUT=<setup.exe> -DRES=<desktop folder>
Unicode true
SetCompressor /SOLID lzma
ManifestDPIAware true

!define APPNAME "AC Remote"
!define EXE "AC Remote.exe"
!define APPID "com.vpn.acremote"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ACRemote"

Name "${APPNAME}"
OutFile "${OUT}"
InstallDir "$PROGRAMFILES64\AC Remote"
InstallDirRegKey HKLM "Software\ACRemote" "InstallDir"
RequestExecutionLevel admin
BrandingText "AC Remote ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "AC Remote"
VIAddVersionKey "FileDescription" "AC Remote installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "AC Remote"
VIAddVersionKey "LegalCopyright" ""

!include "MUI2.nsh"
!include "x64.nsh"
!define MUI_ICON "${RES}\icon.ico"
!define MUI_UNICON "${RES}\icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Install AC Remote"
!define MUI_WELCOMEPAGE_TEXT "AC Remote lets you control your air conditioner from this PC and your phone.$\r$\n$\r$\nIt runs quietly in the system tray and starts with Windows, so presets, timers and your phone keep working.$\r$\n$\r$\nClick Next to continue."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Open AC Remote now"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "AC Remote needs 64-bit Windows 10 or 11."
    Abort
  ${EndIf}
  SetRegView 64
FunctionEnd

Section "AC Remote" SecMain
  SectionIn RO
  ; Close a running copy so its files can be replaced.
  nsExec::Exec 'taskkill /IM "${EXE}" /F'
  Sleep 1500

  SetOutPath "$INSTDIR"
  ; Replace the program files completely on upgrade (your settings live in %LOCALAPPDATA%\ACRemote and are kept).
  RMDir /r "$INSTDIR\resources"
  File /r "${SRC}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall AC Remote.exe"

  SetShellVarContext all
  CreateDirectory "$SMPROGRAMS\AC Remote"
  CreateShortCut "$SMPROGRAMS\AC Remote\AC Remote.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  CreateShortCut "$SMPROGRAMS\AC Remote\Set up remote access.lnk" "powershell.exe" '-NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\app\scripts\remote-access.ps1"' "$INSTDIR\${EXE}" 0
  CreateShortCut "$SMPROGRAMS\AC Remote\Uninstall AC Remote.lnk" "$INSTDIR\Uninstall AC Remote.exe"
  CreateShortCut "$DESKTOP\AC Remote.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0

  ; Let your phone and the AC reach AC Remote on home (private) networks only.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="AC Remote"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="AC Remote" dir=in action=allow program="$INSTDIR\${EXE}" profile=private,domain enable=yes'

  ; Retire the older script-based AC Remote if it was installed, so the two don't compete for the same port.
  nsExec::Exec '"powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\app\scripts\retire-old.ps1"'

  ; Apps & features entry
  WriteRegStr HKLM "Software\ACRemote" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "AC Remote"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "AC Remote"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall AC Remote.exe"'
  WriteRegStr HKLM "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall AC Remote.exe" /S'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "EstimatedSize" 260000
SectionEnd

Section "Uninstall"
  SetRegView 64
  nsExec::Exec 'taskkill /IM "${EXE}" /F'
  Sleep 1500
  nsExec::Exec 'netsh advfirewall firewall delete rule name="AC Remote"'
  ; Stop starting with Windows (the app registers itself under its app ID).
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APPID}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AC Remote"
  SetShellVarContext all
  RMDir /r "$SMPROGRAMS\AC Remote"
  Delete "$DESKTOP\AC Remote.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "${UNINST_KEY}"
  DeleteRegKey HKLM "Software\ACRemote"
  ; Your PIN, paired ACs, presets and MirAIe link stay in %LOCALAPPDATA%\ACRemote, so a reinstall picks up where you left off.
SectionEnd
