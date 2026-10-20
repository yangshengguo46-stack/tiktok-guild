import assert from "node:assert/strict";
import test from "node:test";
import {
  ORIGINAL_COUNTRY_CATALOG_PROFILE,
  originalCountryCatalog,
  originalCountryConfigurationForRoute,
  originalExecutableProfileForCountry,
  originalExecutableProfiles,
  originalRouteCodesForCountry,
  originalTopCodeContracts
} from "../mcp/core/original-country-config.js";

test("catalog preserves all 36 original display variants across 27 route codes", () => {
  assert.equal(ORIGINAL_COUNTRY_CATALOG_PROFILE.sourceRecordCount, 36);
  assert.equal(ORIGINAL_COUNTRY_CATALOG_PROFILE.routeCodeCount, 27);
  assert.equal(ORIGINAL_COUNTRY_CATALOG_PROFILE.displayVariantCount, 36);
  assert.deepEqual(ORIGINAL_COUNTRY_CATALOG_PROFILE.topCodeRecordDistribution, {
    "1": 2,
    "2": 34,
    "3": 0
  });
  assert.equal(ORIGINAL_COUNTRY_CATALOG_PROFILE.configurations.length, 27);
  assert.equal(ORIGINAL_COUNTRY_CATALOG_PROFILE.secretValuesExposed, false);
  assert.equal(ORIGINAL_COUNTRY_CATALOG_PROFILE.opaqueTemplateValuesIncluded, false);
  assert.equal(ORIGINAL_COUNTRY_CATALOG_PROFILE.fixedTemplateScopeCompiledInternally, true);
  assert.equal(ORIGINAL_COUNTRY_CATALOG_PROFILE.fixedTemplateScopeExposed, false);
  assert.equal(ORIGINAL_COUNTRY_CATALOG_PROFILE.safeFixedTemplateScopeCount, 36);
  assert.equal(ORIGINAL_COUNTRY_CATALOG_PROFILE.endpointProfileCount, 3);
  assert.equal(ORIGINAL_COUNTRY_CATALOG_PROFILE.executableProfileCount, 147);
  const serialized = JSON.stringify(ORIGINAL_COUNTRY_CATALOG_PROFILE);
  assert.doesNotMatch(serialized, /token|cookie|authorization|canonicalUrl|"safeFixedTemplateScope"|tiktokv\.(?:us|eu)|[?&](?:anchor_id|room_id)=/i);
  for (const profile of originalExecutableProfiles()) {
    assert.equal(serialized.includes(profile.safeFixedTemplateScope.anchorId), false);
    assert.equal(serialized.includes(profile.safeFixedTemplateScope.roomId), false);
  }
  assert.equal(
    ORIGINAL_COUNTRY_CATALOG_PROFILE.configurations.every((configuration) => (
      configuration.displayVariants.every((variant) => (
        variant.fixedTemplateScopeCompiledInternally === true
        && variant.fixedTemplateScopeExposed === false
        && !Object.hasOwn(variant, "safeFixedTemplateScope")
        && !Object.hasOwn(variant, "canonicalUrl")
      ))
    )),
    true
  );
});

