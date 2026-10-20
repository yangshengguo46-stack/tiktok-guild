import { randomInt, randomUUID } from "node:crypto";
import { COLLECTION_BACKSTAGE_ENDPOINT } from "./collection-backstage.js";

const initializationState = new WeakMap();
const TARGET_URLS = Object.freeze({
  collection_backstage:
    /^https:\/\/live-backstage\.tiktok\.com\/portal\/anchor\/relation\/?$/,
  tiktok_discovery:
    /^https:\/\/www\.tiktok\.com\/(?:(?:foryou|live)\/?|@[^/]+\/(?:live\/?|video\/\d+\/?))?$/,
});

export function requireStartupPage(page, target) {
  let url;
  try {
    url = new URL(page.url());
  } catch {
    throw Object.assign(new Error("初始化页面未就绪"), {
      code: "startup_page_unavailable",
    });
  }
  const destination = url.origin + url.pathname;
  if (!TARGET_URLS[target]?.test(destination))
    throw Object.assign(new Error("初始化仅允许对应会话的官方页面"), {
      code: "startup_navigation_blocked",
    });
  return destination;
}

export async function inspectStartupInitialization(page, target) {
  const url = requireStartupPage(page, target);
  const controls = await page.evaluate(() => {
    const visible = (element) => {
      const r = element.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.height > 0 &&
        getComputedStyle(element).visibility !== "hidden"
      );
    };
    const label = (element) =>
      (element.getAttribute("aria-label") || element.textContent || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 120);
    const relevant =
      /inv|邀请|play|pause|播放|暂停|live|直播|cancel|取消|close|关闭|search|搜索|confirm|确认|verify|验证/i;
    return {
      buttons: [...document.querySelectorAll('button,[role="button"]')]
        .filter(visible)
        .map(label)
        .filter((name) => relevant.test(name))
        .slice(0, 30),
      inputs: [
        ...document.querySelectorAll('input:not([type="password"]),textarea'),
      ]
        .filter(visible)
        .map((e) => ({
          tag: e.tagName,
          type: e.type || null,
          placeholder: e.getAttribute("placeholder"),
          ariaLabel: e.getAttribute("aria-label"),
          maxlength: e.getAttribute("maxlength"),
        }))
        .slice(0, 12),
      links: [...document.querySelectorAll("a[href]")]
        .filter(visible)
        .filter((e) => /live|直播|for you|推荐/i.test(label(e)))
        .map((e) => {
          let href = null;
          try {
            const u = new URL(e.href);
            if (u.origin === "https://www.tiktok.com")
              href = u.origin + u.pathname;
          } catch {}
          return { label: label(e), href };
        })
        .slice(0, 12),
      videos: [...document.querySelectorAll("video")]
        .map((e) => ({
          paused: e.paused,
          muted: e.muted,
          readyState: e.readyState,
        }))
        .slice(0, 12),
      playerControls: [...document.querySelectorAll("[data-e2e]")]
        .filter(visible)
        .filter((e) => /play|pause|video/i.test(e.getAttribute("data-e2e")))
        .map((e) => ({
          tag: e.tagName,
          id: e.getAttribute("data-e2e"),
          label: label(e),
        }))
        .slice(0, 15),
      dialogCount: [...document.querySelectorAll('[role="dialog"]')].filter(
        visible,
      ).length,
      dialogButtons: [
        ...document.querySelectorAll(
          '[role="dialog"] button,[role="dialog"] [role="button"]',
        ),
      ]
        .filter(visible)
        .map(label)
        .slice(0, 10),
    };
  });
  return {
    target,
    url,
    controls,
    inspectionOnly: true,
    platformWritePerformed: false,
  };
}

