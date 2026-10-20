import { createHash, randomBytes } from "node:crypto";

import { DOMAIN_CATALOG } from "./catalog.mjs";
import { GuildError } from "./errors.mjs";
import { authorizeOperation } from "./operation-policy.mjs";
import {
  assertAffiliateAccountMatchesPlan,
  parseAffiliateInventory,
  verifyAffiliateAssignment
} from "./onboarding/affiliate-evidence.mjs";
import {
  prepareAllocationPlan,
  prepareAssignmentPlan,
  prepareAffiliateAccountPlan,
  prepareAffiliateAssignmentPlan,
  prepareBrokerProfilePlan
} from "./onboarding/workflow.mjs";
import {
  allocateInvitationCards,
  assignAffiliateAccount,
  assignStaff,
  grantMessagingPermission
} from "./onboarding/live-write.mjs";
import { sendCreatorMessage, reconcileCreatorMessage, MESSAGE_WRITE_EVIDENCE } from "./messaging/live-write.mjs";
import { createMutex, createOperationStore } from "./messaging/operation-store.mjs";
import { createWorkflowCache } from "./messaging/workflow-cache.mjs";
import { prepareMessagePlan } from "./messaging/workflow.mjs";
import { errorEnvelope, successEnvelope, toolResult } from "./result.mjs";
import { discoverGuild, WORKSPACE_EVIDENCE } from "./workspace/discover.mjs";

async function activePage(context) {
  const pages = typeof context.pages === "function" ? context.pages() : [];
  return pages.at(-1) ?? await context.newPage();
}

