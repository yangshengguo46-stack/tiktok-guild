import { sanitizeTikTokText, sanitizeTikTokUrl, sanitizeTikTokValue } from "./tiktok-live.js";

export const COLLECTION_BACKSTAGE_ENDPOINT =
  "/creators/live/union_platform_api/agency/union_invite/batch_check_anchor/";
// Retained for source compatibility only. Startup preflight v4 reads the
// already-loaded portal state and never requests this retired route.
export const COLLECTION_BACKSTAGE_STARTUP_ENDPOINT = "/common/startup/?requestFrom=portal";
export const COLLECTION_BACKSTAGE_MAX_BATCH_SIZE = 30;
export const COLLECTION_BACKSTAGE_MANUAL_IMPORT_PROVENANCE =
  "official_collection_backstage_user_query";

const COLLECTION_BACKSTAGE_HOST = "live-backstage.tiktok.com";
const COLLECTION_BACKSTAGE_PATH = /^\/portal\/anchor\/relation\/?$/;
const HANDLE_PATTERN = /^[a-z\d._]{1,64}$/i;

const ANCHOR_STATUS = Object.freeze({
  0: "available",
  1: "not_found",
  2: "region_mismatch",
  3: "ineligible",
  4: "not_access_live",
  5: "unavailable",
  6: "invitation_type_not_available",
  7: "quota_limit"
});

const DISPLAY_REASON = Object.freeze({
  0: "unknown_reason",
  1: "followers_too_much",
  2: "already_signed",
  3: "other_reasons",
  4: "multiple_account_risk",
  5: "declined_by_location",
  6: "inappropriate_content",
  7: "insufficient_historical_content",
  8: "bric_risk",
  9: "invitation_in_process",
  10: "content_violation",
  // Current official portal enum, verified from its loaded static bundle.
  11: "identity_ineligible",
  12: "live_data_not_meet_requirement",
  13: "join_qualification_frozen",
  14: "account_performance_qualify_failed"
});

const INVITATION_TYPE = Object.freeze({
  0: "standard",
  1: "classic",
  2: "premium",
  3: "regular",
  4: "elite",
  5: "high_follower",
  6: "premium_ticket"
});

const LOCAL_ERROR_MESSAGES = Object.freeze({
  COLLECTION_NAVIGATION_BLOCKED: "采集子后台关系管理页未就绪",
  COLLECTION_FRONTEND_RUNTIME_MISSING: "采集子后台前端运行时尚未就绪",
  COLLECTION_ADAPTER_MISMATCH: "当前采集子后台前端版本与已验证适配器不匹配",
  COLLECTION_BACKSTAGE_PREFLIGHT_UNAVAILABLE: "未获取到可用的采集子后台账号与大区信息",
  COLLECTION_BACKSTAGE_REQUEST_TIMEOUT: "采集子后台请求超时；本次不会自动重试",
  COLLECTION_BACKSTAGE_REQUEST_FAILED: "采集子后台请求失败；本次不会自动重试"
});

export class CollectionBackstageError extends Error {
  constructor(message, code = "COLLECTION_BACKSTAGE_ERROR", details = null) {
    super(sanitizeTikTokText(message));
    this.name = "CollectionBackstageError";
    this.code = sanitizeTikTokText(code);
    this.details = sanitizeTikTokValue(details);
  }
}

function nullableInteger(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isSafeInteger(number) ? number : null;
}

function nullableBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function integerList(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.map(nullableInteger).filter((item) => item !== null))];
}

function unixSecondsToIso(value) {
  const seconds = nullableInteger(value);
  if (seconds === null || seconds <= 0) return null;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeStartupMarketRegion(value, { expected = false } = {}) {
  if (typeof value !== "string") {
    throw new CollectionBackstageError(
      expected ? "预期采集大区无效" : LOCAL_ERROR_MESSAGES.COLLECTION_BACKSTAGE_PREFLIGHT_UNAVAILABLE,
      "COLLECTION_BACKSTAGE_PREFLIGHT_UNAVAILABLE"
    );
  }
  const firstSegment = value.trim().split("+", 1)[0].trim();
  const normalized = firstSegment === "中国台湾" ? "TW" : firstSegment.toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{1,31}$/.test(normalized)) {
    throw new CollectionBackstageError(
      expected ? "预期采集大区无效" : LOCAL_ERROR_MESSAGES.COLLECTION_BACKSTAGE_PREFLIGHT_UNAVAILABLE,
      "COLLECTION_BACKSTAGE_PREFLIGHT_UNAVAILABLE"
    );
  }
  return normalized;
}

function normalizeObservedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new CollectionBackstageError(
      "采集子后台预检时间无效",
      "COLLECTION_ADAPTER_MISMATCH"
    );
  }
  return date.toISOString();
}

export function isAllowedCollectionBackstageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === COLLECTION_BACKSTAGE_HOST
      && COLLECTION_BACKSTAGE_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

export function normalizeCollectionHandle(value) {
  const handle = String(value ?? "").trim().normalize("NFKC").replace(/^@+/, "");
  return HANDLE_PATTERN.test(handle) ? handle : null;
}

export function normalizeCollectionHandles(values) {
  if (!Array.isArray(values)) {
    throw new CollectionBackstageError("主播账号列表必须是数组", "INVALID_COLLECTION_HANDLES");
  }
  const unique = new Map();
  for (const value of values) {
    const handle = normalizeCollectionHandle(value);
    if (!handle) {
      throw new CollectionBackstageError("主播账号格式无效", "INVALID_COLLECTION_HANDLE");
    }
    if (!unique.has(handle.toLowerCase())) unique.set(handle.toLowerCase(), handle);
  }
  const handles = [...unique.values()];
  if (!handles.length) {
    throw new CollectionBackstageError("至少需要 1 个已采集主播账号", "EMPTY_COLLECTION_BATCH");
  }
  if (handles.length > COLLECTION_BACKSTAGE_MAX_BATCH_SIZE) {
    throw new CollectionBackstageError(
      `采集子后台每次最多核验 ${COLLECTION_BACKSTAGE_MAX_BATCH_SIZE} 个主播`,
      "COLLECTION_BATCH_TOO_LARGE",
      { maximum: COLLECTION_BACKSTAGE_MAX_BATCH_SIZE, received: handles.length }
    );
  }
  return handles;
}

