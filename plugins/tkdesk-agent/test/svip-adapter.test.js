import assert from "node:assert/strict";
import test from "node:test";
import {
  SvipLegacyError,
  buildLegacyListPayload,
  collectSvipLegacy,
  collectSvipLegacyAnchors,
  fetchSvipLegacyPage,
  inspectSvipLegacySession,
  isSvipAnchorListUrl,
  isSvipLegacyLoginUrl,
  mapLegacyAnchor
} from "../mcp/adapters/svip-legacy.js";

function jsonResponse(envelope, status = 200, url = "https://svip.tiktokzb.com/list") {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    url,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? "application/json" : null },
    text: async () => JSON.stringify(envelope)
  };
}

class MockPage {
  constructor({ url = "https://svip.tiktokzb.com/index.html#/anchorList/index", responses = [], domResult = null } = {}) {
    this.currentUrl = url;
    this.responses = [...responses];
    this.domResult = domResult;
    this.fetchCalls = [];
  }

  url() {
    return this.currentUrl;
  }

  async evaluate(callback, argument) {
    if (!argument?.body) return this.domResult;
    const response = this.responses.shift();
    if (!response) throw new Error("MockPage ran out of fetch responses");
    const previous = {
      fetch: globalThis.fetch,
      location: globalThis.location,
      window: globalThis.window
    };
    const page = this;
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: new URL(this.currentUrl) });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
    });
    globalThis.fetch = async (url, options) => {
      page.fetchCalls.push({ url, options });
      if (response instanceof Error) throw response;
      return response;
    };
    try {
      return await callback(argument);
    } finally {
      globalThis.fetch = previous.fetch;
      if (previous.location === undefined) delete globalThis.location;
      else Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: previous.location });
      if (previous.window === undefined) delete globalThis.window;
      else Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: previous.window });
    }
  }
}

function legacyRow(id, overrides = {}) {
  return {
    id,
    name: `Creator ${id}`,
    zb_bj: 0,
    zb_name: `Creator.${id}`,
    zb_yqType: 10,
    zb_Level: "12",
    zb_liveTag: 7,
    zb_create_time: 83,
    region: "US",
    regioncode: "US",
    zb_Ranking: "B2",
    zb_top: 4,
    zbj_renshu: "1,234",
    zb_zuanshi: "567",
    zb_zhoubang: "890",
    zb_pm: "321",
    zb_bak: "999",
    zb_fan: "12.4K",
    up_date: "2026-08-22 10:00:00",
    yg_name: "",
    zb_strid: `uid-${id}`,
    sec_uid: `sec-${id}`,
    ...overrides
  };
}

test("restores the exact /list page/limit payload pruning used by the legacy frontend", () => {
  const payload = buildLegacyListPayload({
    region: "US",
    zb_name: "alice",
    yg_name: "",
    zb_top: "all",
    zb_liveTag: [],
    zb_yqType: ["3", "4"],
    zb_bj: [],
    zb_fan: [{ min: "1,000", max: "20,000" }],
    zb_Level: [{ min: "", max: "" }],
    unused: ""
  }, { page: 3, limit: 50 });

  assert.deepEqual(payload, {
    zb_name: "alice",
    yg_name: "",
    zb_yqType: ["3", "4"],
    zb_fan: [{ min: "1,000", max: "20,000" }],
    page: 3,
    limit: 50,
    region: "US"
  });
});

test("runs POST /list inside the logged-in page without reading or exporting credentials", async () => {
  const page = new MockPage({
    responses: [jsonResponse({ status: "0", data: [legacyRow(1)], count: "1", listArray: [30, 50] })]
  });
  const result = await fetchSvipLegacyPage(page, { region: "US", zb_name: "alice" }, { page: 2, limit: 50 });

  assert.equal(result.total, 1);
  assert.equal(result.rows[0].zb_name, "Creator.1");
  assert.deepEqual(result.listArray, [30, 50]);
  assert.equal(page.fetchCalls.length, 1);
  assert.equal(page.fetchCalls[0].url, "/list");
  assert.equal(page.fetchCalls[0].options.credentials, "include");
  assert.equal(page.fetchCalls[0].options.method, "POST");
  assert.equal(page.fetchCalls[0].options.headers.Authorization, undefined);
  assert.equal(page.fetchCalls[0].options.headers.Cookie, undefined);
  assert.deepEqual(JSON.parse(page.fetchCalls[0].options.body), {
    zb_name: "alice",
    page: 2,
    limit: 50,
    region: "US"
  });
});

