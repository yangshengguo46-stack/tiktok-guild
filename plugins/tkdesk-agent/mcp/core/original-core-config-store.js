import crypto from "node:crypto";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  originalExecutableProfileForCountry,
  ORIGINAL_FIXED_TEMPLATE_BASE_PARAMS,
} from "./original-country-config.js";

const SOURCE = "user_authorized_original_bundle";
const ALLOWED_HOSTS = new Set([
  "webcast16-normal-useast8.tiktokv.us",
  "webcast16-normal-useast5.tiktokv.us",
  "webcast16-normal-no1a.tiktokv.eu",
  "webcast16-normal-c-alisg.tiktokv.com",
]);
const ORIGINAL_EXECUTABLE_SHA256 =
  "a04edd512cdf8be3868d5edbd7a20006c61906c49bb608d8312e8299fa076620";

function discardSecrets(config) {
  for (const entry of config?.mobileHeader ?? []) {
    for (const key of Object.keys(entry.httpHeader ?? {}))
      entry.httpHeader[key] = "";
  }
}

function invalid() {
  return new Error("Original published configuration is invalid");
}
async function readFormatKey(metadata) {
  const executable = await readFile(metadata.originalExecutablePath);
  if (
    crypto.createHash("sha256").update(executable).digest("hex") !==
    ORIGINAL_EXECUTABLE_SHA256
  )
    throw invalid();
  const pe = executable.readUInt32LE(0x3c);
  if (
    executable.readUInt32LE(pe) !== 0x4550 ||
    executable.readUInt16LE(pe + 24) !== 0x20b
  )
    throw invalid();
  const relative = 0x1412440e1 - Number(executable.readBigUInt64LE(pe + 48));
  const count = executable.readUInt16LE(pe + 6);
  const offset = pe + 24 + executable.readUInt16LE(pe + 20);
  for (let index = 0; index < count; index++) {
    const section = offset + index * 40;
    const rva = executable.readUInt32LE(section + 12);
    const size = executable.readUInt32LE(section + 16);
    if (relative >= rva && relative + 11 <= rva + size) {
      const start = executable.readUInt32LE(section + 20) + relative - rva;
      if (start + 11 > executable.length) throw invalid();
      return Buffer.from(executable.subarray(start, start + 11));
    }
  }
  throw invalid();
}

function decode(buffer, passphrase) {
  if (
    !Buffer.isBuffer(passphrase) ||
    !passphrase.length ||
    buffer.length < 36 ||
    buffer.length > 1024 * 1024
  )
    throw invalid();
  const key = crypto.createHash("sha256").update(passphrase).digest();
  const mask = crypto
    .createHash("sha256")
    .update(passphrase)
    .update(buffer.subarray(0, 8))
    .digest();
  let plaintext;
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      buffer.subarray(8, 20),
    );
    decipher.setAuthTag(buffer.subarray(-16));
    plaintext = Buffer.concat([
      decipher.update(buffer.subarray(20, -16)),
      decipher.final(),
    ]);
    for (let index = 0; index < plaintext.length; index++)
      plaintext[index] ^= mask[index % 32];
    return JSON.parse(plaintext.toString("utf8"));
  } finally {
    plaintext?.fill(0);
    key.fill(0);
    mask.fill(0);
    passphrase.fill(0);
  }
}

