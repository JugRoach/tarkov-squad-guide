; Installer hooks for Tarkov Planner.
;
; The product was renamed from "Tarkov Guide" -> "Tarkov Planner" in an earlier
; release. NSIS keys its uninstall registry entry, install directory, and
; shortcuts on the product name, so renamed installs look like a brand-new app
; to NSIS. Result: users who installed the old name end up with two parallel
; installs and keep launching the old, stale binary via their original
; shortcut while the updater faithfully installs new versions into the new
; folder they never open.
;
; This pre-install hook detects the legacy install and silently removes it
; before laying down the new one, so the update path self-heals.

!include "LogicLib.nsh"

!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Tarkov Guide" "UninstallString"
  ${If} $R0 != ""
    DetailPrint "Removing legacy Tarkov Guide install..."
    ExecWait '$R0 /S'
    RMDir /r "$LOCALAPPDATA\Tarkov Guide"
    Delete "$DESKTOP\Tarkov Guide.lnk"
    Delete "$SMPROGRAMS\Tarkov Guide.lnk"
  ${EndIf}
!macroend