export async function openBackstageInitialization(page) {
  requireStartupPage(page, "collection_backstage");
  const textarea = page.getByPlaceholder(
    "最多可输入 30 位主播，每行一个用户名",
    { exact: true },
  );
  if ((await textarea.count()) === 1 && (await textarea.isVisible()))
    return {
      ...(await inspectStartupInitialization(page, "collection_backstage")),
      state: "form_ready",
      ready: false,
      lookupSubmitted: false,
      invitationSent: false,
    };
  const opener = page.getByRole("button", {
    name: /^(邀请主播|Invite creators?|Invite creator)$/i,
  });
  if ((await opener.count()) !== 1)
    throw Object.assign(new Error("未找到唯一的邀请查询入口"), {
      code: "startup_invite_control_unavailable",
    });
  await opener.click();
  await textarea.waitFor({ state: "visible", timeout: 15000 });
  const inspection = await inspectStartupInitialization(
    page,
    "collection_backstage",
  );
  return {
    ...inspection,
    state: "form_ready",
    ready: false,
    lookupSubmitted: false,
    invitationSent: false,
  };
}

const pauseGuard = () => {
  if (
    location.hostname !== "www.tiktok.com" ||
    !/^\/(?:(?:foryou|live)\/?|@[^/]+\/(?:live\/?|video\/\d+\/?))?$/.test(
      location.pathname,
    )
  )
    return;
  const key = Symbol.for("tkdesk.discovery.pause-playback.v1");
  if (!window[key]) {
    const pause = (e) => {
      if (e.target instanceof HTMLMediaElement && !e.target.paused)
        e.target.pause();
    };
    document.addEventListener("play", pause, true);
    window[key] = { installed: true };
  }
  for (const video of document.querySelectorAll("video")) {
    if (!video.paused) video.pause();
  }
};

export async function pauseDiscoveryPlayback(page) {
  requireStartupPage(page, "tiktok_discovery");
  await page.addInitScript(pauseGuard);
  await page.evaluate(pauseGuard);
}

export async function prepareDiscoveryLive(page) {
  await pauseDiscoveryPlayback(page);
  const existingCreatorMedia = /^\/@[^/]+\/(?:live\/?|video\/\d+\/?)$/.test(
    new URL(page.url()).pathname,
  );
  if (
    !existingCreatorMedia &&
    !/^\/live\/?$/.test(new URL(page.url()).pathname)
  ) {
    const liveLink = page.locator(
      'a[href="/live"],a[href="https://www.tiktok.com/live"]',
    );
    await liveLink.first().waitFor({ state: "visible", timeout: 15000 });
    if ((await liveLink.count()) !== 1)
      throw Object.assign(new Error("直播导航入口不唯一"), {
        code: "startup_live_control_unavailable",
      });
    await liveLink.click();
    await page.waitForURL(
      (url) =>
        url.origin === "https://www.tiktok.com" &&
        /^\/live\/?$/.test(url.pathname),
      { timeout: 15000, waitUntil: "domcontentloaded" },
    );
  }
  await page
    .locator("video")
    .first()
    .waitFor({ state: "attached", timeout: 15000 });
  await page.evaluate(pauseGuard);
  const before = await page.evaluate(() =>
    [...document.querySelectorAll("video")].map((v) => ({
      paused: v.paused,
      currentTime: v.currentTime,
    })),
  );
  await page.waitForTimeout(3000);
  requireStartupPage(page, "tiktok_discovery");
  const after = await page.evaluate(() =>
    [...document.querySelectorAll("video")].map((v) => ({
      paused: v.paused,
      currentTime: v.currentTime,
    })),
  );
  const paused = after.length > 0 && after.every((v) => v.paused);
  const mediaTimeStable =
    before.length === after.length &&
    before.every(
      (v, i) => Math.abs(v.currentTime - after[i].currentTime) < 0.25,
    );
  const ready = paused && mediaTimeStable;
  return {
    target: "tiktok_discovery",
    state: ready ? "ready" : "playback_pause_failed",
    ready,
    url: requireStartupPage(page, "tiktok_discovery"),
    paused,
    mediaCount: after.length,
    recheckedAfterMs: 3000,
    mediaTimeStable,
    networkTrafficGuaranteedZero: false,
    existingCreatorMedia,
  };
}

