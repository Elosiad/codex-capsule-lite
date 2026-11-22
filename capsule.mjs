import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {pages,connect} from './cdp.mjs';
import {LocalMetrics,threadId,StreamRate} from './metrics.mjs';

const dir=path.join(process.env.LOCALAPPDATA,'CodexCapsule');
await fs.mkdir(dir,{recursive:true});
const stop=path.join(dir,'stop.signal'), status=path.join(dir,'status.json');
const uid=createHash('sha256').update(dir.toLowerCase()).digest('hex').slice(0,20);
// A local named pipe is used solely as a per-user single-instance lock.
const lock=net.createServer(socket=>socket.destroy());
try{await new Promise((ok,no)=>lock.once('error',no).listen('\\\\.\\pipe\\codex-capsule-'+uid,ok))}
catch(e){if(e.code==='EADDRINUSE')process.exit(0);throw e}
const renderer=await fs.readFile(new URL('./renderer.js',import.meta.url),'utf8');
const api="window[Symbol.for('codex-capsule.local.v1')]";
const metrics=new LocalMetrics(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),process.env.APPDATA);
const clients=new Map();let nextScan=0,lastStatus='',closed=false;
const follow=await fs.stat(path.join(dir,'follow.enabled')).then(()=>true,()=>false);
let watcher=null,nextWatch=0;
function followDesktop(){
  if(!follow||watcher||Date.now()<nextWatch)return;
  const powershell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const child=spawn(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',path.join(dir,'follow-codex.ps1')],{
    windowsHide:true,stdio:['pipe','ignore','ignore']
  });
  watcher=child;
  child.stdin.on('error',()=>{});
  child.on('error',()=>{});
  child.once('close',()=>{watcher=null;nextWatch=Date.now()+3000});
}
process.on('SIGTERM',()=>{closed=true});process.on('SIGINT',()=>{closed=true});
async function report(state){
  if(state===lastStatus)return;
  await fs.writeFile(status,JSON.stringify({version:'0.2.0',pid:process.pid,state,updatedAt:new Date().toISOString()}));
  lastStatus=state;
}
try{
  while(!closed){
    if(await fs.stat(stop).then(()=>true,()=>false))break;
    if(Date.now()>=nextScan){
      const list=await pages().catch(()=>[]);
      if(list.length)watcher?.stdin.end();
      else followDesktop();
      const current=new Set(list.map(p=>p.webSocketDebuggerUrl));
      for(const [url,c] of clients){if(!current.has(url)){c.close();clients.delete(url)}}
      for(const p of list){
        if(clients.has(p.webSocketDebuggerUrl))continue;
        const c=await connect(p).catch(()=>null);if(c)clients.set(p.webSocketDebuggerUrl,c);
      }
      nextScan=Date.now()+5000;
    }
    let active=false;const cycle=performance.now();
    for(const [url,c] of clients){
      try{
        let id=await c.evaluate(`document.hidden?null:(${api}?${api}.current():(document.querySelector('[data-composer-placement]')?'install':null))`);
        if(id==='install'){await c.evaluate(renderer);id=await c.evaluate(api+'.current()')}
        if(id!=='home'&&!threadId.test(id)){c.streamRate?.sample(null);continue}
        active=true;
        const data=await metrics.read(id,await c.evaluate(api+"?.wantsContent?.()===true"));
        c.streamRate??=new StreamRate();
        const sample=data.running&&data.turn?await c.evaluate(api+'?.streamSample?.('+[id,data.turn,data.finishedItem,data.sentAt].map(x=>JSON.stringify(x)).join(',')+')'):null;
        if(data.running&&data.ttft==null&&data.sentAt){
          const wait=await c.evaluate(api+'?.observedWait?.('+JSON.stringify(id)+','+JSON.stringify(data.turn)+')');
          if(Number.isFinite(wait)){data.ttft=wait;data.ttftSource='screen'}
        }
        const live=c.streamRate.sample(sample);
        if(live)data.speed=live;
        await c.evaluate(api+'?.apply('+JSON.stringify(id)+','+JSON.stringify(data)+')');
      }catch{c.close();clients.delete(url)}
    }
    await report(active?'active':'waiting');
    await sleep(active?Math.max(100,1000-(performance.now()-cycle)):3500);
  }
}finally{
  if(watcher){
    const child=watcher;
    const stopped=new Promise(resolve=>child.once('close',resolve));
    child.stdin.end();
    await stopped;
  }
  for(const c of clients.values()){await c.evaluate(api+'?.dispose()').catch(()=>{});c.close()}
  lock.close();await fs.rm(stop,{force:true});await report('stopped');
}
