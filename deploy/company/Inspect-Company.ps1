# Read-only inventory. Does not expose command-line arguments, credentials or data.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(4000,5001) } | ForEach-Object {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue
    [pscustomobject]@{address=$_.LocalAddress;port=$_.LocalPort;pid=$_.OwningProcess;executable=$process.ExecutablePath;parentPid=$process.ParentProcessId}
})
$tasks = @(Get-ScheduledTask | Where-Object { $_.TaskName -match '(?i)TalentAgent|AutoRecru|recru' } | ForEach-Object {
    [pscustomobject]@{name=$_.TaskName;path=$_.TaskPath;state=[string]$_.State;runAs=$_.Principal.UserId;logonType=[string]$_.Principal.LogonType;actions=@($_.Actions | ForEach-Object { [pscustomobject]@{executable=$_.Execute;workingDirectory=$_.WorkingDirectory} })}
})
$node = Get-Command node.exe -ErrorAction SilentlyContinue
$git = Get-Command git.exe -ErrorAction SilentlyContinue
[pscustomobject]@{
    readOnly=$true
    system=(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,OSArchitecture)
    identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
    addresses=@(Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias,IPAddress,PrefixLength)
    nodePath=if ($node) {$node.Source} else {$null}
    nodeVersion=if ($node) {& $node.Source --version} else {$null}
    gitPath=if ($git) {$git.Source} else {$null}
    listeners=$listeners
    relatedTasks=$tasks
} | ConvertTo-Json -Depth 8
