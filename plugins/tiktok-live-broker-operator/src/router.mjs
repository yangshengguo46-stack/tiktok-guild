import { TOOL_DEFINITIONS, TOOL_NAMES } from "./catalog.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = Object.freeze({ name: "tiktok-live-broker-operator", version: "0.1.0" });
const TOOL_NAME_SET = new Set(TOOL_NAMES);

function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }

export function createBrokerRouter({ handlers }) {
  if (!handlers || typeof handlers !== "object") throw new TypeError("Broker MCP handlers are required.");
  return async function route(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return rpcError(message?.id, -32600, "Invalid JSON-RPC request.");
    }
    const notification = message.id === undefined || message.id === null;
    if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return null;
    if (message.method === "initialize") {
      if (notification) return null;
      return rpcResult(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "Use broker_workspace to bind the isolated broker profile, then use broker_messaging with the exact creator_id copied from TKDesk. The broker sender account is fixed at process startup; a mismatched sender fails closed.",
      });
    }
    if (message.method === "ping") return notification ? null : rpcResult(message.id, {});
    if (message.method === "tools/list") return notification ? null : rpcResult(message.id, { tools: TOOL_DEFINITIONS });
    if (message.method === "tools/call") {
      if (notification) return null;
      const name = message.params?.name;
      if (!TOOL_NAME_SET.has(name) || typeof handlers[name] !== "function") {
        return rpcError(message.id, -32602, `Unknown tool "${String(name)}".`);
      }
      try {
        const args = Object.hasOwn(message.params ?? {}, "arguments") ? message.params.arguments : {};
        return rpcResult(message.id, await handlers[name](args));
      } catch {
        return rpcResult(message.id, { isError: true, content: [{ type: "text", text: "Tool execution failed." }] });
      }
    }
    return notification ? null : rpcError(message.id, -32601, `Method "${message.method}" is not supported.`);
  };
}
