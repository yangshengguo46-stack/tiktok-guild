import assert from "node:assert/strict";
import test from "node:test";

import { prepareAssignmentPlan } from "../src/onboarding/workflow.mjs";

test("assignment plan rejects broad permissions and duplicate staff", () => {
  assert.throws(() => prepareAssignmentPlan({
    guild_ref: "guild_12345678",
    assignments: [
      { email: "agent@example.com", group: "自营", role: "组长", permissions: ["全部"] },
      { email: "agent@example.com", group: "自营", role: "组长", permissions: ["即时消息"] }
    ],
    idempotency_key: "assign-001"
  }), /duplicate staff email|broad permission/i);
});