/**
 * Normalize structured rows that a user copied from a manual query in the
 * official collection sub-backend. This function never opens a browser or
 * performs a network request. Numeric official codes are the source of truth;
 * mapped labels are derived locally so a caller cannot submit a contradictory
 * status label.
 */
export function normalizeManualCollectionBackstageResults(
  values,
  { observedAt = new Date().toISOString() } = {}
) {
  if (!Array.isArray(values) || values.length < 1 || values.length > COLLECTION_BACKSTAGE_MAX_BATCH_SIZE) {
    throw new CollectionBackstageError(
      `人工资格结果必须包含 1 到 ${COLLECTION_BACKSTAGE_MAX_BATCH_SIZE} 个主播`,
      "INVALID_MANUAL_QUALIFICATION_BATCH"
    );
  }
  const defaultObservedAt = normalizeObservedAt(observedAt);
  const seen = new Set();
  const strictInvitationCodes = (value, fieldName) => {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value)) {
      throw new CollectionBackstageError(
        `人工资格结果的 ${fieldName} 必须是数组`,
        "INVALID_MANUAL_QUALIFICATION_RESULT"
      );
    }
    const codes = value.map(nullableInteger);
    if (codes.some((code) => code === null || !Object.hasOwn(INVITATION_TYPE, code))) {
      throw new CollectionBackstageError(
        `人工资格结果包含未知的 ${fieldName} 代码`,
        "INVALID_MANUAL_QUALIFICATION_RESULT"
      );
    }
    return [...new Set(codes)];
  };

  return values.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new CollectionBackstageError(
        "人工资格结果必须是结构化对象",
        "INVALID_MANUAL_QUALIFICATION_RESULT"
      );
    }
    const handle = normalizeCollectionHandle(row.handle);
    if (!handle) {
      throw new CollectionBackstageError(
        "人工资格结果包含无效的 TikTok 用户名",
        "INVALID_MANUAL_QUALIFICATION_HANDLE"
      );
    }
    const handleKey = handle.toLocaleLowerCase("en-US");
    if (seen.has(handleKey)) {
      throw new CollectionBackstageError(
        "人工资格结果包含重复的 TikTok 用户名",
        "DUPLICATE_MANUAL_QUALIFICATION_HANDLE"
      );
    }
    seen.add(handleKey);

    const anchorStatusCode = nullableInteger(row.anchorStatusCode);
    if (anchorStatusCode === null || !Object.hasOwn(ANCHOR_STATUS, anchorStatusCode)) {
      throw new CollectionBackstageError(
        "人工资格结果包含未知的 AnchorStatus；本批次没有写入",
        "INVALID_MANUAL_QUALIFICATION_STATUS"
      );
    }
    const displayReasonCode = row.displayReasonCode === undefined || row.displayReasonCode === null
      ? null
      : nullableInteger(row.displayReasonCode);
    if (row.displayReasonCode !== undefined
      && row.displayReasonCode !== null
      && (displayReasonCode === null || !Object.hasOwn(DISPLAY_REASON, displayReasonCode))) {
      throw new CollectionBackstageError(
        "人工资格结果包含未知的 DisplayReason；本批次没有写入",
        "INVALID_MANUAL_QUALIFICATION_REASON"
      );
    }
    const canUseInvitationTypeCodes = strictInvitationCodes(
      row.canUseInvitationTypeCodes,
      "canUseInvitationTypeCodes"
    );
    const popupInvitationTypeCodes = strictInvitationCodes(
      row.popupInvitationTypeCodes,
      "popupInvitationTypeCodes"
    );
    const itemObservedAt = row.observedAt === undefined || row.observedAt === null
      ? defaultObservedAt
      : normalizeObservedAt(row.observedAt);
    return {
      handle,
      handleKey,
      qualificationStatus: qualificationStatus(anchorStatusCode),
      eligible: invitationEligibility(anchorStatusCode),
      anchorStatusCode,
      displayReasonCode,
      displayReason: displayReason(displayReasonCode),
      canUseInvitationTypeCodes,
      canUseInvitationTypes: invitationTypes(canUseInvitationTypeCodes),
      popupInvitationTypeCodes,
      popupInvitationTypes: invitationTypes(popupInvitationTypeCodes),
      observedAt: itemObservedAt,
      source: "collection_backstage",
      importMode: "manual_import",
      provenance: COLLECTION_BACKSTAGE_MANUAL_IMPORT_PROVENANCE
    };
  });
}

function qualificationStatus(code) {
  return ANCHOR_STATUS[code] ?? (code === null ? "unknown" : `unknown_status_${code}`);
}

function invitationEligibility(code) {
  if (code === 0) return true;
  if (code >= 1 && code <= 6) return false;
  return null;
}

function displayReason(code) {
  return DISPLAY_REASON[code] ?? (code === null ? null : `unknown_reason_${code}`);
}

function invitationTypes(codes) {
  if (codes === null) return null;
  return codes.map((code) => INVITATION_TYPE[code] ?? `unknown_type_${code}`);
}

