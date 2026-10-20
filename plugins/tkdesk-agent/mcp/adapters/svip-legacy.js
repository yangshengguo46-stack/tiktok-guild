const ADAPTER_VERSION = "svip-legacy/1.0.0";
const ALLOWED_HOSTS = new Set(["svip.tiktokzb.com"]);
const URL_FIELD_NAME = /(?:url|uri|href|location|redirect)/i;
const NETWORK_URL = /(?:https?:)?\/\/[^\s<>"'`]+/gi;
const SENSITIVE_PARAMETER = /\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth(?:orization)?[_-]?code|oauth[_-]?code|token|code)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^&\s,;}]+)/gi;

export const LEGACY_ANCHOR_FIELDS = Object.freeze([
  "id",
  "name",
  "zb_bj",
  "zb_name",
  "zb_yqType",
  "zb_Level",
  "zb_liveTag",
  "zb_create_time",
  "region",
  "regioncode",
  "zb_Ranking",
  "zb_top",
  "zbj_renshu",
  "zb_zuanshi",
  "zb_zhoubang",
  "zb_pm",
  "zb_bak",
  "zb_fan",
  "up_date",
  "yg_name",
  "zb_strid",
  "sec_uid"
]);

const RANGE_FILTERS = new Set([
  "zb_create_time",
  "zb_bak",
  "zb_zuanshi",
  "zb_zhoubang",
  "zb_pm",
  "zb_date",
  "zb_fan",
  "zb_Level",
  "zbj_renshu"
]);

const ARRAY_FILTERS = new Set(["zb_liveTag", "zb_yqType", "zb_bj"]);

const QUALIFICATION_STATUS = Object.freeze({
  3: "regular_invitation",
  4: "advanced_invitation",
  5: "associated_account",
  6: "insufficient_duration",
  10: "not_queried"
});

const CONNECTION_STATUS = Object.freeze({
  0: "not_connected",
  1: "manual_connected",
  2: "automatic_connected"
});

const SOURCE_STATUS = Object.freeze({
  1: "live_square",
  2: "live_square",
  3: "live_square",
  4: "ranked_creator"
});

const DOM_HEADER_ALIASES = new Map([
  ["connection status", "zb_bj"],
  ["建联状态", "zb_bj"],
  ["anchor id", "zb_name"],
  ["主播id", "zb_name"],
  ["anchor status", "zb_yqType"],
  ["主播状态", "zb_yqType"],
  ["streamer level", "zb_Level"],
  ["主播等级", "zb_Level"],
  ["anchor tags", "zb_liveTag"],
  ["直播标签", "zb_liveTag"],
  ["live duration", "zb_create_time"],
  ["开播时长", "zb_create_time"],
  ["region", "region"],
  ["地区", "region"],
  ["country code", "regioncode"],
  ["国家代码", "regioncode"],
  ["segment ranking", "zb_Ranking"],
  ["段位排名", "zb_Ranking"],
  ["anchor source", "zb_top"],
  ["主播来源", "zb_top"],
  ["viewers in live room", "zbj_renshu"],
  ["直播间人数", "zbj_renshu"],
  ["current diamonds", "zb_zuanshi"],
  ["当前钻石", "zb_zuanshi"],
  ["weekly list diamond", "zb_zhoubang"],
  ["ribang diamond", "zb_zhoubang"],
  ["周榜钻石", "zb_zhoubang"],
  ["日榜钻石", "zb_zhoubang"],
  ["小时榜钻石", "zb_zhoubang"],
  ["last week's list of diamonds", "zb_pm"],
  ["ranking record diamond", "zb_pm"],
  ["上周周榜钻石", "zb_pm"],
  ["排名记录钻石", "zb_pm"],
  ["historical highest diamonds", "zb_bak"],
  ["历史最高钻石", "zb_bak"],
  ["current followers", "zb_fan"],
  ["当前粉丝", "zb_fan"],
  ["record time", "up_date"],
  ["记录时间", "up_date"],
  ["allocation status", "yg_name"],
  ["分配状态", "yg_name"]
]);

export class SvipLegacyError extends Error {
  constructor(code, message, details = {}, options = {}) {
    const safeOptions = options?.cause
      ? { cause: new Error(redactSensitiveText(options.cause?.message ?? options.cause)) }
      : undefined;
    super(redactSensitiveText(message), safeOptions);
    this.name = "SvipLegacyError";
    this.code = redactSensitiveText(code);
    this.details = sanitizeExposedValue(details);
  }
}

function sanitizeUrlForOutput(rawUrl) {
  if (rawUrl === null || rawUrl === undefined || rawUrl === "") return null;
  const text = String(rawUrl);
  const isAbsolute = /^[a-z][a-z\d+.-]*:\/\//i.test(text);
  try {
    const parsed = new URL(text, "https://svip.tiktokzb.com");
    if (!/^https?:$/.test(parsed.protocol)) return "[REDACTED_URL]";
    let pathname = parsed.pathname || "/";
    let decodedPathname = pathname;
    try {
      decodedPathname = decodeURIComponent(pathname);
    } catch {
      // Keep the encoded pathname. Query and hash are still removed below.
    }
    if (/\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth(?:orization)?[_-]?code|oauth[_-]?code|token|code)\b/i.test(decodedPathname)) {
      pathname = "/[REDACTED]";
    }
    return isAbsolute ? `${parsed.origin}${pathname}` : pathname;
  } catch {
    return "[REDACTED_URL]";
  }
}

