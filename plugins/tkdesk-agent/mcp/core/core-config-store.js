import crypto from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CORE_MASTER_KEY_BYTES,
  createDefaultCoreKeyProvider
} from "./key-provider.js";
import { originalExecutableProfiles } from "./original-country-config.js";
import { runtimePaths } from "./runtime-paths.js";

export const CORE_BUNDLE_SCHEMA_VERSION = "tkdesk.core.bundle.v1";
export const CORE_BUNDLE_ENCRYPTION = "aes-256-gcm+hkdf-sha256";

const MAGIC = Buffer.from("TKDCOR01", "ascii");
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HKDF_INFO = Buffer.from("tkdesk-agent/core-bundle/v1", "utf8");
const MOBILE_AUTH_KIND = "x-tt-token";
const TOKEN_PATTERN = /^[\x21-\x7e]{16,4096}$/;

const DEFAULT_USER_AGENT = "com.zhiliaoapp.musically/2022602030 (Linux; U; Android 7.1.2; id; SM-G9750; Build/LMY47I;tt-ok/3.12.13.1)";
const DEFAULT_BASE_PARAMS = Object.freeze({
  use_simple_user: "true",
  league_phase: "0",
  ac: "wifi",
  channel: "googleplay",
  aid: "1233",
  app_name: "musical_ly",
  version_code: "320701",
  version_name: "32.7.1"
});

export const DEFAULT_CORE_COUNTRY_PROFILES = Object.freeze(
  originalExecutableProfiles().map((profile) => Object.freeze({
    countryCode: profile.countryCode,
    marketRegion: profile.marketRegion,
    profileId: profile.id,
    canonicalUrl: profile.canonicalUrl,
    mobileUserAgent: DEFAULT_USER_AGENT,
    baseParams: DEFAULT_BASE_PARAMS,
    topCode: profile.topCode,
    rankTypeCode: 16,
    regionTypeCode: 1,
    gapIntervals: Object.freeze([0, -1])
  }))
);

function coreError(message, code, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function nowIso(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw coreError("Core 时钟无效", "core_clock_invalid");
  return date.toISOString();
}

function normalizedCountryCode(value) {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(text) ? text : null;
}

function normalizedMarketRegion(value) {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z0-9_-]{2,32}$/.test(text) ? text : null;
}

function validatedExpiry(value, installedAtMs) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= installedAtMs) {
    throw coreError("移动授权过期时间无效", "mobile_authorization_expiry_invalid");
  }
  return date.toISOString();
}

function safeAuthorizationState(value) {
  return ["ready", "missing", "expired", "unsupported_country", "market_mismatch", "invalid"]
    .includes(value) ? value : "invalid";
}

function defaultBundle(at) {
  return {
    schemaVersion: CORE_BUNDLE_SCHEMA_VERSION,
    coreVersion: 1,
    createdAt: at,
    updatedAt: at,
    countries: DEFAULT_CORE_COUNTRY_PROFILES.map((profile) => ({
      ...profile,
      baseParams: { ...profile.baseParams },
      gapIntervals: [...profile.gapIntervals]
    })),
    mobileAuthorization: null
  };
}

function uninitializedStatus() {
  const countryCodes = [...new Set(
    DEFAULT_CORE_COUNTRY_PROFILES.map((profile) => profile.countryCode)
  )].sort();
  return Object.freeze({
    state: "uninitialized",
    schemaVersion: CORE_BUNDLE_SCHEMA_VERSION,
    coreVersion: 1,
    encryption: CORE_BUNDLE_ENCRYPTION,
    countries: Object.freeze({
      count: DEFAULT_CORE_COUNTRY_PROFILES.length,
      uniqueCountryCount: countryCodes.length,
      countryCodes: Object.freeze(countryCodes),
      marketRegions: Object.freeze([...new Set(
        DEFAULT_CORE_COUNTRY_PROFILES.map((profile) => profile.marketRegion)
      )].sort())
    }),
    mobileAuthorization: Object.freeze({
      state: "missing",
      configured: false,
      usable: false,
      kind: null,
      marketRegion: null,
      countryCodes: Object.freeze([]),
      installedAt: null,
      expiresAt: null,
      provenance: null
    }),
    secretValuesExposed: false,
    supplierCredentialsCopied: false
  });
}

function validateCountryProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const countryCode = normalizedCountryCode(value.countryCode);
  const marketRegion = normalizedMarketRegion(value.marketRegion);
  if (!countryCode || !marketRegion || typeof value.profileId !== "string") return null;
  let url;
  try {
    url = new URL(value.canonicalUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
    || url.pathname !== "/webcast/ranklist/list/v2/"
    || typeof value.mobileUserAgent !== "string"
    || value.mobileUserAgent.length < 20
    || value.mobileUserAgent.length > 500
    || value.rankTypeCode !== 16
    || value.regionTypeCode !== 1
    || !Array.isArray(value.gapIntervals)
    || value.gapIntervals.length !== 2
    || value.gapIntervals[0] !== 0
    || value.gapIntervals[1] !== -1
    || !value.baseParams
    || typeof value.baseParams !== "object"
    || Array.isArray(value.baseParams)) {
    return null;
  }
  const expected = DEFAULT_CORE_COUNTRY_PROFILES.find((profile) => (
    profile.countryCode === countryCode
    && profile.marketRegion === marketRegion
    && profile.profileId === value.profileId
  ));
  if (!expected
    || expected.canonicalUrl !== url.href
    || expected.mobileUserAgent !== value.mobileUserAgent
    || (value.topCode !== undefined && value.topCode !== expected.topCode)
    || JSON.stringify(expected.baseParams) !== JSON.stringify(value.baseParams)) {
    return null;
  }
  return {
    countryCode,
    marketRegion,
    profileId: value.profileId,
    canonicalUrl: url.href,
    mobileUserAgent: value.mobileUserAgent,
    baseParams: { ...value.baseParams },
    topCode: expected.topCode,
    rankTypeCode: 16,
    regionTypeCode: 1,
    gapIntervals: [0, -1]
  };
}

function validateBundle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== CORE_BUNDLE_SCHEMA_VERSION
    || value.coreVersion !== 1
    || !Array.isArray(value.countries)
    || value.countries.length < 1
    || value.countries.length > DEFAULT_CORE_COUNTRY_PROFILES.length) {
    throw coreError("Core 配置结构无效", "core_bundle_schema_invalid");
  }
  const storedCountries = value.countries.map(validateCountryProfile);
  if (storedCountries.some((country) => !country)
    || new Set(storedCountries.map(
      (country) => `${country.marketRegion}:${country.countryCode}:${country.profileId}`
    )).size !== storedCountries.length) {
    throw coreError("Core 国家配置不受支持", "core_country_profiles_invalid");
  }
  // Country endpoint data is compiled, non-secret source evidence. Expand old
  // three-country bundles in memory so existing user authorization survives a
  // catalog upgrade without copying or re-provisioning credential material.
  const countries = DEFAULT_CORE_COUNTRY_PROFILES.map((profile) => ({
    ...profile,
    baseParams: { ...profile.baseParams },
    gapIntervals: [...profile.gapIntervals]
  }));
  const authorization = value.mobileAuthorization;
  if (authorization !== null) {
    const marketRegion = normalizedMarketRegion(authorization?.marketRegion);
    const countryCodes = Array.isArray(authorization?.countryCodes)
      ? authorization.countryCodes.map(normalizedCountryCode)
      : [];
    if (!authorization
      || authorization.kind !== MOBILE_AUTH_KIND
      || authorization.provenance !== "user_owned_local_secure_terminal"
      || typeof authorization.value !== "string"
      || !TOKEN_PATTERN.test(authorization.value)
      || !marketRegion
      || countryCodes.length < 1
      || countryCodes.length > 3
      || countryCodes.some((countryCode) => !countryCode)
      || new Set(countryCodes).size !== countryCodes.length
      || countryCodes.some((countryCode) => !countries.some(
        (profile) => profile.countryCode === countryCode && profile.marketRegion === marketRegion
      ))
      || !Number.isFinite(Date.parse(authorization.installedAt))
      || (authorization.expiresAt !== null && !Number.isFinite(Date.parse(authorization.expiresAt)))) {
      throw coreError("Core 移动授权结构无效", "core_mobile_authorization_invalid");
    }
  }
  return {
    ...value,
    countries,
    mobileAuthorization: authorization === null ? null : {
      ...authorization,
      marketRegion: normalizedMarketRegion(authorization.marketRegion),
      countryCodes: authorization.countryCodes.map((countryCode) => countryCode.toUpperCase())
    }
  };
}

