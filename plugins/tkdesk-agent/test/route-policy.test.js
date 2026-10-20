import test from "node:test";
import assert from "node:assert/strict";
import {
  COLLECTION_PROXY_LANE_MODE_COUNTRY,
  COLLECTION_PROXY_LANE_MODE_EXACT,
  RoutePolicyError,
  fingerprintCollectionSessionRoute,
  fingerprintDiscoverySessionRoute,
  fingerprintRouteIntent,
  fingerprintRoutePolicy,
  normalizeCollectionLanes,
  normalizeCollectionProxyExitCountries,
  normalizeCollectionProxyServers,
  normalizeCountryCode,
  normalizeMarketCountryCodes,
  normalizeMarketRegion,
  normalizeProxyServer,
  normalizeRouteIntent,
  normalizeRoutePolicy,
  validateRoutePolicy
} from "../mcp/core/route-policy.js";

const THREE_LANES = Object.freeze([
  Object.freeze({ countryCode: "SA", proxyServer: "socks5://127.0.0.1:10801" }),
  Object.freeze({ countryCode: "QA", proxyServer: "socks5://127.0.0.1:10802" }),
  Object.freeze({ countryCode: "EG", proxyServer: "socks5://127.0.0.1:10803" })
]);

function validIntent(overrides = {}) {
  return {
    marketRegion: "MENA",
    marketCountryCodes: ["SA", "QA", "EG", "AE"],
    discoveryCountry: "US",
    discoveryProxyServer: "socks5://127.0.0.1:10800",
    collectionLanes: THREE_LANES,
    ...overrides
  };
}

function validPolicy(overrides = {}) {
  return {
    ...validIntent(),
    discoveryProxyExitCountry: "US",
    collectionProxyExitCountries: ["SA", "QA", "EG"],
    ...overrides
  };
}

function hasCode(code) {
  return (error) => error instanceof RoutePolicyError && error.code === code;
}

test("normalizes an independent US discovery route and one proxy per collection country", () => {
  assert.equal(normalizeMarketRegion("  mena "), "MENA");
  assert.equal(normalizeCountryCode(" sa "), "SA");
  assert.deepEqual(normalizeMarketCountryCodes(["sa", "AE", "sa", " eg "]), [
    "AE", "EG", "SA"
  ]);

  const normalized = normalizeRoutePolicy(validPolicy({
    marketRegion: " mena ",
    marketCountryCodes: ["eg", "SA", "QA", "AE", "sa"],
    collectionLanes: [
      { countryCode: " sa ", proxyServer: "socks5://LOCALHOST:10801" },
      { countryCode: "qa", proxyServer: "http://127.0.0.2:10802" },
      { countryCode: "Eg", proxyServer: "https://[::1]:10803" }
    ]
  }));

  assert.equal(normalized.schemaVersion, "tkdesk.route-policy.v4");
  assert.equal(normalized.discoveryCountry, "US");
  assert.equal(normalized.discoveryProxyServer, "socks5://127.0.0.1:10800");
  assert.deepEqual(normalized.marketCountryCodes, ["AE", "EG", "QA", "SA"]);
  assert.deepEqual(normalized.collectionLanes, [
    { workId: 1, countryCode: "SA", proxyServer: "socks5://localhost:10801" },
    { workId: 2, countryCode: "QA", proxyServer: "http://127.0.0.2:10802" },
    { workId: 3, countryCode: "EG", proxyServer: "https://[::1]:10803" }
  ]);
  assert.deepEqual(normalized.collectionCountryCodes, ["SA", "QA", "EG"]);
  assert.deepEqual(normalized.collectionProxyServers, [
    "socks5://localhost:10801",
    "http://127.0.0.2:10802",
    "https://[::1]:10803"
  ]);
  assert.equal(normalized.collectionProxyLaneMode, COLLECTION_PROXY_LANE_MODE_COUNTRY);
  assert.equal(COLLECTION_PROXY_LANE_MODE_EXACT, COLLECTION_PROXY_LANE_MODE_COUNTRY);
  assert.equal(normalized.collectionProxyLaneCount, 3);
  assert.equal(normalized.routeCountry, "SA");
  assert.equal(normalized.backstageCountry, "SA");
  assert.equal(normalized.collectionProxyServer, "socks5://localhost:10801");
  assert.equal(normalized.proxyServer, normalized.collectionProxyServer);
  assert.equal(normalized.proxyExitCountry, "SA");
  assert.deepEqual(validateRoutePolicy(validPolicy()), normalizeRoutePolicy(validPolicy()));
});

