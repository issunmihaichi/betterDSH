import { discoverSupplierModels, SupplierError } from './supplier.js';

/** Four workers bound upstream requests, including backend credential resolution. */
const DISCOVERY_CONCURRENCY = 4;
const DEFAULT_BASES = {
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  openai: 'https://api.openai.com',
  custom: 'https://api.openai.com',
  grok: 'https://api.openai.com',
};

export class GroupModelsError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

/** Discover the upstream catalogs, never the adapter's whitelist-filtered menu. */
export async function discoverGroupModels(group, accounts, { resolveCredential, fetchImpl, signal }) {
  if (!group) throw new GroupModelsError('unknown-group', '分组不存在，请刷新后重试', 404);
  const members = accounts.filter(account => account.groups?.includes(group.id));
  if (!members.length) throw new GroupModelsError('group-empty', '分组中没有账号，请先添加账号');
  const sources = new Array(members.length);
  let next = 0;
  async function discover(account) {
    const source = { id: account.id, label: account.label || account.id, models: [] };
    if (account.authMode === 'oauth') {
      return { ...source, error: 'OAuth 订阅账号暂不支持从上游获取模型，请手动填写模型 ID' };
    }
    if (signal?.aborted) return { ...source, error: '获取模型已取消，请重试' };
    let credential;
    try { credential = await resolveCredential(account); }
    catch { return { ...source, error: '无法读取账号凭据，请检查凭据配置后重试' }; }
    if (typeof credential !== 'string' || !credential.trim()) {
      return { ...source, error: '账号未配置 API Key，请先配置凭据' };
    }
    try {
      // Grok/custom use the same OpenAI-compatible transport as real pool calls.
      const platform = ['grok', 'custom'].includes(account.platform) ? 'custom' : account.platform;
      const models = await discoverSupplierModels({
        supplier: { platform, baseUrl: account.baseUrl ?? DEFAULT_BASES[account.platform] }, credential,
      }, { fetchImpl, signal });
      // Even a misbehaving upstream must not echo the resolved secret to the browser.
      source.models = models.filter(model => !model.includes(credential.trim()));
      if (!source.models.length) return { ...source, error: '供应商没有返回可用模型，请手动填写模型 ID' };
      return source;
    } catch (error) {
      // SupplierError messages originate in our helper, never upstream response text.
      return { ...source, error: error instanceof SupplierError ? error.message : '无法获取模型目录，请检查地址与 API Key 后重试' };
    }
  }
  await Promise.all(Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, members.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= members.length) return;
      sources[index] = await discover(members[index]);
    }
  }));
  return { models: [...new Set(sources.flatMap(source => source.models))], sources };
}
