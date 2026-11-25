; NodeGSM installer: extra "Data folder" page (shown after the install-folder page).
; The choice is stored in %APPDATA%\NodeGSM\data-location.txt - the same file Settings -> Data location writes
; (see src/main/dataLocation.js). Nothing is written when the default is kept, and the page is skipped on silent
; installs and when a data folder was already chosen (re-installs / updates keep it).
!include MUI2.nsh
!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
Var NodeGSMDataDir
Var NodeGSMDataText
Var NodeGSMDataChosen
!endif

!macro customPageAfterChangeDir
  Page custom NodeGSMDataPageCreate NodeGSMDataPageLeave
!macroend

!ifndef BUILD_UNINSTALLER
Function NodeGSMDataPageCreate
  ${If} ${Silent}
    Abort
  ${EndIf}
  IfFileExists "$APPDATA\NodeGSM\data-location.txt" 0 +2
    Abort
  ; default = what NodeGSM would use anyway (an existing folder from an earlier build wins)
  StrCpy $NodeGSMDataDir "$APPDATA\NodeGSM"
  IfFileExists "$APPDATA\node-wgsm2026\WGSM\*.*" 0 +2
    StrCpy $NodeGSMDataDir "$APPDATA\node-wgsm2026\WGSM"
  StrCpy $NodeGSMDataChosen ""

  !insertmacro MUI_HEADER_TEXT "Data folder" "Where should NodeGSM keep your servers, backups and settings?"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 36u "Game servers can be several GB each. Choose a folder on a drive with enough free space. You can change it later in NodeGSM under Settings -> Data location (the data is copied for you)."
  Pop $0
  ${NSD_CreateText} 0 44u 75% 12u "$NodeGSMDataDir"
  Pop $NodeGSMDataText
  ${NSD_CreateButton} 77% 43u 23% 14u "Browse..."
  Pop $1
  ${NSD_OnClick} $1 NodeGSMDataBrowse
  nsDialogs::Show
FunctionEnd

Function NodeGSMDataBrowse
  nsDialogs::SelectFolderDialog "Choose the NodeGSM data folder" "$NodeGSMDataDir"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $NodeGSMDataText $0
  ${EndIf}
FunctionEnd

Function NodeGSMDataPageLeave
  ${NSD_GetText} $NodeGSMDataText $0
  StrLen $2 $0
  ${If} $2 > 3
    StrCpy $1 $0 1 -1
    ${If} $1 == "\"
      IntOp $2 $2 - 1
      StrCpy $0 $0 $2
    ${EndIf}
  ${EndIf}
  StrCpy $1 $0 1 1
  StrCpy $3 $0 2
  ${If} $1 != ":"
  ${AndIf} $3 != "\\"
    MessageBox MB_ICONEXCLAMATION|MB_OK "Please enter a full folder path, for example D:\NodeGSM-data."
    Abort
  ${EndIf}
  ${If} $0 == $NodeGSMDataDir
    StrCpy $NodeGSMDataChosen ""
  ${Else}
    StrCpy $NodeGSMDataChosen $0
  ${EndIf}
FunctionEnd

!endif

!macro customInstall
  ${If} $NodeGSMDataChosen != ""
    CreateDirectory "$NodeGSMDataChosen"
    CreateDirectory "$APPDATA\NodeGSM"
    FileOpen $0 "$APPDATA\NodeGSM\data-location.txt" w
    FileWrite $0 "$NodeGSMDataChosen$\r$\n"
    FileClose $0
  ${EndIf}
!macroend
