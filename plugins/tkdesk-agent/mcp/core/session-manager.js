import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, readlink, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { chromium, request as playwrightRequest } from "playwright";
import { originalWebLiveProfileForCountry } from "./original-web-live-config.js";
import { safeContentType, transportFailureDiagnostics } from "./http-response-diagnostics.js";
import {
  fingerprintCollectionSessionRoute,
  fingerprintDiscoverySessionRoute,
  normalizeCountryCode,
  normalizeProxyServer,
  normalizeRoutePolicy
} from "./route-policy.js";

const MACOS_CHROME_EXECUTABLE = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MANUAL_STATE_VERSION = 3;
const CLOUDFLARE_TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const ROUTED_SESSION_TARGETS = new Set(["tiktok_discovery", "collection_backstage"]);
const AUTHENTICATED_REQUEST_ENDPOINTS = Object.freeze({
  tiktok_discovery: Object.freeze([
    Object.freeze({ origin: "https://www.tiktok.com", path: "/api-live/user/room/" }),
    Object.freeze({ origin: "https://webcast.us.tiktok.com", path: "/webcast/feed/" }),
    Object.freeze({ origin: "https://webcast.tiktok.com", path: "/webcast/feed/" }),
    Object.freeze({ origin: "https://webcast.us.tiktok.com", path: "/webcast/gift/list/" }),
    Object.freeze({ origin: "https://webcast.us.tiktok.com", path: "/webcast/ranklist/online_audience/" }),
    Object.freeze({ origin: "https://webcast.us.tiktok.com", path: "/webcast/user/" })
  ])
});
const DATA_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
const DATA_ENDPOINTS = Object.freeze({
  basic: ["https://www.tiktok.com", "/api-live/user/room/"],
  country: ["https://webcast.us.tiktok.com", "/webcast/gift/list/"],
  room_enter: ["https://webcast.us.tiktok.com", "/webcast/ranklist/online_audience/"],
  anchor_level: ["https://webcast.us.tiktok.com", "/webcast/user/"]
});
const AUTHENTICATED_REQUEST_HEADER_ALLOWLIST = new Set(["accept"]);
const MAX_AUTHENTICATED_RESPONSE_BYTES = 16 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export const SESSION_TARGETS = Object.freeze({
  tiktok_discovery: Object.freeze({
    label: "TikTok 主播发现",
    startUrl: "https://www.tiktok.com/login",
    takeoverUrl: "https://www.tiktok.com/",
    allowedHosts: Object.freeze(["tiktok.com", "www.tiktok.com", "m.tiktok.com", "accounts.tiktok.com"])
  }),
  collection_backstage: Object.freeze({
    label: "TikTok 主播采集子后台",
    startUrl: "https://live-backstage.tiktok.com/portal/anchor/relation",
    takeoverUrl: "https://live-backstage.tiktok.com/portal/anchor/relation",
    allowedHosts: Object.freeze(["live-backstage.tiktok.com", "accounts.tiktok.com", "www.tiktok.com"]),
    agentDocumentPaths: Object.freeze({
      "live-backstage.tiktok.com": Object.freeze([/^\/portal\/anchor\/relation\/?$/])
    })
  }),
  svip_legacy: Object.freeze({
    label: "TKsoft 历史数据后台",
    startUrl: "https://svip.tiktokzb.com/index.html#/login",
    takeoverUrl: "https://svip.tiktokzb.com/index.html",
    allowedHosts: Object.freeze(["svip.tiktokzb.com"])
  })
});

export const SESSION_TARGET_NAMES = Object.freeze(Object.keys(SESSION_TARGETS));

function requireTarget(target) {
  const name = String(target || "");
  const definition = SESSION_TARGETS[name];
  if (!definition) throw new Error(`未知登录目标：${name || "(empty)"}`);
  return { name, definition };
}

export function isAllowedSessionUrl(target, rawUrl, { allowBlank = false } = {}) {
  const { definition } = requireTarget(target);
  if (allowBlank && rawUrl === "about:blank") return true;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && definition.allowedHosts.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isAllowedAgentNavigationUrl(target, rawUrl, { allowBlank = false } = {}) {
  const { definition } = requireTarget(target);
  if (!isAllowedSessionUrl(target, rawUrl, { allowBlank })) return false;
  if (allowBlank && rawUrl === "about:blank") return true;
  if (!definition.agentDocumentPaths) return true;
  try {
    const url = new URL(rawUrl);
    const patterns = definition.agentDocumentPaths[url.hostname.toLowerCase()] ?? [];
    return patterns.some((pattern) => pattern.test(url.pathname));
  } catch {
    return false;
  }
}

// Query strings and hashes commonly contain OAuth callbacks or short-lived codes.
// They are useful to the browser but must never cross the agent boundary.
export function sanitizeSessionUrl(rawUrl) {
  if (rawUrl === "about:blank") return rawUrl;
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "unavailable";
  }
}

function launchCandidates({ platform, preferredChannel }) {
  const requested = String(preferredChannel || "").trim().toLowerCase();
  const candidates = [];
  if (requested && requested !== "chromium") {
    candidates.push({ channel: requested, label: requested === "chrome" ? "本机 Google Chrome" : `本机 ${requested}` });
  } else if (!requested && platform === "darwin") {
    candidates.push({ channel: "chrome", label: "本机 Google Chrome" });
  }
  candidates.push({ channel: undefined, label: "Playwright Chromium" });
  return candidates;
}

function defaultManualBrowserLauncher(executable, args) {
  return spawn(executable, args, { stdio: "ignore" });
}

async function defaultManualBrowserAvailabilityCheck(executable) {
  await access(executable, fsConstants.X_OK);
}

async function defaultDebugPortAllocator() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!Number.isInteger(port) || port <= 0 || port > 65_535) reject(new Error("无法分配本机调试端口"));
        else resolve(port);
      });
    });
  });
}

function sessionRouteError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function authenticatedRequestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Transport failures do not change the discovery identity or verified route.
// Only admission/authentication/security failures revoke the whole worker run.
function invalidatesCountryWorkerRun(error) {
  const code = String(error?.code || "");
  return code.startsWith("SESSION_ROUTE_") || [
    "SESSION_REQUEST_AUTHENTICATION_REQUIRED",
    "SESSION_REQUEST_PAGE_UNAVAILABLE",
    "SESSION_REQUEST_PROXY_INVALID",
    "SESSION_REQUEST_PROXY_UNVERIFIED",
    "SESSION_REQUEST_PROXY_MISMATCH",
    "SESSION_REQUEST_URL_NOT_ALLOWED",
    "SESSION_REQUEST_HEADERS_NOT_ALLOWED",
    "SESSION_REQUEST_INVALID",
    "SESSION_REQUEST_RUN_CLOSED"
  ].includes(code);
}

function normalizedAuthenticatedRequest(target, request, { allowDataUserAgent = false } = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw authenticatedRequestError("SESSION_REQUEST_INVALID", "会话请求格式无效");
  }
  if (request.requiresAuthenticatedSession !== true || request.sessionTarget !== target) {
    throw authenticatedRequestError("SESSION_REQUEST_INVALID", "会话请求没有绑定到已验证的登录目标");
  }
  if (String(request.method || "").toUpperCase() !== "GET" || request.body !== undefined) {
    throw authenticatedRequestError("SESSION_REQUEST_INVALID", "会话请求只允许固定的无请求体 GET");
  }
  if (request.maxRedirects !== 0) {
    throw authenticatedRequestError("SESSION_REQUEST_INVALID", "会话请求必须拒绝重定向");
  }

  let url;
  try {
    url = new URL(String(request.url));
  } catch {
    throw authenticatedRequestError("SESSION_REQUEST_URL_NOT_ALLOWED", "会话请求 URL 无效");
  }
  const endpointAllowed = (AUTHENTICATED_REQUEST_ENDPOINTS[target] ?? []).some(
    (endpoint) => url.protocol === "https:"
      && url.origin === endpoint.origin
      && url.pathname === endpoint.path
      && !url.username
      && !url.password
      && !url.hash
  );
  if (!endpointAllowed) {
    throw authenticatedRequestError("SESSION_REQUEST_URL_NOT_ALLOWED", "会话请求不在固定 TikTok 端点白名单内");
  }

  const timeoutMs = Number(request.timeoutMs);
  const maxResponseBytes = Number(request.maxResponseBytes);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000
    || !Number.isSafeInteger(maxResponseBytes)
    || maxResponseBytes < 1
    || maxResponseBytes > MAX_AUTHENTICATED_RESPONSE_BYTES) {
    throw authenticatedRequestError("SESSION_REQUEST_INVALID", "会话请求边界无效");
  }

  const headers = {};
  if (request.headers !== undefined) {
    if (!request.headers || typeof request.headers !== "object" || Array.isArray(request.headers)) {
      throw authenticatedRequestError("SESSION_REQUEST_HEADERS_NOT_ALLOWED", "会话请求头格式无效");
    }
    for (const [rawName, rawValue] of Object.entries(request.headers)) {
      const name = String(rawName).trim().toLowerCase();
      if ((!AUTHENTICATED_REQUEST_HEADER_ALLOWLIST.has(name)
          && !(allowDataUserAgent && name === "user-agent" && rawValue === DATA_USER_AGENT))
        || typeof rawValue !== "string"
        || rawValue.length > 256
        || /[\r\n]/.test(rawValue)) {
        throw authenticatedRequestError("SESSION_REQUEST_HEADERS_NOT_ALLOWED", "会话请求头不在安全白名单内");
      }
      headers[name] = rawValue;
    }
  }

  let proxyServer;
  try {
    proxyServer = normalizeProxyServer(request.proxyServer);
  } catch {
    throw authenticatedRequestError("SESSION_REQUEST_PROXY_INVALID", "会话请求代理无效");
  }
  return Object.freeze({
    url: url.href,
    headers: Object.freeze(headers),
    timeoutMs,
    maxResponseBytes,
    proxyServer
  });
}

