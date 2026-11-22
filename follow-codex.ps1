# Watches only while the renderer is unavailable. The parent's stdin pipe
# closes on service shutdown, including when the service exits unexpectedly.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'start-codex.ps1')

function Test-CapsuleWoodfishDaemon($base){
    try{
        $state=Get-Content -Raw -LiteralPath (Join-Path $base 'Woodfish\codex-daemon.json') | ConvertFrom-Json
        $daemon=Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.pid)"
        return ($daemon -and [IO.Path]::GetFileName($daemon.ExecutablePath) -ieq 'woodfish.exe' -and
            $daemon.CommandLine -match '(?i)\s+codex\s+daemon(?:\s|$)' -and $daemon.SessionId -eq $session)
    }catch{return $false}
}

function Test-CapsulePlainLaunch($command,$exe){
    if(!$command){return $false}
    $plain=$command.Trim()
    return ($plain -ieq $exe -or $plain -ieq ('"'+$exe+'"'))
}

function Invoke-CapsuleFreshStart($process,$exe,$stateDir){
    # Pin the process handle before checking its identity. A PID can be reused.
    $null=$process.Handle
    $born=$process.StartTime.ToUniversalTime()
    if($process.SessionId -ne $session -or $process.Path -ine $exe -or $born -lt $startedAfter){return}
    $record=Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)"
    if(!$record -or $record.ExecutablePath -ine $exe -or !(Test-CapsulePlainLaunch $record.CommandLine $exe)){return}
    $owner=Invoke-CimMethod -InputObject $record -MethodName GetOwnerSid
    if($owner.ReturnValue -ne 0 -or $owner.Sid -ne $userSid){return}
    if(Test-CapsuleWoodfishDaemon $env:LOCALAPPDATA){return}
    # A second click on the taskbar may start a short-lived forwarding process.
    # Leave it to Electron if the application already has an older instance.
    foreach($other in [Diagnostics.Process]::GetProcessesByName($process.ProcessName)){
        try{if($other.Id -ne $process.Id -and $other.SessionId -eq $session -and
            $other.Path -ieq $exe -and $other.StartTime.ToUniversalTime() -lt $born){return}}
        finally{$other.Dispose()}
    }
    $process.Refresh()
    if($end.IsCompleted -or $process.HasExited -or ([DateTime]::UtcNow-$born).TotalSeconds -gt 8){return}
    if($process.MainWindowHandle -ne [IntPtr]::Zero){
        # A visible window may already contain work. Respect its normal quit
        # handling, including a close veto or a minimize-to-tray preference.
        if(!$process.CloseMainWindow() -or !$process.WaitForExit(2500)){return}
    }else{
        $process.Kill()
        if(!$process.WaitForExit(5000)){return}
    }
    [void](Start-CapsuleDesktop $exe $stateDir $null)
    return $true
}

if($MyInvocation.InvocationName -ne '.'){
    $session=[Diagnostics.Process]::GetCurrentProcess().SessionId
    $userSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $startedAfter=[DateTime]::UtcNow.AddSeconds(-8)
    $stateDir=Join-Path $env:LOCALAPPDATA 'CodexCapsule'
    $inputPipe=[IO.StreamReader]::new([Console]::OpenStandardInput())
    $end=$inputPipe.ReadLineAsync()
    $seen=@{}
    while(!$end.IsCompleted){
        $now=[DateTime]::UtcNow
        foreach($key in @($seen.Keys)){if(($now-$seen[$key]).TotalSeconds -gt 15){$seen.Remove($key)}}
        foreach($name in 'ChatGPT','Codex'){
            foreach($p in [Diagnostics.Process]::GetProcessesByName($name)){
                try{
                    $born=$p.StartTime.ToUniversalTime()
                    if($p.SessionId -ne $session -or $born -lt $startedAfter -or ($now-$born).TotalSeconds -gt 8){continue}
                    $key="$($p.Id)/$($born.Ticks)"
                    if($seen.ContainsKey($key)){continue}
                    $seen[$key]=$born
                    # Most Codex-named processes are CLI tools. Resolve the
                    # registered desktop package only for plausible app starts.
                    if($p.Path -notmatch '[\\/]OpenAI\.Codex_[^\\/]+_2p2nqsd0c76g0[\\/]'){continue}
                    if($null -eq $desktop -or $desktop -ine $p.Path){$desktop=Get-CapsuleDesktopExecutable}
                    if(Invoke-CapsuleFreshStart $p $desktop $stateDir){return}
                }catch{if($p.HasExited -eq $false){Write-Verbose $_.Exception.Message}}
                finally{$p.Dispose()}
            }
        }
        [void]$end.Wait(950)
    }
}
