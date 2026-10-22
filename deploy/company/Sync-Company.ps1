[CmdletBinding()]
param([string]$InstallRoot = 'D:\App\SXF\AutoRecru')
. (Join-Path $PSScriptRoot 'Common.ps1')
$config = Read-CompanyConfig $InstallRoot
$lock = $null
$previousSsh = [Environment]::GetEnvironmentVariable('GIT_SSH_COMMAND','Process')
$source = Assert-ChildPath $InstallRoot (Join-Path $InstallRoot 'source')
try {
    try { $lock = [IO.File]::Open((Join-Path $InstallRoot 'control\sync.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { Write-Host 'SKIPPED: another mirror deployment is running.'; exit 0 }
    $knownHosts = Join-Path $InstallRoot 'delivery\known_hosts'
    $env:GIT_SSH_COMMAND = '"' + $config.sshPath + '" -i "' + $config.deployKeyPath + '" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="' + $knownHosts + '"'
    $gitArguments = @('-c', ('safe.directory=' + $source))
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        if (-not (Test-Path -LiteralPath $source)) {
            & $config.gitPath @gitArguments clone --quiet --config core.autocrlf=false --branch $config.branch $config.repositoryUrl $source
            if ($LASTEXITCODE -ne 0) { throw 'Gitee clone failed. Check the repository read-only deploy key and server connectivity.' }
        }
        $origin = (& $config.gitPath @gitArguments -C $source remote get-url origin).Trim()
        if ($LASTEXITCODE -ne 0 -or $origin -cne [string]$config.repositoryUrl) { throw 'The delivery source does not use the configured Gitee repository.' }
        $dirty = @(& $config.gitPath @gitArguments -C $source status --porcelain)
        if ($LASTEXITCODE -ne 0 -or $dirty.Count -gt 0) { throw 'The delivery source has local changes. No release was switched.' }
        & $config.gitPath @gitArguments -C $source fetch --quiet --prune origin $config.branch
        if ($LASTEXITCODE -ne 0) { throw 'Gitee fetch failed. The healthy running release was preserved.' }
        $commit = (& $config.gitPath @gitArguments -C $source rev-parse ('origin/' + $config.branch)).Trim()
        if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[a-f0-9]{40}$') { throw 'The mirror main branch was not found.' }
        $pointerPath = Join-Path $InstallRoot 'control\current-release.json'
        if (Test-Path -LiteralPath $pointerPath) {
            $current = Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json
            if ($current.commit -eq $commit) {
                Write-JsonFile (Join-Path $InstallRoot 'delivery\last-sync.json') @{ok=$true;result='up_to_date';commit=$commit;timeUtc=[datetime]::UtcNow.ToString('o')}
                exit 0
            }
        } else { throw 'The first deployment must be activated explicitly with reviewed legacy task and directory parameters.' }
        & $config.gitPath @gitArguments -C $source reset --hard $commit
        if ($LASTEXITCODE -ne 0) { throw 'The delivery checkout could not be updated.' }
    } finally { $ErrorActionPreference = $savedPreference }
    & (Join-Path $PSScriptRoot 'Prepare-Release.ps1') -InstallRoot $InstallRoot -SourceRoot $source -Commit $commit
    $prepared = Get-Content -LiteralPath (Join-Path $InstallRoot 'delivery\prepared-release.json') -Raw | ConvertFrom-Json
    & (Join-Path $PSScriptRoot 'Switch-Release.ps1') -InstallRoot $InstallRoot -ReleaseRoot $prepared.root
    Write-JsonFile (Join-Path $InstallRoot 'delivery\last-sync.json') @{ok=$true;result='deployed';commit=$commit;timeUtc=[datetime]::UtcNow.ToString('o')}
} catch {
    Write-JsonFile (Join-Path $InstallRoot 'delivery\last-sync.json') @{ok=$false;error=$_.Exception.Message;timeUtc=[datetime]::UtcNow.ToString('o')}
    throw
} finally {
    [Environment]::SetEnvironmentVariable('GIT_SSH_COMMAND',$previousSsh,'Process')
    if ($lock) { $lock.Dispose() }
}