export function normalizeCollectionBackstageProjection(projected, requestedHandles, observedAt = new Date().toISOString()) {
  const handles = normalizeCollectionHandles(requestedHandles);
  if (!projected || typeof projected !== "object") {
    throw new CollectionBackstageError("采集子后台返回了无法识别的响应", "COLLECTION_ADAPTER_MISMATCH");
  }
  if (projected.verificationRequired === true) {
    throw new CollectionBackstageError(
      "采集子后台要求人工安全验证；系统不会尝试绕过",
      "manual_verification",
      {
        verificationRenderCalled: projected.verificationRenderCalled === true,
        verificationPresented: projected.verificationPresented === true
      }
    );
  }
  if (projected.ok !== true) {
    const code = Object.hasOwn(LOCAL_ERROR_MESSAGES, projected.code)
      ? projected.code
      : "COLLECTION_BACKSTAGE_REQUEST_FAILED";
    throw new CollectionBackstageError(
      LOCAL_ERROR_MESSAGES[code],
      code,
      { httpStatus: nullableInteger(projected.httpStatus), statusCode: nullableInteger(projected.statusCode) }
    );
  }

  const statusCode = nullableInteger(projected.statusCode);
  if (statusCode !== 0) {
    throw new CollectionBackstageError(
      `采集子后台返回业务错误 ${statusCode ?? "unknown"}`,
      "COLLECTION_BACKSTAGE_BUSINESS_ERROR",
      { httpStatus: nullableInteger(projected.httpStatus), statusCode }
    );
  }
  if (!Array.isArray(projected.rows)) {
    throw new CollectionBackstageError("采集子后台响应缺少主播核验列表", "COLLECTION_ADAPTER_MISMATCH");
  }

  const requested = new Map(handles.map((handle) => [handle.toLowerCase(), handle]));
  const returned = new Set();
  const results = [];
  for (const row of projected.rows) {
    const normalized = normalizeCollectionHandle(row?.displayId);
    if (!normalized || !requested.has(normalized.toLowerCase())) {
      throw new CollectionBackstageError(
        "采集子后台返回了请求范围外的主播记录",
        "COLLECTION_ADAPTER_MISMATCH"
      );
    }
    const normalizedKey = normalized.toLowerCase();
    if (returned.has(normalizedKey)) {
      throw new CollectionBackstageError(
        "采集子后台为同一主播返回了重复记录",
        "COLLECTION_ADAPTER_MISMATCH"
      );
    }
    returned.add(normalizedKey);

    const anchorStatusCode = nullableInteger(row.anchorStatus);
    if (anchorStatusCode === null) {
      throw new CollectionBackstageError(
        "采集子后台主播记录缺少资格状态；本批次没有写入",
        "COLLECTION_ADAPTER_MISMATCH"
      );
    }
    if (!Object.hasOwn(ANCHOR_STATUS, anchorStatusCode)) {
      throw new CollectionBackstageError(
        "采集子后台返回了未知资格状态；本批次没有写入",
        "COLLECTION_ADAPTER_MISMATCH",
        { anchorStatusCode }
      );
    }
    const displayReasonCode = nullableInteger(row.displayReason);
    const canUseInvitationTypeCodes = integerList(row.canUseInvitationTypes);
    const popupInvitationTypeCodes = integerList(row.popupInvitationTypes);
    const status = qualificationStatus(anchorStatusCode);
    results.push({
      handle: requested.get(normalizedKey),
      qualificationStatus: status,
      // quota_limit means the qualification was not determined. It must not
      // be collapsed into a negative creator-eligibility decision.
      eligible: invitationEligibility(anchorStatusCode),
      anchorStatusCode,
      displayReasonCode,
      displayReason: displayReason(displayReasonCode),
      canUseInvitationTypeCodes,
      canUseInvitationTypes: invitationTypes(canUseInvitationTypeCodes),
      popupInvitationTypeCodes,
      popupInvitationTypes: invitationTypes(popupInvitationTypeCodes),
      trialLiveEndAt: unixSecondsToIso(row.trialLiveEndTimestamp),
      flags: {
        hasBricRisk: nullableBoolean(row.hasBricRisk),
        isFollow: nullableBoolean(row.isFollow),
        noPermission: nullableBoolean(row.noPermission),
        inEmergency: nullableBoolean(row.inEmergency),
        multiAccountNotMeetBasicQualification: nullableBoolean(row.multiAccountNotMeetBasicQualification)
      },
      source: "collection_backstage",
      sourceUrl: `https://${COLLECTION_BACKSTAGE_HOST}/portal/anchor/relation`,
      observedAt,
      confidence: 1
    });
  }

  const missingHandles = handles.filter((handle) => !returned.has(handle.toLowerCase()));
  if (missingHandles.length) {
    throw new CollectionBackstageError(
      "采集子后台未返回完整的主播核验结果；本批次没有写入",
      "COLLECTION_INCOMPLETE_RESPONSE",
      { requested: handles.length, returned: results.length, missing: missingHandles.length }
    );
  }
  return sanitizeTikTokValue({
    schemaVersion: "tkdesk.collection-qualification.v1",
    adapterVersion: "collection-backstage.v2",
    transportMode: "pinned-config-direct-axios",
    endpoint: COLLECTION_BACKSTAGE_ENDPOINT,
    requestCount: 1,
    requested: handles.length,
    returned: results.length,
    missingHandles,
    accountState: {
      isBanned: nullableBoolean(projected.accountState?.isBanned),
      dontHaveInviteBenefit: nullableBoolean(projected.accountState?.dontHaveInviteBenefit),
      testAccountLimit: nullableBoolean(projected.accountState?.testAccountLimit)
    },
    results
  });
}

