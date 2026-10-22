# Read-only follow-up inventory for an already prepared company installation.
# Writes only the resulting report; never stops processes or changes deployment.
[CmdletBinding()]
param(
    [string]$InstallRoot = 'D:\App\SXF\Smart-Recruitment-Agent',
    [string]$ReportPath = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'AutoRecru-Deployment-Check.json')
)
$ErrorActionPreference = 'Stop'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')

function Get-ExistingCommandFiles([string]$CommandLine) {
    # Return existing file paths only, never the full command line or values of
    # options (which might contain passwords, tokens or environment settings).
    $pattern = '"(?<file>[A-Za-z]:\\[^"\r\n]+\.(?:exe|ps1|cmd|bat|[cm]?js|json))"|(?:^|\s)(?<file>[A-Za-z]:\\[^\s"\r\n]+\.(?:exe|ps1|cmd|bat|[cm]?js|json))(?=\s|$)'
    @([regex]::Matches($CommandLine, $pattern, 'IgnoreCase') | ForEach-Object {
        $candidate = $_.Groups['file'].Value
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $candidate }
    } | Select-Object -Unique)
}

function Get-ProcessChain([int]$ProcessId) {
    $seen = @{}
    for ($depth = 0; $depth -lt 8 -and $ProcessId -gt 0; $depth++) {
        if ($seen.ContainsKey($ProcessId)) { break }
        $seen[$ProcessId] = $true
        $record = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
        if (-not $record) { break }
        [pscustomobject]@{
            pid=$record.ProcessId; parentPid=$record.ParentProcessId
            executable=$record.ExecutablePath; createdAt=$record.CreationDate
            commandFiles=@(Get-ExistingCommandFiles ([string]$record.CommandLine))
        }
        $parentId = [int]$record.ParentProcessId
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$parentId" -ErrorAction SilentlyContinue
        # Do not associate a reused parent PID with an older child.
        if (-not $parent -or $parent.CreationDate -gt $record.CreationDate) { break }
        $ProcessId = $parentId
    }
}

function Read-InventoryJson([string]$Path) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        try { return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json) }
        catch { $script:inventoryErrors += "Unreadable JSON: $Path" }
    }
    return $null
}

$inventoryErrors = @()
$allListeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
$listeners = @($allListeners | Where-Object { $_.LocalPort -in @(4000,4001,5001,19501) } | ForEach-Object {
    [pscustomobject]@{
        address=$_.LocalAddress; port=$_.LocalPort; pid=$_.OwningProcess
        processChain=@(Get-ProcessChain ([int]$_.OwningProcess))
    }
})
$processIds = @($listeners | ForEach-Object { $_.processChain | ForEach-Object { $_.pid } } | Select-Object -Unique)
$tasks = @(Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\Microsoft\*' } | ForEach-Object {
    $task = $_
    $information = Get-ScheduledTaskInfo -InputObject $task -ErrorAction SilentlyContinue
    [pscustomobject]@{
        name=$task.TaskName; path=$task.TaskPath; state=[string]$task.State
        runAs=$task.Principal.UserId; logonType=[string]$task.Principal.LogonType
        lastResult=if ($information) {$information.LastTaskResult} else {$null}
        actions=@($task.Actions | ForEach-Object {
            [pscustomobject]@{
                executable=$_.Execute; workingDirectory=$_.WorkingDirectory
                commandFiles=@(Get-ExistingCommandFiles ([string]$_.Arguments))
            }
        })
    }
})
$services = @(Get-CimInstance Win32_Service | Where-Object {
    $_.ProcessId -gt 0 -and $_.ProcessId -in $processIds
} | ForEach-Object {
    [pscustomobject]@{name=$_.Name; state=$_.State; startMode=$_.StartMode; pid=$_.ProcessId; commandFiles=@(Get-ExistingCommandFiles ([string]$_.PathName))}
})
$config = Read-InventoryJson (Join-Path $InstallRoot 'delivery\config.json')
$prepared = Read-InventoryJson (Join-Path $InstallRoot 'delivery\prepared-release.json')
$active = Read-InventoryJson (Join-Path $InstallRoot 'control\current-release.json')
$preparedDetails = $null
if ($prepared) {
    $preparedRoot = [IO.Path]::GetFullPath([string]$prepared.root)
    if ($preparedRoot.StartsWith($InstallRoot + '\releases\', [StringComparison]::OrdinalIgnoreCase)) {
        $preparedDetails = [pscustomobject]@{
            root=$preparedRoot; commit=$prepared.commit
            releaseManifestExists=(Test-Path -LiteralPath (Join-Path $preparedRoot 'release.json') -PathType Leaf)
            frontendBuilt=(Test-Path -LiteralPath (Join-Path $preparedRoot 'frontend\build\index.html') -PathType Leaf)
            backendDependenciesPresent=(Test-Path -LiteralPath (Join-Path $preparedRoot 'backend\node_modules') -PathType Container)
            sqliteBinaryPresent=(@(Get-ChildItem -LiteralPath (Join-Path $preparedRoot 'backend\node_modules\sqlite3') -Filter '*.node' -Recurse -File -ErrorAction SilentlyContinue).Count -gt 0)
        }
    } else { $inventoryErrors += 'Prepared release path is outside the expected releases directory.' }
}
$chrome = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
$report = [pscustomobject]@{
    readOnly=$true; generatedAtUtc=[datetime]::UtcNow.ToString('o')
    identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
    installRoot=$InstallRoot
    configured=[bool]$config
    bootstrapCommit=if ($config) {$config.bootstrapCommit} else {$null}
    configuredBackendPort=if ($config -and $config.PSObject.Properties['backendPort']) {$config.backendPort} else {5001}
    configuredGatewayPort=if ($config -and $config.PSObject.Properties['gatewayPort']) {$config.gatewayPort} else {4000}
    candidateBackendPort=19501
    candidateBackendPortHasNoListener=(@($allListeners | Where-Object { $_.LocalPort -eq 19501 }).Count -eq 0)
    preparedRelease=$preparedDetails
    activeRelease=if ($active) {[pscustomobject]@{root=$active.root;commit=$active.commit}} else {$null}
    publicKeyExists=(Test-Path -LiteralPath (Join-Path $InstallRoot 'delivery\gitee-readonly-ed25519.pub') -PathType Leaf)
    chromePaths=@($chrome)
    listeners=$listeners; nonMicrosoftTasks=$tasks; associatedServices=$services
    errors=$inventoryErrors
}
[IO.File]::WriteAllText($ReportPath, ($report | ConvertTo-Json -Depth 14), [Text.UTF8Encoding]::new($false))
Write-Host "DEPLOYMENT_REPORT: $ReportPath"
Write-Host 'Read-only check complete. No service was stopped; no deployment settings or keys were changed.'