function redactSensitiveText(value) {
  const text = String(value ?? "");
  return text
    .replace(NETWORK_URL, (url) => sanitizeUrlForOutput(url))
    .replace(SENSITIVE_PARAMETER, (_match, separator) => `[REDACTED]${separator}[REDACTED]`);
}

function sanitizeExposedValue(value, key = "") {
  if (value === null || value === undefined) return value;
  if (value instanceof URL) return sanitizeUrlForOutput(value.href);
  if (typeof value === "string") {
    return URL_FIELD_NAME.test(key) ? sanitizeUrlForOutput(value) : redactSensitiveText(value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeExposedValue(item));
  if (typeof value === "object") {
    const safe = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      safe[nestedKey] = sanitizeExposedValue(nestedValue, nestedKey);
    }
    return safe;
  }
  return value;
}

function cleanText(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function nullableText(value) {
  const text = cleanText(value);
  return text || null;
}

function nullableNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = cleanText(value).replaceAll(",", "");
  if (!text) return null;
  const match = text.match(/^(-?\d+(?:\.\d+)?)\s*([kKmMwW万千百万]?)$/);
  if (!match) return null;
  const suffix = match[2].toLowerCase();
  const multiplier = {
    k: 1_000,
    千: 1_000,
    w: 10_000,
    万: 10_000,
    m: 1_000_000,
    百万: 1_000_000
  }[suffix] ?? 1;
  const result = Number(match[1]) * multiplier;
  return Number.isFinite(result) ? result : null;
}

function nullableInteger(value) {
  const number = nullableNumber(value);
  return number === null ? null : Math.trunc(number);
}

function normalizeHandle(value) {
  return cleanText(value).replace(/^@+/, "").toLowerCase();
}

function numberCode(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cloneLegacyRow(row) {
  const normalized = {};
  for (const field of LEGACY_ANCHOR_FIELDS) normalized[field] = row?.[field] ?? null;
  const extra = {};
  for (const [key, value] of Object.entries(row ?? {})) {
    if (!LEGACY_ANCHOR_FIELDS.includes(key)) extra[key] = value;
  }
  return Object.keys(extra).length ? { ...normalized, extra } : normalized;
}

function normalizeDurationFromDom(value) {
  const text = cleanText(value);
  if (!text) return null;
  if (/未开播|not\s+live/i.test(text)) return 0;
  const hours = Number(text.match(/(\d+(?:\.\d+)?)\s*(?:小时|hours?|hrs?)/i)?.[1] ?? 0);
  const minutes = Number(text.match(/(\d+(?:\.\d+)?)\s*(?:分钟|minutes?|mins?)/i)?.[1] ?? 0);
  if (hours || minutes) return Math.trunc(hours * 60 + minutes);
  return nullableInteger(text);
}

function normalizeDomStatus(field, value) {
  const text = cleanText(value).toLowerCase();
  if (field === "zb_bj") {
    if (text === "❤" || /not connected|未建联/.test(text)) return 0;
    if (/manual|手动建联/.test(text)) return 1;
    if (/automatic|自动建联/.test(text)) return 2;
  }
  if (field === "zb_yqType") {
    if (/regular invitation|常规邀约/.test(text)) return 3;
    if (/advanced invitation|进阶邀约/.test(text)) return 4;
    if (/not quer|未查询/.test(text)) return 10;
    if (/associated account|关联账号/.test(text)) return 5;
    if (/insufficient duration|时长不足/.test(text)) return 6;
  }
  if (field === "zb_top") {
    if (/live square|直播广场/.test(text)) return 1;
    if (/ranked creator|上榜主播/.test(text)) return 4;
  }
  if (field === "zb_create_time") return normalizeDurationFromDom(value);
  return value;
}

function hasMeaningfulFilters(filters) {
  return Object.entries(filters ?? {}).some(([key, value]) => {
    if (["page", "limit", "region"].includes(key)) return false;
    if (Array.isArray(value)) {
      if (!value.length) return false;
      if (RANGE_FILTERS.has(key)) return value.some((range) => cleanText(range?.min) || cleanText(range?.max));
      return true;
    }
    return cleanText(value) && value !== "all";
  });
}

function getPageUrl(page) {
  if (!page || typeof page.url !== "function") {
    throw new SvipLegacyError("SVIP_PAGE_REQUIRED", "需要一个已打开的 Playwright page。", {});
  }
  return page.url();
}

function assertTrustedPage(page) {
  let parsed;
  try {
    parsed = new URL(getPageUrl(page));
  } catch (error) {
    throw new SvipLegacyError("SVIP_UNTRUSTED_ORIGIN", "无法确认 svip 页面来源。", {}, { cause: error });
  }
  if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new SvipLegacyError(
      "SVIP_UNTRUSTED_ORIGIN",
      "旧版名单适配器只允许在 https://svip.tiktokzb.com 的已登录页面内运行。",
      { url: parsed.href, host: parsed.hostname }
    );
  }
  return parsed;
}