function deriveBundleKey(masterKey, salt) {
  return Buffer.from(crypto.hkdfSync("sha256", masterKey, salt, HKDF_INFO, CORE_MASTER_KEY_BYTES));
}

function encryptBundle(bundle, masterKey, randomBytes) {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = deriveBundleKey(masterKey, salt);
  const plaintext = Buffer.from(JSON.stringify(bundle), "utf8");
  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(MAGIC);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([MAGIC, salt, nonce, ciphertext, tag]);
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
}

function decryptBundle(encoded, masterKey) {
  const minimum = MAGIC.length + SALT_BYTES + NONCE_BYTES + TAG_BYTES + 2;
  if (!Buffer.isBuffer(encoded) || encoded.length < minimum || !encoded.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw coreError("Core 加密容器格式无效", "core_bundle_format_invalid");
  }
  const saltOffset = MAGIC.length;
  const nonceOffset = saltOffset + SALT_BYTES;
  const ciphertextOffset = nonceOffset + NONCE_BYTES;
  const tagOffset = encoded.length - TAG_BYTES;
  const salt = encoded.subarray(saltOffset, nonceOffset);
  const nonce = encoded.subarray(nonceOffset, ciphertextOffset);
  const ciphertext = encoded.subarray(ciphertextOffset, tagOffset);
  const tag = encoded.subarray(tagOffset);
  const key = deriveBundleKey(masterKey, salt);
  let plaintext = null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return validateBundle(JSON.parse(plaintext.toString("utf8")));
  } catch (error) {
    if (error?.code?.startsWith?.("core_")) throw error;
    throw coreError("Core 加密容器校验失败", "core_bundle_authentication_failed", error);
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}

async function atomicWrite(filePath, data) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, data, { mode: 0o600, flag: "wx" });
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    throw coreError(`无法安全写入 ${path.basename(filePath)}`, "core_write_failed", error);
  }
}

export class CoreConfigStore {
  constructor({
    dataDirectory,
    keyProvider = null,
    now = () => new Date(),
    randomBytes = crypto.randomBytes
  } = {}) {
    if (!dataDirectory) throw coreError("缺少 Core 数据目录", "core_data_directory_required");
    this.paths = runtimePaths(dataDirectory);
    this.keyProvider = keyProvider ?? createDefaultCoreKeyProvider({ dataDirectory });
    if (typeof this.keyProvider?.getKey !== "function"
      || typeof this.keyProvider?.getOrCreateKey !== "function") {
      throw coreError("Core 主密钥提供器无效", "core_key_provider_invalid");
    }
    this.now = now;
    this.randomBytes = randomBytes;
  }

  async prepareCoreDirectory() {
    await mkdir(this.paths.coreDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.paths.coreDirectory, 0o700);
  }

  async masterKey({ create = false } = {}) {
    const value = create
      ? await this.keyProvider.getOrCreateKey()
      : await this.keyProvider.getKey();
    if (value === null || value === undefined) {
      throw coreError("macOS 钥匙串中缺少 Core 主密钥", "core_keychain_key_missing");
    }
    const key = Buffer.isBuffer(value)
      ? value
      : value instanceof Uint8Array
        ? Buffer.from(value)
        : null;
    if (!key || key.length !== CORE_MASTER_KEY_BYTES) {
      key?.fill(0);
      throw coreError("Core 主密钥长度无效", "core_keychain_key_invalid");
    }
    return key;
  }

