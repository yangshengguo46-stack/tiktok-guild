import crypto from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";

// DownloadCoreDLL contract recovered from TK主播助手9.9's Go metadata and
// machine code. The original sequence is:
//
//   Login (shared cookie jar) -> GET BaseURL+/Core/Core.dll -> Core.dll
//   -> countryloader.LoadCountryData -> country.mobileHeader
//
// The downloaded payload contains authorization-bearing mobile request
// headers. This module intentionally reproduces only the download contract. It
// accepts no username, password, cookie, token, or arbitrary headers and it
// cannot import/activate the original supplier's authorization material.

export const RECOVERED_DOWNLOAD_CORE_DLL_VERSION = "tksoft-9.9-download-core-dll-v1";
export const RECOVERED_DOWNLOAD_CORE_DLL_PROFILE = Object.freeze({
  version: RECOVERED_DOWNLOAD_CORE_DLL_VERSION,
  originalFunction: "playwright-go/api.(*Client).DownloadCoreDLL",
  requestMethod: "GET",
  requestPath: "/Core/Core.dll",
  successStatus: 200,
  originalSessionKind: "shared_cookie_jar_http_client_after_login",
  originalLoopbackProxy: "http://127.0.0.1:10831",
  localFilename: "Core.dll",
  nextFunction: "playwright-go/countryloader.LoadCountryData",
  decodedFieldKind: "country_mobile_header_map",
  codeRecovered: true,
  networkDownloadPerformed: false,
  acceptsRawCredentials: false,
  supplierAuthorizationReusable: false,
  authorizationBoundary: "user_owned_runtime_only"
});

const USER_OWNED_AUTHORIZATION_SOURCE = "user_owned_runtime";
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const MIN_MAX_BYTES = 1;
const MAX_MAX_BYTES = 64 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

function coreError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function exactCoreUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(String(baseUrl));
  } catch {
    throw coreError("core_bundle_base_url_invalid", "Core bundle base URL is invalid");
  }
  const loopbackHttp = parsed.protocol === "http:"
    && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  if ((parsed.protocol !== "https:" && !loopbackHttp)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) {
    throw coreError("core_bundle_base_url_invalid", "Core bundle base URL is not allowed");
  }
  const prefix = parsed.href.replace(/\/$/, "");
  return `${prefix}${RECOVERED_DOWNLOAD_CORE_DLL_PROFILE.requestPath}`;
}

function loopbackProxy(value) {
  if (value === undefined || value === null || value === "") return null;
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw coreError("core_bundle_proxy_invalid", "Core bundle proxy URL is invalid");
  }
  if (!["http:", "https:", "socks5:"].includes(parsed.protocol)
    || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
    || parsed.username
    || parsed.password
    || !parsed.port
    || (parsed.pathname && parsed.pathname !== "/")
    || parsed.search
    || parsed.hash) {
    throw coreError("core_bundle_proxy_invalid", "Only credential-free loopback proxies are allowed");
  }
  return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
}

function boundedMaxBytes(value) {
  if (value === undefined) return DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(value) || value < MIN_MAX_BYTES || value > MAX_MAX_BYTES) {
    throw coreError("core_bundle_size_limit_invalid", "Core bundle size limit is invalid");
  }
  return value;
}

function responseStatus(response) {
  return typeof response?.status === "function" ? response.status() : response?.status;
}

function responseUrl(response) {
  return typeof response?.url === "function" ? response.url() : response?.url;
}

async function responseChunks(response) {
  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            if (value?.byteLength) yield Buffer.from(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
    };
  }
  if (typeof response?.body === "function") {
    const bytes = await response.body();
    return [Buffer.from(bytes)];
  }
  if (typeof response?.arrayBuffer === "function") {
    return [Buffer.from(await response.arrayBuffer())];
  }
  throw coreError("core_bundle_response_body_missing", "Core bundle response has no readable body");
}

/**
 * Plugin-native implementation of the recovered DownloadCoreDLL contract.
 *
 * `request` must be an already-authenticated, user-owned session adapter. The
 * adapter receives no authorization values from this function. The downloaded
 * encrypted bundle is stored with owner-only permissions and is not parsed or
 * activated here.
 */
export async function downloadRecoveredCoreDLL({
  authorizationSource,
  baseUrl,
  targetDirectory,
  request,
  proxyUrl = null,
  signal,
  maxBytes
}) {
  if (authorizationSource !== USER_OWNED_AUTHORIZATION_SOURCE) {
    throw coreError(
      "core_bundle_user_authorization_required",
      "A user-owned authenticated runtime is required"
    );
  }
  if (typeof request !== "function") {
    throw coreError("core_bundle_request_adapter_missing", "Core bundle request adapter is missing");
  }
  if (typeof targetDirectory !== "string" || !targetDirectory.trim()) {
    throw coreError("core_bundle_target_invalid", "Core bundle target directory is invalid");
  }

  const requestUrl = exactCoreUrl(baseUrl);
  const safeProxyUrl = loopbackProxy(proxyUrl);
  const byteLimit = boundedMaxBytes(maxBytes);
  const destinationPath = path.join(path.resolve(targetDirectory), "Core.dll");
  const temporaryPath = `${destinationPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle = null;

  try {
    const response = await request(requestUrl, {
      method: RECOVERED_DOWNLOAD_CORE_DLL_PROFILE.requestMethod,
      proxyUrl: safeProxyUrl,
      signal
    });
    const status = responseStatus(response);
    if (status !== RECOVERED_DOWNLOAD_CORE_DLL_PROFILE.successStatus) {
      throw coreError(
        "core_bundle_http_status_invalid",
        `Core bundle server returned HTTP ${String(status)}`,
        { status }
      );
    }
    const finalUrl = responseUrl(response);
    if (finalUrl && finalUrl !== requestUrl) {
      throw coreError("core_bundle_redirect_rejected", "Core bundle redirect was rejected");
    }

    const chunks = await responseChunks(response);
    handle = await open(temporaryPath, "wx", 0o600);
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    for await (const chunk of chunks) {
      bytes += chunk.byteLength;
      if (bytes > byteLimit) {
        throw coreError("core_bundle_too_large", "Core bundle exceeds the configured size limit");
      }
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
    if (bytes === 0) throw coreError("core_bundle_empty", "Core bundle is empty");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, destinationPath);
    return Object.freeze({
      status: "downloaded_not_activated",
      version: RECOVERED_DOWNLOAD_CORE_DLL_VERSION,
      destinationPath,
      bytes,
      sha256: hash.digest("hex"),
      authorizationSource: USER_OWNED_AUTHORIZATION_SOURCE,
      supplierAuthorizationReused: false,
      nextStep: "validate_user_owned_bundle_before_activation"
    });
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
