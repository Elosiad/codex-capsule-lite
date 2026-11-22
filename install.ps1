param([switch]$FollowCodex,[switch]$ManualStart)
$ErrorActionPreference = 'Stop'
if($FollowCodex -and $ManualStart){throw 'Choose only one startup mode.'}
$node = (Get-Command node.exe -ErrorAction Stop).Source
& $node --disable-warning=ExperimentalWarning -e "require('node:sqlite'); if(typeof WebSocket!=='function') process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw 'Node.js 22.13 or newer with node:sqlite and WebSocket is required.' }
$dir = Join-Path $env:LOCALAPPDATA 'CodexCapsule'
$files = @('capsule.mjs','cdp.mjs','metrics.mjs','content.mjs','tokenizer.cjs','renderer.js','start-codex.ps1','follow-codex.ps1','uninstall.ps1')
foreach ($f in $files) { if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot $f))) { throw "Missing $f" } }
[void][IO.Directory]::CreateDirectory($dir)
$freshInstall=!(Test-Path -LiteralPath (Join-Path $dir 'capsule.mjs'))
$status = Join-Path $dir 'status.json'
$signal = Join-Path $dir 'stop.signal'
if (Test-Path -LiteralPath $status) {
    $old = Get-Content -Raw -LiteralPath $status | ConvertFrom-Json
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$old.pid)" -ErrorAction SilentlyContinue
    if ($owner -and $owner.CommandLine.Contains((Join-Path $dir 'capsule.mjs'))) {
        [IO.File]::WriteAllText($signal,'stop')
        Wait-Process -Id $old.pid -Timeout 45 -ErrorAction SilentlyContinue
        if (Get-Process -Id $old.pid -ErrorAction SilentlyContinue) { throw 'Previous Capsule instance did not stop.' }
    }
}
if(Test-Path -LiteralPath $signal){Remove-Item -LiteralPath $signal}
foreach ($f in $files) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $f) -Destination (Join-Path $dir $f) -Force }
$followFlag=Join-Path $dir 'follow.enabled'
if($ManualStart){if(Test-Path -LiteralPath $followFlag){Remove-Item -LiteralPath $followFlag}}
elseif($FollowCodex -or $freshInstall){[IO.File]::WriteAllText($followFlag,'')}
$main = Join-Path $dir 'capsule.mjs'
$launcher = Join-Path $dir 'launch.vbs'
$line = 'CreateObject("WScript.Shell").Run """' + $node + '"" --disable-warning=ExperimentalWarning ""' + $main + '""", 0, False'
[IO.File]::WriteAllText($launcher,$line,[Text.Encoding]::Unicode)
$link = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Capsule.lnk'
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shortcut.Arguments = '"' + $launcher + '"'
$shortcut.WorkingDirectory = $dir
$shortcut.Save()
$menuLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex Capsule.lnk'
$menu = (New-Object -ComObject WScript.Shell).CreateShortcut($menuLink)
$menu.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$menu.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "' + (Join-Path $dir 'start-codex.ps1') + '"'
$menu.WorkingDirectory = $dir
$menu.Description = 'Open Codex with the local Capsule status bar'
$menu.Save()
Start-Process -FilePath $node -ArgumentList @('--disable-warning=ExperimentalWarning',('"' + $main + '"')) -WorkingDirectory $dir -WindowStyle Hidden
Write-Output "Installed Codex Capsule in $dir"
