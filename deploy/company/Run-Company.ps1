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
    Assert-CompanyPortsFree
    $definitions = @(
        @{name='backend'; script=(Join-Path $release 'backend\src\index.js'); cwd=(Join-Path $release 'backend'); env=@{HOST='127.0.0.1';PORT='5001';NODE_ENV='production';COMPANY_DEPLOYMENT='true';RECRUITMENT_ENV_FILE=(Join-Path $InstallRoot 'shared\backend.env')}},
        @{name='gateway'; script=(Join-Path $release 'deploy\company\gateway.js'); cwd=$release; env=@{COMPANY_HOST=[string]$config.companyHost;COMPANY_PORT='4000';BACKEND_PORT='5001';LAN_ALLOW_CIDRS=([string[]]$config.allowedNetworks -join ',');NODE_ENV='production'}}
    )
    foreach ($definition in $definitions) {
        $previous = @{}
        try {
            foreach ($name in $definition.env.Keys) {
                $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
                [Environment]::SetEnvironmentVariable($name, $definition.env[$name], 'Process')
            }
            $process = Start-Process -FilePath $config.nodePath -ArgumentList @('"' + $definition.script + '"') -WorkingDirectory $definition.cwd -WindowStyle Hidden -RedirectStandardOutput (Join-Path $InstallRoot ('logs\' + $definition.name + '.stdout.log')) -RedirectStandardError (Join-Path $InstallRoot ('logs\' + $definition.name + '.stderr.log')) -PassThru
            $information = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)"
            if (-not $information) { throw "$($definition.name) exited during startup." }
            $children += @{pid=$process.Id; executable=[string]$config.nodePath; script=$definition.script; createdAtUtc=$information.CreationDate.ToUniversalTime().ToString('o')}
            Write-JsonFile (Join-Path $control 'processes.json') @{release=$release; children=$children}
        } finally {
            foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
        }
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
