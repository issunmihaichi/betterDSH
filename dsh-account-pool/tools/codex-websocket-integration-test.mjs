import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createHttpUpstream, parseSse } from '../lib/upstream.js';
import { buildCodexRequest, mapCodex, getCodexContinuationOutput } from '../lib/native/codex.js';
import { createCodexReplayCodec } from '../lib/native/codex-replay.js';

// Synthetic credentials and injected transport only; no vendor requests.
const codec = createCodexReplayCodec(Buffer.alloc(32, 7));
const account = { id: 'fixture-a', createdAt: '2026-01-01T00:00:00Z', credentialRef: 'FIXTURE', platform: 'openai', authMode: 'oauth', openaiTransport: 'websocket' };
const bundle = { access_token: 'FIXTURE-NOT-A-TOKEN', chatgpt_account_id: 'FIXTURE-WORKSPACE' };
const options = { model: 'fixture-model', sessionId: 'fixture-session', system: 'Synthetic instructions', reasoningEffort: 'high', tools: [{ name: 'python', parameters: { type: 'object' } }], messages: [{ role: 'user', content: 'Start' }] };
const reason = { id: 'rs_fixture', type: 'reasoning', encrypted_content: 'private-fixture-reasoning', summary: [] };
const text = (value='Done') => ({ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: value }] });
const call = { id: 'fc_item', type: 'function_call', status: 'completed', call_id: 'call_native', name: 'python__pool', arguments: '{"b":2,"a":1}' };
const complete = (output=[reason,text()], id='resp_fixture') => ({ type: 'response.completed', response: { id, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } } } });
const sse = event => new Response(`data: ${JSON.stringify(event)}\n\n`);
function assistant(chunks) {
 const order=chunks.filter(c=>c.type==='block-start').map(c=>c.index);
 const blocks=new Map(chunks.filter(c=>c.type==='block-end').map(c=>[c.index,c.block]));
 return { role: 'assistant', content: order.map(i=>blocks.get(i)), source: { replayState: chunks.find(c=>c.type==='finish')?.replayState } };
}
function fixture(t, handler) {
 const sockets=[], sent=[];let credential={...bundle},fetches=0,dispatches=0;
 class FakeSocket extends EventEmitter {
  constructor(url,init) {super();this.readyState=0;this.url=url;this.init=init;sockets.push(this);queueMicrotask(()=>{if(this.readyState===0){this.readyState=1;this.emit('open');}});}
  send(raw,callback) {const body=JSON.parse(raw);sent.push({socket:this,body});callback?.();queueMicrotask(()=>handler?handler(this,body,sent.length):this.emit('message',Buffer.from(JSON.stringify(complete(undefined,`resp_${sent.length}`))),false));}
  terminate() {if(this.readyState===3)return;this.readyState=3;queueMicrotask(()=>this.emit('close'));}
 }
 const upstream=createHttpUpstream({webSocketImpl:FakeSocket,codexReplayCodec:codec,resolveCredential:async()=>credential,
   webSocketConnectTimeoutMs:500,webSocketIdleTimeoutMs:500,onCodexRequest:()=>dispatches++,fetchImpl:async()=>{fetches++;return sse(complete([reason,text('HTTP')],'resp_http'));}});
 t.after(()=>upstream.dispose());
 return {upstream,sockets,sent,setCredential:next=>{credential=next;},get fetches(){return fetches;},get dispatches(){return dispatches;}};
}

