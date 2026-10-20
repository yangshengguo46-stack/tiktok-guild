import { GuildError } from "../errors.mjs";

const ACCOUNTS_PATH = "/creators/live/union_platform_api/agency/host_recruitment/tt_biz_account/employee/accounts/";

function mismatch(message) {
  throw new GuildError("adapter_mismatch", message);
}

export function parseAffiliateInventory(readResult) {
  if (readResult?.completeness?.state !== "complete") mismatch("The affiliate account inventory is incomplete.");
  const matches = readResult?.data?.responses?.filter((entry) => entry.endpoint_path === ACCOUNTS_PATH) ?? [];
  const body = matches.at(-1)?.body;
  if (Number(body?.BaseResp?.StatusCode) !== 0 || !Array.isArray(body?.EmployeeAccounts)
    || !body?.HostBaseInfoMap || typeof body.HostBaseInfoMap !== "object") {
    mismatch("The affiliate account inventory did not have a successful provider response.");
  }
  const ids = new Set();
  return body.EmployeeAccounts.map((entry) => {
    const accountId = String(entry?.TTAccountID ?? "");
    const profile = body.HostBaseInfoMap[accountId];
    const username = String(profile?.display_id ?? "").trim();
    const nickname = String(profile?.nickname ?? "").trim();
    const country = String(entry?.StoreRegion ?? "").trim().toUpperCase();
    if (!/^\d+$/.test(accountId) || ids.has(accountId) || !username || !nickname || !/^[A-Z]{2}$/.test(country)) {
      mismatch("An affiliate account record is incomplete or duplicated.");
    }
    ids.add(accountId);
    return {
      account_id: accountId,
      username,
      nickname,
      country,
      manager_email: typeof entry?.AgentInfo?.AgentName === "string" && entry.AgentInfo.AgentName.trim()
        ? entry.AgentInfo.AgentName.trim().toLowerCase()
        : null
    };
  });
}

export function assertAccountNotPresent(accounts, username) {
  if (accounts.some((account) => account.username?.toLowerCase() === username.toLowerCase())) {
    throw new GuildError("duplicate_write", "An affiliate account with this username already exists.");
  }
}

export function assertAffiliateAccountMatchesPlan(accounts, plan, accountId) {
  const account = accounts.find((entry) => entry.account_id === accountId);
  if (!account || account.username.toLowerCase() !== plan.username.toLowerCase()
    || account.nickname !== plan.nickname || account.country !== plan.country || account.manager_email !== null) {
    throw new GuildError("authorization_required", "The affiliate account ID does not match the unassigned approved identity.");
  }
  return account;
}

export function verifyCreatedAffiliateAccount({ before, after, plan }) {
  assertAccountNotPresent(before, plan.username);
  const candidates = after.filter((account) => account.username?.toLowerCase() === plan.username.toLowerCase());
  if (candidates.length !== 1 || before.some((account) => account.account_id === candidates[0]?.account_id)
    || candidates[0].nickname !== plan.nickname || candidates[0].country !== plan.country) {
    throw new GuildError("write_receipt_unknown", "The created affiliate account did not match the approved plan in read-back.");
  }
  return candidates[0];
}

export function verifyAffiliateAssignment(accounts, accountId, brokerEmail) {
  const account = accounts.find((entry) => entry.account_id === accountId);
  if (!account || account.manager_email !== brokerEmail.toLowerCase()) {
    throw new GuildError("write_receipt_unknown", "The affiliate account manager did not match the approved broker in read-back.");
  }
  return account;
}
