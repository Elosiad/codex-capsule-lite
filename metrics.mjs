import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

export const threadId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const positive = n => Number.isFinite(n) && n > 0;
const pct = n => Math.max(0,Math.min(100,n));

export function summarizeRecord(state, rec, id) {
  if(rec.type!=='event_msg')return;
  const e=rec.payload;
  if(!e || (e.thread_id && e.thread_id!==id))return;
  switch(e.type){
    case 'task_started':
      state.turn=e.turn_id;
      state.speed=null;
      state.ttft=null;
      state.running=true;
      break;
    case 'task_complete':
      if(state.turn && e.turn_id && state.turn!==e.turn_id)return;
      state.running=false;
      state.ttft=positive(e.time_to_first_token_ms)?e.time_to_first_token_ms:null;
      break;
    case 'turn_aborted':
      if(!state.turn||!e.turn_id||state.turn===e.turn_id)state.running=false;
      break;
    case 'item_completed': {
      if(e.item?.type!=='AgentMessage'||(state.turn&&e.turn_id&&e.turn_id!==state.turn))return;
      const ms=e.completed_at_ms-e.started_at_ms;
      state.speed=positive(e.started_at_ms)&&positive(ms)&&positive(e.content_token_count)
        ? {tokens:e.content_token_count,ms,tps:1000*e.content_token_count/ms}:null;
      break;
    }
    case 'token_count': {
      const info=e.info, used=info?.last_token_usage?.total_tokens, max=info?.model_context_window;
      if(Number.isFinite(used)&&used>=0&&positive(max))state.context={used,max,percent:pct(100*used/max)};
      const q=e.rate_limits;
      if(q&&(!q.limit_id||q.limit_id==='codex')){
        const windows=[q.primary,q.secondary].filter(w=>Number.isFinite(w?.used_percent)).map(w=>({
          minutes:w.window_minutes,remaining:pct(100-w.used_percent),reset:w.resets_at*1000
        }));
        if(windows.length)state.quota={plan:q.plan_type,windows,at:Date.parse(rec.timestamp),source:'当前聊天记录'};
      }
      break;
    }
  }
}

export function quotaView(sample, now=Date.now()){
  const plan=String(sample?.plan||'').toLowerCase();
  const windows=(sample?.windows||[]).filter(w=>
    Number.isFinite(w.remaining) && (w.minutes===10080 || (w.minutes===300 && /^plus(?:$|[_ -])/.test(plan)))
  ).map(w=>({...w,remaining:positive(w.reset)&&w.reset<=now?null:pct(w.remaining)}))
   .sort((a,b)=>a.minutes-b.minutes);
  return {plan,windows,at:sample?.at??null,source:sample?.source??null};
}

// Ignore huge image/tool records without ever retaining their contents.
const CHUNK=256*1024, MAX_LINE=512*1024, TAIL=3*1024*1024;
function consume(entry,buffer,id){
  let pos=0;
  while(pos<buffer.length){
    const nl=buffer.indexOf(10,pos),end=nl<0?buffer.length:nl;
    if(!entry.skip){
      if(entry.partial.length+end-pos>MAX_LINE){entry.skip=true;entry.partial=Buffer.alloc(0)}
      else entry.partial=Buffer.concat([entry.partial,buffer.subarray(pos,end)]);
    }
    if(nl<0)break;
    if(!entry.skip && entry.partial.includes('"event_msg"')){
      try{summarizeRecord(entry.state,JSON.parse(entry.partial.toString()),id)}catch{}
    }
    entry.partial=Buffer.alloc(0);entry.skip=false;pos=nl+1;
  }
}

export class LocalMetrics {
  constructor(home,appData){
    this.home=path.resolve(home);
    this.appData=appData;
    this.entries=new Map();
  }
  async logPath(id){
    const names=(await fs.readdir(this.home)).filter(n=>/^state_\d+\.sqlite$/.test(n))
      .sort((a,b)=>parseInt(b.slice(6))-parseInt(a.slice(6)));
    if(!names.length)return null;
    const db=new DatabaseSync(path.join(this.home,names[0]),{readOnly:true,timeout:500});
    let row;
    try{row=db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(id)}finally{db.close()}
    if(!row?.rollout_path)return null;
    const file=await fs.realpath(row.rollout_path);
    const rel=path.relative(await fs.realpath(this.home),file);
    if(!/^(sessions|archived_sessions)[\\/]/i.test(rel)||!path.basename(file).toLowerCase().endsWith(id.toLowerCase()+'.jsonl'))return null;
    return file;
  }
  async session(id){
    if(!threadId.test(id))return {};
    let entry=this.entries.get(id);
    if(!entry){
      const file=await this.logPath(id);if(!file)return {};
      entry={file,offset:0,partial:Buffer.alloc(0),skip:false,state:{}};
      if(this.entries.size>=12)this.entries.delete(this.entries.keys().next().value);
      this.entries.set(id,entry);
    }
    const fd=await fs.open(entry.file,'r');
    try{
      const st=await fd.stat();
      if(entry.ino!==st.ino||entry.offset>st.size||st.size-entry.offset>TAIL){
        entry.offset=Math.max(0,st.size-TAIL);entry.partial=Buffer.alloc(0);
        entry.skip=entry.offset>0;entry.state={};entry.ino=st.ino;
      }
      const buf=Buffer.allocUnsafe(Math.min(CHUNK,st.size-entry.offset));
      while(entry.offset<st.size){
        const {bytesRead}=await fd.read(buf,0,Math.min(buf.length,st.size-entry.offset),entry.offset);
        if(!bytesRead)break;
        consume(entry,buf.subarray(0,bytesRead),id);entry.offset+=bytesRead;
      }
      return entry.state;
    }finally{await fd.close()}
  }
  async snapshot(){
    if(Date.now()<(this.nextSnapshot||0))return this.snapshotValue;
    this.nextSnapshot=Date.now()+5000;
    this.snapshotValue=null;
    try{
      const key=createHash('sha256').update(await fs.realpath(this.home)).digest('hex').slice(0,20);
      const raw=JSON.parse(await fs.readFile(path.join(this.appData,'Codex DragonGirl','snapshots.json'),'utf8'));
      const r=raw.readings?.[key],q=r?.quota,b=q?.buckets?.find(b=>b.id==='codex');
      if(b?.windows?.length && positive(q.capturedAt))
        this.snapshotValue={at:q.capturedAt,plan:r.account?.planType||b.plan,source:'龙娘额度快照',
          windows:b.windows.map(w=>({minutes:w.minutes,remaining:w.remaining,reset:w.resetsAt}))};
    }catch{}
    return this.snapshotValue;
  }
  async read(id){
    let s={};
    try{s=await this.session(id)}catch{this.entries.delete(id)}
    const snapshot=await this.snapshot();
    const q=snapshot&&(!s.quota||snapshot.at>=s.quota.at)?snapshot:s.quota;
    return {speed:s.speed??null,ttft:s.ttft??null,running:s.running===true,context:s.context??null,quota:quotaView(q)};
  }
}
