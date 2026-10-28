[CmdletBinding()]
param(
    [string]$InstallRoot = 'D:\App\SXF\Smart-Recruitment-Agent',
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if ($InstallRoot -ine 'D:\App\SXF\Smart-Recruitment-Agent') { throw 'Use the reviewed company installation root.' }
. (Join-Path $InstallRoot 'delivery\Common.ps1')
$config = Read-CompanyConfig $InstallRoot
if ($config.companyHost -cne '192.168.1.24' -or -not (Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -eq '192.168.1.24')) { throw 'Cleanup must run on the reviewed company server.' }
$locks = [Collections.Generic.List[IO.FileStream]]::new()
try {
    foreach ($name in @('sync.lock','switch.lock','cleanup.lock','maintenance-install.lock')) {
        try { $locks.Add([IO.File]::Open((Join-Path $InstallRoot ('control\' + $name)), 'OpenOrCreate', 'ReadWrite', 'None')) }
        catch [IO.IOException] { Write-Host 'SKIPPED_BUSY: deployment, export or another cleanup is running.'; exit 0 }
    }
    $processRoots = [Collections.Generic.List[string]]::new()
    $pattern = '(?i)' + [regex]::Escape((Join-Path $InstallRoot 'releases\')) + '\d{8}-\d{6}-[a-f0-9]{12}-[a-f0-9]{6}'
    foreach ($process in Get-CimInstance Win32_Process) {
        foreach ($match in [regex]::Matches([string]$process.CommandLine, $pattern)) {
            if (-not $processRoots.Contains($match.Value)) { $processRoots.Add($match.Value) }
        }
    }
    $encodedRoots = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($processRoots.ToArray()) -Compress)))
    $mode = if ($Apply) {'--apply'} else {'--preview'}
    & $config.nodePath (Join-Path $PSScriptRoot 'cleanup-engine.cjs') $InstallRoot $mode $encodedRoots
    if ($LASTEXITCODE -ne 0) { throw 'Cleanup stopped; review delivery\last-cleanup.json. No application service was stopped.' }
} finally {
    for ($index=$locks.Count-1; $index -ge 0; $index--) { $locks[$index].Dispose() }
}