function checkedUrl(value, contract) {
  const url = new URL(value);
  const expected = {
    ...ORIGINAL_FIXED_TEMPLATE_BASE_PARAMS,
    anchor_id: url.searchParams.get("anchor_id"),
    room_id: url.searchParams.get("room_id"),
    rank_type: String(contract.rankTypeCode),
    region_type: "1",
    gap_interval: String(contract.gapInterval),
  };
  if (
    url.protocol !== "https:" ||
    !ALLOWED_HOSTS.has(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== "/webcast/ranklist/list/v2/" ||
    !/^\d{5,32}$/.test(expected.anchor_id ?? "") ||
    !/^\d{5,32}$/.test(expected.room_id ?? "") ||
    url.searchParams.size !== Object.keys(expected).length
  )
    throw invalid();
  for (const [key, value] of Object.entries(expected)) {
    if (
      url.searchParams.getAll(key).length !== 1 ||
      url.searchParams.get(key) !== value
    )
      throw invalid();
  }
  return url;
}

function parseConfiguration(config) {
  if (
    !Array.isArray(config?.countries) ||
    !config.countries.length ||
    config.countries.length > 100 ||
    !Array.isArray(config.mobileHeader) ||
    !config.mobileHeader.length
  )
    throw invalid();
  const headers = config.mobileHeader.map((entry) => {
    if (
      !ALLOWED_HOSTS.has(entry?.host) ||
      !entry.httpHeader ||
      typeof entry.httpHeader !== "object"
    )
      throw invalid();
    const values = Object.fromEntries(
      Object.entries(entry.httpHeader).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const token = values["x-tt-token"],
      userAgent = values["user-agent"];
    if (
      typeof token !== "string" ||
      !/^[\x21-\x7e]{16,4096}$/.test(token) ||
      typeof userAgent !== "string" ||
      !/^[\x20-\x7e]{16,1024}$/.test(userAgent) ||
      values["sdk-version"] !== "2"
    )
      throw invalid();
    return { host: entry.host, token: Buffer.from(token), userAgent };
  });
  try {
    const records = config.countries.map((record) => {
      const market =
        typeof record.countryCode === "string"
          ? record.countryCode.toUpperCase()
          : "";
      const memberValues = Array.isArray(record.IncludeCode)
        ? record.IncludeCode
        : [record.IncludeCode];
      if (memberValues.some((value) => typeof value !== "string"))
        throw invalid();
      const members = [
        ...new Set(
          memberValues
            .flatMap((value) => value.split(","))
            .map((value) => value.trim().toUpperCase()),
        ),
      ];
      if (members.some((value) => !/^[A-Z]{2}$/.test(value))) throw invalid();
      const profiles = members
        .map((countryCode) => {
          const compiled = originalExecutableProfileForCountry({
            marketRegion: market,
            countryCode,
            displayName: record.displayName,
          });
          if (!compiled) return null;
          if (compiled.topCode !== Number(record.topCode)) throw invalid();
          const contracts = compiled.fixedTemplateContracts;
          const templates = [
            ["topUrl", contracts.topList],
            ["historyRankURL", contracts.historyList],
            ["hotListURL", contracts.hotList],
            ["rankRecordURL", contracts.rankRecord],
          ];
          let first;
          for (const [key, contract] of templates) {
            if (contract.state === "skipped") {
              if (record[key]) throw invalid();
              continue;
            }
            const url = checkedUrl(record[key], contract);
            if (
              first &&
              (url.origin !== first.origin ||
                url.searchParams.get("anchor_id") !==
                  first.searchParams.get("anchor_id") ||
                url.searchParams.get("room_id") !==
                  first.searchParams.get("room_id"))
            )
              throw invalid();
            first ??= url;
          }
          // Preserve the publisher's header ordering for duplicate hosts, as in the original configuration.
          const header = headers.find((value) => value.host === first.hostname);
          if (!header) throw invalid();
          return Object.freeze({
            ...compiled,
            profileId: compiled.id,
            canonicalUrl: first.origin + first.pathname,
            mobileUserAgent: header.userAgent,
            baseParams: ORIGINAL_FIXED_TEMPLATE_BASE_PARAMS,
            regionTypeCode: 1,
            safeFixedTemplateScope: Object.freeze({
              anchorId: first.searchParams.get("anchor_id"),
              roomId: first.searchParams.get("room_id"),
            }),
          });
        })
        .filter(Boolean);
      if (!profiles.length) throw invalid();
      return { market, displayName: record.displayName, profiles };
    });
    return { headers, records };
  } catch (error) {
    for (const header of headers) header.token.fill(0);
    throw error;
  } finally {
    discardSecrets(config);
  }
}

/** Maintenance only: no vendor login, no caller URL/headers, no automatic retry. Restart the idle daemon after refresh. */
export async function refreshOriginalCoreConfiguration({
  dataDirectory,
  passphraseReader = readFormatKey,
  fetchImpl = fetch,
} = {}) {
  const metadataPath = path.join(
    dataDirectory,
    "providers",
    "tksoft-original.json",
  );
  const corePath = path.join(
    dataDirectory,
    "providers",
    "tksoft-original.Core.dll",
  );
  const temporary = `${corePath}.${process.pid}.tmp`;
  let configuration;
  let bytes;
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    if (metadata.enabled !== true || metadata.authorizationSource !== SOURCE)
      throw invalid();
    const response = await fetchImpl("https://www.tiktokzb.com/Core/Core.dll", {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(25000),
    });
    if (response.status !== 200 || !response.body) throw invalid();
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > 1024 * 1024) throw invalid();
      chunks.push(Buffer.from(chunk));
    }
    bytes = Buffer.concat(chunks);
    configuration = parseConfiguration(
      decode(bytes, await passphraseReader(metadata)),
    );
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, corePath);
    const cachedAt = new Date().toISOString();
    await writeFile(
      `${metadataPath}.${process.pid}.tmp`,
      JSON.stringify({ ...metadata, cachedAt }),
      { mode: 0o600 },
    );
    await rename(`${metadataPath}.${process.pid}.tmp`, metadataPath);
    return {
      state: "ready",
      source: SOURCE,
      cachedAt,
      sourceRecordCount: configuration.records.length,
      coreSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      secretValuesExposed: false,
      restartRequired: true,
    };
  } catch {
    throw new Error(
      "Original configuration refresh failed; no automatic retry was performed",
    );
  } finally {
    bytes?.fill(0);
    for (const header of configuration?.headers ?? []) header.token.fill(0);
    await unlink(temporary).catch(() => {});
    await unlink(`${metadataPath}.${process.pid}.tmp`).catch(() => {});
  }
}

