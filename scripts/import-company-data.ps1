[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Archive,
    [string]$ExpectedSha256,
    [switch]$InspectOnly
)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$archivePath = (Resolve-Path -LiteralPath $Archive).Path
if (-not $ExpectedSha256) {
    $checksum = $archivePath + '.sha256'
    if (-not (Test-Path -LiteralPath $checksum -PathType Leaf)) { throw 'Provide the accompanying .zip.sha256 file or -ExpectedSha256 from the server export summary.' }
    $ExpectedSha256 = ((Get-Content -LiteralPath $checksum -Raw).Trim() -split '\s+')[0]
}
if ($ExpectedSha256 -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ine $ExpectedSha256) { throw 'Incoming archive checksum mismatch.' }
$workspace = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Auto-Recru-Data-Sync'
if ($workspace.StartsWith($project + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Transfer workspace must be outside the code project.' }
$id = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6)
$incoming = Join-Path $workspace ('incoming\' + $id)
$backup = Join-Path $workspace ('backups\before-server-import-' + $id)
New-Item -ItemType Directory -Path $incoming -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    if ($zip.Entries.Count -gt 200000) { throw 'Unexpectedly large archive entry count.' }
    $seen = @{}
    foreach ($entry in $zip.Entries) {
        $name = $entry.FullName
        if ($name.Contains('\') -or $name.Contains(':') -or $name.StartsWith('/') -or $name -match '(^|/)\.\.?(/|$)') { throw 'Unsafe archive entry path.' }
        $target = [IO.Path]::GetFullPath((Join-Path $incoming $name))
        if (-not $target.StartsWith($incoming + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive entry is outside the transfer directory.' }
        if ($seen.ContainsKey($target)) { throw 'Duplicate archive entry.' }
        $seen[$target] = $true
    }
} finally { $zip.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $incoming)
$node = (Get-Command node.exe -ErrorAction Stop).Source
if ($InspectOnly) {
    & $node --no-warnings (Join-Path $PSScriptRoot 'company-data-sync.js') inspect $incoming
    if ($LASTEXITCODE -ne 0) { throw 'Snapshot compatibility or file verification failed.' }
    Write-Host "VERIFIED_SNAPSHOT: $incoming"
    exit 0
}
$control = Join-Path $project '.local'
New-Item -ItemType Directory -Path $control -Force | Out-Null
$operationLock = [IO.File]::Open((Join-Path $control 'control.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    & $node --no-warnings (Join-Path $PSScriptRoot 'company-data-sync.js') import $incoming $backup
    if ($LASTEXITCODE -ne 0) { throw 'Local data import failed. Read the diagnostic above; the local application was not started.' }
    Write-Host "LOCAL_BACKUP: $backup"
    Write-Host 'ONE_TIME_SYNC_COMPLETE: local model, mailbox and browser login settings were preserved.'
} finally { $operationLock.Dispose() }
