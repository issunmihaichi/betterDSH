import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createPoolAdapter} from '../lib/adapter.js';
import {buildGeminiRequest} from '../lib/native/gemini.js';
import {buildCodexRequest} from '../lib/native/codex.js';
// No network or real credential lookup: transport builders receive fixture bundles.
let checks=0;async function check(label,fn){await fn();checks++;console.log('ok '+label);}
const nativeEfforts=['off','minimal','low','medium','high','xhigh'];
const message=[{role:'user',content:'fixture'}];
for(const [platform,authMode,model] of [['gemini','api-key','gemini-2.5-pro'],['gemini','api-key','gemini-3-pro'],['gemini','oauth','gemini-3.1-pro'],['openai','oauth','gpt-5']])await check(`every advertised native effort builds ${platform}/${authMode}/${model}`,async()=>{
  const account={id:'native',platform,authMode,models:[model],groups:['g'],status:'active'};
  const pool=createPoolAdapter({initialAccounts:[account],initialGroups:[{id:'g',models:[]}]});
  const info=await pool.resolveModel('pool-g',model);assert.deepEqual(info.reasoning.efforts.map(x=>x.id),nativeEfforts);assert.equal(info.reasoning.defaultEffort,undefined);
  const builder=platform==='gemini'?buildGeminiRequest:buildCodexRequest;
  const credential=platform==='gemini'?authMode==='oauth'?{access_token:'fixture-token',project_id:'fixture-project'}:'fixture-key':{access_token:'fixture-token',chatgpt_account_id:'fixture-workspace'};
  for(const effort of info.reasoning.efforts){const request=builder(account,{model,messages:message,reasoningEffort:effort.id},credential);assert.ok(request.init?.body??request.body);}
  assert.throws(()=>builder(account,{model,messages:message,reasoningEffort:'max'},credential),e=>e.code==='POOL_UNSUPPORTED_CONTENT');
});
await check('mixed model pool intersects native support but isolated legacy group preserves max',async()=>{
  const accounts=[{id:'claude',platform:'anthropic',models:['shared','claude-only'],groups:['claude']},{id:'gemini',platform:'gemini',models:['shared'],groups:['gemini']}];
  const pool=createPoolAdapter({initialAccounts:accounts,initialGroups:[{id:'claude',models:[]},{id:'gemini',models:[]}]});
  assert.deepEqual((await pool.resolveModel('pool','shared')).reasoning.efforts.map(x=>x.id),nativeEfforts);
  assert.equal((await pool.resolveModel('pool','claude-only')).reasoning.efforts.at(-1).id,'max');assert.equal((await pool.resolveModel('pool-claude','shared')).reasoning.efforts.at(-1).id,'max');
  pool.upsertGroup({id:'claude',models:['claude-only']});assert.equal((await pool.resolveModel('pool-claude','shared')).reasoning,undefined);
});
if(process.versions.electron){
  const require=createRequire(import.meta.url);const root='C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/';
  const {LlmRuntime}=require(root+'dsh-llm/lib/index.js');const {buildModelCatalog,modelAvailable}=require(root+'dsh-api-session-controller/lib/types/catalog.js');
  const emitted=[];const llm=Object.create(LlmRuntime.prototype);Object.defineProperties(llm,{ctx:{value:{effect(fn){const it=fn();it.next();return()=>it.next();},events:{dispatch(...args){emitted.push(args);return[];}},logger:{warn(){}}}},adapters:{value:new Map()},directory:{value:new Map()},discoveries:{value:new Map()}});
  const accounts=[{id:'claude',platform:'anthropic',authMode:'api-key',models:['shared','claude-only'],groups:['claude'],status:'active'},{id:'native',platform:'gemini',authMode:'api-key',models:['shared'],groups:['native'],status:'active'}];
  const pool=createPoolAdapter({initialAccounts:accounts,initialGroups:[{id:'claude',label:'Claude',models:[]},{id:'native',label:'Native',models:[]},{id:'empty',label:'Empty',models:['shared']}]});const registration=llm.registerAdapter(pool.routesFor(),pool);const ctx={llm,agentDefaultModel:{currentSelection(){return{provider:'pool-claude',model:'claude-only',reasoningEffort:'max'};}}};
  await check('actual Host modelCatalog respects native limits, group isolation and filters empty groups',async()=>{const catalog=await buildModelCatalog(ctx);assert.deepEqual(catalog.failures,[]);assert.equal(catalog.groups.some(x=>x.id==='pool-empty'),false);assert.deepEqual(catalog.groups.find(x=>x.id==='pool-native').models[0].reasoning.efforts.map(x=>x.id),nativeEfforts);assert.equal(catalog.groups.find(x=>x.id==='pool-claude').models.find(x=>x.id==='shared').reasoning.efforts.at(-1).id,'max');assert.deepEqual(catalog.default,{provider:'pool-claude',model:'claude-only',reasoningEffort:'max'});});
  await check('actual selection rejects explicitly unsupported max without silent mapping',async()=>{assert.equal(await modelAvailable(ctx,{provider:'pool-native',model:'shared'}),true);await assert.rejects(()=>llm.resolveCallConfig({provider:'pool-native',model:'shared',reasoningEffort:'max'}),e=>e.code==='UNSUPPORTED_REASONING_EFFORT');assert.equal((await llm.resolveCallConfig({provider:'pool-native',model:'shared',reasoningEffort:'high'})).reasoningEffort,'high');assert.equal((await llm.resolveCallConfig({provider:'pool-claude',model:'claude-only',reasoningEffort:'max'})).reasoningEffort,'max');});
  await check('actual Host advertised native levels all pass validation and transport building',async()=>{const catalog=await buildModelCatalog(ctx);const model=catalog.groups.find(x=>x.id==='pool-native').models[0];for(const effort of model.reasoning.efforts){const config=await llm.resolveCallConfig({provider:'pool-native',model:model.id,reasoningEffort:effort.id});buildGeminiRequest(accounts[1],{...config,model:'gemini-2.5-pro',messages:message},'fixture-key');}});
  await check('actual route replacement emits catalog invalidation and subsequent reads reflect new owner',async()=>{const before=emitted.length;pool.upsertAccount({...accounts[1],models:['other']});registration.replace(pool.routesFor());assert.equal(emitted.slice(before).some(args=>args.some(x=>x==='llm/adapters-updated'||Array.isArray(x)&&x.includes('llm/adapters-updated'))),true);const catalog=await buildModelCatalog(ctx);assert.equal(catalog.groups.find(x=>x.id==='pool').models.find(x=>x.id==='shared').reasoning.efforts.at(-1).id,'max');});
  await check('actual prepared native cancellation and defaults retain prior ownership behavior',async()=>{const ctrl=new AbortController();ctrl.abort();await assert.rejects(()=>llm.prepareCall({provider:'pool-native',model:'other'},ctrl.signal),e=>e.name==='AbortError');const config=await llm.resolveCallConfig({provider:'pool-native',model:'other'});assert.equal(config.maxTokens,64000);assert.equal(config.reasoningEffort,undefined);});
}else console.log('Installed-Host catalog checks require Electron with ELECTRON_RUN_AS_NODE=1');
console.log(`Menu capability: ${checks}/${checks} passed; no network, fixture credentials only`);
