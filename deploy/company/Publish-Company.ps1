[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path,
    [string]$Branch = 'main',
    [switch]$RequireNativeMirror,
    [ValidateRange(0,1800)][int]$MirrorWaitSeconds = 600
)
. (Join-Path $PSScriptRoot 'Common.ps1')
$RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$git = (Get-Command git.exe -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
$mirrorUrl = 'https://gitee.com/felixshe/auto-recru-company.git'
$previousGitPrompt = [Environment]::GetEnvironmentVariable('GIT_TERMINAL_PROMPT','Process')
$previousCredentialPrompt = [Environment]::GetEnvironmentVariable('GCM_INTERACTIVE','Process')
function Invoke-PublishGit([string[]]$GitArguments) {
    $savedPreference = $ErrorActionPreference
    try {
        # Git progress is stderr even on success in Windows PowerShell 5.1.
        $ErrorActionPreference = 'Continue'
        & $git -c credential.interactive=false -c http.lowSpeedTime=15 -c http.lowSpeedLimit=1 @GitArguments
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
    if ($code -ne 0) { throw "Git publication command failed (exit $code). No history was force-pushed." }
}
function Get-PublishedCommit([string]$Remote) {
    $rows = @(Invoke-PublishGit @('-C',$RepositoryRoot,'ls-remote',$Remote,('refs/heads/' + $Branch)))
    if ($rows.Count -eq 0) { return '' }
    $match = [regex]::Match([string]$rows[0], '^([a-f0-9]{40})\s+refs/heads/')
    if (-not $match.Success) { throw 'Could not verify the published branch commit.' }
    return $match.Groups[1].Value
}
try {
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'Never'
    Invoke-PublishGit @('-C',$RepositoryRoot,'diff','--exit-code')
    Invoke-PublishGit @('-C',$RepositoryRoot,'diff','--cached','--exit-code')
    $untracked = @(Invoke-PublishGit @('-C',$RepositoryRoot,'ls-files','--others','--exclude-standard'))
    if ($untracked.Count -gt 0) { throw 'Review and commit the exact release first; the publisher never stages files.' }
    Push-Location $RepositoryRoot
    try { Invoke-Checked $node @('scripts\audit-release.js','--index') } finally { Pop-Location }
    $commit = ([string](Invoke-PublishGit @('-C',$RepositoryRoot,'rev-parse','HEAD'))).Trim()
    # GitHub is always first; verify its remote commit before writing Gitee.
    Invoke-PublishGit @('-C',$RepositoryRoot,'push','origin',('HEAD:' + $Branch))
    if ((Get-PublishedCommit 'origin') -cne $commit) { throw 'GitHub has not been verified at the release commit; Gitee was not pushed.' }
    $deadline = [datetime]::UtcNow.AddSeconds($MirrorWaitSeconds)
    do {
        if ((Get-PublishedCommit $mirrorUrl) -ceq $commit) {
            Write-Host "PUBLISHED_AND_MIRRORED: $commit. GitHub and Gitee are verified at the same commit."
            exit 0
        }
        if (-not $RequireNativeMirror) {
            # Private Gitee mirrors can reject native callbacks. Use existing
            # developer Git credentials; never copy passwords to the server.
            Invoke-PublishGit @('-C',$RepositoryRoot,'push',$mirrorUrl,('HEAD:' + $Branch))
            if ((Get-PublishedCommit $mirrorUrl) -cne $commit) { throw 'Gitee synchronization did not verify; the GitHub commit is preserved.' }
            Write-Host "PUBLISHED_AND_MIRRORED: $commit. The publisher synchronized Gitee after verifying GitHub."
            exit 0
        }
        if ([datetime]::UtcNow -ge $deadline) { break }
        Start-Sleep -Seconds 10
    } while ($true)
    throw "GitHub contains $commit, but the native Gitee mirror has not reached it. No server deployment was reported."
} finally {
    [Environment]::SetEnvironmentVariable('GIT_TERMINAL_PROMPT',$previousGitPrompt,'Process')
    [Environment]::SetEnvironmentVariable('GCM_INTERACTIVE',$previousCredentialPrompt,'Process')
}