test('Codex WS integrated full first request then tool-result and next-turn deltas', async t=>{
 const f=fixture(t,(socket,body,n)=>socket.emit('message',Buffer.from(JSON.stringify(complete(n===1?[reason,call]:[reason,text(`reply-${n}`)],`resp_${n}`))),false));
 const first=await Array.fromAsync(f.upstream.stream(account,options));
 assert.equal(first.at(-1).reason.kind,'tool-calls');
 const history=[...options.messages,assistant(first),{role:'tool',toolCallId:'call_native',content:'3'}];
 // DSH parsing/re-encoding tool argument JSON must not disable semantic continuation.
 history[1].content[0].arguments={a:1,b:2};
 const second=await Array.fromAsync(f.upstream.stream(account,{...options,messages:history,codexTurnId:'new-turn'}));
 assert.equal(f.sockets.length,1);assert.equal(f.sent[1].body.previous_response_id,'resp_1');
 assert.deepEqual(f.sent[1].body.input,[{type:'function_call_output',call_id:'call_native',output:'3'}]);
 const thirdHistory=[...history,assistant(second),{role:'user',content:'Continue'}];
 await Array.fromAsync(f.upstream.stream(account,{...options,messages:thirdHistory,codexTurnId:'another-turn'}));
 assert.equal(f.sockets.length,1);assert.equal(f.sent[2].body.previous_response_id,'resp_2');assert.equal(f.sent[2].body.input.length,1);
 assert.equal(f.sent[0].body.type,'response.create');assert.equal(f.sent[0].body.stream,true);assert.deepEqual(f.sent[0].body.reasoning,{effort:'high'});
 assert.equal(f.sockets[0].url,'wss://chatgpt.com/backend-api/codex/responses');
 assert.equal(f.sockets[0].init.headers['openai-beta'],'responses_websockets=2026-02-06');
 assert.equal(f.sockets[0].init.headers.authorization,`Bearer ${bundle.access_token}`);assert.equal(f.sockets[0].init.followRedirects,false);
 assert.equal(f.fetches,0);assert.equal(f.dispatches,3);
 assert.equal(JSON.stringify(first).includes(reason.encrypted_content),false);assert.equal(JSON.stringify(f.upstream.codexWebSocketSnapshot()).includes(bundle.access_token),false);
});

test('changed instructions, effort, tools, edited history and missing replay use full request',async t=>{
 for(const change of [next=>({...next,system:'Changed'}),next=>({...next,reasoningEffort:'xhigh'}),next=>({...next,tools:[]}),
  next=>({...next,messages:[{role:'user',content:'Edited'},...next.messages.slice(1)]}),
  next=>({...next,messages:next.messages.map(m=>m.role==='assistant'?{...m,source:undefined}:m)})]){
  const f=fixture(t);const chunks=await Array.fromAsync(f.upstream.stream(account,options));
  const next=change({...options,messages:[...options.messages,assistant(chunks),{role:'user',content:'Next'}]});
  await Array.fromAsync(f.upstream.stream(account,next));assert.equal(f.sent[1].body.previous_response_id,undefined);assert.ok(f.sent[1].body.input.length>=3);
 }
});

test('account, token, workspace, model and fork identity changes never inherit response id',async t=>{
 for(const change of ['account','token','workspace','model','session']){
  const f=fixture(t);const chunks=await Array.fromAsync(f.upstream.stream(account,options));
  if(change==='token')f.setCredential({...bundle,access_token:'ROTATED-FIXTURE'});
  if(change==='workspace')f.setCredential({...bundle,chatgpt_account_id:'OTHER-WORKSPACE'});
  await Array.fromAsync(f.upstream.stream(change==='account'?{...account,id:'fixture-b'}:account,{...options,
   ...(change==='model'?{model:'different-model'}:{}),...(change==='session'?{sessionId:'fork-session'}:{}),
   messages:[...options.messages,assistant(chunks),{role:'user',content:'Next'}]}));
  assert.equal(f.sockets.length,2,change);assert.equal(f.sent[1].body.previous_response_id,undefined,change);
 }
});

test('special-purpose and no-session requests never retain connection or continuation',async t=>{
 for(const opts of [{...options,sessionId:undefined},{...options,purpose:'session-title'},{...options,purpose:'compaction'}]){
  const f=fixture(t);await Array.fromAsync(f.upstream.stream(account,opts));await Array.fromAsync(f.upstream.stream(account,opts));
  assert.equal(f.sockets.length,2);assert.equal(f.sent[1].body.previous_response_id,undefined);
 }
});

test('WS connection failure before output falls back to unchanged HTTP body',async t=>{
 const f=fixture(t,socket=>socket.emit('error',Error('PRIVATE raw network error')));
 const chunks=await Array.fromAsync(f.upstream.stream(account,options));assert.equal(chunks.at(-1).type,'finish');assert.equal(f.fetches,1);
 assert.equal(chunks.filter(c=>c.type==='text-delta').map(c=>c.text).join(''),'HTTP');
 await Array.fromAsync(f.upstream.stream(account,{...options,messages:[...options.messages,assistant(chunks),{role:'user',content:'Next'}]}));
 assert.equal(f.sockets.length,1);assert.equal(f.fetches,2);
});

test('WS partial output is never replayed through HTTP',async t=>{
 const f=fixture(t,socket=>{socket.emit('message',Buffer.from(JSON.stringify({type:'response.output_text.delta',output_index:0,item_id:'msg_partial',content_index:0,delta:'partial'})),false);
  setImmediate(()=>socket.terminate());});
 const seen=[];await assert.rejects(async()=>{for await(const chunk of f.upstream.stream(account,options))seen.push(chunk);});
 assert.ok(seen.some(c=>c.type==='text-delta'));assert.equal(f.fetches,0);
});