function routeText(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.pathname}${url.search}${url.hash}`.toLowerCase();
  } catch {
    return "";
  }
}

export function isSvipLegacyLoginUrl(rawUrl) {
  return /(?:^|[/#])login(?:[/?#]|$)/i.test(routeText(rawUrl));
}

export function isSvipAnchorListUrl(rawUrl) {
  return /(?:^|[/#])anchorlist(?:yg)?(?:[/?#]|$)/i.test(routeText(rawUrl));
}

export async function inspectSvipLegacySession(page) {
  const rawUrl = assertTrustedPage(page).href;
  const url = sanitizeUrlForOutput(rawUrl);
  if (isSvipLegacyLoginUrl(rawUrl)) {
    return sanitizeExposedValue({ authenticated: false, state: "login_required", route: "login", url });
  }

  let visibleState;
  try {
    visibleState = await page.evaluate(() => {
      const visible = (element) => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const password = Array.from(document.querySelectorAll('input[type="password"]')).some(visible);
      const loginContainer = visible(document.querySelector(".login-container"));
      const anchorTable = visible(document.querySelector(".el-table__body-wrapper, .el-table"));
      return { password, loginContainer, anchorTable, title: document.title };
    });
  } catch (error) {
    throw new SvipLegacyError(
      "SVIP_SESSION_INSPECTION_FAILED",
      "无法检查 svip 登录状态。",
      { error: error?.message },
      { cause: error }
    );
  }

  if (visibleState.password || visibleState.loginContainer) {
    return sanitizeExposedValue({ authenticated: false, state: "login_required", route: "login_dom", url, title: visibleState.title });
  }
  if (isSvipAnchorListUrl(rawUrl)) {
    return sanitizeExposedValue({
      authenticated: true,
      state: visibleState.anchorTable ? "anchor_list_ready" : "anchor_list_route",
      route: "anchor_list",
      url,
      title: visibleState.title
    });
  }
  return sanitizeExposedValue({ authenticated: true, state: "authenticated_route", route: "other", url, title: visibleState.title });
}

function isEmptyRange(value) {
  if (!Array.isArray(value) || !value.length) return true;
  return value.every((range) => !cleanText(range?.min) && !cleanText(range?.max));
}

export function buildLegacyListPayload(filters = {}, options = {}) {
  const page = Math.max(1, Math.trunc(Number(options.page ?? filters.page ?? 1) || 1));
  const limit = Math.min(1_000, Math.max(1, Math.trunc(Number(options.limit ?? filters.limit ?? 30) || 30)));
  const payload = {};

  for (const [key, value] of Object.entries(filters ?? {})) {
    if (key === "page" || key === "limit" || key === "region") continue;
    if (value === "all") continue;
    if (RANGE_FILTERS.has(key)) {
      if (!isEmptyRange(value)) payload[key] = value.map((range) => ({ min: range?.min ?? "", max: range?.max ?? "" }));
      continue;
    }
    if (ARRAY_FILTERS.has(key)) {
      if (Array.isArray(value) && value.length) payload[key] = [...value];
      continue;
    }
    if (value === "" || value === null || value === undefined) {
      if (key === "yg_name") payload[key] = "";
      continue;
    }
    payload[key] = Array.isArray(value) ? [...value] : value;
  }

  payload.page = page;
  payload.limit = limit;
  payload.region = options.region ?? filters.region ?? "";
  return sanitizeExposedValue(payload);
}

function authMessage(value) {
  return /未登录|登录.*(?:超时|过期)|重新登录|login required|not logged|session.*(?:expired|invalid)/i.test(cleanText(value));
}

function htmlLoginResponse(result) {
  if (!/text\/html/i.test(result?.contentType || "")) return false;
  return /login-container|type=["']password["']|请输入用户名|请输入密码|欢迎登录|\blog\s*in\b/i.test(result?.responseText || "");
}

function validateApiEnvelope(result, payload) {
  if (result?.networkError) {
    throw new SvipLegacyError("SVIP_NETWORK_ERROR", "旧版名单接口请求失败。", { error: result.networkError, page: payload.page });
  }
  if (result?.crossOriginRedirect) {
    throw new SvipLegacyError(
      "SVIP_CROSS_ORIGIN_REDIRECT",
      "旧版名单接口发生跨域跳转，已停止以保护登录会话。",
      { finalUrl: result.finalUrl, page: payload.page }
    );
  }
  if (result?.httpStatus === 401) {
    throw new SvipLegacyError("SVIP_LOGIN_EXPIRED", "svip 登录已过期，请在浏览器中重新登录。", { status: 401, page: payload.page });
  }
  if (result?.httpStatus === 403) {
    throw new SvipLegacyError("SVIP_ACCESS_DENIED", "当前 svip 会话无权读取主播名单。", { status: 403, page: payload.page });
  }
  if (isSvipLegacyLoginUrl(result?.finalUrl || "") || authMessage(result?.responseText) || htmlLoginResponse(result)) {
    throw new SvipLegacyError("SVIP_LOGIN_EXPIRED", "svip 页面已回到登录状态，请重新登录。", {
      status: result?.httpStatus,
      finalUrl: result?.finalUrl,
      page: payload.page
    });
  }
  if (!result?.ok) {
    throw new SvipLegacyError("SVIP_HTTP_ERROR", `旧版名单接口返回 HTTP ${result?.httpStatus ?? "未知"}。`, {
      status: result?.httpStatus ?? null,
      page: payload.page
    });
  }
  if (result.parseError || !result.json || typeof result.json !== "object" || Array.isArray(result.json)) {
    throw new SvipLegacyError("SVIP_STRUCTURE_MISMATCH", "旧版名单接口没有返回预期的 JSON 对象。", {
      status: result.httpStatus,
      contentType: result.contentType,
      parseError: result.parseError || null,
      page: payload.page
    });
  }

  const envelope = result.json;
  if (![0, "0"].includes(envelope.status)) {
    if (authMessage(envelope.msg) || [401, "401"].includes(envelope.status)) {
      throw new SvipLegacyError("SVIP_LOGIN_EXPIRED", "svip 登录已过期，请在浏览器中重新登录。", {
        status: envelope.status,
        message: nullableText(envelope.msg),
        page: payload.page
      });
    }
    throw new SvipLegacyError("SVIP_API_ERROR", envelope.msg || "旧版名单接口返回业务错误。", {
      status: envelope.status ?? null,
      page: payload.page
    });
  }
  if (!Array.isArray(envelope.data)) {
    throw new SvipLegacyError("SVIP_STRUCTURE_MISMATCH", "旧版名单接口的 data 字段不是数组。", {
      actualType: Array.isArray(envelope.data) ? "array" : typeof envelope.data,
      page: payload.page
    });
  }
  const total = Number(envelope.count);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new SvipLegacyError("SVIP_STRUCTURE_MISMATCH", "旧版名单接口的 count 字段不是有效的非负整数。", {
      count: envelope.count,
      page: payload.page
    });
  }
  if (envelope.listArray !== undefined && !Array.isArray(envelope.listArray)) {
    throw new SvipLegacyError("SVIP_STRUCTURE_MISMATCH", "旧版名单接口的 listArray 字段不是数组。", {
      actualType: typeof envelope.listArray,
      page: payload.page
    });
  }
  if (envelope.data.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new SvipLegacyError("SVIP_STRUCTURE_MISMATCH", "旧版名单接口包含无法识别的主播记录。", { page: payload.page });
  }
  if (envelope.data.length > payload.limit) {
    throw new SvipLegacyError("SVIP_STRUCTURE_MISMATCH", "旧版名单接口单页记录数超过请求的 limit。", {
      page: payload.page,
      limit: payload.limit,
      received: envelope.data.length
    });
  }
  return {
    rows: sanitizeExposedValue(envelope.data),
    total,
    listArray: sanitizeExposedValue(envelope.listArray ?? [])
  };
}

export async function fetchSvipLegacyPage(page, filters = {}, options = {}) {
  const currentUrl = assertTrustedPage(page).href;
  if (isSvipLegacyLoginUrl(currentUrl)) {
    throw new SvipLegacyError("SVIP_AUTH_REQUIRED", "请先在 svip 页面中完成登录。", { url: currentUrl });
  }
  const payload = buildLegacyListPayload(filters, options);
  const requestTimeoutMs = Math.min(120_000, Math.max(1_000, Number(options.requestTimeoutMs ?? 60_000)));
  const result = await page.evaluate(async ({ body, timeoutMs }) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch("/list", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "follow",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json;charset=UTF-8"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const finalUrl = response.url || new URL("/list", location.href).href;
      const crossOriginRedirect = new URL(finalUrl, location.href).origin !== location.origin;
      const responseText = await response.text();
      let json = null;
      let parseError = null;
      try {
        json = JSON.parse(responseText);
      } catch (error) {
        parseError = String(error?.message || error);
      }
      return {
        ok: response.ok,
        httpStatus: response.status,
        redirected: response.redirected,
        finalUrl,
        crossOriginRedirect,
        contentType: response.headers.get("content-type") || "",
        responseText: responseText.slice(0, 4_000),
        json,
        parseError
      };
    } catch (error) {
      return { networkError: String(error?.message || error) };
    } finally {
      window.clearTimeout(timeout);
    }
  }, { body: payload, timeoutMs: requestTimeoutMs });

  const validated = validateApiEnvelope(result, payload);
  return {
    ...validated,
    page: payload.page,
    limit: payload.limit,
    payload,
    endpoint: "/list",
    adapterVersion: ADAPTER_VERSION
  };
}

export function mapLegacyAnchor(row, context = {}) {
  const legacy = cloneLegacyRow(row);
  const handleValue = normalizeHandle(row?.zb_name);
  const userId = nullableText(row?.zb_strid);
  const secUid = nullableText(row?.sec_uid);
  const region = nullableText(row?.region);
  const countryCode = nullableText(row?.regioncode);
  const qualificationCode = numberCode(row?.zb_yqType);
  const connectionCode = numberCode(row?.zb_bj);
  const sourceCode = numberCode(row?.zb_top);
  const sourceRecordId = nullableText(row?.id);
  const candidateKey = userId
    ? `tiktok:user:${userId}`
    : secUid
      ? `tiktok:sec:${secUid}`
      : handleValue
        ? `tiktok:handle:${handleValue}:${cleanText(countryCode || region).toLowerCase()}`
        : sourceRecordId
          ? `svip:record:${sourceRecordId}`
          : `svip:page:${context.page ?? 0}:row:${context.rowIndex ?? 0}`;
  const followers = nullableInteger(row?.zb_fan);
  const viewerCount = nullableInteger(row?.zbj_renshu);
  const currentDiamonds = nullableInteger(row?.zb_zuanshi);
  const rankingDiamonds = nullableInteger(row?.zb_zhoubang);
  const rankingRecordDiamonds = nullableInteger(row?.zb_pm);
  const historicalHighestDiamonds = nullableInteger(row?.zb_bak);
  const durationMinutes = nullableInteger(row?.zb_create_time);
  const sourceMode = context.sourceMode ?? "authenticated_same_origin_api";
  const missingFields = LEGACY_ANCHOR_FIELDS.filter((field) =>
    !Object.hasOwn(row ?? {}, field) || row[field] === null || row[field] === undefined
  );

  return sanitizeExposedValue({
    schemaVersion: "tkdesk.candidate-observation.v2",
    adapterVersion: ADAPTER_VERSION,
    source: "svip_legacy",
    sourceMode,
    sourceRecordId,
    candidateKey,
    name: nullableText(row?.name),
    handle: handleValue ? `@${handleValue}` : null,
    profileUrl: handleValue ? `https://www.tiktok.com/@${encodeURIComponent(handleValue)}` : null,
    tiktokUserId: userId,
    secUid,
    country: region,
    countryCode,
    followers,
    viewerCount,
    rank: nullableText(row?.zb_Ranking),
    live: {
      durationMinutes,
      durationKnown: durationMinutes !== null,
      tagId: row?.zb_liveTag ?? null,
      level: nullableInteger(row?.zb_Level),
      levelKnown: nullableNumber(row?.zb_Level) !== null
    },
    diamonds: {
      current: currentDiamonds,
      currentKnown: currentDiamonds !== null && currentDiamonds >= 0,
      ranking: rankingDiamonds !== null && rankingDiamonds >= 0 ? rankingDiamonds : null,
      rankingKnown: rankingDiamonds !== null && rankingDiamonds >= 0,
      rankingRaw: row?.zb_zhoubang ?? null,
      rankingRecord: rankingRecordDiamonds !== null && rankingRecordDiamonds >= 0 ? rankingRecordDiamonds : null,
      rankingRecordKnown: rankingRecordDiamonds !== null && rankingRecordDiamonds >= 0,
      historicalHighest: historicalHighestDiamonds !== null && historicalHighestDiamonds >= 0 ? historicalHighestDiamonds : null,
      historicalHighestKnown: historicalHighestDiamonds !== null && historicalHighestDiamonds >= 0
    },
    discovery: {
      sourceCode,
      source: sourceCode === null ? "unknown" : (SOURCE_STATUS[sourceCode] ?? "unknown_code")
    },
    qualification: {
      known: qualificationCode !== null && qualificationCode !== 10,
      code: qualificationCode,
      status: qualificationCode === null ? "unknown" : (QUALIFICATION_STATUS[qualificationCode] ?? "unknown_code"),
      eligible: [3, 4].includes(qualificationCode) ? true : [5, 6].includes(qualificationCode) ? false : null
    },
    outreach: {
      connectionCode,
      connectionStatus: connectionCode === null ? "unknown" : (CONNECTION_STATUS[connectionCode] ?? "unknown_code"),
      assignedTo: nullableText(row?.yg_name)
    },
    observedAt: nullableText(row?.up_date),
    evidence: {
      endpoint: sourceMode === "authenticated_same_origin_api" ? "/list" : null,
      page: context.page ?? null,
      rowIndex: context.rowIndex ?? null,
      confidence: sourceMode === "authenticated_same_origin_api" ? 0.95 : 0.55,
      completeLegacyFields: missingFields.length === 0,
      missingFields
    },
    legacy
  });
}

