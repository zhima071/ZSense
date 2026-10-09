param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$LogPath
)

try {
  Wait-Process -Id $ParentPid -Timeout 180 -ErrorAction SilentlyContinue
  if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
    '等待旧版 ZSense 退出超时。' | Out-File -FilePath $LogPath -Encoding utf8
    exit 1
  }
  if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) { throw '安装包不存在。' }
  '旧版已退出，正在启动安装向导。' | Out-File -FilePath $LogPath -Encoding utf8
  $installer = Start-Process -FilePath $InstallerPath -PassThru
  $installer.WaitForExit()
  if ($installer.ExitCode -eq 0) { Remove-Item -LiteralPath $InstallerPath -Force -ErrorAction SilentlyContinue }
  "安装向导退出码：$($installer.ExitCode)" | Out-File -FilePath $LogPath -Encoding utf8 -Append
} catch {
  $_.Exception.Message | Out-File -FilePath $LogPath -Encoding utf8 -Append
  exit 1
}
