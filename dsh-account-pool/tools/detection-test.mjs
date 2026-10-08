import assert from 'node:assert/strict';
import { createPoolAdapter } from '../lib/adapter.js';
import { createHttpUpstream, upstreamError } from '../lib/upstream.js';
import { DEFAULT_POOL_DETECTION_KEYWORDS, matchesPoolDetection, poolDetectionConfig, rememberDetectionText } from '../lib/detection.js';

const T0=Date.parse('2026-10-06T00:00:00Z');
const account=(id='a',extra={})=>({id,label:id,platform:'anthropic',status:'active',schedulable:true,priority:100,
  concurrency:1,models:[],groups:['g'],consecutiveFailures:0,poolDetectionRetry:true,
  poolDetectionRetries:2,poolDetectionRetryDelayMs:100,...extra});
const options={provider:'pool-g',model:'fixture-model',sessionId:'fixture-session',messages:[{role:'user',content:[{type:'text',text:'fixture'}]}]};
const binding={sessionHash:options.sessionId,accountId:'a',platform:'anthropic',boundAt:new Date(T0).toISOString(),expiresAt:new Date(T0+600000).toISOString()};
const hit=(status=503,message='号池不可用，请稍后重试')=>Object.assign(new Error(message),{status,code:`http-${status}`});
const collect=async(iterable)=>{const result=[];for await(const chunk of iterable)result.push(chunk);return result;};
const success=()=> (async function*(){yield {type:'text-delta',index:0,text:'OK'};yield {type:'finish',reason:{kind:'stop'}};})();
const exhausted=e=>e.code==='POOL_DETECTION_RETRY_EXHAUSTED'&&!e.cause&&!e.message.includes('号池不可用');
const partial=e=>e.code==='POOL_DETECTION_PARTIAL_RESPONSE'&&!e.cause;
function setup({members=[account()],stream,wait=async()=>{},mode='sticky',random=()=>0,initialBindings=[binding],...extra}={}){
  const cooled=[],usage=[],writes=[],drops=[];
  const pool=createPoolAdapter({initialAccounts:members,initialGroups:[{id:'g',models:[],selectionMode:mode}],initialBindings,
    upstream:{stream},clock:{now:()=>T0},detectionWait:wait,random,
    onCooldown:event=>cooled.push(event),onUsage:event=>usage.push(event),
    persist:{putAccount:row=>writes.push(row),deleteBinding:key=>drops.push(key)},...extra});
  return {pool,cooled,usage,writes,drops};
}
function untouched(state,id='a'){
  const row=state.pool.getAccount(id);assert.equal(row.consecutiveFailures,0);
  for(const field of ['tempUnschedulableUntil','overloadUntil','rateLimitResetAt'])assert.ok(!row[field]);
  assert.deepEqual(state.cooled,[]);assert.deepEqual(state.drops,[]);
}
const sse=(rows)=>new Response(rows.map(row=>`data: ${typeof row==='string'?row:JSON.stringify(row)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
const anthropicSuccess=[{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'OK'}},{type:'message_delta',delta:{stop_reason:'end_turn'}},{type:'message_stop'}];
const openaiSuccess=[{choices:[{delta:{content:'OK'},finish_reason:'stop'}]},'[DONE]'];
let checks=0;
const quick = process.argv.includes('--quick');
const quickCases = new Set([
  'HTTP 503 detection retries same account without cooling',
  'off/no keyword retains ordinary 429 cooldown and failover (true)',
  'bounded exhaustion leaves account, binding and alternatives intact (retries=2)',
  'any yielded chunk prevents duplicate output and detection never cools partial responses',
  'cancel during real retry wait promptly stops and releases concurrency',
  'account probe applies settings consistently and returns only safe exhaustion information',
]);
async function check(label,fn){if(quick&&!quickCases.has(label))return;await fn();quickCases.delete(label);checks++;console.log('ok '+label);}

await check('default, bounded settings and literal case-insensitive matching',async()=>{
  assert.deepEqual(DEFAULT_POOL_DETECTION_KEYWORDS,['号池检测','池检测','号池不可用']);
  assert.equal(poolDetectionConfig({}).enabled,false);assert.equal(poolDetectionConfig({}).retries,2);
  assert.equal(poolDetectionConfig({poolDetectionRetries:999,poolDetectionRetryDelayMs:-1}).retries,5);
  assert.equal(poolDetectionConfig({poolDetectionRetryDelayMs:-1}).delayMs,100);
  assert.equal(poolDetectionConfig({poolDetectionRetryDelayMs:99999}).delayMs,10000);
  assert.equal(matchesPoolDetection(hit(),account()),true);assert.equal(matchesPoolDetection(hit(403,'不可用'),account()),false);
  assert.equal(matchesPoolDetection(hit(429,'ordinary quota exceeded'),account()),false);
  assert.equal(matchesPoolDetection(hit(),account('a',{poolDetectionRetry:false})),false);
  assert.equal(matchesPoolDetection(hit(403,'PROBE [WAIT]'),account('a',{poolDetectionKeywords:['probe [wait]']})),true);
  assert.equal(matchesPoolDetection(hit(403,'probe w'),account('a',{poolDetectionKeywords:['probe [wait]']})),false);
  assert.equal(matchesPoolDetection(hit(),account('a',{poolDetectionKeywords:[]})),false);
  assert.equal(matchesPoolDetection(hit(),account('a',{poolDetectionKeywords:['  ']})),false);
});
await check('bounded hidden HTTP error body can match beyond truncated display message without serialization',async()=>{
  const text=JSON.stringify({error:{message:'x'.repeat(600)},note:'号池不可用',secret:'fixture-secret'});
  const error=upstreamError(new Response('',{status:503}),text);
  assert.equal(error.message.includes('号池不可用'),false);assert.equal(matchesPoolDetection(error,account()),true);
  assert.equal(JSON.stringify(error).includes('fixture-secret'),false);
  assert.equal(matchesPoolDetection(rememberDetectionText(new Error('ordinary'), 'x'.repeat(8192)+'号池检测'),account()),false);
});
for(const status of [429,503,403])await check(`HTTP ${status} detection retries same account without cooling`,async()=>{
  let requests=0;const sent=[];const waits=[];
  const transport=createHttpUpstream({resolveCredential:()=> 'fixture-secret',fetchImpl:async(url,init)=>{
    requests++;sent.push({url,headers:init.headers,body:init.body});
    return requests===1?new Response(JSON.stringify({error:{message:'号池不可用，稍后再试'}}),{status}):sse(anthropicSuccess);
  }});
  const state=setup({stream:transport.stream,wait:async(ms)=>waits.push(ms)});const out=await collect(state.pool.stream(options));
  assert.equal(out.filter(x=>x.type==='text-delta').map(x=>x.text).join(''),'OK');assert.equal(requests,2);
  assert.deepEqual(sent[0],sent[1],'Request body and identity are unchanged');assert.deepEqual(waits,[100]);
  untouched(state);assert.equal(state.pool.getBinding(options.sessionId).accountId,'a');assert.equal(state.usage.at(-1).switches,0);assert.equal(state.pool.inflightSnapshot().size,0);
});
for(const platform of ['anthropic','openai'])await check(`${platform} SSE error original message retries before output`,async()=>{
  let requests=0;const transport=createHttpUpstream({resolveCredential:()=> 'fixture-secret',fetchImpl:async()=>{
    requests++;return requests===1?sse([{type:'error',error:{type:'rate_limit_error',message:'正在号池检测，请稍后'}}]):sse(platform==='anthropic'?anthropicSuccess:openaiSuccess);
  }});
  const state=setup({members:[account('a',{platform})],stream:transport.stream});
  assert.equal((await collect(state.pool.stream(options))).filter(x=>x.type==='text-delta').map(x=>x.text).join(''),'OK');
  assert.equal(requests,2);untouched(state);assert.equal(state.pool.inflightSnapshot().size,0);
});
for(const [enabled,message] of [[false,'号池不可用'],[true,'ordinary quota exceeded']])await check(`off/no keyword retains ordinary 429 cooldown and failover (${enabled})`,async()=>{
  const calls=[];const state=setup({members:[account('a',{poolDetectionRetry:enabled}),account('b')],stream(row){calls.push(row.id);if(row.id==='a')throw hit(429,message);return success();}});
  await collect(state.pool.stream(options));assert.deepEqual(calls,['a','b']);assert.equal(state.cooled.length,1);
  assert.ok(state.pool.getAccount('a').rateLimitResetAt);assert.deepEqual(state.drops,[options.sessionId]);assert.equal(state.pool.getBinding(options.sessionId).accountId,'b');
});
for(const retries of [0,1,2,5,99])await check(`bounded exhaustion leaves account, binding and alternatives intact (retries=${retries})`,async()=>{
  const calls=[];let waits=0;const state=setup({members:[account('a',{poolDetectionRetries:retries}),account('b')],stream(row){calls.push(row.id);throw hit();},wait:async()=>{waits++;}});
  await assert.rejects(()=>collect(state.pool.stream(options)),exhausted);
  const limit=Math.min(5,retries);assert.equal(calls.length,limit+1);assert.ok(calls.every(id=>id==='a'));assert.equal(waits,limit);
  untouched(state);assert.deepEqual(state.pool.getBinding(options.sessionId),binding);assert.equal(state.writes.length,0);
  assert.equal(state.usage.length,1);assert.equal(state.usage[0].errorCode,'POOL_DETECTION_RETRY_EXHAUSTED');assert.equal(state.pool.inflightSnapshot().size,0);
});
await check('weighted group pins detected account even when new draws choose other member',async()=>{
  let draws=0;const calls=[];const state=setup({mode:'weighted-random',initialBindings:[],members:[account('a',{weight:100}),account('b',{weight:100})],random:()=>draws++===0?0:0.99,
    stream(row){calls.push(row.id);if(calls.length<3)throw hit();return success();}});
  await collect(state.pool.stream(options));assert.deepEqual(calls,['a','a','a']);assert.equal(draws,1);untouched(state);assert.equal(state.pool.getBinding(options.sessionId),undefined);
});
await check('ordinary failure after detection resumes existing policy and mixed-account failover',async()=>{
  const calls=[];const state=setup({members:[account(),account('b')],stream(row){calls.push(row.id);if(calls.length===1)throw hit();if(row.id==='a')throw hit(429,'quota exceeded');return success();}});
  await collect(state.pool.stream(options));assert.deepEqual(calls,['a','a','b']);assert.equal(state.cooled.length,1);assert.equal(state.usage.at(-1).switches,1);
});
await check('any yielded chunk prevents duplicate output and detection never cools partial responses',async()=>{
  let calls=0;const state=setup({stream(){calls++;return(async function*(){yield {type:'text-delta',text:'partial',index:0};throw hit();})();}});
  const received=[];await assert.rejects(async()=>{for await(const chunk of state.pool.stream(options))received.push(chunk);},partial);
  assert.equal(calls,1);assert.deepEqual(received,[{type:'text-delta',text:'partial',index:0}]);untouched(state);assert.equal(state.pool.inflightSnapshot().size,0);
});
for(const platform of ['anthropic','openai'])await check(`${platform} SSE detection after partial output stops without retry or cooling`,async()=>{
  let calls=0;const transport=createHttpUpstream({resolveCredential:()=> 'fixture-secret',fetchImpl:async()=>{calls++;return sse(platform==='anthropic'?
    [anthropicSuccess[0],anthropicSuccess[1],{type:'error',error:{type:'overloaded_error',message:'号池不可用'}}]:
    [{choices:[{delta:{content:'OK'}}]},{error:{message:'池检测',status:503}}]);}});
  const state=setup({members:[account('a',{platform})],stream:transport.stream});const out=[];
  await assert.rejects(async()=>{for await(const chunk of state.pool.stream(options))out.push(chunk);},partial);
  assert.equal(out.filter(x=>x.type==='text-delta').map(x=>x.text).join(''),'OK');assert.equal(calls,1);untouched(state);
});
await check('usage-only output is committed; terminal detection error before any yield may retry',async()=>{
  let calls=0;const state=setup({stream(){calls++;return(async function*(){if(calls===1)yield {type:'finish',reason:{kind:'error',failure:hit()}};else yield* success();})();}});
  await collect(state.pool.stream(options));assert.equal(calls,2);untouched(state);
  const usageState=setup({stream(){return(async function*(){yield {type:'usage',usage:{inputTokens:1}};throw hit();})();}});
  await assert.rejects(()=>collect(usageState.pool.stream(options)),partial);untouched(usageState);
});
await check('cancel during real retry wait promptly stops and releases concurrency',async()=>{
  const ctrl=new AbortController();let entered;const waiting=new Promise(resolve=>{entered=resolve;});let calls=0;
  const {waitForPoolDetection}=await import('../lib/detection.js');
  const realState=setup({members:[account('a',{poolDetectionRetryDelayMs:10000})],wait:(ms,signal)=>{entered();return waitForPoolDetection(ms,signal);},stream(){calls++;throw hit();}});
  const pending=collect(realState.pool.stream({...options,signal:ctrl.signal}));await waiting;ctrl.abort();
  await assert.rejects(()=>pending,e=>e.name==='AbortError');assert.equal(calls,1);untouched(realState);assert.equal(realState.pool.inflightSnapshot().size,0);
});
await check('AbortError mentioning detection does not retry without a supplied signal',async()=>{
  let calls=0;const state=setup({stream(){calls++;throw Object.assign(new Error('号池检测'),{name:'AbortError'});}});
  await assert.rejects(()=>collect(state.pool.stream(options)),e=>e.name==='AbortError');assert.equal(calls,1);untouched(state);
});
await check('slot remains reserved while waiting and is available after successful retry',async()=>{
  let resume;let waiting;const entered=new Promise(resolve=>{waiting=resolve;});let calls=0;
  const state=setup({stream(){calls++;if(calls===1)throw hit();return success();},wait:async()=>{waiting();await new Promise(resolve=>{resume=resolve;});}});
  const pending=collect(state.pool.stream(options));await entered;assert.equal(state.pool.inflightSnapshot().get('a'),1);
  await assert.rejects(()=>collect(state.pool.stream({...options,sessionId:'other'})),e=>e.code==='POOL_EXHAUSTED');
  resume();await pending;assert.equal(calls,2);assert.equal(state.pool.inflightSnapshot().size,0);
  await collect(state.pool.stream({...options,sessionId:'third'}));assert.equal(calls,3);assert.equal(state.pool.inflightSnapshot().size,0);
});
for(const edit of ['delete','disable','toggle','model','group','cooldown','keywords','budget'])await check(`latest account edit respected while detection is waiting (${edit})`,async()=>{
  let calls=0;let state;state=setup({stream(){calls++;throw hit();},wait:async()=>{
    if(edit==='delete')state.pool.removeAccount('a');
    else if(edit==='group')state.pool.removeGroup('g');
    else{const row=state.pool.getAccount('a');const update={disable:{status:'disabled'},toggle:{poolDetectionRetry:false},model:{models:['other-model']},cooldown:{tempUnschedulableUntil:new Date(T0+10000).toISOString()},keywords:{poolDetectionKeywords:['unrelated']},budget:{poolDetectionRetries:0}}[edit];state.pool.upsertAccount({...row,...update,label:'edited'});}
  }});
  await assert.rejects(()=>collect(state.pool.stream(options)),exhausted);assert.equal(calls,1);assert.equal(state.pool.inflightSnapshot().size,0);assert.deepEqual(state.cooled,[]);
  if(edit==='delete')assert.equal(state.pool.getAccount('a'),undefined);else assert.equal(state.pool.getAccount('a').consecutiveFailures,0);
});
await check('edited URL is used on retry and raising configured retries does not replenish initial budget',async()=>{
  let calls=0;let state;const urls=[];state=setup({members:[account('a',{poolDetectionRetries:1,baseUrl:'https://first.invalid'})],stream(row){calls++;urls.push(row.baseUrl);throw hit();},wait:async()=>state.pool.upsertAccount({...state.pool.getAccount('a'),baseUrl:'https://second.invalid',poolDetectionRetries:5})});
  await assert.rejects(()=>collect(state.pool.stream(options)),exhausted);assert.equal(calls,2);assert.deepEqual(urls,['https://first.invalid','https://second.invalid']);assert.equal(state.pool.getAccount('a').baseUrl,'https://second.invalid');untouched(state);
});
await check('deletion after a successful yielded response is never resurrected',async()=>{
  let state;state=setup({stream(){return(async function*(){yield {type:'text-delta',index:0,text:'OK'};state.pool.removeAccount('a');yield {type:'finish',reason:{kind:'stop'}};})();}});
  await collect(state.pool.stream(options));assert.equal(state.pool.getAccount('a'),undefined);assert.equal(state.pool.getBinding(options.sessionId),undefined);assert.equal(state.pool.inflightSnapshot().size,0);
});
await check('account probe applies settings consistently and returns only safe exhaustion information',async()=>{
  let calls=0;const state=setup({stream(){calls++;throw hit(503,'号池不可用 fixture-secret');}});
  const result=await state.pool.testAccount('a',{model:'fixture-model'});assert.equal(calls,3);assert.equal(result.ok,false);
  assert.equal(result.errorCode,'POOL_DETECTION_RETRY_EXHAUSTED');assert.equal(JSON.stringify(result).includes('fixture-secret'),false);untouched(state);assert.equal(state.pool.inflightSnapshot().size,0);
  const successState=setup({stream(){calls++;if(calls===4)throw hit();return success();}});assert.equal((await successState.pool.testAccount('a',{model:'fixture-model'})).ok,true);assert.equal(calls,5);untouched(successState);
});
await check('probe disabled setting preserves ordinary cooldown behavior',async()=>{
  let calls=0;const state=setup({members:[account('a',{poolDetectionRetry:false})],stream(){calls++;throw hit(429);}});
  const result=await state.pool.testAccount('a',{model:'fixture-model'});assert.equal(result.errorCode,'http-429');assert.equal(calls,1);assert.equal(state.cooled.length,1);assert.ok(state.pool.getAccount('a').rateLimitResetAt);
});
await check('probe retry wait participates in its overall timeout and releases its slot',async()=>{
  const {waitForPoolDetection}=await import('../lib/detection.js');let calls=0;
  const state=setup({members:[account('a',{poolDetectionRetryDelayMs:10000})],wait:waitForPoolDetection,stream(){calls++;throw hit();}});
  const result=await state.pool.testAccount('a',{model:'fixture-model',timeoutMs:10});assert.equal(result.errorCode,'POOL_TEST_TIMEOUT');assert.equal(calls,1);assert.equal(state.pool.inflightSnapshot().size,0);
});
if(quick&&quickCases.size)throw new Error('Missing quick detection cases: '+[...quickCases].join(', '));
console.log(`Detection retries${quick?' (quick)':''}: ${checks}/${checks} passed; no network, fixture credentials only`);
