[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [Parameter(Mandatory=$true)][string]$SourceRoot,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$Commit
)
. (Join-Path $PSScriptRoot 'Common.ps1')
$config = Read-CompanyConfig $InstallRoot
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
# A failed build must never consume the remaining space needed by the live
# service, its logs and shared resume database. Cleanup can reclaim older
# incomplete builds on its next scheduled run.
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($InstallRoot)))
if ($drive.AvailableFreeSpace -lt 8GB) { throw 'Release build deferred: fewer than 8 GB remain on the application volume. The running release was preserved.' }
$release = Assert-ChildPath $InstallRoot (Join-Path $InstallRoot ('releases\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $Commit.Substring(0,12) + '-' + [guid]::NewGuid().ToString('N').Substring(0,6)))
New-Item -ItemType Directory -Path $release | Out-Null
try {

if (Test-Path -LiteralPath (Join-Path $SourceRoot '.git')) {
    $actualCommit = (& $config.gitPath -C $SourceRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $actualCommit -ine $Commit) { throw 'The source checkout does not match the requested commit.' }
    $archive = Assert-ChildPath $InstallRoot ($release + '.zip')
    Invoke-Checked $config.gitPath @('-C', $SourceRoot, 'archive', '--format=zip', ('--output=' + $archive), $Commit)
    Expand-Archive -LiteralPath $archive -DestinationPath $release
    Remove-Item -LiteralPath $archive -Force
} else {
    # Bootstrap accepts an extracted archive of one reviewed, exact commit.
    $excluded = '(^|[\\/])(\.git|node_modules|\.local|runtime|logs|talent-data|artifacts|exports)([\\/]|$)|^backend[\\/](storage|uploads)([\\/]|$)|(^|[\\/])\.env($|\.)|\.sqlite3?($|-)|\.log$'
    $directories = [Collections.Generic.Stack[string]]::new()
    $directories.Push($SourceRoot)
    while ($directories.Count -gt 0) {
        foreach ($item in Get-ChildItem -LiteralPath $directories.Pop() -Force) {
            $relative = $item.FullName.Substring($SourceRoot.TrimEnd('\').Length + 1)
            if ($relative -match $excluded) { continue }
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Bootstrap source must not contain reparse points.' }
            if ($item.PSIsContainer) { $directories.Push($item.FullName); continue }
            $destination = Assert-ChildPath $release (Join-Path $release $relative)
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath $item.FullName -Destination $destination
        }
    }
}

foreach ($relative in @('backend\src\index.js','backend\package-lock.json','frontend\package-lock.json','deploy\company\gateway.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $release $relative) -PathType Leaf)) { throw "Release is missing $relative" }
}
$ocrHashes = @{
    'chi_sim.traineddata' = 'A5FCB6F0DB1E1D6D8522F39DB4E848F05984669172E584E8D76B6B3141E1F730'
    'eng.traineddata' = '7D4322BD2A7749724879683FC3912CB542F19906C83BCC1A52132556427170B2'
}
foreach ($name in $ocrHashes.Keys) {
    $model = Join-Path $release ('backend\assets\tessdata\' + $name)
    if (-not (Test-Path -LiteralPath $model -PathType Leaf)) { throw "Release is missing OCR language data: $name" }
    if ((Get-FileHash -LiteralPath $model -Algorithm SHA256).Hash -cne $ocrHashes[$name]) {
        throw "Release OCR language data checksum failed: $name"
    }
}
# Never let historical CRA environment files override the company build.
Get-ChildItem -LiteralPath (Join-Path $release 'frontend') -Force -File | Where-Object { $_.Name -match '^\.env($|\.)' } | Remove-Item -Force
foreach ($relative in @('.local','backend\storage','backend\uploads','backend\.env')) {
    if (Test-Path -LiteralPath (Join-Path $release $relative)) { throw "The code archive contains forbidden runtime state: $relative" }
}
$previous = @{}
$buildEnvironment = @{ REACT_APP_API_BASE_URL=''; REACT_APP_SOCKET_URL=''; REACT_APP_COMPANY_AUTH='true'; NODE_ENV='production'; CI='false'; GENERATE_SOURCEMAP='false' }
try {
    foreach ($variable in Get-ChildItem Env: | Where-Object { $_.Name -like 'REACT_APP_*' }) {
        $previous[$variable.Name] = $variable.Value
        [Environment]::SetEnvironmentVariable($variable.Name, $null, 'Process')
    }
    foreach ($name in $buildEnvironment.Keys) {
        if (-not $previous.ContainsKey($name)) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
        [Environment]::SetEnvironmentVariable($name, $buildEnvironment[$name], 'Process')
    }
    Push-Location (Join-Path $release 'backend')
    try {
        Invoke-Checked $config.npmPath @('ci', '--omit=dev', '--no-audit', '--no-fund')
        Invoke-Checked $config.nodePath @('scripts\check-ocr-assets.js')
    } finally { Pop-Location }
    Push-Location (Join-Path $release 'frontend')
    try {
        Invoke-Checked $config.npmPath @('ci', '--include=dev', '--no-audit', '--no-fund')
        Invoke-Checked $config.npmPath @('run', 'build')
    } finally { Pop-Location }
} finally {
    foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
Invoke-Checked $config.nodePath @('--check', (Join-Path $release 'backend\src\index.js'))
Invoke-Checked $config.nodePath @('--check', (Join-Path $release 'deploy\company\gateway.js'))
if (-not (Test-Path -LiteralPath (Join-Path $release 'frontend\build\index.html'))) { throw 'The frontend build did not produce index.html.' }
Connect-SharedState $InstallRoot $release
Write-JsonFile (Join-Path $release 'release.json') @{ commit=$Commit; preparedAtUtc=[datetime]::UtcNow.ToString('o'); root=$release }
# A dedicated final output lets callers avoid capturing npm diagnostic output.
Write-JsonFile (Join-Path $InstallRoot 'delivery\prepared-release.json') @{ commit=$Commit; root=$release }
Write-Host "PREPARED_RELEASE: $release"
} catch {
    # A failed npm install or build must not accumulate another large release.
    # Shared business state is attached only after a successful build; refuse
    # cleanup if any of its junctions may already have been created.
    if (-not (Test-Path -LiteralPath (Join-Path $release 'release.json')) -and
        -not (Test-Path -LiteralPath (Join-Path $release '.local')) -and
        -not (Test-Path -LiteralPath (Join-Path $release 'backend\storage')) -and
        -not (Test-Path -LiteralPath (Join-Path $release 'backend\uploads'))) {
        try {
            $deleter = Join-Path $PSScriptRoot 'maintenance\Remove-CompanyArtifact.ps1'
            $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $deleter -InstallRoot $InstallRoot -Kind release -Target $release
            if ($LASTEXITCODE -ne 0) { Write-Warning 'Failed build cleanup was refused; scheduled cleanup will retry.' }
        } catch { Write-Warning 'Failed build cleanup was refused; scheduled cleanup will retry.' }
    }
    throw
}
