# All removals are non-recursive, after a full reparse-point and path audit.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [Parameter(Mandatory=$true)][ValidateSet('release','backup','archive','log')][string]$Kind,
    [Parameter(Mandatory=$true)][string]$Target
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$failureStage = 'validation'
trap {
    $exception = $_.Exception
    $native = [int]($exception.HResult -band 65535)
    $code = if ($exception -is [IO.PathTooLongException] -or $native -eq 206) { 'PATH_TOO_LONG' }
        elseif ($native -in @(32,33)) { 'FILE_IN_USE' }
        elseif ($exception -is [UnauthorizedAccessException] -or $native -eq 5) { 'ACCESS_DENIED' }
        elseif ($native -eq 145) { 'DIRECTORY_NOT_EMPTY' }
        elseif ($exception.Message -match 'protected|reparse|junction|reviewed|outside|approved') { 'SAFETY_REFUSAL' }
        else { 'OTHER' }
    [Console]::Error.WriteLine("CLEANUP_FAILURE code=$code stage=$failureStage win32=$native")
    exit 1
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$Target = [IO.Path]::GetFullPath($Target).TrimEnd('\')
$releasePattern = '^\d{8}-\d{6}-[a-fA-F0-9]{12}-[a-fA-F0-9]{6}$'
$backupPattern = '^before-\d{8}-\d{6}-[a-fA-F0-9]{6}$'
$folder = if ($Kind -eq 'backup') {'backups'} elseif ($Kind -eq 'log') {'logs'} else {'releases'}
$parent = Join-Path $InstallRoot $folder
if ((Split-Path -Parent $Target) -ine $parent -or -not $Target.StartsWith($InstallRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Deletion target is outside its reviewed direct parent.' }
$name = Split-Path -Leaf $Target
if (($Kind -eq 'release' -and $name -notmatch $releasePattern) -or
    ($Kind -eq 'backup' -and $name -notmatch $backupPattern) -or
    ($Kind -eq 'archive' -and ($name -notlike '*.zip' -or $name.Substring(0,$name.Length-4) -notmatch $releasePattern)) -or
    ($Kind -eq 'log' -and ($name -notmatch '^[a-zA-Z0-9._-]+\.log$' -or $name -in @('backend.stdout.log','backend.stderr.log','gateway.stdout.log','gateway.stderr.log')))) { throw 'The artifact name is not approved for cleanup.' }
foreach ($directory in @($InstallRoot,$parent)) {
    if ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup cannot traverse a reparse-point parent.' }
}
if (-not (Test-Path -LiteralPath $Target)) { exit 0 }
if ((Get-Item -LiteralPath $Target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup target cannot itself be a reparse point.' }
# Re-check the active, prepared and process references immediately before removal.
if ($Kind -in @('release','archive')) {
    $compared = if ($Kind -eq 'archive') {$Target.Substring(0,$Target.Length-4)} else {$Target}
    foreach ($reference in @('control\current-release.json','delivery\prepared-release.json','control\processes.json')) {
        $file = Join-Path $InstallRoot $reference
        if (Test-Path -LiteralPath $file) {
            $value = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
            $field = if ($reference -eq 'control\processes.json') {'release'} else {'root'}
            if ($value.PSObject.Properties[$field] -and [IO.Path]::GetFullPath([string]$value.$field).TrimEnd('\') -ieq $compared) { throw 'A live or prepared release is protected.' }
        }
    }
}
if ($Kind -eq 'backup') {
    $record = Join-Path $InstallRoot 'delivery\last-deployment.json'
    if (Test-Path -LiteralPath $record) {
        $value = Get-Content -LiteralPath $record -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($value.PSObject.Properties['snapshot'] -and [IO.Path]::GetFullPath([string]$value.snapshot).TrimEnd('\') -ieq $Target) { throw 'The current deployment backup is protected.' }
    }
}
$files = [Collections.Generic.List[string]]::new()
$directories = [Collections.Generic.List[string]]::new()
$junctions = [Collections.Generic.List[string]]::new()
$stack = [Collections.Generic.Stack[string]]::new()
$stack.Push($Target)
$failureStage = 'audit'
while ($stack.Count -gt 0) {
    $current = $stack.Pop()
    if ($current -ine $Target -and -not $current.StartsWith($Target + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Artifact traversal escaped the deletion root.' }
    # PowerShell 5.1's Get-ChildItem/Remove-Item cannot reliably enumerate
    # deep npm trees on Windows Server 2016. .NET accepts extended paths.
    $nativePath = '\\?\' + $current
    $attributes = [IO.File]::GetAttributes($nativePath)
    if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
        $relative = $current.Substring($Target.Length + 1)
        $expected = switch ($relative.ToLowerInvariant()) {
            '.local' { Join-Path $InstallRoot 'shared\local' }
            'backend\storage' { Join-Path $InstallRoot 'shared\backend-storage' }
            'backend\uploads' { Join-Path $InstallRoot 'shared\backend-uploads' }
            default { $null }
        }
        if ($Kind -ne 'release' -or -not $expected -or -not ($attributes -band [IO.FileAttributes]::Directory)) { throw 'Unreviewed reparse point in artifact; nothing was removed.' }
        $item = Get-Item -LiteralPath $current -Force
        if (-not $item.PSObject.Properties['Target']) { throw 'Deployment junction target cannot be inspected; nothing was removed.' }
        $actual = [string]@($item.Target)[0]
        if ($actual.StartsWith('\??\')) { $actual = $actual.Substring(4) }
        if ($actual.StartsWith('\\?\')) { $actual = $actual.Substring(4) }
        if ([IO.Path]::GetFullPath($actual).TrimEnd('\') -ine [IO.Path]::GetFullPath($expected).TrimEnd('\')) { throw 'Deployment junction has an unexpected target; nothing was removed.' }
        $junctions.Add($current)
    } elseif ($attributes -band [IO.FileAttributes]::Directory) {
        $directories.Add($current)
        foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($nativePath)) {
            if (-not $child.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Artifact traversal returned an unexpected path.' }
            $stack.Push($child.Substring(4))
        }
    } else { $files.Add($current) }
}
# These calls never recursively follow a shared-data junction. Unknown links
# have already caused a refusal before the first filesystem change.
$failureStage = 'remove_junction'
foreach ($junction in $junctions) {
    $nativePath = '\\?\' + $junction
    if (-not ([IO.File]::GetAttributes($nativePath) -band [IO.FileAttributes]::ReparsePoint)) { throw 'A junction changed during cleanup.' }
    [IO.Directory]::Delete($nativePath, $false)
}
$failureStage = 'remove_file'
foreach ($file in $files) {
    $nativePath = '\\?\' + $file
    for ($attempt=0; $attempt -lt 3; $attempt++) {
        try {
            if ([IO.File]::GetAttributes($nativePath) -band [IO.FileAttributes]::ReparsePoint) { throw 'A file changed into a reparse point during cleanup.' }
            [IO.File]::SetAttributes($nativePath, [IO.FileAttributes]::Normal)
            [IO.File]::Delete($nativePath)
            break
        } catch [IO.IOException] {
            if ($attempt -eq 2) { throw }
            Start-Sleep -Milliseconds (250 * ($attempt + 1))
        }
    }
}
$failureStage = 'remove_directory'
foreach ($directory in @($directories | Sort-Object Length -Descending)) {
    $nativePath = '\\?\' + $directory
    for ($attempt=0; $attempt -lt 3; $attempt++) {
        try {
            if ([IO.File]::GetAttributes($nativePath) -band [IO.FileAttributes]::ReparsePoint) { throw 'A directory changed into a reparse point during cleanup.' }
            [IO.File]::SetAttributes($nativePath, [IO.FileAttributes]::Normal)
            [IO.Directory]::Delete($nativePath, $false)
            break
        } catch [IO.IOException] {
            if ($attempt -eq 2) { throw }
            Start-Sleep -Milliseconds (250 * ($attempt + 1))
        }
    }
}
