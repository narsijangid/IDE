; OLKIL installer chrome only. Bundled into Setup.exe, never into the IDE app.
; Keep /S silent so electron-updater quitAndInstall still works.

!define MUI_BGCOLOR "0A0A0A"
!define MUI_TEXTCOLOR "FFFFFF"
!define MUI_INSTFILESPAGE_COLORS "FFFFFF 0A0A0A"
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "Are you sure you want to quit OLKIL Setup?"
!define MUI_UNABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "Welcome to OLKIL"
!define MUI_WELCOMEPAGE_TEXT "The AI-powered IDE.$\r$\n$\r$\nSetup installs OLKIL for your Windows account only. Click Next to continue."
!define MUI_FINISHPAGE_TITLE "OLKIL is ready"
!define MUI_FINISHPAGE_TEXT "Installation is complete. Open OLKIL and start building."
!define MUI_FINISHPAGE_RUN_TEXT "Open OLKIL"
!define MUI_UNWELCOMEPAGE_TITLE "Uninstall OLKIL"
!define MUI_UNFINISHPAGE_TITLE "OLKIL has been removed"

; Welcome is skipped on silent / in-app updates (--updated).
!macro customWelcomePage
  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_WELCOME
!macroend

; Skip the per-user / all-users page. Same install mode as the old one-click setup.
!macro customInstallmode
  StrCpy $isForceCurrentInstall "1"
!macroend
