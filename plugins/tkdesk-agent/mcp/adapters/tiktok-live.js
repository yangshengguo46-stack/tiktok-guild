const DEFAULT_START_URL = "https://www.tiktok.com/live";
const DISCOVERY_HOSTS = new Set(["tiktok.com", "www.tiktok.com", "m.tiktok.com"]);
const NETWORK_URL = /https?:\/\/[^\s<>"'`]+/gi;
const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PATH_EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const BEARER_CREDENTIAL = /\b(?:authorization\s*[:=]\s*)?bearer\s+(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const SENSITIVE_ASSIGNMENT = /\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth(?:orization)?[_-]?code|oauth[_-]?code|authorization|cookie|password|passwd|secret|token|credential|session[_-]?id|api[_-]?key|csrf|xsrf|email|query|hash)(?:\s*[:=]\s*|\s+bearer\s+)(?:"[^"]*"|'[^']*'|[^&\s,;}]+)/gi;
const URL_FIELD_NAME = /(?:url|uri|href|location|redirect)/i;
const PATH_SECRET_KEYS = new Set([
  "access_token", "refresh_token", "id_token", "auth_code", "authorization_code", "oauth_code",
  "authorization", "cookie", "password", "passwd", "secret", "token", "credential", "session_id",
  "api_key", "csrf", "xsrf", "email", "query", "hash"
]);
const PATH_CALLBACK_MARKERS = new Set(["callback", "oauth_callback", "auth_callback", "redirect"]);

function normalizedKey(value) {
  return String(value ?? "")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function isSensitiveKey(key) {
  const normalized = normalizedKey(key);
  if (["query", "search", "hash", "fragment"].includes(normalized)) return true;
  return /(?:^|_)(?:authorization|cookie|password|passwd|secret|token|credential|email|session_id|api_key|csrf|xsrf)(?:$|_)/.test(normalized);
}

function safePathname(pathname) {
  const rawSegments = String(pathname || "/").split("/").slice(1);
  const decodedSegments = [];
  try {
    for (const segment of rawSegments) decodedSegments.push(decodeURIComponent(segment));
  } catch {
    return "/_redacted_";
  }

  // TikTok creator paths are useful discovery evidence and have a strict,
  // non-secret grammar. Preserve them exactly (including the optional /live).
  const nonEmpty = decodedSegments.filter((segment) => segment !== "");
  if ((nonEmpty.length === 1 || nonEmpty.length === 2)
    && /^@[a-z\d._]{1,64}$/i.test(nonEmpty[0])
    && (nonEmpty.length === 1 || nonEmpty[1].toLowerCase() === "live")) {
    return pathname || "/";
  }

  let callbackSeen = false;
  for (let index = 0; index < decodedSegments.length; index += 1) {
    const segment = decodedSegments[index];
    if (!segment) continue;
    const normalized = normalizedKey(segment);
    const assignmentKey = normalizedKey(segment.split(/[=:]/, 1)[0]);
    const hasSensitiveAssignment = PATH_SECRET_KEYS.has(assignmentKey) && /[=:]/.test(segment);
    const hasSensitivePrefixValue = [...PATH_SECRET_KEYS].some((key) => (
      normalized.startsWith(`${key}_`) && normalized.length > key.length + 1
    ));
    const unsafe = callbackSeen
      || PATH_EMAIL_ADDRESS.test(segment)
      || segment.includes("/")
      || segment.includes("\\")
      || PATH_SECRET_KEYS.has(normalized)
      || hasSensitiveAssignment
      || hasSensitivePrefixValue;
    if (unsafe) {
      const safePrefix = rawSegments.slice(0, index).filter(Boolean);
      return `/${[...safePrefix, "_redacted_"].join("/")}`;
    }
    if (PATH_CALLBACK_MARKERS.has(normalized)) callbackSeen = true;
  }
  return pathname || "/";
}

export function sanitizeTikTokUrl(rawUrl) {
  if (rawUrl === null || rawUrl === undefined || rawUrl === "") return null;
  try {
    const parsed = new URL(String(rawUrl));
    if (!/^https?:$/.test(parsed.protocol)) return "[REDACTED_URL]";
    parsed.username = "";
    parsed.password = "";
    return `${parsed.origin}${safePathname(parsed.pathname)}`;
  } catch {
    return "[REDACTED_URL]";
  }
}

export function sanitizeTikTokText(value) {
  return String(value ?? "")
    .replace(NETWORK_URL, (url) => sanitizeTikTokUrl(url))
    .replace(BEARER_CREDENTIAL, "[REDACTED]")
    .replace(SENSITIVE_ASSIGNMENT, "[REDACTED]")
    .replace(EMAIL_ADDRESS, "[REDACTED]");
}

export function sanitizeTikTokValue(value, key = "", depth = 0) {
  if (value === null || value === undefined) return value;
  if (isSensitiveKey(key)) return "[REDACTED]";
  if (depth > 12) return "[REDACTED]";
  if (value instanceof URL) return sanitizeTikTokUrl(value.href);
  if (typeof value === "string") {
    return URL_FIELD_NAME.test(key) ? sanitizeTikTokUrl(value) : sanitizeTikTokText(value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeTikTokValue(item, "", depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([nestedKey, nestedValue]) => [
      nestedKey,
      sanitizeTikTokValue(nestedValue, nestedKey, depth + 1)
    ]));
  }
  return value;
}

class TikTokLiveError extends Error {
  constructor(error) {
    super(sanitizeTikTokText(error?.message ?? error));
    this.name = "TikTokLiveError";
    this.code = sanitizeTikTokText(error?.code || "TIKTOK_DISCOVERY_ERROR");
    this.details = sanitizeTikTokValue(error?.details ?? null);
  }
}

function compact(value, limit = 500) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function parseCount(text, labels) {
  for (const label of labels) {
    const expression = new RegExp(`([\\d,.]+)\\s*([KMB万千]?)\\s*${label}`, "i");
    const match = compact(text).match(expression);
    if (!match) continue;
    const base = Number(match[1].replaceAll(",", ""));
    const multiplier = { k: 1_000, m: 1_000_000, b: 1_000_000_000, 万: 10_000, 千: 1_000 }[match[2].toLowerCase()] ?? 1;
    if (Number.isFinite(base)) return Math.round(base * multiplier);
  }
  return null;
}

export function isAllowedTikTokDiscoveryUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && DISCOVERY_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function normalizeTikTokLiveLinks(items, observedAt = new Date().toISOString()) {
  const prospects = new Map();
  for (const item of items ?? []) {
    let url;
    try { url = new URL(item.href); } catch { continue; }
    if (!DISCOVERY_HOSTS.has(url.hostname.toLowerCase())) continue;
    const match = url.pathname.match(/^\/@([^/?#]+)(?:\/live)?\/?$/i);
    if (!match) continue;
    const handle = decodeURIComponent(match[1]).replace(/^@/, "").trim();
    if (!/^[a-z\d._]{1,64}$/i.test(handle) || /^(login|signup|explore|live)$/i.test(handle)) continue;
    const text = sanitizeTikTokText(compact(item.text));
    const liveSignal = /\/live\/?$/i.test(url.pathname) || /\bLIVE\b|直播中|正在直播/i.test(text);
    if (!liveSignal) continue;
    const previous = prospects.get(handle.toLowerCase());
    const viewerCount = parseCount(text, ["viewers?", "watching", "人观看", "观众"]);
    const record = sanitizeTikTokValue({
      candidateId: null,
      userId: null,
      secUid: null,
      handle,
      displayName: compact(item.displayName || text.split(" · ")[0] || handle, 160),
      profileUrl: `https://www.tiktok.com/@${encodeURIComponent(handle)}`,
      roomId: null,
      region: null,
      countryCode: null,
      followerCount: null,
      viewerCount,
      live: true,
      seller: null,
      liveTag: null,
      source: "tiktok_live",
      sourceUrl: sanitizeTikTokUrl(url.href),
      observedAt,
      rawEvidence: { text: text.slice(0, 300), href: sanitizeTikTokUrl(url.href) },
      confidence: viewerCount === null ? 0.72 : 0.8
    });
    if (!previous || (record.rawEvidence.text.length > previous.rawEvidence.text.length)) {
      prospects.set(handle.toLowerCase(), record);
    }
  }
  return [...prospects.values()];
}

async function detectGate(page) {
  const url = page.url();
  const text = compact(await page.locator("body").innerText().catch(() => ""), 50_000);
  if (/captcha|verify to continue|security check|请完成验证|安全验证|验证码/i.test(text)) {
    return { blocked: "manual_verification", url };
  }
  if (/\/login(?:[/?#]|$)/i.test(new URL(url).pathname) || /log in to tiktok|登录\s*tiktok|登录以继续/i.test(text)) {
    return { blocked: "authentication_required", url };
  }
  return null;
}

async function readLiveLinks(page) {
  return page.locator('a[href*="/@"]').evaluateAll((anchors) => anchors.slice(0, 2_000).map((anchor) => {
    const container = anchor.closest('article, [data-e2e*="live" i], [class*="live" i]') || anchor;
    return {
      href: anchor.href,
      text: (container.innerText || anchor.innerText || anchor.textContent || "").slice(0, 1_000),
      displayName: (anchor.getAttribute("aria-label") || anchor.innerText || "").slice(0, 200)
    };
  }));
}

async function collectTikTokLiveInternal({
  page,
  startUrl = DEFAULT_START_URL,
  maxCandidates = 100,
  maxScrolls = 20,
  checkpoint = {},
  onBatch = async () => {},
  onProgress = async () => {},
  shouldStop = () => false
}) {
  if (!page) throw new Error("缺少 TikTok 浏览器页面");
  if (!isAllowedTikTokDiscoveryUrl(startUrl)) throw new Error("TikTok 发现源只允许官方 HTTPS 页面");
  const navigationUrl = sanitizeTikTokUrl(startUrl);
  if (!isAllowedTikTokDiscoveryUrl(page.url()) || page.url() === "about:blank") {
    await page.goto(navigationUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } else if (sanitizeTikTokUrl(page.url()) !== navigationUrl && !checkpoint.scroll) {
    await page.goto(navigationUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  }
  await page.waitForTimeout(1_500);
  const firstLiveCard = page.locator('a[href*="/@"][href*="/live"]');
  if (typeof firstLiveCard?.first === "function") {
    await firstLiveCard.first().waitFor({ state: "attached", timeout: 12_000 }).catch(() => {});
  }
  const gate = await detectGate(page);
  if (gate) {
    const error = new Error(gate.blocked === "manual_verification" ? "TikTok 需要人工验证" : "TikTok 需要用户登录");
    error.code = gate.blocked;
    error.details = gate;
    throw error;
  }

  const found = new Map();
  let noGrowthRounds = 0;
  let scroll = Number(checkpoint.scroll || 0);
  for (; scroll < maxScrolls && found.size < maxCandidates; scroll += 1) {
    if (shouldStop()) break;
    const observedAt = new Date().toISOString();
    const batch = normalizeTikTokLiveLinks(await readLiveLinks(page), observedAt)
      .filter((item) => !found.has(item.handle.toLowerCase()))
      .slice(0, Math.max(0, maxCandidates - found.size));
    for (const prospect of batch) found.set(prospect.handle.toLowerCase(), prospect);
    if (batch.length) {
      noGrowthRounds = 0;
      await onBatch(batch);
    } else {
      noGrowthRounds += 1;
    }
    await onProgress(sanitizeTikTokValue({ scroll, found: found.size, newInRound: batch.length, url: page.url() }));
    if (noGrowthRounds >= 3) break;
    await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 0.9, 700)));
    await page.waitForTimeout(1_000);
  }

  return sanitizeTikTokValue({
    source: "tiktok_live",
    found: found.size,
    scrolls: scroll,
    expected: null,
    exhaustive: false,
    exhaustionReason: found.size >= maxCandidates
      ? "candidate_limit"
      : noGrowthRounds >= 3
        ? "no_new_cards_after_three_scrolls"
        : shouldStop()
          ? "paused_or_cancelled"
          : "scroll_limit",
    candidates: [...found.values()]
  });
}

export async function collectTikTokLive(options) {
  try {
    return await collectTikTokLiveInternal(options);
  } catch (error) {
    if (error instanceof TikTokLiveError) throw error;
    throw new TikTokLiveError(error);
  }
}
