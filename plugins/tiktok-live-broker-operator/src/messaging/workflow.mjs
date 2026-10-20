const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_MESSAGE_CODE_POINTS = 2_000;

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field} is required.`);
  return value.trim();
}

function safeId(value, field) {
  const normalized = requiredString(value, field);
  if (!ID_PATTERN.test(normalized)) throw new TypeError(`${field} is invalid.`);
  return normalized;
}

function recipient(params) {
  const candidates = [
    ["conversation_id", params.conversation_id],
    ["creator_id", params.creator_id],
    ["recipient_handle", params.recipient_handle]
  ].filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "");
  if (candidates.length !== 1) throw new TypeError("exactly one recipient identifier is required.");
  const [[field, value]] = candidates;
  const normalized = safeId(value, field);
  return { [field]: normalized };
}

export function prepareMessagePlan({
  guild_ref,
  workflow_id,
  sender_account_ref,
  conversation_id,
  creator_id,
  recipient_handle,
  lookup_handle,
  content,
  idempotency_key
} = {}) {
  const body = requiredString(content, "content");
  if ([...body].length > MAX_MESSAGE_CODE_POINTS) {
    throw new TypeError(`content must contain at most ${MAX_MESSAGE_CODE_POINTS} code points.`);
  }
  const target = recipient({ conversation_id, creator_id, recipient_handle });
  if (lookup_handle !== undefined && !target.creator_id) throw new TypeError("lookup_handle is only valid with creator_id.");
  const lookup = lookup_handle === undefined ? {} : { lookup_handle: safeId(lookup_handle, "lookup_handle") };
  return {
    kind: "guild_message",
    status: "ready_for_agent",
    guild_ref: safeId(guild_ref, "guild_ref"),
    workflow_id: safeId(workflow_id, "workflow_id"),
    sender_account_ref: safeId(sender_account_ref, "sender_account_ref"),
    ...target,
    ...lookup,
    content: body,
    idempotency_key: safeId(idempotency_key, "idempotency_key"),
    required_approvals: [],
    capability: "write_verified"
  };
}
