import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectStartupInitialization,
  openBackstageInitialization,
  prepareDiscoveryLive,
} from "../mcp/adapters/startup-initialization.js";
import { DatabaseStore } from "../mcp/core/database.js";
import { SessionManager } from "../mcp/core/session-manager.js";

test("initialization inspection rejects the wrong profile destination before reading DOM", async () => {
  let reads = 0;
  for (const [target, url] of [
    ["collection_backstage", "https://www.tiktok.com/"],
    [
      "collection_backstage",
      "https://live-backstage.tiktok.com/portal/creator/im",
    ],
    ["tiktok_discovery", "https://www.tiktok.com.evil.example/live"],
    ["unknown", "https://www.tiktok.com/live"],
  ]) {
    await assert.rejects(
      inspectStartupInitialization(
        {
          url: () => url,
          evaluate: async () => {
            reads++;
          },
        },
        target,
      ),
    );
  }
  assert.equal(reads, 0);
});

test("startup media control is confined to the authenticated discovery profile and public task pages", () => {
  const manager = new SessionManager({
    dataDirectory: "/tmp/tkdesk-startup-unit-no-browser",
  });
  const pages = [
    "https://www.tiktok.com/",
    "https://www.tiktok.com/live",
    "https://www.tiktok.com/@creator/live",
    "https://www.tiktok.com/@creator/video/123",
    "https://www.tiktok.com/login",
    "https://live-backstage.tiktok.com/portal/anchor/relation",
    "https://evil.example/",
  ].map((url) => ({ url: () => url, isClosed: () => false }));
  manager.sessions.set("tiktok_discovery", {
    authenticated: true,
    context: { pages: () => pages },
  });
  assert.deepEqual(manager.startupPages("tiktok_discovery"), pages.slice(0, 4));
  manager.sessions.get("tiktok_discovery").authenticated = false;
  assert.throws(() => manager.startupPages("tiktok_discovery"));
});

test("startup lookup consumes the same durable quota without adding fake prospects", () => {
  const db = new DatabaseStore(":memory:", {
    clock: () => new Date("2026-09-26T10:00:00Z"),
  }).init();
  try {
    const before = db.getQualificationUsage();
    const attempt = db.reserveStartupQualificationAttempt({
      requestId: "startup-test",
      routeProfileId: "route",
      minimumSpacingSeconds: 75,
    });
    assert.equal(db.getQualificationUsage().dailyUsed, before.dailyUsed + 1);
    assert.equal(db.getQualificationUsage().allowed, false);
    const again = db.reserveStartupQualificationAttempt({
      requestId: "startup-test",
      routeProfileId: "route",
      minimumSpacingSeconds: 75,
    });
    assert.equal(again.auditId, attempt.auditId);
    assert.equal(db.getQualificationUsage().dailyUsed, 1);
    assert.throws(
      () =>
        db.reserveStartupQualificationAttempt({
          requestId: "other",
          routeProfileId: "route",
          minimumSpacingSeconds: 75,
        }),
      (e) => e.code === "QUALIFICATION_BUDGET_EXHAUSTED",
    );
    assert.equal(db.queryProspects({ limit: 10 }).length, 0);
  } finally {
    db.close();
  }
});

test("LIVE pause refuses off-site and login pages before any click or media change", async () => {
  for (const url of [
    "https://www.tiktok.com/login",
    "https://www.tiktok.com.evil.example/live",
  ]) {
    let touched = false;
    await assert.rejects(
      prepareDiscoveryLive({
        url: () => url,
        evaluate: async () => {
          touched = true;
        },
      }),
    );
    assert.equal(touched, false);
  }
});

test("backstage form preparation never submits a query or a real invitation", async () => {
  const calls = [];
  const page = {
    url: () => "https://live-backstage.tiktok.com/portal/anchor/relation",
    getByPlaceholder: () => ({ count: async () => 0, waitFor: async () => {} }),
    getByRole: () => ({
      count: async () => 1,
      click: async () => calls.push("open-dialog"),
    }),
    waitForTimeout: async () => {},
    evaluate: async () => ({
      buttons: ["邀请"],
      inputs: [{ tag: "INPUT", placeholder: "输入用户名" }],
      videos: [],
    }),
  };
  const result = await openBackstageInitialization(page);
  assert.equal(result.state, "form_ready");
  assert.equal(result.invitationSent, false);
  assert.equal(result.lookupSubmitted, false);
  assert.deepEqual(calls, ["open-dialog"]);
});

test("inspection carries only fixed target metadata and never submits or navigates", async () => {
  const calls = [];
  const page = {
    url: () =>
      "https://live-backstage.tiktok.com/portal/anchor/relation?private=SECRET",
    evaluate: async (fn, arg) => {
      calls.push(arg);
      return { buttons: ["邀请主播"], inputs: [], videos: [] };
    },
  };
  const result = await inspectStartupInitialization(
    page,
    "collection_backstage",
  );
  assert.equal(calls.length, 1);
  assert.equal(result.target, "collection_backstage");
  assert.equal(
    result.url,
    "https://live-backstage.tiktok.com/portal/anchor/relation",
  );
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});
