import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {ContentReader} from './content.mjs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);

// One sampler per renderer. Tokenize only newly rendered text; discard each
// window immediately after counting, including on navigation or loss of focus.
export class StreamRate {
  sample(s){
    if(!s || s.reset || this.key!==s.key || s.at-this.lastAt>2800 || s.at<this.lastAt){
      this.key=s?.key;this.start=s?.at;this.lastAt=s?.at;this.pending='';this.rate=null;
      return null;
    }
    this.lastAt=s.at;
    this.pending+=s.delta;
    const elapsed=s.at-this.start;
    if(elapsed>=2950){
      const tokens=this.pending?require('./tokenizer.cjs').countTokens(this.pending,{disallowedSpecial:new Set()}):0;
      this.rate=tokens?{tps:tokens*1000/elapsed,tokens,ms:elapsed,live:true}:null;
      this.start=s.at;this.pending='';
    }
    return this.rate;
  }
}

export const threadId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const positive = n => Number.isFinite(n) && n > 0;
const pct = n => Math.max(0,Math.min(100,n));
const count=n=>Number.isSafeInteger(n)&&n>=0?n:null;

export function contextUsage(info){
  const u=info?.last_token_usage,used=count(u?.total_tokens),max=info?.model_context_window;
  if(used==null||!positive(max))return null;
  const input=count(u.input_tokens),read=count(u.cached_input_tokens),write=count(u.cache_write_input_tokens);
  const output=count(u.output_tokens),reason=count(u.reasoning_output_tokens);
  const validRead=input!=null && read!=null && read<=input;
  const split=validRead && output!=null && reason!=null && output>=reason &&
    info.last_usage_includes_reasoning!==false && used===input+output;
  return {used,max,percent:pct(100*used/max),input,read,write,output,reason,split,
    uncached:validRead?input-read:null,cacheRate:validRead&&input>0?100*read/input:null};
}

// Only return known protocol phrases and numeric codes to the renderer.
// Arbitrary server messages can contain signed URLs, request headers or prompts.
const reasons=[
  [/insufficient_quota|usage_limit_reached|usageLimitExceeded|quota exceeded|quota exhausted|usage limit (?:has been )?reached/i,'额度已用尽','服务报告可用额度已耗尽。请查看额度重置时间。'],
  [/model is at capacity|model is currently at capacity/i,'模型繁忙','所选模型暂时满载。'],
  [/server overloaded|serverOverloaded|service unavailable|\b503\b/i,'服务繁忙','服务端暂时无法接收请求，可稍后再试。'],
  [/rate_limit_exceeded|too many requests|rate limit reached|\b429\b/i,'请求受限','服务端限制了这次请求；可稍后再试。'],
  [/unauthorized|authentication failed|\b401\b/i,'登录验证失败','服务端拒绝了当前凭据，可检查 Codex 登录状态。'],
  [/forbidden|\b403\b/i,'访问被拒绝','服务端拒绝了此请求，请检查当前账号或模型权限。'],
  [/ETIMEDOUT|timed?\s*out|responseStreamTimeout/i,'连接超时','等待响应超过时限。'],
  [/websocket closed by server before response\.completed|ECONNRESET|connection reset by peer|websocket closed|unexpected eof/i,'连接中断','回复传输提前结束，Codex 没有收到完整响应。'],
  [/stream disconnected before completion|responseStreamDisconnected|httpConnectionFailed|responseStreamConnectionFailed/i,'连接中断','与服务的连接未能建立或维持，具体断点未知。'],
  [/\b50[024]\b|internal server error|internalServerError/i,'服务端错误','服务端处理请求时返回了错误。']
];

export function explainFailure(text, phase, at, attempt){
  const msg=String(text||'').slice(-4096);
  for(const [pattern,title,summary] of reasons){
    const hit=msg.match(pattern);
    if(hit)return {title,summary,technical:hit[0],phase,at,attempt};
  }
  return {title:'请求异常',summary:'Codex 报告了请求异常，当前记录未标明可确认的原因。',technical:'',phase,at,attempt};
}

export function retryDiagnostic(body,turn,at){
  if(!threadId.test(turn)||typeof body!=='string')return null;
  const marker=body.lastIndexOf('retrying sampling request');
  if(marker<0)return null;
  const part=body.slice(marker);
  const rowTurn=part.match(/\bturn_id="?([0-9a-f-]{36})/i)?.[1];
  if(rowTurn!==turn)return null;
  const count=part.match(/\bretries=(\d+)\s+max_retries=(\d+)/);
  const failure=explainFailure(part.split('sampling_error=').at(-1),'retry',at,count?count[1]+'/'+count[2]:'');
  const delay=part.match(/\bin\s+(\d+(?:\.\d+)?)(ms|s)\)/);
  if(delay)failure.retryAt=at+Math.round(Number(delay[1])*(delay[2]==='s'?1000:1));
  return failure;
}

