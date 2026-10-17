import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, join, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const name = 'dsh-installer';
export const inject = ['connection', 'pluginManager'];
import { CATALOG, bundleAction, publicErrorCode } from './catalog.js';
export { CATALOG } from './catalog.js';
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ALLOWED = new Set(CATALOG.map(x => x.name));
export const ROUTES = { status: '/api/betterdsh.status', plan: '/api/betterdsh.plan', install: '/api/betterdsh.install', job: '/api/betterdsh.job' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });

/** Only the fixed catalog is executable; paths and identities are checked before planning. */
export async function inspectSource(root, plugin) {
  const realRoot = await realpath(root);
  const dir = await realpath(join(realRoot, plugin));
  const rel = relative(realRoot, dir);
  if (rel.startsWith('..') || isAbsolute(rel)) throw fail('source-outside-repository');
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  if (manifest.name !== plugin || typeof manifest.version !== 'string' || !manifest.dsh?.bundle?.patch) throw fail('invalid-bundle');
  return { path: dir, version: manifest.version };
}

export function createInstaller({ manager, source = inspectSource, defaultRoot = DEFAULT_ROOT, clock = Date.now, id = randomUUID }) {
  const plans = new Map();
  let currentJob = null;
  let disposed = false;
  const capable = () => typeof manager?.listBundles === 'function' && typeof manager?.installBundle === 'function' && typeof manager?.setBundleEnabled === 'function';
  const rootOf = value => {
    const root = value === undefined || value === '' ? defaultRoot : value;
    if (typeof root !== 'string' || !isAbsolute(root) || root.length > 4096) throw fail('absolute-repository-path-required');
    return resolve(root);
  };
  async function status(root) {
    root = rootOf(root);
    const bundles = capable() ? await manager.listBundles() : [];
    const plugins = await Promise.all(CATALOG.map(async item => {
      const installed = bundles.find(row => row.name === item.name);
      let available;
      let sourceProblem = null;
      try { available = await source(root, item.name); }
      catch (error) { available = null; sourceProblem = publicErrorCode(error.code, 'source-unavailable'); }
      return { ...item, available: !!available, sourceProblem, sourceVersion: available?.version ?? null, installed: installed?.installed === true,
        enabled: installed?.enabled === true, installedVersion: installed?.version ?? null, problem: installed?.error ? publicErrorCode(installed.error.code, 'bundle-problem') : null };
    }));
    return { capable: capable(), root, plugins, job: currentJob };
  }
  async function plan(body) {
    if (!capable()) throw fail('plugin-manager-unavailable', 503);
    if (disposed) throw fail('installer-stopped', 503);
    if (currentJob?.state === 'running') throw fail('installation-busy', 409);
    const root = rootOf(body.root);
    if (!Array.isArray(body.names) || !body.names.length || body.names.length > 5 || body.names.some(n => !ALLOWED.has(n)) || new Set(body.names).size !== body.names.length) throw fail('invalid-selection');
    const bundles = await manager.listBundles();
    const items = [];
    for (const plugin of body.names) {
      const installed = bundles.find(x => x.name === plugin && x.installed);
      const action = bundleAction(installed);
      if (action === 'blocked') throw fail('bundle-problem', 409);
      let available = null;
      if (action === 'install') {
        try { available = await source(root, plugin); }
        catch (error) { throw fail(publicErrorCode(error.code, 'source-unavailable')); }
      }
      items.push({ name: plugin, action, path: available?.path, version: available?.version ?? installed?.version ?? null });
    }
    for (const [key, value] of plans) if (value.expiresAt <= clock()) plans.delete(key);
    if (plans.size >= 20) plans.delete(plans.keys().next().value);
    const result = { id: id(), root, expiresAt: clock() + 300000, items };
    plans.set(result.id, result);
    return result;
  }
  function install(body) {
    if (disposed) throw fail('installer-stopped', 503);
    if (body.confirm !== true) throw fail('confirmation-required');
    if (currentJob?.state === 'running') throw fail('installation-busy', 409);
    const pending = plans.get(body.planId);
    if (!pending || pending.expiresAt <= clock()) throw fail('plan-expired', 409);
    plans.delete(body.planId);
    const job = { id: id(), state: 'running', total: pending.items.length, planned: pending.items.map(item => item.name), results: [], active: null, restartRequired: false, startedAt: clock() };
    currentJob = job;
    const done = (async () => {
      for (const item of pending.items) {
        if (disposed) { job.state = 'stopped'; break; }
        job.active = item.name;
        try {
          const bundles = await manager.listBundles();
          const installed = bundles.find(x => x.name === item.name && x.installed);
          let result;
          if (bundleAction(installed) === 'blocked') throw fail('bundle-problem');
          if (installed?.enabled) { job.results.push({ name: item.name, state: 'skipped' }); continue; }
          if (installed) result = await manager.setBundleEnabled(item.name, true);
          else {
            const fresh = await source(pending.root, item.name);
            if (fresh.path !== item.path || fresh.version !== item.version) throw fail('source-changed-replan');
            result = await manager.installBundle(fresh.path, { enabled: true, requestId: `${job.id}:${item.name}` });
          }
          if (!result || !['applied', 'restart-required'].includes(result.application)) {
            const code = result?.pendingBuilds?.length ? 'build-approval-required' : result?.application === 'overridden' ? 'overridden' : publicErrorCode(result?.error?.code);
            job.results.push({ name: item.name, state: 'failed', code });
            job.state = 'failed'; break;
          }
          job.restartRequired ||= result.application === 'restart-required';
          job.results.push({ name: item.name, state: result.application, warnings: Array.isArray(result.warnings) ? result.warnings.length : 0 });
        } catch (error) {
          // Do not send package-manager output, credentials, or exception messages to the browser.
          job.results.push({ name: item.name, state: 'failed', code: publicErrorCode(error.code) });
          job.state = 'failed'; break;
        }
      }
      job.active = null;
      if (job.state === 'running') job.state = 'completed';
      job.finishedAt = clock();
    })();
    return { job, done };
  }
  async function handle(request, route) {
    try {
      if (route === ROUTES.status) return json(await status(new URL(request.url).searchParams.get('root') || undefined));
      if (route === ROUTES.job) return json({ job: currentJob });
      if (!request.headers.get('content-type')?.startsWith('application/json')) throw fail('json-required', 415);
      const text = await request.text();
      if (text.length > 16384) throw fail('request-too-large', 413);
      let body; try { body = JSON.parse(text); } catch { throw fail('invalid-json'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('invalid-request');
      if (route === ROUTES.plan) return json(await plan(body));
      if (route === ROUTES.install) return json({ job: install(body).job }, 202);
      throw fail('not-found', 404);
    } catch (error) { return json({ error: { code: error.status ? error.code : 'operation-failed' } }, error.status ?? 500); }
  }
  return { status, plan, install, handle, dispose: () => { disposed = true; plans.clear(); } };
}
export function apply(ctx) {
  const installer = createInstaller({ manager: ctx.get('pluginManager') });
  for (const route of Object.values(ROUTES)) ctx.effect(() => ctx.connection.fetch.register({ path: route, methods: [route === ROUTES.status || route === ROUTES.job ? 'GET' : 'POST'], requestBody: 'buffered', fetch: request => installer.handle(request, route) }), `betterdsh:${route}`);
  ctx.effect(() => () => installer.dispose(), 'betterdsh: lifecycle');
}
