import { probeMcpServer } from './process.mjs';
import { PUBLIC_OUTREACH_TOOL_NAMES } from './constants.mjs';

export const PUBLIC_OUTREACH_CHILDREN = Object.freeze({
  public_outreach_accounts: Object.freeze(['list', 'register', 'health', 'disable']),
  public_outreach_tasks: Object.freeze(['enqueue', 'get', 'claim', 'complete', 'fail', 'reconcile']),
});

export async function inspectGatewayMcpConfig({ gatewayUrl, expectedServers, timeoutMs = 5000 }) {
  let response;
  let actual;
  try {
    response = await fetch(new URL('/api/mcp/config', gatewayUrl), {
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 1024 * 1024) throw new Error('response exceeds 1 MiB');
      chunks.push(chunk);
    }
    try { actual = JSON.parse(Buffer.concat(chunks).toString('utf8')).mcp_servers; }
    catch { throw new Error('invalid JSON response'); }
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) throw new Error('invalid server catalog');
  } catch (error) {
    throw new Error(`Gateway MCP configuration unavailable: ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`);
  }
  const missing = Object.keys(expectedServers).filter((name) => !Object.hasOwn(actual, name));
  const extra = Object.keys(actual).filter((name) => !Object.hasOwn(expectedServers, name));
  if (missing.length || extra.length) {
    throw new Error(`Gateway MCP configuration drift: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`);
  }
  for (const [name, expected] of Object.entries(expectedServers)) {
    for (const field of ['enabled', 'required', 'command', 'cwd', 'tool_name_prefix']) {
      if (actual[name][field] !== expected[field]) throw new Error(`Gateway MCP configuration drift: ${name}.${field}`);
    }
    if ((actual[name].type ?? actual[name].transport) !== (expected.type ?? expected.transport)) {
      throw new Error(`Gateway MCP configuration drift: ${name}.type`);
    }
    for (const field of ['args', 'enabled_tools']) {
      if (JSON.stringify(actual[name][field] ?? []) !== JSON.stringify(expected[field] ?? [])) {
        throw new Error(`Gateway MCP configuration drift: ${name}.${field}`);
      }
    }
    if (JSON.stringify(Object.keys(actual[name].env ?? {}).sort()) !== JSON.stringify(Object.keys(expected.env ?? {}).sort())) {
      throw new Error(`Gateway MCP configuration drift: ${name}.env keys`);
    }
  }
  return { detail: `${Object.keys(actual).length} configured direct MCPs match the approved startup config; masked/inherited environment values and loaded Gateway catalog unverified` };
}

export async function inspectDirectMcpCatalog({ serverName, server, environment, timeoutMs = 10000 }) {
  const env = { ...environment };
  for (const [name, value] of Object.entries(server.env ?? {})) {
    env[name] = String(value).replace(/\$\{([A-Za-z_][A-Za-z_0-9]*)\}|\$([A-Za-z_][A-Za-z_0-9]*)/gu, (_match, braces, bare) => {
      const key = braces ?? bare;
      if (environment[key] === undefined) throw new Error(`${serverName} environment variable ${key} is unavailable`);
      return environment[key];
    });
  }
  const result = await probeMcpServer({ command: server.command, args: server.args ?? [], cwd: server.cwd, env, timeoutMs });
  const names = [];
  for (const tool of result.tools) {
    if (typeof tool?.name !== 'string' || !tool.name || !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) {
      throw new Error(`${serverName} tools/list returned an invalid tool`);
    }
    names.push(tool.name);
  }
  if (new Set(names).size !== names.length) throw new Error(`${serverName} tools/list has duplicate raw tool names`);
  const missing = server.enabled_tools.filter((name) => !names.includes(name));
  if (missing.length) throw new Error(`${serverName} direct catalog drift: missing approved tools [${missing.join(', ')}]`);
  return {
    toolCount: names.length,
    approvedToolCount: server.enabled_tools.length,
    detail: `${server.enabled_tools.length} approved tools discovered from ${serverName} (${names.length} raw tools); separate probe process, Gateway loading unverified`,
  };
}

export async function inspectPublicOutreachCatalog({ server, environment, timeoutMs = 10000 }) {
  const result = await inspectDirectMcpCatalog({
    serverName: 'public_outreach_operator',
    server,
    environment,
    timeoutMs,
  });
  const approved = [...(server.enabled_tools ?? [])];
  if (JSON.stringify(approved) !== JSON.stringify(PUBLIC_OUTREACH_TOOL_NAMES)) {
    throw new Error(`public_outreach_operator allowlist must match the two approved tool families`);
  }
  return {
    ...result,
    toolCount: result.toolCount,
    approvedToolCount: approved.length,
    detail: `${result.detail}; public outreach operator catalog is read-only until a native DeerFlow adapter is configured`,
  };
}
