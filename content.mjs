import fs from 'node:fs/promises';
import {isMainThread,parentPort,Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';

let tokenizer;
const require=createRequire(import.meta.url);
const empty=()=>({text:{},images:0,files:0,audio:0,opaque:0,unknown:0,partial:false});
function addText(stats,key,value){
  if(typeof value!=='string'||!value)return;
  // Embedded binary data is never tokenized as if it had been typed out.
  const text=value.replace(/data:[\w.+/-]+;base64,[\w+/=\r\n]+/g,' ');
  tokenizer??=require('./tokenizer.cjs');
  let n=0;
  for(let i=0;i<text.length;i+=32768)
    n+=tokenizer.countTokens(text.slice(i,i+32768),{disallowedSpecial:new Set()});
  stats.text[key]=(stats.text[key]||0)+n;
}
function parts(s,key,values){
  if(typeof values==='string')return addText(s,key,values);
  if(!Array.isArray(values))return;
  for(const v of values){
    if(!v)continue;
    if(typeof v==='string')addText(s,key,v);
    else if(['input_image','image','image_url','output_image'].includes(v.type))s.images++;
    else if(['input_file','file'].includes(v.type))s.files++;
    else if(['input_audio','audio','output_audio'].includes(v.type))s.audio++;
    else if(typeof v.text==='string')addText(s,key,v.text);
    else s.unknown++;
  }
}
export function item(s,o){
  if(!o)return;
  switch(o.type){
    case 'message':{
      const key={developer:'instructions',system:'instructions',assistant:'assistant',user:'user'}[o.role]||'other';
      parts(s,key,o.content);break;
    }
    case 'reasoning':parts(s,'reason',o.summary);if(o.encrypted_content)s.opaque++;break;
    case 'compaction':if(o.encrypted_content)s.opaque++;parts(s,'summary',o.content);break;
    case 'function_call':case 'custom_tool_call':addText(s,'calls',o.arguments??o.input);break;
    case 'function_call_output':case 'custom_tool_call_output':parts(s,'results',o.output);break;
    case 'additional_tools':if(o.tools)addText(s,'tools',JSON.stringify(o.tools));break;
    default:s.unknown++;
  }
}
const block=1024*1024,limit=64*block;
// Find the latest replacement checkpoint without parsing all previous turns.
async function checkpoint(fd,size){
  let following=Buffer.alloc(0);
  for(let end=size;end>0;){
    const start=Math.max(0,end-block),buf=Buffer.alloc(end-start);
    await fd.read(buf,0,buf.length,start);
    const scan=Buffer.concat([buf,following]).toString('latin1');
    const matches=[...scan.matchAll(/(?:^|\n)(\{"timestamp":"[^"\n]{8,40}","type":"compacted","payload":)/g)];
    for(const m of matches.reverse()){
      const pos=m.index+(m[0].startsWith('\n')?1:0);
      if(pos<buf.length)return start+pos;
    }
    following=buf.subarray(0,192);end=start;
  }
  return 0;
}
export async function scanContent(file,prev){
  const fd=await fs.open(file,'r');
  try{
    const stat=await fd.stat(),same=prev&&prev.ino===stat.ino&&prev.offset<=stat.size;
    let offset=same?prev.offset:await checkpoint(fd,stat.size),s=same?prev.stats:empty();
    let cursor=offset,chunks=[],length=0,oversize=false;
    while(cursor<stat.size){
      const buf=Buffer.allocUnsafe(Math.min(block,stat.size-cursor));
      const {bytesRead:n}=await fd.read(buf,0,buf.length,cursor);if(!n)break;
      for(let at=0;at<n;){
        const nl=buf.subarray(at,n).indexOf(10),end=nl<0?n:at+nl;
        length+=end-at;
        if(length>limit){oversize=true;chunks=[]}
        else chunks.push(buf.subarray(at,end));
        if(nl<0)break;
        if(oversize){s=empty();s.partial=true}
        else{
          const line=chunks.length===1?chunks[0]:Buffer.concat(chunks,length);
          const prefix=line.subarray(0,180).toString();
          try{
            if(prefix.includes('"type":"compacted"')){
              const o=JSON.parse(line).payload;s=empty();
              if(Array.isArray(o.replacement_history))for(const r of o.replacement_history)item(s,r);
              else{addText(s,'summary',o.message);s.partial=true}
            }else if(prefix.includes('"type":"response_item"'))item(s,JSON.parse(line).payload);
            else if(prefix.includes('"type":"thread_rolled_back"')){s=empty();s.partial=true}
          }catch{s.partial=true}
        }
        offset=cursor+end+1;at=end+1;chunks=[];length=0;oversize=false;
      }
      cursor+=n;
    }
    return {offset,ino:stat.ino,stats:s};
  }finally{await fd.close()}
}
if(!isMainThread){
  parentPort.once('message',async({file,prev})=>{
    try{parentPort.postMessage(await scanContent(file,prev))}
    catch{parentPort.postMessage(null)}
  });
}
// Count on demand, off the UI and polling threads. Keep only aggregate counts.
export class ContentReader{
  cache=new Map();pending=false;
  async get(file){
    if(!file)return null;
    const st=await fs.stat(file).catch(()=>null);if(!st)return null;
    const old=this.cache.get(file);
    if(!this.pending&&(!old||(old.result?.offset!==st.size||old.result?.ino!==st.ino)&&Date.now()-old.checked>10000)){
      this.pending=true;
      const worker=new Worker(new URL('./content.mjs',import.meta.url),{execArgv:[]});
      const record={result:old?.result,checked:Date.now()};this.cache.set(file,record);
      if(this.cache.size>8)this.cache.delete(this.cache.keys().next().value);
      worker.once('message',r=>{if(r)record.result=r});
      worker.once('error',()=>{});worker.once('exit',()=>{this.pending=false});
      worker.postMessage({file,prev:old?.result});
    }
    return this.cache.get(file)?.result?.stats??null;
  }
}