function cancellationRequested(options, state) {
  if (options.signal?.aborted) return Promise.resolve(true);
  const callback = options.isCancelled ?? options.shouldCancel;
  return typeof callback === "function" ? Promise.resolve(callback(state)).then(Boolean) : Promise.resolve(false);
}

async function reportProgress(options, event) {
  if (typeof options.onProgress === "function") await options.onProgress(event);
}

async function reportBatch(options, batch) {
  if (typeof options.onBatch === "function") await options.onBatch(batch);
}

function fallbackEligible(error) {
  if (!(error instanceof SvipLegacyError)) return false;
  if (error.code === "SVIP_NETWORK_ERROR") return true;
  if (error.code !== "SVIP_HTTP_ERROR") return false;
  const status = Number(error.details?.status);
  return [404, 405, 502, 503, 504].includes(status);
}

function domFieldForHeader(header) {
  return DOM_HEADER_ALIASES.get(cleanText(header).replace(/:$/, "").toLowerCase()) ?? null;
}

function rowFromDom(headers, cells) {
  const row = {};
  for (let index = 0; index < Math.min(headers.length, cells.length); index += 1) {
    const field = domFieldForHeader(headers[index]);
    if (!field || Object.hasOwn(row, field)) continue;
    row[field] = normalizeDomStatus(field, cells[index]);
  }
  return row;
}

