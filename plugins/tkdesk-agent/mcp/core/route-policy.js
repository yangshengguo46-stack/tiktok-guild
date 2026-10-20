import crypto from "node:crypto";
import { originalCountryConfigurationForRoute } from "./original-country-config.js";

export const ROUTE_POLICY_SCHEMA_VERSION = "tkdesk.route-policy.v4";

const SESSION_ROUTE_FINGERPRINT_SCHEMA_VERSION = "tkdesk.session-route.v1";
const COLLECTION_SESSION_ROUTE_FINGERPRINT_SCHEMA_VERSION =
  "tkdesk.collection-session-route.v3";
export const COLLECTION_PROXY_LANE_COUNT = 3;
export const COLLECTION_PROXY_LANE_MODE_COUNTRY = "country_lanes";
// Compatibility export retained while callers migrate from the old name. It
// now means a validated set of one-to-three country lanes, not three same-
// country proxies.
export const COLLECTION_PROXY_LANE_MODE_EXACT = COLLECTION_PROXY_LANE_MODE_COUNTRY;
export const COLLECTION_PROXY_LANE_MODE_DEGRADED = "degraded_single_lane";
export const COLLECTION_PROXY_LANE_MODE_LEGACY_AMBIGUOUS = "legacy_ambiguous_v5";

const MARKET_REGION_PATTERN = /^[A-Z][A-Z0-9_-]{1,31}$/;
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
const ALLOWED_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:"]);

export class RoutePolicyError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "RoutePolicyError";
    this.code = code;
    this.details = details;
  }
}

function policyError(code, message, details = null) {
  throw new RoutePolicyError(code, message, details);
}

export function normalizeMarketRegion(value) {
  const marketRegion = String(value ?? "").trim().toUpperCase();
  if (!marketRegion) policyError("MARKET_REGION_REQUIRED", "marketRegion is required");
  if (!MARKET_REGION_PATTERN.test(marketRegion)) {
    policyError(
      "MARKET_REGION_INVALID",
      "marketRegion must contain 2-32 uppercase letters, digits, underscores, or hyphens",
      { marketRegion }
    );
  }
  return marketRegion;
}

export function normalizeCountryCode(value, fieldName = "countryCode") {
  const countryCode = String(value ?? "").trim().toUpperCase();
  if (!countryCode) {
    policyError("COUNTRY_CODE_REQUIRED", `${fieldName} is required`, { field: fieldName });
  }
  if (!COUNTRY_CODE_PATTERN.test(countryCode)) {
    policyError(
      "COUNTRY_CODE_INVALID",
      `${fieldName} must be a two-letter ISO country code`,
      { field: fieldName, countryCode }
    );
  }
  return countryCode;
}

export function normalizeMarketCountryCodes(value) {
  const rawCodes = value instanceof Set ? [...value] : value;
  if (!Array.isArray(rawCodes) || rawCodes.length === 0) {
    policyError(
      "MARKET_COUNTRY_CODES_REQUIRED",
      "marketCountryCodes must be an explicit non-empty list"
    );
  }
  const countryCodes = [...new Set(
    rawCodes.map((countryCode) => normalizeCountryCode(countryCode, "marketCountryCodes[]"))
  )].sort();
  return Object.freeze(countryCodes);
}