  async initialize() {
    await this.prepareCoreDirectory();
    let key = null;
    try {
      await readFile(this.paths.coreBundlePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      key = await this.masterKey({ create: true });
      const at = nowIso(this.now);
      await atomicWrite(
        this.paths.coreBundlePath,
        encryptBundle(defaultBundle(at), key, this.randomBytes)
      );
    } finally {
      key?.fill(0);
    }
    return this.status();
  }

  async readBundle({ createIfMissing = false } = {}) {
    await this.prepareCoreDirectory();
    let encoded;
    try {
      encoded = await readFile(this.paths.coreBundlePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (!createIfMissing) {
        throw coreError("Core 加密配置尚未初始化", "core_bundle_missing", error);
      }
      await this.initialize();
      encoded = await readFile(this.paths.coreBundlePath);
    }
    const key = await this.masterKey();
    try {
      return decryptBundle(encoded, key);
    } finally {
      key.fill(0);
      encoded.fill(0);
    }
  }

  async writeBundle(bundle) {
    await this.prepareCoreDirectory();
    const key = await this.masterKey();
    try {
      await atomicWrite(
        this.paths.coreBundlePath,
        encryptBundle(validateBundle(bundle), key, this.randomBytes)
      );
    } finally {
      key.fill(0);
    }
  }

  async status() {
    try {
      await this.prepareCoreDirectory();
      try {
        await readFile(this.paths.coreBundlePath);
      } catch (error) {
        if (error?.code === "ENOENT") return uninitializedStatus();
        throw error;
      }
      const bundle = await this.readBundle();
      const authorization = bundle.mobileAuthorization;
      const expired = authorization?.expiresAt
        ? Date.parse(authorization.expiresAt) <= Date.parse(nowIso(this.now))
        : false;
      const marketRegions = [...new Set(bundle.countries.map((profile) => profile.marketRegion))].sort();
      const countryCodes = [...new Set(bundle.countries.map((profile) => profile.countryCode))].sort();
      const publicStatus = Object.freeze({
        state: "ready",
        schemaVersion: bundle.schemaVersion,
        coreVersion: bundle.coreVersion,
        encryption: CORE_BUNDLE_ENCRYPTION,
        countries: Object.freeze({
          count: bundle.countries.length,
          uniqueCountryCount: countryCodes.length,
          countryCodes: Object.freeze(countryCodes),
          marketRegions: Object.freeze(marketRegions)
        }),
        mobileAuthorization: Object.freeze({
          state: authorization ? (expired ? "expired" : "ready") : "missing",
          configured: Boolean(authorization),
          usable: Boolean(authorization) && !expired,
          kind: authorization ? MOBILE_AUTH_KIND : null,
          marketRegion: authorization?.marketRegion ?? null,
          countryCodes: Object.freeze([...(authorization?.countryCodes ?? [])].sort()),
          installedAt: authorization?.installedAt ?? null,
          expiresAt: authorization?.expiresAt ?? null,
          provenance: authorization ? "user_owned_local_secure_terminal" : null
        }),
        secretValuesExposed: false,
        supplierCredentialsCopied: false
      });
      if (authorization) authorization.value = "";
      return publicStatus;
    } catch (error) {
      return Object.freeze({
        state: "invalid",
        schemaVersion: CORE_BUNDLE_SCHEMA_VERSION,
        encryption: CORE_BUNDLE_ENCRYPTION,
        errorCode: String(error?.code ?? "core_bundle_invalid"),
        countries: Object.freeze({ count: 0, countryCodes: Object.freeze([]), marketRegions: Object.freeze([]) }),
        mobileAuthorization: Object.freeze({
          state: "invalid",
          configured: false,
          usable: false,
          kind: null,
          marketRegion: null,
          countryCodes: Object.freeze([]),
          installedAt: null,
          expiresAt: null,
          provenance: null
        }),
        secretValuesExposed: false,
        supplierCredentialsCopied: false
      });
    }
  }

  async resolveMobileAuthorization({ marketRegion, countryCode, endpointProfileId } = {}) {
    let bundle;
    try {
      bundle = await this.readBundle();
    } catch (error) {
      if (error?.code === "core_bundle_missing") {
        return Object.freeze({ status: "missing" });
      }
      return Object.freeze({ status: "invalid" });
    }
    const authorization = bundle.mobileAuthorization;
    if (!authorization) return Object.freeze({ status: "missing" });
    if (authorization.expiresAt && Date.parse(authorization.expiresAt) <= Date.parse(nowIso(this.now))) {
      return Object.freeze({ status: "expired" });
    }
    const normalizedMarket = normalizedMarketRegion(marketRegion);
    const normalizedCountry = normalizedCountryCode(countryCode);
    if (!normalizedMarket || normalizedMarket !== authorization.marketRegion) {
      return Object.freeze({ status: "market_mismatch" });
    }
    if (!normalizedCountry || !authorization.countryCodes.includes(normalizedCountry)) {
      return Object.freeze({ status: "unsupported_country" });
    }
    const profile = bundle.countries.find((candidate) => (
      candidate.countryCode === normalizedCountry
      && candidate.marketRegion === normalizedMarket
      && (!endpointProfileId || candidate.profileId === endpointProfileId)
    ));
    if (!profile) return Object.freeze({ status: "unsupported_country" });
    const value = Buffer.from(authorization.value, "utf8");
    authorization.value = "";
    return Object.freeze({
      status: "ready",
      kind: MOBILE_AUTH_KIND,
      value
    });
  }

  async installMobileAuthorization({
    value,
    marketRegion,
    countryCodes,
    expiresAt = null,
    provenance
  } = {}) {
    if (provenance !== "user_owned_local_secure_terminal") {
      throw coreError("仅允许从本机安全终端导入用户自有授权", "mobile_authorization_provenance_required");
    }
    const tokenBuffer = Buffer.isBuffer(value)
      ? Buffer.from(value)
      : value instanceof Uint8Array
        ? Buffer.from(value)
        : typeof value === "string"
          ? Buffer.from(value.trim(), "utf8")
          : Buffer.alloc(0);
    let token = tokenBuffer.toString("utf8");
    if (!TOKEN_PATTERN.test(token)) {
      tokenBuffer.fill(0);
      token = "";
      throw coreError("移动授权格式无效", "mobile_authorization_value_invalid");
    }
    let next = null;
    try {
      const normalizedMarket = normalizedMarketRegion(marketRegion);
      const normalizedCountries = Array.isArray(countryCodes)
        ? countryCodes.map(normalizedCountryCode)
        : [];
      if (!normalizedMarket
        || normalizedCountries.length < 1
        || normalizedCountries.length > 3
        || normalizedCountries.some((countryCode) => !countryCode)
        || new Set(normalizedCountries).size !== normalizedCountries.length) {
        throw coreError("移动授权国家范围无效", "mobile_authorization_scope_invalid");
      }
      if (normalizedCountries.some((countryCode) => !DEFAULT_CORE_COUNTRY_PROFILES.some(
        (profile) => profile.marketRegion === normalizedMarket && profile.countryCode === countryCode
      ))) {
        throw coreError("移动授权范围不属于已编译国家配置", "mobile_authorization_scope_unsupported");
      }
      const installedAt = nowIso(this.now);
      const normalizedExpiresAt = validatedExpiry(expiresAt, Date.parse(installedAt));
      const bundle = await this.readBundle({ createIfMissing: true });
      if (normalizedCountries.some((countryCode) => !bundle.countries.some(
        (profile) => profile.marketRegion === normalizedMarket && profile.countryCode === countryCode
      ))) {
        throw coreError("移动授权范围不属于已编译国家配置", "mobile_authorization_scope_unsupported");
      }
      next = {
        ...bundle,
        updatedAt: installedAt,
        mobileAuthorization: {
          kind: MOBILE_AUTH_KIND,
          value: token,
          marketRegion: normalizedMarket,
          countryCodes: normalizedCountries,
          installedAt,
          expiresAt: normalizedExpiresAt,
          provenance
        }
      };
      await this.writeBundle(next);
    } finally {
      tokenBuffer.fill(0);
      token = "";
      if (next?.mobileAuthorization) next.mobileAuthorization.value = "";
    }
    return this.status();
  }

  async clearMobileAuthorization() {
    try {
      await readFile(this.paths.coreBundlePath);
    } catch (error) {
      if (error?.code === "ENOENT") return uninitializedStatus();
      throw error;
    }
    const bundle = await this.readBundle();
    try {
      if (bundle.mobileAuthorization === null) return this.status();
      await this.writeBundle({
        ...bundle,
        updatedAt: nowIso(this.now),
        mobileAuthorization: null
      });
      return this.status();
    } finally {
      if (bundle.mobileAuthorization) bundle.mobileAuthorization.value = "";
    }
  }
}

export function publicAuthorizationState(value) {
  return safeAuthorizationState(value);
}
