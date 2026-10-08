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
console.log(`${checks}/${checks} installed-runtime checks passed; ${fetches} mock HTTP calls, no real credentials`);
