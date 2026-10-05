/**
 * Context window classification — pure functions.
 *
 * These decide *what* each part of the current request is, never how big it is:
 * the caller injects DSH's own estimator (`@deepseek-ai/dsh-token-meter/estimate`
 * in the Host half), so every number below is priced exactly the way DSH prices
 * the official `contextBreakdown` it is compared against.
 *
 * Two facts make the classification exact rather than guessed:
 *   - MCP tools are registered under `mcp__<server>__<tool>` (dsh-mcp-client);
 *   - DSH injects its skill catalog as one durable `user/message` whose
 *     `source.kind` is `skill-catalog` and whose `source.entries` list the skills.
 */

/** MCP tools are registered under this namespace prefix (dsh-mcp-client). */
export const MCP_PREFIX = 'mcp__';

/**
 * MCP public name -> `{ server, rawName }`; `undefined` for a built-in tool.
 * @param toolName - model-facing tool name.
 * @returns the MCP coordinates, or undefined when the name is not namespaced.
 */
export function mcpCoordinates(toolName) {
  if (typeof toolName !== 'string' || !toolName.startsWith(MCP_PREFIX)) return undefined;
  const rest = toolName.slice(MCP_PREFIX.length);
  const separator = rest.indexOf('__');
  if (separator <= 0) return { server: '', rawName: rest };
  return { server: rest.slice(0, separator), rawName: rest.slice(separator + 2) };
}

/**
 * Split the current request envelope's tool schemas into MCP and built-in, each
 * priced by the injected estimator. `total` is the whole-array price, so a
 * caller can normalize the two sides onto the official number.
 * @param tools - tool schemas from the latest `request/header`.
 * @param options - `{ maxItems, priceTools }`; `priceTools(tools)` returns tokens.
 * @returns `{ total, mcp, system }`; every price is in the estimator's tokens.
 */
export function splitTools(tools, options) {
  const { maxItems, priceTools } = options;
  const list = Array.isArray(tools) ? tools : [];
  const mcp = list.filter((tool) => mcpCoordinates(tool?.name) !== undefined);
  const system = list.filter((tool) => mcpCoordinates(tool?.name) === undefined);
  const price = (tool) => priceTools([tool]);
  const detail = (entries) => entries
    .map((tool) => {
      const coordinates = mcpCoordinates(tool.name);
      return {
        name: String(tool.name),
        tokens: price(tool),
        ...coordinates === undefined ? {} : { server: coordinates.server, rawName: coordinates.rawName },
      };
    })
    .sort((left, right) => right.tokens - left.tokens || (left.name < right.name ? -1 : 1));
  const servers = new Map();
  for (const tool of mcp) {
    const { server } = mcpCoordinates(tool.name);
    const row = servers.get(server) ?? { server, count: 0, tokens: 0, tools: [] };
    row.count += 1;
    row.tokens += price(tool);
    row.tools.push(tool);
    servers.set(server, row);
  }
  return {
    total: priceTools(list),
    mcp: {
      count: mcp.length,
      tokens: priceTools(mcp),
      tokensByTool: mcp.reduce((sum, tool) => sum + price(tool), 0),
      // One level below the MCP row: the servers, each carrying its own tools, so
      // the panel can disclose servers first and their tools second.
      servers: [...servers.values()]
        .map((row) => ({
          server: row.server,
          count: row.count,
          tokens: row.tokens,
          items: detail(row.tools).slice(0, maxItems),
        }))
        .sort((left, right) => right.tokens - left.tokens || (left.server < right.server ? -1 : 1)),
      items: detail(mcp).slice(0, maxItems),
    },
    system: {
      count: system.length,
      tokens: priceTools(system),
      tokensByTool: system.reduce((sum, tool) => sum + price(tool), 0),
      items: detail(system).slice(0, maxItems),
    },
  };
}

/**
 * Find the durable skill-catalog message and price it the way DSH prices a user
 * message (`priceContent(blocks) + roleOverhead`), so the number is directly
 * comparable with the message bucket it lives in.
 * @param events - session events in ascending seq order.
 * @param options - `{ maxItems, priceContent, roleOverhead }`.
 * @returns the latest catalog, or null when the session has none.
 */
export function skillCatalog(events, options) {
  const { maxItems, priceContent, roleOverhead } = options;
  const list = Array.isArray(events) ? events : [];
  const catalogs = list.filter((event) => event?.type === 'user/message'
    && event?.data?.source?.kind === 'skill-catalog');
  const latest = catalogs[catalogs.length - 1];
  if (latest === undefined) return null;
  const content = Array.isArray(latest.data.content) ? latest.data.content : [];
  const entries = Array.isArray(latest.data.source?.entries) ? latest.data.source.entries : [];
  const text = content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('');
  const price = (entry) => priceContent([{
    type: 'text',
    text: `- \`${String(entry?.name ?? '')}\`: ${String(entry?.description ?? '')}`,
  }]);
  return {
    seq: latest.seq,
    update: latest.data.source?.update === true,
    count: entries.length,
    tokens: priceContent(content) + roleOverhead,
    chars: text.length,
    items: entries
      .map((entry) => ({ name: String(entry?.name ?? ''), tokens: price(entry) }))
      .sort((left, right) => right.tokens - left.tokens || (left.name < right.name ? -1 : 1))
      .slice(0, maxItems),
  };
}

/**
 * Fold one event log into the panel's classification payload: the latest request
 * envelope's tools (MCP vs built-in) plus the durable skill catalog.
 * @param events - session events in ascending seq order.
 * @param sessionId - the session these events belong to.
 * @param options - `{ maxItems, priceTools, priceContent, roleOverhead, now }`.
 * @returns JSON-safe payload for the Browser half.
 */
export function classifySession(events, sessionId, options) {
  const list = Array.isArray(events) ? events : [];
  const lastOf = (type) => {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (list[index]?.type === type) return list[index];
    }
    return undefined;
  };
  const header = lastOf('request/header');
  const context = lastOf('request/context');
  const catalog = skillCatalog(list, options);
  // The `skill` tool's own schema is part of the built-in tools bucket; reporting
  // its price next to the catalog answers "where does the skill tool cost go?".
  const skillTool = (header?.data?.header?.tools ?? []).find((tool) => tool?.name === 'skill');
  return {
    sessionId: String(sessionId),
    generatedAt: typeof options.now === 'number' ? options.now : Date.now(),
    contextWindow: context?.data?.contextWindow,
    headerSeq: header?.seq,
    tools: splitTools(header?.data?.header?.tools, options),
    skills: catalog === null ? null : {
      ...catalog,
      tool: {
        name: 'skill',
        tokens: skillTool === undefined ? 0 : options.priceTools([skillTool]),
      },
    },
  };
}