test("supports one, two, or three collection lanes and rejects other counts", () => {
  for (const count of [1, 2, 3]) {
    const normalized = normalizeCollectionLanes(THREE_LANES.slice(0, count));
    assert.equal(normalized.length, count);
    assert.deepEqual(normalized.map((lane) => lane.workId),
      Array.from({ length: count }, (_, index) => index + 1));
  }

  assert.throws(() => normalizeCollectionLanes([]), hasCode("COLLECTION_PROXY_LANE_COUNT_INVALID"));
  assert.throws(
    () => normalizeCollectionLanes([...THREE_LANES, {
      countryCode: "AE",
      proxyServer: "socks5://127.0.0.1:10804"
    }]),
    hasCode("COLLECTION_PROXY_LANE_COUNT_INVALID")
  );
});

test("requires collection countries and proxy endpoints to be unique", () => {
  assert.throws(
    () => normalizeCollectionLanes([
      THREE_LANES[0],
      { countryCode: "SA", proxyServer: "socks5://127.0.0.1:10802" }
    ]),
    hasCode("COLLECTION_COUNTRIES_NOT_DISTINCT")
  );
  assert.throws(
    () => normalizeCollectionLanes([
      THREE_LANES[0],
      { countryCode: "QA", proxyServer: THREE_LANES[0].proxyServer }
    ]),
    hasCode("COLLECTION_PROXY_LANES_NOT_DISTINCT")
  );
  assert.throws(
    () => normalizeCollectionProxyServers([
      "socks5://127.0.0.1:10801",
      "socks5://127.0.0.1:10801"
    ]),
    hasCode("COLLECTION_PROXY_LANES_NOT_DISTINCT")
  );
});

test("validates market membership and observed exits lane by lane", () => {
  assert.deepEqual(normalizeCollectionProxyExitCountries(["sa", "qa", "eg"], 3), [
    "SA", "QA", "EG"
  ]);
  assert.throws(
    () => normalizeRouteIntent(validIntent({ marketCountryCodes: ["SA", "EG"] })),
    hasCode("COLLECTION_COUNTRY_NOT_IN_MARKET")
  );
  assert.throws(
    () => normalizeRoutePolicy(validPolicy({
      collectionProxyExitCountries: ["SA", "EG", "QA"]
    })),
    hasCode("COLLECTION_PROXY_EXIT_COUNTRY_MISMATCH")
  );
  assert.throws(
    () => normalizeRoutePolicy(validPolicy({ collectionProxyExitCountries: ["SA", "QA"] })),
    hasCode("COLLECTION_PROXY_EXIT_COUNTRY_COUNT_INVALID")
  );
  assert.throws(
    () => normalizeRoutePolicy(validPolicy({ discoveryProxyExitCountry: "CA" })),
    hasCode("DISCOVERY_PROXY_EXIT_COUNTRY_MISMATCH")
  );
});

test("binds market membership to the complete original IncludeCode catalog", () => {
  assert.throws(
    () => normalizeRouteIntent(validIntent({ marketRegion: "UNKNOWN" })),
    hasCode("MARKET_REGION_NOT_IN_ORIGINAL_CATALOG")
  );
  assert.throws(
    () => normalizeRouteIntent(validIntent({ marketCountryCodes: ["SA", "US", "QA", "EG"] })),
    hasCode("MARKET_COUNTRY_NOT_IN_ORIGINAL_CATALOG")
  );
  const sourceDefined = normalizeRouteIntent(validIntent({
    marketCountryCodes: ["SA", "BL", "QA", "EG"]
  }));
  assert.equal(sourceDefined.marketCountryCodes.includes("BL"), true);
});

test("accepts old arrays only when their per-index countries are unambiguous", () => {
  const { collectionLanes: _lanes, ...base } = validPolicy();
  const compatible = normalizeRoutePolicy({
    ...base,
    collectionProxyServers: THREE_LANES.map((lane) => lane.proxyServer),
    collectionCountryCodes: THREE_LANES.map((lane) => lane.countryCode)
  });
  assert.deepEqual(compatible.collectionLanes, THREE_LANES.map((lane, index) => ({
    workId: index + 1,
    ...lane
  })));

  assert.throws(
    () => normalizeRouteIntent({
      ...base,
      discoveryProxyExitCountry: undefined,
      collectionProxyExitCountries: undefined,
      collectionProxyServers: THREE_LANES.map((lane) => lane.proxyServer),
      routeCountry: "SA"
    }),
    hasCode("COLLECTION_LANE_COUNTRIES_REQUIRED")
  );
});

