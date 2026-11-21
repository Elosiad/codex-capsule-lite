import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {pages,connect} from './cdp.mjs';
import {LocalMetrics,threadId} from './metrics.mjs';

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
      const current=new Set(list.map(p=>p.webSocketDebuggerUrl));
      for(const [url,c] of clients){if(!current.has(url)){c.close();clients.delete(url)}}
      for(const p of list){
        if(clients.has(p.webSocketDebuggerUrl))continue;
        const c=await connect(p).catch(()=>null);if(c)clients.set(p.webSocketDebuggerUrl,c);
      }
      nextScan=Date.now()+5000;
    }
    let active=false;
    for(const [url,c] of clients){
      try{
        let id=await c.evaluate(`document.hidden?null:(${api}?${api}.current():(document.querySelector('[data-composer-placement]')?'install':null))`);
        if(id==='install'){await c.evaluate(renderer);id=await c.evaluate(api+'.current()')}
        if(id!=='home'&&!threadId.test(id))continue;
        active=true;
        const data=await metrics.read(id,await c.evaluate(api+"?.wantsContent?.()===true"));
        await c.evaluate(api+'?.apply('+JSON.stringify(id)+','+JSON.stringify(data)+')');
      }catch{c.close();clients.delete(url)}
    }
    await report(active?'active':'waiting');
    await sleep(active?1200:3500);
  }
}finally{
  for(const c of clients.values()){await c.evaluate(api+'?.dispose()').catch(()=>{});c.close()}
  lock.close();await fs.rm(stop,{force:true});await report('stopped');
}
