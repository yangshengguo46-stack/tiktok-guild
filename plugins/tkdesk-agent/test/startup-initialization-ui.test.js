import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import {
  initializeCollectionBackstage,
  prepareDiscoveryLive,
} from "../mcp/adapters/startup-initialization.js";
import { COLLECTION_BACKSTAGE_ENDPOINT } from "../mcp/adapters/collection-backstage.js";

const html = `<button onclick="document.querySelector('[role=dialog]').hidden=false">邀请主播</button>
<section role="dialog" hidden><textarea placeholder="最多可输入 30 位主播，每行一个用户名"></textarea>
<button onclick="lookup()">下一步</button><button onclick="document.querySelector('[role=dialog]').hidden=true">取消</button></section>
<script>async function lookup(){const value=document.querySelector('textarea').value;const response=await fetch('${COLLECTION_BACKSTAGE_ENDPOINT}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({DisplayIDList:[value]})});await response.json();}</script>`;

test("real DOM invitation lookup uses random letters once, cleans input, reserves once and creates no invitation", async (t) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requests = [];
  await page.route("**/*", async (route) => {
    const r = route.request(),
      path = new URL(r.url()).pathname;
    if (path === COLLECTION_BACKSTAGE_ENDPOINT) {
      requests.push(r.postDataJSON());
      await route.fulfill({
        json: {
          status_code: 0,
          data: {
            AnchorList: [
              {
                UserBaseInfo: { DisplayID: r.postDataJSON().DisplayIDList[0] },
                AnchorStatus: 1,
              },
            ],
          },
        },
      });
    } else
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: html,
      });
  });
  await page.goto("https://live-backstage.tiktok.com/portal/anchor/relation");
  let reservations = 0;
  const result = await initializeCollectionBackstage(page, {
    reserveAttempt: () => {
      reservations++;
    },
  });
  assert.equal(result.ready, true);
  assert.equal(result.invitationSent, false);
  assert.equal(requests.length, 1);
  assert.equal(reservations, 1);
  assert.match(requests[0].DisplayIDList[0], /^[a-z]{24}$/);
  assert.equal(await page.locator("textarea").inputValue(), "");
  const reused = await initializeCollectionBackstage(page, {
    reserveAttempt: () => {
      reservations++;
    },
  });
  assert.equal(reused.reused, true);
  assert.equal(requests.length, 1);
  assert.equal(reservations, 1);
});

test("real creator collision stops test initialization without completing an invitation", async (t) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("**/*", async (route) =>
    new URL(route.request().url()).pathname === COLLECTION_BACKSTAGE_ENDPOINT
      ? route.fulfill({
          json: {
            status_code: 0,
            data: {
              AnchorList: [
                {
                  UserBaseInfo: {
                    DisplayID: route.request().postDataJSON().DisplayIDList[0],
                  },
                  AnchorStatus: 0,
                },
              ],
            },
          },
        })
      : route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
  );
  await page.goto("https://live-backstage.tiktok.com/portal/anchor/relation");
  const result = await initializeCollectionBackstage(page, {
    reserveAttempt: () => {},
  });
  assert.equal(result.ready, false);
  assert.equal(result.state, "test_identity_collision");
  assert.equal(result.invitationSent, false);
});

test("quota rejection blocks the UI request before dispatch and keeps no test input", async (t) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let dispatches = 0;
  await page.route("**/*", async (route) => {
    if (
      new URL(route.request().url()).pathname === COLLECTION_BACKSTAGE_ENDPOINT
    )
      dispatches++;
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: html,
    });
  });
  await page.goto("https://live-backstage.tiktok.com/portal/anchor/relation");
  await assert.rejects(
    initializeCollectionBackstage(page, {
      reserveAttempt: () => {
        throw Object.assign(Error("quota"), {
          code: "QUALIFICATION_BUDGET_EXHAUSTED",
        });
      },
    }),
    (e) => e.code === "QUALIFICATION_BUDGET_EXHAUSTED",
  );
  assert.equal(dispatches, 0);
  assert.equal(await page.locator("textarea").inputValue(), "");
});

test("LIVE initialization moves from recommendation and keeps a real media element paused across replay", async (t) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body:
        new URL(route.request().url()).pathname === "/live"
          ? '<canvas></canvas><video muted></video><script>const video=document.querySelector("video");video.srcObject=document.querySelector("canvas").captureStream(1);video.play().catch(()=>{});</script>'
          : '<a href="/live">LIVE</a>',
    }),
  );
  await page.goto("https://www.tiktok.com/");
  const result = await prepareDiscoveryLive(page);
  assert.equal(result.ready, true);
  assert.equal(result.paused, true);
  assert.equal(result.recheckedAfterMs, 3000);
  assert.equal(new URL(page.url()).pathname, "/live");
  await page.evaluate(() =>
    document
      .querySelector("video")
      .play()
      .catch(() => {}),
  );
  assert.equal(
    await page.evaluate(() => document.querySelector("video").paused),
    true,
  );
});

