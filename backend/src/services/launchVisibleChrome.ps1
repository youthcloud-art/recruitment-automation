param(
    [Parameter(Mandatory=$true)][string]$ChromePath,
    [Parameter(Mandatory=$true)][string]$ProfileDir,
    [Parameter(Mandatory=$true)][int]$Port,
    [Parameter(Mandatory=$true)][string]$InitialUrl
)

$ErrorActionPreference = 'Stop'
$chromeArguments = @(
    '--remote-debugging-address=127.0.0.1',
    "--remote-debugging-port=$Port",
    "--user-data-dir=`"$ProfileDir`"",
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    "`"$InitialUrl`""
)

$chrome = Start-Process -FilePath $ChromePath -ArgumentList $chromeArguments -WindowStyle Normal -PassThru
[Console]::Out.WriteLine($chrome.Id)
