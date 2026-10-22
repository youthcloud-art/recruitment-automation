[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path,
    [string]$Branch = 'main',
    [ValidateRange(0,1800)][int]$MirrorWaitSeconds = 600
)
. (Join-Path $PSScriptRoot 'Common.ps1')
$RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$git = (Get-Command git.exe -ErrorAction Stop).Source
Invoke-Checked $git @('-C',$RepositoryRoot,'diff','--exit-code')
Invoke-Checked $git @('-C',$RepositoryRoot,'diff','--cached','--exit-code')
$untracked = @(& $git -C $RepositoryRoot ls-files --others --exclude-standard)
if ($LASTEXITCODE -ne 0 -or $untracked.Count -gt 0) { throw 'Review and commit the exact release first. This publisher never stages files automatically.' }
$tracked = @(& $git -C $RepositoryRoot ls-files)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect tracked release files.' }
$forbidden = @($tracked | Where-Object { $_ -match '(^|/)(\.local|node_modules|storage|uploads|talent-data|private|logs)(/|$)|(^|/)\.env($|\.(?!example$))|\.sqlite3?($|-)' })
if ($forbidden.Count -gt 0) { throw ('Persistent/private files must not enter the release repository: ' + ($forbidden -join ', ')) }
Invoke-Checked $git @('-C',$RepositoryRoot,'push','origin',('HEAD:' + $Branch))
$commit = (& $git -C $RepositoryRoot rev-parse HEAD).Trim()
$deadline = [datetime]::UtcNow.AddSeconds($MirrorWaitSeconds)
$mirrorUrl = 'https://gitee.com/felixshe/auto-recru-company.git'
$previousGitPrompt = [Environment]::GetEnvironmentVariable('GIT_TERMINAL_PROMPT','Process')
$previousCredentialPrompt = [Environment]::GetEnvironmentVariable('GCM_INTERACTIVE','Process')
try {
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'Never'
do {
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $remote = @(& $git -c credential.interactive=false -c http.lowSpeedTime=15 -c http.lowSpeedLimit=1 ls-remote $mirrorUrl ('refs/heads/' + $Branch) 2>$null)
        if ($LASTEXITCODE -eq 0 -and $remote.Count -gt 0 -and $remote[0].StartsWith($commit + "`t")) {
            Write-Host "PUBLISHED_AND_MIRRORED: $commit. The company server checks Gitee every five minutes."
            exit 0
        }
    } finally { $ErrorActionPreference = $savedPreference }
    if ([datetime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Seconds 10
} while ($true)
throw "GitHub contains $commit, but the Gitee mirror has not yet been verified at the same commit. Check Gitee mirror status; the commit was preserved."
} finally {
    [Environment]::SetEnvironmentVariable('GIT_TERMINAL_PROMPT',$previousGitPrompt,'Process')
    [Environment]::SetEnvironmentVariable('GCM_INTERACTIVE',$previousCredentialPrompt,'Process')
}
