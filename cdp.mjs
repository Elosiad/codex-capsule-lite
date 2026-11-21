import fs from 'node:fs/promises';
import path from 'node:path';

// Use only the running local Woodfish renderer endpoint. Never open a port.
export async function pages() {
  const state = JSON.parse(await fs.readFile(path.join(process.env.LOCALAPPDATA,'Woodfish','codex-state.json'),'utf8'));
  if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535) throw Error('Invalid local renderer port');
  const endpoint = new URL('http://127.0.0.1:'+state.port);
  const response = await fetch(new URL('/json/list',endpoint), {signal:AbortSignal.timeout(2000),redirect:'error'});
  const list=await response.json();
  return list.filter(p=>{
    if(p.type!=='page'||!/^app:\/\/-\//.test(p.url)) return false;
    const ws=new URL(p.webSocketDebuggerUrl);
    return ws.protocol==='ws:' && ws.hostname==='127.0.0.1' && ws.port===endpoint.port;
  });
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