export function summarizeRecord(state, rec, id) {
  if(rec.type!=='event_msg')return;
  const e=rec.payload;
  if(!e || (e.thread_id && e.thread_id!==id))return;
  const at=Date.parse(rec.timestamp)||0;
  switch(e.type){
    case 'task_started':
      if(e.turn_id&&state.turn===e.turn_id)break;
      state.turn=e.turn_id;
      state.turnOutput=null;
      state.speed=null;
      state.finishedItem=null;
      state.ttft=null;
      state.ttftSource=null;state.sentAt=null;state.firstTextSeen=false;
      state.running=true;
      state.startedAt=at;state.progressAt=0;state.failure=null;
      break;
    case 'stream_error':
    case 'error': {
      if(state.turn && e.turn_id && state.turn!==e.turn_id)return;
      const info=e.codex_error_info??e.codexErrorInfo;
      const retry=e.type==='stream_error'||e.will_retry===true||e.willRetry===true;
      state.failure=explainFailure([e.message,e.additional_details,JSON.stringify(info)].join(' '),retry?'retry':'failed',at);
      break;
    }
    case 'task_complete':
      if(state.turn && e.turn_id && state.turn!==e.turn_id)return;
      state.running=false;
      if(state.failure?.phase==='retry'||(state.failure?.at&&state.progressAt>state.failure.at))state.failure=null;
      if(state.ttft==null&&positive(e.time_to_first_token_ms)){
        state.ttft=e.time_to_first_token_ms;state.ttftSource='official';
      }
      break;
    case 'turn_aborted':
      if(!state.turn||!e.turn_id||state.turn===e.turn_id){state.running=false;state.failure=null}
      break;
    case 'item_completed': {
      if(state.turn&&e.turn_id&&e.turn_id!==state.turn)return;
      if(e.item?.type==='UserMessage'){
        if(state.turn&&state.running&&!state.sentAt&&!state.firstTextSeen&&positive(e.started_at_ms))state.sentAt=e.started_at_ms;
        return;
      }
      if(e.item?.type!=='AgentMessage')return;
      const hasText=positive(e.content_token_count)||e.item.content?.some?.(p=>typeof p?.text==='string'&&p.text.trim());
      if(hasText&&!state.firstTextSeen){
        state.firstTextSeen=true;
        if(positive(state.sentAt)&&e.started_at_ms>=state.sentAt && e.started_at_ms<=e.completed_at_ms){
          state.ttft=e.started_at_ms-state.sentAt;state.ttftSource='message';
        }
      }
      state.progressAt=Math.max(state.progressAt||0,at);
      state.finishedItem=e.item.id??null;
      if(state.failure?.phase==='retry')state.failure=null;
      const ms=e.completed_at_ms-e.started_at_ms;
      state.speed=positive(e.started_at_ms)&&positive(ms)&&positive(e.content_token_count)
        ? {tokens:e.content_token_count,ms,tps:1000*e.content_token_count/ms}:null;
      break;
    }
    case 'token_count': {
      if(e.turn_id&&state.turn&&e.turn_id!==state.turn)return;
      const total=count(e.info?.total_token_usage?.output_tokens);
      const last=count(e.info?.last_token_usage?.output_tokens);
      if(total!=null){
        const prior=state.outputWatermark;
        const delta=prior!=null&&total>=prior?total-prior:last;
        if((state.running||(e.turn_id&&e.turn_id===state.turn))&&state.turn&&delta!=null){
          state.turnOutput=(state.turnOutput??0)+delta;
        }
        state.outputWatermark=total;
      }
      const context=contextUsage(e.info);
      if(context)state.context=context;
      const q=e.rate_limits;
      if(q&&(!q.limit_id||q.limit_id==='codex')){
        const windows=[q.primary,q.secondary].filter(w=>Number.isFinite(w?.used_percent)).map(w=>({
          minutes:w.window_minutes,remaining:pct(100-w.used_percent),reset:w.resets_at*1000
        }));
        if(windows.length||q.credits)state.quota={plan:q.plan_type,windows,credits:q.credits,at:Date.parse(rec.timestamp),source:'当前聊天记录'};
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
  const c=sample?.credits,raw=c?.balance,has=c?.has_credits??c?.hasCredits;
  const printable=(typeof raw==='string'&&raw.trim()!==''&&raw.length<=64)||Number.isFinite(raw);
  const unit=typeof c?.unit==='string'?c.unit.trim():'';
  const balance=printable && (has===true || (has==null&&Number(raw)>0)) && c?.unlimited!==true
    ? [String(raw),unit].filter(Boolean).join(' '):null;
  return {plan,windows,balance,at:sample?.at??null,source:sample?.source??null};
}

// Ignore huge image/tool records without ever retaining their contents.
const CHUNK=256*1024, MAX_LINE=512*1024, TAIL=3*1024*1024;
// A tool result can push the beginning of the active turn out of the tail.
// On cold reads find its boundary and the preceding usage snapshot. Inspect
// compact JSONL headers only; giant attachment lines are skipped by consume.
async function initialOffset(fd,size){
  if(size<=TAIL)return 0;
  const normal=size-TAIL;
  let turnStart=null,next=Buffer.alloc(0);
  for(let end=size;end>0;){
    const start=Math.max(0,end-CHUNK),left=Math.max(0,start-1);
    const block=Buffer.alloc(end-left);
    if((await fd.read(block,0,block.length,left)).bytesRead!==block.length)return 0;
    const bytes=Buffer.concat([block,next]);
    // One preceding byte and 256 following bytes cover straddling headers.
    const headers=bytes.toString('latin1').matchAll(/(?:^|\n)(\{"timestamp":"[^"\n]{8,40}",(?:"ordinal":\d+,)?"type":"event_msg","payload":\{"type":"(task_started|token_count)")/g);
    for(const match of [...headers].reverse()){
      const pos=match.index+(match[0][0]==='\n'?1:0);
      const absolute=left+pos;
      if(absolute<start||absolute>=end)continue;
      if(turnStart==null){
        if(match[2]==='task_started')turnStart=absolute;
      }else if(match[2]==='token_count'&&!bytes.toString('latin1',pos,pos+256).includes('"info":null')){
        return Math.min(normal,absolute);
      }
    }
    next=block.subarray(start-left,start-left+256);end=start;
  }
  return turnStart==null?normal:Math.min(normal,turnStart);
}
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
    this.content=new ContentReader();
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
      if(entry.ino!==st.ino||entry.offset>st.size){
        entry.offset=await initialOffset(fd,st.size);entry.partial=Buffer.alloc(0);
        const preceding=Buffer.alloc(1);
        if(entry.offset>0)await fd.read(preceding,0,1,entry.offset-1);
        entry.skip=entry.offset>0&&preceding[0]!==10;entry.state={};entry.ino=st.ino;
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
      if((b?.windows?.length||b?.credits) && positive(q.capturedAt))
        this.snapshotValue={at:q.capturedAt,plan:r.account?.planType||b.plan,source:'龙娘额度快照',
          credits:b.credits,windows:(b.windows||[]).map(w=>({minutes:w.minutes,remaining:w.remaining,reset:w.resetsAt}))};
    }catch{}
    return this.snapshotValue;
  }
  async read(id,wantContent=false){
    let s={};
    try{s=await this.session(id)}catch{this.entries.delete(id)}
    const snapshot=await this.snapshot();
    const q=snapshot&&(!s.quota||snapshot.at>=s.quota.at)?snapshot:s.quota;
    const retry=s.running&&s.turn?await this.retry(id,s):null;
    const failure=s.failure && (!retry||s.failure.at>=retry.at||s.failure.phase==='failed')?s.failure:retry;
    const composition=wantContent?await this.content.get(this.entries.get(id)?.file):null;
    return {speed:s.speed??null,turn:s.turn??null,turnOutput:s.turnOutput??null,sentAt:s.sentAt??null,finishedItem:s.finishedItem??null,ttft:s.ttft??null,ttftSource:s.ttftSource??null,running:s.running===true,context:s.context??null,composition,quota:quotaView(q),failure};
  }
  async retry(id,s){
    const entry=this.entries.get(id);
    if(!entry||!s.startedAt)return null;
    if(entry.checkedTurn!==s.turn||!(Date.now()<entry.nextCheck)){
      if(entry.checkedTurn!==s.turn){entry.retry=null;entry.lastLogId=0}
      entry.checkedTurn=s.turn;entry.nextCheck=Date.now()+3000;
      try{
        if(!this.logsFile){
          const files=(await fs.readdir(this.home)).filter(n=>/^logs_\d+\.sqlite$/.test(n));
          this.logsFile=files.sort((a,b)=>parseInt(b.slice(5))-parseInt(a.slice(5)))[0];
        }
        if(!this.logsFile)return null;
        const db=new DatabaseSync(path.join(this.home,this.logsFile),{readOnly:true,timeout:150});
        try{
          const high=db.prepare('SELECT max(id) AS n FROM logs').get().n||0;
          if(high<(entry.lastLogId||0))entry.lastLogId=0;
          if(high!==(entry.lastLogId||0)){
            const rows=db.prepare(`SELECT ts,ts_nanos,substr(feedback_log_body,-4096) AS body FROM logs
              WHERE thread_id=? AND ts BETWEEN ? AND ? AND id>? AND id<=? AND target='codex_core::responses_retry'
              ORDER BY ts DESC,ts_nanos DESC LIMIT 12`).all(id,Math.floor(s.startedAt/1000),Math.floor(Date.now()/1000),entry.lastLogId||0,high);
            for(const row of rows){
            const at=row.ts*1000+Math.floor(row.ts_nanos/1e6);
            const candidate=retryDiagnostic(row.body,s.turn,at);
            if(candidate){entry.retry=candidate;break}
            }
            entry.lastLogId=high;
          }
        }finally{db.close()}
      }catch{this.logsFile=null}
    }
    return entry.retry && entry.retry.at>(s.progressAt||0)?entry.retry:null;
  }
}