test("paginates, maps all legacy fields, emits batches/progress, and reconciles count", async () => {
  const page = new MockPage({
    responses: [
      jsonResponse({ status: 0, data: [legacyRow(1), legacyRow(2)], count: 3, listArray: [2, 30] }),
      jsonResponse({ status: 0, data: [legacyRow(3, { zb_yqType: 3, zb_bj: 2 })], count: 3, listArray: [2, 30] })
    ]
  });
  const progress = [];
  const batches = [];
  const result = await collectSvipLegacy({
    page,
    filters: { region: "US" },
    pageSize: 2,
    maxPages: 5,
    maxCandidates: 10,
    onProgress: (event) => progress.push(event),
    onBatch: (batch) => batches.push(batch)
  });

  assert.equal(result.complete, true);
  assert.equal(result.reason, "completed");
  assert.equal(result.items.length, 3);
  assert.equal(result.candidates, result.items);
  assert.equal(result.reconciliation.matched, true);
  assert.equal(result.reconciliation.sourceRowsFetched, 3);
  assert.equal(result.checkpoint.nextPage, null);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].checkpoint.nextPage, 2);
  assert.ok(progress.some((event) => event.phase === "page_collected" && event.page === 2));

  const creator = result.items[2];
  assert.equal(creator.schemaVersion, "tkdesk.candidate-observation.v2");
  assert.equal(creator.candidateKey, "tiktok:user:uid-3");
  assert.equal(creator.handle, "@creator.3");
  assert.equal(creator.profileUrl, "https://www.tiktok.com/@creator.3");
  assert.equal(creator.followers, 12_400);
  assert.equal(creator.viewerCount, 1_234);
  assert.equal(creator.qualification.status, "regular_invitation");
  assert.equal(creator.qualification.eligible, true);
  assert.equal(creator.outreach.connectionStatus, "automatic_connected");
  assert.equal(creator.legacy.sec_uid, "sec-3");
  assert.equal(creator.evidence.completeLegacyFields, true, "an empty but present yg_name means unassigned, not missing");
});

test("supports cooperative cancellation without requesting another page", async () => {
  const page = new MockPage({
    responses: [
      jsonResponse({ status: 0, data: [legacyRow(1), legacyRow(2)], count: 4 }),
      jsonResponse({ status: 0, data: [legacyRow(3), legacyRow(4)], count: 4 })
    ]
  });
  const result = await collectSvipLegacyAnchors(page, {
    filters: { region: "US" },
    pageSize: 2,
    shouldCancel: ({ page }) => page > 1
  });

  assert.equal(result.complete, false);
  assert.equal(result.reason, "cancelled");
  assert.equal(result.items.length, 2);
  assert.equal(page.fetchCalls.length, 1);
  assert.equal(result.reconciliation.matched, false);
});

test("returns the exact candidate limit and seals a terminal selection checkpoint", async () => {
  const page = new MockPage({
    responses: [
      jsonResponse({ status: 0, data: [legacyRow(1), legacyRow(2)], count: 4 }),
      jsonResponse({ status: 0, data: [legacyRow(3), legacyRow(4)], count: 4 })
    ]
  });
  const selected = await collectSvipLegacy({ page, pageSize: 2, maxCandidates: 3 });

  assert.equal(selected.reason, "max_items_reached");
  assert.equal(selected.complete, false, "the source still has an unselected row");
  assert.equal(selected.selectionComplete, true);
  assert.equal(selected.items.length, 3);
  assert.equal(selected.reconciliation.sourceRowsFetched, 4);
  assert.equal(selected.reconciliation.returnedItems, 3);
  assert.equal(selected.checkpoint.nextPage, null);
  assert.equal(selected.checkpoint.selectionComplete, true);
});

