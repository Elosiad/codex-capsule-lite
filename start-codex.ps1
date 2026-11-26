# Run with Windows PowerShell for the built-in Appx module.
$ErrorActionPreference='Stop'

function Get-CapsuleDesktopExecutable {
    $pkg=Get-AppxPackage -Name OpenAI.Codex | Where-Object { $_.PublisherId -eq '2p2nqsd0c76g0' } | Select-Object -First 1
    if(!$pkg){throw 'Install the official Codex desktop app for this Windows user first.'}
    [xml]$manifest=Get-Content -Raw -LiteralPath (Join-Path $pkg.InstallLocation 'AppxManifest.xml')
    $app=$manifest.Package.Applications.Application | Where-Object {$_.Id -eq 'App'} | Select-Object -First 1
    $exe=(Get-Item -LiteralPath (Join-Path $pkg.InstallLocation $app.Executable)).FullName
    if(!$exe.StartsWith($pkg.InstallLocation+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid Codex package entry.'}
    return $exe
}

function Start-CapsuleDesktop($exe,$stateDir,$profileDir){
    $arguments=@('--remote-debugging-address=127.0.0.1','--remote-debugging-port=0')
    if($profileDir){$arguments+=('--user-data-dir="'+$profileDir+'"')}
    $child=Start-Process -FilePath $exe -ArgumentList $arguments -WindowStyle Normal -PassThru
    for($i=0;$i -lt 40;$i++){
        if($child.HasExited){throw 'Codex returned to an existing instance. Fully quit Codex, then use Codex Capsule again.'}
        $ports=Get-NetTCPConnection -OwningProcess $child.Id -State Listen -ErrorAction SilentlyContinue
        foreach($p in $ports){
            if($p.LocalAddress -ne '127.0.0.1'){continue}
            try{$ver=Invoke-RestMethod "http://127.0.0.1:$($p.LocalPort)/json/version" -TimeoutSec 1 -MaximumRedirection 0}catch{continue}
            $ws=$ver.webSocketDebuggerUrl -as [uri]
            if(!$ws -or $ws.Scheme -ne 'ws' -or $ws.Host -ne '127.0.0.1' -or $ws.Port -ne $p.LocalPort -or $ws.AbsolutePath -notmatch '^/devtools/browser/[a-f0-9-]+$'){continue}
            $state=@{port=$ws.Port;browserPath=$ws.AbsolutePath;pid=$child.Id}
            [void][IO.Directory]::CreateDirectory($stateDir)
            $dest=Join-Path $stateDir 'desktop.json'
            $tmp=$dest+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
            [IO.File]::WriteAllText($tmp,($state|ConvertTo-Json -Compress))
            if([IO.File]::Exists($dest)){[IO.File]::Replace($tmp,$dest,[NullString]::Value)}else{[IO.File]::Move($tmp,$dest)}
            return $state
        }
        Start-Sleep -Milliseconds 350
    }
    throw 'Codex opened but did not provide a local renderer connection.'
}
if($MyInvocation.InvocationName -ne '.'){
    try{
        $exe=Get-CapsuleDesktopExecutable
        $running=Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($exe)) -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq $exe}
        $dir=Join-Path $env:LOCALAPPDATA 'CodexCapsule'
        $launcher=Join-Path $dir 'launch.vbs'
        if(Test-Path -LiteralPath $launcher){Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList ('"'+$launcher+'"') -WindowStyle Hidden}
        if($running){
            foreach($source in @( (Join-Path $dir 'desktop.json'), (Join-Path $env:LOCALAPPDATA 'Woodfish\codex-state.json'), (Join-Path $env:LOCALAPPDATA 'CodexDreamSkin\state.json') )){
                if(![IO.File]::Exists($source)){continue}
                try{
                    $s=Get-Content -Raw -LiteralPath $source|ConvertFrom-Json
                    $listener=Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $s.port -State Listen -ErrorAction Stop
                    if($running.Id -contains $listener.OwningProcess){Start-Process -FilePath $exe -WindowStyle Normal;return}
                }catch{}
            }
            throw 'Please fully quit Codex (including its tray icon), then open Codex Capsule from Start.'
        }
        [void](Start-CapsuleDesktop $exe $dir $null)
    }catch{
        Add-Type -AssemblyName System.Windows.Forms
        [void][Windows.Forms.MessageBox]::Show($_.Exception.Message,'Codex Capsule')
        exit 1
    }
}
