import test from 'node:test';
import assert from 'node:assert/strict';
import {quotaView,summarizeRecord,retryDiagnostic,explainFailure,contextUsage} from './metrics.mjs';
const windows=[{minutes:300,remaining:42,reset:3000},{minutes:10080,remaining:68,reset:9000}];
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
