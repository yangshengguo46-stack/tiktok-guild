import { GuildError } from "../errors.mjs";
import { projectIdentity } from "./project-identity.mjs";

const BACKSTAGE_ORIGIN = "https://live-backstage.tiktok.com";
const OVERVIEW_URL = `${BACKSTAGE_ORIGIN}/portal/overview`;
const STARTUP_PATH = "/creators/live/union_platform_api/agency/common/startup/";
const MAX_BYTES = 1024 * 1024;
const LOGIN_PATH = /\/(?:login|signup|oauth|auth|challenge|captcha|verification|security-check)(?:\/|$)/iu;

function currentPath(page) {
  try {
    return new URL(page.url()).pathname;
  } catch {
    return "";
  }
}

export async function discoverGuild({ page, responseTimeoutMs = 10_000 }) {
  if (!page || typeof page.on !== "function" || typeof page.goto !== "function") {
    throw new GuildError("session_owner_unverified", "The owned Backstage page is unavailable.");
  }
  if (!Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs < 100 || responseTimeoutMs > 15_000) {
    throw new TypeError("responseTimeoutMs must be an integer from 100 to 15000.");
  }

  const bodies = [];
  const pending = new Set();
  let matchingResponses = 0;
  let lastCaptureError = null;
  let notifyBody;
  const bodyArrived = new Promise((resolve) => { notifyBody = resolve; });
  const onResponse = (response) => {
    let url;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (url.origin !== BACKSTAGE_ORIGIN || url.pathname !== STARTUP_PATH || response.status() !== 200) return;
    matchingResponses += 1;
    const capture = (async () => {
      const headers = await response.headers();
      if (!String(headers["content-type"] ?? "").toLowerCase().includes("application/json")) return null;
      const bytes = await response.body();
      if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_BYTES) {
        throw new GuildError("adapter_mismatch", "The startup identity response exceeded its reviewed boundary.");
      }
      return JSON.parse(bytes.toString("utf8"));
    })();
    const observed = capture.then(
      (body) => {
        if (body !== null) {
          bodies.push(body);
          notifyBody();
        }
      },
      (error) => { lastCaptureError = error; }
    );
    pending.add(observed);
    void observed.finally(() => pending.delete(observed));
  };

  page.on("response", onResponse);
  try {
    await page.goto(OVERVIEW_URL, { waitUntil: "domcontentloaded" });
    const path = currentPath(page);
    if (LOGIN_PATH.test(path)) {
      throw new GuildError("login_required", "TikTok LIVE Backstage login is required.");
    }
    if (bodies.length === 0) {
      let timer;
      await Promise.race([
        bodyArrived,
        new Promise((resolve) => { timer = setTimeout(resolve, responseTimeoutMs); })
      ]).finally(() => clearTimeout(timer));
    }
    if (bodies.length === 0) {
      if (matchingResponses > 0 && lastCaptureError instanceof GuildError) throw lastCaptureError;
      if (matchingResponses > 0) {
        throw new GuildError("capability_unavailable", "The Backstage startup identity response body was unavailable.");
      }
      throw new GuildError("guild_binding_not_found", "No accessible guild identity was observed on Backstage overview.");
    }
    let loginError = null;
    let mismatchError = null;
    for (const body of bodies.toReversed()) {
      try {
        return projectIdentity(body);
      } catch (error) {
        if (error instanceof GuildError && error.code === "login_required") loginError = error;
        else mismatchError = error;
      }
    }
    if (loginError) throw loginError;
    throw mismatchError ?? new GuildError("adapter_mismatch", "The Backstage startup identity response changed shape.");
  } catch (error) {
    if (error instanceof GuildError) throw error;
    throw new GuildError("capability_unavailable", "The Backstage overview could not be read.");
  } finally {
    if (typeof page.off === "function") page.off("response", onResponse);
    else if (typeof page.removeListener === "function") page.removeListener("response", onResponse);
  }
}

export const WORKSPACE_EVIDENCE = Object.freeze({
  route: "/portal/overview",
  endpoint_path: STARTUP_PATH
});
