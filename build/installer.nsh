!include LogicLib.nsh

!macro customInit
  Var /GLOBAL VCRedistDownload
  Var /GLOBAL VCRedistName

  ${If} ${RunningX64}
    SetRegView 64
    ReadRegDWORD $R0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
    SetRegView lastused
    IntCmp $R0 1 VSRedistInstalled

    StrCpy $VCRedistName "Microsoft Visual C++ Redistributable 2015-2022 x64"
    StrCpy $VCRedistDownload "https://aka.ms/vs/17/release/vc_redist.x64.exe"
  ${Else}
    SetRegView 32
    ReadRegDWORD $R0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x86" "Installed"
    SetRegView lastused
    IntCmp $R0 1 VSRedistInstalled

    StrCpy $VCRedistName "Microsoft Visual C++ Redistributable 2015-2022 x86"
    StrCpy $VCRedistDownload "https://aka.ms/vs/17/release/vc_redist.x86.exe"
  ${EndIf}

  MessageBox MB_YESNO "This application may require$\r$\n\
    '$VCRedistName'$\r$\n\
    to run native input hooks properly.$\r$\n$\r$\n\
    Download and install now?" /SD IDYES IDNO VSRedistInstalled

  CreateDirectory $TEMP\mvpp-2026-setup
  inetc::get "$VCRedistDownload" $TEMP\mvpp-2026-setup\vcppredist.exe
  ExecWait "$TEMP\mvpp-2026-setup\vcppredist.exe"

  VSRedistInstalled:
!macroend