export async function extractSvipElementUiPage(page) {
  const currentUrl = assertTrustedPage(page).href;
  if (isSvipLegacyLoginUrl(currentUrl)) {
    throw new SvipLegacyError("SVIP_AUTH_REQUIRED", "请先在 svip 页面中完成登录。", { url: currentUrl });
  }
  if (!isSvipAnchorListUrl(currentUrl)) {
    throw new SvipLegacyError(
      "SVIP_DOM_FALLBACK_UNAVAILABLE",
      "DOM 备用读取只能在 anchorList 页面执行。",
      { url: currentUrl }
    );
  }

  const extracted = await page.evaluate(() => {
    const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const tables = Array.from(document.querySelectorAll(".el-table"));
    const root = tables.find((table) => table.querySelector(".el-table__body-wrapper tbody"));
    if (!root) return { found: false, headers: [], rows: [], total: null };
    const headers = Array.from(root.querySelectorAll(".el-table__header-wrapper thead th"))
      .map((cell) => clean(cell.querySelector(".cell")?.textContent ?? cell.textContent));
    const rows = Array.from(root.querySelectorAll(".el-table__body-wrapper tbody tr"))
      .map((row) => Array.from(row.querySelectorAll("td")).map((cell) => clean(cell.querySelector(".cell")?.textContent ?? cell.textContent)))
      .filter((row) => row.some(Boolean));
    const pagination = document.querySelector(".el-pagination");
    const totalText = clean(pagination?.querySelector(".el-pagination__total")?.textContent);
    const totalMatch = totalText.match(/(\d[\d,]*)/);
    const currentText = clean(pagination?.querySelector(".el-pager li.active")?.textContent);
    return {
      found: true,
      headers,
      rows,
      total: totalMatch ? Number(totalMatch[1].replaceAll(",", "")) : null,
      currentPage: Number(currentText) || null
    };
  });

  if (!extracted?.found || !Array.isArray(extracted.headers) || !Array.isArray(extracted.rows)) {
    throw new SvipLegacyError("SVIP_DOM_FALLBACK_UNAVAILABLE", "没有找到可识别的 Element UI 主播表格。", {
      url: currentUrl
    });
  }
  const recognizedFields = extracted.headers.map(domFieldForHeader).filter(Boolean);
  if (!recognizedFields.includes("zb_name") && extracted.rows.length) {
    throw new SvipLegacyError("SVIP_STRUCTURE_MISMATCH", "Element UI 表格结构已变化，无法识别主播 ID 列。", {
      headers: extracted.headers
    });
  }
  const rows = extracted.rows.map((cells) => rowFromDom(extracted.headers, cells));
  return sanitizeExposedValue({
    rows,
    total: Number.isSafeInteger(extracted.total) ? extracted.total : null,
    page: extracted.currentPage,
    headers: extracted.headers,
    recognizedFields
  });
}

