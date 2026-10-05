/**
 * Minimal GitHub REST client for dsh-github.
 *
 * One job: answer "which repositories can this token see?" and hand back the
 * fields a picker needs. It is deliberately not an SDK — it issues the two
 * requests the Settings page actually makes (`/user` for the account line and
 * `/user/repos` for the listing), maps GitHub's response into this plugin's
 * own shape, and turns a failure into a reason the UI can translate.
 *
 * `fetchImpl` is injectable so the offline tests never touch the network.
 */

/** Public REST API root. */
export const GITHUB_API = 'https://api.github.com';

/** Affiliation query: everything the token can see, not just owned repos. */
export const DEFAULT_AFFILIATION = 'owner,collaborator,organization_member';

const asString = (value) => (typeof value === 'string' ? value : '');

/** GitHub repository JSON -> the picker's own shape. */
export function mapRepo(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  return {
    id: typeof source.id === 'number' ? source.id : 0,
    name: asString(source.name),
    fullName: asString(source.full_name),
    owner: asString(source.owner?.login),
    private: source.private === true,
    fork: source.fork === true,
    archived: source.archived === true,
    description: asString(source.description),
    language: asString(source.language),
    defaultBranch: asString(source.default_branch),
    updatedAt: asString(source.updated_at),
    cloneUrl: asString(source.clone_url),
    webUrl: asString(source.html_url),
    sizeKb: typeof source.size === 'number' ? source.size : 0,
  };
}

/**
 * Inject the token into an HTTPS clone URL so a private repository can be
 * fetched non-interactively. The caller is responsible for scrubbing the URL
 * back out of the clone's `origin` afterwards; see `setRemoteUrl`.
 */
export function authenticatedCloneUrl(cloneUrl, token) {
  if (typeof token !== 'string' || token === '') return cloneUrl;
  const match = /^https:\/\/([^/]+)\/(.+)$/u.exec(cloneUrl);
  if (match === null) return cloneUrl;
  return `https://x-access-token:${encodeURIComponent(token)}@${match[1]}/${match[2]}`;
}

/** Replace a token with `***` in any text git may echo back at us. */
export function scrubToken(text, token) {
  if (typeof token !== 'string' || token === '') return String(text ?? '');
  const encoded = encodeURIComponent(token);
  return String(text ?? '').split(token).join('***').split(encoded).join('***');
}

function rateLimitOf(headers) {
  if (headers === undefined || headers === null || typeof headers.get !== 'function') return null;
  const remaining = headers.get('x-ratelimit-remaining');
  const limit = headers.get('x-ratelimit-limit');
  const reset = headers.get('x-ratelimit-reset');
  if (remaining === null && limit === null) return null;
  return {
    remaining: remaining === null ? null : Number(remaining),
    limit: limit === null ? null : Number(limit),
    resetAt: reset === null ? null : Number(reset) * 1000,
  };
}

export function createGitHubApi(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const token = options.token;
  const baseUrl = options.baseUrl ?? GITHUB_API;
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': options.userAgent ?? 'dsh-github',
    'x-github-api-version': '2022-11-28',
  };
  if (typeof token === 'string' && token !== '') headers.authorization = `Bearer ${token}`;

  /** One GET, with every transport and HTTP failure folded into `{ok:false}`. */
  async function request(path) {
    let response;
    try {
      response = await fetchImpl(new URL(path, baseUrl), { headers });
    } catch (error) {
      return {
        ok: false,
        reason: 'network',
        message: `无法访问 GitHub API：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const rateLimit = rateLimitOf(response.headers);
    if (response.ok !== true) {
      let detail = '';
      try {
        const body = await response.json();
        detail = typeof body?.message === 'string' ? body.message : '';
      } catch { /* a non-JSON error body is fine */ }
      const exceeded = rateLimit !== null && rateLimit.remaining === 0;
      const reason = response.status === 401
        ? 'bad-token'
        : response.status === 403 && exceeded
          ? 'rate-limited'
          : response.status === 404
            ? 'not-found'
            : 'http-error';
      const message = reason === 'bad-token'
        ? '令牌无效或已过期（HTTP 401）'
        : reason === 'rate-limited'
          ? `GitHub API 速率限制已用尽（剩余 ${String(rateLimit?.remaining ?? 0)}，${rateLimit?.resetAt === null || rateLimit?.resetAt === undefined ? '稍后' : new Date(rateLimit.resetAt).toLocaleTimeString()} 重置）`
          : `GitHub API 返回 HTTP ${String(response.status)}${detail === '' ? '' : `：${detail}`}`;
      return { ok: false, reason, status: response.status, message, rateLimit };
    }
    const body = await response.json().catch(() => undefined);
    return { ok: true, body, rateLimit, link: response.headers?.get?.('link') ?? '' };
  }

  return {
    /** The account this token belongs to. */
    async account() {
      const result = await request('/user');
      if (result.ok !== true) return result;
      return {
        ok: true,
        account: {
          login: asString(result.body?.login),
          name: asString(result.body?.name),
          avatarUrl: asString(result.body?.avatar_url),
        },
        rateLimit: result.rateLimit,
      };
    },

    /**
     * One page of every repository this token can see, newest push first.
     * `hasMore` prefers GitHub's `Link: rel="next"` and falls back to a full page.
     */
    async listRepos(options2 = {}) {
      const page = Number.isSafeInteger(options2.page) && options2.page > 0 ? options2.page : 1;
      const perPage = Number.isSafeInteger(options2.perPage) && options2.perPage > 0 ? Math.min(100, options2.perPage) : 100;
      const query = new URLSearchParams({
        per_page: String(perPage),
        page: String(page),
        sort: 'updated',
        direction: 'desc',
        affiliation: DEFAULT_AFFILIATION,
      });
      const result = await request(`/user/repos?${query.toString()}`);
      if (result.ok !== true) return result;
      const items = Array.isArray(result.body) ? result.body.map(mapRepo) : [];
      return {
        ok: true,
        page,
        perPage,
        items,
        hasMore: /rel="next"/u.test(result.link) || items.length === perPage,
        rateLimit: result.rateLimit,
      };
    },
  };
}

/** Does this repository match a free-text query? */
export function repoMatches(repo, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle === '') return true;
  return `${repo.fullName} ${repo.description} ${repo.language}`.toLowerCase().includes(needle);
}
