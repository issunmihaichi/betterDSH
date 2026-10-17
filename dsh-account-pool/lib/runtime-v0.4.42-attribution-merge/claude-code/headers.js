/**
 * Header module.
 *
 * The names and values come from sub2api's `DefaultHeaders`, and the ORDER mirrors
 * its captured `headerWireOrder`.
 *
 * One honest limitation, stated rather than hidden: sub2api writes raw header names
 * into a Go response and therefore controls casing exactly. Here `fetch`/undici
 * builds a `Headers` object that lowercases names, so the request carries the
 * correct header NAMES but not the CLI's exact casing. Header names are
 * case-insensitive, so this is a fingerprint risk rather than a protocol error —
 * and it is not fixable at this layer. See DESIGN.md §21.
 *
 * The other gap is the same kind and also recorded: Node's fetch cannot shape the
 * TLS ClientHello or the HTTP/2 settings frame, so a JA3-style check still sees
 * Node rather than the CLI. Nothing at this layer can change that.
 */
import { randomUUID } from 'node:crypto';

import { CLICurrentVersion } from './constants.js';
import { claudeCliUserAgent } from './version.js';

/** Static header values the CLI presents, in captured order. */
export const CLI_HEADER_DEFAULTS = [
  ['x-stainless-retry-count', '0'],
  ['x-stainless-timeout', '600'],
  ['x-stainless-lang', 'js'],
  ['x-stainless-package-version', '0.94.0'],
  ['x-stainless-os', 'Linux'],
  ['x-stainless-arch', 'arm64'],
  ['x-stainless-runtime', 'node'],
  ['x-stainless-runtime-version', 'v24.3.0'],
  ['anthropic-dangerous-direct-browser-access', 'true'],
];

/**
 * The CLI header set for one request.
 *
 * `sessionId` is threaded through so `x-claude-code-session-id` agrees with the
 * `metadata.user_id` session. Those two are kept in sync by the real client, and
 * disagreeing about the session within one request is exactly the kind of internal
 * contradiction the check looks for.
 *
 * @param options.authMode - decides the beta set; `oauth` also implies a bearer,
 *   which the transport supplies because it owns the secret.
 * @param options.betaHeader - the resolved `anthropic-beta` value.
 * @param options.version - the resolved CLI version.
 * @param options.sessionId - the session UUID, or `undefined` to omit the header.
 * @param options.stream - whether the request is a streaming one; the CLI then
 *   adds `x-stainless-helper-method: stream`.
 * @param options.requestId - pins `x-client-request-id` (tests use this).
 * @returns a plain object of headers to merge over the request's own.
 */
export function mimicryHeaders({
  authMode = 'api-key',
  betaHeader,
  version = CLICurrentVersion,
  sessionId,
  stream = false,
  requestId,
} = {}) {
  const headers = {
    // The real CLI sends `application/json` even for streaming (`stream: true` is
    // carried in the BODY, and the response is SSE anyway). `text/event-stream`
    // here is a third-party shape: it advertises a client that negotiates the
    // response format up front, which the CLI does not do.
    accept: 'application/json',
    'x-stainless-retry-count': '0',
    'x-stainless-timeout': '600',
    'x-stainless-lang': 'js',
    'x-stainless-package-version': '0.94.0',
    'x-stainless-os': 'Linux',
    'x-stainless-arch': 'arm64',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': 'v24.3.0',
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-version': '2023-06-01',
    'x-app': 'cli',
    'user-agent': claudeCliUserAgent(version),
    'content-type': 'application/json',
  };
  if (typeof betaHeader === 'string' && betaHeader !== '') headers['anthropic-beta'] = betaHeader;
  if (authMode === 'oauth') headers['x-app'] = 'cli';
  if (typeof sessionId === 'string' && sessionId !== '') headers['x-claude-code-session-id'] = sessionId;
  headers['x-client-request-id'] = typeof requestId === 'string' && requestId !== '' ? requestId : randomUUID();
  // Last in the captured wire order, and only on streaming requests: the SDK sets
  // it to tell its own transport helper which method produced the call.
  if (stream === true) headers['x-stainless-helper-method'] = 'stream';
  return headers;
}

/** The header stage: overlay the CLI headers onto the request's own. */
export const headersModule = {
  name: 'headers',
  purpose: 'overlay the official CLI header set (UA, X-Stainless-*, betas, session ids)',
  apply(plan) {
    Object.assign(
      plan.headers,
      mimicryHeaders({
        authMode: plan.account?.authMode,
        betaHeader: plan.betas,
        version: plan.version,
        sessionId: plan.sessionId,
        stream: plan.body?.stream === true,
        requestId: plan.request?.requestId,
      }),
    );
  },
};