async function collectDomFallback(page, filters, options, apiError) {
  const extracted = await extractSvipElementUiPage(page);
  const items = extracted.rows.map((row, rowIndex) => mapLegacyAnchor(row, {
    sourceMode: "element_ui_dom_fallback",
    page: extracted.page,
    rowIndex
  }));
  const reportedTotal = extracted.total;
  const matched = reportedTotal !== null && reportedTotal === extracted.rows.length;
  const reason = items.length === 0
    ? "dom_no_visible_results"
    : matched
      ? "api_unavailable_dom_complete_page"
      : "api_unavailable_dom_partial_page";
  await reportBatch(options, {
    source: "svip_legacy",
    sourceMode: "element_ui_dom_fallback",
    page: extracted.page,
    received: items.length,
    reportedTotal,
    items,
    checkpoint: {
      adapterVersion: ADAPTER_VERSION,
      nextPage: matched ? null : ((extracted.page ?? 1) + 1),
      reportedTotal,
      sourceRowsFetched: extracted.rows.length
    }
  });
  await reportProgress(options, {
    phase: "completed",
    mode: "element_ui_dom_fallback",
    reason,
    collected: items.length,
    reportedTotal
  });
  return {
    source: "svip_legacy",
    sourceMode: "element_ui_dom_fallback",
    adapterVersion: ADAPTER_VERSION,
    complete: matched,
    reason,
    items,
    pagesFetched: items.length || reportedTotal === 0 ? 1 : 0,
    listArray: [],
    warnings: [{
      code: "SVIP_API_FALLBACK",
      message: apiError.message,
      causeCode: apiError.code,
      status: apiError.details?.status ?? null
    }],
    reconciliation: {
      reportedTotalInitial: reportedTotal,
      reportedTotalFinal: reportedTotal,
      totalsObserved: reportedTotal === null ? [] : [reportedTotal],
      totalStable: true,
      sourceRowsFetched: extracted.rows.length,
      returnedItems: items.length,
      delta: reportedTotal === null ? null : extracted.rows.length - reportedTotal,
      matched
    }
  };
}

