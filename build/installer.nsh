!include "FileFunc.nsh"
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "StrFunc.nsh"
!include "WinVer.nsh"
!include "x64.nsh"

!ifndef BUILD_UNINSTALLER

!define ZSENSE_INSTALL_FOLDER "ZSense"

${StrStr}

Var ZSensePreflightDialog
Var ZSensePreflightStatus
Var ZSensePreflightFailed
Var ZSensePreflightDetails

Function ZSenseEnsureInstallDirectory
  ${GetFileName} "$INSTDIR" $0
  ${If} $0 != "${ZSENSE_INSTALL_FOLDER}"
    StrCpy $INSTDIR "$INSTDIR\${ZSENSE_INSTALL_FOLDER}"
  ${EndIf}
FunctionEnd

Function ZSenseRunPreflight
  StrCpy $ZSensePreflightFailed "0"
  StrCpy $ZSensePreflightDetails "√ 最终安装目录：$INSTDIR$\r$\n"

  ${If} ${AtLeastWin10}
    StrCpy $ZSensePreflightDetails "$ZSensePreflightDetails√ Windows 10 / 11：支持$\r$\n"
  ${Else}
    StrCpy $ZSensePreflightFailed "1"
    StrCpy $ZSensePreflightDetails "$ZSensePreflightDetails× 系统版本：需要 64 位 Windows 10 或 Windows 11$\r$\n"
  ${EndIf}

  ${If} ${RunningX64}
    StrCpy $ZSensePreflightDetails "$ZSensePreflightDetails√ 处理器架构：64 位$\r$\n"
  ${Else}
    StrCpy $ZSensePreflightFailed "1"
    StrCpy $ZSensePreflightDetails "$ZSensePreflightDetails× 处理器架构：当前安装包只支持 64 位 Windows$\r$\n"
  ${EndIf}

  StrCpy $ZSensePreflightDetails "$ZSensePreflightDetails√ Agent Core：已内置，无需下载独立运行时$\r$\n"

  ${GetRoot} "$INSTDIR" $0
  ${DriveSpace} "$0" "/D=F /S=M" $1
  ${If} $1 == ""
    StrCpy $ZSensePreflightFailed "1"
    StrCpy $ZSensePreflightDetails "$ZSensePreflightDetails× 磁盘空间：无法读取安装盘可用空间$\r$\n"
  ${ElseIf} $1 < 3072
    StrCpy $ZSensePreflightFailed "1"
    StrCpy $ZSensePreflightDetails "$ZSensePreflightDetails× 磁盘空间：剩余 $1 MB，完整离线安装至少需要 3072 MB$\r$\n"
  ${Else}
    StrCpy $ZSensePreflightDetails "$ZSensePreflightDetails√ 磁盘空间：剩余 $1 MB$\r$\n"
  ${EndIf}

  ClearErrors
  CreateDirectory "$APPDATA\ZSense"
  FileOpen $2 "$APPDATA\ZSense\.installer-write-test" w
  ${If} ${Errors}
    StrCpy $ZSensePreflightFailed "1"
    StrCpy $ZSensePreflightDetails "$ZSensePreflightDetails× 私有数据目录：$APPDATA\ZSense 不可写$\r$\n"
  ${Else}
    FileWrite $2 "ZSense installer preflight"
    FileClose $2
    Delete "$APPDATA\ZSense\.installer-write-test"
    StrCpy $ZSensePreflightDetails "$ZSensePreflightDetails√ 私有数据目录：可写$\r$\n"
  ${EndIf}

  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq ${APP_FILENAME}.exe" /NH /FO CSV'
  Pop $3
  Pop $4
  ${StrStr} $5 $4 '"${APP_FILENAME}.exe"'
  ${If} $5 != ""
    StrCpy $ZSensePreflightDetails "$ZSensePreflightDetails! ZSense 正在运行，开始安装时会先安全关闭$\r$\n"
  ${Else}
    StrCpy $ZSensePreflightDetails "$ZSensePreflightDetails√ 应用状态：可以安装$\r$\n"
  ${EndIf}

FunctionEnd

Function ZSensePreflightCreate
  Call ZSenseEnsureInstallDirectory
  Call ZSenseRunPreflight

  nsDialogs::Create 1018
  Pop $ZSensePreflightDialog
  ${If} $ZSensePreflightDialog == error
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "安装前检查" "确认 ZSense 可以在本机安全运行。"

  ${NSD_CreateLabel} 0 0 100% 12u "系统与安装位置"
  Pop $0
  CreateFont $1 "$(^Font)" "$(^FontSize)" "700"
  SendMessage $0 ${WM_SETFONT} $1 1

  ${NSD_CreateLabel} 0 16u 100% 72u "$ZSensePreflightDetails"
  Pop $ZSensePreflightStatus

  ${NSD_CreateLabel} 0 91u 100% 12u "应用内置能力"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $1 1

  ${NSD_CreateLabel} 0 107u 100% 30u "√ Agent Core    √ 消息网关    √ 本地 STT / TTS    √ Office / 钉钉 / 金山文档$\r$\n模型调用、技能、记忆、任务、文件工具与原生依赖均已离线内置。"
  Pop $0

  ${NSD_CreateLabel} 0 141u 100% 19u "ZSense 不安装 Python、Node.js、Git 或外部 Agent Runtime，也不会读取其他 Agent 的配置、密钥、会话或记忆。"
  Pop $0

  ${If} $ZSensePreflightFailed == "1"
    SetCtlColors $ZSensePreflightStatus 0xB42318 transparent
    GetDlgItem $0 $HWNDPARENT 1
    EnableWindow $0 0
  ${Else}
    SetCtlColors $ZSensePreflightStatus 0x25613B transparent
    GetDlgItem $0 $HWNDPARENT 1
    EnableWindow $0 1
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function ZSensePreflightLeave
  ${If} $ZSensePreflightFailed == "1"
    MessageBox MB_OK|MB_ICONSTOP "安装前检查未通过。请修复标记为 × 的项目后重试。"
    Abort
  ${EndIf}