export function normalizeCollectionBackstageStartupProjection(
  projected,
  { expectedMarketRegion, observedAt = new Date().toISOString() } = {}
) {
  const expected = normalizeStartupMarketRegion(expectedMarketRegion, { expected: true });
  if (!projected || typeof projected !== "object" || Array.isArray(projected)) {
    throw new CollectionBackstageError(
      "采集子后台返回了无法识别的启动信息",
      "COLLECTION_ADAPTER_MISMATCH"
    );
  }
  if (projected.verificationRequired === true) {
    throw new CollectionBackstageError(
      "采集子后台要求人工安全验证；系统不会尝试绕过或重试",
      "manual_verification",
      { verificationPresented: false }
    );
  }
  if (projected.ok !== true) {
    const code = Object.hasOwn(LOCAL_ERROR_MESSAGES, projected.code)
      ? projected.code
      : "COLLECTION_BACKSTAGE_REQUEST_FAILED";
    throw new CollectionBackstageError(
      LOCAL_ERROR_MESSAGES[code],
      code,
      { httpStatus: nullableInteger(projected.httpStatus), statusCode: nullableInteger(projected.statusCode) }
    );
  }

  for (const field of [
    "accountAvailable",
    "accountIdentityPresent",
    "unionIdentityPresent",
    "appIdentityPresent"
  ]) {
    if (typeof projected[field] !== "boolean") {
      throw new CollectionBackstageError(
        "采集子后台启动信息投影与已验证适配器不匹配",
        "COLLECTION_ADAPTER_MISMATCH"
      );
    }
  }

  const httpStatus = nullableInteger(projected.httpStatus);
  const statusCode = nullableInteger(projected.statusCode);
  if ((projected.httpStatus !== null && projected.httpStatus !== undefined && httpStatus === null)
    || (projected.statusCode !== null && projected.statusCode !== undefined && statusCode === null)) {
    throw new CollectionBackstageError(
      "采集子后台启动状态与已验证适配器不匹配",
      "COLLECTION_ADAPTER_MISMATCH"
    );
  }
  if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)) {
    throw new CollectionBackstageError(
      LOCAL_ERROR_MESSAGES.COLLECTION_BACKSTAGE_REQUEST_FAILED,
      "COLLECTION_BACKSTAGE_REQUEST_FAILED",
      { httpStatus, statusCode }
    );
  }
  if (statusCode !== null && statusCode !== 0) {
    throw new CollectionBackstageError(
      LOCAL_ERROR_MESSAGES.COLLECTION_BACKSTAGE_PREFLIGHT_UNAVAILABLE,
      "COLLECTION_BACKSTAGE_PREFLIGHT_UNAVAILABLE",
      { httpStatus, statusCode }
    );
  }
  if (projected.accountAvailable !== true || projected.accountIdentityPresent !== true) {
    throw new CollectionBackstageError(
      LOCAL_ERROR_MESSAGES.COLLECTION_BACKSTAGE_PREFLIGHT_UNAVAILABLE,
      "COLLECTION_BACKSTAGE_PREFLIGHT_UNAVAILABLE",
      {
        accountAvailable: projected.accountAvailable,
        accountIdentityPresent: projected.accountIdentityPresent,
        unionIdentityPresent: projected.unionIdentityPresent,
        appIdentityPresent: projected.appIdentityPresent
      }
    );
  }

  const observed = normalizeStartupMarketRegion(projected.observedMarketRegion);
  if (observed !== expected) {
    throw new CollectionBackstageError(
      "采集子后台大区与当前任务大区不一致",
      "COLLECTION_BACKSTAGE_MARKET_MISMATCH",
      {
        expectedMarketRegion: expected,
        observedMarketRegion: observed,
        accountAvailable: true
      }
    );
  }

  return sanitizeTikTokValue({
    schemaVersion: "tkdesk.collection-backstage-preflight.v1",
    adapterVersion: "collection-backstage-startup.v4",
    transportMode: "pinned-portal-redux-state",
    expectedMarketRegion: expected,
    observedMarketRegion: observed,
    regionMatched: true,
    accountAvailable: true,
    accountIdentityPresent: projected.accountIdentityPresent,
    unionIdentityPresent: projected.unionIdentityPresent,
    appIdentityPresent: projected.appIdentityPresent,
    qualificationRequestConsumed: false,
    observedAt: normalizeObservedAt(observedAt)
  });
}