test('HTTP selected account never opens WS and changing back invalidates old socket',async t=>{
 const f=fixture(t);await Array.fromAsync(f.upstream.stream(account,options));
 await Array.fromAsync(f.upstream.stream({...account,openaiTransport:'http'},options));assert.equal(f.fetches,1);assert.equal(f.sockets[0].readyState,3);
 await Array.fromAsync(f.upstream.stream(account,options));assert.equal(f.sockets.length,2);assert.equal(f.sent[1].body.previous_response_id,undefined);
});

test('mapper sidecar is private, defensive, and refuses incomplete or unsupported output',async()=>{
 const build=()=>buildCodexRequest(account,options,bundle,{replayCodec:codec});
 const request=build();const chunks=await Array.fromAsync(mapCodex(sse(complete([reason,call,text()])).body,parseSse,request.context));
 const expected=JSON.parse(buildCodexRequest(account,{...options,messages:[assistant(chunks)]},bundle,{replayCodec:codec}).init.body).input;
 assert.deepEqual(getCodexContinuationOutput(request.context),expected);
 const leaked=getCodexContinuationOutput(request.context);leaked.length=0;assert.equal(getCodexContinuationOutput(request.context).length,3);
 assert.equal(JSON.stringify(request.context).includes(reason.encrypted_content),false);
 await assert.rejects(Array.fromAsync(mapCodex(sse({type:'response.failed',response:{error:{code:'invalid_request_error'}}}).body,parseSse,request.context)));
 assert.equal(getCodexContinuationOutput(request.context),undefined);
 for(const output of [[{...reason,encrypted_content:undefined},text()],[{type:'web_search_call',id:'unsupported'},text()]]){
  const r=build();await Array.fromAsync(mapCodex(sse(complete(output)).body,parseSse,r.context));assert.equal(getCodexContinuationOutput(r.context),undefined);
 }
});

function toolImageRegressionCase() {
 const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFhQAAAAASUVORK5CYII=';
 const image = { type: 'image', mediaType: 'image/png', data };
 const wireImage = { type: 'input_image', image_url: `data:image/png;base64,${data}`, detail: 'auto' };
 return {
  content: [
   { type: 'text', text: 'before' }, { ...image },
   { type: 'text', text: 'between' }, { ...image },
   { type: 'text', text: 'after' },
  ],
  output: [
   { type: 'input_text', text: 'before' }, { ...wireImage },
   { type: 'input_text', text: 'between' }, { ...wireImage },
   { type: 'input_text', text: 'after' },
  ],
 };
}

test('Codex WS tool images survive incremental call-id rewrite and later full history replay', async t => {
 const f = fixture(t, (socket, body, n) => socket.emit('message', Buffer.from(JSON.stringify(
  complete(n === 1 ? [reason, call] : [reason, text(`image-reply-${n}`)], `resp_image_${n}`),
 )), false));
 const { content, output } = toolImageRegressionCase();
 const first = await Array.fromAsync(f.upstream.stream(account, options));
 assert.equal(first.at(-1).reason.kind, 'tool-calls');
 const history = [...options.messages, assistant(first), { role: 'tool', toolCallId: 'call_native', content }];
 const original = structuredClone(history);
 const second = await Array.fromAsync(f.upstream.stream(account, { ...options, messages: history }));
 assert.deepEqual(history, original, 'request preparation must not mutate tool history');
 assert.equal(f.sent[1].body.previous_response_id, 'resp_image_1');
 assert.deepEqual(f.sent[1].body.input, [
  { type: 'function_call_output', call_id: 'call_native', output },
 ], 'delta keeps ordered multimodal output and restores the native server call id');

 const thirdHistory = [...history, assistant(second), { role: 'user', content: 'Continue after the images' }];
 const third = await Array.fromAsync(f.upstream.stream(account, { ...options, messages: thirdHistory }));
 assert.equal(f.sent[2].body.previous_response_id, 'resp_image_2');
 assert.deepEqual(f.sent[2].body.input, [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue after the images' }] },
 ], 'matching history reuses server state rather than dropping to full replay or duplicating images');

 // A changed request property forces a full request. JSON round-tripping also
 // exercises the persisted, provider-neutral image history rather than object identity.
 const persistedHistory = JSON.parse(JSON.stringify([
  ...thirdHistory, assistant(third), { role: 'user', content: 'Replay the full history' },
 ]));
 await Array.fromAsync(f.upstream.stream(account, {
  ...options, system: 'Changed synthetic instructions', messages: persistedHistory,
 }));
 const full = f.sent[3].body;
 assert.equal(full.previous_response_id, undefined);
 assert.deepEqual(full.input.filter(item => item.type === 'function_call_output'), [
  { type: 'function_call_output', call_id: 'fc_native', output },
 ], 'full replay retains both images exactly once and uses normalized call ids');
 assert.equal(full.input.filter(item => item.type === 'function_call').length, 1);
 assert.equal(full.input.find(item => item.type === 'function_call').call_id, 'fc_native');
 assert.ok(full.input.filter(item => item.role === 'user').every(item =>
  item.content.every(part => part.type !== 'input_image'),
 ), 'tool images must not be promoted to a synthetic user message');
 assert.equal(f.fetches, 0);
 assert.equal(f.sockets.length, 1);
});

