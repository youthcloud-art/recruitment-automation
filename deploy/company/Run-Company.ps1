[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$InstallRoot)
. (Join-Path $PSScriptRoot 'Common.ps1')
$config = Read-CompanyConfig $InstallRoot
$control = Join-Path $InstallRoot 'control'
$runtimeLock = [IO.File]::Open((Join-Path $control 'runtime.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
$children = @()
$exitStatus = 0
$unverifiedChecks = @{}
$release = ''
try {
    if (Test-Path -LiteralPath (Join-Path $control 'stop.request')) { exit 0 }
    $pointer = Get-Content -LiteralPath (Join-Path $control 'current-release.json') -Raw | ConvertFrom-Json
    $release = Assert-ChildPath (Join-Path $InstallRoot 'releases') ([string]$pointer.root)
    Assert-CompanyPortsFree -BackendPort $config.backendPort -GatewayPort $config.gatewayPort
    $definitions = @(Get-CompanyRuntimeDefinitions $config $release)
    foreach ($definition in $definitions) {
        $children += Start-CompanyChild $config $definition
        Write-JsonFile (Join-Path $control 'processes.json') @{release=$release; children=$children}
    }
    while (-not (Test-Path -LiteralPath (Join-Path $control 'stop.request'))) {
        foreach ($record in $children) {
            $key = [string]$record.pid
            if (Get-VerifiedChild $record) {
                $unverifiedChecks[$key] = 0
                continue
            }
            # CIM may miss one snapshot while Chrome or OCR loads the server.
            # Require three consecutive failed identity checks before stopping
            # both application children. A real exit is still detected in 4 s.
            $unverifiedChecks[$key] = [int]$unverifiedChecks[$key] + 1
            if ($unverifiedChecks[$key] -ge 3) {
                throw "Company application child $key failed three identity checks. Check archived server logs."
            }
        }
        Start-Sleep -Seconds 2
    }
} catch {
    $exitStatus = 1
    [Console]::Error.WriteLine($_.Exception.Message)
    try {
        Write-JsonFile (Join-Path $control 'runtime-failure.json') @{
            timeUtc=[datetime]::UtcNow.ToString('o')
            reason=$_.Exception.Message
            release=$release
        }
    } catch { [Console]::Error.WriteLine('Could not write runtime-failure.json') }
} finally {
    foreach ($record in $children) { try { Stop-VerifiedChild $record } catch { Write-Warning $_.Exception.Message } }
    $runtimeLock.Dispose()
}
exit $exitStatus
