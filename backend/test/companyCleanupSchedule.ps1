param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText($Installer)
$template = [regex]::Match($source, '(?ms)^\s*\$xml = @"\r?\n(.*?)\r?\n"@')
if (-not $template.Success) { throw 'The actual installer task XML was not found.' }
$root = 'D:\App\SXF\Smart-Recruitment-Agent'
$xml = $template.Groups[1].Value.Replace('${today}', '2026-10-28').Replace('$command', "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe").Replace('$escapedArguments', '-NoProfile -File &quot;D:\App\SXF\Smart-Recruitment-Agent\delivery\maintenance\test.ps1&quot;').Replace('$escapedRoot', $root)
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$definition = $scheduler.NewTask(0)
# XmlText invokes the real Windows task schema validator without registering
# a task, running software, deleting files or requiring an administrator.
$definition.XmlText = $xml
if ($definition.Principal.UserId -notin @('SYSTEM','S-1-5-18','NT AUTHORITY\SYSTEM') -or $definition.Principal.LogonType -ne 5) { throw 'SYSTEM service-account identity was not inferred.' }
if ($definition.Principal.RunLevel -ne 1) { throw 'The task did not retain HighestAvailable.' }
[xml]$parsed = $definition.XmlText
$boundaries = @($parsed.Task.Triggers.CalendarTrigger | ForEach-Object { [string]$_.StartBoundary })
if ($boundaries.Count -ne 2 -or $boundaries[0] -notmatch 'T12:30:00\+08:00$' -or $boundaries[1] -notmatch 'T20:00:00\+08:00$') { throw 'The native parser did not retain the two fixed Beijing times.' }
if ([string]$parsed.Task.Settings.MultipleInstancesPolicy -ne 'IgnoreNew') { throw 'Cleanup concurrency settings were lost.' }
$invalid = $xml.Replace('<UserId>S-1-5-18</UserId>', '<UserId>S-1-5-18</UserId><LogonType>ServiceAccount</LogonType>')
$refused = $false
try { $scheduler.NewTask(0).XmlText = $invalid } catch { $refused = $true }
if (-not $refused) { throw 'The previous invalid LogonType was unexpectedly accepted.' }
Write-Host 'NATIVE_CLEANUP_SCHEDULE_VALID: SYSTEM, fixed Beijing schedule, invalid XML regression rejected.'
