import assert from 'node:assert/strict';
import { supplierEndpoint, planSupplier, discoverSupplierModels } from '../lib/supplier.js';
const body={supplier:{name:'供应商 A',platform:'custom',baseUrl:'https://relay.invalid/v1/chat/completions',models:['a','a',' b ']},credential:'fixture-key'};
const opts={accounts:[],groups:[],at:'2026-01-01T00:00:00.000Z',token:()=> '123abc'};
let count=0;
async function check(label,fn){await fn();count++;console.log('ok '+label);}
await check('connect plans named pool, member and private credential reference',()=>{const p=planSupplier(body,opts);assert.equal(p.group.label,'供应商 A');assert.deepEqual(p.group.models,[]);assert.deepEqual(p.account.models,['a','b']);assert.deepEqual(p.account.groups,[p.group.id]);assert.equal(p.account.authMode,'api-key');assert.equal(p.account.baseUrl,'https://relay.invalid');assert.equal(p.credential,'fixture-key');assert.ok(!JSON.stringify(p.account).includes('fixture-key'));});
await check('roots and copied inference endpoints normalize for every supported protocol',()=>{for(const platform of ['custom','openai','anthropic']){assert.equal(supplierEndpoint(platform,'https://x.invalid/proxy/v1/'),'https://x.invalid/proxy');assert.equal(supplierEndpoint(platform,'https://x.invalid/proxy/v1/messages'),'https://x.invalid/proxy');}assert.equal(supplierEndpoint('gemini','https://x.invalid/v1beta/models'),'https://x.invalid');assert.equal(supplierEndpoint('custom','http://localhost:8080'),'http://localhost:8080');});
await check('invalid input never produces writable plan',()=>{for(const patch of [{name:''},{models:[]},{models:['\nbad\nvalue']},{platform:'other'},{baseUrl:'https://u:p@x.invalid'},{baseUrl:'file:///tmp'},{baseUrl:'https://x.invalid?k=key'},{platform:'custom',mimicry:'claude-code'},{betas:['\nx']}])assert.throws(()=>planSupplier({...body,supplier:{...body.supplier,...patch}},opts));assert.throws(()=>planSupplier({...body,credential:''},opts));});
await check('existing provider gets a new member with stable route and no overwrite',()=>{const group={id:'nyroute',label:'Anyrouter1',models:['a','b'],description:'keep'};const p=planSupplier({...body,supplier:{...body.supplier,groupId:'nyroute'}},{...opts,groups:[group]});assert.equal(p.createGroup,false);assert.equal(p.group,group);assert.deepEqual(p.account.groups,['nyroute']);assert.throws(()=>planSupplier({...body,supplier:{...body.supplier,groupId:'missing'}},opts));assert.throws(()=>planSupplier({...body,supplier:{...body.supplier,groupId:'nyroute',models:['blocked']}},{...opts,groups:[group]}));});
await check('identifier and credential references are unique even for repeated names',()=>{let c=0;const first=planSupplier(body,opts);const second=planSupplier(body,{...opts,accounts:[first.account],groups:[first.group],token:()=>String(++c)});assert.notEqual(first.account.id,second.account.id);assert.notEqual(first.account.credentialRef,second.account.credentialRef);});
for(const platform of ['custom','openai','anthropic','gemini'])await check('catalog GET '+platform,async()=>{let calls=0;const models=await discoverSupplierModels({...body,supplier:{platform,baseUrl:'https://x.invalid/v1'}},{fetchImpl:async(url,init)=>{calls++;assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.ok(!init.body);assert.ok(!url.includes('fixture-key'));if(platform==='gemini'){assert.equal(init.headers['x-goog-api-key'],'fixture-key');return Response.json({models:[{name:'models/gemini-pro',supportedGenerationMethods:['generateContent']},{name:'models/embedding',supportedGenerationMethods:['embedContent']}]});}assert.equal(url,'https://x.invalid/v1/models');assert.equal(init.headers[platform==='anthropic'?'x-api-key':'authorization'],platform==='anthropic'?'fixture-key':'Bearer fixture-key');if(platform==='anthropic'){assert.equal(init.headers['anthropic-version'],'2023-06-01');assert.equal(init.headers.authorization,'Bearer fixture-key');}return Response.json({data:[{id:'a'},{id:'a'},{id:'b'}]});}});assert.deepEqual(models,platform==='gemini'?['gemini-pro']:['a','b']);assert.equal(calls,1);});
await check('discovery errors do not expose upstream secret or response content',async()=>{for(const response of [new Response('fixture-key upstream secret',{status:401}),new Response('invalid JSON fixture-key'),Response.json({data:[]}),Response.json({unexpected:'fixture-key'})]){await assert.rejects(()=>discoverSupplierModels(body,{fetchImpl:async()=>response}),e=>!e.message.includes('fixture-key'));}await assert.rejects(()=>discoverSupplierModels(body,{fetchImpl:async()=>{throw new Error('fixture-key');}}),e=>!e.message.includes('fixture-key'));});
await check('Anthropic relay directory accepts Bearer in one request while retaining native auth', async () => {
  let calls = 0;
  const models = await discoverSupplierModels({ supplier: { platform: 'anthropic', baseUrl: 'https://relay.invalid' }, credential: 'private-relay-key' }, {
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, 'https://relay.invalid/v1/models');
      assert.equal(init.method, 'GET');
      assert.equal(init.headers['x-api-key'], 'private-relay-key');
      assert.equal(init.headers['anthropic-version'], '2023-06-01');
      if (init.headers.authorization !== 'Bearer private-relay-key') return new Response('private-relay-key upstream rejected auth', { status: 401 });
      return Response.json({ data: [{ id: 'claude-relay-model' }] });
    },
  });
  assert.deepEqual(models, ['claude-relay-model']);
  assert.equal(calls, 1, 'both auth formats use a single discovery request');
  assert.equal(JSON.stringify(models).includes('private-relay-key'), false);
});
await check('Responses and WebSocket selections survive supplier planning and use HTTP model discovery', async () => {
  const supplier={...body.supplier,platform:'openai',baseUrl:'wss://relay.invalid/proxy/v1/responses',openaiApi:'responses',openaiTransport:'websocket'};
  const planned=planSupplier({...body,supplier},opts);
  assert.equal(planned.account.openaiApi,'responses');assert.equal(planned.account.openaiTransport,'websocket');assert.equal(planned.account.baseUrl,'https://relay.invalid/proxy');
  await discoverSupplierModels({...body,supplier},{fetchImpl:async(url,init)=>{assert.equal(url,'https://relay.invalid/proxy/v1/models');assert.equal(init.method,'GET');return Response.json({data:[{id:'a'}]});}});
  for(const patch of [{openaiApi:'other'},{openaiTransport:'udp'},{openaiApi:'chat-completions'},{platform:'anthropic'}])assert.throws(()=>planSupplier({...body,supplier:{...supplier,...patch}},opts));
  assert.equal(planSupplier(body,opts).account.openaiApi,'chat-completions');assert.equal(planSupplier(body,opts).account.openaiTransport,'http');
});
console.log(`${count}/${count} supplier checks passed`);