/** Explicit operator opt-in to the original publisher's encrypted read-only ranking configuration. */
export async function createOriginalCoreConfigStore({
  dataDirectory,
  passphraseReader = readFormatKey,
} = {}) {
  const metadataPath = path.join(
    dataDirectory,
    "providers",
    "tksoft-original.json",
  );
  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    metadata = { enabled: true };
  }
  if (metadata.enabled !== true) return null;
  let loaded = null,
    failed = false,
    cleared = false;
  try {
    if (metadata.authorizationSource !== SOURCE) throw invalid();
    loaded = parseConfiguration(
      decode(
        await readFile(
          path.join(dataDirectory, "providers", "tksoft-original.Core.dll"),
        ),
        await passphraseReader(metadata),
      ),
    );
  } catch {
    failed = true;
  }
  function profileFor(scope = {}) {
    if (!loaded || cleared) return null;
    const market = String(
      scope.marketRegion ?? metadata.defaultMarketRegion ?? "",
    ).toUpperCase();
    const country = String(scope.countryCode ?? "").toUpperCase();
    const record = loaded.records.find(
      (r) =>
        r.market === market &&
        (!scope.displayName || r.displayName === scope.displayName) &&
        r.profiles.some((p) => p.countryCode === country),
    );
    const profile = record?.profiles.find((p) => p.countryCode === country);
    return profile &&
      (!scope.endpointProfileId || scope.endpointProfileId === profile.id)
      ? profile
      : null;
  }
  return Object.freeze({
    profileFor,
    async status(scope = {}) {
      const market = String(
        scope.marketRegion ?? metadata.defaultMarketRegion ?? "",
      ).toUpperCase();
      const profiles =
        loaded?.records
          .filter((r) => r.market === market)
          .flatMap((r) => r.profiles) ?? [];
      const countryCodes = [
        ...new Set(profiles.map((p) => p.countryCode)),
      ].sort();
      const state = cleared
        ? "missing"
        : failed
          ? "invalid"
          : profiles.length && (!scope.countryCode || profileFor(scope))
            ? "ready"
            : "unsupported_country";
      return {
        state: failed ? "invalid" : "ready",
        schemaVersion: "tksoft.published-core.v1",
        coreVersion: null,
        encryption: "original_aes256_gcm_xor",
        errorCode: failed ? "original_core_invalid" : null,
        countries: {
          count: loaded?.records.length ?? 0,
          countryCodes: [
            ...new Set(
              loaded?.records.flatMap((r) =>
                r.profiles.map((p) => p.countryCode),
              ) ?? [],
            ),
          ].sort(),
          marketRegions: [
            ...new Set(loaded?.records.map((r) => r.market) ?? []),
          ].sort(),
        },
        mobileAuthorization: {
          state,
          configured: !cleared && !failed,
          usable: state === "ready",
          marketRegion: market,
          countryCodes,
          installedAt: metadata.cachedAt ?? null,
          expiresAt: null,
          provenance: SOURCE,
        },
        secretValuesExposed: false,
        supplierCredentialsCopied: !cleared,
      };
    },
    async resolveMobileAuthorization(scope) {
      if (cleared) return { status: "missing" };
      if (failed) throw invalid();
      const profile = profileFor(scope);
      if (!profile) return { status: "unsupported_country" };
      const header = loaded.headers.find(
        (h) => h.host === new URL(profile.canonicalUrl).hostname,
      );
      return {
        status: "ready",
        kind: "x-tt-token",
        value: Buffer.from(header.token),
      };
    },
    async clearMobileAuthorization() {
      const temporary = `${metadataPath}.${process.pid}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify({ ...metadata, enabled: false }),
        { mode: 0o600 },
      );
      await rename(temporary, metadataPath);
      for (const header of loaded?.headers ?? []) header.token.fill(0);
      loaded = null;
      cleared = true;
    },
  });
}