export async function inspectCollectionBackstageStartup({
  page,
  expectedMarketRegion,
  observedAt = new Date().toISOString()
}) {
  if (!page || typeof page.url !== "function" || typeof page.evaluate !== "function") {
    throw new CollectionBackstageError("采集子后台页面对象不可用", "COLLECTION_PAGE_UNAVAILABLE");
  }
  if (!isAllowedCollectionBackstageUrl(page.url())) {
    throw new CollectionBackstageError(
      `采集子后台只允许在关系管理页执行启动预检：${sanitizeTikTokUrl(page.url())}`,
      "COLLECTION_NAVIGATION_BLOCKED"
    );
  }

  // Current LIVE Backstage exposes the authenticated portal state through
  // its Redux store. Read it in-page and return only region plus presence
  // booleans; account identifiers never cross the browser boundary and this
  // preflight performs zero network requests.
  const projected = await page.evaluate(() => {
    const hasOpaqueIdentity = (value) => {
      if (typeof value === "string") return value.trim().length > 0;
      return typeof value === "number" && Number.isFinite(value);
    };
    try {
      if (location.protocol !== "https:"
        || location.hostname.toLowerCase() !== "live-backstage.tiktok.com"
        || !/^\/portal\/anchor\/relation\/?$/.test(location.pathname)) {
        return { ok: false, code: "COLLECTION_NAVIGATION_BLOCKED" };
      }
      const store = window.__portalStore;
      if (!store
        || typeof store !== "object"
        || typeof store.dispatch !== "function"
        || typeof store.subscribe !== "function"
        || typeof store.getState !== "function"
        || typeof store.replaceReducer !== "function") {
        return { ok: false, code: "COLLECTION_ADAPTER_MISMATCH" };
      }
      const state = store.getState();
      const root = state?.root && typeof state.root === "object" && !Array.isArray(state.root)
        ? state.root
        : null;
      if (!root) return { ok: false, code: "COLLECTION_ADAPTER_MISMATCH" };

      const user = root.user && typeof root.user === "object" && !Array.isArray(root.user)
        ? root.user
        : null;
      const observedMarketRegion = typeof root.visitorRegion === "string"
        ? root.visitorRegion
        : null;
      const accountIdentityPresent = hasOpaqueIdentity(user?.email)
        && hasOpaqueIdentity(user?.id);
      const unionIdentityPresent = hasOpaqueIdentity(user?.unionID ?? user?.unionId);
      const appIdentityPresent = hasOpaqueIdentity(root.appId);
      return {
        ok: true,
        httpStatus: null,
        statusCode: null,
        observedMarketRegion,
        accountAvailable: user !== null
          && observedMarketRegion !== null
          && accountIdentityPresent,
        accountIdentityPresent,
        unionIdentityPresent,
        appIdentityPresent
      };
    } catch {
      return { ok: false, code: "COLLECTION_ADAPTER_MISMATCH" };
    }
  });

  return normalizeCollectionBackstageStartupProjection(projected, {
    expectedMarketRegion,
    observedAt
  });
}

/**
 * Probe the qualification adapter without issuing a qualification request.
 * The browser returns only a fixed failure-stage enum, never module source,
 * request headers, identity, or the computed request configuration.
 */
export async function inspectCollectionBackstageCompatibility({ page }) {
  if (!page || typeof page.url !== "function" || typeof page.evaluate !== "function") {
    throw new CollectionBackstageError("采集子后台页面对象不可用", "COLLECTION_PAGE_UNAVAILABLE");
  }
  if (!isAllowedCollectionBackstageUrl(page.url())) {
    throw new CollectionBackstageError(
      `采集子后台只允许在关系管理页执行兼容性预检：${sanitizeTikTokUrl(page.url())}`,
      "COLLECTION_NAVIGATION_BLOCKED"
    );
  }

  const projected = await page.evaluate(({ endpoint }) => {
    const fail = (failureStage) => ({ ready: false, failureStage });
    try {
      if (location.protocol !== "https:"
        || location.hostname.toLowerCase() !== "live-backstage.tiktok.com"
        || !/^\/portal\/anchor\/relation\/?$/.test(location.pathname)) {
        return fail("navigation");
      }
      const chunks = window["@live-backstage/client"];
      if (!Array.isArray(chunks)) return fail("runtime");
      let runtime;
      chunks.push([[Date.now()], {}, (value) => { runtime = value; }]);
      if (!runtime || !runtime.m) return fail("runtime");

      const factories = runtime.m;
      const definitions = {
        endpoint: String(factories[54026] ?? ""),
        officialApi: String(factories[29975] ?? ""),
        requestConfig: String(factories[76891] ?? ""),
        axios: String(factories[75740] ?? ""),
        axiosInstance: String(factories[87662] ?? ""),
        axiosDefaults: String(factories[96555] ?? ""),
        xhrAdapter: String(factories[10252] ?? ""),
        verification: String(factories[62636] ?? "")
      };
      if (!factories[54026]
        || !definitions.endpoint.includes(endpoint)
        || !definitions.endpoint.includes("v_")
        || !definitions.endpoint.includes("NeedAxiosResultRequest")) return fail("endpoint_definition");
      if (!factories[29975] || !definitions.officialApi.includes(endpoint)) return fail("official_api_definition");
      if (!factories[76891]
        || !definitions.requestConfig.includes("x-csrf-token")
        || !definitions.requestConfig.includes("faction-id")
        || !definitions.requestConfig.includes("timeout:16e3")) return fail("request_config_definition");
      if (!factories[75740]
        || !factories[87662]
        || !factories[96555]
        || !factories[10252]
        || !definitions.axios.includes("87662")
        || !definitions.axiosInstance.includes("96555")
        || !definitions.axiosDefaults.includes("adapter:")
        || !definitions.axiosDefaults.includes("10252")
        || !definitions.xhrAdapter.includes("XMLHttpRequest")
        || !definitions.xhrAdapter.includes(".send(")) return fail("transport_definition");
      const verificationDefinitionPinned = Boolean(factories[62636])
        && definitions.verification.includes("captchaOptions")
        && definitions.verification.includes("showMode");

      const officialRequest = runtime(29975)?.WY?.HostPack_BatchCheckAnchor;
      const buildRequestConfig = runtime(76891)?.v_;
      const axiosModule = runtime(75740);
      const axios = typeof axiosModule?.default === "function"
        ? axiosModule.default
        : (typeof axiosModule === "function" ? axiosModule : null);
      const xhrAdapter = runtime(10252);
      if (typeof officialRequest !== "function") return fail("official_request_export");
      if (typeof buildRequestConfig !== "function") return fail("request_config_export");
      if (typeof axios !== "function") return fail("axios_export");
      if (axios.VERSION !== "0.27.2") return fail("axios_version");
      if (typeof xhrAdapter !== "function") return fail("xhr_adapter_export");
      const verificationModule = verificationDefinitionPinned ? runtime(62636) : null;
      const verificationPresentationReady = verificationDefinitionPinned
        && typeof verificationModule?.t === "function";
      const verificationExportShape = verificationPresentationReady ? null
        : Object.keys(verificationModule ?? {})
            .filter((name) => /^[A-Za-z_$][\w$]{0,31}$/.test(name))
            .slice(0, 8)
            .map((name) => ({ name, type: typeof verificationModule[name] }));
      const transportReady = () => Array.isArray(axios.interceptors?.request?.handlers)
        && axios.interceptors.request.handlers.length === 0
        && Array.isArray(axios.interceptors?.response?.handlers)
        && axios.interceptors.response.handlers.length === 0
        && axios === runtime(87662)
        && axios.defaults?.adapter === xhrAdapter
        && [undefined, null, ""].includes(axios.defaults?.baseURL);
      if (!transportReady()) return fail("transport_defaults");

      const displayIds = ["tkdesk_preflight"];
      const config = buildRequestConfig(endpoint, { DisplayIDList: displayIds }, {
        headers: { "content-type": "application/json" }
      });
      if (!config
        || String(config.method).toLowerCase() !== "post"
        || config.url !== endpoint
        || !Array.isArray(config.data?.DisplayIDList)
        || config.data.DisplayIDList.length !== 1
        || config.data.DisplayIDList[0] !== displayIds[0]
        || config.adapter !== undefined
        || ![undefined, null, ""].includes(config.baseURL)
        || !config.headers
        || typeof config.headers !== "object"
        || Array.isArray(config.headers)) return fail("request_config");
      if (!transportReady()) return fail("transport_changed_during_probe");
      return { ready: true, failureStage: null, verificationPresentationReady, verificationExportShape };
    } catch {
      return fail("probe_exception");
    }
  }, { endpoint: COLLECTION_BACKSTAGE_ENDPOINT });

  const allowedStages = new Set([
    "navigation", "runtime", "endpoint_definition", "official_api_definition",
    "request_config_definition", "transport_definition", "verification_definition",
    "official_request_export", "request_config_export", "axios_export",
    "axios_version", "xhr_adapter_export", "verification_export",
    "transport_defaults", "request_config",
    "transport_changed_during_probe", "probe_exception"
  ]);
  const ready = projected?.ready === true && projected.failureStage === null;
  const verificationExportShape = projected?.verificationPresentationReady === false
    && Array.isArray(projected.verificationExportShape)
    ? projected.verificationExportShape.slice(0, 8)
      .filter((entry) => /^[A-Za-z_$][\w$]{0,31}$/.test(entry?.name)
        && ["function", "object", "undefined", "string", "number", "boolean"].includes(entry?.type))
      .map(({ name, type }) => ({ name, type }))
    : null;
  return {
    adapterVersion: "collection-backstage-qualification.v1",
    ready,
    failureStage: ready ? null : (allowedStages.has(projected?.failureStage)
      ? projected.failureStage : "probe_exception"),
    qualificationRequestConsumed: false,
    ...(typeof projected?.verificationPresentationReady === "boolean"
      ? { verificationPresentationReady: projected.verificationPresentationReady } : {}),
    ...(verificationExportShape === null ? {} : { verificationExportShape })
  };
}

