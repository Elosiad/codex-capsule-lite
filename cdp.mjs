import fs from 'node:fs/promises';
import path from 'node:path';

async function readPages(file,mode) {
  const state = JSON.parse(await fs.readFile(file,'utf8'));
  if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535) throw Error('Invalid local renderer port');
  const endpoint = new URL('http://127.0.0.1:'+state.port);
  if(mode==='own'){
    if(!Number.isInteger(state.pid)||state.pid<=0||!/^\/devtools\/browser\/[a-f0-9-]+$/.test(state.browserPath))return [];
    process.kill(state.pid,0);
    const v=await fetch(new URL('/json/version',endpoint),{signal:AbortSignal.timeout(1500),redirect:'error'});
    if((await v.json()).webSocketDebuggerUrl!=='ws://'+endpoint.host+state.browserPath)return [];
  }else if(mode==='dreamskin'){
    if(!Number.isInteger(state.codexPid)||state.codexPid<=0||!/^[a-f0-9-]+$/i.test(state.browserId||''))return [];
    process.kill(state.codexPid,0);
    const v=await fetch(new URL('/json/version',endpoint),{signal:AbortSignal.timeout(1500),redirect:'error'});
    if((await v.json()).webSocketDebuggerUrl!==`ws://${endpoint.host}/devtools/browser/${state.browserId}`)return [];
  }
  const response = await fetch(new URL('/json/list',endpoint), {signal:AbortSignal.timeout(2000),redirect:'error'});
  const list=await response.json();
  return list.filter(p=>{
    if(p.type!=='page'||!/^app:\/\/-\//.test(p.url)) return false;
    const ws=new URL(p.webSocketDebuggerUrl);
    return ws.protocol==='ws:' && ws.hostname==='127.0.0.1' && ws.port===endpoint.port;
  });
}

export async function pages(base=process.env.LOCALAPPDATA){
  const own=await readPages(path.join(base,'CodexCapsule','desktop.json'),'own').catch(()=>[]);
  if(own.length)return own;
  const woodfish=await readPages(path.join(base,'Woodfish','codex-state.json'),'woodfish').catch(()=>[]);
  if(woodfish.length)return woodfish;
  return readPages(path.join(base,'CodexDreamSkin','state.json'),'dreamskin').catch(()=>[]);
}

export async function connect(page) {
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ws.close();reject(Error('Renderer timeout'))},2500);
    ws.onopen=()=>{clearTimeout(timer);resolve()};
    ws.onerror=()=>{clearTimeout(timer);reject(Error('Renderer unavailable'))};
  });
  const pending=new Map();
  let sequence=0;
  ws.onmessage=({data})=>{
    const message=JSON.parse(data);
    const task=pending.get(message.id);
    if(!task)return;
    pending.delete(message.id);clearTimeout(task.timer);
    if(message.error)task.reject(Error(message.error.message));else task.resolve(message.result);
  };
  ws.onclose=()=>{for(const task of pending.values()){clearTimeout(task.timer);task.reject(Error('Renderer closed'))}pending.clear()};
  function call(method,params={}){
    return new Promise((resolve,reject)=>{
      if(ws.readyState!==1)return reject(Error('Renderer unavailable'));
      const id=++sequence;
      const timer=setTimeout(()=>{pending.delete(id);reject(Error('Renderer timeout'))},3000);
      pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));
    });
  }
  async function evaluate(expression){
    const result=await call('Runtime.evaluate',{expression,returnByValue:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return result.result.value;
  }
  return {call,evaluate,close:()=>ws.close()};
}
