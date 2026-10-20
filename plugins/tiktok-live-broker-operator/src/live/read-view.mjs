import { GuildError } from "../errors.mjs";

const ORIGIN = "https://live-backstage.tiktok.com";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CALL_BYTES = 4 * 1024 * 1024;
const EXPECTED_RESPONSE_WAIT_MS = 12_000;
const LOGIN_PATH = /\/(?:login|signup|oauth|auth|challenge|captcha|verification|security-check)(?:\/|$)/iu;

async function readSurface(page) {
  if (typeof page.evaluate !== "function") return null;
  try {
    return await page.evaluate(() => {
      const compact = (value, maximum) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maximum);
      const root = document.querySelector("main") ?? document.body;
      if (!root) return null;
      const text = compact(root.innerText ?? root.textContent, 32_000);
      const tables = [...root.querySelectorAll("table")].slice(0, 8).map((table) => ({
        headers: [...table.querySelectorAll("th")].slice(0, 32).map((cell) => compact(cell.innerText ?? cell.textContent, 256)),
        rows: [...table.querySelectorAll("tr")].slice(0, 200).map((row) => (
          [...row.querySelectorAll("td")].slice(0, 32).map((cell) => compact(cell.innerText ?? cell.textContent, 4_096))
        )).filter((row) => row.length > 0)
      }));
      return { title: compact(document.title, 256), path: location.pathname, text, tables };
    });
  } catch {
    return null;
  }
}

function hasReadableSurface(surface) {
  if (surface === null) return false;
  if (surface.tables?.some((table) => table.headers?.length > 0 || table.rows?.length > 0)) return true;
  const text = String(surface.text ?? "").trim();
  if (/^Loading instant messages, please wait\.?$/iu.test(text)) return false;
  return text.length > 0 && text !== String(surface.title ?? "").trim();
}

export async function readView({
  page,
  view,
  params = {},
  clock = () => new Date().toISOString(),
  responseWaitMs = EXPECTED_RESPONSE_WAIT_MS
}) {
  if (!page || typeof page.on !== "function" || typeof page.goto !== "function") {
    throw new GuildError("session_owner_unverified", "The owned Backstage page is unavailable.");
  }
  if (!view || typeof view.route !== "string" || !Array.isArray(view.response_paths)) {
    throw new GuildError("capability_unavailable", "The live view is invalid.");
  }

  const allowed = new Set(view.response_paths);
  const captures = [];
  const capturedPaths = new Set();
  let capturedBytes = 0;
  let responseListenerAttached = true;
  let resolveExpectedResponses;
  const expectedResponses = new Promise((resolve) => { resolveExpectedResponses = resolve; });
  const detachResponseListener = () => {
    if (!responseListenerAttached) return;
    responseListenerAttached = false;
    if (typeof page.off === "function") page.off("response", onResponse);
    else if (typeof page.removeListener === "function") page.removeListener("response", onResponse);
  };
  const onResponse = (response) => {
    let url;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    const method = typeof response.request === "function" ? response.request().method() : "GET";
    if (url.origin !== ORIGIN || !allowed.has(url.pathname) || method !== "GET" || response.status() !== 200) return;
    const capture = (async () => {
      const headers = await response.headers();
      if (!String(headers["content-type"] ?? "").toLowerCase().includes("application/json")) return null;
      const bytes = await response.body();
      if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_RESPONSE_BYTES) {
        throw new GuildError("adapter_mismatch", "A live JSON response exceeded its reviewed boundary.");
      }
      capturedBytes += bytes.length;
      if (capturedBytes > MAX_CALL_BYTES) {
        throw new GuildError("adapter_mismatch", "The live read exceeded its bounded response budget.");
      }
      let body;
      try {
        body = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new GuildError("adapter_mismatch", "A live JSON response was malformed.");
      }
      return { endpoint_path: url.pathname, body };
    })();
    captures.push(capture);
    void capture.then((result) => {
      if (result === null) return;
      capturedPaths.add(result.endpoint_path);
      if ([...allowed].every((endpointPath) => capturedPaths.has(endpointPath))) resolveExpectedResponses();
    }, () => resolveExpectedResponses());
  };

  page.on("response", onResponse);
  try {
    await page.goto(`${ORIGIN}${view.route}`, { waitUntil: "domcontentloaded" });
    if (typeof view.prepare === "function") await view.prepare(page);
    if (allowed.size > 0) {
      let timeoutId;
      const timeout = new Promise((resolve) => {
        timeoutId = setTimeout(resolve, responseWaitMs);
      });
      await Promise.race([expectedResponses, timeout]);
      clearTimeout(timeoutId);
    }
    detachResponseListener();
    let path = "";
    try { path = new URL(page.url()).pathname; } catch { /* handled as unavailable below */ }
    if (LOGIN_PATH.test(path)) throw new GuildError("login_required", "TikTok LIVE Backstage login is required.");

    const settled = await Promise.allSettled(captures);
    const rejected = settled.find(({ status }) => status === "rejected");
    if (rejected) throw rejected.reason;
    const responses = settled.filter(({ status, value }) => status === "fulfilled" && value !== null).map(({ value }) => value);
    const successfulPaths = new Set(responses.map(({ endpoint_path }) => endpoint_path));
    let surface = await readSurface(page);
    if (allowed.size === 0 && !hasReadableSurface(surface)) {
      const deadline = Date.now() + responseWaitMs;
      while (Date.now() < deadline && !hasReadableSurface(surface)) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
        surface = await readSurface(page);
      }
    }
    const missing = view.response_paths.filter((endpointPath) => !successfulPaths.has(endpointPath));
    if (view.response_paths.length === 0 && !hasReadableSurface(surface)) missing.push("live_read_mapping");
    if (responses.length === 0 && surface === null) {
      throw new GuildError("capability_unavailable", "The live page returned no readable evidence.");
    }
    const observedAt = clock();
    const evidence = [
      ...responses.map(({ endpoint_path }) => ({ route: view.route, endpoint_path, observed_at: observedAt })),
      ...(surface === null ? [] : [{ route: view.route, source: "visible_dom", observed_at: observedAt }])
    ];
    return {
      status: missing.length === 0 ? "ok" : "partial",
      data: { responses, surface, params },
      evidence,
      completeness: {
        state: missing.length === 0 ? "complete" : "partial",
        missing
      },
      pagination: {
        complete: false,
        next_cursor: null,
        pages_read: 1,
        page_size: null,
        state: "not_proven"
      }
    };
  } catch (error) {
    if (error instanceof GuildError) throw error;
    throw new GuildError("capability_unavailable", "The live page could not be read.");
  } finally {
    detachResponseListener();
  }
}
