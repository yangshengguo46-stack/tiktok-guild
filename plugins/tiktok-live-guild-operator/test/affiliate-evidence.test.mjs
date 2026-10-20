import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAccountNotPresent,
  assertAffiliateAccountMatchesPlan,
  parseAffiliateInventory,
  verifyCreatedAffiliateAccount,
  verifyAffiliateAssignment
} from "../src/onboarding/affiliate-evidence.mjs";

const PATH = "/creators/live/union_platform_api/agency/host_recruitment/tt_biz_account/employee/accounts/";

function readResult(accounts, profiles, statusCode = 0) {
  return {
    completeness: { state: "complete" },
    data: { responses: [{ endpoint_path: PATH, body: {
      BaseResp: { StatusCode: statusCode }, EmployeeAccounts: accounts, HostBaseInfoMap: profiles
    } }] }
  };
}

test("affiliate inventory binds account ID, public handle, nickname, region and manager", () => {
  const result = parseAffiliateInventory(readResult(
    [{ TTAccountID: "7638180861091316752", StoreRegion: "ae", AgentInfo: { AgentName: "manager@example.com" } }],
    { "7638180861091316752": { display_id: "mira.creator_01", nickname: "Mira" } }
  ));

  assert.deepEqual(result, [{
    account_id: "7638180861091316752",
    username: "mira.creator_01",
    nickname: "Mira",
    country: "AE",
    manager_email: "manager@example.com"
  }]);
});

test("affiliate inventory rejects an incomplete or failed provider read", () => {
  const incomplete = readResult([], {});
  incomplete.completeness.state = "partial";
  assert.throws(() => parseAffiliateInventory(incomplete), { code: "adapter_mismatch" });
  assert.throws(() => parseAffiliateInventory(readResult([], {}, 1001)), { code: "adapter_mismatch" });
});

test("creation preflight rejects a duplicate handle", () => {
  assert.throws(() => assertAccountNotPresent([{
    username: "Mira.Creator_01"
  }], "mira.creator_01"), { code: "duplicate_write" });
});

test("new-account readback requires a new ID, exact public name and region", () => {
  const before = [{ account_id: "old", username: "other_01" }];
  const after = [...before, {
    account_id: "new_account_01", username: "mira.creator_01",
    nickname: "Mira", country: "AE", manager_email: null
  }];
  const plan = { username: "mira.creator_01", nickname: "Mira", country: "AE" };
  assert.deepEqual(verifyCreatedAffiliateAccount({ before, after, plan }), after[1]);
  assert.throws(() => verifyCreatedAffiliateAccount({ before: after, after, plan }), { code: "duplicate_write" });
  assert.throws(() => verifyCreatedAffiliateAccount({ before, after: [{ ...after[1], country: "SA" }], plan }), { code: "write_receipt_unknown" });
});

test("assignment readback must show the exact broker on the created account", () => {
  const account = { account_id: "new_account_01", username: "mira.creator_01", manager_email: "mry666888@outlook.com" };
  assert.deepEqual(verifyAffiliateAssignment([account], "new_account_01", "mry666888@outlook.com"), account);
  assert.throws(() => verifyAffiliateAssignment([{ ...account, manager_email: "other@example.com" }], "new_account_01", "mry666888@outlook.com"), { code: "write_receipt_unknown" });
});

test("assignment preparation refuses an account ID that does not match the planned public identity", () => {
  const plan = { username: "mira.creator_01", nickname: "Mira", country: "AE" };
  const account = { account_id: "7638180861091316752", username: "mira.creator_01", nickname: "Mira", country: "AE", manager_email: null };
  assert.deepEqual(assertAffiliateAccountMatchesPlan([account], plan, account.account_id), account);
  assert.throws(() => assertAffiliateAccountMatchesPlan([account], plan, "7638180603527889937"), { code: "authorization_required" });
  assert.throws(() => assertAffiliateAccountMatchesPlan([{ ...account, nickname: "Other" }], plan, account.account_id), { code: "authorization_required" });
  assert.throws(() => assertAffiliateAccountMatchesPlan([{ ...account, manager_email: "other@example.com" }], plan, account.account_id), { code: "authorization_required" });
});