function explicitPort(rawProxyServer, parsed) {
  const authority = rawProxyServer
    .slice(rawProxyServer.indexOf("//") + 2)
    .split(/[/?#]/, 1)[0]
    .split("@").at(-1);
  const match = authority.startsWith("[")
    ? authority.match(/^\[[^\]]+\]:(\d+)$/)
    : authority.match(/:(\d+)$/);
  if (!match) return null;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return parsed.port ? Number(parsed.port) : port;
}

function isLoopbackHostname(value) {
  const hostname = String(value ?? "").toLowerCase();
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true;
  const octets = hostname.split(".");
  return octets.length === 4
    && octets.every((octet) => /^\d+$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255)
    && Number(octets[0]) === 127;
}

export function normalizeProxyServer(value, fieldName = "proxyServer") {
  const rawProxyServer = String(value ?? "").trim();
  if (!rawProxyServer) {
    policyError("PROXY_SERVER_REQUIRED", `${fieldName} is required`, { field: fieldName });
  }

  let parsed;
  try {
    parsed = new URL(rawProxyServer);
  } catch {
    policyError(
      "PROXY_SERVER_INVALID",
      `${fieldName} must be an absolute proxy URL`,
      { field: fieldName }
    );
  }
  if (!ALLOWED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    policyError(
      "PROXY_PROTOCOL_UNSUPPORTED",
      `${fieldName} must use http, https, or socks5`,
      { field: fieldName, protocol: parsed.protocol }
    );
  }
  if (parsed.username || parsed.password) {
    policyError(
      "PROXY_CREDENTIALS_NOT_ALLOWED",
      `${fieldName} must not contain a username or password`,
      { field: fieldName }
    );
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    policyError(
      "PROXY_NOT_LOOPBACK",
      `${fieldName} must point to a loopback address`,
      { field: fieldName, hostname: parsed.hostname }
    );
  }
  if (!["", "/"].includes(parsed.pathname) || parsed.search || parsed.hash) {
    policyError(
      "PROXY_URL_COMPONENTS_NOT_ALLOWED",
      `${fieldName} must not contain a path, query, or fragment`,
      { field: fieldName }
    );
  }
  const port = explicitPort(rawProxyServer, parsed);
  if (port === null) {
    policyError(
      "PROXY_PORT_REQUIRED",
      `${fieldName} must contain an explicit valid port`,
      { field: fieldName }
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  return `${parsed.protocol}//${hostname}:${port}`;
}

function normalizedBoundedLaneArray(value, fieldName) {
  if (!Array.isArray(value)) {
    policyError(`${fieldName.toUpperCase()}_INVALID`, `${fieldName} must be an array`);
  }
  if (value.length < 1 || value.length > COLLECTION_PROXY_LANE_COUNT) {
    policyError(
      "COLLECTION_PROXY_LANE_COUNT_INVALID",
      `${fieldName} must contain between 1 and ${COLLECTION_PROXY_LANE_COUNT} items`,
      { laneCount: value.length }
    );
  }
  return value;
}

export function normalizeCollectionProxyServers(value) {
  const raw = normalizedBoundedLaneArray(value, "collectionProxyServers");
  const proxyServers = raw.map((proxyServer, index) => (
    normalizeProxyServer(proxyServer, `collectionProxyServers[${index}]`)
  ));
  if (new Set(proxyServers).size !== proxyServers.length) {
    policyError(
      "COLLECTION_PROXY_LANES_NOT_DISTINCT",
      "each collection country must use one distinct loopback proxy endpoint"
    );
  }
  return Object.freeze(proxyServers);
}

export function normalizeCollectionProxyExitCountries(value, expectedCount = null) {
  const raw = normalizedBoundedLaneArray(value, "collectionProxyExitCountries");
  if (expectedCount !== null && raw.length !== expectedCount) {
    policyError(
      "COLLECTION_PROXY_EXIT_COUNTRY_COUNT_INVALID",
      `collectionProxyExitCountries must contain exactly ${expectedCount} country codes`,
      { laneCount: raw.length, expectedCount }
    );
  }
  return Object.freeze(raw.map((countryCode, index) => (
    normalizeCountryCode(countryCode, `collectionProxyExitCountries[${index}]`)
  )));
}

function normalizeCollectionCountryCodes(value, expectedCount) {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    policyError(
      "COLLECTION_COUNTRY_COUNT_INVALID",
      `collectionCountryCodes must contain exactly ${expectedCount} country codes`,
      { laneCount: Array.isArray(value) ? value.length : null, expectedCount }
    );
  }
  const countries = value.map((countryCode, index) => (
    normalizeCountryCode(countryCode, `collectionCountryCodes[${index}]`)
  ));
  if (new Set(countries).size !== countries.length) {
    policyError(
      "COLLECTION_COUNTRIES_NOT_DISTINCT",
      "each collection country may appear only once"
    );
  }
  return Object.freeze(countries);
}

export function normalizeCollectionLanes(value) {
  const raw = normalizedBoundedLaneArray(value, "collectionLanes");
  const lanes = raw.map((lane, index) => {
    if (!lane || typeof lane !== "object" || Array.isArray(lane)) {
      policyError(
        "COLLECTION_LANE_INVALID",
        `collectionLanes[${index}] must be an object`,
        { laneIndex: index }
      );
    }
    return Object.freeze({
      workId: index + 1,
      countryCode: normalizeCountryCode(lane.countryCode, `collectionLanes[${index}].countryCode`),
      proxyServer: normalizeProxyServer(lane.proxyServer, `collectionLanes[${index}].proxyServer`)
    });
  });
  if (new Set(lanes.map((lane) => lane.countryCode)).size !== lanes.length) {
    policyError("COLLECTION_COUNTRIES_NOT_DISTINCT", "each collection country may appear only once");
  }
  if (new Set(lanes.map((lane) => lane.proxyServer)).size !== lanes.length) {
    policyError(
      "COLLECTION_PROXY_LANES_NOT_DISTINCT",
      "each collection country must use one distinct loopback proxy endpoint"
    );
  }
  return Object.freeze(lanes);
}

function optionalNormalizedProxyAlias(input) {
  const values = [
    input.collectionProxyServer === undefined || input.collectionProxyServer === null
      ? null
      : normalizeProxyServer(input.collectionProxyServer, "collectionProxyServer"),
    input.proxyServer === undefined || input.proxyServer === null
      ? null
      : normalizeProxyServer(input.proxyServer, "proxyServer")
  ].filter(Boolean);
  if (new Set(values).size > 1) {
    policyError(
      "COLLECTION_PROXY_ALIAS_MISMATCH",
      "proxyServer must match collectionProxyServer when both are supplied"
    );
  }
  return values[0] ?? null;
}

function normalizeCollectionLaneConfiguration(input) {
  let lanes;
  if (input.collectionLanes !== undefined && input.collectionLanes !== null) {
    lanes = normalizeCollectionLanes(input.collectionLanes);
  } else if (input.collectionProxyServers !== undefined && input.collectionProxyServers !== null) {
    const proxyServers = normalizeCollectionProxyServers(input.collectionProxyServers);
    let countryCodes;
    if (input.collectionCountryCodes !== undefined && input.collectionCountryCodes !== null) {
      countryCodes = normalizeCollectionCountryCodes(
        input.collectionCountryCodes,
        proxyServers.length
      );
    } else if (proxyServers.length === 1) {
      countryCodes = Object.freeze([
        normalizeCountryCode(input.routeCountry ?? input.backstageCountry, "routeCountry")
      ]);
    } else {
      policyError(
        "COLLECTION_LANE_COUNTRIES_REQUIRED",
        "legacy multi-proxy input is ambiguous; supply collectionLanes with one country per proxy",
        { laneCount: proxyServers.length }
      );
    }
    lanes = Object.freeze(proxyServers.map((proxyServer, index) => Object.freeze({
      workId: index + 1,
      countryCode: countryCodes[index],
      proxyServer
    })));
  } else {
    const proxyServer = optionalNormalizedProxyAlias(input);
    if (!proxyServer) {
      policyError("PROXY_SERVER_REQUIRED", "collectionLanes is required");
    }
    lanes = Object.freeze([Object.freeze({
      workId: 1,
      countryCode: normalizeCountryCode(
        input.routeCountry ?? input.backstageCountry,
        "routeCountry"
      ),
      proxyServer
    })]);
  }

  const firstLane = lanes[0];
  const explicitProxyAlias = optionalNormalizedProxyAlias(input);
  if (explicitProxyAlias && explicitProxyAlias !== firstLane.proxyServer) {
    policyError(
      "COLLECTION_PROXY_ALIAS_MISMATCH",
      "collectionProxyServer and proxyServer are compatibility aliases for collectionLanes[0]"
    );
  }
  for (const fieldName of ["routeCountry", "backstageCountry"]) {
    if (input[fieldName] === undefined || input[fieldName] === null) continue;
    const alias = normalizeCountryCode(input[fieldName], fieldName);
    if (alias !== firstLane.countryCode) {
      policyError(
        fieldName === "routeCountry" ? "ROUTE_COUNTRY_ALIAS_MISMATCH" : "BACKSTAGE_COUNTRY_ALIAS_MISMATCH",
        `${fieldName} is a compatibility alias for collectionLanes[0].countryCode`,
        { alias, firstLaneCountry: firstLane.countryCode }
      );
    }
  }
  return lanes;
}

function normalizeRouteBase(input, { requireProxyExitCountry }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    policyError("ROUTE_POLICY_INVALID", "route policy must be an object");
  }
  const marketRegion = normalizeMarketRegion(input.marketRegion);
  const marketCountryCodes = normalizeMarketCountryCodes(input.marketCountryCodes);
  const originalConfiguration = originalCountryConfigurationForRoute(marketRegion);
  if (!originalConfiguration) {
    policyError(
      "MARKET_REGION_NOT_IN_ORIGINAL_CATALOG",
      "marketRegion must match an original country configuration route code",
      { marketRegion }
    );
  }
  const catalogMismatches = marketCountryCodes.filter(
    (countryCode) => !originalConfiguration.memberCountryCodes.includes(countryCode)
  );
  if (catalogMismatches.length > 0) {
    policyError(
      "MARKET_COUNTRY_NOT_IN_ORIGINAL_CATALOG",
      "every marketCountryCodes item must belong to the original IncludeCode configuration",
      { marketRegion, countriesOutsideOriginalCatalog: catalogMismatches }
    );
  }
  const discoveryCountry = normalizeCountryCode(input.discoveryCountry, "discoveryCountry");
  const discoveryProxyServer = normalizeProxyServer(
    input.discoveryProxyServer,
    "discoveryProxyServer"
  );
  const collectionLanes = normalizeCollectionLaneConfiguration(input);
  const collectionCountryCodes = Object.freeze(collectionLanes.map((lane) => lane.countryCode));
  const collectionProxyServers = Object.freeze(collectionLanes.map((lane) => lane.proxyServer));
  const firstLane = collectionLanes[0];

  const countriesOutsideMarket = collectionCountryCodes.filter(
    (countryCode) => !marketCountryCodes.includes(countryCode)
  );
  if (countriesOutsideMarket.length > 0) {
    policyError(
      "COLLECTION_COUNTRY_NOT_IN_MARKET",
      "every collection lane country must be included in marketCountryCodes",
      { marketRegion, countriesOutsideMarket, marketCountryCodes }
    );
  }

  const result = {
    schemaVersion: ROUTE_POLICY_SCHEMA_VERSION,
    marketRegion,
    marketCountryCodes,
    discoveryCountry,
    discoveryProxyServer,
    collectionLanes,
    collectionCountryCodes,
    collectionProxyServers,
    collectionProxyLaneMode: COLLECTION_PROXY_LANE_MODE_COUNTRY,
    collectionProxyLaneCount: collectionLanes.length,
    // Compatibility aliases. They intentionally describe lane 1 only and are
    // never used as an aggregate multi-country invariant.
    routeCountry: firstLane.countryCode,
    backstageCountry: firstLane.countryCode,
    collectionProxyServer: firstLane.proxyServer,
    proxyServer: firstLane.proxyServer
  };

  if (requireProxyExitCountry) {
    const discoveryProxyExitCountry = normalizeCountryCode(
      input.discoveryProxyExitCountry,
      "discoveryProxyExitCountry"
    );
    if (discoveryProxyExitCountry !== discoveryCountry) {
      policyError(
        "DISCOVERY_PROXY_EXIT_COUNTRY_MISMATCH",
        "discoveryProxyExitCountry must match discoveryCountry",
        { discoveryCountry, discoveryProxyExitCountry }
      );
    }
    let collectionProxyExitCountries;
    if (input.collectionProxyExitCountries !== undefined
      && input.collectionProxyExitCountries !== null) {
      collectionProxyExitCountries = normalizeCollectionProxyExitCountries(
        input.collectionProxyExitCountries,
        collectionLanes.length
      );
    } else if (collectionLanes.length === 1) {
      collectionProxyExitCountries = Object.freeze([
        normalizeCountryCode(input.proxyExitCountry, "proxyExitCountry")
      ]);
    } else {
      policyError(
        "COLLECTION_PROXY_EXIT_COUNTRIES_INVALID",
        "collectionProxyExitCountries is required for a multi-country route"
      );
    }
    const mismatchedLaneIndexes = collectionProxyExitCountries
      .map((countryCode, index) => (
        countryCode === collectionLanes[index].countryCode ? null : index
      ))
      .filter((index) => index !== null);
    if (mismatchedLaneIndexes.length > 0) {
      policyError(
        "COLLECTION_PROXY_EXIT_COUNTRY_MISMATCH",
        "each collection proxy exit must match its lane country",
        {
          mismatchedLaneIndexes,
          expectedCountries: collectionCountryCodes,
          observedCountries: collectionProxyExitCountries
        }
      );
    }
    const proxyExitCountry = input.proxyExitCountry === undefined
      || input.proxyExitCountry === null
      ? collectionProxyExitCountries[0]
      : normalizeCountryCode(input.proxyExitCountry, "proxyExitCountry");
    if (proxyExitCountry !== collectionProxyExitCountries[0]) {
      policyError(
        "COLLECTION_PROXY_EXIT_ALIAS_MISMATCH",
        "proxyExitCountry is a compatibility alias for collectionProxyExitCountries[0]"
      );
    }
    result.discoveryProxyExitCountry = discoveryProxyExitCountry;
    result.collectionProxyExitCountries = collectionProxyExitCountries;
    result.proxyExitCountry = proxyExitCountry;
  }
  return Object.freeze(result);
}

export function normalizeRouteIntent(input) {
  return normalizeRouteBase(input, { requireProxyExitCountry: false });
}

export function normalizeRoutePolicy(input) {
  return normalizeRouteBase(input, { requireProxyExitCountry: true });
}

export function validateRouteIntent(input) {
  return normalizeRouteIntent(input);
}

export function validateRoutePolicy(input) {
  return normalizeRoutePolicy(input);
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function fingerprintRouteIntent(input) {
  return sha256(normalizeRouteIntent(input));
}

export function fingerprintRoutePolicy(input) {
  return sha256(normalizeRoutePolicy(input));
}

export function fingerprintDiscoverySessionRoute(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    policyError("ROUTE_POLICY_INVALID", "route policy must be an object");
  }
  return sha256({
    schemaVersion: SESSION_ROUTE_FINGERPRINT_SCHEMA_VERSION,
    discoveryCountry: normalizeCountryCode(input.discoveryCountry, "discoveryCountry"),
    discoveryProxyServer: normalizeProxyServer(
      input.discoveryProxyServer,
      "discoveryProxyServer"
    )
  });
}

export function fingerprintCollectionSessionRoute(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    policyError("ROUTE_POLICY_INVALID", "route policy must be an object");
  }
  const collectionLanes = normalizeCollectionLaneConfiguration(input);
  return sha256({
    schemaVersion: COLLECTION_SESSION_ROUTE_FINGERPRINT_SCHEMA_VERSION,
    collectionLanes
  });
}

export const normalize = normalizeRoutePolicy;
export const validate = validateRoutePolicy;
export const fingerprint = fingerprintRoutePolicy;