test("manual verification completion removes its test input without replay and a new document requires a fresh initialization", async (t) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let dispatches = 0,
    reservations = 0;
  await page.route("**/*", async (route) => {
    if (
      new URL(route.request().url()).pathname === COLLECTION_BACKSTAGE_ENDPOINT
    ) {
      dispatches++;
      await route.fulfill({
        headers: { "bdturing-verify": "mock-challenge" },
        json: { status_code: 1 },
      });
    } else
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: html,
      });
  });
  await page.goto("https://live-backstage.tiktok.com/portal/anchor/relation");
  const reserveAttempt = () => {
    reservations++;
  };
  const first = await initializeCollectionBackstage(page, { reserveAttempt });
  assert.equal(first.requiresUserAction, true);
  assert.equal(first.ready, false);
  const stillWaiting = await initializeCollectionBackstage(page, {
    reserveAttempt,
  });
  assert.equal(stillWaiting.requiresUserAction, true);
  assert.equal(dispatches, 1);
  const confirmed = await initializeCollectionBackstage(page, {
    reserveAttempt,
    userConfirmedVerification: true,
  });
  assert.equal(confirmed.ready, true);
  assert.equal(dispatches, 1);
  assert.equal(reservations, 1);
  assert.equal(await page.locator("textarea").inputValue(), "");
  await page.reload();
  const fresh = await initializeCollectionBackstage(page, { reserveAttempt });
  assert.equal(fresh.requiresUserAction, true);
  assert.equal(dispatches, 2);
  assert.equal(reservations, 2);
});

test("unexpected invitation POST from the form is blocked before dispatch and cannot cache ready", async (t) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let invitations = 0;
  const unsafeHtml = html.replace(
    "await response.json();",
    "await response.json();await fetch('/creators/live/union_platform_api/agency/union_invite/send_invite/',{method:'POST',body:'{}'});",
  );
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === COLLECTION_BACKSTAGE_ENDPOINT)
      await route.fulfill({
        json: {
          status_code: 0,
          data: {
            AnchorList: [
              {
                UserBaseInfo: {
                  DisplayID: route.request().postDataJSON().DisplayIDList[0],
                },
                AnchorStatus: 1,
              },
            ],
          },
        },
      });
    else if (path.includes("send_invite")) {
      invitations++;
      await route.fulfill({ json: {} });
    } else
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: unsafeHtml,
      });
  });
  await page.goto("https://live-backstage.tiktok.com/portal/anchor/relation");
  await initializeCollectionBackstage(page, { reserveAttempt: () => {} });
  await page.waitForTimeout(100);
  assert.equal(invitations, 0);
  await assert.rejects(
    initializeCollectionBackstage(page, { reserveAttempt: () => {} }),
    (e) => e.code === "startup_initialization_retry_required",
  );
});

test("a PUT to the qualification endpoint is blocked without quota reservation or dispatch", async (t) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let dispatched = 0,
    reserved = 0;
  await page.route("**/*", async (route) => {
    if (
      new URL(route.request().url()).pathname === COLLECTION_BACKSTAGE_ENDPOINT
    ) {
      dispatched++;
      await route.fulfill({ json: {} });
    } else
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: html.replace("method:'POST'", "method:'PUT'"),
      });
  });
  await page.goto("https://live-backstage.tiktok.com/portal/anchor/relation");
  const result = await initializeCollectionBackstage(page, {
    reserveAttempt: () => {
      reserved++;
    },
  });
  assert.equal(result.ready, false);
  assert.equal(result.state, "unexpected_invitation_request_blocked");
  assert.equal(dispatched, 0);
  assert.equal(reserved, 0);
});

test("an existing dedicated creator LIVE page is paused in place without navigating", async (t) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<canvas></canvas><video muted></video><script>const v=document.querySelector("video");v.srcObject=document.querySelector("canvas").captureStream(1);v.play().catch(()=>{});</script>',
    }),
  );
  await page.goto("https://www.tiktok.com/@creator/live", {
    waitUntil: "domcontentloaded",
  });
  const result = await prepareDiscoveryLive(page);
  assert.equal(result.ready, true);
  assert.equal(result.existingCreatorMedia, true);
  assert.equal(result.mediaTimeStable, true);
  assert.equal(page.url(), "https://www.tiktok.com/@creator/live");
});

test("initialization waits for the delayed official Next button before querying once", async (t) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let dispatches = 0;
  const delayed =
    html.replace(
      '<button onclick="lookup()">下一步</button>',
      '<span id="next"></span>',
    ) +
    '<script>setTimeout(()=>{document.querySelector("#next").innerHTML=\'<button onclick="lookup()">下一步</button>\';},500);</script>';
  await page.route("**/*", async (route) => {
    if (
      new URL(route.request().url()).pathname === COLLECTION_BACKSTAGE_ENDPOINT
    ) {
      dispatches++;
      await route.fulfill({
        json: {
          status_code: 0,
          data: {
            AnchorList: [
              {
                UserBaseInfo: {
                  DisplayID: route.request().postDataJSON().DisplayIDList[0],
                },
                AnchorStatus: 1,
              },
            ],
          },
        },
      });
    } else
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: delayed,
      });
  });
  await page.goto("https://live-backstage.tiktok.com/portal/anchor/relation");
  const result = await initializeCollectionBackstage(page, {
    reserveAttempt: () => {},
  });
  assert.equal(result.ready, true);
  assert.equal(dispatches, 1);
});
