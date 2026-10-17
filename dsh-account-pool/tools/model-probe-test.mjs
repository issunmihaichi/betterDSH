import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPoolAdapter} from '../lib/adapter.js';
const model='gpt-6.1-sol';
const row=(id,extra={})=>({id,label:id,platform:'openai',authMode:'oauth',credentialRef:'PRIVATE_REF_'+id,
  baseUrl:'https://private-host.test',createdAt:'2026-01-01T00:00:00Z',models:[model],status:'active',schedulable:true,
  priority:1,concurrency:4,consecutiveFailures:0,...extra});
const request={model,maxTokens:8192};
const drain=stream=>Array.fromAsync(stream);
const signal=()=>new AbortController().signal;
const ok=async function*(calls,account,opts){calls.push({account,opts});yield {type:'text-delta',index:0,text:'1 2 3'};
  yield {type:'usage',usage:{inputTokens:5,outputTokens:4}};yield {type:'finish',reason:{kind:'stop'}};};
test('pinned model probe bypasses paused/disabled scheduling, never chooses another account or changes health',async()=>{
  const calls=[],usage=[];const a=row('a',{status:'disabled',schedulable:false}),b=row('b');
  const pool=createPoolAdapter({initialAccounts:[a,b],requestRetries:3,upstream:{stream:(account,opts)=>ok(calls,account,opts)},onUsage:entry=>usage.push(entry)});
  const before=structuredClone(pool.getAccount('a'));
  const prepared=pool.prepareAccountProbe('a',request);
  for(const text of ['fixed one','fixed two','fixed three'])await drain(prepared.stream(text,signal()));
  assert.equal(calls.length,3);assert.ok(calls.every(call=>call.account.id==='a'));
  for(const {opts} of calls){assert.equal(opts.model,model);assert.equal(opts.maxTokens,8192);assert.equal(opts.purpose,'model-attribution');assert.equal(opts.system,'');assert.equal(opts.messages.length,1);assert.equal(opts.sessionId,undefined);assert.equal(opts.tools,undefined);}
  assert.deepEqual(pool.getAccount('a'),before);assert.deepEqual(pool.listBindings(),[]);assert.equal(pool.inflightSnapshot().size,0);
  assert.equal(usage.length,3);assert.ok(usage.every(entry=>entry.accountId==='a'&&entry.switches===0&&entry.ok));
});
test('probe error does not retry, fail over, cool or rewrite the account',async()=>{
  let calls=0;const a=row('a');const pool=createPoolAdapter({initialAccounts:[a,row('b')],requestRetries:3,
    upstream:{async *stream(){calls++;throw Object.assign(Error('fixture error'),{status:503});}}});
  const before=structuredClone(pool.getAccount('a'));
  await assert.rejects(drain(pool.prepareAccountProbe('a',request).stream('fixed',signal())),/fixture error/);
  assert.equal(calls,1);assert.deepEqual(pool.getAccount('a'),before);assert.equal(pool.inflightSnapshot().size,0);assert.equal(pool.listBindings().length,0);
});
test('connection change or deletion invalidates the captured target, with no new IO',async()=>{
  const calls=[];const pool=createPoolAdapter({initialAccounts:[row('a')],upstream:{stream:(a,o)=>ok(calls,a,o)}});
  const prepared=pool.prepareAccountProbe('a',request);await drain(prepared.stream('first',signal()));
  pool.upsertAccount({...pool.getAccount('a'),credentialRef:'DIFFERENT_PRIVATE_REF'});
  await assert.rejects(drain(prepared.stream('second',signal())),{code:'POOL_TEST_TARGET_CHANGED'});assert.equal(calls.length,1);
  const fresh=pool.prepareAccountProbe('a',request);pool.removeAccount('a');
  await assert.rejects(drain(fresh.stream('third',signal())),{code:'POOL_TEST_TARGET_CHANGED'});assert.equal(calls.length,1);
});
test('exact-owner capability and allow-list checks reject unsafe selections before IO',()=>{
  const pool=createPoolAdapter({initialAccounts:[row('a'),row('b',{platform:'anthropic',authMode:'api-key'})],upstream:{async *stream(){throw Error('must not dispatch');}}});
  assert.throws(()=>pool.prepareAccountProbe('a',{...request,reasoningEffort:'max'}),/unsupported/);
  assert.throws(()=>pool.prepareAccountProbe('a',{...request,model:'disallowed-model'}),/does not allow/);
  assert.throws(()=>pool.prepareAccountProbe('a',{...request,maxTokens:100000}),/budget/);
  const description=pool.describeAccountProbe('a');assert.match(description.key,/^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(description),/PRIVATE_REF|private-host/);
  description.models.push('modified');assert.deepEqual(pool.getAccount('a').models,[model]);
});
test('concurrency, abort and mid-stream connection change release the exact account slot',async()=>{
  const pool=createPoolAdapter({initialAccounts:[row('a')],upstream:{async *stream(){yield {type:'text-delta',index:0,text:'1'};yield {type:'finish',reason:{kind:'stop'}};}}});
  const prepared=pool.prepareAccountProbe('a',request),controller=new AbortController();
  const first=prepared.stream('fixed',controller.signal);await first.next();assert.equal(pool.inflightSnapshot().get('a'),1);
  await assert.rejects(drain(prepared.stream('second',signal())),{code:'POOL_TEST_BUSY'});
  controller.abort();await assert.rejects(first.next(),{name:'AbortError'});assert.equal(pool.inflightSnapshot().size,0);
  const changed=prepared.stream('fixed',signal());await changed.next();pool.upsertAccount({...pool.getAccount('a'),baseUrl:'https://changed.test'});
  await assert.rejects(changed.next(),{code:'POOL_TEST_TARGET_CHANGED'});assert.equal(pool.inflightSnapshot().size,0);
});