export async function collectSvipLegacyAnchors(page, options = {}) {
  const currentUrl = assertTrustedPage(page).href;
  if (isSvipLegacyLoginUrl(currentUrl)) {
    throw new SvipLegacyError("SVIP_AUTH_REQUIRED", "请先在 svip 页面中完成登录。", { url: currentUrl });
  }
  const filters = options.filters ?? {};
  const startPage = Math.max(1, Math.trunc(Number(options.startPage ?? 1) || 1));
  const maxPages = options.maxPages === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.trunc(Number(options.maxPages) || 0));
  const maxItems = options.maxItems === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.trunc(Number(options.maxItems) || 0));
  const requestedPageSize = Math.min(1_000, Math.max(1, Math.trunc(Number(options.pageSize ?? 30) || 30)));
  const pageSize = requestedPageSize;
  const items = [];
  const pages = [];
  const initialReportedTotal = Number(options.initialReportedTotal);
  const totalsObserved = Number.isSafeInteger(initialReportedTotal) && initialReportedTotal >= 0 ? [initialReportedTotal] : [];
  const warnings = [];
  let pageNumber = startPage;
  let sourceRowsFetched = Math.max(0, Math.trunc(Number(options.initialSourceRowsFetched) || 0));
  let reason = "completed";
  let complete = false;
  let selectionComplete = false;
  let selectionTruncated = false;
  let listArray = [];

  if (maxPages === 0 || maxItems === 0) {
    return {
      source: "svip_legacy",
      sourceMode: "authenticated_same_origin_api",
      adapterVersion: ADAPTER_VERSION,
      complete: false,
      selectionComplete: maxItems === 0,
      reason: maxPages === 0 ? "max_pages_reached" : "max_items_reached",
      items,
      pagesFetched: 0,
      pages,
      listArray,
      warnings,
      reconciliation: {
        reportedTotalInitial: totalsObserved[0] ?? null,
        reportedTotalFinal: totalsObserved.at(-1) ?? null,
        totalsObserved,
        totalStable: true,
        sourceRowsFetched,
        returnedItems: 0,
        delta: totalsObserved.length ? sourceRowsFetched - totalsObserved.at(-1) : null,
        matched: false
      }
    };
  }

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const state = { page: pageNumber, collected: items.length, sourceRowsFetched, reportedTotal: totalsObserved.at(-1) ?? null };
    if (await cancellationRequested(options, state)) {
      reason = "cancelled";
      break;
    }
    await reportProgress(options, { phase: "fetching", ...state, pageSize });

    let result;
    try {
      result = await fetchSvipLegacyPage(page, filters, {
        page: pageNumber,
        limit: pageSize,
        region: options.region,
        requestTimeoutMs: options.requestTimeoutMs
      });
    } catch (error) {
      if (options.allowDomFallback !== false && pageIndex === 0 && fallbackEligible(error)) {
        return collectDomFallback(page, filters, options, error);
      }
      throw error;
    }

    totalsObserved.push(result.total);
    if (result.listArray.length) listArray = result.listArray;
    const mapped = result.rows.map((row, rowIndex) => mapLegacyAnchor(row, {
      sourceMode: "authenticated_same_origin_api",
      page: pageNumber,
      rowIndex
    }));
    const remaining = Number.isFinite(maxItems) ? Math.max(0, maxItems - items.length) : mapped.length;
    sourceRowsFetched += result.rows.length;
    const returnedBatch = Number.isFinite(maxItems) ? mapped.slice(0, remaining) : mapped;
    const selectionReached = Number.isFinite(maxItems) && items.length + returnedBatch.length >= maxItems;
    selectionTruncated ||= returnedBatch.length < mapped.length;
    items.push(...returnedBatch);
    pages.push({ page: pageNumber, received: returnedBatch.length, sourceRowsReceived: result.rows.length, reportedTotal: result.total });
    await reportBatch(options, {
      source: "svip_legacy",
      sourceMode: "authenticated_same_origin_api",
      page: pageNumber,
      received: returnedBatch.length,
      sourceRowsReceived: result.rows.length,
      reportedTotal: result.total,
      items: returnedBatch,
      checkpoint: {
        adapterVersion: ADAPTER_VERSION,
        nextPage: selectionReached ? null : pageNumber + 1,
        pageSize,
        reportedTotal: result.total,
        sourceRowsFetched,
        complete: false,
        selectionComplete: selectionReached
      }
    });
    await reportProgress(options, {
      phase: "page_collected",
      page: pageNumber,
      pageSize,
      received: returnedBatch.length,
      sourceRowsReceived: result.rows.length,
      collected: items.length,
      sourceRowsFetched,
      reportedTotal: result.total
    });

    if (result.total === 0 && sourceRowsFetched === 0) {
      reason = hasMeaningfulFilters(filters) ? "no_results_for_filters" : "legacy_source_empty";
      complete = true;
      break;
    }
    if (sourceRowsFetched > result.total) {
      reason = "source_rows_exceed_total";
      warnings.push({
        code: "SVIP_TOTAL_OVERRUN",
        message: "实收记录数超过接口 count，已停止并标记为未完成。",
        sourceRowsFetched,
        reportedTotal: result.total
      });
      break;
    }
    if (sourceRowsFetched === result.total) {
      if (selectionTruncated) {
        reason = "max_items_reached";
        selectionComplete = true;
      } else {
        reason = "completed";
        complete = true;
        selectionComplete = selectionReached;
      }
      break;
    }
    if (selectionReached) {
      reason = "max_items_reached";
      selectionComplete = true;
      break;
    }
    if (result.rows.length === 0 || result.rows.length < pageSize) {
      reason = "source_exhausted_before_total";
      break;
    }
    if (await cancellationRequested(options, {
      page: pageNumber,
      collected: items.length,
      sourceRowsFetched,
      reportedTotal: result.total
    })) {
      reason = "cancelled";
      break;
    }
    pageNumber += 1;
  }

  if (!complete && reason === "completed") reason = "max_pages_reached";
  const reportedTotalInitial = totalsObserved[0] ?? null;
  const reportedTotalFinal = totalsObserved.at(-1) ?? null;
  const totalStable = new Set(totalsObserved).size <= 1;
  const matched = complete && totalStable && reportedTotalFinal !== null && sourceRowsFetched === reportedTotalFinal;
  if (!totalStable) {
    warnings.push({
      code: "SVIP_TOTAL_CHANGED",
      message: "采集期间接口 count 发生变化，结果已保留但不视为严格对账完成。",
      totalsObserved: [...totalsObserved]
    });
    complete = false;
    if (reason === "completed") reason = "source_total_changed";
  }
  const reconciliation = {
    reportedTotalInitial,
    reportedTotalFinal,
    totalsObserved,
    totalStable,
    sourceRowsFetched,
    returnedItems: items.length,
    delta: reportedTotalFinal === null ? null : sourceRowsFetched - reportedTotalFinal,
    matched
  };
  await reportProgress(options, {
    phase: "completed",
    mode: "authenticated_same_origin_api",
    reason,
    complete,
    selectionComplete,
    collected: items.length,
    sourceRowsFetched,
    reportedTotal: reportedTotalFinal,
    reconciliation
  });

  return {
    source: "svip_legacy",
    sourceMode: "authenticated_same_origin_api",
    adapterVersion: ADAPTER_VERSION,
    complete,
    selectionComplete,
    reason,
    items,
    pagesFetched: pages.length,
    pages,
    listArray,
    warnings,
    reconciliation
  };
}

