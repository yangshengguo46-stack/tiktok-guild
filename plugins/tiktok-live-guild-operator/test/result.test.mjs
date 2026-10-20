import assert from "node:assert/strict";
import test from "node:test";

import { GuildError, recoveryFor } from "../src/errors.mjs";
import { errorEnvelope, successEnvelope, toolResult } from "../src/result.mjs";

test("a domain error remains inside its own envelope", () => {
  const result = errorEnvelope({
    domain: "guild_governance",
    child: "list_guild_violations",
    error: new GuildError("adapter_mismatch", "The live surface changed.")
  });

  assert.equal(result.status, "error");
  assert.equal(result.domain, "guild_governance");
  assert.equal(result.child, "list_guild_violations");
  assert.equal(result.data, null);
  assert.deepEqual(result.errors.map(({ code }) => code), ["adapter_mismatch"]);
  assert.equal(result.errors[0].recovery, "Retry after the live adapter is reviewed.");
});

test("success envelopes preserve partial evidence and pagination", () => {
  const result = successEnvelope({
    status: "partial",
    domain: "guild_creators",
    child: "list_creators",
    data: { creators: [{ creator_id: "738001", diamonds: 120034 }] },
    evidence: [{ route: "/portal/anchor/list", observed_at: "2026-09-20T00:00:00.000Z" }],
    completeness: { state: "partial", missing: ["page:2"] },
    pagination: { complete: false, next_cursor: "2", pages_read: 1, page_size: 100 }
  });

  assert.equal(result.status, "partial");
  assert.equal(result.data.creators[0].creator_id, "738001");
  assert.equal(result.data.creators[0].diamonds, 120034);
  assert.equal(result.pagination.next_cursor, "2");
  assert.deepEqual(result.errors, []);
});

test("stable errors have actionable recovery text", () => {
  const codes = [
    "login_required",
    "runtime_restart_required",
    "guild_binding_not_found",
    "session_owner_unverified",
    "capability_unavailable",
    "adapter_mismatch"
  ];
  for (const code of codes) assert.ok(recoveryFor(code).length > 8);
});

test("tool results expose the same structured envelope", () => {
  const envelope = successEnvelope({
    domain: "guild_revenue",
    child: "get_overview",
    data: { diamonds: 9 },
    evidence: [],
    completeness: { state: "complete", missing: [] },
    pagination: null
  });
  const result = toolResult(envelope);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent, envelope);
  assert.match(result.content[0].text, /guild_revenue/);
});