test("resumes a max-pages partial run from the next whole source page", async () => {
  const firstPage = new MockPage({
    responses: [jsonResponse({ status: 0, data: [legacyRow(1), legacyRow(2)], count: 4 })]
  });
  const partial = await collectSvipLegacy({ page: firstPage, pageSize: 2, maxPages: 1, maxCandidates: 10 });
  assert.equal(partial.reason, "max_pages_reached");
  assert.equal(partial.items.length, 2);
  assert.equal(partial.checkpoint.nextPage, 2);

  const secondPage = new MockPage({
    responses: [jsonResponse({ status: 0, data: [legacyRow(3), legacyRow(4)], count: 4 })]
  });
  const resumed = await collectSvipLegacy({ page: secondPage, checkpoint: partial.checkpoint, maxCandidates: 10 });
  assert.equal(JSON.parse(secondPage.fetchCalls[0].options.body).page, 2);
  assert.equal(JSON.parse(secondPage.fetchCalls[0].options.body).limit, 2);
  assert.equal(resumed.complete, true);
  assert.equal(resumed.reconciliation.sourceRowsFetched, 4);
  assert.equal(resumed.reconciliation.matched, true);
  assert.equal(resumed.checkpoint.nextPage, null);
});

test("a default request for 50 candidates asks for and returns exactly 50", async () => {
  const rows = Array.from({ length: 50 }, (_, index) => legacyRow(index + 1));
  const page = new MockPage({ responses: [jsonResponse({ status: 0, data: rows, count: 60 })] });
  const result = await collectSvipLegacy({ page, maxCandidates: 50 });

  assert.equal(JSON.parse(page.fetchCalls[0].options.body).limit, 50);
  assert.equal(result.items.length, 50);
  assert.equal(result.selectionComplete, true);
  assert.equal(result.complete, false);
  assert.equal(result.checkpoint.nextPage, null);
});

test("returns an explicit reason when a valid query has zero results", async () => {
  const page = new MockPage({ responses: [jsonResponse({ status: 0, data: [], count: 0 })] });
  const result = await collectSvipLegacyAnchors(page, { filters: { zb_name: "does-not-exist" } });

  assert.equal(result.complete, true);
  assert.equal(result.reason, "no_results_for_filters");
  assert.equal(result.items.length, 0);
  assert.equal(result.reconciliation.matched, true);
});

test("reports HTTP 401 as an expired login and never converts it into an empty result", async () => {
  const page = new MockPage({ responses: [jsonResponse({ status: 401, msg: "未登录" }, 401)] });
  await assert.rejects(
    collectSvipLegacyAnchors(page),
    (error) => error instanceof SvipLegacyError && error.code === "SVIP_LOGIN_EXPIRED"
  );
});