function normalizeSessionRoute(target, route) {
  if (route === undefined || route === null) return null;
  if (!ROUTED_SESSION_TARGETS.has(target)) {
    throw sessionRouteError("SESSION_ROUTE_NOT_SUPPORTED", `${SESSION_TARGETS[target].label} 不允许配置代理路由`);
  }
  const policy = normalizeRoutePolicy(route);
  if (target === "collection_backstage") {
    // The collection sub-backend shares WorkID1's target-country node. Later
    // WorkID lanes are independent country collectors and must not change this
    // persistent browser's route identity.
    const firstLane = policy.collectionLanes[0];
    return Object.freeze({
      policy,
      fingerprint: fingerprintCollectionSessionRoute({ collectionLanes: [firstLane] }),
      country: firstLane.countryCode,
      proxyServer: firstLane.proxyServer
    });
  }

  // TikTok discovery/login remains on its independent US main-account node.
  return Object.freeze({
    policy,
    fingerprint: fingerprintDiscoverySessionRoute(policy),
    country: policy.discoveryCountry,
    proxyServer: policy.discoveryProxyServer
  });
}

function routeStatus(holder) {
  return {
    routeFingerprint: holder?.routeFingerprint ?? null,
    routeCountry: holder?.routeCountry ?? null,
    restartRequired: holder?.routeRestartRequired === true
  };
}

function bindRequestedRoute(holder, requestedRoute) {
  if (!holder || !requestedRoute) return false;
  const mismatch = holder.routeFingerprint !== requestedRoute.fingerprint
    || holder.routeCountry !== requestedRoute.country;
  holder.routeRestartRequired = mismatch;
  if (!mismatch) {
    holder.routeFingerprint = requestedRoute.fingerprint;
    holder.routeCountry = requestedRoute.country;
    holder.route = requestedRoute;
  }
  return mismatch;
}

function proxyProbeError(message) {
  return sessionRouteError("PROXY_EXIT_COUNTRY_UNAVAILABLE", message);
}

/**
 * Probe the egress country through a temporary, non-persistent Playwright
 * browser. Only Cloudflare's two-letter `loc` value crosses this boundary;
 * its trace body and the observed IP are discarded.
 */
export async function probeProxyExitCountry(proxyServer, {
  probe,
  chromiumLauncher = chromium,
  timeoutMs = 10_000
} = {}) {
  const normalizedProxyServer = normalizeProxyServer(proxyServer);
  if (typeof probe === "function") {
    const result = await probe(normalizedProxyServer);
    const value = result && typeof result === "object"
      ? (result.proxyExitCountry ?? result.countryCode)
      : result;
    const countryCode = normalizeCountryCode(value, "proxyExitCountry");
    if (countryCode === "XX") throw proxyProbeError("代理出口国家未知");
    return countryCode;
  }
  if (!chromiumLauncher || typeof chromiumLauncher.launch !== "function") {
    throw proxyProbeError("Playwright 临时浏览器不可用");
  }

  const timeout = Math.min(30_000, Math.max(1_000, Number(timeoutMs) || 10_000));
  let browser;
  try {
    browser = await chromiumLauncher.launch({
      headless: true,
      proxy: { server: normalizedProxyServer }
    });
    const page = await browser.newPage();
    const response = await page.goto(CLOUDFLARE_TRACE_URL, {
      waitUntil: "domcontentloaded",
      timeout
    });
    if (!response || (typeof response.ok === "function" && !response.ok())) {
      throw proxyProbeError("代理出口国家探测请求失败");
    }
    const trace = await response.text();
    const match = String(trace).match(/(?:^|\n)loc=([A-Za-z]{2})(?:\r?$|\n)/m);
    if (!match) throw proxyProbeError("代理出口国家探测结果缺少国家代码");
    const countryCode = normalizeCountryCode(match[1], "proxyExitCountry");
    if (countryCode === "XX") throw proxyProbeError("代理出口国家未知");
    return countryCode;
  } catch (error) {
    if (error?.code === "PROXY_EXIT_COUNTRY_UNAVAILABLE") throw error;
    throw proxyProbeError("代理出口国家探测失败");
  } finally {
    await browser?.close?.().catch(() => {});
  }
}

async function defaultProcessInspector(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false, executable: null, command: null, startedAt: null };
  try {
    const [{ stdout: executable }, { stdout: command }, { stdout: startedAt }] = await Promise.all([
      execFileAsync("/bin/ps", ["-p", String(pid), "-o", "comm="]),
      execFileAsync("/bin/ps", ["-p", String(pid), "-o", "command="]),
      execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="])
    ]);
    return {
      alive: Boolean(command.trim()),
      executable: executable.trim() || null,
      command: command.trim(),
      startedAt: startedAt.trim() || null
    };
  } catch (error) {
    if (error?.code === 1) return { alive: false, executable: null, command: null, startedAt: null };
    return { alive: null, executable: null, command: null, startedAt: null };
  }
}

