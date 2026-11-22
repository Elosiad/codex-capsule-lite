$ErrorActionPreference='Stop'
$dir=Join-Path $env:LOCALAPPDATA 'CodexCapsule'
$link=Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Capsule.lnk'
if(Test-Path -LiteralPath $link){Remove-Item -LiteralPath $link}
$menu=Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex Capsule.lnk'
if(Test-Path -LiteralPath $menu){Remove-Item -LiteralPath $menu}
if(!(Test-Path -LiteralPath $dir)){return}
$status=Join-Path $dir 'status.json'
$signal=Join-Path $dir 'stop.signal'
if(Test-Path -LiteralPath $status){
    $old=Get-Content -Raw -LiteralPath $status|ConvertFrom-Json
    $owner=Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$old.pid)" -ErrorAction SilentlyContinue
    if($owner -and $owner.CommandLine.Contains((Join-Path $dir 'capsule.mjs'))){
        [IO.File]::WriteAllText($signal,'stop')
        Wait-Process -Id $old.pid -Timeout 45 -ErrorAction SilentlyContinue
        if(Get-Process -Id $old.pid -ErrorAction SilentlyContinue){throw 'Capsule has not stopped yet.'}
    }
}
foreach($f in 'capsule.mjs','cdp.mjs','metrics.mjs','content.mjs','tokenizer.cjs','renderer.js','launch.vbs','status.json','desktop.json','start-codex.ps1','follow-codex.ps1','follow.enabled','stop.signal','uninstall.ps1'){
    $file=Join-Path $dir $f
    if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file}
}
if(!(Get-ChildItem -LiteralPath $dir -Force)){[IO.Directory]::Delete($dir)}
