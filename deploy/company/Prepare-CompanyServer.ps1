# First-run preparation only. The existing port-4000 application stays running.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$Commit,
    [string]$InstallRoot = 'D:\App\SXF\Smart-Recruitment-Agent'
)
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Open Windows PowerShell as Administrator, then run this script again.'
}
$reportPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AutoRecru-Server-Check.json'
$report = & (Join-Path $PSScriptRoot 'Inspect-Company.ps1')
[IO.File]::WriteAllText($reportPath, ($report -join [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
Write-Host "SERVER_REPORT: $reportPath"
Write-Output $report

$inventory = ($report -join [Environment]::NewLine) | ConvertFrom-Json
if (-not (@($inventory.addresses | Where-Object { $_.IPAddress -eq '192.168.1.24' }).Count)) {
    throw 'Run this script on company server 192.168.1.24. Only the read-only report was generated.'
}
if (-not $inventory.nodePath -or -not $inventory.gitPath -or
    -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw 'Node.js 24+, npm, and Git for Windows are required. Send the server report before making further changes.'
}
$major = [int](& $inventory.nodePath -p "process.versions.node.split('.')[0]")
if ($major -lt 24) {
    throw 'The server Node.js is older than 24. Preparation stopped without changing the old application; send the server report first.'
}
$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$parameters = @{
    InitialRepositoryRoot=$source
    Commit=$Commit
    InstallRoot=$InstallRoot
    PrepareOnly=$true
}
if (Test-Path -LiteralPath (Join-Path $InstallRoot 'delivery\config.json')) { $parameters.Resume = $true }
& (Join-Path $PSScriptRoot 'Install-Company.ps1') @parameters

$publicKey = Join-Path $InstallRoot 'delivery\gitee-readonly-ed25519.pub'
Write-Host ''
Write-Host 'PREPARATION_COMPLETE: The previous port-4000 application is still running.'
Write-Host 'Send the server report and the PUBLIC key below. Never send the key file without the .pub suffix.'
Get-Content -LiteralPath $publicKey
Write-Host "SERVER_REPORT: $reportPath"
Write-Host 'Do not activate or stop the old service until its exact tasks and installation directory have been reviewed.'
