import test from "node:test";
import assert from "node:assert/strict";

import {
  authorizeOperation,
  operationPolicy
} from "../src/operation-policy.mjs";

test("ordinary backstage reads and writes run under the agent operation policy", () => {
  assert.deepEqual(operationPolicy({ domain: "guild_messaging", child: "send_message" }), {
    mode: "agent_auto",
    requires_explicit_approval: false
  });
  assert.deepEqual(operationPolicy({ domain: "guild_onboarding", child: "assign_staff" }), {
    mode: "agent_auto",
    requires_explicit_approval: false
  });
  assert.deepEqual(operationPolicy({ domain: "guild_onboarding", child: "grant_messaging_permission" }), {
    mode: "agent_auto",
    requires_explicit_approval: false
  });
});

test("creator removal remains explicitly approval gated", () => {
  assert.throws(
    () => authorizeOperation({ domain: "guild_creators", child: "remove_creator" }),
    { code: "authorization_required" }
  );

  const result = authorizeOperation({
    domain: "guild_creators",
    child: "remove_creator",
    approval: {
      approved: true,
      workflow_id: "remove-workflow-1",
      step: "remove_creator",
      idempotency_key: "remove-1",
      expires_at: "2099-09-27T00:00:00.000Z"
    },
    now: "2026-09-27T00:00:00.000Z"
  });
  assert.deepEqual(result, { mode: "explicit_approval", requires_explicit_approval: true });

  assert.throws(
    () => authorizeOperation({
      domain: "guild_creators",
      child: "remove_creator",
      approval: {
        approved: true,
        workflow_id: "remove-workflow-1",
        step: "remove_creator",
        idempotency_key: "remove-1",
        expires_at: "not-a-date"
      },
      now: "2026-09-27T00:00:00.000Z"
    }),
    { code: "authorization_expired" }
  );
});