test("internal executable profiles retain endpoint variants and fixed scope without credentials", () => {
  assert.equal(originalExecutableProfiles().length, 147);
  assert.equal(
    new Set(originalExecutableProfiles().map((profile) => new URL(profile.canonicalUrl).host)).size,
    3
  );
  assert.match(
    originalExecutableProfileForCountry({ marketRegion: "CCA", countryCode: "BY" }).canonicalUrl,
    /useast5\.tiktokv\.us/
  );
  assert.match(
    originalExecutableProfileForCountry({ marketRegion: "CCA", countryCode: "KG" }).canonicalUrl,
    /no1a\.tiktokv\.eu/
  );
  assert.match(
    originalExecutableProfileForCountry({ marketRegion: "CCA", countryCode: "AZ" }).canonicalUrl,
    /useast8\.tiktokv\.us/
  );
  assert.equal(
    originalExecutableProfileForCountry({ marketRegion: "CCA", countryCode: "BY" }).topCode,
    2
  );
  assert.match(
    originalExecutableProfileForCountry({ marketRegion: "MENA", countryCode: "SA" })
      .safeFixedTemplateScope.anchorId,
    /^\d{5,32}$/
  );
  assert.equal(
    originalExecutableProfileForCountry({ marketRegion: "CCA", countryCode: "BY", displayName: "CCA(阿塞拜疆-日榜)" }),
    null
  );
  assert.deepEqual(
    [
      ["MENA", "SA", "MENA(中东)"],
      ["MENA", "QA", "MENA(中东)"],
      ["MENA", "EG", "MENA(中东)"],
      ["CCA", "BY", "CCA(白俄罗斯-日榜)"],
      ["CCA", "KG", "CCA(吉尔吉斯-日榜)"],
      ["BK", "RS", "BK(巴尔干)"]
    ].map(([marketRegion, countryCode, displayName]) => {
      const profile = originalExecutableProfileForCountry({ marketRegion, countryCode });
      return [profile?.marketRegion, profile?.countryCode, profile?.displayName, Boolean(profile?.id)];
    }),
    [
      ["MENA", "SA", "MENA(中东)", true],
      ["MENA", "QA", "MENA(中东)", true],
      ["MENA", "EG", "MENA(中东)", true],
      ["CCA", "BY", "CCA(白俄罗斯-日榜)", true],
      ["CCA", "KG", "CCA(吉尔吉斯-日榜)", true],
      ["BK", "RS", "BK(巴尔干)", true]
    ]
  );
  assert.equal(originalExecutableProfileForCountry({ marketRegion: "CCA", countryCode: "RS" }), null);
});

test("MENA and duplicate display variants retain source-defined membership", () => {
  const mena = originalCountryConfigurationForRoute("mena");
  assert.equal(mena.topCode, 1);
  assert.deepEqual(mena.displayNames, ["MENA(中东)"]);
  assert.equal(mena.memberCountryCodes.includes("SA"), true);
  assert.equal(mena.memberCountryCodes.includes("QA"), true);
  assert.equal(mena.memberCountryCodes.includes("EG"), true);
  assert.equal(mena.memberCountryCodes.includes("BL"), true);

  assert.equal(originalCountryConfigurationForRoute("CCA").displayNames.length, 5);
  assert.equal(originalCountryConfigurationForRoute("LATAM").displayNames.length, 3);
  assert.equal(originalCountryConfigurationForRoute("US").displayNames.length, 2);
  assert.deepEqual(originalRouteCodesForCountry("PR"), ["LATAM", "US"]);
  assert.deepEqual(originalRouteCodesForCountry("SA"), ["MENA"]);
});

test("TopCode contracts reproduce every executable branch without caller parameters", () => {
  assert.deepEqual(originalTopCodeContracts(1).topScore, {
    rankTypeCode: 0,
    regionTypeCode: 1,
    gapInterval: 0
  });
  assert.deepEqual(originalTopCodeContracts(1).historyRankScore, {
    state: "skipped",
    reason: "top_code_1"
  });
  assert.equal(originalTopCodeContracts(2).topScore.rankTypeCode, 8);
  assert.equal(originalTopCodeContracts(2).historyRankScore.rankTypeCode, 8);
  assert.equal(originalTopCodeContracts(3).topScore.rankTypeCode, 1);
  assert.equal(originalTopCodeContracts(3).historyRankScore.rankTypeCode, 1);
  assert.equal(originalTopCodeContracts(999).topScore.rankTypeCode, 0);
  assert.equal(originalTopCodeContracts(999).historyRankScore.rankTypeCode, 8);
  assert.deepEqual(originalTopCodeContracts(2).hotListScore, {
    sourceKind: "mobile_discovery_prefill",
    templateLabel: "HotListURL",
    rankTypeCode: 15,
    regionTypeCode: 1,
    gapInterval: 0
  });
});

test("catalog filters by route or member country and rejects malformed selectors", () => {
  assert.deepEqual(originalCountryCatalog({ routeCode: "TR" }).configurations.map(
    (configuration) => configuration.routeCode
  ), ["TR"]);
  assert.deepEqual(originalCountryCatalog({ countryCode: "PR" }).configurations.map(
    (configuration) => configuration.routeCode
  ), ["LATAM", "US"]);
  assert.equal(originalCountryCatalog({ routeCode: "bad route" }), null);
  assert.equal(originalCountryCatalog({ countryCode: "SAU" }), null);
});
