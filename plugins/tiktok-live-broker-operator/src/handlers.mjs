import { createHash, randomBytes } from "node:crypto";

import { GuildError } from "./errors.mjs";
import { sendCreatorMessage, reconcileCreatorMessage, MESSAGE_WRITE_EVIDENCE } from "./messaging/live-write.mjs";
import { createMutex, createOperationStore } from "./messaging/operation-store.mjs";
import { createWorkflowCache } from "./messaging/workflow-cache.mjs";
import { prepareMessagePlan } from "./messaging/workflow.mjs";
import { errorEnvelope, successEnvelope, toolResult } from "./result.mjs";
import { discoverGuild, WORKSPACE_EVIDENCE } from "./workspace/discover.mjs";

const MESSAGING_CHILDREN = new Set(["list_conversations", "get_messages", "prepare_message", "send_message", "get_operation_status", "reconcile_message"]);

async function activePage(context) {
  const pages = typeof context.pages === "function" ? context.pages() : [];
  return pages.at(-1) ?? await context.newPage();
}

export function createBrokerHandlers({
  composition,
  sendMessage = sendCreatorMessage,
  operationStore,
  maxWorkflows = 256,
  workflowTtlMs = 30 * 60_000,
  guildDiscovery = discoverGuild,
  clock = () => new Date().toISOString(),
  refSalt = randomBytes(32),
} = {}) {
  const sessionOwner = composition?.sessionOwner;
  const brokerAccountRef = composition?.brokerAccountRef;
  const brokerIdentityText = composition?.brokerIdentityText;
  const liveReader = composition?.liveReader;
  if (!sessionOwner || typeof sessionOwner.ensureActive !== "function" || typeof sessionOwner.getStatus !== "function") {
    throw new TypeError("A broker session owner is required.");
  }
  if (typeof brokerAccountRef !== "string" || brokerAccountRef.trim() === "") {
    throw new TypeError("A broker account reference is required.");
  }
  if (typeof brokerIdentityText !== "string" || brokerIdentityText.trim() === "") {
    throw new TypeError("A broker identity marker is required.");
  }
  if (typeof sendMessage !== "function" || typeof guildDiscovery !== "function"
    || typeof clock !== "function" || typeof liveReader !== "function") {
    throw new TypeError("Broker live readers, discovery, clock, and sender are required.");
  }

  const bindings = new Map();
  const workflows = new Map();
  const messageStore = operationStore ?? composition.operationStore ?? sessionOwner.operationStore
    ?? createOperationStore({ profileDir: composition.profileDir ?? sessionOwner.profileDir });
  const exclusive = sessionOwner.withExclusive ?? createMutex();
  const workflowCache = createWorkflowCache({ workflows, maxWorkflows, workflowTtlMs });
  let messagingContext = null;
  let messagingPage = null;
  const getMessagingPage = async (context) => {
    if (messagingContext !== context) { messagingPage = null; messagingContext = context; }
    if (messagingPage && typeof messagingPage.isClosed === "function" && messagingPage.isClosed()) {
      messagingPage = null;
    }
    if (!messagingPage) messagingPage = await context.newPage();
    return messagingPage;
  };
  const brokerRef = (guildId) => `broker_${createHash("sha256").update(refSalt).update("\0").update(guildId).digest("hex").slice(0, 24)}`;

  const workspace = async (args = {}) => {
    const child = args?.child ?? null;
    if (child === "get_status") {
      return toolResult(successEnvelope({
        domain: "broker_workspace",
        child,
        data: sessionOwner.getStatus(),
        evidence: [],
        completeness: { state: "complete", missing: [] },
        pagination: null,
      }));
    }
    if (child !== null || !args || typeof args !== "object" || Array.isArray(args)) {
      return toolResult(errorEnvelope({
        domain: "broker_workspace",
        child,
        error: new GuildError("capability_unavailable", "Unknown broker workspace operation."),
      }));
    }

    let page;
    try {
      const context = await sessionOwner.ensureActive();
      page = await activePage(context);
      const identity = await guildDiscovery({ page, clock });
      await sessionOwner.minimize?.(page);
      const ref = brokerRef(identity.guild_id);
      bindings.set(ref, { identity });
      return toolResult(successEnvelope({
        domain: "broker_workspace",
        child: null,
        data: { guild_ref: ref, ...identity },
        evidence: [{ ...WORKSPACE_EVIDENCE, observed_at: clock() }],
        completeness: { state: "complete", missing: [] },
        pagination: null,
      }));
    } catch (error) {
      if (error instanceof GuildError && error.code === "login_required") await sessionOwner.reveal?.(page);
      return toolResult(errorEnvelope({ domain: "broker_workspace", child: null, error }));
    }
  };

  const messaging = async (args = {}) => {
    const child = args?.child ?? null;
    try {
      if (!MESSAGING_CHILDREN.has(child)) throw new GuildError("capability_unavailable", "Unknown broker messaging operation.");
      const statusParams = args.params;
      if (child === "get_operation_status" || child === "reconcile_message") {
        const operation = messageStore.get(statusParams?.idempotency_key);
        const statusBinding = bindings.get(args.guild_ref);
        if (!operation || (statusBinding && operation.guild_id !== statusBinding.identity.guild_id)
          || (brokerAccountRef && operation.sender_account_ref !== brokerAccountRef)) {
          throw new GuildError("operation_not_found", "No operation belongs to this owned profile and sender.");
        }
        const data = child === "reconcile_message" ? await reconcileCreatorMessage({ page: messagingPage, operation }) : operation;
        return toolResult(successEnvelope({ domain: "broker_messaging", child, data, evidence: [], completeness: { state: "complete", missing: [] }, pagination: null }));
      }
      const binding = bindings.get(args.guild_ref);
      if (!binding) throw new GuildError("guild_binding_not_found", "The broker workspace reference is not active in this process.");
      const params = args.params;
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        throw new GuildError("capability_unavailable", "Broker messaging parameters are required.");
      }
      if (child === "prepare_message") {
        if (params.sender_account_ref !== brokerAccountRef) {
          throw new GuildError("authorization_required", "The sender account must match the configured broker profile.");
        }
        const plan = prepareMessagePlan({ guild_ref: args.guild_ref, ...params });
        plan.kind = "broker_message";
        workflowCache.set(plan.workflow_id, { binding, message: plan });
        return toolResult(successEnvelope({
          domain: "broker_messaging",
          child,
          data: { workflow_id: plan.workflow_id, plan, required_approvals: [], status: "ready_for_agent" },
          evidence: [],
          completeness: { state: "complete", missing: [] },
          pagination: null,
        }));
      }
      if (child === "send_message") {
        const workflow = workflowCache.get(params.workflow_id);
        if (!workflow?.message) throw new GuildError("guild_binding_not_found", "The broker message workflow is not active in this process.");
        if (workflow.binding.identity.guild_id !== binding.identity.guild_id) {
          throw new GuildError("authorization_required", "The broker message is bound to a different guild.");
        }
        const plan = workflow.message;
        for (const field of ["sender_account_ref", "conversation_id", "creator_id", "recipient_handle", "lookup_handle", "content"]) {
          if (params[field] !== undefined && params[field] !== plan[field]) {
            throw new GuildError("authorization_required", `The broker message ${field} does not match the approved plan.`);
          }
        }
        if (plan.sender_account_ref !== brokerAccountRef) {
          throw new GuildError("authorization_required", "The sender account must match the configured broker profile.");
        }
        try {
          const result = await messageStore.execute({ ...plan, guild_id: binding.identity.guild_id }, async (writeGuard) => {
            const context = await sessionOwner.ensureActive();
            const page = await getMessagingPage(context);
            try {
              return await sendMessage({ page, senderAccountRef: plan.sender_account_ref, conversationId: plan.conversation_id,
                creatorId: plan.creator_id, recipientHandle: plan.recipient_handle, lookupHandle: plan.lookup_handle, content: plan.content,
                idempotencyKey: plan.idempotency_key, expectedIdentityText: brokerIdentityText, writeGuard });
            } catch (error) {
              if (error instanceof GuildError && error.code === "login_required") await sessionOwner.reveal?.(page);
              throw error;
            }
          });
          return toolResult(successEnvelope({ domain: "broker_messaging", child,
            status: result.status === "verified" ? "ok" : "partial", data: { workflow_id: plan.workflow_id, ...result },
            evidence: [{ ...MESSAGE_WRITE_EVIDENCE, observed_at: clock() }],
            completeness: result.status === "verified" ? { state: "complete", missing: [] } : { state: "partial", missing: ["verified_message_receipt"] }, pagination: null }));
        } finally { workflowCache.delete(plan.workflow_id); }
      }

      const context = await sessionOwner.ensureActive();
      const page = await context.newPage();
      let preserveForIntervention = false;
      try {
        const read = await liveReader({
          page,
          domain: "guild_messaging",
          child,
          params,
          identity: binding.identity,
          clock,
        });
        await sessionOwner.minimize?.(page);
        return toolResult(successEnvelope({ domain: "broker_messaging", child, ...read }));
      } catch (error) {
        if (error instanceof GuildError && error.code === "login_required") {
          preserveForIntervention = true;
          await sessionOwner.reveal?.(page);
        }
        throw error;
      } finally {
        if (!preserveForIntervention) {
          try { await page.close?.(); } catch { /* preserve live state */ }
        }
      }
    } catch (error) {
      return toolResult(errorEnvelope({ domain: "broker_messaging", child, error }));
    }
  };

  return Object.freeze({ broker_workspace: args => args?.child === "get_status" ? workspace(args) : exclusive(() => workspace(args)), broker_messaging: args => exclusive(() => messaging(args)) });
}
