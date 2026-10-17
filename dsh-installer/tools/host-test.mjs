import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { CATALOG, createInstaller, inspectSource, ROUTES, apply, inject } from '../lib/host.js';
let checks = 0;
async function check(label, fn) { await fn(); checks++; console.log('ok ' + label); }
const root = resolve('fixture-repository');
const sources = async (r, n) => ({ path: join(r, n), version: '1.0.0' });
function fixture(options = {}) {
  const rows = options.rows ?? [];
  const calls = [];
  let counter = 0;
  const manager = {
    listBundles: async () => rows,
    installBundle: async (path, opts) => { calls.push({ path, opts }); if (options.install) return options.install(path, opts); return { application: 'restart-required', changed: true }; },
    setBundleEnabled: async (name, enabled) => { calls.push({ name, enabled }); return { application: 'applied', changed: true }; },
  };
  const installer = createInstaller({ manager, source: options.source ?? sources, defaultRoot: root, id: () => 'id-' + (++counter), clock: options.clock ?? (() => 1000) });
  return { installer, manager, rows, calls };
}
await check('fixed five-plugin catalog and injected official manager', () => { assert.equal(CATALOG.length, 5); assert.ok(inject.includes('pluginManager')); });
await check('status distinguishes installed, enabled and missing sources', async () => {
  const f = fixture({ rows: [{ name: CATALOG[0].name, installed: true, enabled: false, version: '0.1.0' }], source: async (r,n) => { if (n===CATALOG[1].name) throw Error('private'); return sources(r,n); } });
  const result = await f.installer.status(); assert.equal(result.plugins[0].installed, true); assert.equal(result.plugins[0].enabled, false); assert.equal(result.plugins[1].available, false); assert.ok(!JSON.stringify(result).includes('private'));
});
await check('planning is read-only and installs only after confirmation', async () => {
  const f = fixture(); const p = await f.installer.plan({ names: [CATALOG[0].name] }); assert.equal(f.calls.length, 0);
  assert.throws(() => f.installer.install({ planId: p.id }), /confirmation-required/);
  const run = f.installer.install({ planId: p.id, confirm: true }); await run.done;
  assert.equal(f.calls.length, 1); assert.equal(run.job.state, 'completed'); assert.equal(run.job.restartRequired, true); assert.equal(f.calls[0].opts.enabled, true);
  assert.throws(() => f.installer.install({ planId: p.id, confirm: true }), /plan-expired/);
});
await check('existing bundles are enabled or skipped, never reinstalled', async () => {
  const f = fixture({ rows: [{ name: CATALOG[0].name, installed: true, enabled: true }, { name: CATALOG[1].name, installed: true, enabled: false }] });
  const p = await f.installer.plan({ names: CATALOG.slice(0,2).map(x=>x.name) }); assert.deepEqual(p.items.map(x=>x.action), ['skip','enable']);
  const run = f.installer.install({ planId:p.id, confirm:true }); await run.done; assert.equal(f.calls.length,1); assert.equal(f.calls[0].name,CATALOG[1].name);
});
await check('unknown, duplicate, empty and relative-path selections refused', async () => {
  const f=fixture(); for(const names of [[], ['evil'], [CATALOG[0].name,CATALOG[0].name]]) await assert.rejects(()=>f.installer.plan({names}), /invalid-selection/);
  await assert.rejects(()=>f.installer.plan({names:[CATALOG[0].name],root:'relative'}), /absolute-repository-path-required/);
});
await check('expired confirmation plans refused', async () => { let now=1000; const f=fixture({clock:()=>now}); const p=await f.installer.plan({names:[CATALOG[0].name]}); now+=300001; assert.throws(()=>f.installer.install({planId:p.id,confirm:true}), /plan-expired/); });
await check('source version changes force a new plan', async () => { let version='1'; const f=fixture({source:async(r,n)=>({path:join(r,n),version})}); const p=await f.installer.plan({names:[CATALOG[0].name]}); version='2'; const run=f.installer.install({planId:p.id,confirm:true}); await run.done; assert.equal(run.job.results[0].code,'source-changed-replan'); assert.equal(f.calls.length,0); });
await check('partial failure stops batch and hides manager diagnostics', async () => {
  const f=fixture({install:async()=>({application:'failed',error:{code:'blocked'},packageResult:{output:'SECRET'}})}); const p=await f.installer.plan({names:CATALOG.slice(0,2).map(x=>x.name)}); const run=f.installer.install({planId:p.id,confirm:true}); await run.done; assert.equal(run.job.state,'failed'); assert.equal(f.calls.length,1); assert.ok(!JSON.stringify(run.job).includes('SECRET'));
});
await check('only one batch executes at a time', async () => { let release; const blocked=new Promise(r=>release=r); const f=fixture({install:async()=>{await blocked; return {application:'applied'};}}); const p=await f.installer.plan({names:[CATALOG[0].name]}); const run=f.installer.install({planId:p.id,confirm:true}); await assert.rejects(()=>f.installer.plan({names:[CATALOG[1].name]}), /installation-busy/); release(); await run.done; });
await check('HTTP routes require valid JSON and explicit confirmation', async()=>{
  const f=fixture(); const req=(body,type='application/json')=>new Request('http://localhost/api/test',{method:'POST',headers:{'content-type':type},body});
  assert.equal((await f.installer.handle(req('{}','text/plain'),ROUTES.plan)).status,415);
  assert.equal((await f.installer.handle(req('{'),ROUTES.plan)).status,400);
  assert.equal((await f.installer.handle(req('null'),ROUTES.plan)).status,400);
  assert.equal((await f.installer.handle(req(JSON.stringify({names:['evil']})),ROUTES.plan)).status,400);
  assert.equal((await f.installer.handle(req('{}'),ROUTES.install)).status,400);
});
await check('unavailable manager degrades and fails closed',async()=>{const i=createInstaller({defaultRoot:root,source:sources}); assert.equal((await i.status()).capable,false); await assert.rejects(()=>i.plan({names:[CATALOG[0].name]}),/plugin-manager-unavailable/);});
await check('dispose prevents further writes', async()=>{const f=fixture(); const p=await f.installer.plan({names:[CATALOG[0].name]}); f.installer.dispose(); assert.throws(()=>f.installer.install({planId:p.id,confirm:true}),/installer-stopped/);});
await check('real package source validates identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'betterdsh-test-')); try { const p=join(dir,CATALOG[0].name); await mkdir(p); await writeFile(join(p,'package.json'),JSON.stringify({name:CATALOG[0].name,version:'1',dsh:{bundle:{patch:'./cordis.patch.yml'}}})); assert.equal((await inspectSource(dir,CATALOG[0].name)).version,'1'); await writeFile(join(p,'package.json'),JSON.stringify({name:'evil'})); await assert.rejects(()=>inspectSource(dir,CATALOG[0].name),/invalid-bundle/); } finally { await rm(dir,{recursive:true,force:true}); }
});
await check('apply registers four exact authenticated channel routes and cleanup',()=>{const routes=[]; const cleanup=[]; apply({get:()=>fixture().manager,connection:{fetch:{register:r=>{routes.push(r);return()=>{};}}},effect:fn=>{const d=fn(); if(typeof d==='function')cleanup.push(d);}}); assert.equal(routes.length,4); assert.deepEqual(routes.map(x=>x.path),Object.values(ROUTES)); cleanup.forEach(fn=>fn());});
await check('problem bundles cannot be skipped or enabled as successful', async () => {
  const f = fixture({ rows: [{ name: CATALOG[0].name, installed: true, enabled: true, error: { code: 'incompatible-version' } }] });
  await assert.rejects(() => f.installer.plan({ names: [CATALOG[0].name] }), /bundle-problem/);
  assert.equal(f.calls.length, 0);
});
await check('unknown error codes and missing sources have safe recoverable summaries', async () => {
  const f = fixture({ rows: [{ name: CATALOG[0].name, installed: true, error: { code: 'secret-diagnostic' } }], source: async () => { throw new Error('secret-path'); } });
  const status = await f.installer.status();
  assert.equal(status.plugins[0].problem, 'bundle-problem');
  assert.equal(status.plugins[0].sourceProblem, 'source-unavailable');
  assert.ok(!JSON.stringify(status).includes('secret'));
});
await check('pending builds provide recovery and partial progress without raw logs', async () => {
  const f = fixture({ install: async () => ({ application: 'failed', pendingBuilds: ['private-dependency'], error: { code: 'secret-diagnostic' } }) });
  const p = await f.installer.plan({ names: CATALOG.slice(0, 2).map(x => x.name) });
  const run = f.installer.install({ planId: p.id, confirm: true }); await run.done;
  assert.equal(run.job.total, 2); assert.equal(run.job.results.length, 1);
  assert.equal(run.job.results[0].code, 'build-approval-required');
  assert.ok(!JSON.stringify(run.job).includes('private-dependency'));
});
await check('installer alone handles a real directory with no catalog plugin sources', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'betterdsh-empty-catalog-'));
  try {
    const f = fixture({ source: inspectSource });
    const result = await f.installer.status(empty);
    assert.equal(result.capable, true);
    assert.equal(result.plugins.length, 5);
    assert.ok(result.plugins.every(plugin => !plugin.installed && !plugin.available && plugin.sourceProblem === 'source-unavailable'));
    await assert.rejects(() => f.installer.plan({ root: empty, names: [CATALOG[0].name] }), /source-unavailable/);
    assert.equal(f.calls.length, 0, 'missing source never triggers installation');
  } finally {
    assert.equal(dirname(resolve(empty)), resolve(tmpdir()));
    assert.ok(basename(empty).startsWith('betterdsh-empty-catalog-'));
    await rm(empty, { recursive: true, force: true });
  }
});
console.log(`${checks}/${checks} host scenarios passed; no live profile changes`);