async function defaultSingletonLockInspector(profileDirectory) {
  const lockPath = path.join(profileDirectory, "SingletonLock");
  try {
    const target = await readlink(lockPath);
    const match = String(target).match(/(\d+)$/);
    return { exists: true, pid: match ? Number(match[1]) : null, parseable: Boolean(match) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, pid: null, parseable: true };
    // A lock that exists but cannot be attributed must fail closed. Never
    // delete or rewrite Chrome's lock from the Agent.
    return { exists: true, pid: null, parseable: false };
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandOwnsProfile(inspected, profileDirectory, chromeExecutable) {
  if (!inspected?.command || inspected.executable !== chromeExecutable) return false;
  const command = String(inspected.command);
  const executablePattern = new RegExp(`^${escapeRegExp(chromeExecutable)}(?=\\s|$)`);
  const profileArgumentPattern = new RegExp(
    `(?:^|\\s)--user-data-dir=${escapeRegExp(profileDirectory)}(?=\\s|$)`
  );
  // Both the executable and --user-data-dir must be complete argv values.
  // Prefix strings such as <profile>_other, <profile>/child, and URL text that
  // merely contains the switch are not process ownership proof.
  return executablePattern.test(command) && profileArgumentPattern.test(command);
}

function commandDebugPort(inspected) {
  const match = String(inspected?.command || "").match(/(?:^|\s)--remote-debugging-port=(\d+)(?=\s|$)/);
  const port = match ? Number(match[1]) : null;
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function commandUsesLoopbackDebugging(inspected) {
  return /(?:^|\s)--remote-debugging-address=127\.0\.0\.1(?=\s|$)/.test(String(inspected?.command || ""));
}

function commandUsesProxy(inspected, proxyServer) {
  if (!proxyServer) return true;
  const pattern = new RegExp(
    `(?:^|\\s)--proxy-server=${escapeRegExp(proxyServer)}(?=\\s|$)`
  );
  return pattern.test(String(inspected?.command || ""));
}

function persistedManualState(manual, target, profileDirectory) {
  return {
    version: MANUAL_STATE_VERSION,
    target,
    phase: manual.state === "running" || manual.state === "starting"
      ? "manual_browser_running"
      : manual.state === "owner_unverified"
        ? "manual_owner_unverified"
        : "manual_browser_closed",
    pid: Number.isInteger(manual.pid) ? manual.pid : null,
    debugPort: Number.isInteger(manual.debugPort) ? manual.debugPort : null,
    processStartedAt: manual.processStartedAt ?? null,
    chromeExecutable: manual.chromeExecutable,
    profileDirectory,
    launchedUrl: sanitizeSessionUrl(manual.destination),
    // Persist only the non-secret route identity. The loopback proxy address
    // and full policy remain process-local and are supplied again on restart.
    routeFingerprint: manual.routeFingerprint ?? null,
    routeCountry: manual.routeCountry ?? null,
    startedAt: manual.startedAt ?? null,
    updatedAt: new Date().toISOString()
  };
}

function waitForChildSpawn(child) {
  if (child?.pid) return Promise.resolve();
  if (!child || typeof child.once !== "function") {
    throw new Error("普通 Chrome 启动器没有返回可跟踪的进程");
  }
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.removeListener?.("error", onError);
      resolve();
    };
    const onError = (error) => {
      child.removeListener?.("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function pageIsOpen(page) {
  return page && (typeof page.isClosed !== "function" || !page.isClosed());
}

function authenticationFromUrl(target, rawUrl) {
  try {
    const url = new URL(rawUrl);
    const pathAndHash = `${url.pathname}${url.hash}`;
    if (target === "svip_legacy") return /(?:^|[/#])login(?:[/?#]|$)/i.test(pathAndHash);
    if (url.hostname.toLowerCase() === "accounts.tiktok.com") return true;
    if (/\/(?:login|logout|signup)(?:[/?#]|$)/i.test(url.pathname)) return true;
    return target === "collection_backstage"
      && url.hostname.toLowerCase() === "live-backstage.tiktok.com"
      && url.pathname === "/"
      && url.searchParams.has("callback_url");
  } catch {
    return false;
  }
}

function verificationFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /(?:captcha|challenge|verification|security-check)/i.test(`${url.pathname}${url.hash}`);
  } catch {
    return false;
  }
}

async function inspectLoginDom(page, target) {
  return page.evaluate(({ sessionTarget }) => {
    const text = (document.body?.innerText || "").slice(0, 50_000);
    const isVisible = (element) => {
      if (!(element instanceof Element)) return false;
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || 1) !== 0
        && box.width > 0
        && box.height > 0;
    };
    // Do not use a broad `[class*="verify"]` selector here. The collection
    // backstage uses ordinary `verified`/`verify-*` class names in its normal
    // authenticated shell, which previously produced a false CAPTCHA result.
    // A manual gate must have visible, challenge-specific DOM or explicit text.
    const challengeSelector = [
      'iframe[src*="captcha" i]',
      'iframe[src*="challenge" i]',
      '[id*="captcha" i]',
      '[data-e2e*="captcha" i]',
      '[data-e2e*="challenge" i]',
      '[role="dialog"] [class*="captcha" i]'
    ].join(",");
    const challengeElement = [...document.querySelectorAll(challengeSelector)].find(isVisible);
    const captcha = Boolean(
      challengeElement
      || /captcha|security check|verify to continue|complete (?:the )?(?:security )?verification|请完成(?:安全)?验证|安全验证|验证码|拖动滑块|滑动滑块/i.test(text)
    );
    const authentication = Boolean(
      document.querySelector('input[type="password"], form[action*="login" i], [data-e2e*="login" i]')
      || /log in to tiktok|sign in to tiktok|登录\s*tiktok|登录以继续|请先登录/i.test(text)
    );

    let authenticated = false;
    if (sessionTarget === "tiktok_discovery") {
      authenticated = Boolean(document.querySelector([
        '[data-e2e="profile-icon"]',
        '[data-e2e="nav-profile"]',
        '[data-e2e="top-avatar"]',
        'a[href^="/@"][aria-label*="profile" i]'
      ].join(",")));
    } else if (sessionTarget === "collection_backstage") {
      const relationShell = /live backstage/i.test(document.title)
        && ((/管理关系/.test(text) && /邀请主播/.test(text))
          || (/manage relationships?/i.test(text) && /invite (?:a )?(?:creator|host)/i.test(text)));
      authenticated = relationShell || Boolean(document.querySelector([
        '[data-e2e*="account" i]',
        '[class*="user-avatar" i]',
        '[class*="account-avatar" i]',
        'nav a[href*="/portal/"]'
      ].join(",")));
    } else if (sessionTarget === "svip_legacy") {
      authenticated = Boolean(document.querySelector([
        '#app aside',
        '#app .el-menu',
        '#app a[href*="anchorList"]',
        '#app a[href*="taskList"]'
      ].join(",")));
    }
    return { captcha, authentication, authenticated };
  }, { sessionTarget: target });
}

export class SessionManager {
  constructor({
    dataDirectory,
    log = () => {},
    chromiumLauncher = chromium,
    requestContextFactory = playwrightRequest,
    platform = process.platform,
    preferredChannel = process.env.TKDESK_AGENT_BROWSER_CHANNEL,
    manualBrowserLauncher = defaultManualBrowserLauncher,
    manualBrowserAvailabilityCheck = defaultManualBrowserAvailabilityCheck,
    debugPortAllocator = defaultDebugPortAllocator,
    chromeExecutable = MACOS_CHROME_EXECUTABLE,
    processInspector = defaultProcessInspector,
    singletonLockInspector = defaultSingletonLockInspector,
    processSignaler = (pid, signal) => process.kill(pid, signal)
  } = {}) {
    if (!dataDirectory) throw new Error("SessionManager 需要 dataDirectory");
    if (!chromiumLauncher
      || typeof chromiumLauncher.launchPersistentContext !== "function"
      || (platform === "darwin" && typeof chromiumLauncher.connectOverCDP !== "function")) {
      throw new Error("chromiumLauncher 必须提供 launchPersistentContext，macOS 还必须提供 connectOverCDP");
    }
    this.profileRoot = path.resolve(dataDirectory, "browser-profiles");
    this.manualStateRoot = path.resolve(dataDirectory, "browser-session-state");
    this.log = log;
    this.chromiumLauncher = chromiumLauncher;
    this.requestContextFactory = requestContextFactory;
    this.platform = platform;
    this.preferredChannel = preferredChannel;
    this.manualBrowserLauncher = manualBrowserLauncher;
    this.manualBrowserAvailabilityCheck = manualBrowserAvailabilityCheck;
    this.debugPortAllocator = debugPortAllocator;
    this.chromeExecutable = chromeExecutable;
    this.processInspector = processInspector;
    this.singletonLockInspector = singletonLockInspector;
    this.processSignaler = processSignaler;
    this.sessions = new Map();
    this.manualSessions = new Map();
    this.manualStateLoaded = new Set();
    this.manualStateWrites = new Map();
    this.startPromises = new Map();
    this.countryWorkerRun = null;
  }

  profileDirectory(target) {
    const { name } = requireTarget(target);
    const directory = path.resolve(this.profileRoot, name);
    if (path.dirname(directory) !== this.profileRoot) throw new Error("无效的浏览器配置目录");
    return directory;
  }

  manualStatePath(target) {
    const { name } = requireTarget(target);
    const statePath = path.resolve(this.manualStateRoot, `${name}.json`);
    if (path.dirname(statePath) !== this.manualStateRoot) throw new Error("无效的人工登录状态路径");
    return statePath;
  }

  #queueManualStateWrite(name, operation) {
    const previous = this.manualStateWrites.get(name) ?? Promise.resolve();
    const queued = previous.catch(() => {}).then(operation);
    this.manualStateWrites.set(name, queued);
    return queued.finally(() => {
      if (this.manualStateWrites.get(name) === queued) this.manualStateWrites.delete(name);
    });
  }

  async #persistManual(name, manual) {
    const statePath = this.manualStatePath(name);
    const payload = persistedManualState(manual, name, this.profileDirectory(name));
    await this.#queueManualStateWrite(name, async () => {
      await mkdir(this.manualStateRoot, { recursive: true, mode: 0o700 });
      const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, statePath);
    });
  }

  async #removeManualState(name) {
    await this.#queueManualStateWrite(name, async () => {
      await unlink(this.manualStatePath(name)).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    });
  }

  async #loadManualState(name, definition) {
    if (this.manualStateLoaded.has(name)) return this.manualSessions.get(name) ?? null;
    this.manualStateLoaded.add(name);
    try {
      await this.manualStateWrites.get(name)?.catch(() => {});
      const raw = JSON.parse(await readFile(this.manualStatePath(name), "utf8"));
      const expectedProfile = this.profileDirectory(name);
      if (![1, 2, MANUAL_STATE_VERSION].includes(raw?.version)
        || raw?.target !== name
        || raw?.profileDirectory !== expectedProfile
        || raw?.chromeExecutable !== this.chromeExecutable
        || (raw?.routeFingerprint !== undefined
          && raw.routeFingerprint !== null
          && !/^[a-f0-9]{64}$/.test(raw.routeFingerprint))
        || (raw?.routeCountry !== undefined
          && raw.routeCountry !== null
          && !/^[A-Z]{2}$/.test(raw.routeCountry))
        || Boolean(raw?.routeFingerprint) !== Boolean(raw?.routeCountry)
        || !["manual_browser_running", "manual_owner_unverified", "manual_browser_closed", "takeover_ready"].includes(raw?.phase)) {
        throw new Error("人工登录状态文件格式不匹配");
      }
      const manual = {
        child: null,
        pid: Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : null,
        debugPort: Number.isInteger(raw.debugPort) && raw.debugPort > 0 && raw.debugPort <= 65_535 ? raw.debugPort : null,
        processStartedAt: typeof raw.processStartedAt === "string" ? raw.processStartedAt : null,
        chromeExecutable: raw.chromeExecutable,
        destination: isAllowedSessionUrl(name, raw.launchedUrl) ? raw.launchedUrl : definition.startUrl,
        route: null,
        routeFingerprint: raw.routeFingerprint ?? null,
        routeCountry: raw.routeCountry ?? null,
        routeRestartRequired: false,
        engine: "本机 Google Chrome（人工登录）",
        state: raw.phase === "manual_browser_running"
          ? "running"
          : ["manual_browser_closed", "takeover_ready"].includes(raw.phase)
            ? "closed"
            : "owner_unverified",
        startedAt: raw.startedAt ?? null,
        exitedAt: null,
        exitCode: null,
        error: null,
        recovered: true,
        ownerVerified: false
      };
      this.manualSessions.set(name, manual);
      return manual;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      // Corrupt or unexpected state is a security boundary, not a cue to
      // delete the state or reuse the profile.
      const manual = {
        child: null,
        pid: null,
        debugPort: null,
        processStartedAt: null,
        chromeExecutable: this.chromeExecutable,
        destination: definition.startUrl,
        route: null,
        routeFingerprint: null,
        routeCountry: null,
        routeRestartRequired: false,
        engine: "本机 Google Chrome（人工登录）",
        state: "owner_unverified",
        startedAt: null,
        exitedAt: null,
        exitCode: null,
        error: "manual_state_unreadable",
        recovered: true,
        ownerVerified: false
      };
      this.manualSessions.set(name, manual);
      return manual;
    }
  }

  async #refreshManualState(name, definition) {
    let manual = await this.#loadManualState(name, definition);
    if (manual?.child && (manual.state === "running" || manual.state === "starting")) {
      manual.ownerVerified = true;
      return manual;
    }

    const lock = await this.singletonLockInspector(this.profileDirectory(name));
    if (!manual && !lock.exists) return null;
    if (!manual) {
      manual = {
        child: null,
        pid: lock.pid,
        debugPort: null,
        processStartedAt: null,
        chromeExecutable: this.chromeExecutable,
        destination: definition.startUrl,
        route: null,
        routeFingerprint: null,
        routeCountry: null,
        routeRestartRequired: false,
        engine: "本机 Google Chrome（人工登录）",
        state: "owner_unverified",
        startedAt: null,
        exitedAt: null,
        exitCode: null,
        error: null,
        recovered: true,
        ownerVerified: false
      };
      this.manualSessions.set(name, manual);
    }

    if (manual.error === "manual_state_unreadable") {
      manual.state = "owner_unverified";
      manual.ownerVerified = false;
      return manual;
    }

    if (lock.exists && !lock.parseable) {
      manual.state = "owner_unverified";
      manual.ownerVerified = false;
      await this.#persistManual(name, manual);
      return manual;
    }

    const candidatePids = [...new Set([manual.pid, lock.pid].filter((pid) => Number.isInteger(pid) && pid > 0))];
    let inspectionUnknown = false;
    for (const pid of candidatePids) {
      const inspected = await this.processInspector(pid);
      if (inspected?.alive === null) {
        inspectionUnknown = true;
        continue;
      }
      if (inspected?.alive !== true) continue;
      const ownsProfile = commandOwnsProfile(inspected, this.profileDirectory(name), this.chromeExecutable);
      const inspectedDebugPort = commandDebugPort(inspected);
      const debugPortMatches = !manual.debugPort || manual.debugPort === inspectedDebugPort;
      const startIdentityMatches = !(manual.pid === pid && manual.processStartedAt && inspected.startedAt)
        || manual.processStartedAt === inspected.startedAt;
      if (!ownsProfile || !startIdentityMatches || !debugPortMatches) {
        manual.state = "owner_unverified";
        manual.ownerVerified = false;
        manual.pid = pid;
        await this.#persistManual(name, manual);
        return manual;
      }
      manual.state = "running";
      manual.ownerVerified = true;
      manual.pid = pid;
      manual.debugPort = inspectedDebugPort ?? manual.debugPort;
      manual.processStartedAt = inspected.startedAt ?? manual.processStartedAt;
      await this.#persistManual(name, manual);
      return manual;
    }

    if (inspectionUnknown) {
      manual.state = "owner_unverified";
      manual.ownerVerified = false;
      await this.#persistManual(name, manual);
      return manual;
    }

    // A dead PID and an absent or stale (dead-owner) SingletonLock are the
    // only conditions that permit a later ordinary-Chrome reopen. Chrome owns
    // lock cleanup; the Agent never unlinks SingletonLock itself.
    manual.state = "closed";
    manual.ownerVerified = false;
    await this.#persistManual(name, manual);
    return manual;
  }

  async start(target, { startUrl, route } = {}) {
    const { name, definition } = requireTarget(target);
    const requestedRoute = normalizeSessionRoute(name, route);
    const existing = this.sessions.get(name);
    if (existing?.context) {
      bindRequestedRoute(existing, requestedRoute);
      return this.status(name);
    }
    if (this.startPromises.has(name)) {
      await this.startPromises.get(name);
      return this.start(name, { startUrl, route });
    }

    if (this.platform === "darwin") {
      const manual = await this.#refreshManualState(name, definition);
      bindRequestedRoute(manual, requestedRoute);
      // Never start a second Chrome against a live profile owner. A closed
      // ordinary browser is safe to reopen with the same persistent profile;
      // macOS no longer relaunches that profile through Playwright.
      if (manual && manual.state !== "closed") return this.status(name);
      if (manual?.state === "closed") {
        this.manualSessions.delete(name);
        await this.#removeManualState(name);
      }
    }

    const destination = startUrl || definition.startUrl;
    if (!isAllowedSessionUrl(name, destination)) {
      throw new Error(`${definition.label} 只允许打开其官方 HTTPS 白名单页面`);
    }

    const launch = this.platform === "darwin"
      ? () => this.#launchManual(name, definition, destination, requestedRoute)
      : () => this.#launchAutomation(name, definition, destination, requestedRoute);
    const promise = launch().finally(() => {
      this.startPromises.delete(name);
    });
    this.startPromises.set(name, promise);
    return promise;
  }

  /**
   * Bind an expected route only to a browser that is already running.
   *
   * This deliberately does not wait for, join, or create a start operation:
   * login checking must remain passive even when the browser closes between a
   * preceding status read and this call. A recovered ordinary-Chrome holder is
   * accepted only after the existing process/profile ownership checks succeed.
   */
  async bindExistingRoute(target, { route } = {}) {
    const { name, definition } = requireTarget(target);
    const requestedRoute = normalizeSessionRoute(name, route);
    const existing = this.sessions.get(name);
    if (existing?.context) {
      bindRequestedRoute(existing, requestedRoute);
    } else if (this.platform === "darwin") {
      const manual = await this.#refreshManualState(name, definition);
      if (manual
        && ["running", "starting"].includes(manual.state)
        && manual.ownerVerified) {
        const mismatch = bindRequestedRoute(manual, requestedRoute);
        if (requestedRoute && manual.recovered) {
          // Old state may carry a fingerprint produced by an earlier routing
          // model, while the oldest v3 state may have no route identity at all.
          // Either may be upgraded in place only when the persisted country is
          // compatible and a second live inspection proves the exact same
          // profile, loopback debug endpoint, requested proxy argv, and process
          // start identity. The exact proxy comparison is the country proof for
          // an otherwise-unbound legacy holder. Any partial, missing, or changed
          // identity evidence fails closed.
          const legacyUnbound = manual.routeFingerprint === null && manual.routeCountry === null;
          const countryCompatible = legacyUnbound || manual.routeCountry === requestedRoute.country;
          const inspected = countryCompatible ? await this.processInspector(manual.pid) : null;
          const identityMatches = countryCompatible
            && inspected?.alive === true
            && commandOwnsProfile(inspected, this.profileDirectory(name), this.chromeExecutable)
            && commandUsesLoopbackDebugging(inspected)
            && Number.isInteger(manual.debugPort)
            && commandDebugPort(inspected) === manual.debugPort
            && commandUsesProxy(inspected, requestedRoute.proxyServer)
            && typeof manual.processStartedAt === "string"
            && manual.processStartedAt.length > 0
            && inspected.startedAt === manual.processStartedAt;
          if (!identityMatches) {
            manual.routeRestartRequired = true;
          } else {
            manual.route = requestedRoute;
            manual.routeFingerprint = requestedRoute.fingerprint;
            manual.routeCountry = requestedRoute.country;
            manual.routeRestartRequired = false;
            if (mismatch) await this.#persistManual(name, manual);
          }
        }
      }
    }

    // status() rechecks an ordinary Chrome owner. If it closed during this
    // method, the result is stopped/reopenRequired; this method never relaunches
    // the persistent profile as a side effect of that race.
    const status = await this.status(name);
    return {
      ...status,
      state: !status.running
        ? "stopped"
        : status.restartRequired
          ? "route_restart_required"
          : "running",
      reopenRequired: status.reopenRequired === true
    };
  }

  async #launchManual(name, definition, destination, route) {
    const previous = this.manualSessions.get(name);
    if (previous) return this.status(name);

    try {
      await this.manualBrowserAvailabilityCheck(this.chromeExecutable);
    } catch (error) {
      throw new Error(`找不到可执行的本机 Google Chrome：${this.chromeExecutable}（${error?.message || error}）`);
    }

    // This is intentionally a normal Chrome process, not a Playwright launch.
    // A random loopback-only DevTools endpoint lets the Agent attach to this
    // exact already-running browser after login, without restarting it, adding
    // --enable-automation, or extracting credentials/cookies.
    const debugPort = await this.debugPortAllocator();
    if (!Number.isInteger(debugPort) || debugPort <= 0 || debugPort > 65_535) {
      throw new Error("无法为普通 Chrome 分配有效的本机连接端口");
    }
    const args = [
      `--user-data-dir=${this.profileDirectory(name)}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${debugPort}`,
      ...(route ? [`--proxy-server=${route.proxyServer}`] : []),
      "--new-window",
      destination
    ];
    let child;
    try {
      child = this.manualBrowserLauncher(this.chromeExecutable, args, { stdio: "ignore" });
    } catch (error) {
      throw new Error(`无法启动 ${definition.label} 人工登录浏览器：${error?.message || error}`);
    }

    const manual = {
      child,
      pid: Number.isInteger(child?.pid) ? child.pid : null,
      debugPort,
      processStartedAt: null,
      chromeExecutable: this.chromeExecutable,
      destination,
      route,
      routeFingerprint: route?.fingerprint ?? null,
      routeCountry: route?.country ?? null,
      routeRestartRequired: false,
      engine: "本机 Google Chrome（人工登录）",
      state: "starting",
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
      error: null,
      recovered: false,
      ownerVerified: true
    };
    this.manualSessions.set(name, manual);
    const markClosed = (exitCode = null) => {
      if (this.manualSessions.get(name) !== manual) return;
      manual.state = "closed";
      manual.exitedAt = new Date().toISOString();
      manual.exitCode = Number.isInteger(exitCode) ? exitCode : null;
      manual.child = null;
      manual.ownerVerified = false;
      void this.#releaseAttachedSession(name).catch(() => {});
      void this.#persistManual(name, manual).catch(() => {});
      this.log(`${definition.label} 普通 Chrome 已关闭；登录资料仍保留，可重新打开后原地连接`);
    };
    child.once?.("exit", markClosed);
    child.once?.("error", (error) => {
      if (this.manualSessions.get(name) !== manual) return;
      manual.state = "closed";
      manual.exitedAt = new Date().toISOString();
      manual.error = "manual_browser_process_error";
      manual.child = null;
      manual.ownerVerified = false;
      void this.#releaseAttachedSession(name).catch(() => {});
      void this.#persistManual(name, manual).catch(() => {});
    });

    try {
      await waitForChildSpawn(child);
    } catch (error) {
      if (this.manualSessions.get(name) === manual) this.manualSessions.delete(name);
      throw new Error(`无法启动 ${definition.label} 人工登录浏览器：${error?.message || error}`);
    }
    if (manual.state === "starting") manual.state = "running";
    child.unref?.();
    const identity = manual.pid ? await this.processInspector(manual.pid) : null;
    if (identity?.alive === true
      && commandOwnsProfile(identity, this.profileDirectory(name), this.chromeExecutable)) {
      manual.processStartedAt = identity.startedAt ?? null;
    }
    await this.#persistManual(name, manual);
    this.log(`${definition.label} 已用普通 Google Chrome 打开；请手动登录并保持窗口打开，Agent 将原地连接`);
    return this.status(name);
  }

  async #launchAutomation(name, definition, destination, route) {
    const errors = [];
    let context = null;
    let engine = null;
    for (const candidate of launchCandidates({
      platform: this.platform,
      preferredChannel: this.preferredChannel
    })) {
      try {
        const launchOptions = {
          headless: false,
          channel: candidate.channel,
          viewport: null,
          locale: "zh-CN",
          args: ["--start-maximized"],
          ...(route ? { proxy: { server: route.proxyServer } } : {})
        };
        context = await this.chromiumLauncher.launchPersistentContext(this.profileDirectory(name), launchOptions);
        engine = candidate.label;
        break;
      } catch (error) {
        errors.push(`${candidate.label}: ${error?.message || error}`);
      }
    }
    if (!context) throw new Error(`无法启动 ${definition.label} 登录浏览器。\n${errors.join("\n")}`);

    const session = {
      context,
      currentPage: null,
      engine,
      ownership: "launched",
      guardInstalled: false,
      route,
      routeFingerprint: route?.fingerprint ?? null,
      routeCountry: route?.country ?? null,
      routeRestartRequired: false
    };
    this.sessions.set(name, session);
    await this.#installNavigationGuard(name, context);
    session.guardInstalled = true;

    if (typeof context.on === "function") {
      context.on("page", (page) => {
        session.currentPage = page;
      });
      context.on("close", () => {
        if (this.sessions.get(name)?.context === context) this.sessions.delete(name);
        this.log(`${definition.label} 浏览器已关闭`);
      });
    }

    try {
      const page = context.pages()[0] ?? await context.newPage();
      session.currentPage = page;
      await page.goto(destination, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.bringToFront?.();
      this.log(`${definition.label} 已打开；请在该独立窗口中手动完成登录或验证`);
      return this.status(name);
    } catch (error) {
      this.sessions.delete(name);
      await context.close().catch(() => {});
      throw error;
    }
  }

  async #attachRunningManualLogin(name, definition) {
    const existing = this.sessions.get(name);
    if (existing?.context) return;
    const inFlight = this.startPromises.get(name);
    if (inFlight) {
      await inFlight;
      return;
    }

    // Register the single-flight promise synchronously. Concurrent checks must
    // converge on one CDP connection to the already-running normal Chrome.
    const promise = (async () => {
      const manual = await this.#refreshManualState(name, definition);
      if (!manual || !["running", "starting"].includes(manual.state) || !manual.ownerVerified) {
        throw new Error(`${definition.label} 普通 Chrome 进程身份尚未通过核验，Agent 已拒绝连接`);
      }
      if (!Number.isInteger(manual.debugPort)) {
        throw new Error(`${definition.label} 普通 Chrome 没有安全的本机连接端口，请重新打开登录窗口`);
      }

      // Recheck exact process identity and loopback-only endpoint immediately
      // before connecting. Never attach to an arbitrary local Chrome/CDP port.
      const inspected = await this.processInspector(manual.pid);
      const identityMatches = inspected?.alive === true
        && commandOwnsProfile(inspected, this.profileDirectory(name), this.chromeExecutable)
        && commandUsesLoopbackDebugging(inspected)
        && commandDebugPort(inspected) === manual.debugPort
        && commandUsesProxy(inspected, manual.route?.proxyServer)
        && (!manual.processStartedAt || !inspected.startedAt || manual.processStartedAt === inspected.startedAt);
      if (!identityMatches) {
        throw new Error(`${definition.label} 普通 Chrome 的本机连接身份不匹配，Agent 已拒绝连接`);
      }

      const browser = await this.chromiumLauncher.connectOverCDP(
        `http://127.0.0.1:${manual.debugPort}`,
        { timeout: 10_000 }
      );
      const context = browser.contexts()[0];
      if (!context) throw new Error(`${definition.label} 普通 Chrome 没有可连接的浏览器上下文`);
      const openPages = context.pages().filter(pageIsOpen);
      const currentPage = openPages.filter((page) => isAllowedSessionUrl(name, page.url(), { allowBlank: true })).at(-1)
        ?? openPages.at(-1)
        ?? null;
      const session = {
        browser,
        context,
        currentPage,
        agentPage: null,
        recoveryPage: null,
        engine: "本机 Google Chrome（Agent 原地连接）",
        ownership: "cdp_attached",
        guardInstalled: false,
        authenticated: false,
        route: manual.route,
        routeFingerprint: manual.routeFingerprint ?? null,
        routeCountry: manual.routeCountry ?? null,
        routeRestartRequired: manual.routeRestartRequired === true
      };
      this.sessions.set(name, session);
      if (typeof context.on === "function") {
        context.on("page", (page) => {
          session.currentPage = page;
        });
      }
      browser.on?.("disconnected", () => {
        if (this.sessions.get(name)?.browser === browser) this.sessions.delete(name);
      });
      this.log(`${definition.label} 已原地连接普通 Chrome；窗口与登录状态均未重启`);
      return this.status(name);
    })();
    this.startPromises.set(name, promise);
    try {
      await promise;
    } finally {
      if (this.startPromises.get(name) === promise) this.startPromises.delete(name);
    }
  }

  async #installNavigationGuard(target, context, { agentRestricted = false } = {}) {
    if (typeof context.route !== "function") return;
    await context.route("**/*", async (route) => {
      const request = route.request();
      const navigationAllowed = agentRestricted ? isAllowedAgentNavigationUrl : isAllowedSessionUrl;
      if (request.resourceType() === "document" && !navigationAllowed(target, request.url(), { allowBlank: true })) {
        this.log(`${SESSION_TARGETS[target].label} 已阻止白名单外页面跳转`);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
  }

  async #ensureNavigationGuard(target) {
    const session = this.sessions.get(target);
    if (!session?.context || session.guardInstalled) return;
    if (session.ownership === "cdp_attached") {
      // Never route, navigate, close, or expose the user's human login tabs.
      // After authentication, create one background Agent-owned tab and put
      // the allowlist only on that page.
      const page = await session.context.newPage();
      try {
        await this.#installNavigationGuard(target, page, { agentRestricted: true });
        await page.goto(SESSION_TARGETS[target].takeoverUrl || SESSION_TARGETS[target].startUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000
        });
        session.agentPage = page;
        session.currentPage = page;
        if (pageIsOpen(session.recoveryPage)) {
          await session.recoveryPage.close?.().catch(() => {});
        }
        session.recoveryPage = null;
      } catch (error) {
        await page.close?.().catch(() => {});
        throw error;
      }
    } else {
      await this.#installNavigationGuard(target, session.context);
    }
    session.guardInstalled = true;
  }

  async #releaseAttachedSession(target) {
    const session = this.sessions.get(target);
    if (!session || session.ownership !== "cdp_attached") return;
    this.sessions.delete(target);
    if (pageIsOpen(session.agentPage)) await session.agentPage.close?.().catch(() => {});
    // A recovery tab is left open for the user to finish a normal login or
    // security challenge. The next explicit check_login may attach to it.
    // For a connectOverCDP browser, browser.close() closes only Playwright's
    // WebSocket transport. It does not terminate the ordinary Chrome process.
    await session.browser?.close?.().catch(() => {});
  }

  #activePage(target) {
    const session = this.sessions.get(target);
    if (!session?.context) return null;
    // A CDP-attached session may also contain the user's human login tabs.
    // Adapters must never fall back to one of those tabs if the dedicated
    // Agent page was closed; fail closed and require an explicit reconnect.
    if (session.ownership === "cdp_attached") {
      return pageIsOpen(session.agentPage) ? session.agentPage : null;
    }
    if (pageIsOpen(session.currentPage)) return session.currentPage;
    const pages = session.context.pages().filter(pageIsOpen);
    session.currentPage = pages.at(-1) ?? null;
    return session.currentPage;
  }

  #loginInspectionPage(target) {
    const session = this.sessions.get(target);
    if (!session?.context) return null;
    // During the one explicit check_login attach, the Agent must inspect the
    // human page once to establish whether login succeeded. After an Agent tab
    // has been created, even a closed Agent tab must never cause a fallback to
    // that human page.
    if (session.ownership === "cdp_attached"
      && !session.agentPage
      && pageIsOpen(session.currentPage)) {
      return session.currentPage;
    }
    return this.#activePage(target);
  }

  // Internal daemon adapter escape hatch. The Page object is deliberately
  // returned by reference and must never be serialized into an MCP response.
  page(target) {
    const { name, definition } = requireTarget(target);
    const session = this.sessions.get(name);
    if (!session?.context) throw new Error(`${definition.label} 会话尚未启动`);
    if (session.routeRestartRequired) {
      throw sessionRouteError(
        "SESSION_ROUTE_RESTART_REQUIRED",
        `${definition.label} 当前代理路由与请求不一致；请保留登录 profile 并重新打开专用浏览器`
      );
    }
    if (session.ownership === "cdp_attached" && session.authenticated !== true) {
      throw new Error(`${definition.label} 尚未通过登录验证，Agent 不会读取或操作人工登录页面`);
    }
    const page = this.#activePage(name);
    if (!page) throw new Error(`${definition.label} 浏览器中没有可用页面`);
    return page;
  }

  startupPages(target) {
    if(target!=="tiktok_discovery")throw new Error("播放初始化只允许发现会话");
    const session=this.sessions.get(target);
    if(!session?.context||session.authenticated!==true||session.routeRestartRequired)throw new Error("播放初始化需要已认证的专用窗口");
    return session.context.pages().filter(page=>{
      if(!pageIsOpen(page))return false;
      try{const url=new URL(page.url());return url.origin==='https://www.tiktok.com'&&/^\/(?:(?:foryou|live)\/?|@[^/]+\/(?:live\/?|video\/\d+\/?))?$/.test(url.pathname);}catch{return false;}
    });
  }

  beginCountryWorkerRun(runId) {
    if (typeof runId !== "string" || !runId.trim() || runId.length > 256) {
      throw authenticatedRequestError("SESSION_REQUEST_RUN_INVALID", "国家处理器运行标识无效");
    }
    if (this.countryWorkerRun && !this.countryWorkerRun.ended) {
      throw authenticatedRequestError("SESSION_REQUEST_RUN_ACTIVE", "国家处理器运行尚未结束");
    }
    this.countryWorkerRun = { runId, closing: false, invalidated: false, ended: false, leases: new Map(), operations: new Set(), binding: null, ending: null };
  }

  async endCountryWorkerRun(runId) {
    const run = this.countryWorkerRun;
    // A delayed finalizer from an earlier run must never dispose a newer run.
    if (!run || run.runId !== runId) return;
    run.closing = true;
    if (!run.ending) run.ending = (async () => {
      await Promise.allSettled([...run.operations]);
      await Promise.allSettled([...run.leases.values()].map(async pending => {
        const lease = await pending;
        await lease.context.dispose();
      }));
      run.leases.clear();
      run.ended = true;
    })();
    await run.ending;
  }

  executeCountryFeedRequest(request, verifiedRoute) {
    return this.#dispatchCountryRequest("pc", request, verifiedRoute);
  }

  executeCountryDataRequest(request, verifiedRoute) {
    return this.#dispatchCountryRequest("data", request, verifiedRoute);
  }

  #dispatchCountryRequest(family, request, verifiedRoute) {
    const run = this.countryWorkerRun;
    if (run?.closing || run?.invalidated) return Promise.reject(authenticatedRequestError("SESSION_REQUEST_RUN_CLOSED", "国家处理器运行已经关闭"));
    const operation = this.#executeCountryRequest(family, request, verifiedRoute, run);
    if (run) run.operations.add(operation);
    return operation.catch(async error => {
      // Drain operations before disposing their jars, including in-flight initialization.
      if (run && invalidatesCountryWorkerRun(error)) {
        run.invalidated = true;
        await this.endCountryWorkerRun(run.runId);
      }
      throw error;
    }).finally(() => run?.operations.delete(operation));
  }

  async #executeCountryRequest(family, request, verifiedRoute, run) {
    const normalized = normalizedAuthenticatedRequest("tiktok_discovery", request, { allowDataUserAgent: family === "data" });
    const url = new URL(normalized.url);
    const dataEndpoint = DATA_ENDPOINTS[request.stage];
    if (family === "pc"
      ? request.stage !== "feed" || !["https://webcast.us.tiktok.com", "https://webcast.tiktok.com"].includes(url.origin) || url.pathname !== "/webcast/feed/"
      : !dataEndpoint || url.origin !== dataEndpoint[0] || url.pathname !== dataEndpoint[1]) {
      throw authenticatedRequestError("SESSION_REQUEST_URL_NOT_ALLOWED", "国家处理器只允许固定 web 端点");
    }
    const session = this.sessions.get("tiktok_discovery");
    if (!session?.context || session.authenticated !== true || !this.#activePage("tiktok_discovery")) {
      throw authenticatedRequestError("SESSION_REQUEST_AUTHENTICATION_REQUIRED", "国家处理器需要已核验的 TikTok 发现登录");
    }
    if (session.routeRestartRequired) {
      throw authenticatedRequestError("SESSION_ROUTE_RESTART_REQUIRED", "TikTok 发现会话线路已变更");
    }
    let policy;
    try { policy = normalizeRoutePolicy(verifiedRoute); } catch {
      throw authenticatedRequestError("SESSION_REQUEST_PROXY_UNVERIFIED", "国家采集线路无效");
    }
    const workId = request.workId;
    const laneIndex = family === "data" && workId === 4
      ? policy.collectionLanes.findIndex(lane => lane.countryCode === request.countryCode)
      : Number.isInteger(workId) && workId >= 1 && workId <= 3 ? workId - 1
      : family === "data" && (workId === null || workId === undefined) && policy.collectionLanes.length === 1 ? 0 : -1;
    const lane = policy.collectionLanes[laneIndex];
    if (verifiedRoute?.verificationStatus !== "verified"
      || policy.discoveryCountry !== "US" || verifiedRoute.discoveryProxyExitCountry !== "US"
      || session.routeFingerprint !== fingerprintDiscoverySessionRoute(policy)
      || !lane || lane.countryCode !== request.countryCode || lane.proxyServer !== normalized.proxyServer
      || verifiedRoute.collectionProxyExitCountries?.[laneIndex] !== lane.countryCode) {
      throw authenticatedRequestError("SESSION_REQUEST_PROXY_MISMATCH", "登录或国家槽与已核验线路不符");
    }
    const browserContext = session.context;
    const authenticationGeneration = session.authenticationGeneration ?? 0;
    const revokeAuthorization = (reason) => {
      // Fence all admitted lanes before releasing this response's queue turn.
      if (run) run.invalidated = true;
      if (this.sessions.get("tiktok_discovery") === session
        && session.context === browserContext
        && (session.authenticationGeneration ?? 0) === authenticationGeneration) {
        session.authenticated = false;
        session.authenticationGeneration = authenticationGeneration + 1;
        session.authenticationRevocationGeneration = (session.authenticationRevocationGeneration ?? 0) + 1;
        session.authorizationFailure = { reason, observedAt: new Date().toISOString() };
      }
    };
    const fingerprint = JSON.stringify([policy, verifiedRoute.collectionProxyExitCountries]);
    if (run) {
      if (run.binding && (run.binding.context !== session.context || run.binding.fingerprint !== fingerprint
        || run.binding.authenticationGeneration !== authenticationGeneration)) {
        run.invalidated = true;
        throw authenticatedRequestError("SESSION_REQUEST_AUTHENTICATION_REQUIRED", "国家处理器登录或线路身份已变更，需要新运行");
      }
      run.binding ??= { context: session.context, fingerprint, authenticationGeneration };
    }
    const profile = originalWebLiveProfileForCountry({ marketRegion: policy.marketRegion, countryCode: lane.countryCode });
    if (!profile || typeof session.context.cookies !== "function") {
      throw authenticatedRequestError("SESSION_REQUEST_AUTHENTICATION_REQUIRED", "发现登录会话不可用");
    }
    const key = `${family}:${laneIndex}:${lane.countryCode}:${lane.proxyServer}`;
    const initialize = async () => {
      // Only discovery cookies applicable to approved web hosts initialize a jar.
      const cookies = (await browserContext.cookies(["https://www.tiktok.com/", "https://webcast.us.tiktok.com/", "https://webcast.tiktok.com/"]))
        .filter(cookie => ["tiktok.com", "www.tiktok.com", "us.tiktok.com", "webcast.us.tiktok.com", "webcast.tiktok.com"]
          .includes(String(cookie.domain).replace(/^\./, ""))
          && (cookie.expires === -1 || cookie.expires > Date.now() / 1000));
      if (run?.invalidated || !cookies.length || this.sessions.get("tiktok_discovery") !== session || session.context !== browserContext || (session.authenticationGeneration ?? 0) !== authenticationGeneration || session.authenticated !== true || session.routeRestartRequired) {
        throw authenticatedRequestError("SESSION_REQUEST_AUTHENTICATION_REQUIRED", "发现会话缺少有效登录状态");
      }
      const context = await this.requestContextFactory.newContext({
        proxy: { server: lane.proxyServer },
        userAgent: family === "pc" ? `Mozilla/${profile.publicQuery.browser_version}` : DATA_USER_AGENT,
        extraHTTPHeaders: family === "pc" ? { accept: "*/*", "accept-language": "en-US,en;q=0.9", referer: "https://www.tiktok.com/" } : {},
        storageState: { cookies, origins: [] }, timeout: normalized.timeoutMs, ignoreHTTPSErrors: false
      });
      return { context, tail: Promise.resolve() };
    };
    let lease;
    let requestStartedAt = Date.now();
    try {
      let pending = run?.leases.get(key);
      if (!pending) {
        pending = initialize().catch(error => {
          // A failed initializer owns no context. Remove its promise so a
          // transient failure can retry without retaining a rejected cache entry.
          if (run?.leases.get(key) === pending) run.leases.delete(key);
          throw error;
        });
        run?.leases.set(key, pending); // publish promise before awaiting; one initializer per lane
      }
      lease = await pending;
      const fetch = async () => {
        // A rejected predecessor invalidates the run before releasing its jar
        // turn. Explicit end still drains requests already admitted.
        if (run?.invalidated) {
          throw authenticatedRequestError("SESSION_REQUEST_RUN_CLOSED", "国家处理器运行已经失效");
        }
        if (this.sessions.get("tiktok_discovery") !== session
          || session.context !== browserContext
          || (session.authenticationGeneration ?? 0) !== authenticationGeneration
          || (run && session.context !== run.binding.context)
          || session.routeFingerprint !== fingerprintDiscoverySessionRoute(policy)
          || session.authenticated !== true || session.routeRestartRequired || !this.#activePage("tiktok_discovery")) {
          throw authenticatedRequestError("SESSION_REQUEST_AUTHENTICATION_REQUIRED", "发现登录状态已经失效");
        }
        requestStartedAt = Date.now();
        const response = await lease.context.get(normalized.url, {
          timeout: normalized.timeoutMs, maxRedirects: 0, failOnStatusCode: false,
          headers: normalized.headers
        });
        try {
          const status = response.status();
          if (status === 401 || status === 403) {
            revokeAuthorization(`http_${status}`);
            throw authenticatedRequestError("SESSION_REQUEST_AUTHENTICATION_REQUIRED", "国家 HTTP 请求的认证已被拒绝");
          }
          const finalUrl = new URL(response.url());
          if ((status >= 300 && status < 400) || finalUrl.origin !== url.origin || finalUrl.pathname !== url.pathname
            || finalUrl.username || finalUrl.password || finalUrl.hash) {
            throw authenticatedRequestError("SESSION_REQUEST_REDIRECT_REJECTED", "国家请求拒绝重定向");
          }
          const body = await response.body();
          if (body.byteLength > normalized.maxResponseBytes) {
            throw authenticatedRequestError("SESSION_REQUEST_RESPONSE_TOO_LARGE", "国家请求响应超过上限");
          }
          let payload;
          try { payload = JSON.parse(body.toString("utf8")); } catch { /* Transport owns non-JSON diagnostics. */ }
          const businessCode = payload?.status_code ?? payload?.statusCode ?? payload?.code;
          if (status >= 200 && status < 300 && (businessCode === 20003 || businessCode === "20003")) {
            revokeAuthorization("business_20003");
            throw authenticatedRequestError("SESSION_REQUEST_AUTHENTICATION_REQUIRED", "国家 HTTP 请求的登录状态已被拒绝");
          }
          const contentType = safeContentType(typeof response.headerValue === "function"
            ? await response.headerValue("content-type") : response.headers?.()["content-type"]);
          return Object.freeze({ status, url: `${finalUrl.origin}${finalUrl.pathname}`, body: body.toString("utf8"),
            contentType, elapsedMs: Math.max(0, Date.now() - requestStartedAt) });
        } finally {
          // APIRequestContext retains response buffers until disposal; free each
          // response while preserving the long-lived cookie jar.
          await response.dispose?.().catch(() => {});
        }
      };
      const result = lease.tail.then(fetch);
      lease.tail = result.catch(error => {
        // This handler runs before any queued successor receives its turn;
        // the outer operation cleanup alone is too late to fence that send.
        if (run && invalidatesCountryWorkerRun(error)) run.invalidated = true;
      });
      return await result;
    } catch (error) {
      if (String(error?.code).startsWith("SESSION_REQUEST_") || error?.code === "SESSION_ROUTE_RESTART_REQUIRED") throw error;
      const failure = authenticatedRequestError("SESSION_REQUEST_FAILED", "国家 HTTP 请求失败");
      failure.transportDiagnostics = transportFailureDiagnostics(error, requestStartedAt);
      throw failure;
    } finally {
      if (!run) await lease?.context.dispose().catch(() => {});
    }
  }

  async executeAuthenticatedRequest(target, request) {
    const { name, definition } = requireTarget(target);
    const normalized = normalizedAuthenticatedRequest(name, request);
    const session = this.sessions.get(name);
    if (!session?.context || session.authenticated !== true) {
      throw authenticatedRequestError(
        "SESSION_REQUEST_AUTHENTICATION_REQUIRED",
        `${definition.label} 尚未成为已验证的登录会话`
      );
    }
    if (session.routeRestartRequired) {
      throw authenticatedRequestError(
        "SESSION_ROUTE_RESTART_REQUIRED",
        `${definition.label} 当前代理路由需要重新打开`
      );
    }

    let sessionProxyServer;
    try {
      sessionProxyServer = normalizeProxyServer(session.route?.proxyServer);
    } catch {
      throw authenticatedRequestError(
        "SESSION_REQUEST_PROXY_UNVERIFIED",
        `${definition.label} 当前浏览器没有可验证的代理绑定`
      );
    }
    if (sessionProxyServer !== normalized.proxyServer) {
      throw authenticatedRequestError(
        "SESSION_REQUEST_PROXY_MISMATCH",
        `${definition.label} 当前浏览器代理与该请求要求的代理不一致`
      );
    }

    const page = this.#activePage(name);
    if (!page || typeof page.evaluate !== "function") {
      throw authenticatedRequestError(
        "SESSION_REQUEST_PAGE_UNAVAILABLE",
        `${definition.label} 没有可执行会话请求的 Agent 页面`
      );
    }

    let result;
    try {
      result = await page.evaluate(async ({ requestUrl, headers, timeoutMs, maxResponseBytes }) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(requestUrl, {
            method: "GET",
            headers,
            credentials: "include",
            redirect: "manual",
            cache: "no-store",
            signal: controller.signal
          });
          if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
            return { failure: "redirect_rejected" };
          }
          let responseUrl = "unavailable";
          try {
            const parsed = new URL(response.url || requestUrl);
            responseUrl = `${parsed.origin}${parsed.pathname}`;
          } catch {
            // The caller rejects an unavailable response URL.
          }

          const reader = response.body?.getReader?.();
          if (!reader) {
            const body = await response.text();
            if (new TextEncoder().encode(body).byteLength > maxResponseBytes) {
              return { failure: "response_too_large" };
            }
            return { status: response.status, url: responseUrl, body };
          }

          const decoder = new TextDecoder();
          let received = 0;
          let body = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > maxResponseBytes) {
              await reader.cancel().catch(() => {});
              return { failure: "response_too_large" };
            }
            body += decoder.decode(value, { stream: true });
          }
          body += decoder.decode();
          return { status: response.status, url: responseUrl, body };
        } catch (error) {
          return { failure: error?.name === "AbortError" ? "timeout" : "request_failed" };
        } finally {
          clearTimeout(timeout);
        }
      }, {
        requestUrl: normalized.url,
        headers: normalized.headers,
        timeoutMs: normalized.timeoutMs,
        maxResponseBytes: normalized.maxResponseBytes
      });
    } catch {
      throw authenticatedRequestError(
        "SESSION_REQUEST_FAILED",
        `${definition.label} 会话内请求失败`
      );
    }

    if (result?.failure === "redirect_rejected") {
      throw authenticatedRequestError("SESSION_REQUEST_REDIRECT_REJECTED", "会话请求拒绝重定向");
    }
    if (result?.failure === "response_too_large") {
      throw authenticatedRequestError("SESSION_REQUEST_RESPONSE_TOO_LARGE", "会话请求响应超过上限");
    }
    if (result?.failure === "timeout") {
      throw authenticatedRequestError("SESSION_REQUEST_TIMEOUT", "会话请求超时");
    }
    if (!result || result.failure || !Number.isSafeInteger(result.status)
      || typeof result.url !== "string" || typeof result.body !== "string") {
      throw authenticatedRequestError("SESSION_REQUEST_FAILED", "会话内请求没有返回可验证结果");
    }
    return Object.freeze({ status: result.status, url: result.url, body: result.body });
  }

  async status(target) {
    if (target === undefined) {
      const entries = await Promise.all(SESSION_TARGET_NAMES.map(async (name) => [name, await this.status(name)]));
      return Object.fromEntries(entries);
    }
    const { name, definition } = requireTarget(target);
    const session = this.sessions.get(name);
    if (!session?.context) {
      const manual = this.platform === "darwin"
        ? await this.#refreshManualState(name, definition)
        : this.manualSessions.get(name);
      if (manual?.state === "running" || manual?.state === "starting") {
        return {
          target: name,
          label: definition.label,
          running: true,
          engine: manual.engine,
          mode: "manual_login",
          manualLoginInProgress: true,
          manualOwnerVerified: true,
          takeoverReady: false,
          attachReady: Number.isInteger(manual.debugPort),
          authenticatedRequestReady: false,
          ...routeStatus(manual),
          // The agent never observes the manually controlled browser. Report
          // only the sanitized URL it launched, never current tabs or titles.
          pages: [{ url: sanitizeSessionUrl(manual.destination), title: "", active: true }]
        };
      }
      if (manual?.state === "owner_unverified") {
        return {
          target: name,
          label: definition.label,
          running: true,
          engine: manual.engine,
          mode: "manual_login_owner_unverified",
          manualLoginInProgress: true,
          manualOwnerVerified: false,
          takeoverReady: false,
          attachReady: false,
          authenticatedRequestReady: false,
          ...routeStatus(manual),
          pages: []
        };
      }
      if (manual?.state === "closed") {
        return {
          target: name,
          label: definition.label,
          running: false,
          engine: manual.engine,
          mode: "manual_browser_closed",
          manualLoginInProgress: false,
          manualOwnerVerified: false,
          takeoverReady: false,
          attachReady: false,
          authenticatedRequestReady: false,
          reopenRequired: true,
          ...routeStatus(manual),
          pages: []
        };
      }
      return {
        target: name,
        label: definition.label,
        running: false,
        engine: null,
        mode: null,
        manualLoginInProgress: false,
        manualOwnerVerified: false,
        takeoverReady: false,
        attachReady: false,
        authenticatedRequestReady: false,
        ...routeStatus(null),
        pages: []
      };
    }
    const pages = [];
    const visiblePages = session.ownership === "cdp_attached"
      ? [session.agentPage ?? session.recoveryPage].filter(pageIsOpen)
      : session.context.pages();
    for (const page of visiblePages) {
      if (!pageIsOpen(page)) continue;
      pages.push({
        url: sanitizeSessionUrl(page.url()),
        // Titles can contain an account identifier on some sites. They are not
        // needed for Agent control, so never serialize them across RPC.
        title: "",
        active: page === session.currentPage
      });
    }
    return {
      target: name,
      label: definition.label,
      running: true,
      engine: session.engine,
      mode: session.ownership === "cdp_attached" ? "agent_attached" : "agent_controlled",
      manualLoginInProgress: false,
      manualOwnerVerified: session.ownership === "cdp_attached",
      takeoverReady: false,
      attachReady: session.ownership === "cdp_attached",
      authorizationFailure: session.authorizationFailure ?? null,
      authenticatedRequestReady: session.authenticated === true
        && !session.routeRestartRequired
        && Boolean(this.#activePage(name)),
      ...routeStatus(session),
      pages
    };
  }

  async checkLogin(target) {
    const { name, definition } = requireTarget(target);
    // Once an Agent-controlled context exists, it is the authoritative owner
    // of the profile. A delayed/stale manual-state write must never reclassify
    // that very Chrome process as an in-progress human login merely because it
    // owns the same SingletonLock.
    const activeSession = this.sessions.get(name);
    const manual = activeSession?.context
      ? null
      : (this.platform === "darwin"
          ? await this.#refreshManualState(name, definition)
          : this.manualSessions.get(name));
    const routeHolder = activeSession?.context ? activeSession : manual;
    if (routeHolder?.routeRestartRequired) {
      return {
        target: name,
        state: "route_restart_required",
        authenticated: null,
        requiresUserAction: true,
        restartRequired: true,
        routeFingerprint: routeHolder.routeFingerprint ?? null,
        routeCountry: routeHolder.routeCountry ?? null,
        message: `${definition.label} 当前代理路由与请求不一致；请关闭该专用窗口后按目标国家重新打开，登录 profile 不会被删除`
      };
    }
    if (manual?.state === "running" || manual?.state === "starting") {
      try {
        await this.#attachRunningManualLogin(name, definition);
      } catch (error) {
        const restartRequired = !Number.isInteger(manual.debugPort);
        return {
          target: name,
          state: restartRequired ? "manual_login_restart_required" : "manual_connection_pending",
          authenticated: null,
          requiresUserAction: restartRequired,
          url: sanitizeSessionUrl(manual.destination),
          message: restartRequired
            ? `这是旧版打开的 ${definition.label} 普通 Chrome；请关闭该专用窗口后重新执行 start_login，登录资料不会被删除`
            : `${definition.label} 普通 Chrome 正在启动或本机连接尚未就绪，请保持窗口打开并稍后重试`
        };
      }
    }
    if (manual?.state === "owner_unverified") {
      return {
        target: name,
        state: "manual_login_owner_unverified",
        authenticated: null,
        requiresUserAction: true,
        message: `检测到 ${definition.label} 独立配置仍被无法安全核验的 Chrome 进程或锁占用；Agent 不会删除锁或强行连接`
      };
    }
    if (manual?.state === "closed") {
      return {
        target: name,
        state: "stopped",
        authenticated: null,
        requiresUserAction: true,
        message: `${definition.label} 普通 Chrome 已关闭；请重新执行 start_login，登录资料仍会保留`
      };
    }
    const page = this.#loginInspectionPage(name);
    if (!page) {
      await this.#releaseAttachedSession(name);
      return {
        target: name,
        state: "stopped",
        authenticated: null,
        requiresUserAction: true,
        message: `请先启动 ${definition.label} 登录窗口`
      };
    }

    const inspectedSession = this.sessions.get(name);
    const inspectedContext = inspectedSession?.context;
    const authenticationRevocationGeneration = inspectedSession?.authenticationRevocationGeneration ?? 0;
    const inspectionCurrent = () => this.sessions.get(name) === inspectedSession
      && inspectedSession?.context === inspectedContext
      && (inspectedSession?.authenticationRevocationGeneration ?? 0) === authenticationRevocationGeneration;
    const staleInspection = () => ({ target: name, state: "unknown", authenticated: null,
      requiresUserAction: false, message: "登录检查期间会话已变更，请重新检查当前会话" });
    const rawUrl = page.url();
    const outputUrl = sanitizeSessionUrl(rawUrl);
    const previouslyAuthenticated = this.sessions.get(name)?.authenticated === true;
    if (!isAllowedSessionUrl(name, rawUrl, { allowBlank: true })) {
      const failedSession = this.sessions.get(name);
      if (failedSession) failedSession.authenticated = false;
      await this.#releaseAttachedSession(name);
      return {
        target: name,
        state: "blocked_navigation",
        authenticated: false,
        requiresUserAction: true,
        url: outputUrl,
        message: "当前页面不在该会话的白名单中，已停止自动判断"
      };
    }

    let dom = { captcha: false, authentication: false, authenticated: false };
    try {
      dom = await inspectLoginDom(page, name);
    } catch {
      if (!inspectionCurrent()) return staleInspection();
      if (!previouslyAuthenticated) await this.#releaseAttachedSession(name);
      return {
        target: name,
        state: "unknown",
        authenticated: null,
        requiresUserAction: false,
        url: outputUrl,
        message: "页面正在加载或跳转，请稍后重新检查"
      };
    }

    if (!inspectionCurrent()) return staleInspection();
    if (dom.captcha || verificationFromUrl(rawUrl)) {
      const failedSession = this.sessions.get(name);
      if (failedSession) failedSession.authenticated = false;
      await this.#releaseAttachedSession(name);
      return {
        target: name,
        state: "manual_verification",
        authenticated: false,
        requiresUserAction: true,
        url: outputUrl,
        message: "检测到验证码或安全验证，请在浏览器窗口中手动完成；系统不会尝试绕过"
      };
    }
    if (dom.authentication) {
      const failedSession = this.sessions.get(name);
      if (failedSession) failedSession.authenticated = false;
      await this.#releaseAttachedSession(name);
      return {
        target: name,
        state: "authentication_required",
        authenticated: false,
        requiresUserAction: true,
        url: outputUrl,
        message: "请在浏览器窗口中手动登录；不要向智能体提供密码、Cookie 或 Token"
      };
    }

    if (dom.authenticated === true) {
      try {
        await this.#ensureNavigationGuard(name);
        if (!inspectionCurrent()) return staleInspection();
        inspectedSession.authenticated = true;
        inspectedSession.authenticationGeneration = (inspectedSession.authenticationGeneration ?? 0) + 1;
        inspectedSession.authorizationFailure = null;
      } catch {
        if (!inspectionCurrent()) return staleInspection();
        await this.#releaseAttachedSession(name);
        return {
          target: name,
          state: "agent_page_unavailable",
          authenticated: null,
          requiresUserAction: false,
          url: outputUrl,
          message: "登录已识别，但 Agent 专用页面尚未准备好；普通 Chrome 与登录状态未被关闭，请稍后重试"
        };
      }
      return {
        target: name,
        state: "authenticated",
        authenticated: true,
        requiresUserAction: false,
        url: outputUrl,
        message: `${definition.label} 登录状态已就绪`
      };
    }
    // URL is only a fallback after explicit DOM evidence. A login-looking URL
    // may remain in history after a successful login; conversely, application
    // routes can remain after a session expires.
    if (authenticationFromUrl(name, rawUrl)) {
      const failedSession = this.sessions.get(name);
      if (failedSession) failedSession.authenticated = false;
      await this.#releaseAttachedSession(name);
      return {
        target: name,
        state: "authentication_required",
        authenticated: false,
        requiresUserAction: true,
        url: outputUrl,
        message: "请在浏览器窗口中手动登录；不要向智能体提供密码、Cookie 或 Token"
      };
    }
    const currentSession = this.sessions.get(name);
    if (previouslyAuthenticated
      && currentSession?.ownership === "cdp_attached"
      && page === currentSession.agentPage) {
      return {
        target: name,
        state: "authenticated",
        authenticated: true,
        requiresUserAction: false,
        url: outputUrl,
        message: `${definition.label} 已沿用本次连接中验证过的登录状态`
      };
    }
    if (!previouslyAuthenticated) await this.#releaseAttachedSession(name);
    return {
      target: name,
      state: "unknown",
      authenticated: null,
      requiresUserAction: false,
      url: outputUrl,
      message: "当前页面没有足够证据确认登录状态，请完成登录后重新检查"
    };
  }

  async #terminateManualTarget(target, definition) {
    let manual = await this.#refreshManualState(target, definition);
    if (!manual) return;
    if (manual.state === "owner_unverified" || (manual.state === "running" && !manual.ownerVerified)) {
      throw new Error(`${definition.label} 的 Chrome 进程身份无法安全核验；Agent 拒绝终止任何进程，请先用 Command-Q 完全退出专用 Chrome`);
    }
    if (manual.state === "running" || manual.state === "starting") {
      const pid = manual.pid;
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error(`${definition.label} 的专用 Chrome PID 无法核验；Agent 拒绝终止任何进程`);
      }
      // Final TOCTOU guard immediately before SIGTERM. PID reuse or a changed
      // argv/start identity must fail closed even if the earlier refresh was
      // valid.
      const finalInspection = await this.processInspector(pid);
      const finalIdentityMatches = finalInspection?.alive === true
        && commandOwnsProfile(finalInspection, this.profileDirectory(target), this.chromeExecutable)
        && typeof manual.processStartedAt === "string"
        && manual.processStartedAt.length > 0
        && finalInspection.startedAt === manual.processStartedAt;
      if (!finalIdentityMatches) {
        throw new Error(`${definition.label} 的专用 Chrome 进程身份在关闭前发生变化；Agent 拒绝发送任何信号`);
      }
      try {
        if (manual.child) {
          if (manual.child.kill?.("SIGTERM") === false) {
            throw new Error("专用 Chrome 进程未接受关闭请求");
          }
        } else {
          // Exact verified PID only. Never pkill, pattern-match, or signal the
          // user's everyday Chrome profile.
          this.processSignaler(pid, "SIGTERM");
        }
      } catch (error) {
        throw new Error(`无法安全关闭 ${definition.label} 专用 Chrome：${error?.message || error}`);
      }

      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        manual = await this.#refreshManualState(target, definition);
        if (!manual || manual.state === "closed") break;
        if (manual.state === "owner_unverified") {
          throw new Error(`${definition.label} 关闭后仍存在无法核验的配置锁；Agent 不会删除该锁`);
        }
      }
      if (manual && manual.state !== "closed") {
        throw new Error(`${definition.label} 专用 Chrome 尚未完全退出，请手动关闭后重试`);
      }
    }
    this.manualSessions.delete(target);
    await this.#removeManualState(target);
  }

  async #stopTarget(target, { terminateManual = false } = {}) {
    if (target === "tiktok_discovery" && this.countryWorkerRun) {
      await this.endCountryWorkerRun(this.countryWorkerRun.runId);
    }
    const session = this.sessions.get(target);
    if (session?.context) {
      this.sessions.delete(target);
      // A CDP-attached context is the user's still-running ordinary Chrome.
      // Close only the Agent-owned tab and the CDP WebSocket transport; never
      // close the attached default context or terminate ordinary Chrome.
      if (session.ownership === "cdp_attached") {
        if (pageIsOpen(session.agentPage)) await session.agentPage.close?.().catch(() => {});
        await session.browser?.close?.().catch(() => {});
      } else {
        await session.context.close();
      }
    }
    if (terminateManual) {
      const { definition } = requireTarget(target);
      await this.#terminateManualTarget(target, definition);
    }
  }

  async reset(target) {
    const { name } = requireTarget(target);
    await this.startPromises.get(name)?.catch(() => {});
    await this.#stopTarget(name, { terminateManual: true });
    const profileDirectory = this.profileDirectory(name);
    const archivedPath = `${profileDirectory}.reset-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    let archived = false;
    try {
      await rename(profileDirectory, archivedPath);
      archived = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { target: name, reset: true, running: false, archived, archivedPath: archived ? archivedPath : null };
  }

  async reopen(target, { route } = {}) {
    if (target !== "collection_backstage" || this.platform !== "darwin" || !route) {
      throw new Error("只允许以已验证线路恢复采集子后台官方页面");
    }
    await this.startPromises.get(target)?.catch(() => {});
    if (this.sessions.get(target)?.context) {
      throw new Error("采集子后台已由 Agent 连接；拒绝重复打开恢复页面");
    }
    const bound = await this.bindExistingRoute(target, { route });
    if (!bound.running || bound.manualOwnerVerified !== true || bound.restartRequired) {
      throw new Error("采集子后台现有 Chrome 的进程或线路身份不匹配；拒绝打开恢复页面");
    }
    await this.#attachRunningManualLogin(target, SESSION_TARGETS[target]);
    const session = this.sessions.get(target);
    if (session?.ownership !== "cdp_attached" || !session.context) {
      throw new Error("采集子后台未能连接到已核验的专用 Chrome");
    }
    let page = null;
    try {
      page = await session.context.newPage();
      await this.#installNavigationGuard(target, page);
      await page.goto(SESSION_TARGETS[target].takeoverUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000
      });
      if (!isAllowedSessionUrl(target, page.url())) {
        throw new Error("恢复页面未停留在采集子后台的官方白名单域名");
      }
      session.recoveryPage = page;
      session.currentPage = page;
      await page.bringToFront?.();
      return this.status(target);
    } catch (error) {
      if (pageIsOpen(page)) await page.close?.().catch(() => {});
      await this.#releaseAttachedSession(target);
      throw error;
    }
  }

  async stopAll() {
    if (this.countryWorkerRun) await this.endCountryWorkerRun(this.countryWorkerRun.runId);
    await Promise.allSettled([...this.startPromises.values()]);
    // Daemon shutdown must not kill the ordinary Chrome window. Its durable
    // state lets the next daemon instance recover ownership fail-closed.
    const running = [...this.sessions.keys()];
    const preservedManual = [...this.manualSessions.entries()]
      .filter(([, manual]) => manual.state === "running" || manual.state === "starting" || manual.state === "owner_unverified")
      .map(([target]) => target);
    const results = await Promise.allSettled(running.map((target) => this.#stopTarget(target)));
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map((result) => result.reason), "部分浏览器会话关闭失败");
    return { stopped: running, preservedManual };
  }
}