export async function batchCheckCollectionBackstage({ page, handles, observedAt = new Date().toISOString() }) {
  if (!page || typeof page.url !== "function" || typeof page.evaluate !== "function") {
    throw new CollectionBackstageError("采集子后台页面对象不可用", "COLLECTION_PAGE_UNAVAILABLE");
  }
  if (!isAllowedCollectionBackstageUrl(page.url())) {
    throw new CollectionBackstageError(
      `采集子后台只允许在关系管理页执行只读核验：${sanitizeTikTokUrl(page.url())}`,
      "COLLECTION_NAVIGATION_BLOCKED"
    );
  }
  const normalizedHandles = normalizeCollectionHandles(handles);

  // The browser projection is intentionally a strict allowlist. Raw Axios
  // responses contain UserID, SearchID, avatars, signed URLs, and headers;
  // none of those values are allowed to cross the page/Node boundary.
  let projected = await page.evaluate(async ({ endpoint, displayIds }) => {
    const boolOrNull = (value) => typeof value === "boolean" ? value : null;
    const intOrNull = (value) => {
      if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
      if (typeof value !== "string") return null;
      const normalized = value.trim();
      if (!/^-?\d+$/.test(normalized)) return null;
      const number = Number(normalized);
      return Number.isSafeInteger(number) ? number : null;
    };
    const intArrayOrNull = (value) => Array.isArray(value)
      ? value.map(intOrNull).filter((item) => item !== null)
      : null;
    const headerValue = (headers, name) => {
      if (!headers) return null;
      if (typeof headers.get === "function") return headers.get(name);
      const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
      return key ? headers[key] : null;
    };
    try {
      if (location.protocol !== "https:"
        || location.hostname.toLowerCase() !== "live-backstage.tiktok.com"
        || !/^\/portal\/anchor\/relation\/?$/.test(location.pathname)) {
        return { ok: false, code: "COLLECTION_NAVIGATION_BLOCKED", message: "关系管理页未就绪" };
      }
      delete window[Symbol.for("tkdesk.collection.verification-decision")];
      const chunks = window["@live-backstage/client"];
      if (!Array.isArray(chunks)) {
        return { ok: false, code: "COLLECTION_FRONTEND_RUNTIME_MISSING", message: "前端运行时尚未就绪" };
      }
      let runtime;
      chunks.push([[Date.now()], {}, (value) => { runtime = value; }]);
      if (!runtime || !runtime.m) {
        return { ok: false, code: "COLLECTION_FRONTEND_RUNTIME_MISSING", message: "无法连接前端只读请求层" };
      }

      // These module IDs and export names are intentionally pinned to the
      // LIVE Backstage build validated for this adapter version. A new build
      // must fail closed and be reviewed instead of scanning/executing unknown
      // modules or falling back to an arbitrary fetch.
      const endpointDefinitionFactory = runtime.m[54026];
      const officialApiFactory = runtime.m[29975];
      const requestConfigFactory = runtime.m[76891];
      const axiosFactory = runtime.m[75740];
      const axiosInstanceFactory = runtime.m[87662];
      const axiosDefaultsFactory = runtime.m[96555];
      const xhrAdapterFactory = runtime.m[10252];
      const endpointDefinition = String(endpointDefinitionFactory ?? "");
      const officialApiDefinition = String(officialApiFactory ?? "");
      const requestConfigDefinition = String(requestConfigFactory ?? "");
      const axiosDefinition = String(axiosFactory ?? "");
      const axiosInstanceDefinition = String(axiosInstanceFactory ?? "");
      const axiosDefaultsDefinition = String(axiosDefaultsFactory ?? "");
      const xhrAdapterDefinition = String(xhrAdapterFactory ?? "");
      if (!endpointDefinitionFactory
        || !officialApiFactory
        || !requestConfigFactory
        || !axiosFactory
        || !axiosInstanceFactory
        || !axiosDefaultsFactory
        || !xhrAdapterFactory
        || !endpointDefinition.includes(endpoint)
        || !endpointDefinition.includes("v_")
        || !endpointDefinition.includes("NeedAxiosResultRequest")
        || !officialApiDefinition.includes(endpoint)
        || !requestConfigDefinition.includes("x-csrf-token")
        || !requestConfigDefinition.includes("faction-id")
        || !requestConfigDefinition.includes("timeout:16e3")
        || !axiosDefinition.includes("87662")
        || !axiosInstanceDefinition.includes("96555")
        || !axiosDefaultsDefinition.includes("adapter:")
        || !axiosDefaultsDefinition.includes("10252")
        || !xhrAdapterDefinition.includes("XMLHttpRequest")
        || !xhrAdapterDefinition.includes(".send(")) {
        return { ok: false, code: "COLLECTION_ADAPTER_MISMATCH", message: "当前前端版本与已验证的资格核验适配器不匹配" };
      }
      const officialRequest = runtime(29975)?.WY?.HostPack_BatchCheckAnchor;
      const buildRequestConfig = runtime(76891)?.v_;
      const axiosModule = runtime(75740);
      const axios = typeof axiosModule?.default === "function"
        ? axiosModule.default
        : (typeof axiosModule === "function" ? axiosModule : null);
      const pinnedAxios = runtime(87662);
      const xhrAdapter = runtime(10252);
      const transportStateIsPinned = () => {
        const requestHandlers = axios?.interceptors?.request?.handlers;
        const responseHandlers = axios?.interceptors?.response?.handlers;
        return Array.isArray(requestHandlers)
          && requestHandlers.length === 0
          && Array.isArray(responseHandlers)
          && responseHandlers.length === 0
          && axios === pinnedAxios
          && typeof xhrAdapter === "function"
          && axios?.defaults?.adapter === xhrAdapter
          && (axios?.defaults?.baseURL === undefined
            || axios.defaults.baseURL === null
            || axios.defaults.baseURL === "");
      };
      if (typeof officialRequest !== "function"
        || typeof buildRequestConfig !== "function"
        || typeof axios !== "function"
        || axios.VERSION !== "0.27.2"
        || !transportStateIsPinned()) {
        return { ok: false, code: "COLLECTION_ADAPTER_MISMATCH", message: "当前前端只读请求函数不可用" };
      }

      const config = buildRequestConfig(
        endpoint,
        { DisplayIDList: displayIds },
        { headers: { "content-type": "application/json" } }
      );
      if (!config
        || String(config.method).toLowerCase() !== "post"
        || config.url !== endpoint
        || !config.data
        || !Array.isArray(config.data.DisplayIDList)
        || config.data.DisplayIDList.length !== displayIds.length
        || config.data.DisplayIDList.some((value, index) => value !== displayIds[index])
        || config.adapter !== undefined
        || ![undefined, null, ""].includes(config.baseURL)
        || !config.headers
        || typeof config.headers !== "object"
        || Array.isArray(config.headers)
        || !transportStateIsPinned()) {
        return { ok: false, code: "COLLECTION_ADAPTER_MISMATCH", message: "当前前端请求配置与已验证适配器不匹配" };
      }

      // Call the same pinned Axios transport used by the official frontend,
      // but deliberately skip its global verification handler: that handler
      // automatically replays the request after a CAPTCHA succeeds. TKDesk
      // must spend at most one batch allowance per explicit tool invocation.
      const controller = new AbortController();
      let timeoutId;
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error("request timeout"), {
            code: "COLLECTION_BACKSTAGE_REQUEST_TIMEOUT"
          }));
        }, 20_000);
      });
      const requestConfig = {
        method: "post",
        url: endpoint,
        headers: { ...config.headers },
        timeout: 16_000,
        params: {},
        data: { DisplayIDList: [...displayIds] },
        signal: controller.signal,
        // Pin the exact verified browser XHR adapter. The untrusted config
        // builder is not allowed to supply an adapter or destination base URL.
        adapter: xhrAdapter
      };
      let response;
      try {
        if (!transportStateIsPinned()) {
          return { ok: false, code: "COLLECTION_ADAPTER_MISMATCH", message: "采集子后台传输状态在发送前发生变化" };
        }
        response = await Promise.race([axios(requestConfig), timeout]);
      } catch (error) {
        if (!error?.response) throw error;
        response = error.response;
      } finally {
        clearTimeout(timeoutId);
      }
      const headers = response?.headers ?? null;
      const rawEnvelope = response?.data && typeof response.data === "object" ? response.data : null;
      const blockData = rawEnvelope?.data?.block_data ?? rawEnvelope?.BlockData ?? null;
      const verificationDecision = headerValue(headers, "bdturing-verify")
        ?? (blockData?.type === "verify" ? blockData.decision_conf : null);
      if (verificationDecision) {
        // Keep the opaque verification decision inside the browser page. Node
        // receives only booleans. The Agent brings its own tab forward before
        // a second, network-free evaluate consumes and deletes this value.
        window[Symbol.for("tkdesk.collection.verification-decision")] = verificationDecision;
        return {
          ok: false,
          verificationRequired: true,
          verificationRenderCalled: false,
          verificationPresented: false,
          httpStatus: intOrNull(response?.status),
          statusCode: null
        };
      }
      const envelope = response?.data && typeof response.data === "object" ? response.data : response;
      const payload = envelope?.data && typeof envelope.data === "object" ? envelope.data : null;
      const rows = Array.isArray(payload?.AnchorList) ? payload.AnchorList : null;
      return {
        ok: true,
        httpStatus: intOrNull(response?.status),
        statusCode: intOrNull(envelope?.status_code ?? envelope?.statusCode),
        verificationRequired: false,
        accountState: {
          isBanned: boolOrNull(payload?.IsBanned),
          dontHaveInviteBenefit: boolOrNull(payload?.DontHaveInviteBenefit),
          testAccountLimit: boolOrNull(payload?.TestAccountLimit)
        },
        rows: rows?.map((row) => {
          const base = row?.UserBaseInfo && typeof row.UserBaseInfo === "object" ? row.UserBaseInfo : {};
          return {
            displayId: String(base.DisplayID ?? "").trim().replace(/^@/, "").slice(0, 64),
            anchorStatus: intOrNull(row?.AnchorStatus),
            displayReason: intOrNull(row?.DisplayReason),
            canUseInvitationTypes: intArrayOrNull(row?.CanUseInvitationType),
            popupInvitationTypes: intArrayOrNull(row?.PopupInvitationType),
            trialLiveEndTimestamp: String(row?.TrialLiveRequirement?.TrialLiveEndTimestamp ?? "").slice(0, 24),
            hasBricRisk: boolOrNull(row?.HasBricRisk),
            isFollow: boolOrNull(row?.IsFollow),
            noPermission: boolOrNull(base.NoPermission ?? row?.NoPermission),
            inEmergency: boolOrNull(base.InEmergency ?? row?.InEmergency),
            multiAccountNotMeetBasicQualification: boolOrNull(row?.MultiAccountNotMeetBasicQualification)
          };
        }) ?? null
      };
    } catch (error) {
      const envelope = error?.response?.data && typeof error.response.data === "object" ? error.response.data : null;
      return {
        ok: false,
        httpStatus: intOrNull(error?.response?.status),
        statusCode: intOrNull(envelope?.status_code ?? envelope?.statusCode),
        code: error?.code === "COLLECTION_BACKSTAGE_REQUEST_TIMEOUT"
          ? "COLLECTION_BACKSTAGE_REQUEST_TIMEOUT"
          : "COLLECTION_BACKSTAGE_REQUEST_FAILED"
      };
    }
  }, { endpoint: COLLECTION_BACKSTAGE_ENDPOINT, displayIds: normalizedHandles });

  if (projected?.verificationRequired === true) {
    let presentation = { verificationRenderCalled: false, verificationPresented: false };
    try {
      if (typeof page.bringToFront === "function") await page.bringToFront();
      presentation = await page.evaluate(async () => {
        const key = Symbol.for("tkdesk.collection.verification-decision");
        const decision = window[key];
        delete window[key];
        if (!decision
          || location.protocol !== "https:"
          || location.hostname.toLowerCase() !== "live-backstage.tiktok.com"
          || !/^\/portal\/anchor\/relation\/?$/.test(location.pathname)) {
          return { verificationRenderCalled: false, verificationPresented: false };
        }
        try {
          const chunks = window["@live-backstage/client"];
          let runtime;
          chunks.push([[Date.now()], {}, (value) => { runtime = value; }]);
          const factory = String(runtime?.m?.[62636] ?? "");
          const createVerifier = runtime?.(62636)?.t;
          if (!factory.includes("captchaOptions")
            || !factory.includes("showMode")
            || typeof createVerifier !== "function") {
            return { verificationRenderCalled: false, verificationPresented: false };
          }
          const verifier = await createVerifier();
          if (!verifier || typeof verifier.render !== "function") {
            return { verificationRenderCalled: false, verificationPresented: false };
          }
          // No-op callbacks are intentional: solving the challenge never
          // triggers a hidden qualification request. A new request requires a
          // new explicit tool invocation after verification is complete.
          verifier.onsuccess = () => {};
          verifier.onclose = () => {};
          verifier.render(decision);
          await new Promise((resolve) => setTimeout(resolve, 750));
          const visible = typeof document === "object" && [...document.querySelectorAll([
            'iframe[src*="captcha" i]',
            'iframe[src*="challenge" i]',
            '[id*="captcha" i]',
            '[data-e2e*="captcha" i]',
            '[data-e2e*="challenge" i]'
          ].join(","))].some((element) => {
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return style.display !== "none"
              && style.visibility !== "hidden"
              && Number(style.opacity || 1) !== 0
              && box.width > 0
              && box.height > 0;
          });
          return {
            verificationRenderCalled: true,
            verificationPresented: typeof document === "object" ? visible : true
          };
        } catch {
          return { verificationRenderCalled: false, verificationPresented: false };
        }
      });
    } catch {
      // The error remains manual_verification even if presentation fails.
    }
    projected = { ...projected, ...presentation };
  }

  return normalizeCollectionBackstageProjection(projected, normalizedHandles, observedAt);
}
