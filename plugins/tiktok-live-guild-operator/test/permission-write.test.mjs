import assert from "node:assert/strict";
import test from "node:test";

import { grantMessagingPermission } from "../src/onboarding/live-write.mjs";

test("messaging-permission write requires an owned Backstage page and exact target identity", async () => {
  await assert.rejects(
    grantMessagingPermission({ page: {}, targetAgentId: "7410763046928745478", targetEmail: "mry666888@outlook.com" }),
    { code: "session_owner_unverified" }
  );

  const page = { async goto() {} };
  await assert.rejects(
    grantMessagingPermission({ page, targetAgentId: "not-an-id", targetEmail: "mry666888@outlook.com" }),
    { code: "capability_unavailable" }
  );
  await assert.rejects(
    grantMessagingPermission({ page, targetAgentId: "7410763046928745478", targetEmail: "not-an-email" }),
    { code: "capability_unavailable" }
  );
});
