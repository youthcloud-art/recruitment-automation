# Run manually on the company server. Business data stays in backups; only the
# export summary is written to Desktop. No HTTP download endpoint is created.
[CmdletBinding()]
param([string]$InstallRoot = 'D:\App\SXF\Smart-Recruitment-Agent')
$ErrorActionPreference = 'Stop'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if ($InstallRoot -ine 'D:\App\SXF\Smart-Recruitment-Agent') { throw 'Use the reviewed company installation directory.' }
. (Join-Path $InstallRoot 'delivery\Common.ps1')
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run Export-Server-Data.cmd as Administrator.' }
$config = Read-CompanyConfig $InstallRoot
if ($config.companyHost -cne '192.168.1.24' -or -not (Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -eq '192.168.1.24')) { throw 'Run the export on company server 192.168.1.24.' }
if ($config.runAs -ine [Security.Principal.WindowsIdentity]::GetCurrent().Name) { throw 'Use the same logged-in Windows account as the running assistant.' }
$tool = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\scripts\company-data-sync.js')).Path
$reportPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AutoRecru-Data-Export-Result.json'
$report = @{ok=$false;timeUtc=[datetime]::UtcNow.ToString('o');installRoot=$InstallRoot}
$syncLock = $null
$restart = $false
$syncWasEnabled = $false
$syncChanged = $false
$runtimeRestored = $false
$runtimeStopRequested = $false
try {
    $syncLock = [IO.File]::Open((Join-Path $InstallRoot 'control\sync.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $sync = Get-ScheduledTask -TaskName $config.syncTask -ErrorAction Stop
    $runtime = Get-ScheduledTask -TaskName $config.runtimeTask -ErrorAction Stop
    $restart = [string]$runtime.State -eq 'Running'
    if ($restart) {
        $status = Get-CompanyResponseText ('http://' + $config.companyHost + ':' + $config.gatewayPort + '/api/browser-console/status') | ConvertFrom-Json
        if (-not $status.success -or @($status.data.platforms | Where-Object running).Count -gt 0) { throw 'A recruitment collection is active or its state cannot be verified. Finish or pause collection, then export again.' }
    }
    $syncWasEnabled = [string]$sync.State -ne 'Disabled'
    if ($syncWasEnabled) { Disable-ScheduledTask -TaskName $config.syncTask | Out-Null; $syncChanged = $true }
    $exportRoot = Assert-ChildPath $InstallRoot (Join-Path $InstallRoot ('backups\data-export-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6)))
    New-Item -ItemType Directory -Path $exportRoot | Out-Null
    $snapshot = Join-Path $exportRoot 'snapshot'
    if ($restart) { $runtimeStopRequested = $true; Stop-CompanyRuntime $config }
    Assert-CompanyPortsFree -BackendPort $config.backendPort -GatewayPort $config.gatewayPort
    Write-Host 'Creating a consistent business-data snapshot. Credentials and browser logins are excluded.'
    $summary = & $config.nodePath --no-warnings $tool export $InstallRoot $snapshot
    if ($LASTEXITCODE -ne 0) { throw 'Business-data export failed. Preserve the export directory and see the error above.' }
    $summary = ($summary -join [Environment]::NewLine) | ConvertFrom-Json
    # Resume as soon as the consistent copy exists; ZIP compression happens online.
    if ($restart) {
        Start-CompanyRuntime $config
        Wait-CompanyHealth ('http://' + $config.companyHost + ':' + $config.gatewayPort + '/healthz')
        $runtimeRestored = $true
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Add-Type -AssemblyName System.IO.Compression
    $archive = Join-Path $exportRoot ('AutoRecru-Server-Data-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
    $stream = [IO.File]::Open($archive, 'CreateNew', 'ReadWrite', 'None')
    try {
        $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
        try {
            foreach ($file in Get-ChildItem -LiteralPath $snapshot -Recurse -Force -File) {
                $relative = $file.FullName.Substring($snapshot.TrimEnd('\').Length + 1).Replace('\','/')
                [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $relative, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
            }
        } finally { $zip.Dispose() }
    } finally { $stream.Dispose() }
    $sha = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText(($archive + '.sha256'), ($sha + '  ' + [IO.Path]::GetFileName($archive) + "`r`n"), [Text.Encoding]::ASCII)
    $report.ok = $true
    $report.archive = $archive
    $report.sha256 = $sha
    $report.count = $summary.count
    $report.bytes = $summary.bytes
    $report.serverCommit = $summary.serverCommit
    Write-Host "DATA_EXPORT_COMPLETE: $archive"
    Write-Host 'Copy this ZIP and its .sha256 file to your local Downloads folder using Remote Desktop.'
} catch {
    $report.error = $_.Exception.Message
    throw
} finally {
    try {
        if ($runtimeStopRequested -and -not $runtimeRestored -and $syncLock) {
            Start-CompanyRuntime $config
            Wait-CompanyHealth ('http://' + $config.companyHost + ':' + $config.gatewayPort + '/healthz')
            $runtimeRestored = $true
        }
    } catch { $report.runtimeRecoveryError = $_.Exception.Message; $report.ok = $false; Write-Warning $_.Exception.Message }
    try { if ($syncChanged -and $syncWasEnabled) { Enable-ScheduledTask -TaskName $config.syncTask | Out-Null } }
    catch { $report.mirrorRecoveryError = $_.Exception.Message; $report.ok = $false; Write-Warning $_.Exception.Message }
    if ($syncLock) { $syncLock.Dispose() }
    $report.runtimeResumed = $runtimeRestored
    $report.timeUtc = [datetime]::UtcNow.ToString('o')
    Write-JsonFile $reportPath $report
    Write-Host "EXPORT_REPORT: $reportPath"
}
