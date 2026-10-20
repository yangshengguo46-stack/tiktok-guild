const MESSAGING_CHILDREN = Object.freeze(["list_conversations", "get_messages", "prepare_message", "send_message", "get_operation_status", "reconcile_message"]);

function businessInputSchema(children) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["guild_ref", "child"],
    properties: {
      guild_ref: { type: "string", minLength: 8, maxLength: 128 },
      child: { type: "string", enum: [...children] },
      params: { type: "object", additionalProperties: true, ...(children.includes("prepare_message") ? { properties: { lookup_handle: { type: "string", minLength: 1, maxLength: 128, description: "Only with creator_id: a sourced TikTok username used for native lookup; returned CreatorUID must match creator_id exactly. It is a locator, not a second recipient identity." } } } : {}) },
    },
  };
}

export const TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: "broker_workspace",
    title: "Broker workspace",
    description: "Discover the authenticated broker workspace or inspect its isolated session state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { child: { type: "string", enum: ["get_status"] } },
    },
  }),
  Object.freeze({
    name: "broker_messaging",
    title: "Broker messaging",
    description: "Use an exact conversation, creator UID with sourced lookup_handle, or recipient username through the broker's isolated Backstage profile; native identities are verified before the single message attempt.",
    inputSchema: businessInputSchema(MESSAGING_CHILDREN),
  }),
]);

export const TOOL_NAMES = Object.freeze(TOOL_DEFINITIONS.map(({ name }) => name));
