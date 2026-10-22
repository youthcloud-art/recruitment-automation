[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$InitialRepositoryRoot,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$Commit,
    [string]$InstallRoot = 'D:\App\SXF\AutoRecru',
    [string]$RunAs = [Security.Principal.WindowsIdentity]::GetCurrent().Name,
    [string]$RepositoryUrl = 'git@gitee.com:felixshe/auto-recru-company.git',
    [string]$CompanyHost = '192.168.1.24',
    [string[]]$AllowedNetworks = @('192.168.1.0/24','192.168.11.0/24'),
    [string[]]$LegacyTaskName = @(),
    [string]$LegacyInstallRoot,
    [switch]$OpenFirewall,
    [switch]$PrepareOnly,
    [switch]$Resume
)
. (Join-Path $PSScriptRoot 'Common.ps1')
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run Windows PowerShell as Administrator on the company server.' }
if ($CompanyHost -ne '192.168.1.24') { throw 'This installation is prepared for the reviewed company server 192.168.1.24.' }
if ($RepositoryUrl -cne 'git@gitee.com:felixshe/auto-recru-company.git') { throw 'Use the reviewed Gitee SSH repository; do not put tokens or passwords in repository URLs.' }
if (-not (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -eq $CompanyHost })) { throw 'Run this installer on the company server that owns the configured IP address.' }
if ($AllowedNetworks.Count -eq 0) { throw 'At least one confirmed company network is required.' }
foreach ($network in $AllowedNetworks) {
    Assert-CompanyNetwork $network
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if ($InstallRoot -eq [IO.Path]::GetPathRoot($InstallRoot).TrimEnd('\')) { throw 'The installation cannot be a drive root.' }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source
$gitPath = (Get-Command git.exe -ErrorAction Stop).Source
$nodeMajor = [int](& $nodePath -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 24) { throw 'Install Node.js 24 LTS or newer before preparing the release.' }
$account = [Security.Principal.NTAccount]::new($RunAs)
$sid = $account.Translate([Security.Principal.SecurityIdentifier]).Value
$configPath = Join-Path $InstallRoot 'delivery\config.json'
$savedConfig = $null
if (Test-Path -LiteralPath $configPath) {
    if (-not $Resume) { throw 'This installation is already initialized. Resume an incomplete first installation with -Resume; use Sync-Company.ps1 for later upgrades.' }
    if (Test-Path -LiteralPath (Join-Path $InstallRoot 'control\current-release.json')) { throw 'Resume is only for an incomplete first installation, never an active deployment.' }
    $savedConfig = Read-CompanyConfig $InstallRoot
    if ($savedConfig.bootstrapCommit -ine $Commit -or $savedConfig.runAs -ine $RunAs -or
        $savedConfig.repositoryUrl -cne $RepositoryUrl -or $savedConfig.companyHost -cne $CompanyHost -or
        (([string[]]$savedConfig.allowedNetworks | Sort-Object) -join ',') -cne (($AllowedNetworks | Sort-Object) -join ',') -or
        $savedConfig.nodePath -ine $nodePath -or $savedConfig.npmPath -ine $npmPath -or $savedConfig.gitPath -ine $gitPath) {
        throw 'Resume arguments or runtime paths do not match the incomplete installation configuration.'
    }
} else {
    if ($Resume) { throw 'No incomplete installation configuration was found to resume.' }
    if ((Test-Path -LiteralPath $InstallRoot) -and @(Get-ChildItem -LiteralPath $InstallRoot -Force).Count -gt 0) { throw 'Initial installation requires an empty, dedicated directory.' }
}
foreach ($taskName in @('AutoRecru-Company-Runtime','AutoRecru-Company-MirrorDeploy')) {
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existingTask -and -not $Resume) { throw "Task already exists and was not replaced: $taskName" }
    if ($existingTask -and $existingTask.State -eq 'Running') { throw "Wait for the incomplete installation task to finish before resuming: $taskName" }
}
foreach ($relative in @('delivery','releases','shared\local','shared\backend-storage','shared\backend-uploads','control','logs','backups')) {
    New-Item -ItemType Directory -Path (Join-Path $InstallRoot $relative) -Force | Out-Null
}
Invoke-Checked 'icacls.exe' @($InstallRoot, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)(F)', '*S-1-5-32-544:(OI)(CI)(F)', ('*' + $sid + ':(OI)(CI)(RX)'))
foreach ($relative in @('shared','control','logs')) {
    Invoke-Checked 'icacls.exe' @((Join-Path $InstallRoot $relative), '/grant:r', ('*' + $sid + ':(OI)(CI)(M)'))
}
if (-not $Resume) {
    [IO.File]::WriteAllText((Join-Path $InstallRoot 'shared\backend.env'), "DATABASE_TYPE=sqlite`r`nRESUME_STORAGE_ENGINE=sqlite`r`nNODE_ENV=production`r`n", [Text.UTF8Encoding]::new($false))
} elseif (-not (Test-Path -LiteralPath (Join-Path $InstallRoot 'shared\backend.env') -PathType Leaf)) { throw 'The shared backend environment file is missing; it was not recreated or overwritten.' }

$keyPath = Join-Path $InstallRoot 'delivery\gitee-readonly-ed25519'
$sshKeygen = Get-Command ssh-keygen.exe -ErrorAction SilentlyContinue
$ssh = Get-Command ssh.exe -ErrorAction SilentlyContinue
if (-not $sshKeygen -or -not $ssh) {
    $gitInstallation = Split-Path -Parent (Split-Path -Parent $gitPath)
    $sshPath = Join-Path $gitInstallation 'usr\bin\ssh.exe'
    $keygenPath = Join-Path $gitInstallation 'usr\bin\ssh-keygen.exe'
} else { $sshPath = $ssh.Source; $keygenPath = $sshKeygen.Source }
if (-not (Test-Path -LiteralPath $keygenPath) -or -not (Test-Path -LiteralPath $sshPath)) { throw 'Install the OpenSSH tools included with Git for Windows.' }
if (-not (Test-Path -LiteralPath $keyPath)) {
    if ($Resume) { throw 'The saved deployment private key is missing. Restore it before resuming.' }
    Invoke-Checked $keygenPath @('-q','-t','ed25519','-f',$keyPath,'-N','""','-C','auto-recru-company-readonly')
}
Invoke-Checked 'icacls.exe' @($keyPath, '/inheritance:r', '/grant:r', '*S-1-5-18:(R)', '*S-1-5-32-544:(F)')
$config = @{
    installRoot=$InstallRoot; companyHost=$CompanyHost; allowedNetworks=$AllowedNetworks;
    repositoryUrl=$RepositoryUrl; branch='main'; nodePath=$nodePath; npmPath=$npmPath; gitPath=$gitPath;
    sshPath=$sshPath; deployKeyPath=$keyPath; runAs=$RunAs; bootstrapCommit=$Commit;
    runtimeTask='AutoRecru-Company-Runtime'; syncTask='AutoRecru-Company-MirrorDeploy'
}
if (-not $Resume) { Write-JsonFile $configPath $config }
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$runtimeAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $InstallRoot 'delivery\Run-Company.ps1') + '" -InstallRoot "' + $InstallRoot + '"') -WorkingDirectory $InstallRoot
$runtimePrincipal = New-ScheduledTaskPrincipal -UserId $RunAs -LogonType Interactive -RunLevel Limited
$syncAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $InstallRoot 'delivery\Sync-Company.ps1') + '" -InstallRoot "' + $InstallRoot + '"') -WorkingDirectory $InstallRoot
$syncPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$periodic = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$syncSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2) -StartWhenAvailable
foreach ($definition in @(
    @{name=$config.runtimeTask; action=$runtimeAction; principal=$runtimePrincipal; settings=$settings; triggers=@((New-ScheduledTaskTrigger -AtLogOn -User $RunAs)); description='Company recruitment gateway and loopback backend. Interactive identity keeps Chrome available for platform sign-in.'},
    @{name=$config.syncTask; action=$syncAction; principal=$syncPrincipal; settings=$syncSettings; triggers=@($periodic,(New-ScheduledTaskTrigger -AtStartup)); description='Pull Gitee main, prepare dependencies/build before downtime, verify and roll back failed releases.'}
)) {
    $existingTask = Get-ScheduledTask -TaskName $definition.name -ErrorAction SilentlyContinue
    if ($existingTask) {
        if (@($existingTask.Actions).Count -ne 1 -or
            $existingTask.Actions[0].Execute -ine $definition.action.Execute -or
            $existingTask.Actions[0].Arguments -cne $definition.action.Arguments -or
            $existingTask.Actions[0].WorkingDirectory -ine $definition.action.WorkingDirectory -or
            [string]$existingTask.Principal.LogonType -ne [string]$definition.principal.LogonType) {
            throw "Existing task configuration does not match this incomplete installation: $($definition.name)"
        }
        $existingUser = [string]$existingTask.Principal.UserId
        $expectedUser = [string]$definition.principal.UserId
        if ($existingUser -ine $expectedUser -and -not ($existingUser -in @('SYSTEM','S-1-5-18') -and $expectedUser -in @('SYSTEM','S-1-5-18'))) {
            throw "Existing task identity does not match this incomplete installation: $($definition.name)"
        }
    } else {
        Register-ScheduledTask -TaskName $definition.name -Action $definition.action -Trigger $definition.triggers -Principal $definition.principal -Settings $definition.settings -Description $definition.description | Out-Null
    }
}
foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File) {
    $destination = Join-Path (Join-Path $InstallRoot 'delivery') $file.Name
    if ($file.FullName -ine $destination) { Copy-Item -LiteralPath $file.FullName -Destination $destination -Force }
}
# Keep delivery paused until the first reviewed activation has succeeded.
Disable-ScheduledTask -TaskName $config.syncTask | Out-Null
if ($OpenFirewall) {
    $ruleName = 'AutoRecru-Company-TCP4000'
    $existingRule = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
    if ($existingRule) {
        if (-not $Resume) { throw "Firewall rule already exists; review it instead of overwriting: $ruleName" }
        $portFilter = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $existingRule
        $addressFilter = Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $existingRule
        $applicationFilter = Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $existingRule
        if ($existingRule.Enabled -ne 'True' -or $existingRule.Direction -ne 'Inbound' -or $existingRule.Action -ne 'Allow' -or
            [string]$portFilter.LocalPort -ne '4000' -or [string]$portFilter.Protocol -notin @('TCP','6') -or
            [string]$addressFilter.LocalAddress -ne $CompanyHost -or $applicationFilter.Program -ine $nodePath -or
            ((@($addressFilter.RemoteAddress | ForEach-Object { ConvertTo-CanonicalFirewallNetwork $_ }) | Sort-Object) -join ',') -cne (($AllowedNetworks | Sort-Object) -join ',')) {
            throw 'The existing firewall rule does not match the reviewed incomplete installation.'
        }
    } else { New-NetFirewallRule -Name $ruleName -DisplayName 'AutoRecru company networks TCP 4000' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $CompanyHost -LocalPort 4000 -RemoteAddress $AllowedNetworks -Program $nodePath -Profile Any | Out-Null }
}
& (Join-Path $InstallRoot 'delivery\Prepare-Release.ps1') -InstallRoot $InstallRoot -SourceRoot $InitialRepositoryRoot -Commit $Commit
$prepared = Get-Content -LiteralPath (Join-Path $InstallRoot 'delivery\prepared-release.json') -Raw | ConvertFrom-Json
Write-Host "READ_ONLY_GITEE_PUBLIC_KEY: $keyPath.pub"
Write-Host 'Add only that .pub file as a read-only deploy key to felixshe/auto-recru-company. Do not share the private key.'
if (-not $PrepareOnly) {
    & (Join-Path $InstallRoot 'delivery\Switch-Release.ps1') -InstallRoot $InstallRoot -ReleaseRoot $prepared.root -LegacyTaskName $LegacyTaskName -LegacyInstallRoot $LegacyInstallRoot
    Enable-ScheduledTask -TaskName $config.syncTask | Out-Null
} else { Write-Host 'PREPARED_ONLY: production and any old service have not been stopped. The mirror task remains disabled.' }
