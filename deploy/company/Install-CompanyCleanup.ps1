[CmdletBinding()]
param([string]$InstallRoot = 'D:\App\SXF\Smart-Recruitment-Agent')
$ErrorActionPreference = 'Stop'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if ($InstallRoot -ine 'D:\App\SXF\Smart-Recruitment-Agent') { throw 'Use the reviewed company installation directory.' }
. (Join-Path $InstallRoot 'delivery\Common.ps1')
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Install the cleanup task as Administrator or SYSTEM.' }
$config = Read-CompanyConfig $InstallRoot
if ($config.repositoryUrl -cne 'git@gitee.com:felixshe/auto-recru-company.git' -or $config.companyHost -cne '192.168.1.24' -or
    -not (Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -eq '192.168.1.24')) { throw 'The cleanup installer is limited to the reviewed company server.' }
$taskName = 'AutoRecru-Company-Cleanup'
$lock = [IO.File]::Open((Join-Path $InstallRoot 'control\maintenance-install.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    $source = Join-Path $PSScriptRoot 'maintenance'
    $names = @('cleanup-engine.cjs','cleanup-policy.default.json','Invoke-CompanyCleanup.ps1','Remove-CompanyArtifact.ps1')
    $parts = @($names | ForEach-Object { $_ + ':' + (Get-FileHash -LiteralPath (Join-Path $source $_) -Algorithm SHA256).Hash.ToLowerInvariant() })
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $bundle = ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes(($parts -join "`n"))))).Replace('-','').ToLowerInvariant() }
    finally { $hasher.Dispose() }
    $bundleRoot = Assert-ChildPath $InstallRoot (Join-Path $InstallRoot ('delivery\maintenance\' + $bundle))
    foreach ($folder in @((Join-Path $InstallRoot 'delivery'),(Join-Path $InstallRoot 'delivery\maintenance'))) {
        if ((Test-Path -LiteralPath $folder) -and ((Get-Item -LiteralPath $folder -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Maintenance directory cannot be a reparse point.' }
    }
    New-Item -ItemType Directory -Path $bundleRoot -Force | Out-Null
    if ((Get-Item -LiteralPath $bundleRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Maintenance bundle cannot be a reparse point.' }
    foreach ($name in $names) {
        $destination = Join-Path $bundleRoot $name
        if (Test-Path -LiteralPath $destination) {
            if ((Get-Item -LiteralPath $destination -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Maintenance file cannot be a reparse point.' }
            if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ine (Get-FileHash -LiteralPath (Join-Path $source $name) -Algorithm SHA256).Hash) { throw 'An immutable maintenance bundle has local changes.' }
        } else { Copy-Item -LiteralPath (Join-Path $source $name) -Destination $destination }
    }
    $policy = Join-Path $InstallRoot 'delivery\cleanup-policy.json'
    if (-not (Test-Path -LiteralPath $policy)) { Copy-Item -LiteralPath (Join-Path $source 'cleanup-policy.default.json') -Destination $policy }
    if ((Get-Item -LiteralPath $policy -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup policy cannot be a reparse point.' }
    # Validate retained settings without starting a cleanup while deployment owns sync.lock.
    & $config.nodePath (Join-Path $bundleRoot 'cleanup-engine.cjs') --validate-policy $policy
    if ($LASTEXITCODE -ne 0) { throw 'Cleanup policy validation failed; no scheduled task was changed.' }
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
        $action = @($existing.Actions)
        $ownedPattern = '^-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + [regex]::Escape((Join-Path $InstallRoot 'delivery\maintenance\')) + '[a-f0-9]{64}\\Invoke-CompanyCleanup\.ps1" -InstallRoot "' + [regex]::Escape($InstallRoot) + '" -Apply$'
        if ($action.Count -ne 1 -or $action[0].Execute -ine "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -or
            $action[0].WorkingDirectory -ine $InstallRoot -or $action[0].Arguments -notmatch $ownedPattern -or
            $existing.Principal.UserId -notin @('SYSTEM','S-1-5-18','NT AUTHORITY\SYSTEM') -or [string]$existing.Principal.LogonType -ne 'ServiceAccount') { throw 'An unrelated task already uses the cleanup name; it was preserved.' }
    }
    $today = [datetime]::UtcNow.AddHours(8).ToString('yyyy-MM-dd')
    $command = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $bundleRoot 'Invoke-CompanyCleanup.ps1') + '" -InstallRoot "' + $InstallRoot + '" -Apply'
    $escapedArguments = [Security.SecurityElement]::Escape($arguments)
    $escapedRoot = [Security.SecurityElement]::Escape($InstallRoot)
    $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>AutoRecru company deployment</Author><Description>Conservative artifact cleanup at 12:30 and 20:00 Asia/Shanghai; live data and protected releases are excluded.</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger><StartBoundary>${today}T12:30:00+08:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>
    <CalendarTrigger><StartBoundary>${today}T20:00:00+08:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>
  </Triggers>
  <Principals><Principal id="System"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT2H</ExecutionTimeLimit><Priority>7</Priority></Settings>
  <Actions Context="System"><Exec><Command>$command</Command><Arguments>$escapedArguments</Arguments><WorkingDirectory>$escapedRoot</WorkingDirectory></Exec></Actions>
</Task>
"@
    # ServiceAccount is a PowerShell/CIM enum, not a valid XML LogonType.
    # Windows infers service-account logon from the explicit SYSTEM user.
    Register-ScheduledTask -TaskName $taskName -Xml $xml -User 'SYSTEM' -Force | Out-Null
    $installed = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if ([string]$installed.State -eq 'Disabled' -or @($installed.Triggers).Count -ne 2 -or $installed.Actions[0].Arguments -cne $arguments -or
        $installed.Principal.UserId -notin @('SYSTEM','S-1-5-18','NT AUTHORITY\SYSTEM') -or [string]$installed.Principal.LogonType -ne 'ServiceAccount') { throw 'Cleanup task registration did not match the reviewed schedule or SYSTEM identity.' }
    Write-JsonFile (Join-Path $InstallRoot 'delivery\cleanup-installation.json') @{
        installed=$true;taskName=$taskName;times=@('12:30','20:00');timeZone='Asia/Shanghai';offset='+08:00';bundle=$bundle;
        installedAtUtc=[datetime]::UtcNow.ToString('o');enabled=$true;policy=(Get-Content -LiteralPath $policy -Raw | ConvertFrom-Json)
    }
    Write-Host 'CLEANUP_TASK_INSTALLED: daily 12:30 and 20:00 Asia/Shanghai, running as SYSTEM.'
} finally { $lock.Dispose() }
