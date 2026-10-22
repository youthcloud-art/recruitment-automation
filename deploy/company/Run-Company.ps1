[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$InstallRoot)
. (Join-Path $PSScriptRoot 'Common.ps1')
$config = Read-CompanyConfig $InstallRoot
$control = Join-Path $InstallRoot 'control'
$runtimeLock = [IO.File]::Open((Join-Path $control 'runtime.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
$children = @()
$exitStatus = 0
try {
    if (Test-Path -LiteralPath (Join-Path $control 'stop.request')) { exit 0 }
    $pointer = Get-Content -LiteralPath (Join-Path $control 'current-release.json') -Raw | ConvertFrom-Json
    $release = Assert-ChildPath (Join-Path $InstallRoot 'releases') ([string]$pointer.root)
    Assert-CompanyPortsFree -BackendPort $config.backendPort
    $definitions = @(Get-CompanyRuntimeDefinitions $config $release)
    foreach ($definition in $definitions) {
        $children += Start-CompanyChild $config $definition
        Write-JsonFile (Join-Path $control 'processes.json') @{release=$release; children=$children}
    }
    while (-not (Test-Path -LiteralPath (Join-Path $control 'stop.request'))) {
        foreach ($record in $children) {
            if (-not (Get-VerifiedChild $record)) { throw 'A company application process exited. Check the server logs.' }
        }
        Start-Sleep -Seconds 2
    }
} catch {
    $exitStatus = 1
    [Console]::Error.WriteLine($_.Exception.Message)
} finally {
    foreach ($record in $children) { try { Stop-VerifiedChild $record } catch { Write-Warning $_.Exception.Message } }
    $runtimeLock.Dispose()
}
exit $exitStatus
