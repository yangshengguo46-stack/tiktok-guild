import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { DOMAIN_CATALOG } from "../src/catalog.mjs";
import { GuildError } from "../src/errors.mjs";
import { createHandlers } from "../src/handlers.mjs";
import { readView } from "../src/live/read-view.mjs";
import { getView } from "../src/live/view-registry.mjs";

class FakePage extends EventEmitter {
  constructor(responses) {
    super();
    this.responses = responses;
    this.currentUrl = "about:blank";
  }
  url() { return this.currentUrl; }
  async goto(url) {
    this.currentUrl = url;
    for (const response of this.responses) this.emit("response", response);
  }
  async waitForTimeout() {}
  async evaluate() {
    return { title: "Creator management", path: "/portal/anchor/list", text: "Creators", tables: [] };
  }
}

class DelayedPage extends FakePage {
  constructor(responses, delayMilliseconds = 500) {
    super([]);
    this.delayedResponses = responses;
    this.delayMilliseconds = delayMilliseconds;
  }
  async goto(url) {
    this.currentUrl = url;
    setTimeout(() => {
      for (const response of this.delayedResponses) this.emit("response", response);
    }, this.delayMilliseconds);
  }
  async waitForTimeout(milliseconds) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

class BlankSurfacePage extends FakePage {
  async evaluate() {
    return { title: "Instant messages", path: "/portal/anchor/instant-messages", text: "", tables: [] };
  }
}

function jsonResponse(path, body, { status = 200, origin = "https://live-backstage.tiktok.com" } = {}) {
  return {
    url: () => `${origin}${path}`,
    status: () => status,
    request: () => ({ method: () => "GET" }),
    headers: async () => ({ "content-type": "application/json" }),
    body: async () => Buffer.from(JSON.stringify(body))
  };
}

test("every catalog child has one curated live view", () => {
  const ownerChildren = new Set(["prepare_message", "send_message", "get_operation_status", "reconcile_message"]);
  for (const domain of DOMAIN_CATALOG.filter(({ name }) => !["guild_workspace", "guild_onboarding"].includes(name))) {
    for (const child of domain.children) {
      if (ownerChildren.has(child)) continue;
      const view = getView(domain.name, child);
      assert.equal(view.domain, domain.name);
      assert.equal(view.child, child);
      assert.match(view.route, /^\/portal\//);
    }
  }
});

test("affiliate-account inventory reads the dedicated recruitment account tab", async () => {
  const view = getView("guild_recruitment", "list_affiliate_accounts");
  const accountPath = "/creators/live/union_platform_api/agency/host_recruitment/tt_biz_account/employee/accounts/";
  const page = new FakePage([jsonResponse(accountPath, {
    BaseResp: { StatusCode: 0 },
    EmployeeAccounts: [{ TTAccountID: "7638180861091316752", AgentInfo: { AgentName: "manager@example.com" } }]
  })]);
  let openedAffiliateTab = false;
  page.getByRole = () => ({
    filter: () => ({ getByRole: () => ({ isVisible: async () => false }) })
  });
  page.getByText = (label) => {
    assert.equal(label, "Affiliate Accounts");
    return { waitFor: async () => {}, click: async () => { openedAffiliateTab = true; } };
  };
  page.evaluate = async () => ({
    title: "Scout creators",
    path: "/portal/anchor/scout-creators",
    text: "Recruitment accounts Affiliate accounts mira.creator_01 Assigned to mry666888@outlook.com",
    tables: []
  });
  const result = await readView({ page, view, params: {}, responseWaitMs: 0 });

  assert.equal(page.currentUrl, "https://live-backstage.tiktok.com/portal/anchor/scout-creators?tab=accounts");
  assert.equal(openedAffiliateTab, true);
  assert.equal(result.status, "ok");
  assert.equal(result.data.responses[0].body.EmployeeAccounts[0].TTAccountID, "7638180861091316752");
  assert.match(result.data.surface.text, /mira\.creator_01/u);
  assert.equal(result.evidence[0].endpoint_path, accountPath);
});

test("a DOM-only live view does not wait for an endpoint that is not mapped", async () => {
  const view = { ...getView("guild_recruitment", "list_affiliate_accounts"), response_paths: [], prepare: undefined };
  const start = performance.now();
  const result = await readView({ page: new FakePage([]), view, params: {}, responseWaitMs: 1_000 });

  assert.equal(result.status, "ok");
  assert.ok(performance.now() - start < 500, "DOM-only views should return without an endpoint timeout");
});

test("an affiliate-account view waits past the Backstage loading shell", async () => {
  const page = new FakePage([]);
  let samples = 0;
  page.evaluate = async () => {
    samples += 1;
    return samples < 3
      ? { title: "LIVE Backstage", path: "/portal/anchor/scout-creators", text: "LIVE Backstage", tables: [] }
      : { title: "LIVE Backstage", path: "/portal/anchor/scout-creators", text: "招募账号 联盟账号 创建账号", tables: [] };
  };

  const result = await readView({
    page,
    view: { ...getView("guild_recruitment", "list_affiliate_accounts"), response_paths: [], prepare: undefined },
    responseWaitMs: 1_000
  });

  assert.ok(samples >= 3);
  assert.equal(result.status, "ok");
  assert.match(result.data.surface.text, /联盟账号/u);
});

test("a persistent Backstage loading shell is partial, not an account inventory", async () => {
  const page = new FakePage([]);
  page.evaluate = async () => ({
    title: "LIVE Backstage", path: "/portal/anchor/scout-creators", text: "LIVE Backstage", tables: []
  });
  const result = await readView({
    page,
    view: { ...getView("guild_recruitment", "list_affiliate_accounts"), response_paths: [], prepare: undefined },
    responseWaitMs: 0
  });

  assert.equal(result.status, "partial");
  assert.deepEqual(result.completeness.missing, ["live_read_mapping"]);
});

test("the reader preserves creator IDs and numeric metrics from allowed responses", async () => {
  const view = getView("guild_creators", "list_creators");
  const expectedPath = view.response_paths[0];
  const page = new FakePage([
    jsonResponse("/unrelated", { secret: "ignored" }),
    jsonResponse(expectedPath, { data: { creator_id: "738001", diamonds: 120034 } })
  ]);

  const result = await readView({
    page,
    view: { ...view, response_paths: [expectedPath] },
    params: {},
    clock: () => "2026-09-20T00:00:00.000Z"
  });

  assert.equal(result.data.responses[0].body.data.creator_id, "738001");
  assert.equal(result.data.responses[0].body.data.diamonds, 120034);
  assert.equal(result.completeness.state, "complete");
  assert.equal(result.evidence[0].endpoint_path, expectedPath);
});

test("the reader waits for delayed expected responses instead of sampling a fixed startup instant", async () => {
  const view = getView("guild_creators", "list_creators");
  const expectedPaths = view.response_paths;
  const page = new DelayedPage(expectedPaths.map((path, index) => (
    jsonResponse(path, { data: { creator_id: `73800${index + 1}`, diamonds: 100 + index } })
  )));

  const result = await readView({
    page,
    view,
    params: {},
    clock: () => "2026-09-20T00:00:00.000Z",
    responseWaitMs: 1_000
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.completeness.missing, []);
  assert.equal(result.data.responses.length, expectedPaths.length);
});

test("a missing expected endpoint produces partial data instead of whole-call refusal", async () => {
  const view = getView("guild_revenue", "list_incentive_tasks");
  const page = new FakePage([jsonResponse(view.response_paths[0], { data: { progress: 41 } })]);
  const result = await readView({
    page,
    view,
    params: {},
    clock: () => "2026-09-20T00:00:00.000Z",
    responseWaitMs: 0
  });

  assert.equal(result.status, "partial");
  assert.ok(result.completeness.missing.length > 0);
  assert.equal(result.data.responses[0].body.data.progress, 41);
});

test("an unmapped blank live view is partial instead of a false successful read", async () => {
  const view = getView("guild_messaging", "list_conversations");
  const result = await readView({
    page: new BlankSurfacePage([]),
    view,
    params: {},
    clock: () => "2026-09-20T00:00:00.000Z",
    responseWaitMs: 0
  });

  assert.equal(result.status, "partial");
  assert.equal(result.completeness.state, "partial");
  assert.deepEqual(result.completeness.missing, ["live_read_mapping"]);
});

test("a persistent instant-message loading shell is partial, not a conversation read", async () => {
  const page = new FakePage([]);
  page.evaluate = async () => ({
    title: "Instant messages",
    path: "/portal/anchor/instant-messages",
    text: "Loading instant messages, please wait",
    tables: []
  });

  const result = await readView({
    page,
    view: getView("guild_messaging", "list_conversations"),
    responseWaitMs: 0
  });

  assert.equal(result.status, "partial");
  assert.deepEqual(result.completeness.missing, ["live_read_mapping"]);
});

test("oversized allowed responses are rejected", async () => {
  const view = getView("guild_creators", "list_creators");
  const response = jsonResponse(view.response_paths[0], { data: {} });
  response.body = async () => Buffer.alloc(1024 * 1024 + 1, 1);
  await assert.rejects(
    readView({ page: new FakePage([response]), view, params: {}, clock: () => new Date().toISOString(), responseWaitMs: 0 }),
    (error) => error.code === "adapter_mismatch"
  );
});

test("one domain failure does not poison another domain handler", async () => {
  const page = { async close() {} };
  const sessionOwner = {
    getStatus: () => ({ state: "running", visible: true }),
    ensureActive: async () => ({ pages: () => [page], newPage: async () => page })
  };
  const handlers = createHandlers({
    sessionOwner,
    guildDiscovery: async () => ({ guild_id: "103785", guild_name: "Atlantis", registered_country: "AE", portal_region: "MENA", account_role: 4, roles: [] }),
    liveReader: async ({ domain }) => {
      if (domain === "guild_governance") throw new GuildError("adapter_mismatch", "Governance changed.");
      return {
        data: { creators: [{ creator_id: "738001", diamonds: 9 }] },
        evidence: [],
        completeness: { state: "complete", missing: [] },
        pagination: null
      };
    }
  });
  const discovery = await handlers.guild_workspace({});
  const guildRef = discovery.structuredContent.data.guild_ref;
  const failed = await handlers.guild_governance({ guild_ref: guildRef, child: "list_guild_violations" });
  const succeeded = await handlers.guild_creators({ guild_ref: guildRef, child: "list_creators" });

  assert.equal(failed.structuredContent.status, "error");
  assert.equal(succeeded.structuredContent.status, "ok");
  assert.equal(succeeded.structuredContent.data.creators[0].creator_id, "738001");
});

test("parallel domain reads receive isolated pages", async () => {
  const discoveryPage = { id: "discovery" };
  const createdPages = [];
  const context = {
    pages: () => [discoveryPage],
    async newPage() {
      const page = { id: `business-${createdPages.length + 1}`, closed: false, async close() { this.closed = true; } };
      createdPages.push(page);
      return page;
    }
  };
  const handlers = createHandlers({
    sessionOwner: {
      getStatus: () => ({ state: "running", visible: true }),
      ensureActive: async () => context
    },
    guildDiscovery: async () => ({ guild_id: "103785", guild_name: "Atlantis", registered_country: "AE", portal_region: "MENA", account_role: 4, roles: [] }),
    liveReader: async ({ page }) => ({
      data: { page_id: page.id }, evidence: [],
      completeness: { state: "complete", missing: [] }, pagination: null
    })
  });
  const discovery = await handlers.guild_workspace({});
  const guildRef = discovery.structuredContent.data.guild_ref;
  const [creators, revenue] = await Promise.all([
    handlers.guild_creators({ guild_ref: guildRef, child: "list_creators" }),
    handlers.guild_revenue({ guild_ref: guildRef, child: "get_overview" })
  ]);

  assert.notEqual(creators.structuredContent.data.page_id, revenue.structuredContent.data.page_id);
  assert.deepEqual(createdPages.map(({ closed }) => closed), [true, true]);
});

test("domain reads use the session owner's current context after a mode change", async () => {
  const discoveryPage = { id: "discovery" };
  const staleContext = { pages: () => [discoveryPage] };
  const currentPage = { id: "current-business", async close() {} };
  const currentContext = { async newPage() { return currentPage; } };
  let current = staleContext;
  const sessionOwner = {
    getStatus: () => ({ state: "running", visible: false }),
    async ensureActive() { return current; },
    async minimize() { current = currentContext; return currentContext; }
  };
  const handlers = createHandlers({
    sessionOwner,
    guildDiscovery: async () => ({ guild_id: "103785", guild_name: "Atlantis", registered_country: "AE", portal_region: "MENA", account_role: 4, roles: [] }),
    liveReader: async ({ page }) => ({
      data: { page_id: page.id }, evidence: [],
      completeness: { state: "complete", missing: [] }, pagination: null
    })
  });

  const discovery = await handlers.guild_workspace({});
  const result = await handlers.guild_creators({
    guild_ref: discovery.structuredContent.data.guild_ref,
    child: "list_creators"
  });

  assert.equal(result.structuredContent.status, "ok");
  assert.equal(result.structuredContent.data.page_id, "current-business");
});

test("a business login challenge reveals and preserves its intervention page", async () => {
  const discoveryPage = { id: "discovery" };
  const businessPage = {
    id: "login-challenge",
    closed: false,
    async close() { this.closed = true; }
  };
  const windowEvents = [];
  const context = {
    pages: () => [discoveryPage],
    async newPage() { return businessPage; }
  };
  const sessionOwner = {
    getStatus: () => ({ state: "running", visible: false }),
    ensureActive: async () => context,
    async reveal(page) { windowEvents.push({ action: "reveal", page }); },
    async minimize(page) { windowEvents.push({ action: "minimize", page }); }
  };
  const handlers = createHandlers({
    sessionOwner,
    guildDiscovery: async () => ({ guild_id: "103785", guild_name: "Atlantis", registered_country: "AE", portal_region: "MENA", account_role: 4, roles: [] }),
    liveReader: async () => { throw new GuildError("login_required", "Login challenge requires intervention."); }
  });
  const discovery = await handlers.guild_workspace({});
  windowEvents.length = 0;

  const result = await handlers.guild_creators({
    guild_ref: discovery.structuredContent.data.guild_ref,
    child: "list_creators"
  });

  assert.equal(result.structuredContent.errors[0].code, "login_required");
  assert.deepEqual(windowEvents, [{ action: "reveal", page: businessPage }]);
  assert.equal(businessPage.closed, false);
});