test("redacts query, hash, access_token, and code from a cross-origin redirect error", async () => {
  const page = new MockPage({
    responses: [jsonResponse(
      { status: 0, data: [], count: 0 },
      200,
      "https://identity.example/oauth/callback?access_token=token-secret&code=code-secret#id_token=hash-secret"
    )]
  });

  await assert.rejects(
    fetchSvipLegacyPage(page),
    (error) => {
      assert.ok(error instanceof SvipLegacyError);
      assert.equal(error.code, "SVIP_CROSS_ORIGIN_REDIRECT");
      assert.deepEqual(error.details, {
        finalUrl: "https://identity.example/oauth/callback",
        page: 1
      });
      const exposed = JSON.stringify({ message: error.message, details: error.details, cause: error.cause?.message });
      assert.doesNotMatch(exposed, /token-secret|code-secret|hash-secret|access_token|id_token|[?#]/i);
      return true;
    }
  );
});

test("fails loudly when a successful response no longer matches the legacy schema", async () => {
  const page = new MockPage({ responses: [jsonResponse({ status: 0, data: { items: [] }, count: 0 })] });
  await assert.rejects(
    collectSvipLegacyAnchors(page),
    (error) => error instanceof SvipLegacyError && error.code === "SVIP_STRUCTURE_MISMATCH"
  );
});

test("uses the Element UI table only as a marked, lossy fallback for API outages", async () => {
  const page = new MockPage({
    responses: [jsonResponse({ status: 502, msg: "网关错误" }, 502)],
    domResult: {
      found: true,
      headers: ["", "建联状态", "主播ID", "关注", "主播状态", "主播等级", "直播标签", "开播时长", "地区", "国家代码", "段位排名", "主播来源", "直播间人数", "当前钻石", "日榜钻石", "历史最高钻石", "当前粉丝", "记录时间", "分配状态"],
      rows: [["", "手动建联", "Alice", "关注", "常规邀约", "8", "游戏", "1小时2分钟", "US", "US", "A2", "上榜主播", "88", "120", "300", "600", "10K", "2026-08-22", "未分配"]],
      total: 1,
      currentPage: 1
    }
  });
  const result = await collectSvipLegacyAnchors(page, { allowDomFallback: true });

  assert.equal(result.sourceMode, "element_ui_dom_fallback");
  assert.equal(result.complete, true);
  assert.equal(result.items[0].handle, "@alice");
  assert.equal(result.items[0].live.durationMinutes, 62);
  assert.equal(result.items[0].qualification.status, "regular_invitation");
  assert.equal(result.items[0].evidence.confidence, 0.55);
  assert.ok(result.items[0].evidence.missingFields.includes("sec_uid"));
  assert.equal(result.warnings[0].causeCode, "SVIP_HTTP_ERROR");
});

test("recognizes both hash routes and refuses a login route before any request", async () => {
  assert.equal(isSvipLegacyLoginUrl("https://svip.tiktokzb.com/index.html#/login"), true);
  assert.equal(isSvipAnchorListUrl("https://svip.tiktokzb.com/index.html#/anchorList/index"), true);
  assert.equal(isSvipAnchorListUrl("https://svip.tiktokzb.com/index.html#/anchorListyg/index"), true);

  const page = new MockPage({
    url: "https://svip.tiktokzb.com/index.html?access_token=page-secret#/login?code=route-secret"
  });
  await assert.rejects(
    fetchSvipLegacyPage(page),
    (error) => {
      assert.ok(error instanceof SvipLegacyError);
      assert.equal(error.code, "SVIP_AUTH_REQUIRED");
      assert.deepEqual(error.details, { url: "https://svip.tiktokzb.com/index.html" });
      assert.doesNotMatch(JSON.stringify(error.details), /page-secret|route-secret|access_token|[?#]/i);
      return true;
    }
  );
  assert.equal(page.fetchCalls.length, 0);
});

test("redacts navigation secrets from session and row outputs", async () => {
  const page = new MockPage({
    url: "https://svip.tiktokzb.com/index.html?access_token=session-secret#/anchorList/index?code=route-secret",
    domResult: { password: false, loginContainer: false, anchorTable: true, title: "主播名单" },
    responses: [jsonResponse({
      status: 0,
      data: [legacyRow(7, {
        oauth_redirect_url: "https://identity.example/callback?access_token=row-secret&code=row-code#token=hash-secret"
      })],
      count: 1
    })]
  });

  const session = await inspectSvipLegacySession(page);
  assert.equal(session.authenticated, true);
  assert.equal(session.route, "anchor_list");
  assert.equal(session.url, "https://svip.tiktokzb.com/index.html");

  const result = await fetchSvipLegacyPage(page);
  assert.equal(result.rows[0].oauth_redirect_url, "https://identity.example/callback");
  assert.doesNotMatch(
    JSON.stringify({ session, result }),
    /session-secret|route-secret|row-secret|row-code|hash-secret|access_token|[?#]/i
  );
});

test("preserves unknown legacy fields while keeping unknown metrics null", () => {
  const item = mapLegacyAnchor({ zb_name: "@Mystery", zb_yqType: 10, vendor_new_field: "kept" }, { page: 4, rowIndex: 2 });
  assert.equal(item.followers, null);
  assert.equal(item.qualification.known, false);
  assert.equal(item.qualification.eligible, null);
  assert.equal(item.legacy.extra.vendor_new_field, "kept");
  assert.equal(item.candidateKey, "tiktok:handle:mystery:");
});
