import assert from "node:assert/strict";
import test from "node:test";

import { DOMAIN_CATALOG } from "../src/catalog.mjs";
import { prepareMessagePlan } from "../src/messaging/workflow.mjs";

test("messaging exposes an agent-ready prepare and send operation", () => {
  const domain = DOMAIN_CATALOG.find(({ name }) => name === "guild_messaging");
  assert.deepEqual(domain.children, ["list_conversations", "get_messages", "prepare_message", "send_message", "get_operation_status", "reconcile_message"]);

  const plan = prepareMessagePlan({
    guild_ref: "guild_12345678",
    workflow_id: "msg-wf-001",
    sender_account_ref: "affiliate:mira.creator_01",
    recipient_handle: "lla.ap",
    content: "你好",
    idempotency_key: "msg-001"
  });
  assert.equal(plan.status, "ready_for_agent");
  assert.deepEqual(plan.required_approvals, []);
  assert.equal(plan.recipient_handle, "lla.ap");
  assert.equal(plan.capability, "write_verified");
});

test("message plans require one exact recipient and non-empty content", () => {
  assert.throws(() => prepareMessagePlan({
    guild_ref: "guild_12345678",
    workflow_id: "msg-wf-001",
    sender_account_ref: "affiliate:mira.creator_01",
    content: "你好",
    idempotency_key: "msg-001"
  }), /recipient/iu);

  assert.throws(() => prepareMessagePlan({
    guild_ref: "guild_12345678",
    workflow_id: "msg-wf-001",
    sender_account_ref: "affiliate:mira.creator_01",
    recipient_handle: "lla.ap",
    content: " ",
    idempotency_key: "msg-001"
  }), /content/iu);
});
