$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -ErrorAction Stop).Source
& $node --disable-warning=ExperimentalWarning -e "require('node:sqlite'); if(typeof WebSocket!=='function') process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw 'Node.js 22.13 or newer with node:sqlite and WebSocket is required.' }
$dir = Join-Path $env:LOCALAPPDATA 'CodexCapsule'
$files = @('capsule.mjs','cdp.mjs','metrics.mjs','renderer.js','uninstall.ps1')
foreach ($f in $files) { if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot $f))) { throw "Missing $f" } }
[void][IO.Directory]::CreateDirectory($dir)
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
Start-Process -FilePath $node -ArgumentList @('--disable-warning=ExperimentalWarning',('"' + $main + '"')) -WorkingDirectory $dir -WindowStyle Hidden
Write-Output "Installed Codex Capsule in $dir"
