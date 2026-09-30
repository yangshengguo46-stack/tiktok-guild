const COMMON_PROPERTIES = Object.freeze({
  owner_user_id: { type: 'string', minLength: 1, maxLength: 128 },
  task_id: { type: ['string', 'null'], maxLength: 128 },
  sender_account_id: { type: ['string', 'null'], maxLength: 128 },
  channel: { type: ['string', 'null'], enum: ['android', 'web', 'ios', null] },
  creator_uid: { type: ['string', 'null'], maxLength: 128 },
  action: { type: ['string', 'null'], enum: ['like', 'comment', 'follow', 'message', null] },
  idempotency_key: { type: ['string', 'null'], maxLength: 255 },
});

export const ACCOUNT_CHILDREN = Object.freeze(['list', 'register', 'health', 'disable']);
export const TASK_CHILDREN = Object.freeze(['enqueue', 'get', 'claim', 'execute', 'complete', 'fail', 'reconcile']);
export const ADAPTER_METHODS = Object.freeze({
  public_outreach_accounts: Object.freeze({
    list: 'listSenderAccounts',
    register: 'registerSenderAccount',
    health: 'healthSenderAccount',
    disable: 'disableSenderAccount',
  }),
  public_outreach_tasks: Object.freeze({
    enqueue: 'enqueueAction',
    get: 'getAction',
    claim: 'claimAction',
    execute: 'executeAction',
    complete: 'completeAction',
    fail: 'failAction',
    reconcile: 'reconcileActions',
  }),
});
export const REQUIRED_RESULT_FIELDS = Object.freeze([
  'task_id',
  'sender_account_id',
  'channel',
  'creator_uid',
  'action',
  'idempotency_key',
  'completeness',
]);

function childSchema(children) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['child'],
    properties: {
      child: { type: 'string', enum: [...children] },
      params: { type: 'object', additionalProperties: true },
    },
  };
}

export const TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'public_outreach_accounts',
    title: 'Public outreach accounts',
    description: 'Read and manage sender account readiness through the native DeerFlow outreach repository.',
    inputSchema: childSchema(ACCOUNT_CHILDREN),
  }),
  Object.freeze({
    name: 'public_outreach_tasks',
    title: 'Public outreach tasks',
    description: 'Create and reconcile native ordered tasks. Only the explicit execute child performs external TikTok writes, within the deployment single-account pilot gate; claim cannot perform provider writes.',
    inputSchema: childSchema(TASK_CHILDREN),
  }),
]);

export const TOOL_NAMES = Object.freeze(TOOL_DEFINITIONS.map(({ name }) => name));
export const SERVER_INFO = Object.freeze({
  name: 'public-outreach-operator',
  version: '0.1.0',
});

export function identityFields(source = {}) {
  return Object.freeze({
    task_id: source.task_id ?? null,
    sender_account_id: source.sender_account_id ?? null,
    channel: source.channel ?? null,
    creator_uid: source.creator_uid ?? null,
    action: source.action ?? null,
    idempotency_key: source.idempotency_key ?? null,
  });
}

export function completeness(state = 'complete', missing = []) {
  if (!['complete', 'partial', 'unavailable', 'unknown'].includes(state)) {
    throw new TypeError(`Unknown completeness state: ${state}`);
  }
  return Object.freeze({ state, missing: Object.freeze([...missing]) });
}

export function resultEnvelope({
  status = 'ok',
  domain,
  child,
  data = null,
  identity = {},
  completenessStatus = completeness(),
  evidence = [],
  errors = [],
}) {
  if (!['ok', 'partial', 'error'].includes(status)) throw new TypeError(`Unknown result status: ${status}`);
  return Object.freeze({
    status,
    domain,
    child,
    ...identityFields(identity),
    data,
    evidence: Object.freeze([...evidence]),
    completeness: completenessStatus,
    errors: Object.freeze([...errors]),
  });
}

export function errorEnvelope({
  domain,
  child,
  code,
  message,
  identity = {},
  completenessStatus = completeness('unavailable', [child]),
}) {
  return resultEnvelope({
    status: 'error',
    domain,
    child,
    identity,
    completenessStatus,
    errors: [{ code, message }],
  });
}

export function toolResult(envelope) {
  const message = envelope.status === 'error'
    ? `${envelope.domain}.${envelope.child} failed: ${envelope.errors[0]?.message ?? 'unknown error'}`
    : `${envelope.domain}.${envelope.child}: ${envelope.status}`;
  return {
    ...(envelope.status === 'error' ? { isError: true } : {}),
    content: [{ type: 'text', text: message }],
    structuredContent: envelope,
  };
}

export const RESULT_COMMON_PROPERTIES = Object.freeze({
  ...COMMON_PROPERTIES,
  completeness: {
    type: 'object',
    additionalProperties: false,
    required: ['state', 'missing'],
    properties: {
      state: { type: 'string', enum: ['complete', 'partial', 'unavailable', 'unknown'] },
      missing: { type: 'array', items: { type: 'string' } },
    },
  },
});
