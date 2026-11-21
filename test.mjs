import test from 'node:test';
import assert from 'node:assert/strict';
import {quotaView,summarizeRecord} from './metrics.mjs';
const windows=[{minutes:300,remaining:42,reset:3000},{minutes:10080,remaining:68,reset:9000}];
test('Plus shows actual five-hour and weekly windows; Pro hides five-hour window',()=>{
  assert.deepEqual(quotaView({plan:'plus',windows},1000).windows.map(w=>w.remaining),[42,68]);
  assert.deepEqual(quotaView({plan:'pro',windows},1000).windows.map(w=>w.minutes),[10080]);
  assert.deepEqual(quotaView({plan:'plus',windows:windows.slice(1)},1000).windows.map(w=>w.minutes),[10080]);
  assert.equal(quotaView({plan:'plus',windows},3000).windows[0].remaining,null);
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