export function createHandlers({
  sessionOwner,
  liveReader,
  sendMessage = sendCreatorMessage,
  operationStore,
  senderAccountRef = null,
  senderIdentityText = null,
  maxWorkflows = 256,
  workflowTtlMs = 30 * 60_000,
  guildDiscovery = discoverGuild,
  clock = () => new Date().toISOString(),
  refSalt = randomBytes(32)
}) {
  if (!sessionOwner || typeof sessionOwner.ensureActive !== "function" || typeof sessionOwner.getStatus !== "function") {
    throw new TypeError("A session owner is required.");
  }
  if (typeof liveReader !== "function" || typeof guildDiscovery !== "function" || typeof clock !== "function") {
    throw new TypeError("Live reader, discovery, and clock must be functions.");
  }

  const bindings = new Map();
  const workflows = new Map();
  const workflowCache = createWorkflowCache({ workflows, maxWorkflows, workflowTtlMs });
  const messageStore = operationStore ?? sessionOwner.operationStore ?? createOperationStore({ profileDir: sessionOwner.profileDir });
  const exclusive = sessionOwner.withExclusive ?? createMutex();
  let messagingPage = null, messagingContext = null;
  const getMessagingPage = async context => {
    if (messagingContext !== context || messagingPage?.isClosed?.()) { messagingPage = null; messagingContext = context; }
    if (!messagingPage) messagingPage = await context.newPage();
    return messagingPage;
  };
  const consumedOperations = new Set();
  const consumeOperation = (domain, child, idempotencyKey) => {
    const key = `${domain}:${child}:${idempotencyKey}`;
    if (consumedOperations.has(key)) {
      throw new GuildError("duplicate_write", `Operation ${domain}.${child} was already consumed.`);
    }
    consumedOperations.add(key);
  };
  const guildRef = (guildId) => `guild_${createHash("sha256").update(refSalt).update("\0").update(guildId).digest("hex").slice(0, 24)}`;

  const workspace = async (args = {}) => {
    const child = args?.child ?? null;
    if (child === "get_status") {
      return toolResult(successEnvelope({
        domain: "guild_workspace",
        child,
        data: sessionOwner.getStatus(),
        evidence: [],
        completeness: { state: "complete", missing: [] },
        pagination: null
      }));
    }
    if (child !== null || !args || typeof args !== "object" || Array.isArray(args)) {
      return toolResult(errorEnvelope({
        domain: "guild_workspace",
        child,
        error: new GuildError("capability_unavailable", "Unknown workspace operation.")
      }));
    }

    let page;
    try {
      const context = await sessionOwner.ensureActive();
      page = await activePage(context);
      const identity = await guildDiscovery({ page, clock });
      await sessionOwner.minimize?.(page);
      const ref = guildRef(identity.guild_id);
      bindings.set(ref, { identity });
      const observedAt = clock();
      return toolResult(successEnvelope({
        domain: "guild_workspace",
        child: null,
        data: { guild_ref: ref, ...identity },
        evidence: [{ ...WORKSPACE_EVIDENCE, observed_at: observedAt }],
        completeness: { state: "complete", missing: [] },
        pagination: null
      }));
    } catch (error) {
      if (error instanceof GuildError && error.code === "login_required") {
        await sessionOwner.reveal?.(page);
      }
      return toolResult(errorEnvelope({ domain: "guild_workspace", child: null, error }));
    }
  };

  const onboarding = async (args = {}) => {
    const child = args?.child ?? null;
    try {
      const binding = bindings.get(args.guild_ref);
      if (!binding) throw new GuildError("guild_binding_not_found", "The guild reference is not active in this process.");
      const params = args.params;
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        throw new GuildError("capability_unavailable", "Onboarding parameters are required.");
      }
      authorizeOperation({ domain: "guild_onboarding", child, approval: params.approval });
      if (child === "prepare_affiliate_workflow") {
        const creation = prepareAffiliateAccountPlan({
          guild: { ...binding.identity, guild_ref: args.guild_ref },
          username: params.username,
          nickname: params.nickname,
          persona_ref: params.persona_ref,
          country: params.country,
          idempotency_key: params.creation_idempotency_key
        });
        if (params.broker_name !== undefined && params.broker_name !== creation.nickname) {
          throw new GuildError("authorization_required", "The broker profile name must match the approved affiliate identity.");
        }
        const profile = prepareBrokerProfilePlan({
          guild_ref: args.guild_ref,
          broker_email: params.broker_email,
          affiliate_username: creation.username,
          broker_name: creation.nickname,
          persona_ref: creation.persona_ref,
          contact_email: params.contact_email,
          idempotency_key: params.profile_idempotency_key
        });
        workflowCache.set(params.workflow_id, { binding, creation, profile });
        return toolResult(successEnvelope({
          domain: "guild_onboarding",
          child,
          data: {
            workflow_id: params.workflow_id,
            creation,
            profile,
            public_identity: {
              display_name: creation.nickname,
              tiktok_username: creation.username,
              tiktok_homepage_candidate: creation.tiktok_homepage_candidate,
              base_persona_ref: creation.persona_ref,
              account_type: "affiliate_digital_broker",
              content_status: "not_created"
            },
            assignment_status: "awaiting_created_account_id",
            credential_delivery: "broker_backstage_registration_email",
            required_approvals: [],
            status: "ready_for_agent"
          },
          evidence: [],
          completeness: { state: "complete", missing: [] },
          pagination: null
        }));
      }
      if (child === "prepare_access_workflow") {
      const assignment = prepareAssignmentPlan({
        guild_ref: args.guild_ref,
        assignments: params.assignments,
        idempotency_key: params.assignment_idempotency_key
      });
      const allocation = params.allocations === undefined
        ? null
        : prepareAllocationPlan({
          guild_ref: args.guild_ref,
          allocations: params.allocations,
          idempotency_key: params.allocation_idempotency_key
        });
      const workflowId = params.workflow_id;
      workflowCache.set(workflowId, { binding, assignment, allocation });
      return toolResult(successEnvelope({
        domain: "guild_onboarding",
        child,
        data: {
          workflow_id: workflowId,
          assignment,
          allocation,
          required_approvals: [],
          status: "ready_for_agent"
        },
        evidence: [],
        completeness: { state: "complete", missing: [] },
        pagination: null
      }));
      }

      const context = await sessionOwner.ensureActive();
      if (child === "grant_messaging_permission") {
        if (typeof params.idempotency_key !== "string" || params.idempotency_key.trim() === "") {
          throw new GuildError("capability_unavailable", "An idempotency_key is required for messaging-permission writes.");
        }
        consumeOperation("guild_onboarding", child, params.idempotency_key);
        const page = await context.newPage();
        try {
          const result = await grantMessagingPermission({
            page,
            targetAgentId: params.target_agent_id,
            targetEmail: params.target_email
          });
          return toolResult(successEnvelope({
            domain: "guild_onboarding",
            child,
            data: { ...result, operation: "grant_messaging_permission" },
            evidence: [{ route: "/portal/anchor/scout-creators?tab=accounts", endpoint_path: "/creators/live/union_platform_api/agency/host_recruitment/change_recruitment_permission/", observed_at: clock() }],
            completeness: { state: "complete", missing: [] },
            pagination: null
          }));
        } finally { try { await page.close?.(); } catch {} }
      }

      const workflow = workflowCache.get(params.workflow_id);
      if (!workflow) throw new GuildError("guild_binding_not_found", "The onboarding workflow is not active in this process.");
      if (workflow.binding.identity.guild_id !== binding.identity.guild_id) {
        throw new GuildError("authorization_required", "The approval is bound to a different guild.");
      }
      if (child === "prepare_affiliate_assignment") {
        if (!workflow.creation || !workflow.profile) {
          throw new GuildError("capability_unavailable", "This workflow does not contain an affiliate account plan.");
        }
        if (String(params.broker_email ?? "").trim().toLowerCase() !== workflow.profile.broker_email) {
          throw new GuildError("authorization_required", "The assignment broker differs from the planned profile owner.");
        }
        const page = await context.newPage();
        let inventoryRead;
        try {
          inventoryRead = await liveReader({
            page,
            domain: "guild_recruitment",
            child: "list_affiliate_accounts",
            params: {},
            identity: binding.identity,
            clock
          });
        } finally { try { await page.close?.(); } catch {} }
        assertAffiliateAccountMatchesPlan(
          parseAffiliateInventory(inventoryRead),
          workflow.creation,
          String(params.affiliate_account_id ?? "")
        );
        const assignment = prepareAffiliateAssignmentPlan({
          guild_ref: args.guild_ref,
          affiliate_account_id: params.affiliate_account_id,
          broker_email: params.broker_email,
          idempotency_key: params.assignment_idempotency_key
        });
        workflow.affiliate_assignment = assignment;
        return toolResult(successEnvelope({
          domain: "guild_onboarding",
          child,
          data: { workflow_id: params.workflow_id, assignment, required_approvals: [], status: "ready_for_agent" },
          evidence: inventoryRead.evidence ?? [],
          completeness: { state: "complete", missing: [] },
          pagination: null
        }));
      }
      if (child === "assign_affiliate_account") {
        const plan = workflow.affiliate_assignment;
        if (!plan) throw new GuildError("capability_unavailable", "No affiliate-account assignment exists in the approved workflow.");
        if (String(params.affiliate_account_id ?? "") !== plan.affiliate_account_id
          || String(params.broker_email ?? "").trim().toLowerCase() !== plan.broker_email) {
          throw new GuildError("authorization_required", "The affiliate-account write does not match the approved assignment.");
        }
        consumeOperation("guild_onboarding", child, plan.idempotency_key);
        const page = await context.newPage();
        try {
          const result = await assignAffiliateAccount({
            page,
            affiliateAccountId: plan.affiliate_account_id,
            brokerEmail: plan.broker_email
          });
          const readPage = await context.newPage();
          let inventoryRead;
          try {
            inventoryRead = await liveReader({
              page: readPage,
              domain: "guild_recruitment",
              child: "list_affiliate_accounts",
              params: {},
              identity: binding.identity,
              clock
            });
          } finally { try { await readPage.close?.(); } catch {} }
          const account = verifyAffiliateAssignment(
            parseAffiliateInventory(inventoryRead),
            plan.affiliate_account_id,
            plan.broker_email
          );
          return toolResult(successEnvelope({
            domain: "guild_onboarding",
            child,
            data: {
              workflow_id: params.workflow_id,
              ...result,
              status: "verified",
              read_back: account
            },
            evidence: [
              { route: "/portal/anchor/scout-creators?tab=accounts", endpoint_path: "/creators/live/union_platform_api/agency/host_recruitment/tt_biz_account/employee/assign/", observed_at: clock() },
              ...(inventoryRead.evidence ?? [])
            ],
            completeness: { state: "complete", missing: [] },
            pagination: null
          }));
        } finally { try { await page.close?.(); } catch {} }
      }
      if (child === "assign_staff") {
        const plan = workflow.assignment;
        if (!plan) throw new GuildError("capability_unavailable", "This workflow does not contain a staff invitation plan.");
        const requested = plan.assignments;
        const group = params.group ?? requested[0]?.group;
        const emails = params.emails ?? requested.filter((entry) => entry.group === group).map((entry) => entry.email);
        const approvedEmails = new Set(requested.filter((entry) => entry.group === group).map((entry) => entry.email));
        if (!group || emails.some((email) => !approvedEmails.has(email))
          || requested.some((entry) => entry.group === group && !emails.includes(entry.email))) {
          throw new GuildError("authorization_required", "The assignment request does not match the approved plan.");
        }
        consumeOperation("guild_onboarding", child, plan.idempotency_key);
        const page = await context.newPage();
        try {
          const result = await assignStaff({ page, group, emails });
          return toolResult(successEnvelope({
            domain: "guild_onboarding",
            child,
            data: { workflow_id: params.workflow_id, ...result },
            evidence: [{ route: "/portal/administration/staff", endpoint_path: "/creators/live/union_platform_api/agency/group_management/invite/", observed_at: clock() }],
            completeness: { state: "complete", missing: [] },
            pagination: null
          }));
        } finally { try { await page.close?.(); } catch {} }
      }
      if (child === "allocate_invitation_cards") {
        const plan = workflow.allocation;
        if (!plan) throw new GuildError("capability_unavailable", "No invitation-card allocation exists in the approved workflow.");
        const requested = plan.allocations.find((entry) => entry.target === (params.target_email ?? params.target_id));
        if (!requested) throw new GuildError("authorization_required", "The allocation target does not match the approved plan.");
        consumeOperation("guild_onboarding", child, plan.idempotency_key);
        const contextPage = await context.newPage();
        try {
          const result = await allocateInvitationCards({
            page: contextPage,
            agencyId: binding.identity.guild_id,
            userId: params.user_id,
            targetId: params.target_id,
            targetEmail: params.target_email,
            regular: requested.regular,
            premium: requested.premium
          });
          return toolResult(successEnvelope({
            domain: "guild_onboarding",
            child,
            data: { workflow_id: params.workflow_id, ...result },
            evidence: [{ route: "/portal/anchor/invitation-management", endpoint_path: "/creators/live/union_platform_api/agency/quota/transfer_quota/", observed_at: clock() }],
            completeness: { state: "partial", missing: ["invitation_quota_read_back"] },
            pagination: null
          }));
        } finally { try { await contextPage.close?.(); } catch {} }
      }
      throw new GuildError("capability_unavailable", "Unknown guild onboarding operation.");
    } catch (error) {
      return toolResult(errorEnvelope({ domain: "guild_onboarding", child, error }));
    }
  };

  const messaging = async (args = {}) => {
    const child = args?.child ?? null;
    try {
      if (!DOMAIN_CATALOG.find(({ name }) => name === "guild_messaging").children.includes(child)) {
        throw new GuildError("capability_unavailable", "Unknown guild messaging operation.");
      }
      const statusParams = args.params;
      if (child === "get_operation_status" || child === "reconcile_message") {
        const operation = messageStore.get(statusParams?.idempotency_key);
        const statusBinding = bindings.get(args.guild_ref);
        if (!operation || (statusBinding && operation.guild_id !== statusBinding.identity.guild_id)
          || (senderAccountRef && operation.sender_account_ref !== senderAccountRef)) {
          throw new GuildError("operation_not_found", "No operation belongs to this owned profile and sender.");
        }
        const data = child === "reconcile_message" ? await reconcileCreatorMessage({ page: messagingPage, operation }) : operation;
        return toolResult(successEnvelope({ domain: "guild_messaging", child, data, evidence: [], completeness: { state: "complete", missing: [] }, pagination: null }));
      }
      const binding = bindings.get(args.guild_ref);
      if (!binding) throw new GuildError("guild_binding_not_found", "The guild reference is not active in this process.");
      const params = args.params;
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        throw new GuildError("capability_unavailable", "Messaging parameters are required.");
      }
      authorizeOperation({ domain: "guild_messaging", child, approval: params.approval });
      if (child === "prepare_message") {
        if (senderAccountRef && params.sender_account_ref !== senderAccountRef) throw new GuildError("authorization_required", "The sender differs from the configured profile identity.");
        const plan = prepareMessagePlan({ guild_ref: args.guild_ref, ...params });
        workflowCache.set(plan.workflow_id, { binding, message: plan });
        return toolResult(successEnvelope({
          domain: "guild_messaging",
          child,
          data: { workflow_id: plan.workflow_id, plan, required_approvals: [], status: "ready_for_agent" },
          evidence: [],
          completeness: { state: "complete", missing: [] },
          pagination: null
        }));
      }
      if (child === "send_message") {
        const workflow = workflowCache.get(params.workflow_id);
        if (!workflow?.message) throw new GuildError("guild_binding_not_found", "The message workflow is not active in this process.");
        if (workflow.binding.identity.guild_id !== binding.identity.guild_id) {
          throw new GuildError("authorization_required", "The approval is bound to a different guild.");
        }
        const plan = workflow.message;
        for (const field of ["sender_account_ref", "conversation_id", "creator_id", "recipient_handle", "lookup_handle", "content"]) {
          if (params[field] !== undefined && params[field] !== plan[field]) {
            throw new GuildError("authorization_required", `The message ${field} does not match the approved plan.`);
          }
        }
        if (senderAccountRef && plan.sender_account_ref !== senderAccountRef) throw new GuildError("authorization_required", "The sender differs from the configured profile identity.");
        try {
          const result = await messageStore.execute({ ...plan, guild_id: binding.identity.guild_id }, async writeGuard => {
            const context = await sessionOwner.ensureActive();
            const page = await getMessagingPage(context);
            try {
              return await sendMessage({ page, senderAccountRef: plan.sender_account_ref, conversationId: plan.conversation_id,
                creatorId: plan.creator_id, recipientHandle: plan.recipient_handle, lookupHandle: plan.lookup_handle, content: plan.content,
                idempotencyKey: plan.idempotency_key, expectedIdentityText: senderIdentityText, writeGuard });
            } catch (error) {
              if (error instanceof GuildError && error.code === "login_required") await sessionOwner.reveal?.(page);
              throw error;
            }
          });
          return toolResult(successEnvelope({ domain: "guild_messaging", child,
            status: result.status === "verified" ? "ok" : "partial", data: { workflow_id: plan.workflow_id, ...result },
            evidence: [{ ...MESSAGE_WRITE_EVIDENCE, observed_at: clock() }],
            completeness: result.status === "verified" ? { state: "complete", missing: [] } : { state: "partial", missing: ["verified_message_receipt"] }, pagination: null }));
        } finally { workflowCache.delete(plan.workflow_id); }
      }

      const context = await sessionOwner.ensureActive();
      if (typeof context.newPage !== "function") {
        throw new GuildError("session_owner_unverified", "The owned Backstage context cannot create an isolated page.");
      }
      const page = await context.newPage();
      let preserveForIntervention = false;
      try {
        const read = await liveReader({
          page,
          domain: "guild_messaging",
          child,
          params,
          identity: binding.identity,
          clock
        });
        await sessionOwner.minimize?.(page);
        return toolResult(successEnvelope({ domain: "guild_messaging", child, ...read }));
      } catch (error) {
        if (error instanceof GuildError && error.code === "login_required") {
          preserveForIntervention = true;
          await sessionOwner.reveal?.(page);
        }
        throw error;
      } finally {
        if (!preserveForIntervention) {
          try { await page.close?.(); } catch { /* a mode switch already closed the old page */ }
        }
      }
    } catch (error) {
      return toolResult(errorEnvelope({ domain: "guild_messaging", child, error }));
    }
  };

  const handlers = { guild_workspace: workspace, guild_onboarding: onboarding, guild_messaging: messaging };
  for (const domain of DOMAIN_CATALOG.filter(({ name }) => !["guild_workspace", "guild_onboarding", "guild_messaging"].includes(name))) {
    handlers[domain.name] = async (args = {}) => {
      const child = args?.child ?? null;
      try {
        if (!domain.children.includes(child)) {
          throw new GuildError("capability_unavailable", `Unknown ${domain.name} operation.`);
        }
        const binding = bindings.get(args.guild_ref);
        if (!binding) throw new GuildError("guild_binding_not_found", "The guild reference is not active in this process.");
        const context = await sessionOwner.ensureActive();
        if (typeof context.newPage !== "function") {
          throw new GuildError("session_owner_unverified", "The owned Backstage context cannot create an isolated page.");
        }
        const page = await context.newPage();
        let preserveForIntervention = false;
        try {
          const read = await liveReader({
            page,
            domain: domain.name,
            child,
            params: args.params ?? {},
            identity: binding.identity,
            clock
          });
          await sessionOwner.minimize?.(page);
          return toolResult(successEnvelope({ domain: domain.name, child, ...read }));
        } catch (error) {
          if (error instanceof GuildError && error.code === "login_required") {
            preserveForIntervention = true;
            await sessionOwner.reveal?.(page);
          }
          throw error;
        } finally {
          if (!preserveForIntervention) {
            try { await page.close?.(); } catch { /* a mode switch already closed the old page */ }
          }
        }
      } catch (error) {
        return toolResult(errorEnvelope({ domain: domain.name, child, error }));
      }
    };
  }
  for (const [name, handler] of Object.entries(handlers)) {
    handlers[name] = args => name === "guild_workspace" && args?.child === "get_status" ? handler(args) : exclusive(() => handler(args));
  }
  return Object.freeze(handlers);
}