function randomTestHandle() {
  return (
    "tkdeskinit" +
    Array.from({ length: 14 }, () =>
      String.fromCharCode(97 + randomInt(26)),
    ).join("")
  );
}
function startupFailure(code, message) {
  return Object.assign(new Error(message), { code });
}
const guardPattern =
  "**/creators/live/union_platform_api/agency/union_invite/**";

export async function initializeCollectionBackstage(
  page,
  { reserveAttempt, userConfirmedVerification = false } = {},
) {
  requireStartupPage(page, "collection_backstage");
  if (typeof reserveAttempt !== "function")
    throw startupFailure(
      "startup_budget_owner_missing",
      "初始化查询需要持久额度记录",
    );
  let previous = initializationState.get(page);
  if (
    previous &&
    (await page.evaluate(
      (token) =>
        window[Symbol.for("tkdesk.collection.startup.document")] === token,
      previous.documentToken,
    )) !== true
  ) {
    await previous.cleanup({ dispose: true }).catch(() => {});
    initializationState.delete(page);
    previous = null;
  }
  if (previous) {
    if (
      previous.state === "awaiting_manual_verification" &&
      !userConfirmedVerification
    )
      return {
        state: previous.state,
        ready: false,
        requiresUserAction: true,
        lookupSubmitted: true,
        invitationSent: false,
        requestId: previous.requestId,
      };
    if (previous.state === "ready")
      return {
        state: "ready",
        ready: true,
        reused: true,
        lookupSubmitted: true,
        invitationSent: false,
        requestId: previous.requestId,
      };
    if (
      previous.state === "awaiting_manual_verification" &&
      userConfirmedVerification
    ) {
      await previous.cleanup();
      previous.state = previous.blockedMutation
        ? "unexpected_invitation_request_blocked"
        : "ready";
      return {
        state: previous.state,
        ready: previous.state === "ready",
        userConfirmedVerification: true,
        lookupSubmitted: true,
        invitationSent: false,
        requestId: previous.requestId,
      };
    }
    throw startupFailure(
      "startup_initialization_retry_required",
      "上次初始化未完成；不自动重发测试查询",
    );
  }
  await openBackstageInitialization(page);
  const dialog = page.getByRole("dialog");
  if ((await dialog.count()) !== 1)
    throw startupFailure("startup_invite_form_ambiguous", "邀请查询弹窗不唯一");
  const field = dialog.getByPlaceholder(
    "最多可输入 30 位主播，每行一个用户名",
    { exact: true },
  );
  const buttons = dialog.getByRole("button", {
    name: /^(下一步|Next|邀请主播|Invite creators?)$/i,
  });
  await buttons.first().waitFor({ state: "visible", timeout: 15000 });
  if ((await buttons.count()) !== 1)
    throw startupFailure(
      "startup_lookup_control_unavailable",
      "未找到唯一的查询按钮",
    );
  const existing = await field.inputValue();
  if (existing.trim())
    throw startupFailure(
      "startup_existing_input",
      "邀请框已有输入，初始化不会覆盖",
    );
  const testHandle = randomTestHandle(),
    requestId = randomUUID();
  const documentToken = randomUUID();
  await page.evaluate((token) => {
    window[Symbol.for("tkdesk.collection.startup.document")] = token;
  }, documentToken);
  const state = {
    state: "submitting",
    requestId,
    documentToken,
    submitted: false,
    blockedMutation: false,
    collision: false,
  };
  let responseResolve;
  const responsePromise = new Promise((resolve) => {
    responseResolve = resolve;
  });
  const responseListener = async (response) => {
    const u = new URL(response.url());
    if (
      u.origin !== "https://live-backstage.tiktok.com" ||
      u.pathname !== COLLECTION_BACKSTAGE_ENDPOINT ||
      response.request().method() !== "POST"
    )
      return;
    try {
      if (response.request().postDataJSON()?.DisplayIDList?.[0] !== testHandle)
        return;
    } catch {
      return;
    }
    let result = {
      state: "lookup_response_unrecognized",
      httpStatus: response.status(),
    };
    try {
      const verify = Boolean(await response.headerValue("bdturing-verify"));
      if (verify)
        result = {
          state: "awaiting_manual_verification",
          verificationPresented: null,
        };
      else {
        const body = await response.body();
        if (body.length > 1024 * 1024) throw Error("oversize");
        const envelope = JSON.parse(body.toString("utf8"));
        const rows = envelope?.data?.AnchorList;
        const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
        const matched =
          String(row?.UserBaseInfo?.DisplayID ?? "").toLowerCase() ===
          testHandle;
        if (
          Number(envelope.status_code ?? envelope.statusCode) === 0 &&
          matched
        ) {
          const notFound = Number(row.AnchorStatus) === 1;
          result = {
            state: notFound ? "ready" : "test_identity_collision",
            testIdentityFound: !notFound,
          };
        } else if (envelope?.data?.block_data?.type === "verify")
          result = {
            state: "awaiting_manual_verification",
            verificationPresented: null,
          };
      }
    } catch {}
    responseResolve(result);
  };
  const handler = async (route) => {
    const request = route.request(),
      u = new URL(request.url());
    if (u.origin !== "https://live-backstage.tiktok.com") {
      await route.abort();
      return;
    }
    if (request.method() === "GET") {
      await route.fallback();
      return;
    }
    if (
      request.method() !== "POST" ||
      u.pathname !== COLLECTION_BACKSTAGE_ENDPOINT
    ) {
      state.blockedMutation = true;
      state.state = "unexpected_invitation_request_blocked";
      responseResolve({ state: state.state });
      await route.abort();
      return;
    }
    let payload;
    try {
      payload = request.postDataJSON();
    } catch {}
    if (state.finished) {
      if (
        Array.isArray(payload?.DisplayIDList) &&
        !payload.DisplayIDList.includes(testHandle)
      )
        await route.fallback();
      else await route.abort();
      return;
    }
    if (
      state.submitted ||
      !Array.isArray(payload?.DisplayIDList) ||
      payload.DisplayIDList.length !== 1 ||
      payload.DisplayIDList[0] !== testHandle
    ) {
      await route.abort();
      return;
    }
    try {
      reserveAttempt({ requestId });
    } catch (error) {
      state.reservationError = error;
      responseResolve({ state: "waiting_quota" });
      await route.abort();
      return;
    }
    state.submitted = true;
    await route.fallback();
  };
  state.cleanup = async ({ dispose = false } = {}) => {
    state.finished = true;
    if (dispose) await page.unroute(guardPattern, handler);
    page.off("response", responseListener);
    if (dispose) return;
    if ((await field.count()) === 1 && (await field.isVisible()))
      await field.fill("");
    const cancel = dialog.getByRole("button", { name: /^(取消|Cancel)$/i });
    if ((await cancel.count()) === 1 && (await cancel.isVisible()))
      await cancel.click();
  };
  initializationState.set(page, state);
  await page.route(guardPattern, handler);
  page.on("response", responseListener);
  let timer;
  try {
    await field.fill(testHandle);
    await buttons.click();
    const result = await Promise.race([
      responsePromise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ state: "lookup_timeout" }), 20000);
      }),
    ]);
    state.state = result.state;
    if (state.reservationError) throw state.reservationError;
    if (state.state === "awaiting_manual_verification") {
      await page.bringToFront();
      return {
        state: state.state,
        ready: false,
        requiresUserAction: true,
        lookupSubmitted: state.submitted,
        requestId,
        invitationSent: false,
      };
    }
    await state.cleanup();
    if (state.blockedMutation)
      state.state = "unexpected_invitation_request_blocked";
    return {
      ...result,
      state: state.state,
      ready: state.state === "ready" && !state.blockedMutation,
      lookupSubmitted: state.submitted,
      requestId,
      invitationSent: false,
      blockedInvitationRequest: state.blockedMutation,
      syntheticResultNotStored: true,
    };
  } catch (error) {
    state.state = "failed";
    await state.cleanup().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
