import {
  ACCOUNT_CHILDREN,
  ADAPTER_METHODS,
  SERVER_INFO,
  TASK_CHILDREN,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  completeness,
  errorEnvelope,
  identityFields,
  resultEnvelope,
  toolResult,
} from './contracts.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const TOOL_NAME_SET = new Set(TOOL_NAMES);
const CHILDREN = Object.freeze({
  public_outreach_accounts: new Set(ACCOUNT_CHILDREN),
  public_outreach_tasks: new Set(TASK_CHILDREN),
});
function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeErrorMessage(error) {
  return error instanceof Error && error.message ? error.message.slice(0, 256) : 'Tool execution failed.';
}

function normalizeArguments(rawArguments) {
  if (rawArguments === undefined) return {};
  if (!isRecord(rawArguments)) throw new TypeError('Tool arguments must be an object.');
  return rawArguments;
}

function extractParams(argumentsValue) {
  const { child, params, __toolName: _toolName, ...inline } = argumentsValue;
  if (params !== undefined && !isRecord(params)) throw new TypeError('Tool params must be an object.');
  return params === undefined ? inline : params;
}

function identityFrom(argumentsValue, result) {
  return identityFields({
    ...argumentsValue,
    ...(isRecord(argumentsValue.params) ? argumentsValue.params : {}),
    ...(isRecord(result) ? result : {}),
  });
}

function dataFor(domain, child, value) {
  if (domain === 'public_outreach_accounts' && child === 'list' && Array.isArray(value)) {
    return { accounts: value };
  }
  return value;
}

function normalizeSuccess({ domain, child, argumentsValue, value }) {
  const returned = isRecord(value) ? value : {};
  const rawData = Object.hasOwn(returned, 'data') ? returned.data : value;
  const status = returned.status === 'partial' ? 'partial' : 'ok';
  const completenessStatus = returned.completeness
    ?? (status === 'partial' ? completeness('partial', [child]) : completeness());
  return toolResult(resultEnvelope({
    status,
    domain,
    child,
    data: dataFor(domain, child, rawData),
    identity: identityFrom(argumentsValue, {
      ...returned,
      ...(isRecord(rawData) ? rawData : {}),
    }),
    completenessStatus,
    evidence: Array.isArray(returned.evidence) ? returned.evidence : [],
  }));
}

function normalizeFailure({ domain, child, argumentsValue, error, code = 'operator_call_failed' }) {
  return toolResult({
    ...errorEnvelope({
      domain,
      child,
      code,
      message: safeErrorMessage(error),
      identity: identityFrom(argumentsValue, {}),
    }),
  });
}

function validateCall(argumentsValue) {
  if (!isRecord(argumentsValue)) throw new TypeError('Tool arguments must be an object.');
  if (typeof argumentsValue.child !== 'string' || !argumentsValue.child) {
    throw new TypeError('Tool arguments require a child.');
  }
  const children = CHILDREN[argumentsValue.__toolName];
  if (!children?.has(argumentsValue.child)) {
    throw new TypeError(`Unknown child "${argumentsValue.child}".`);
  }
  return extractParams(argumentsValue);
}

export function createPublicOutreachRouter({
  adapter = null,
  configured = Boolean(adapter),
  configurationError = null,
} = {}) {
  const isConfigured = configured === true && isRecord(adapter);

  return async function route(message) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcError(message?.id, -32600, 'Invalid JSON-RPC request.');
    }
    const notification = message.id === undefined || message.id === null;
    if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return null;
    if (message.method === 'initialize') {
      if (notification) return null;
      return rpcResult(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'Use the native DeerFlow outreach repository adapter. This operator exposes execution contracts only and remains unconfigured until an explicit adapter is supplied.',
      });
    }
    if (message.method === 'ping') return notification ? null : rpcResult(message.id, {});
    if (message.method === 'tools/list') return notification ? null : rpcResult(message.id, { tools: TOOL_DEFINITIONS });
    if (message.method !== 'tools/call') {
      return notification ? null : rpcError(message.id, -32601, `Method "${message.method}" is not supported.`);
    }
    if (notification) return null;

    const name = message.params?.name;
    if (!TOOL_NAME_SET.has(name)) return rpcError(message.id, -32602, `Unknown tool "${String(name)}".`);
    const rawArguments = Object.hasOwn(message.params ?? {}, 'arguments') ? message.params.arguments : {};
    let argumentsValue;
    try {
      argumentsValue = normalizeArguments(rawArguments);
      argumentsValue.__toolName = name;
      validateCall(argumentsValue);
    } catch (error) {
      return rpcError(message.id, -32602, safeErrorMessage(error));
    }

    const child = argumentsValue.child;
    const params = extractParams(argumentsValue);
    if (!isConfigured) {
      return rpcResult(message.id, normalizeFailure({
        domain: name,
        child,
        argumentsValue: params,
        error: configurationError ?? new Error('Public outreach operator is not configured.'),
        code: 'operator_unconfigured',
      }));
    }

    const methodName = ADAPTER_METHODS[name][child];
    if (typeof adapter[methodName] !== 'function') {
      return rpcResult(message.id, normalizeFailure({
        domain: name,
        child,
        argumentsValue: params,
        error: new Error(`Native DeerFlow adapter does not implement ${methodName}.`),
        code: 'adapter_contract_missing',
      }));
    }
    try {
      const value = await adapter[methodName](params);
      return rpcResult(message.id, normalizeSuccess({
        domain: name,
        child,
        argumentsValue: params,
        value,
      }));
    } catch (error) {
      return rpcResult(message.id, normalizeFailure({
        domain: name,
        child,
        argumentsValue: params,
        error,
      }));
    }
  };
}
