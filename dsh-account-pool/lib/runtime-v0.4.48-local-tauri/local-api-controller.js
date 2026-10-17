/** Lifecycle and durable configuration for the loopback-only inference gateway.
 * The operator's key belongs to the credential service, never pool data/status.
 * Writes are serialized so a slow enable cannot resurrect a disabled listener.
 */
import { randomBytes } from 'node:crypto';
import { createLocalApiServer } from './local-api.js';

export const LOCAL_API_KEY_REF = 'account-pool/local-api';
export const LOCAL_API_DEFAULT_PORT = 19389;
const validKey = value => typeof value === 'string' && value.length >= 32 && value.length <= 512 && /^[A-Za-z0-9_-]+$/.test(value);
const safeError = (code, message, status = 503) => Object.assign(new Error(message), { code, status });

export function createLocalApiController({ adapter, credentials, readConfig, saveConfig, available = true, createServer = createLocalApiServer }) {
  let listener = null;
  let key = null;
  let error = null;
  let closed = false;
  let closePromise;
  let queue = Promise.resolve();
  const config = () => ({ enabled: readConfig()?.enabled === true, port: readConfig()?.port ?? LOCAL_API_DEFAULT_PORT });
  const snapshot = () => ({ ...config(), running: !!listener, baseUrl: listener?.baseUrl ?? `http://127.0.0.1:${config().port}/v1`, keyConfigured: validKey(key), error });
  const serialize = operation => {
    const task = queue.then(async () => {
      if (closed) throw safeError('local-api-closed', '本机 API 已卸载，请刷新页面。');
      return operation();
    });
    queue = task.catch(() => {});
    return task;
  };
  async function stop() {
    const old = listener;
    listener = null;
    if (old) await old.close();
  }
  async function start(port) {
    if (!available) throw safeError('local-api-unavailable', '账号池上游服务不可用，无法启动本机 API。');
    if (!validKey(key)) throw safeError('local-api-key-required', '请先生成 API Key，再启用本机 API。', 409);
    try { return await createServer({ adapter, apiKey: key, port }); }
    catch (cause) {
      throw safeError('local-api-listen-failed', cause?.code === 'EADDRINUSE'
        ? '本机 API 端口已被占用，请换一个端口。' : '无法启动本机 API，请检查端口和监听权限。');
    }
  }
  return {
    snapshot,
    initialize: () => serialize(async () => {
      try {
        const resolved = await credentials?.resolve?.(LOCAL_API_KEY_REF);
        key = validKey(resolved?.value) ? resolved.value : null;
        if (config().enabled) listener = await start(config().port);
      } catch (cause) {
        error = cause?.code?.startsWith('local-api-') ? cause.message : '无法读取本机 API 凭据，监听器未启动。';
      }
      return snapshot();
    }),
    update: body => serialize(async () => {
      if (!body || typeof body.enabled !== 'boolean' || !Number.isInteger(body.port) || body.port < 1024 || body.port > 65535
        || Object.keys(body).some(field => !['action', 'enabled', 'port'].includes(field))) {
        throw safeError('invalid-local-api', 'enabled 必须为布尔值，port 必须是 1024–65535 的整数。', 400);
      }
      // Bind a new port before disturbing the running listener or durable config.
      let next = null;
      const reuse = body.enabled && listener?.port === body.port;
      if (body.enabled && !reuse) next = await start(body.port);
      try { await saveConfig({ enabled: body.enabled, port: body.port }); }
      catch {
        await next?.close();
        throw safeError('local-api-save-failed', '无法保存本机 API 设置，原有设置和监听器未改变。');
      }
      if (!reuse) {
        await stop();
        listener = next;
      }
      error = null;
      return { ok: true, localApi: snapshot() };
    }),
    rotateKey: body => serialize(async () => {
      if (!body || Object.keys(body).some(field => field !== 'action')) throw safeError('invalid-local-api', '生成密钥不接受其他参数。', 400);
      if (typeof credentials?.set !== 'function' || typeof credentials?.resolve !== 'function') {
        throw safeError('local-api-key-unavailable', '凭据服务不可用，无法保存 API Key。');
      }
      const next = 'sk-pool-' + randomBytes(32).toString('base64url');
      try {
        // A read-only credential source must not silently shadow the newly saved key.
        const info = await credentials.describe?.(LOCAL_API_KEY_REF);
        if (info?.writable === false) throw Error('readonly');
        await credentials.set(LOCAL_API_KEY_REF, next);
        const resolved = await credentials.resolve(LOCAL_API_KEY_REF);
        if (resolved?.value !== next) throw Error('shadowed');
      } catch {
        // Do not let an old in-memory key continue authorizing if storage changed.
        try {
          const resolved = await credentials.resolve(LOCAL_API_KEY_REF);
          key = validKey(resolved?.value) ? resolved.value : null;
          if (listener && key) listener.setApiKey(key);
          else await stop();
        } catch { key = null; await stop(); }
        error = '无法确认 API Key 已保存，请检查凭据服务后重新生成。';
        throw safeError('local-api-key-save-failed', error);
      }
      key = next;
      listener?.setApiKey(next);
      error = config().enabled && !listener ? '设置为启用但尚未监听，请重新保存设置。' : null;
      return { ok: true, localApi: snapshot(), apiKey: next };
    }),
    close() {
      if (!closePromise) {
        closed = true;
        closePromise = (async () => { await queue; await stop(); key = null; })();
      }
      return closePromise;
    },
  };
}
