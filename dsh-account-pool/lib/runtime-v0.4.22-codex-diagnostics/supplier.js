import { randomBytes } from 'node:crypto';
import { accountSchema, groupSchema } from './domain.js';

export class SupplierError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const protocols = ['anthropic', 'openai', 'gemini', 'custom'];
export function supplierEndpoint(platform, value) {
  if (!protocols.includes(platform)) throw new SupplierError('supplier-protocol', '请选择 Anthropic、OpenAI 兼容或 Gemini 协议');
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw new SupplierError('supplier-url', '请填写完整的供应商地址，例如 https://example.com'); }
  if (['openai', 'custom'].includes(platform) && ['ws:', 'wss:'].includes(url.protocol)) url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new SupplierError('supplier-url', '供应商地址只接受 HTTP / HTTPS，不能包含用户名、密码、查询参数或片段');
  }
  // Accept both the API root and a copied endpoint, without doubling /v1.
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(messages|chat\/completions|responses|models)$/, '');
  if (platform === 'gemini') url.pathname = url.pathname.replace(/\/v1(?:beta)?$/, '');
  else url.pathname = url.pathname.replace(/\/v1$/, '');
  return url.href.replace(/\/+$/, '');
}
function apiKey(value) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) throw new SupplierError('supplier-key', '请填写供应商 API Key；订阅账号请使用 OAuth 登录入口');
  return value.trim();
}
export function supplierInput(body, requireModels = true) {
  const input = body?.supplier;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SupplierError('supplier-input', '请填写供应商配置');
  const platform = input.platform;
  const openaiApi = input.openaiApi ?? 'chat-completions';
  const openaiTransport = input.openaiTransport ?? 'http';
  if (!['chat-completions', 'responses'].includes(openaiApi) || !['http', 'websocket'].includes(openaiTransport)) throw new SupplierError('supplier-openai-protocol', '请选择有效的 OpenAI 请求格式和传输方式');
  if ((!['openai', 'custom'].includes(platform) && (openaiApi !== 'chat-completions' || openaiTransport !== 'http')) || (openaiTransport === 'websocket' && openaiApi !== 'responses')) throw new SupplierError('supplier-openai-protocol', 'WebSocket 传输仅支持 OpenAI 兼容的 Responses API');
  const baseUrl = supplierEndpoint(platform, input.baseUrl);
  const credential = apiKey(body.credential);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const models = Array.isArray(input.models) && input.models.every(x => typeof x === 'string') ? [...new Set(input.models.map(x => x.trim()).filter(Boolean))] : [];
  if (requireModels && (!name || name.length > 120)) throw new SupplierError('supplier-name', '请填写供应商名称（最多 120 个字符）');
  if (requireModels && (!models.length || models.length > 500 || models.some(x => x.length > 256 || /[\r\n]/.test(x)))) throw new SupplierError('supplier-models', '请至少选择或填写一个有效模型（最多 500 个）');
  const mimicry = input.mimicry ?? 'off';
  if (!['off', 'claude-code'].includes(mimicry) || (platform !== 'anthropic' && mimicry !== 'off')) throw new SupplierError('supplier-mimicry', 'Claude Code 模式只能用于 Anthropic 协议');
  const betas = input.betas ?? [];
  if (!Array.isArray(betas) || betas.some(x => typeof x !== 'string' || /[\r\n]/.test(x))) throw new SupplierError('supplier-betas', 'Beta 参数必须是有效字符串列表');
  return { name, platform, baseUrl, openaiApi, openaiTransport, credential, models, mimicry, betas: [...new Set(betas.map(x => x.trim()).filter(Boolean))], groupId: typeof input.groupId === 'string' ? input.groupId.trim() : '' };
}
export function planSupplier(body, { accounts, groups, at, token = () => randomBytes(5).toString('hex') }) {
  const input = supplierInput(body);
  const existing = input.groupId ? groups.find(x => x.id === input.groupId) : undefined;
  if (input.groupId && !existing) throw new SupplierError('supplier-group', '所选供应商或分组已不存在，请重新选择');
  if (existing?.models.length && input.models.some(x => !existing.models.includes(x))) throw new SupplierError('supplier-group-models', '部分模型不在所选分组的白名单中，请调整模型或新建供应商');
  const prefix = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'supplier';
  let id;
  for(let tries=0;tries<8;tries++) { const next = `${prefix}-${token()}`; if(!accounts.some(x=>x.id===next) && !groups.some(x=>x.id===next)){id=next;break;} }
  if(!id) throw new SupplierError('supplier-conflict', '无法生成供应商标识，请重试', 409);
  const group = existing ?? groupSchema.parse({ id, label: input.name, models: [], createdAt: at, updatedAt: at });
  const account = accountSchema.parse({ id, label: input.name, platform: input.platform, openaiApi: input.openaiApi, openaiTransport: input.openaiTransport, baseUrl: input.baseUrl, models: input.models, groups: [group.id], authMode: 'api-key', mimicry: input.mimicry, betas: input.betas, credentialRef: `ACCOUNT_POOL_SUPPLIER_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`, createdAt: at, updatedAt: at });
  return { account, group, credential: input.credential, createGroup: !existing };
}
export async function discoverSupplierModels(body, { fetchImpl = globalThis.fetch, signal } = {}) {
  const input = supplierInput(body, false);
  const root = input.baseUrl;
  const url = input.platform === 'gemini' ? `${root}/v1beta/models?pageSize=1000` : /\/v1$/.test(root) ? `${root}/models` : `${root}/v1/models`;
  // Anthropic-compatible relays often expose an OpenAI-style model directory.
  // Keep native Anthropic auth while supplying the same key as Bearer on this GET.
  const headers = input.platform === 'anthropic' ? {'x-api-key':input.credential,'anthropic-version':'2023-06-01',authorization:`Bearer ${input.credential}`} : input.platform === 'gemini' ? {'x-goog-api-key':input.credential} : {authorization:`Bearer ${input.credential}`};
  headers.accept='application/json';
  const timeout = AbortSignal.timeout(15000);
  try {
    const response = await fetchImpl(url, { headers, method:'GET', redirect:'error', signal:signal ? AbortSignal.any([signal,timeout]) : timeout });
    if (!response.ok) throw new SupplierError('supplier-discovery-http', `获取模型失败（HTTP ${response.status}），可以直接填写模型 ID`, 502);
    const text = await response.text();
    if(text.length>2*1024*1024) throw new SupplierError('supplier-discovery-shape','模型目录过大，请手动填写模型 ID',502);
    const payload = JSON.parse(text);
    const rows = input.platform === 'gemini' ? payload.models : payload.data;
    if(!Array.isArray(rows)) throw new SupplierError('supplier-discovery-shape','供应商没有返回有效模型目录，请手动填写模型 ID',502);
    const models=[...new Set(rows.filter(x => input.platform !== 'gemini' || !Array.isArray(x.supportedGenerationMethods) || x.supportedGenerationMethods.includes('generateContent')).map(x => input.platform === 'gemini' ? String(x.name??'').replace(/^models\//,'') : x.id).filter(x=>typeof x==='string'&&x.trim()&&x.length<=256&&!/[\r\n]/.test(x)).map(x=>x.trim()))].slice(0,500);
    if(!models.length)throw new SupplierError('supplier-discovery-empty','模型目录为空，请手动填写模型 ID',502);
    return models;
  } catch(error) {
    if(error instanceof SupplierError)throw error;
    throw new SupplierError('supplier-discovery-failed', '无法获取模型目录，请检查地址与 API Key，或直接填写模型 ID',502);
  }
}
