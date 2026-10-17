import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createPoolAdapter} from '../lib/adapter.js';
import {createHttpUpstream} from '../lib/upstream.js';
const require=createRequire(import.meta.url);
const {LlmRuntime,createUserMessage,assembleAssistantStream}=require('C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js');
// Use the installed runtime's real registration/preparation/validation/dispatch methods.
// Only framework lifecycle and middleware are test doubles; HTTP is mock-only.
function runtime(){const value=Object.create(LlmRuntime.prototype);Object.defineProperties(value,{ctx:{value:{effect(fn){const it=fn();it.next();return()=>it.next();},events:{dispatch(){return[];}},waterfall(owner,name,options,next){return next();},get(){return undefined;},logger:{warn(){}}}},adapters:{value:new Map()},directory:{value:new Map()},discoveries:{value:new Map()}});return value;}
const model='claude-fable-5-1-reversed';
const accounts=[{id:'anyrouter',label:'Anyrouter',platform:'anthropic',authMode:'api-key',priority:100,status:'active',schedulable:true,concurrency:4,models:[model],groups:['nyroute'],consecutiveFailures:0}];
const groups=[{id:'nyroute',label:'Anyrouter1',models:[model]}];
let fetches=0;
const upstream=createHttpUpstream({resolveCredential:()=> 'fake-api-key',fetchImpl:async(url,init)=>{fetches++;assert.equal(new URL(url).pathname,'/v1/messages');const body=JSON.parse(init.body);assert.equal(body.model,model);assert.equal(body.messages[0].content[0].text,'draw an SVG');return new Response('data: {"type":"message_start","message":{"usage":{"input_tokens":11}}}\n\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<svg/>"}}\n\ndata: {"type":"content_block_stop","index":0}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\ndata: {"type":"message_stop"}\n\n');}});
const pool=createPoolAdapter({initialAccounts:accounts,initialGroups:groups,upstream});
let checks=0;
async function check(label,fn){await fn();checks++;console.log('ok '+label);}
const llm=runtime();llm.registerAdapter(pool.routesFor(),pool);
await check('reproduces reported legacy adapter error before provider I/O',async()=>{const old=runtime();old.registerAdapter(pool.routesFor(),{...pool,prepareCall:undefined});await assert.rejects(()=>old.prepareCall({provider:'pool-nyroute',model,reasoningEffort:'max'}),/prepareCall is not a function/);assert.equal(fetches,0);});
for(const provider of ['pool-nyroute','pool']){
 await check('actual DSH prepared chat dispatch '+provider,async()=>{const call=await llm.prepareCall({provider,model,reasoningEffort:'max'});assert.equal(call.config.maxTokens,64000);assert.equal(call.context.contextWindow,200000);const options={...call.config,sessionId:'runtime-'+provider,messages:[createUserMessage({content:[{type:'text',text:'draw an SVG'}],source:{kind:'user'}})]};const records=[];for await(const chunk of call.stream(options))records.push({type:'chunk',chunk});const result=assembleAssistantStream(records);if(result.finish.kind!=='stop')console.log('runtime failure',JSON.stringify(result.finish));assert.equal(result.finish.kind,'stop');assert.equal(result.blocks().filter(x=>x.type==='text').map(x=>x.text).join(''),'<svg/>');assert.equal(result.usage.inputTokens,11);assert.throws(()=>call.stream(options),e=>e.code==='INVALID_PREPARED_CALL');});
}
await check('runtime stream entry also uses prepared adapter interface',async()=>{const chunks=[];for await(const chunk of llm.stream({provider:'pool',model,reasoningEffort:'max',sessionId:'direct-runtime',messages:[createUserMessage({content:[{type:'text',text:'draw an SVG'}],source:{kind:'user'}})]}))chunks.push(chunk);assert.equal(chunks.at(-1).reason.kind,'stop');});
await check('runtime image price query is supported',async()=>assert.equal(llm.imageRequestPricing('pool',model),undefined));
await check('runtime preparation respects already aborted signal',async()=>{const ctrl=new AbortController();ctrl.abort();const before=fetches;await assert.rejects(()=>llm.prepareCall({provider:'pool',model},ctrl.signal),e=>e.name==='AbortError');assert.equal(fetches,before);});
await check('prepared config change rejected by real runtime',async()=>{const call=await llm.prepareCall({provider:'pool',model});assert.throws(()=>call.stream({...call.config,provider:'pool-nyroute',messages:[]}),e=>e.code==='INVALID_PREPARED_CALL');});
const {buildModelCatalog,modelAvailable}=require('C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/catalog.js');
const menuRuntime=runtime();const sent=[];
const menuPool=createPoolAdapter({initialAccounts:[{id:'relay-a',platform:'anthropic',status:'active',schedulable:true,priority:100,models:['shared','a-only'],groups:['anyrouter']},{id:'relay-b',platform:'anthropic',status:'active',schedulable:true,priority:100,models:['shared','b-only'],groups:['backup']}],initialGroups:[{id:'anyrouter',label:'Anyrouter',models:[]},{id:'backup',label:'Sub-Backup',models:[]},{id:'empty',label:'Empty',models:['shared']}],upstream:{stream(account,options){sent.push({account:account.id,provider:options.provider,model:options.model});return(async function*(){yield {type:'text-delta',index:0,text:account.id};yield {type:'finish',reason:{kind:'stop'}};})();}}});
const menuHandle=menuRuntime.registerAdapter(menuPool.routesFor(),menuPool);const menuCtx={llm:menuRuntime};const defaultSelection={provider:'pool-anyrouter',model:'shared'};
await check('native composer catalog uses Sub labels and preserves stable provider ids',async()=>{const catalog=await buildModelCatalog(menuCtx,defaultSelection);assert.deepEqual(catalog.failures,[]);assert.deepEqual(catalog.routableProviders,['pool','pool-anyrouter','pool-backup']);assert.equal(catalog.groups.find(x=>x.id==='pool-anyrouter').name,'Sub-Anyrouter');assert.equal(catalog.groups.find(x=>x.id==='pool-backup').name,'Sub-Backup');assert.deepEqual(catalog.groups.find(x=>x.id==='pool-anyrouter').models.map(x=>x.id),['shared','a-only']);assert.equal(await modelAvailable(menuCtx,{provider:'pool-anyrouter',model:'b-only'}),false);assert.equal(await modelAvailable(menuCtx,{provider:'Sub-Anyrouter',model:'shared'}),false);});
await check('same model selected under two groups dispatches only to the chosen pool',async()=>{for(const provider of ['pool-anyrouter','pool-backup']){assert.equal(await modelAvailable(menuCtx,{provider,model:'shared'}),true);const config=await menuRuntime.resolveCallConfig({provider,model:'shared'});const call=await menuRuntime.prepareCall(config);for await(const chunk of call.stream({...call.config,sessionId:'selected-'+provider,messages:[createUserMessage({content:[{type:'text',text:'fixture'},],source:{kind:'user'}})]})){}assert.deepEqual(sent.at(-1),{account:provider==='pool-anyrouter'?'relay-a':'relay-b',provider,model:'shared'});}});
await check('empty group becomes selectable when a member is attached and disappears after removal',async()=>{let catalog=await buildModelCatalog(menuCtx,defaultSelection);assert.equal(catalog.groups.some(x=>x.id==='pool-empty'),false);const account=menuPool.getAccount('relay-a');menuPool.upsertAccount({...account,groups:[...account.groups,'empty']});menuHandle.replace(menuPool.routesFor());catalog=await buildModelCatalog(menuCtx,defaultSelection);assert.equal(catalog.groups.find(x=>x.id==='pool-empty').name,'Sub-Empty');assert.deepEqual(catalog.groups.find(x=>x.id==='pool-empty').models.map(x=>x.id),['shared']);menuPool.removeGroup('empty');menuHandle.replace(menuPool.routesFor());assert.equal(await modelAvailable(menuCtx,{provider:'pool-empty',model:'shared'}),false);assert.equal(await modelAvailable(menuCtx,{provider:'pool-anyrouter',model:'shared'}),true);});
await check('unrestricted member exposes both group models in native menus and dispatches each to its group',async()=>{
  const expected=['claude-fable-5-1-reversed','gpt-6-astra-cc-format[1m]'];const dispatches=[];const native=runtime();
  const adapter=createPoolAdapter({initialAccounts:[{id:'all-models',platform:'anthropic',models:[],groups:['all'],status:'active',schedulable:true}],initialGroups:[{id:'all',label:'Anyrouter',models:expected},{id:'orphan',models:['not-owned']}],upstream:{stream(account,options){dispatches.push({account:account.id,provider:options.provider,model:options.model});return(async function*(){yield {type:'text-delta',index:0,text:'fixture'};yield {type:'finish',reason:{kind:'stop'}};})();}}});
  native.registerAdapter(adapter.routesFor(),adapter);const ctx={llm:native};const catalog=await buildModelCatalog(ctx,{provider:'pool-all',model:expected[0]});assert.deepEqual(catalog.failures,[]);
  for(const provider of ['pool','pool-all']){assert.deepEqual(catalog.groups.find(x=>x.id===provider).models.map(x=>x.id),expected);for(const model of expected)assert.equal(await modelAvailable(ctx,{provider,model}),true);}
  assert.equal(catalog.groups.some(x=>x.id==='pool-orphan'),false);
  for(const model of expected){const call=await native.prepareCall({provider:'pool-all',model,reasoningEffort:'max'});for await(const chunk of call.stream({...call.config,sessionId:'wildcard-'+model,messages:[createUserMessage({content:[{type:'text',text:'fixture'}],source:{kind:'user'}})]})){}assert.deepEqual(dispatches.at(-1),{account:'all-models',provider:'pool-all',model});}
});
await check('actual prepared chat retries transient pool detection HTTP errors without cooling or changing route',async()=>{
  let calls=0;const pauses=[];const adapter=createPoolAdapter({initialAccounts:[{id:'detected',platform:'anthropic',models:[model],groups:['detection'],status:'active',schedulable:true,poolDetectionRetry:true,poolDetectionRetries:2,poolDetectionRetryDelayMs:100,poolDetectionKeywords:['号池不可用']}],initialGroups:[{id:'detection',label:'Detection',models:[model]}],detectionWait:async ms=>{pauses.push(ms);},upstream:createHttpUpstream({resolveCredential:()=> 'fixture-secret',fetchImpl:async()=>{
    if(++calls===1)return new Response(JSON.stringify({error:{message:'号池不可用'}}),{status:503});
    return new Response('data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\ndata: {"type":"content_block_stop","index":0}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\ndata: {"type":"message_stop"}\n\n');
  }})});
  const native=runtime();native.registerAdapter(adapter.routesFor(),adapter);const call=await native.prepareCall({provider:'pool-detection',model,reasoningEffort:'max'});const records=[];
  for await(const chunk of call.stream({...call.config,sessionId:'runtime-detection',messages:[createUserMessage({content:[{type:'text',text:'fixture'}],source:{kind:'user'}})]}))records.push({type:'chunk',chunk});
  const reply=assembleAssistantStream(records);assert.equal(reply.finish.kind,'stop');assert.equal(reply.blocks().filter(x=>x.type==='text').map(x=>x.text).join(''),'ok');assert.equal(calls,2);assert.deepEqual(pauses,[100]);
  const record=adapter.getAccount('detected');assert.equal(record.consecutiveFailures,0);assert.equal(record.rateLimitResetAt??null,null);assert.equal(record.overloadUntil??null,null);assert.equal(record.tempUnschedulableUntil??null,null);assert.equal(adapter.listBindings()[0].accountId,'detected');
});
await check('actual DSH image history reaches Codex as input_image through a prepared call', async () => {
  const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFhQAAAAASUVORK5CYII=', 'base64');
  let reads = 0, requests = 0;
  const native = runtime();
  const adapter = createPoolAdapter({ initialAccounts: [{ id: 'codex-image', platform: 'openai', authMode: 'oauth', status: 'active', schedulable: true, models: ['gpt-5.3-codex'], groups: ['codex-image'] }],
    initialGroups: [{ id: 'codex-image', models: [] }], upstream: createHttpUpstream({
      resolveCredential: () => ({ access_token: 'offline-token', chatgpt_account_id: 'offline-account' }),
      resolveAttachments: () => ({ async readImageRequest(ref, target) { reads++; assert.equal(ref.attachmentId, 'sha256:offline-image'); assert.equal(target.maxBytes, 1048576); return { data, mediaType: 'image/png', width: 1, height: 1 }; } }),
      fetchImpl: async (url, init) => { requests++; const input = JSON.parse(init.body).input; assert.equal(input[0].content.at(-1).type, 'input_image'); assert.equal(input[0].content.at(-1).image_url, `data:image/png;base64,${data.toString('base64')}`); return new Response('data: '+JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', id: 'msg_image', content: [{ type: 'output_text', text: 'image received' }] }], usage: { input_tokens: 100, output_tokens: 2 } } })+'\n\n'); },
    }) });
  native.registerAdapter(adapter.routesFor(), adapter);
  const call = await native.prepareCall({ provider: 'pool-codex-image', model: 'gpt-5.3-codex' });
  assert.deepEqual(call.inputModalities, ['text', 'image']);
  const records = [];
  for await (const chunk of call.stream({ ...call.config, messages: [createUserMessage({ content: [
    { type: 'text', text: 'describe this' }, { type: 'image', attachment: { attachmentId: 'sha256:offline-image', mediaType: 'image/png', width: 1, height: 1, bytes: data.length } },
  ], source: { kind: 'user' } })] })) records.push({ type: 'chunk', chunk });
  const result = assembleAssistantStream(records);
  assert.equal(result.finish.kind, 'stop'); assert.equal(result.blocks().find(block => block.type === 'text').text, 'image received');
  assert.equal(reads, 1); assert.equal(requests, 1);
});
await check('actual DSH preserves Codex purpose through prepared and direct dispatch', async () => {
  const native = runtime(); const captures = [];
  const adapter = createPoolAdapter({ initialAccounts: [{ id: 'attribution', platform: 'openai', authMode: 'oauth', status: 'active', schedulable: true, models: ['gpt-5.3-codex'] }],
    upstream: createHttpUpstream({ resolveCredential: () => ({ access_token: 'offline', chatgpt_account_id: 'offline' }),
      resolveCodexSession: id => ({ known: true, origin: id === 'child' ? 'subagent' : undefined, parentSessionId: id === 'child' ? 'parent' : undefined, rootSessionId: 'parent', turnId: `${id}:turn:1` }),
      fetchImpl: async (url, init) => { const body = JSON.parse(init.body); const meta = JSON.parse(body.client_metadata['x-codex-turn-metadata']); captures.push(meta);
        assert.equal(init.headers['x-codex-turn-metadata'], body.client_metadata['x-codex-turn-metadata']);
        return new Response('data: '+JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [], usage: {} } })+'\n\n'); },
    }) });
  native.registerAdapter(adapter.routesFor(), adapter);
  for (const purpose of [undefined, 'session-title', 'compaction']) {
    const call = await native.prepareCall({ provider: 'pool', model: 'gpt-5.3-codex' });
    for await (const chunk of call.stream({ ...call.config, sessionId: 'child', purpose, messages: [createUserMessage({ content: [{ type: 'text', text: 'fixture' }], source: { kind: 'user' } })] })) {}
  }
  assert.deepEqual(captures.map(m => [m.request_kind, m.thread_source]), [['turn','subagent'],['turn','thread_title'],['compaction','subagent']]);
  assert.equal(captures[0].subagent_kind, 'thread_spawn'); assert.equal(captures[1].subagent_kind, undefined);
});
await check('actual DSH preserves review sidecar without changing ordinary session scheduling', async () => {
  const native = runtime(); const captures = [];
  const adapter = createPoolAdapter({ initialAccounts: [{ id: 'review-runtime', platform: 'openai', authMode: 'oauth', status: 'active', schedulable: true, models: ['gpt-5.3-codex'] }],
    upstream: createHttpUpstream({ resolveCredential: () => ({ access_token: 'offline', chatgpt_account_id: 'offline' }),
      resolveCodexSession: id => { assert.equal(id, 'owner-runtime'); return { known: true, rootSessionId: id, turnId: 'owner-turn' }; },
      fetchImpl: async (url, init) => { const body = JSON.parse(init.body); const meta = JSON.parse(body.client_metadata['x-codex-turn-metadata']); captures.push({ meta, body, headers: init.headers });
        return new Response('data: '+JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [], usage: {} } })+'\n\n'); },
    }) });
  native.registerAdapter(adapter.routesFor(), adapter);
  const sidecar = Object.freeze({ version: 1, kind: 'auto-review', ownerSessionId: 'owner-runtime', requestId: 'unique-review' });
  const request = Object.freeze({ provider: 'pool', model: 'gpt-5.3-codex', messages: Object.freeze([createUserMessage({ content: [{ type: 'text', text: 'offline review' }], source: { kind: 'user' } })]), codexRequestProvenance: sidecar });
  for await (const chunk of native.stream(request)) {}
  const capture = captures.at(-1); assert.equal(capture.meta.thread_source, 'guardian_review');
  assert.equal(capture.headers['x-openai-subagent'], 'guardian'); assert.equal(capture.headers['x-codex-guardian'], undefined);
  assert.equal(capture.headers['thread-id'], capture.meta.thread_id); assert.equal(capture.body.prompt_cache_key, undefined);
  assert.equal(request.sessionId, undefined); assert.deepEqual(adapter.listBindings(), []);
  assert.equal(capture.body.client_metadata['x-codex-turn-metadata'], capture.headers['x-codex-turn-metadata']);
});
await check('original Auto gate through real Cordis and LlmRuntime reaches scoped Codex review metadata', async () => {
  const { Context } = require('C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis');
  const { AUTO_PRESET } = require('C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-permission-presets');
  const companion = (await import('../../dsh-codex-review-attribution/lib/host.js')).default;
  const { sessionFixture, mockContext } = await import('../../dsh-codex-review-attribution/tools/fixtures.mjs');
  const { mountPool, inject: poolInject, ROUTES } = await import('../lib/host.js');
  const { poolDomainSpec } = await import('../lib/domain.js');
  const native = runtime(), root = new Context(), calls = [], routes = [], tables = new Map();
  let globals = { ...poolDomainSpec.global.initial }, mountedPool, domainClosed = 0;
  const owner = sessionFixture({ id: 'integration-child', mode: 'native', preset: AUTO_PRESET });
  owner.session.header = { ...owner.session.header, origin: 'subagent', parentSession: 'integration-root' };
  const ptc = sessionFixture({ id: 'integration-ptc', mode: 'ptc', preset: AUTO_PRESET });
  const parent = sessionFixture({ id: 'integration-root' });
  const sessions = [parent.session, owner.session, ptc.session];
  for (const session of sessions) { const header = session.requestHeader(); session.requestHeader = () => ({ ...header, config: { provider: 'pool', model: 'gpt-5.3-codex' } }); }
  const h = mockContext({ sessions });
  const account = { id: 'integration-oauth', platform: 'openai', authMode: 'oauth', credentialRef: 'MOCK_REVIEW', models: ['gpt-5.3-codex'], groups: ['integration'], status: 'active', schedulable: true };
  tables.set('groups', new Map([['integration', { id: 'integration', label: 'Integration', models: ['gpt-5.3-codex'] }]]));
  const storageDomain = { open: async spec => {
    assert.equal(spec, poolDomainSpec);
    return { global: { get: () => globals, set: async value => { globals = value; } },
      table(name) { if (!tables.has(name)) tables.set(name, new Map()); const table = tables.get(name);
        return { get: key => table.get(key), entries: () => table.entries(), put: async (key, value) => { table.set(key, value); },
          delete: async key => table.delete(key), update: async (key, fn) => { const value = fn(table.get(key)); table.set(key, value); return value; } }; },
      close: async () => { if (domainClosed === 0) domainClosed += 1; } };
  } };
  const services = root.plugin({ name: 'integration-mock-services', apply(ctx) {
    const values = { approval: h.ctx.approval, permissionPresets: h.ctx.permissionPresets, tools: h.ctx.tools, llm: native, storageDomain,
      sessions: { list: () => sessions, get: id => sessions.find(session => session.id === id) },
      sessionProjections: { stateOf: (session, key) => { assert.equal(key, 'turnBoundary'); return { openTurnStartSeq: 1, lastTurn: 1 }; } },
      connection: { fetch: { register: route => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1); }; } } }, timer: {}, credentials: { resolve: async ref => { assert.equal(ref, 'MOCK_REVIEW'); return { value: JSON.stringify({ access_token: 'offline', chatgpt_account_id: 'offline' }) }; } }, attachments: {} };
    for (const [key, value] of Object.entries(values)) ctx.provide(key, value);
  } });
  await services;
  const poolFiber = root.plugin({ name: 'integration-account-pool', inject: poolInject, async apply(ctx) {
    mountedPool = await mountPool(ctx, { accounts: [account], refreshEnabled: false,
      fetchImpl: async (url, init) => {
        assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
        const body = JSON.parse(init.body), meta = JSON.parse(body.client_metadata['x-codex-turn-metadata']); calls.push({ body, meta, headers: init.headers });
        const text = '{"risk":"low","decision":"allow"}';
        return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 2 } } }) + '\n\n');
      } });
    return () => mountedPool.dispose();
  } });
  await poolFiber;
  const capability = async () => { const route = routes.find(row => row.path === ROUTES.accounts); return (await (await route.fetch(new Request('http://127.0.0.1' + ROUTES.accounts))).json()).codexAttributionCapabilities; };
  assert.equal((await capability()).reviewBridge, false);
  const originalModulePath = require.resolve('C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review/lib/index.js');
  const reviewFiber = root.plugin(companion, { originalModulePath });
  await reviewFiber;
  try {
    assert.equal(h.registered, 1, 'exactly one original Auto registration');
    assert.equal((await capability()).reviewBridge, true, 'real optional child injection observes the sibling service');
    const ordinary = [];
    for (const fixture of [owner, ptc]) {
      for await (const chunk of native.stream({ provider: 'pool', model: 'gpt-5.3-codex', sessionId: fixture.session.id, messages: [createUserMessage({ content: [{ type: 'text', text: 'ordinary mock request' }], source: { kind: 'user' } })] })) {}
      ordinary.push(calls.at(-1));
    }
    const bindings = mountedPool.adapter.listBindings().map(binding => ({ ...binding }));
    let downstreamCalls = 0;
    const decisions = await Promise.all([owner, ptc].map(fixture => root.waterfall('tools/pre-execute', fixture.exec, () => { downstreamCalls += 1; return { kind: 'allow' }; })));
    assert.deepEqual(decisions, [{ kind: 'allow' }, { kind: 'allow' }]); assert.equal(downstreamCalls, 2);
    const reviews = calls.filter(call => call.meta.thread_source === 'guardian_review');
    assert.equal(reviews.length, 2);
    assert.notEqual(reviews[0].meta.thread_id, reviews[1].meta.thread_id);
    for (const normal of ordinary) {
      const review = reviews.find(call => call.meta.parent_thread_id === normal.meta.thread_id); assert.ok(review, 'review names the actual owner, not an invented collaboration parent');
      assert.equal(review.meta.session_id, normal.meta.session_id); assert.notEqual(review.meta.thread_id, normal.meta.thread_id);
      assert.equal(review.headers['thread-id'], review.meta.thread_id); assert.equal(review.headers['session-id'], review.meta.session_id);
      assert.equal(review.headers['x-openai-subagent'], 'guardian'); assert.equal(review.headers['x-codex-guardian'], undefined);
      assert.equal(review.body.prompt_cache_key, undefined); assert.equal(review.headers.session_id, undefined); assert.equal(review.meta.subagent_kind, undefined);
    }
    assert.deepEqual(mountedPool.adapter.listBindings(), bindings, 'the original producer adds no ordinary scheduling session');
    assert.equal((await capability()).review.augmentedRequests, 2); assert.equal((await capability()).review.missingProvenance, 0);
    await reviewFiber.dispose();
    assert.equal(h.registered, 0); assert.equal((await capability()).reviewBridge, false);
    assert.equal(owner.session.preset, 'danger-full-access'); assert.equal(ptc.session.preset, 'danger-full-access');
    const sentinel = { kind: 'allow' }; assert.equal(root.waterfall('tools/pre-execute', owner.exec, () => sentinel), sentinel);
  } finally {
    await reviewFiber.dispose(); await poolFiber.dispose(); await services.dispose();
  }
  assert.equal(domainClosed, 1);
});
console.log(`${checks}/${checks} installed-runtime checks passed; ${fetches} earlier mock HTTP calls, no real credentials`);
