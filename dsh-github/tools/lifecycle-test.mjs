/** Real apply(), fake Cordis service lifetimes, disposable local fixtures only. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { apply, ROUTES } from '../lib/host.js';

const fixture = await mkdtemp(join(tmpdir(), 'github-lifecycle-'));
const oldHome = process.env.DSH_HOME;
const services = new Map();
const routes = new Map();
const effects = [];
const children = [];
const calls = [];
function effect(list, fn) { const cleanup = fn(); if (typeof cleanup === 'function') list.push(cleanup); return cleanup; }
function stop(list) { for (const cleanup of list.splice(0).reverse()) cleanup(); }
const ctx = {
  get: name => services.get(name),
  connection: { fetch: { register: route => {
    assert.ok(!routes.has(route.path)); routes.set(route.path, route);
    return () => routes.delete(route.path);
  } } },
  effect: fn => effect(effects, fn),
  inject: (names, callback) => { children.push({ names, callback, effects: [] }); },
  logger: { info() {}, warn() {} },
};
function mountCommands(id) {
  const command = { register: definition => {
    assert.equal(definition.name, 'github'); calls.push(['register', id]);
    return () => calls.push(['dispose', id]);
  } };
  services.set('commands', command);
  for (const child of children) {
    stop(child.effects);
    child.callback({ get: name => services.get(name), effect: fn => effect(child.effects, fn) });
  }
}
const request = async route => {
  const response = await routes.get(route).fetch(new Request(`http://fixture.invalid${route}`));
  assert.equal(response.status, 200);
  return response.json();
};
try {
  process.env.DSH_HOME = fixture;
  const clones = join(fixture, 'repos');
  await mkdir(join(clones, 'example', '.git'), { recursive: true });
  apply(ctx, { workspaceRoot: clones, fetchImpl: () => { throw new Error('Network forbidden'); } });
  assert.equal(routes.size, Object.keys(ROUTES).length, 'no optional services are needed to mount the API');
  assert.deepEqual(children.map(child => child.names), [['commands']]);
  assert.deepEqual(calls, []);
  assert.ok(await request(ROUTES.settings)); // drain the initial local settings load
  const repos = async () => (await request(ROUTES.clone)).repos;
  assert.equal((await repos()).length, 1);
  assert.equal((await repos())[0].workspaceId, undefined);
  for (const id of ['late-registry', 'replacement-registry']) {
    services.set('workspaceRegistry', { resolveByPath: async () => ({ id }) });
    assert.equal((await repos())[0].workspaceId, id, 'lookup uses the current registry');
  }
  services.delete('workspaceRegistry');
  assert.equal((await repos())[0].workspaceId, undefined, 'unloaded registry is not retained');
  mountCommands('first');
  assert.deepEqual(calls, [['register', 'first']]);
  for (const child of children) stop(child.effects);
  services.delete('commands');
  assert.deepEqual(calls, [['register', 'first'], ['dispose', 'first']]);
  assert.ok(await request(ROUTES.settings), 'command unload does not withdraw settings');
  mountCommands('second');
  assert.deepEqual(calls.at(-1), ['register', 'second']);
  for (const child of children) stop(child.effects);
  stop(effects);
  assert.deepEqual(calls.at(-1), ['dispose', 'second']);
  assert.equal(routes.size, 0);
  console.log('GitHub lifecycle: absent/late/replaced/unloaded optional services passed; no network or live profile.');
} finally {
  for (const child of children) stop(child.effects);
  stop(effects);
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
  assert.equal(dirname(resolve(fixture)), resolve(tmpdir()));
  assert.ok(basename(fixture).startsWith('github-lifecycle-'));
  await rm(fixture, { recursive: true, force: true });
}
