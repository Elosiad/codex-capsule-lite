import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {scanContent} from './content.mjs';
import {quotaView,summarizeRecord,retryDiagnostic,explainFailure,contextUsage,StreamRate,LocalMetrics} from './metrics.mjs';
const windows=[{minutes:300,remaining:42,reset:3000},{minutes:10080,remaining:68,reset:9000}];
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
test('first commentary counts, tool and reasoning events do not; later messages cannot replace it',()=>{
  const s={},send=(type,payload={})=>summarizeRecord(s,{type:'event_msg',payload:{type,turn_id:'t',...payload}},'A');
  const item=(type,at,extra={})=>send('item_completed',{started_at_ms:at,completed_at_ms:at+100,item:{type,...extra}});
  send('task_started');item('UserMessage',1000);item('Reasoning',1500);item('CommandExecution',1800);
  item('AgentMessage',2200,{content:[]});assert.equal(s.ttft,null);
  item('AgentMessage',4655,{phase:'commentary',content:[{text:'我来查一下'}]});assert.equal(s.ttft,3655);assert.equal(s.ttftSource,'message');
  item('UserMessage',6000);item('AgentMessage',7000,{phase:'final',content:[{text:'好了'}]});
  send('task_complete',{time_to_first_token_ms:3751});assert.equal(s.ttft,3655);
  send('task_started',{turn_id:'next'});assert.equal(s.ttft,null);
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
