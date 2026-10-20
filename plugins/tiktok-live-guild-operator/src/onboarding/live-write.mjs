import { GuildError } from "../errors.mjs";

const ORIGIN = "https://live-backstage.tiktok.com";
const INVITE_PATH = "/creators/live/union_platform_api/agency/group_management/invite/";
const TRANSFER_QUOTA_PATH = "/creators/live/union_platform_api/agency/quota/transfer_quota/";
const RECRUITMENT_PERMISSION_PATH = "/creators/live/union_platform_api/agency/host_recruitment/change_recruitment_permission/";
const AFFILIATE_ACCOUNTS_ROUTE = "/portal/anchor/scout-creators?tab=accounts";
const ASSIGN_AFFILIATE_ACCOUNT_PATH = "/creators/live/union_platform_api/agency/host_recruitment/tt_biz_account/employee/assign/";

function providerError(message, details = {}) {
  return new GuildError("provider_write_failed", message, undefined, details);
}

async function jsonResponse(response) {
  let body;
  try { body = await response.json(); } catch { throw providerError("The provider returned a non-JSON write response."); }
  const statusCode = Number(body?.BaseResp?.StatusCode ?? body?.status_code ?? -1);
  if (response.status() !== 200 || statusCode !== 0) {
    throw providerError("The provider rejected the write request.", { provider_status: response.status(), status_code: statusCode });
  }
  return body;
}

async function click(locator) {
  if (await locator.count() === 0) throw new GuildError("capability_unavailable", "The live write control is not present.");
  try { await locator.last().dispatchEvent("click"); } catch { await locator.last().click({ force: true }); }
}

async function selectGroup(page, group) {
  const exact = page.getByText(group, { exact: true });
  if (await exact.count() === 0) throw new GuildError("capability_unavailable", `Backstage group "${group}" was not found.`);
  await click(exact);
  await page.waitForTimeout(250);
}

async function visibleDialog(page) {
  const dialogs = page.locator('[role="dialog"]:visible');
  if (await dialogs.count() > 0) return dialogs.last();
  return page.locator('body');
}

async function responseFor(page, path, action) {
  const responsePromise = page.waitForResponse((response) => {
    try { return new URL(response.url()).pathname === path; } catch { return false; }
  }, { timeout: 15_000 });
  await action();
  return jsonResponse(await responsePromise);
}

async function findSubmit(dialog, labels) {
  const buttons = dialog.locator("button");
  for (const label of labels) {
    const candidate = buttons.filter({ hasText: label });
    if (await candidate.count() > 0) return candidate.last();
  }
  throw new GuildError("capability_unavailable", "The live write submit control is not present.");
}

export async function grantMessagingPermission({ page, targetAgentId, targetEmail }) {
  if (!page || typeof page.goto !== "function") {
    throw new GuildError("session_owner_unverified", "The owned Backstage page is unavailable.");
  }
  if (!/^\d+$/.test(String(targetAgentId ?? ""))) {
    throw new GuildError("capability_unavailable", "A target agent ID is required.");
  }
  if (typeof targetEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail.trim())) {
    throw new GuildError("capability_unavailable", "A valid target agent email is required.");
  }
  const email = targetEmail.trim().toLowerCase();
  await openAffiliateAccounts(page);
  let row = page.locator("tr").filter({ hasText: email });
  if (await row.count() === 0) throw new GuildError("capability_unavailable", "The target agent is not visible in Backstage.");
  row = row.last();
  const authorize = row.getByRole("button", { name: /authorize|授权/iu });
  if (await authorize.count() === 0) {
    const text = await row.innerText();
    if (/authorized|已授权/iu.test(text)) {
      return {
        status: "verified",
        endpoint_path: RECRUITMENT_PERMISSION_PATH,
        provider_status: null,
        target: { agent_id: String(targetAgentId), email },
        read_back: { authorized: true, already_authorized: true }
      };
    }
    throw new GuildError("capability_unavailable", "The messaging-permission control is not present for the target agent.");
  }
  await click(authorize);
  const dialog = await visibleDialog(page);
  const submit = await findSubmit(dialog, [/^authorize$|^授权$|^confirm$|^确认$/iu]);
  const body = await responseFor(page, RECRUITMENT_PERMISSION_PATH, () => click(submit));
  await page.waitForTimeout(700);
  const readBack = page.locator("tr").filter({ hasText: email }).last();
  if (await readBack.count() === 0 || !/authorized|已授权/iu.test(await readBack.innerText())) {
    throw new GuildError("write_receipt_unknown", "The permission write was accepted but authorization was not visible in read-back.", undefined, {
      target_agent_id: String(targetAgentId),
      target_email: email,
      endpoint_path: RECRUITMENT_PERMISSION_PATH
    });
  }
  return {
    status: "verified",
    endpoint_path: RECRUITMENT_PERMISSION_PATH,
    provider_status: Number(body?.BaseResp?.StatusCode ?? body?.status_code ?? 0),
    target: { agent_id: String(targetAgentId), email },
    read_back: { authorized: true, already_authorized: false }
  };
}