test("retains singular compatibility aliases only for lane one", () => {
  const single = normalizeRoutePolicy({
    marketRegion: "MENA",
    marketCountryCodes: ["SA", "QA"],
    discoveryCountry: "US",
    discoveryProxyServer: "socks5://127.0.0.1:10800",
    routeCountry: "SA",
    backstageCountry: "SA",
    collectionProxyServer: "socks5://127.0.0.1:10801",
    proxyServer: "socks5://127.0.0.1:10801",
    discoveryProxyExitCountry: "US",
    proxyExitCountry: "SA"
  });
  assert.deepEqual(single.collectionLanes, [{
    workId: 1,
    countryCode: "SA",
    proxyServer: "socks5://127.0.0.1:10801"
  }]);
  assert.deepEqual(single.collectionProxyExitCountries, ["SA"]);

  assert.throws(
    () => normalizeRouteIntent(validIntent({ routeCountry: "QA" })),
    hasCode("ROUTE_COUNTRY_ALIAS_MISMATCH")
  );
  assert.throws(
    () => normalizeRouteIntent(validIntent({ backstageCountry: "QA" })),
    hasCode("BACKSTAGE_COUNTRY_ALIAS_MISMATCH")
  );
  assert.throws(
    () => normalizeRouteIntent(validIntent({
      collectionProxyServer: "socks5://127.0.0.1:10999"
    })),
    hasCode("COLLECTION_PROXY_ALIAS_MISMATCH")
  );
  assert.throws(
    () => normalizeRoutePolicy(validPolicy({ proxyExitCountry: "QA" })),
    hasCode("COLLECTION_PROXY_EXIT_ALIAS_MISMATCH")
  );
});

test("supports an intent before probing but requires complete per-lane evidence for policy", () => {
  const intent = normalizeRouteIntent(validIntent());
  assert.equal(intent.collectionLanes.length, 3);
  assert.match(fingerprintRouteIntent(validIntent()), /^[a-f0-9]{64}$/);

  assert.throws(
    () => normalizeRoutePolicy(validIntent()),
    hasCode("COUNTRY_CODE_REQUIRED")
  );
  assert.throws(
    () => normalizeRoutePolicy({
      ...validIntent(),
      discoveryProxyExitCountry: "US",
      proxyExitCountry: "SA"
    }),
    hasCode("COLLECTION_PROXY_EXIT_COUNTRIES_INVALID")
  );
});

test("rejects malformed countries, regions, and non-loopback proxy URLs", () => {
  assert.throws(() => normalizeMarketRegion("M"), hasCode("MARKET_REGION_INVALID"));
  assert.throws(() => normalizeMarketRegion("中东"), hasCode("MARKET_REGION_INVALID"));
  assert.throws(() => normalizeCountryCode("USA"), hasCode("COUNTRY_CODE_INVALID"));

  assert.equal(normalizeProxyServer("http://localhost:8080"), "http://localhost:8080");
  assert.equal(normalizeProxyServer("https://127.0.0.9:8443"), "https://127.0.0.9:8443");
  assert.equal(normalizeProxyServer("socks5://[::1]:1080"), "socks5://[::1]:1080");
  assert.throws(
    () => normalizeProxyServer("ftp://127.0.0.1:21"),
    hasCode("PROXY_PROTOCOL_UNSUPPORTED")
  );
  assert.throws(
    () => normalizeProxyServer("http://user:pass@127.0.0.1:8080"),
    hasCode("PROXY_CREDENTIALS_NOT_ALLOWED")
  );
  assert.throws(
    () => normalizeProxyServer("http://192.168.1.2:8080"),
    hasCode("PROXY_NOT_LOOPBACK")
  );
  assert.throws(
    () => normalizeProxyServer("http://127.0.0.1"),
    hasCode("PROXY_PORT_REQUIRED")
  );
  assert.throws(
    () => normalizeProxyServer("http://127.0.0.1:8080/path"),
    hasCode("PROXY_URL_COMPONENTS_NOT_ALLOWED")
  );
});

test("fingerprints are stable after normalization and preserve lane identity", () => {
  const normalized = normalizeRoutePolicy(validPolicy());
  assert.equal(fingerprintRoutePolicy(normalized), fingerprintRoutePolicy(validPolicy({
    marketCountryCodes: ["AE", "EG", "QA", "SA", "SA"]
  })));

  const reorderedLanes = [THREE_LANES[1], THREE_LANES[0], THREE_LANES[2]];
  assert.notEqual(
    fingerprintRouteIntent(validIntent()),
    fingerprintRouteIntent(validIntent({ collectionLanes: reorderedLanes }))
  );
  assert.notEqual(
    fingerprintCollectionSessionRoute(validIntent()),
    fingerprintCollectionSessionRoute(validIntent({
      collectionLanes: THREE_LANES.map((lane, index) => index === 2
        ? { ...lane, proxyServer: "socks5://127.0.0.1:10903" }
        : lane)
    }))
  );
  assert.equal(
    fingerprintDiscoverySessionRoute(validIntent()),
    fingerprintDiscoverySessionRoute(validIntent({ collectionLanes: reorderedLanes }))
  );
  assert.match(fingerprintRoutePolicy(validPolicy()), /^[a-f0-9]{64}$/);
});
