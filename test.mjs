import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {scanContent} from './content.mjs';
import {quotaView,summarizeRecord,retryDiagnostic,explainFailure,contextUsage,StreamRate,LocalMetrics} from './metrics.mjs';
const windows=[{minutes:300,remaining:42,reset:3000},{minutes:10080,remaining:68,reset:9000}];
test('parallel and reused agent turns count once under their root, including split writes',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capsule-agents-'));
  const uuid=n=>'a0000000-0000-4000-8000-'+String(n).padStart(12,'0');
  const [parent,root,a,b,t1,t2,t3,other]=Array.from({length:8},(_,i)=>uuid(i+1));
  const db=new DatabaseSync(path.join(dir,'thread_history_1.sqlite'));
  const file=id=>path.join(dir,id+'.jsonl');
  const rec=(second,type,payload)=>JSON.stringify({timestamp:new Date(second*1000).toISOString(),type,payload})+'\n';
  const usage=(agent,turn,total,r=root)=>rec(108,'token_usage_record',{thread_id:agent,turn_id:turn,root_turn_id:r,turn_token_usage:{output_tokens:total}});
  try{
    db.exec('CREATE TABLE thread_turns(thread_id,turn_id,root_turn_id,rollout_byte_offset,rollout_end_byte_offset)');
    const add=db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?)');
    const lines=usage(a,t1,30)+usage(a,t1,30)+usage(a,t1,999,other)+usage(b,t1,999);
    await fs.writeFile(file(a),lines+usage(a,t3,15));
    add.run(a,t1,root,0,lines.length);add.run(a,t3,root,lines.length,(await fs.stat(file(a))).size);
    const split=usage(b,t2,50);await fs.writeFile(file(b),split.slice(0,-4));add.run(b,t2,root,0,null);
    await fs.writeFile(file(parent),rec(100,'event_msg',{type:'task_started',turn_id:root})+
      rec(101,'event_msg',{type:'item_completed',thread_id:parent,turn_id:root,item:{type:'SubAgentActivity',agent_thread_id:a}})+
      rec(109,'event_msg',{type:'token_count',info:{total_token_usage:{output_tokens:100},last_token_usage:{output_tokens:100}}})+
      rec(110,'event_msg',{type:'task_complete',turn_id:root}));
    const m=new LocalMetrics(dir,dir);m.logPath=async id=>file(id);
    assert.equal((await m.read(parent)).turnOutput,145);
    await fs.appendFile(file(b),split.slice(-4));
    db.prepare('UPDATE thread_turns SET rollout_end_byte_offset=? WHERE thread_id=?').run(split.length,b);
    m.entries.get(parent).family.next=0;
    const both=await m.read(parent);
    assert.equal(both.agentCount,2);assert.equal(both.agentOutput,95);
    assert.equal(both.speed.tps,19.5);assert.equal((await m.read(parent)).turnOutput,195);
    await fs.appendFile(file(parent),rec(120,'event_msg',{type:'task_started',turn_id:other}));
    assert.equal((await m.read(parent)).agentCount,0);
  }finally{db.close();await fs.rm(dir,{recursive:true,force:true})}
});
test('an open chat follows its indexed rollout segment without mixing another thread',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capsule-segment-'));
  const id='a0000000-0000-4000-8000-000000000001',segment='b0000000-0000-4000-8000-000000000002';
  const sessions=path.join(dir,'sessions'),prefix=path.join(sessions,'rollout-2026-11-23T01-23-08-');
  const original=prefix+id+'.jsonl',next=prefix+id+'_'+segment+'.jsonl';
  const db=new DatabaseSync(path.join(dir,'state_5.sqlite'));
  const row=(type,body)=>JSON.stringify({timestamp:'2026-11-22T17:30:17Z',type:'event_msg',payload:{type,...body}})+'\n';
  try{
    await fs.mkdir(sessions);
    await fs.writeFile(original,row('task_started',{turn_id:'previous'}));
    await fs.writeFile(next,row('task_started',{turn_id:'current'})+row('token_count',{info:{total_token_usage:{output_tokens:999},last_token_usage:{output_tokens:42}}}));
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT)');
    const put=db.prepare('INSERT OR REPLACE INTO threads VALUES(?,?)');
    put.run(id,original);
    const reader=new LocalMetrics(dir,dir);
    assert.equal((await reader.session(id)).turn,'previous');
    put.run(id,next);
    assert.equal((await reader.logPath(id)),await fs.realpath(next));
    reader.entries.get(id).nextPathCheck=0;
    const current=await reader.session(id);
    assert.equal(current.turn,'current');assert.equal(current.turnOutput,42);
    put.run(segment,next);
    assert.equal(await reader.logPath(segment),null);
  }finally{db.close();await fs.rm(dir,{recursive:true,force:true})}
});
test('whole-turn output survives restart beyond the normal log tail; duplicates, tools and other turns do not inflate it',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capsule-output-')),file=path.join(dir,'test.jsonl');
  const id='a0000000-0000-4000-8000-000000000001';
  const ev=(type,body={})=>JSON.stringify({timestamp:'2026-11-22T01:01:00Z',ordinal:1,type:'event_msg',payload:{type,...body}})+'\n';
  const usage=(total,last,extra={})=>ev('token_count',{info:{total_token_usage:{output_tokens:total},last_token_usage:{output_tokens:last,reasoning_output_tokens:1}},...extra});
  const reader=()=>{const m=new LocalMetrics(dir,dir);m.logPath=async()=>file;return m};
  try{
    await fs.writeFile(file,usage(1200,45)+ev('task_started',{turn_id:'t'})+usage(1200,45)+usage(1250,50));
    const m=reader();assert.equal((await m.session(id)).turnOutput,50);
    await fs.appendFile(file,ev('item_completed',{item:{type:'CommandExecution',output:'a'.repeat(4*1024*1024)}})+usage(1250,50)+usage(9000,100,{thread_id:'other'})+usage(8000,200,{turn_id:'other'})+usage(1320,70)+ev('task_complete',{turn_id:'t'}));
    assert.equal((await m.session(id)).turnOutput,120);
    assert.equal((await reader().session(id)).turnOutput,120);
    await fs.appendFile(file,ev('task_started',{turn_id:'new'})+ev('token_count',{info:null}));
    assert.equal((await m.session(id)).turnOutput,null);
    await fs.appendFile(file,usage(1332,12)+ev('task_started',{turn_id:'new'})+usage(4,4)+usage(4,4)+ev('turn_aborted',{turn_id:'new'}));
    assert.equal((await m.session(id)).turnOutput,16);
  }finally{await fs.unlink(file);await fs.rmdir(dir)}
});
test('first commentary counts, empty reasoning and tool events do not; later messages cannot replace it',()=>{
  const s={},send=(type,payload={})=>summarizeRecord(s,{type:'event_msg',payload:{type,turn_id:'t',...payload}},'A');
  const item=(type,at,extra={})=>send('item_completed',{started_at_ms:at,completed_at_ms:at+100,item:{type,...extra}});
  send('task_started');item('UserMessage',1000);item('Reasoning',1500);item('CommandExecution',1800);
  item('AgentMessage',2200,{content:[]});assert.equal(s.ttft,null);
  item('AgentMessage',4655,{phase:'commentary',content:[{text:'我来查一下'}]});assert.equal(s.ttft,3655);assert.equal(s.ttftSource,'message');
  item('UserMessage',6000);item('AgentMessage',7000,{phase:'final',content:[{text:'好了'}]});
  send('task_complete',{time_to_first_token_ms:3751});assert.equal(s.ttft,3655);
  send('task_started',{turn_id:'next'});assert.equal(s.ttft,null);
});
test('first nonempty public summary is timed independently of speed; raw reasoning and empty summaries are ignored',()=>{
  const s={},send=(type,body={})=>summarizeRecord(s,{type:'event_msg',payload:{type,turn_id:'t',...body}},'A');
  const completed=(type,start,fields)=>send('item_completed',{started_at_ms:start,completed_at_ms:start+100,item:{type,...fields}});
  send('task_started');completed('UserMessage',1000,{});
  completed('Reasoning',1200,{raw_content:['private'],summary_text:[' ']});assert.equal(s.ttft,null);
  completed('Reasoning',1450,{summary_text:['public']});assert.equal(s.ttft,450);assert.equal(s.ttftSource,'summary');assert.equal(s.speed,null);
  completed('AgentMessage',6000,{content:[{text:'hello'}]});send('task_complete',{time_to_first_token_ms:3500});assert.equal(s.ttft,450);
});
test('tool input is timed from model creation to completed call, with a pending state before parameters arrive',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capsule-tool-')),file=path.join(dir,'log.jsonl');
  const id='a0000000-0000-4000-8000-000000000001',turn='b0000000-0000-4000-8000-000000000001';
  const start=Math.floor(Date.now()/1000)*1000-9000;
  const rec=(at,type,payload)=>JSON.stringify({timestamp:new Date(at).toISOString(),type,payload})+'\n';
  const tool=(kind,key,args)=>({type:kind,id:key,status:'completed',[kind==='function_call'?'arguments':'input']:args,internal_chat_message_metadata_passthrough:{turn_id:turn,create_time:(start+1000)/1000}});
  const db=new DatabaseSync(path.join(dir,'logs_2.sqlite'));
  try{
    db.exec('CREATE TABLE logs(id INTEGER PRIMARY KEY,thread_id TEXT,ts INTEGER,ts_nanos INTEGER,target TEXT,feedback_log_body TEXT)');
    db.prepare('INSERT INTO logs VALUES(1,?,?,0,?,?)').run(id,start/1000+1,'codex_core::stream_events_utils','run{turn_id='+turn+'}: Output item item_type="custom_tool_call" item_id="ctc_1"');
    await fs.writeFile(file,rec(start,'event_msg',{type:'task_started',turn_id:turn}));
    const m=new LocalMetrics(dir,dir);m.logPath=async()=>file;
    const pending=(await m.read(id)).speed;assert.equal(pending.kind,'toolPending');assert(pending.ms>=6000);
    const call=tool('custom_tool_call','ctc_1','hello world');
    await fs.appendFile(file,rec(start+3000,'response_item',call));
    m.entries.get(id).nextSpeed=0;
    const speed=(await m.read(id)).speed;assert.deepEqual(speed,{kind:'tool',tokens:2,ms:2000,tps:1});
    await fs.appendFile(file,rec(start+4000,'response_item',call)+rec(start+5000,'response_item',{type:'custom_tool_call_output',output:'x'.repeat(5000)})+
      rec(start+5500,'event_msg',{type:'item_completed',turn_id:turn,item:{type:'CommandExecution'}}));
    assert.deepEqual((await m.session(id)).speed,speed);assert.equal((await m.read(id)).turnOutput,null);
    await fs.appendFile(file,rec(start+7000,'response_item',tool('function_call','fc_2','hello'))+
      rec(start+8000,'response_item',{...tool('function_call','fc_other','ignored'),internal_chat_message_metadata_passthrough:{turn_id:'other',create_time:start/1000}}));
    assert.equal((await m.session(id)).speed.ms,6000);
    await fs.appendFile(file,rec(start+9000,'event_msg',{type:'task_started',turn_id:'new'}));
    assert.equal((await m.read(id)).speed,null);
  }finally{db.close();await fs.rm(file,{force:true});await fs.unlink(path.join(dir,'logs_2.sqlite'));await fs.rmdir(dir)}
});
test('live speed uses timed additions, clears on idle and resets on item/turn changes',()=>{
  const rate=new StreamRate();
  const tick=(at,delta='',key='thread/turn/item')=>rate.sample({at,delta,key});
  assert.equal(tick(0,'historical text'),null);
  assert.equal(tick(1000,'hello'),null);tick(2000,' world');
  const first=tick(3000,'!');
  assert.equal(first.live,true);assert.equal(first.tokens,3);assert.equal(first.tps,1);
  tick(4000);tick(5000);assert.equal(tick(6000),null);
  tick(7000,'resume');assert.equal(tick(8000,'old','threadB/turn/item'),null);
  assert.equal(rate.sample(null),null);assert.equal(tick(9000,'history'),null);
  assert.equal(tick(14000,'after suspend'),null);
});
test('balance preserves the reported amount and unit; no credits or unknown amounts stay hidden',()=>{
  assert.equal(quotaView({credits:{has_credits:true,balance:'35.50'}}).balance,'35.50');
  assert.equal(quotaView({credits:{hasCredits:true,balance:4,unit:'credits'}}).balance,'4 credits');
  assert.equal(quotaView({credits:{hasCredits:false,balance:'0'}}).balance,null);
  assert.equal(quotaView({credits:{has_credits:true,balance:null}}).balance,null);
});
test('content counts the last checkpoint, images once and appended records only',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capsule-content-')),file=path.join(dir,'log.jsonl');
  const msg=(role,content)=>({type:'message',role,content});
  const rec=(type,payload)=>JSON.stringify({timestamp:'2026-01-01T00:00:00Z',type,payload})+'\n';
  const user=msg('user',[{type:'input_text',text:'hello'},{type:'input_image',image_url:'data:image/png;base64,AA=='}]);
  try{
    await fs.writeFile(file,rec('response_item',user)+rec('compacted',{replacement_history:[user]})+rec('response_item',{type:'reasoning',encrypted_content:'hidden'}));
    const a=await scanContent(file);assert.equal(a.stats.images,1);assert.equal(a.stats.text.user,1);assert.equal(a.stats.opaque,1);
    await fs.appendFile(file,rec('response_item',user)+rec('response_item',{type:'function_call_output',output:[{type:'input_text',text:'hello'},{type:'input_file'}]}));
    const b=await scanContent(file,a);assert.equal(b.stats.images,2);assert.equal(b.stats.text.results,1);assert.equal(b.stats.files,1);
    await fs.appendFile(file,rec('compacted',{replacement_history:[user]}));
    assert.equal((await scanContent(file,b)).stats.images,1);
    assert.equal((await scanContent(file)).stats.images,1);
  }finally{await fs.unlink(file);await fs.rmdir(dir)}
});
test('context breakdown is additive and missing fields stay unknown',()=>{
  const u={input_tokens:150000,cached_input_tokens:142500,cache_write_input_tokens:2000,output_tokens:10000,reasoning_output_tokens:4000,total_tokens:160000};
  const get=(v)=>contextUsage({model_context_window:512000,last_token_usage:v});
  const c=get(u);
  assert.equal(c.cacheRate,95);assert.equal(c.uncached,7500);assert.equal(c.split,true);
  assert.equal(c.uncached+c.read+c.reason+(c.output-c.reason),c.used);
  assert.equal(get({...u,cached_input_tokens:undefined}).cacheRate,null);
  assert.equal(get({...u,reasoning_output_tokens:11000}).split,false);
});
test('Plus shows actual five-hour and weekly windows; Pro hides five-hour window',()=>{
  assert.deepEqual(quotaView({plan:'plus',windows},1000).windows.map(w=>w.remaining),[42,68]);
  assert.deepEqual(quotaView({plan:'pro',windows},1000).windows.map(w=>w.minutes),[10080]);
  assert.deepEqual(quotaView({plan:'plus',windows:windows.slice(1)},1000).windows.map(w=>w.minutes),[10080]);
  assert.equal(quotaView({plan:'plus',windows},3000).windows[0].remaining,null);
});
test('stream wrapper respects the specific cause, retry count and turn identity',()=>{
  const turn='10000000-0000-4000-8000-000000000001';
  const prefix='stream disconnected - retrying sampling request (1/5 in 187ms)... turn_id='+turn+' retries=1 max_retries=5 sampling_error=';
  const lost=retryDiagnostic(prefix+'stream disconnected before completion: websocket closed by server before response.completed',turn,12);
  assert.equal(lost.title,'连接中断');assert.equal(lost.attempt,'1/5');assert.equal(lost.phase,'retry');
  assert.match(lost.technical,/websocket/);
  assert.equal(retryDiagnostic(prefix+'Selected model is at capacity.',turn,12).title,'模型繁忙');
  assert.equal(lost.retryAt,199);
  assert.equal(retryDiagnostic(prefix.replace('187ms','309.9932304s')+'Selected model is at capacity.',turn,12).retryAt,310005);
  assert.equal(retryDiagnostic(prefix+'429',turn.replace(/1$/,'2'),12),null);
  assert.equal(explainFailure('HTTP 429','failed',12).title,'请求受限');
  assert.equal(explainFailure('HTTP 429 insufficient_quota','failed',12).title,'额度已用尽');
  assert.equal(explainFailure('unknown response with private user text','failed',12).technical,'');
});
test('wrapped transport causes take priority and reconnect wording follows the phase',()=>{
  const wrapper='stream disconnected before completion: ';
  const limit='Responses websocket connection limit reached (60 minutes)';
  const retry=explainFailure(wrapper+limit+'. Create a new websocket connection to continue.','retry',1);
  assert.equal(retry.summary,'连接已满 60 分钟，Codex 正在自动重连');
  assert.equal(retry.technical,limit);
  const state={turn:'t'};
  summarizeRecord(state,{type:'event_msg',payload:{type:'error',turn_id:'t',additionalDetails:limit}},'chat');
  assert.equal(state.failure.phase,'failed');assert.equal(state.failure.title,retry.title);
  assert.doesNotMatch(state.failure.summary,/正在自动重连/);
  summarizeRecord(state,{type:'event_msg',payload:{type:'stream_error',turn_id:'t',will_retry:false,message:limit}},'chat');
  assert.equal(state.failure.phase,'failed');assert.doesNotMatch(state.failure.summary,/正在自动重连/);
  for(const [reason,title] of [['HTTP 502','服务端错误'],['HTTP 504','服务端错误'],['HTTP 503','服务繁忙'],['ECONNREFUSED','连接被拒绝'],['ENOTFOUND','域名解析失败'],['ETIMEDOUT','连接超时'],['HTTP 401','登录验证失败'],['HTTP 403','访问被拒绝'],['HTTP 429','请求受限'],['insufficient_quota','额度已用尽']]){
    assert.equal(explainFailure(wrapper+reason,'retry',1).title,title,reason);
  }
  assert.match(explainFailure(wrapper+'unrecognized detail','retry',1).summary,/具体断点未知/);
});
test('long SQLite retry records retain the turn and cause without exposing raw details',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capsule-retry-')),file=path.join(dir,'logs_2.sqlite');
  const turn='10000000-0000-4000-8000-000000000001',time=Math.floor(Date.now()/1000);
  try{
    const db=new DatabaseSync(file);
    try{
      db.exec('CREATE TABLE logs(id INTEGER PRIMARY KEY,thread_id TEXT,ts INTEGER,ts_nanos INTEGER,target TEXT,feedback_log_body TEXT)');
      const body='retrying sampling request (1/5 in 185ms)... turn_id='+turn+' retries=1 max_retries=5 sampling_error=stream disconnected before completion: Responses websocket connection limit reached (60 minutes). '+ 'private'.repeat(800);
      db.prepare('INSERT INTO logs VALUES(1,?,?,0,?,?)').run('chat',time,'codex_core::responses_retry',body);
    }finally{db.close()}
    const m=new LocalMetrics(dir,dir);m.entries.set('chat',{});
    const failure=await m.retry('chat',{turn,startedAt:time*1000});
    assert.equal(failure?.summary,'连接已满 60 分钟，Codex 正在自动重连');
    assert.equal(failure.attempt,'1/5');assert.equal(failure.retryAt,time*1000+185);
    assert.doesNotMatch(JSON.stringify(failure),/private/);
  }finally{await fs.unlink(file);await fs.rmdir(dir)}
});
test('retry clears on resumed output, a new turn or cancellation; terminal error is distinct',()=>{
  const s={},send=(type,data={})=>summarizeRecord(s,{type:'event_msg',timestamp:'2026-11-22T01:00:00Z',payload:{type,turn_id:'t',...data}},'A');
  send('task_started');send('stream_error',{message:'ECONNRESET'});assert.equal(s.failure.phase,'retry');
  send('item_completed',{item:{type:'AgentMessage'}});assert.equal(s.failure,null);
  send('error',{message:'HTTP 401'});assert.equal(s.failure.phase,'failed');
  send('task_started',{turn_id:'new'});assert.equal(s.failure,null);
  send('error',{message:'HTTP 429'});assert.equal(s.failure,null);
  send('turn_aborted',{turn_id:'new'});assert.equal(s.failure,null);
});
test('speed uses completed assistant text and TTFT belongs to its turn',()=>{
  const state={},id='A',send=(type,payload)=>summarizeRecord(state,{type:'event_msg',payload:{type,...payload}},id);
  send('task_started',{turn_id:'t'});
  const item={thread_id:id,turn_id:'t',item:{type:'AgentMessage'},content_token_count:60,started_at_ms:100,completed_at_ms:2100};
  send('item_completed',{...item,thread_id:'B'});assert.ok(!state.speed);
  send('item_completed',{...item,item:{type:'CommandExecution'}});assert.ok(!state.speed);
  send('item_completed',item);assert.equal(state.speed.tps,30);
  send('task_complete',{turn_id:'old',time_to_first_token_ms:999});assert.equal(state.ttft,null);
  send('task_complete',{turn_id:'t',time_to_first_token_ms:2010});assert.equal(state.ttft,2010);
  send('task_started',{turn_id:'next'});assert.equal(state.ttft,null);assert.equal(state.speed,null);
});
