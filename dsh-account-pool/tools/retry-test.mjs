import assert from 'node:assert/strict';
import test from 'node:test';
import { createPoolAdapter } from '../lib/adapter.js';
import { createHttpUpstream, mapAnthropic } from '../lib/upstream.js';
import { requestRetryConfig } from '../lib/retry.js';

const row = (extra = {}) => ({ id: 'one', platform: 'anthropic', status: 'active', schedulable: true, concurrency: 1, models: [], groups: [], consecutiveFailures: 0, ...extra });
const request = { provider: 'pool', model: 'fixture', sessionId: 'fixture-session', messages: [{role: 'user', content: [{type:'text', text:'fixture'}]}] };
const collect = async stream => { const chunks=[]; for await (const c of stream) chunks.push(c); return chunks; };
const ok = async function* () { yield {type:'text-delta',index:0,text:'OK'}; yield {type:'finish',reason:{kind:'stop'}}; };
const transient = () => Object.assign(new Error('temporary upstream overload'), {status:503, code:'http-503'});

test('single account retries three temporary failures before success', async () => {
  let calls=0; const waits=[], usage=[], cooled=[];
  const pool=createPoolAdapter({ initialAccounts:[row()], upstream:{stream(){calls++; if(calls<4)throw transient(); return ok();}}, retryWait:async ms=>waits.push(ms), onUsage:u=>usage.push(u), onCooldown:c=>cooled.push(c) });
  const chunks=await collect(pool.stream(request));
  assert.equal(calls,4); assert.deepEqual(waits,[1000,2000,4000]);
  assert.equal(chunks.find(c=>c.type==='text-delta').text,'OK'); assert.equal(usage.length,1); assert.equal(usage[0].switches,0); assert.deepEqual(cooled,[]); assert.equal(pool.inflightSnapshot().size,0);
});
test('bounded exhaustion retains failure facts and cools once', async () => {
  let calls=0;const cooldown=[];const pool=createPoolAdapter({initialAccounts:[row()],upstream:{stream(){calls++;throw transient();}},retryWait:async()=>{},onCooldown:c=>cooldown.push(c)});
  await assert.rejects(()=>collect(pool.stream(request)), e=>e.code==='POOL_EXHAUSTED' && e.failure.code==='POOL_EXHAUSTED' && e.failure.status===503);
  assert.equal(calls,4);assert.equal(cooldown.length,1);assert.equal(pool.inflightSnapshot().size,0);
});
test('authentication and request errors do not retry same account', async () => {
  for(const status of [400,401,403,404,405,413,422,429]){
    let calls=0;const pool=createPoolAdapter({initialAccounts:[row()],upstream:{stream(){calls++;throw Object.assign(new Error('fixture failure'),{status,code:`http-${status}`});}},retryWait:async()=>{throw new Error('unexpected retry')}});
    await assert.rejects(()=>collect(pool.stream(request)),e=>e.failure?.code===e.code);assert.equal(calls,1);
  }
});
test('partial content fails explicitly without duplicate output',async()=>{
  let calls=0;const received=[];const pool=createPoolAdapter({initialAccounts:[row()],upstream:{async *stream(){calls++;yield {type:'text-delta',index:0,text:'partial'};throw transient();}},retryWait:async()=>{throw new Error('unexpected retry')}});
  await assert.rejects(async()=>{for await(const c of pool.stream(request))received.push(c)},e=>e.code==='POOL_PARTIAL_RESPONSE'&&e.failure.status===503);
  assert.equal(calls,1);assert.equal(received.length,1);
});
test('cancel and disabling an account during retry release its slot',async()=>{
  for(const cancel of [true,false]){
    let calls=0;const controller=new AbortController();let pool;
    pool=createPoolAdapter({initialAccounts:[row()],upstream:{stream(){calls++;throw transient();}},retryWait:async()=>{if(cancel)controller.abort();else pool.upsertAccount(row({schedulable:false}));}});
    await assert.rejects(()=>collect(pool.stream({...request,signal:controller.signal})));assert.equal(calls,1);assert.equal(pool.inflightSnapshot().size,0);
    if(cancel)assert.equal(pool.getAccount('one').consecutiveFailures,0);
  }
});
test('empty Anthropic EOF retries and partial EOF is never a successful finish',async()=>{
  const partial=async function*(){yield JSON.stringify({type:'content_block_start',index:0,content_block:{type:'text',text:''}});yield JSON.stringify({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'partial'}});};
  const chunks=[];await assert.rejects(async()=>{for await(const c of mapAnthropic(partial()))chunks.push(c)},e=>e.code==='TRANSPORT');assert.ok(!chunks.some(c=>c.type==='finish'));
  let calls=0;const transport=createHttpUpstream({resolveCredential:()=> 'fixture', fetchImpl:async()=>{calls++;return new Response(calls===1?'':'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n',{headers:{'content-type':'text/event-stream'}});}});
  const pool=createPoolAdapter({initialAccounts:[row()],upstream:transport,retryWait:async()=>{}});assert.equal((await collect(pool.stream(request))).find(c=>c.type==='text-delta').text,'OK');assert.equal(calls,2);
});
test('management probes retry network and 5xx before any cooldown', async () => {
  for (const failure of [transient, () => Object.assign(new Error('socket closed'), { code: 'TRANSPORT' })]) {
    let calls = 0; const waits = [], cooldowns = [];
    let pool;
    pool = createPoolAdapter({ initialAccounts: [row()], upstream: { stream() { if (++calls < 4) throw failure(); return ok(); } },
      retryWait: async ms => { waits.push(ms); assert.equal(pool.getAccount('one').consecutiveFailures, 0); assert.equal(pool.getAccount('one').status, 'active'); assert.equal(pool.inflightSnapshot().get('one'), 1); }, onCooldown: value => cooldowns.push(value) });
    const result = await pool.testAccount('one', { model: 'fixture' });
    assert.equal(result.ok, true); assert.equal(calls, 4); assert.deepEqual(waits, [1000, 2000, 4000]); assert.deepEqual(cooldowns, []); assert.equal(pool.inflightSnapshot().size, 0);
  }
});
test('management probe exhaustion applies cooldown once after all attempts', async () => {
  let calls = 0; const cooldowns = [], records = [];
  const pool = createPoolAdapter({ initialAccounts: [row()], upstream: { stream() { calls++; throw transient(); } }, retryWait: async () => {},
    onCooldown: value => { assert.equal(calls, 4); cooldowns.push(value); }, onUsage: value => records.push(value) });
  const result = await pool.testAccount('one', { model: 'fixture' });
  assert.equal(result.ok, false); assert.equal(result.status, 503); assert.equal(calls, 4); assert.equal(cooldowns.length, 1); assert.equal(records.length, 1);
  assert.equal(pool.getAccount('one').consecutiveFailures, 1); assert.equal(pool.inflightSnapshot().size, 0);
});
test('management probes preserve auth/client/partial-output no-retry policy', async () => {
  for (const status of [400, 401, 403]) {
    let calls = 0; const pool = createPoolAdapter({ initialAccounts: [row()], upstream: { stream() { calls++; throw Object.assign(new Error('fixture'), { status }); } }, retryWait: async () => { throw new Error('Must not retry'); } });
    assert.equal((await pool.testAccount('one', { model: 'fixture' })).status, status); assert.equal(calls, 1);
  }
  let calls = 0; const pool = createPoolAdapter({ initialAccounts: [row()], upstream: { async *stream() { calls++; yield { type: 'text-delta', text: 'partial' }; throw transient(); } }, retryWait: async () => { throw new Error('Must not replay'); } });
  assert.equal((await pool.testAccount('one', { model: 'fixture' })).ok, false); assert.equal(calls, 1);
});
test('management probe retries respect timeout, deletion and scheduling edits', async () => {
  for (const action of ['delete', 'disable', 'timeout']) {
    let calls = 0; let pool;
    pool = createPoolAdapter({ initialAccounts: [row()], upstream: { stream() { calls++; throw transient(); } }, retryWait: async (ms, signal) => {
      if (action === 'delete') pool.removeAccount('one');
      else if (action === 'disable') pool.upsertAccount(row({ schedulable: false }));
      else await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
    } });
    const result = await pool.testAccount('one', { model: 'fixture', timeoutMs: 20 });
    assert.equal(result.ok, false); assert.equal(calls, 1); assert.equal(pool.inflightSnapshot().size, 0);
    if (action === 'delete') assert.equal(pool.getAccount('one'), undefined);
    if (action === 'disable') assert.equal(pool.getAccount('one').schedulable, false);
    if (action === 'timeout') assert.equal(result.errorCode, 'POOL_TEST_TIMEOUT');
  }
  const pool = createPoolAdapter({ initialAccounts: [row({ status: 'disabled', schedulable: false })], upstream: { stream: ok } });
  assert.equal((await pool.testAccount('one', { model: 'fixture' })).ok, true);
});

test('explicit Retry-After is respected and settings bound retry counts',async()=>{
  assert.equal(requestRetryConfig({requestRetries:999}).retries,5);assert.equal(requestRetryConfig({requestRetries:0}).retries,0);
  let calls=0;const waits=[];const pool=createPoolAdapter({initialAccounts:[row()],upstream:{stream(){if(++calls===1)throw Object.assign(new Error('slow down'),{status:429,code:'http-429',providerRetryAfterMs:2000});return ok();}},retryWait:async ms=>waits.push(ms)});
  await collect(pool.stream(request));assert.deepEqual(waits,[2000]);assert.equal(calls,2);
});