async function openAffiliateAccounts(page) {
  await page.goto(`${ORIGIN}${AFFILIATE_ACCOUNTS_ROUTE}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  const policyDialog = page.getByRole("dialog").filter({ hasText: /TikTok Creator Network Management Policy/i });
  if (await policyDialog.count() > 0) {
    const close = policyDialog.getByRole("button", { name: /close|关闭/i });
    if (await close.count() > 0 && await close.last().isVisible()) await click(close);
  }
  const tab = page.getByText("Affiliate Accounts", { exact: true });
  if (await tab.count() > 0 && await tab.last().isVisible()) await click(tab);
  await page.waitForTimeout(900);
}

async function selectAffiliateManager(page, dialog, brokerEmail) {
  const combobox = dialog.locator('[role="combobox"], .semi-select').last();
  if (await combobox.count() === 0) {
    throw new GuildError("capability_unavailable", "The affiliate manager selector is not present.");
  }
  await click(combobox);
  const option = page.getByRole("option", { name: brokerEmail, exact: true });
  const textOption = page.getByText(brokerEmail, { exact: true });
  if (await option.count() > 0) {
    await click(option.last());
    return;
  }
  if (await textOption.count() > 0) {
    await click(textOption.last());
    return;
  }
  throw new GuildError("authorization_required", `The approved affiliate manager ${brokerEmail} is not available in Backstage.`);
}

export async function assignAffiliateAccount({ page, affiliateAccountId, brokerEmail }) {
  if (!page || typeof page.goto !== "function") {
    throw new GuildError("session_owner_unverified", "The owned Backstage page is unavailable.");
  }
  if (!/^\d+$/.test(String(affiliateAccountId ?? ""))) {
    throw new GuildError("capability_unavailable", "An affiliate account ID is required.");
  }
  if (typeof brokerEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(brokerEmail.trim())) {
    throw new GuildError("capability_unavailable", "A valid affiliate manager email is required.");
  }
  const normalizedBrokerEmail = brokerEmail.trim().toLowerCase();
  await openAffiliateAccounts(page);
  let row = page.locator(`tr[data-row-key="${affiliateAccountId}"]`);
  if (await row.count() === 0) {
    row = page.locator("tr").filter({ hasText: String(affiliateAccountId) });
  }
  if (await row.count() === 0) {
    throw new GuildError("capability_unavailable", "The approved affiliate account is not visible in Backstage.");
  }
  row = row.last();
  const assign = row.locator('[data-id="scoutCreators-assign-bcAccount-btn"]');
  if (await assign.count() === 0) {
    throw new GuildError("authorization_required", "The affiliate account is already assigned or the current identity cannot assign it.");
  }
  await click(assign);
  const dialog = await visibleDialog(page);
  await selectAffiliateManager(page, dialog, normalizedBrokerEmail);
  const submit = await findSubmit(dialog, [/^确定$|^assign$|^change manager$|^confirm$|^分配$|^更换经纪人$/i]);
  const body = await responseFor(page, ASSIGN_AFFILIATE_ACCOUNT_PATH, () => click(submit));
  await page.waitForTimeout(700);
  return {
    status: "accepted",
    endpoint_path: ASSIGN_AFFILIATE_ACCOUNT_PATH,
    provider_status: Number(body?.BaseResp?.StatusCode ?? body?.status_code ?? 0),
    request: { TTAccountID: String(affiliateAccountId), broker_email: normalizedBrokerEmail },
    read_back_required: true
  };
}

export async function assignStaff({ page, group, emails }) {
  if (!page || typeof page.goto !== "function") throw new GuildError("session_owner_unverified", "The owned Backstage page is unavailable.");
  if (!Array.isArray(emails) || emails.length === 0) throw new GuildError("capability_unavailable", "At least one staff email is required.");
  await page.goto(`${ORIGIN}/portal/administration/staff`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await selectGroup(page, group);
  await page.waitForSelector('[data-id="invite-agent"]', { state: "visible", timeout: 10_000 });
  await click(page.locator('[data-id="invite-agent"]'));
  const dialog = await visibleDialog(page);
  const internalMatches = emails.map((email) => dialog.getByText(email, { exact: true }));
  const internalCounts = await Promise.all(internalMatches.map((locator) => locator.count()));
  const canSelectInternal = internalCounts.every((count) => count > 0);
  if (canSelectInternal) {
    for (const match of internalMatches) await click(match);
  } else {
    const external = dialog.getByText(/公会外部|external|externo/i);
    if (await external.count() > 0) await click(external);
    const input = dialog.locator('input[type="email"], input[placeholder*="电子邮件"], input[placeholder*="email" i]').first();
    if (await input.count() === 0) throw new GuildError("capability_unavailable", "The staff email control is not present.");
    for (const email of emails) {
      await input.fill(email);
      await input.press("Enter");
    }
  }
  const submit = await findSubmit(dialog, [/确定|submit|enviar/i]);
  const responsePromise = page.waitForResponse((response) => {
    try { return new URL(response.url()).pathname === INVITE_PATH; } catch { return false; }
  }, { timeout: 15_000 });
  await click(submit);
  await page.waitForTimeout(350);
  const confirmation = page.locator('[role="dialog"]:visible').filter({ hasText: /removed from|移出|eliminar|current group/i });
  if (await confirmation.count() > 0) {
    const confirmButton = await findSubmit(confirmation.last(), [/确定|submit|confirm|enviar/i]);
    await click(confirmButton);
  }
  const body = await jsonResponse(await responsePromise);
  await page.waitForTimeout(500);
  await page.goto(`${ORIGIN}/portal/administration/staff`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await selectGroup(page, group);
  const readBack = await page.locator("body").innerText();
  const missing = emails.filter((email) => !readBack.toLowerCase().includes(email.toLowerCase()));
  if (missing.length > 0) {
    throw new GuildError("write_receipt_unknown", "The staff write was accepted but the assignment was not visible in read-back.", undefined, { missing });
  }
  return {
    status: "verified",
    endpoint_path: INVITE_PATH,
    provider_status: Number(body?.BaseResp?.StatusCode ?? 0),
    assigned_group: group,
    assigned_emails: [...emails],
    read_back: { visible: true, missing: [] }
  };
}

async function expandAllGroups(page) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const expanders = page.locator('tr[aria-level="1"] .semi-table-expand-icon');
    const count = await expanders.count();
    if (count === 0) return;
    let clicked = false;
    for (let index = 0; index < count; index += 1) {
      const row = expanders.nth(index).locator("..").locator("..");
      if ((await row.getAttribute("aria-expanded")) !== "true") {
        await click(expanders.nth(index));
        clicked = true;
        await page.waitForTimeout(150);
      }
    }
    if (!clicked) return;
  }
}

export async function allocateInvitationCards({ page, agencyId, userId, targetId, targetEmail, regular = 0, premium = 0 }) {
  if (!page || typeof page.goto !== "function") throw new GuildError("session_owner_unverified", "The owned Backstage page is unavailable.");
  if (!targetId && !targetEmail) throw new GuildError("capability_unavailable", "A target agent id or email is required.");
  if (!Number.isInteger(regular) || regular < 0 || !Number.isInteger(premium) || premium < 0 || (regular === 0 && premium === 0)) {
    throw new GuildError("capability_unavailable", "Invitation quantities must contain at least one non-negative integer.");
  }
  await page.goto(`${ORIGIN}/portal/anchor/invitation-management`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  await expandAllGroups(page);
  let row = targetId ? page.locator(`tr[data-row-key="${targetId}"]`) : page.locator("tr").filter({ hasText: targetEmail });
  if (await row.count() === 0) throw new GuildError("capability_unavailable", "The target agent is not visible in invitation allocation.");
  row = row.last();
  const beforeCells = await row.locator("td").allTextContents();
  const beforeRegular = Number(String(beforeCells[3] ?? "0").replace(/[^0-9-]/g, "")) || 0;
  const beforePremium = Number(String(beforeCells[4] ?? "0").replace(/[^0-9-]/g, "")) || 0;
  const resolvedTargetId = targetId ?? await row.getAttribute("data-row-key");
  const adjust = row.locator('[data-id="invitation-management-InvitationAllocationTable-assign-btn"]');
  await click(adjust);
  const dialog = await visibleDialog(page);
  const inputs = dialog.locator('input[type="text"], input[type="number"]');
  if (await inputs.count() < 2) throw new GuildError("capability_unavailable", "The invitation quantity controls are not present.");
  await inputs.nth(0).fill(String(regular));
  await inputs.nth(1).fill(String(premium));
  const submit = await findSubmit(dialog, [/^调整$|^adjust$|^ajustar$|submit|enviar/i]);
  const deltaMap = {};
  if (regular !== 0) deltaMap["3"] = regular;
  if (premium !== 0) deltaMap["6"] = premium;
  const body = await responseFor(page, TRANSFER_QUOTA_PATH, () => click(submit));
  await page.waitForTimeout(700);
  await page.goto(`${ORIGIN}/portal/anchor/invitation-management`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1400);
  await expandAllGroups(page);
  let readBackRow = resolvedTargetId ? page.locator(`tr[data-row-key="${resolvedTargetId}"]`) : page.locator("tr").filter({ hasText: targetEmail });
  if (await readBackRow.count() === 0) throw new GuildError("write_receipt_unknown", "The quota write was accepted but the target row disappeared from read-back.");
  readBackRow = readBackRow.last();
  const afterCells = await readBackRow.locator("td").allTextContents();
  const afterRegular = Number(String(afterCells[3] ?? "0").replace(/[^0-9-]/g, "")) || 0;
  const afterPremium = Number(String(afterCells[4] ?? "0").replace(/[^0-9-]/g, "")) || 0;
  if (afterRegular !== beforeRegular + regular || afterPremium !== beforePremium + premium) {
    throw new GuildError("write_receipt_unknown", "The quota write was accepted but allocation read-back did not match the requested delta.", undefined, {
      expected: { regular: beforeRegular + regular, premium: beforePremium + premium },
      observed: { regular: afterRegular, premium: afterPremium }
    });
  }
  return {
    status: "verified",
    endpoint_path: TRANSFER_QUOTA_PATH,
    provider_status: Number(body?.BaseResp?.StatusCode ?? 0),
    request: { AgencyID: agencyId, UserID: userId ?? null, TargetID: resolvedTargetId, DeltaMap: deltaMap },
    read_back: { regular: afterRegular, premium: afterPremium, matched: true }
  };
}

export async function fillVerificationCode({ page, verificationCode }) {
  if (!page || typeof page.locator !== "function") throw new GuildError("session_owner_unverified", "The visible verification page is unavailable.");
  if (typeof verificationCode !== "string" || !/^\d{4,8}$/.test(verificationCode.trim())) {
    throw new GuildError("capability_unavailable", "The verification code must be 4 to 8 digits.");
  }
  const candidates = page.locator('input[autocomplete="one-time-code"], input[name*="code" i], input[placeholder*="验证码"], input[placeholder*="verification" i]');
  const visible = [];
  for (let index = 0; index < await candidates.count(); index += 1) {
    if (await candidates.nth(index).isVisible()) visible.push(candidates.nth(index));
  }
  if (visible.length !== 1) throw new GuildError("capability_unavailable", "Exactly one verification-code field must be visible.");
  await visible[0].fill(verificationCode.trim());
  return { status: "filled", field_count: 1, code_consumed: true };
}
