import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

function startServer() {
  const fixture = fileURLToPath(new URL("./fixtures/acceptance-driver.mjs", import.meta.url));
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, NODE_ENV: "test", TIKTOK_GUILD_TEST_DRIVER: fixture },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let output = "";
  let stderr = "";
  let nextId = 1;
  const waiting = new Map();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    output += chunk;
    while (output.includes("\n")) {
      const newline = output.indexOf("\n");
      const line = output.slice(0, newline).trim();
      output = output.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  const call = (name, args) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => reject(new Error(`MCP timeout. stderr=${stderr}`)), 2_000);
    waiting.set(id, (message) => {
      clearTimeout(timeout);
      resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  });
  return { child, call };
}

test("clean MCP composes discovery and isolated live domains", async (t) => {
  const server = startServer();
  t.after(() => server.child.kill("SIGTERM"));

  const passive = await server.call("guild_workspace", { child: "get_status" });
  assert.equal(passive.structuredContent.data.launch_count, 0);

  const login = await server.call("guild_workspace", {});
  assert.equal(login.structuredContent.errors[0].code, "login_required");

  const discovered = await server.call("guild_workspace", {});
  assert.equal(discovered.structuredContent.data.guild_id, "103785");
  assert.equal(discovered.structuredContent.data.portal_region, "MENA");
  const guildRef = discovered.structuredContent.data.guild_ref;

  const creators = await server.call("guild_creators", { guild_ref: guildRef, child: "list_creators" });
  assert.equal(creators.structuredContent.data.creators[0].creator_id, "738001");
  assert.equal(creators.structuredContent.data.creators[0].diamonds, 120034);

  const messagePlan = await server.call("guild_messaging", {
    guild_ref: guildRef,
    child: "prepare_message",
    params: {
      workflow_id: "msg-wf-001",
      sender_account_ref: "affiliate:mira.creator_01",
      recipient_handle: "lla.ap",
      content: "你好",
      idempotency_key: "msg-001"
    }
  });
  assert.equal(messagePlan.structuredContent.status, "ok");
  assert.deepEqual(messagePlan.structuredContent.data.required_approvals, []);
  assert.equal(messagePlan.structuredContent.data.status, "ready_for_agent");

  const governance = await server.call("guild_governance", { guild_ref: guildRef, child: "list_guild_violations" });
  assert.equal(governance.structuredContent.errors[0].code, "adapter_mismatch");

  const revenue = await server.call("guild_revenue", { guild_ref: guildRef, child: "get_overview" });
  assert.equal(revenue.structuredContent.status, "ok");
  assert.equal(revenue.structuredContent.data.overview.diamonds, 880001);

  const onboarding = await server.call("guild_onboarding", {
    guild_ref: guildRef,
    child: "prepare_access_workflow",
    params: {
      workflow_id: "wf-001",
      mailbox: "guild-ops@example.com",
      organization_name: "Atlantis LIVE",
      registration_idempotency_key: "reg-001",
      assignment_idempotency_key: "assign-001",
      assignments: [
        { email: "agent@example.com", group: "自营", role: "组长", permissions: ["即时消息"] }
      ]
    }
  });
  assert.equal(onboarding.structuredContent.status, "ok");
  assert.equal(onboarding.structuredContent.data.registration, undefined);
  assert.equal(onboarding.structuredContent.data.assignment.assignments[0].email, "agent@example.com");
  assert.deepEqual(onboarding.structuredContent.data.required_approvals, []);
  assert.equal(onboarding.structuredContent.data.status, "ready_for_agent");

  const affiliate = await server.call("guild_onboarding", {
    guild_ref: guildRef,
    child: "prepare_affiliate_workflow",
    params: {
      workflow_id: "affiliate-wf-001",
      username: "mira.creator_01",
      nickname: "Mira",
      persona_ref: "relaxed_wit@1.0.1",
      country: "AE",
      broker_email: "mry666888@outlook.com",
      broker_name: "Mira",
      contact_email: "qq651938934@outlook.com",
      creation_idempotency_key: "affiliate-create-001",
      profile_idempotency_key: "affiliate-profile-001"
    }
  });
  assert.equal(affiliate.structuredContent.status, "ok");
  assert.equal(affiliate.structuredContent.data.creation.kind, "affiliate_account_creation");
  assert.equal(affiliate.structuredContent.data.creation.username, "mira.creator_01");
  assert.deepEqual(affiliate.structuredContent.data.public_identity, {
    display_name: "Mira",
    tiktok_username: "mira.creator_01",
    tiktok_homepage_candidate: "https://www.tiktok.com/@mira.creator_01",
    base_persona_ref: "relaxed_wit@1.0.1",
    account_type: "affiliate_digital_broker",
    content_status: "not_created"
  });
  assert.equal(affiliate.structuredContent.data.profile.broker_name, "Mira");
  assert.equal(affiliate.structuredContent.data.profile.persona_ref, "relaxed_wit@1.0.1");
  assert.equal(affiliate.structuredContent.data.profile.contact_email, "qq651938934@outlook.com");
  assert.equal(affiliate.structuredContent.data.assignment_status, "awaiting_created_account_id");
  assert.equal(affiliate.structuredContent.data.credential_delivery, "broker_backstage_registration_email");

  const affiliateAssignment = await server.call("guild_onboarding", {
    guild_ref: guildRef,
    child: "prepare_affiliate_assignment",
    params: {
      workflow_id: "affiliate-wf-001",
      affiliate_account_id: "7654321",
      broker_email: "mry666888@outlook.com",
      assignment_idempotency_key: "affiliate-assign-001"
    }
  });
  assert.equal(affiliateAssignment.structuredContent.status, "ok");
  assert.equal(affiliateAssignment.structuredContent.data.assignment.affiliate_account_id, "7654321");
  assert.deepEqual(affiliateAssignment.structuredContent.data.required_approvals, []);
  assert.equal(affiliateAssignment.structuredContent.data.status, "ready_for_agent");

  const wrongAccountId = await server.call("guild_onboarding", {
    guild_ref: guildRef,
    child: "prepare_affiliate_assignment",
    params: {
      workflow_id: "affiliate-wf-001",
      affiliate_account_id: "7654322",
      broker_email: "mry666888@outlook.com",
      assignment_idempotency_key: "affiliate-assign-wrong-id"
    }
  });
  assert.equal(wrongAccountId.structuredContent.status, "error");
  assert.equal(wrongAccountId.structuredContent.errors[0].code, "authorization_required");

  const mismatchedIdentity = await server.call("guild_onboarding", {
    guild_ref: guildRef,
    child: "prepare_affiliate_workflow",
    params: {
      workflow_id: "affiliate-mismatch-001",
      username: "mira.creator_02",
      nickname: "Mira",
      broker_name: "Atlantis Creator Network",
      persona_ref: "relaxed_wit@1.0.1",
      country: "AE",
      broker_email: "mry666888@outlook.com",
      contact_email: "qq651938934@outlook.com",
      creation_idempotency_key: "affiliate-create-002",
      profile_idempotency_key: "affiliate-profile-002"
    }
  });
  assert.equal(mismatchedIdentity.structuredContent.status, "error");

  const wrongBroker = await server.call("guild_onboarding", {
    guild_ref: guildRef,
    child: "prepare_affiliate_assignment",
    params: {
      workflow_id: "affiliate-wf-001",
      affiliate_account_id: "7654321",
      broker_email: "other@example.com",
      assignment_idempotency_key: "affiliate-assign-002"
    }
  });
  assert.equal(wrongBroker.structuredContent.status, "error");
  assert.equal(wrongBroker.structuredContent.errors[0].code, "authorization_required");
});
