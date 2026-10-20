import assert from "node:assert/strict";
import test from "node:test";

import * as workflow from "../src/onboarding/workflow.mjs";

const guild = { guild_ref: "guild_12345678", guild_id: "103785", registered_country: "AE", portal_region: "MENA" };

test("affiliate creation plans the official username, nickname, and region without inventing mailbox credentials", () => {
  const plan = workflow.prepareAffiliateAccountPlan({
    guild,
    username: "mira.creator_01",
    nickname: "Mira",
    persona_ref: "relaxed_wit@1.0.1",
    country: "AE",
    idempotency_key: "affiliate-create-001",
    mailbox: "ignored@example.com",
    password: "never-copy"
  });

  assert.deepEqual(plan, {
    kind: "affiliate_account_creation",
    status: "ready_for_agent",
    guild_ref: "guild_12345678",
    guild_id: "103785",
    username: "mira.creator_01",
    nickname: "Mira",
    persona_ref: "relaxed_wit@1.0.1",
    tiktok_homepage_candidate: "https://www.tiktok.com/@mira.creator_01",
    country: "AE",
    idempotency_key: "affiliate-create-001",
    required_approvals: [],
    capability: "write_verified"
  });
});

test("affiliate creation rejects usernames the official Backstage form would reject", () => {
  for (const username of ["letters", "name.", "bad-name", "a".repeat(26)]) {
    assert.throws(() => workflow.prepareAffiliateAccountPlan({
      guild, username, nickname: "Atlantis LIVE", country: "AE", idempotency_key: "affiliate-create-001"
    }), /username/i);
  }
});

test("affiliate identity requires an approved expression asset rather than an invented persona", () => {
  assert.throws(() => workflow.prepareAffiliateAccountPlan({
    guild, username: "mira.creator_01", nickname: "Mira", country: "AE", idempotency_key: "affiliate-create-001"
  }), /persona_ref/u);
  assert.throws(() => workflow.prepareAffiliateAccountPlan({
    guild, username: "mira.creator_01", nickname: "Mira", persona_ref: "fictional_human@1.0.1", country: "AE", idempotency_key: "affiliate-create-001"
  }), /persona_ref/u);
});

test("affiliate assignment binds one created account to one already-authorized broker", () => {
  assert.deepEqual(workflow.prepareAffiliateAssignmentPlan({
    guild_ref: "guild_12345678",
    affiliate_account_id: "7654321",
    broker_email: "MRY666888@OUTLOOK.COM",
    idempotency_key: "affiliate-assign-001"
  }), {
    kind: "affiliate_account_assignment",
    status: "ready_for_agent",
    guild_ref: "guild_12345678",
    affiliate_account_id: "7654321",
    broker_email: "mry666888@outlook.com",
    idempotency_key: "affiliate-assign-001",
    required_approvals: [],
    capability: "write_verified"
  });
});

test("broker profile keeps public contact email distinct from Backstage login email", () => {
  assert.deepEqual(workflow.prepareBrokerProfilePlan({
    guild_ref: "guild_12345678",
    broker_email: "mry666888@outlook.com",
    affiliate_username: "mira.creator_01",
    broker_name: "Mira",
    persona_ref: "relaxed_wit@1.0.1",
    contact_email: "qq651938934@outlook.com",
    idempotency_key: "profile-001"
  }), {
    kind: "broker_profile_update",
    status: "ready_for_agent",
    guild_ref: "guild_12345678",
    broker_email: "mry666888@outlook.com",
    affiliate_username: "mira.creator_01",
    broker_name: "Mira",
    persona_ref: "relaxed_wit@1.0.1",
    tiktok_homepage_candidate: "https://www.tiktok.com/@mira.creator_01",
    contact_email: "qq651938934@outlook.com",
    idempotency_key: "profile-001",
    required_approvals: [],
    capability: "write_verified"
  });
});