/**
 * Daemon-facing compatibility entry point. The checkpoint stores the next
 * whole source page; null means either source reconciliation or an explicitly
 * completed bounded selection, distinguished by complete/selectionComplete.
 */
export async function collectSvipLegacy({
  page,
  filters = {},
  maxPages,
  maxCandidates,
  checkpoint = {},
  onBatch,
  onProgress,
  shouldStop,
  signal,
  region,
  pageSize,
  allowDomFallback,
  requestTimeoutMs
} = {}) {
  if (checkpoint?.complete || checkpoint?.selectionComplete || checkpoint?.nextPage === null) {
    const reportedTotal = checkpoint?.reportedTotal ?? null;
    const sourceRowsFetched = Math.max(0, Math.trunc(Number(checkpoint?.sourceRowsFetched) || 0));
    const reconciliation = {
      reportedTotalInitial: reportedTotal,
      reportedTotalFinal: reportedTotal,
      totalsObserved: reportedTotal === null ? [] : [reportedTotal],
      totalStable: true,
      sourceRowsFetched,
      returnedItems: 0,
      delta: reportedTotal === null ? null : sourceRowsFetched - reportedTotal,
      matched: reportedTotal !== null && sourceRowsFetched === reportedTotal
    };
    return {
      source: "svip_legacy",
      sourceMode: "authenticated_same_origin_api",
      adapterVersion: ADAPTER_VERSION,
      complete: checkpoint?.complete === true,
      selectionComplete: checkpoint?.selectionComplete === true || checkpoint?.complete === true,
      reason: checkpoint?.reason ?? (checkpoint?.complete ? "checkpoint_complete" : "max_items_reached"),
      items: [],
      candidates: [],
      pagesFetched: 0,
      pages: [],
      listArray: [],
      warnings: [],
      reconciliation,
      checkpoint: {
        ...checkpoint,
        adapterVersion: ADAPTER_VERSION,
        nextPage: null,
        complete: checkpoint?.complete === true,
        selectionComplete: checkpoint?.selectionComplete === true || checkpoint?.complete === true
      }
    };
  }
  const startPage = Math.max(1, Math.trunc(Number(checkpoint?.nextPage ?? checkpoint?.page ?? 1) || 1));
  const requestedCandidateLimit = Math.max(0, Math.trunc(Number(maxCandidates) || 0));
  const defaultPageSize = requestedCandidateLimit > 0 ? Math.min(1_000, requestedCandidateLimit) : 30;
  const effectivePageSize = pageSize ?? checkpoint?.pageSize ?? defaultPageSize;
  const result = await collectSvipLegacyAnchors(page, {
    filters,
    startPage,
    pageSize: effectivePageSize,
    maxPages,
    maxItems: maxCandidates,
    initialSourceRowsFetched: checkpoint?.sourceRowsFetched,
    initialReportedTotal: checkpoint?.reportedTotal,
    onBatch,
    onProgress,
    shouldCancel: shouldStop,
    signal,
    region: region ?? checkpoint?.region,
    allowDomFallback,
    requestTimeoutMs
  });
  const lastPage = result.pages?.at(-1)?.page ?? startPage - 1;
  const nextPage = result.complete || result.selectionComplete ? null : Math.max(startPage, lastPage + 1);
  return {
    ...result,
    candidates: result.items,
    checkpoint: {
      adapterVersion: ADAPTER_VERSION,
      nextPage,
      pageSize: effectivePageSize,
      region: region ?? checkpoint?.region ?? filters.region ?? "",
      reportedTotal: result.reconciliation.reportedTotalFinal,
      sourceRowsFetched: result.reconciliation.sourceRowsFetched,
      complete: result.complete,
      selectionComplete: result.selectionComplete,
      reason: result.reason
    }
  };
}