test('Codex WS image delta failure falls back to full multimodal HTTP and retains images next turn', async t => {
 const sent = [];
 const httpBodies = [];
 class ToolImageFallbackSocket extends EventEmitter {
  constructor() {
   super();
   this.readyState = 0;
   queueMicrotask(() => {
    if (this.readyState === 0) { this.readyState = 1; this.emit('open'); }
   });
  }
  send(raw, callback) {
   const body = JSON.parse(raw);
   sent.push(body);
   callback?.();
   queueMicrotask(() => {
    if (sent.length === 1) {
     this.emit('message', Buffer.from(JSON.stringify(complete([reason, call], 'resp_image_seed'))), false);
    } else {
     // Failure before any output of the second response permits HTTP fallback.
     this.emit('error', new Error('SYNTHETIC pre-output transport failure'));
    }
   });
  }
  terminate() {
   if (this.readyState === 3) return;
   this.readyState = 3;
   queueMicrotask(() => this.emit('close'));
  }
 }
 const upstream = createHttpUpstream({
  webSocketImpl: ToolImageFallbackSocket,
  codexReplayCodec: codec,
  resolveCredential: async () => ({ ...bundle }),
  webSocketConnectTimeoutMs: 500,
  webSocketIdleTimeoutMs: 500,
  fetchImpl: async (url, init) => {
   httpBodies.push(JSON.parse(init.body));
   return sse(complete([reason, text('HTTP image reply')], `resp_image_http_${httpBodies.length}`));
  },
 });
 t.after(() => upstream.dispose());
 const { content, output } = toolImageRegressionCase();
 const first = await Array.fromAsync(upstream.stream(account, options));
 const history = [...options.messages, assistant(first), { role: 'tool', toolCallId: 'call_native', content }];
 const expectedFullInput = JSON.parse(buildCodexRequest(account, {
  ...options, messages: history,
 }, bundle, { replayCodec: codec }).init.body).input;
 const second = await Array.fromAsync(upstream.stream(account, { ...options, messages: history }));
 assert.equal(second.at(-1).type, 'finish');
 assert.equal(second.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'HTTP image reply');
 assert.equal(sent.length, 2);
 assert.equal(sent[1].previous_response_id, 'resp_image_seed');
 assert.deepEqual(sent[1].input, [
  { type: 'function_call_output', call_id: 'call_native', output },
 ]);
 assert.equal(httpBodies.length, 1);
 assert.equal(httpBodies[0].previous_response_id, undefined);
 assert.equal(httpBodies[0].type, undefined);
 assert.deepEqual(httpBodies[0].input, expectedFullInput,
  'fallback must use the original full request, not the incremental WS payload');
 assert.deepEqual(httpBodies[0].input.filter(item => item.type === 'function_call_output'), [
  { type: 'function_call_output', call_id: 'fc_native', output },
 ]);

 // A connection failure suppresses further WS attempts for this session. The
 // following ordinary turn must replay the image-bearing tool result through HTTP.
 const nextHistory = JSON.parse(JSON.stringify([
  ...history, assistant(second), { role: 'user', content: 'Use the previous tool images' },
 ]));
 await Array.fromAsync(upstream.stream(account, { ...options, messages: nextHistory }));
 assert.equal(sent.length, 2, 'suppressed WS must not be retried on the next turn');
 assert.equal(httpBodies.length, 2);
 assert.equal(httpBodies[1].previous_response_id, undefined);
 assert.deepEqual(httpBodies[1].input.filter(item => item.type === 'function_call_output'), [
  { type: 'function_call_output', call_id: 'fc_native', output },
 ]);
 assert.deepEqual(httpBodies[1].input.at(-1), {
  type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Use the previous tool images' }],
 });
});