FunctionEnd

!macro customInit
  ${If} ${Silent}
    Call ZSenseEnsureInstallDirectory
    Call ZSenseRunPreflight
    ${If} $ZSensePreflightFailed == "1"
      MessageBox MB_OK|MB_ICONSTOP "ZSense 安装前检查未通过，安装已停止。" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  PageEx custom
    PageCallbacks ZSensePreflightCreate ZSensePreflightLeave
  PageExEnd
!macroend

!macro customInstall
  DetailPrint "正在安装本地语音引擎所需的 Microsoft Visual C++ 运行库…"
  ExecWait '"$INSTDIR\resources\bundled-tools\redist\VC_redist.x64.exe" /install /quiet /norestart' $0
  ${If} $0 == 0
    DetailPrint "Microsoft Visual C++ 运行库已就绪。"
  ${ElseIf} $0 == 1638
    DetailPrint "检测到相同或更新版本的 Microsoft Visual C++ 运行库。"
  ${ElseIf} $0 == 3010
    DetailPrint "Microsoft Visual C++ 运行库已安装，系统稍后重启即可完成更新。"
    SetRebootFlag true
  ${Else}
    MessageBox MB_OK|MB_ICONSTOP "本地语音依赖安装失败（错误码 $0）。ZSense 安装已停止，请重新运行安装程序。"
    SetErrorLevel 3
    Abort
  ${EndIf}
!macroend

!endif

!ifdef BUILD_UNINSTALLER

Var ZSenseUninstallDataDialog
Var ZSenseKeepUserDataRadio
Var ZSenseDeleteUserDataRadio
Var ZSenseKeepUserData

Function un.ZSenseUninstallDataCreate
  nsDialogs::Create 1018
  Pop $ZSenseUninstallDataDialog
  ${If} $ZSenseUninstallDataDialog == error
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "用户数据" "选择卸载 ZSense 后如何处理本机数据。"

  ${NSD_CreateLabel} 0 0 100% 24u "程序文件将被移除。请选择是否保留配置、Bot、会话、记忆、技能和本地缓存。"
  Pop $0

  ${NSD_CreateRadioButton} 0 34u 100% 14u "保留用户数据（推荐，重新安装后可继续使用）"
  Pop $ZSenseKeepUserDataRadio

  ${NSD_CreateRadioButton} 0 60u 100% 14u "删除全部用户数据"
  Pop $ZSenseDeleteUserDataRadio

  ${NSD_CreateLabel} 18u 80u 94% 30u "删除后无法恢复。用户主动选择的外部工作区文件不会被删除。"
  Pop $0
  SetCtlColors $0 0xB42318 transparent

  ${If} $ZSenseKeepUserData == "0"
    ${NSD_Check} $ZSenseDeleteUserDataRadio
  ${Else}
    ${NSD_Check} $ZSenseKeepUserDataRadio
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function un.ZSenseUninstallDataLeave
  ${NSD_GetState} $ZSenseDeleteUserDataRadio $0
  ${If} $0 == ${BST_CHECKED}
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "确定删除 ZSense 的全部用户数据吗？配置、Bot、会话、记忆、技能和本地缓存将被永久删除，且无法恢复。" IDYES ZSenseConfirmDelete
    Abort
    ZSenseConfirmDelete:
      StrCpy $ZSenseKeepUserData "0"
  ${Else}
    StrCpy $ZSenseKeepUserData "1"
  ${EndIf}
FunctionEnd

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.ZSenseUninstallDataCreate un.ZSenseUninstallDataLeave
!macroend

!macro customUnInit
  StrCpy $ZSenseKeepUserData "1"
  ${GetParameters} $R0
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${IfNot} ${Errors}
    StrCpy $ZSenseKeepUserData "0"
  ${EndIf}
  ${GetOptions} $R0 "/KEEP_APP_DATA" $R1
  ${IfNot} ${Errors}
    StrCpy $ZSenseKeepUserData "1"
  ${EndIf}
!macroend

!macro customUnInstall
  ${If} $ZSenseKeepUserData == "0"
    ${IfNot} ${isUpdated}
      DetailPrint "正在删除 ZSense 用户数据…"
      ${If} $installMode == "all"
        SetShellVarContext current
      ${EndIf}
      RMDir /r "$APPDATA\${APP_FILENAME}"
      RMDir /r "$LOCALAPPDATA\${APP_FILENAME}"
      !ifdef APP_PRODUCT_FILENAME
        RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
        RMDir /r "$LOCALAPPDATA\${APP_PRODUCT_FILENAME}"
      !endif
      !ifdef APP_PACKAGE_NAME
        RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
        RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}"
      !endif
      ${If} $installMode == "all"
        SetShellVarContext all
      ${EndIf}
    ${EndIf}
  ${Else}
    DetailPrint "保留 ZSense 用户数据。"
  ${EndIf}
!macroend

!endif
