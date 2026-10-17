/**
 * The loopback redirect receiver.
 *
 * The authorization code has to come back to us, and with a `localhost` redirect
 * the vendor hands it to whatever is listening on that port:
 *
 *   - The listener binds ONLY when a login is actually started. A pool whose
 *     operator never uses OAuth must not hold a TCP port open for the life of the
 *     DSH process, and an abandoned login must not hold one either (see the idle
 *     close in `lib/host.js`).
 *   - The PATH is per vendor, because it is part of what the vendor registered.
 *     Anthropic's CLI callback is `/callback`; OpenAI's Codex client is
 *     `/auth/callback` under port 1455.
 *   - The PORT is usually `0` (the OS picks a free one, so two DSH instances cannot
 *     collide). It is NOT always free to choose: a vendor that registered the whole
 *     redirect URI refuses any other value with `invalid_request_error` /
 *     `invalid_authorize_request` BEFORE showing a consent screen. That is why
 *     `port` is an option here and why each provider declares what it needs.
 *
 * Nothing is authenticated here: the request carries `state`, and the ONLY thing
 * the listener does with it is hand the parameters to a handler that checks it
 * against a live flow. A callback for an unknown or expired flow renders as a
 * failure and changes nothing.
 */
import { createServer } from 'node:http';

/** The path the pool uses when the vendor does not dictate one. */
export const CALLBACK_PATH = '/oauth/callback';

/**
 * The redirect URI for one concrete port, path and host.
 *
 * `host` matters and is not cosmetic: a vendor registration matches the string, and
 * `localhost` and `127.0.0.1` are different strings to the authorization server.
 * Measured against `auth.openai.com`: `127.0.0.1:<any port>/auth/callback` is
 * accepted, while the same URI with `localhost` is refused with
 * `invalid_authorize_request`. It also defaults to `127.0.0.1` for a second,
 * unrelated reason: on a dual-stack machine `localhost` may resolve to `::1` first,
 * and a listener bound to IPv4 alone would never see the request.
 */
export function callbackRedirectUri(port, path = CALLBACK_PATH, host = '127.0.0.1') {
  return `http://${host}:${String(port)}${path}`;
}

/** Treat provider messages and account labels as text, never markup. */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

/** No script or redirect derived from callback parameters. */
function page(title, body, ok) {
  const safeTitle = escapeHtml(title);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#14161a;color:#e6e8eb}
main{max-width:34rem;padding:2rem;border:1px solid #2a2e36;border-radius:12px;background:#1b1e24}
h1{font-size:1.2rem;margin:0 0 .6rem}p{margin:.4rem 0;color:#a9b0bb;overflow-wrap:anywhere}
.ok{border-color:#2c5f3f}.bad{border-color:#6b3030}</style>
</head><body><main class="${ok ? 'ok' : 'bad'}"><h1>${ok ? '登录成功 · Sign-in complete' : safeTitle}</h1>${body}
<p>请返回 DSH 账号池页面，可关闭此标签页。</p><p>Return to the DSH account pool. You can close this tab.</p>
</main></body></html>`;
}

/**
 * Start the loopback listener.
 *
 * @param options.handler - `({ params, afterResponse }) => Promise<{ ok, title, message }>`;
 *   `afterResponse(fn)` runs cleanup after the answer flushes or the peer disconnects.
 * @param options.host - defaults to `127.0.0.1` (NOT `0.0.0.0`: a login code must
 *   not be receivable from the network).
 * @param options.port - `0` (default) asks the OS for a free port; a vendor-pinned
 *   port is passed through. Ports below 1024 need privileges, so a requested port
 *   in that range is a configuration error rather than a bind attempt.
 * @param options.path - the callback path the vendor will redirect to.
 * @returns `{ port, redirectUri, close }`, or throws if the port cannot be bound —
 *   the caller degrades to pasting the redirect URL by hand.
 */
export async function createCallbackServer(options = {}) {
  const handler = options.handler;
  if (typeof handler !== 'function') throw new Error('createCallbackServer requires a handler');
  const host = options.host ?? '127.0.0.1';
  const path = typeof options.path === 'string' && options.path.startsWith('/') ? options.path : CALLBACK_PATH;
  const requestedPort = Number.isInteger(options.port) && options.port > 0 ? options.port : 0;
  if (requestedPort !== 0 && requestedPort < 1024) {
    throw new Error(`port ${String(requestedPort)} is privileged and cannot be bound by this process`);
  }

  let closing = null;
  const server = createServer((request, response) => {
    // A callback is a single-use page. Finish the TCP response rather than
    // leaving a browser's keep-alive socket holding the listener open.
    response.setHeader('connection', 'close');
    const afterResponse = (cleanup) => {
      if (response.writableFinished || response.destroyed) {
        cleanup();
        return;
      }
      const done = () => {
        response.removeListener('finish', done);
        response.removeListener('close', done);
        cleanup();
      };
      response.once('finish', done);
      response.once('close', done);
    };
    void (async () => {
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (url.pathname !== path) {
        response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        response.end(page('Not found', '<p>This listener only serves the OAuth callback.</p>', false));
        return;
      }
      let result;
      try {
        result = await handler({ params: Object.fromEntries(url.searchParams), afterResponse });
      } catch (error) {
        result = { ok: false, title: 'Sign-in failed', message: String(error?.message ?? error) };
      }
      if (response.destroyed) return;
      response.writeHead(result?.ok === true ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page(
        result?.title ?? 'Sign-in finished',
        `<p>${escapeHtml(result?.message ?? '')}</p>`,
        result?.ok === true,
      ));
    })();
  });

  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      // A pinned port that is already taken is the interesting failure: another
      // Codex CLI (or an earlier DSH) is holding the exact port the vendor
      // registered, and the only fix is to free it or point the login elsewhere.
      if (requestedPort !== 0 && error?.code === 'EADDRINUSE') {
        reject(Object.assign(
          new Error(`port ${String(requestedPort)} is already in use — the provider requires this exact port, so free it and retry`),
          { code: 'port-in-use', port: requestedPort },
        ));
        return;
      }
      reject(error);
    });
    server.listen(requestedPort, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    host,
    path,
    port,
    redirectUri: callbackRedirectUri(port, path, host),
    /** Idempotent: a login finishing and a plugin unloading may both close it. */
    close({ drain = false } = {}) {
      if (closing === null) {
        closing = new Promise((resolve) => {
          // This is a maximum drain time, not a delay before closing. Normal
          // responses use Connection: close and release the socket immediately.
          const grace = drain ? setTimeout(() => server.closeAllConnections?.(), 1000) : null;
          grace?.unref?.();
          // Stop accepting first, so no new connection can race forced cleanup.
          server.close(() => {
            if (grace !== null) clearTimeout(grace);
            resolve();
          });
          if (drain) server.closeIdleConnections?.();
          else server.closeAllConnections?.();
        });
      } else if (!drain) {
        // Cancellation/disposal can interrupt an already requested drain.
        server.closeAllConnections?.();
      }
      return closing;
    },
  };
}
