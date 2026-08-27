; OLKIL Windows installer chrome.
; Bundled into Setup.exe only — never into the IDE.
; Silent `/S --updated` from electron-updater still skips every wizard page.

!ifndef MUI_BGCOLOR
  !define MUI_BGCOLOR "0A0A0A"
!endif
!ifndef MUI_TEXTCOLOR
  !define MUI_TEXTCOLOR "FFFFFF"
!endif
!ifndef MUI_INSTFILESPAGE_COLORS
  !define MUI_INSTFILESPAGE_COLORS "FFFFFF 0A0A0A"
!endif
!ifndef MUI_INSTFILESPAGE_PROGRESSBAR
  !define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"
!endif
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "Are you sure you want to quit OLKIL Setup?"
!define MUI_UNABORTWARNING

!ifndef MUI_WELCOMEPAGE_TITLE
  !define MUI_WELCOMEPAGE_TITLE "Welcome to OLKIL"
!endif
!ifndef MUI_WELCOMEPAGE_TEXT
  !define MUI_WELCOMEPAGE_TEXT "The AI-powered IDE.$\r$\n$\r$\nSetup installs OLKIL for your Windows account only. Click Next to continue."
!endif
!ifndef MUI_FINISHPAGE_TITLE
  !define MUI_FINISHPAGE_TITLE "OLKIL is ready"
!endif
!ifndef MUI_FINISHPAGE_TEXT
  !define MUI_FINISHPAGE_TEXT "Installation is complete.$\r$\n$\r$\nClick Finish to open OLKIL and start building."
!endif
!ifndef MUI_FINISHPAGE_RUN_TEXT
  !define MUI_FINISHPAGE_RUN_TEXT "Open OLKIL"
!endif
!define MUI_FINISHPAGE_NOREBOOTSUPPORT
!define MUI_FINISHPAGE_NOAUTOCLOSE
!ifndef MUI_UNWELCOMEPAGE_TITLE
  !define MUI_UNWELCOMEPAGE_TITLE "Uninstall OLKIL"
!endif
!ifndef MUI_UNFINISHPAGE_TITLE
  !define MUI_UNFINISHPAGE_TITLE "OLKIL has been removed"
!endif

!macro customWelcomePage
  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_WELCOME
!macroend

; Skip per-user / all-users page. Same mode as the old one-click setup.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Always (re)write Start Menu + Desktop shortcuts and App Paths so Search / Apps
; keep finding OLKIL even if a previous install skipped them (KeepShortcuts).
!macro customInstall
  SetShellVarContext current
  StrCmp $appExe "" 0 +2
  StrCpy $appExe "$INSTDIR\OLKIL.exe"
  CreateDirectory "$SMPROGRAMS"
  CreateShortCut "$SMPROGRAMS\OLKIL.lnk" "$appExe" "" "$appExe" 0 "" "" "OLKIL AI Code Editor"
  CreateShortCut "$DESKTOP\OLKIL.lnk" "$appExe" "" "$appExe" 0 "" "" "OLKIL AI Code Editor"
  WinShell::SetLnkAUMI "$SMPROGRAMS\OLKIL.lnk" "${APP_ID}"
  WinShell::SetLnkAUMI "$DESKTOP\OLKIL.lnk" "${APP_ID}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\OLKIL.exe" "" "$appExe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\OLKIL.exe" "Path" "$INSTDIR"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

; During auto-update the default uninstaller deletes $INSTDIR first. If the new
; Setup.exe is then blocked (SmartScreen / AV), OLKIL vanishes from Apps + Search.
; Keep files on --updated so a failed silent install cannot wipe the app.
!macro customRemoveFiles
  ${ifNot} ${isUpdated}
    RMDir /r $INSTDIR
  ${endIf}
!macroend
