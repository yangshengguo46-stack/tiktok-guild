const SOURCE_CONFIG_VERSION = "tksoft-core-country-catalog-v3";

/**
 * Public, non-credential query values recovered from the original country
 * templates. Authentication headers, cookies, tokens and signatures are not
 * represented here and must come from the user's own opaque authorization
 * lease at runtime.
 */
export const ORIGINAL_FIXED_TEMPLATE_BASE_PARAMS = Object.freeze({
  use_simple_user: "true",
  league_phase: "0",
  ac: "wifi",
  channel: "googleplay",
  aid: "1233",
  app_name: "musical_ly",
  version_code: "320701",
  version_name: "32.7.1"
});

// The original Core sample stores one non-credential numeric leaderboard scope per
// display variant. Only these two non-authentication identifiers are compiled;
// the supplier's complete URLs and request headers are deliberately absent.
const SAFE_FIXED_SCOPE_BY_DISPLAY_NAME = Object.freeze({
  "MENA(中东)": ["6905836807787742214", "7320649238176615186"],
  "VN(越南)": ["7102813546375087106", "7320631740610579208"],
  "UK(英国)": ["6857195150104380422", "7321242483940248353"],
  "ID(印尼)": ["6593708259855826946", "7320590819615443717"],
  "TR(土耳其)": ["6973731383705748481", "7320645699017820933"],
  "TH(泰国)": ["6875228756568491009", "7320613717687241478"],
  "JP(日本)": ["7345054696245675009", "7546976143662811925"],
  "PH(菲律宾)": ["6804411217717838849", "7321227093555612421"],
  "FR(法国)": ["6884576420795270149", "7320579674679282465"],
  "DE(德国)": ["179046171447996417", "7326800300168252192"],
  "LATAM(哥伦比亚/秘鲁)": ["7080259202496758789", "7321189279525260037"],
  "LATAM(墨西哥)": ["6873163745955513346", "7320655471334853381"],
  "LATAM(其他)": ["6919114172619392006", "7321212833982302981"],
  "CCA(阿塞拜疆-日榜)": ["6713762922608542726", "7321213677289310994"],
  "CCA(白俄罗斯-日榜)": ["6920661239183180805", "7477249101568264965"],
  "CCA(哈萨克斯坦-日榜)": ["7220367598620541998", "7321216681576106798"],
  "CCA(吉尔吉斯-日榜)": ["6919265402405995525", "7538047598810499848"],
  "CCA(亚美尼亚/格鲁吉亚/摩尔多瓦/土库曼/塔吉克-日榜)": ["7149924726852682753", "7538042763166796560"],
  "IT(意大利)": ["6774408606245094405", "7320604287457708832"],
  "US(美国)": ["6954190509623673862", "7320587069414214442"],
  "US(加拿大)": ["6920532626445337606", "7320571470950255365"],
  "MY(马来西亚)": ["113110928446902272", "7321210198126693122"],
  "AU(澳洲)": ["7109052387742532613", "7352842388315966216"],
  "TW(中国台湾)": ["7114948236456248346", "7321185286787042054"],
  "RO(罗马尼亚)": ["6810805255417496581", "7418100006344788768"],
  "BR(巴西)": ["7150811311152333830", "7320582993740057349"],
  "ES(西班牙)": ["6897392236473746438", "7325766864814672673"],
  "KR(韩国)": ["6992227270216254465", "7348764074433350401"],
  "SE(瑞典)": ["6782215257647399941", "7408556130085915424"],
  "SE(丹麦/挪威/芬兰/冰岛)": ["6817541976255742982", "7408525119896718112"],
  "NL(荷兰)": ["7215186280157250565", "7516509576055114518"],
  "PL(波兰)": ["7410525937282991110", "7424098725959076613"],
  "BK(巴尔干)": ["7155537712501195781", "7528810739785501462"],
  "PT(葡萄牙)": ["6576665650428903430", "7538193997961300758"],
  "HU(捷克)": ["7258956053583938587", "7538290807296658198"],
  "HU(匈牙利/斯洛伐克)": ["7406528929484473377", "7538288538530433814"]
});

const ENDPOINT_PROFILES = Object.freeze({
  useast8: Object.freeze({
    id: "tkdesk-country-bundle-mena-v1",
    canonicalUrl: "https://webcast16-normal-useast8.tiktokv.us/webcast/ranklist/list/v2/"
  }),
  useast5: Object.freeze({
    id: "tkdesk-original-rank-useast5-v1",
    canonicalUrl: "https://webcast16-normal-useast5.tiktokv.us/webcast/ranklist/list/v2/"
  }),
  no1a: Object.freeze({
    id: "tkdesk-original-rank-no1a-v1",
    canonicalUrl: "https://webcast16-normal-no1a.tiktokv.eu/webcast/ranklist/list/v2/"
  })
});

const RAW_GROUPS = [
  ["MENA", ["MENA(中东)"], ["AE", "BH", "DJ", "DZ", "EG", "IQ", "JO", "KM", "KW", "LB", "LY", "MA", "MR", "OM", "BL", "QA", "SA", "SD", "SO", "TN", "YE"], 1, ["useast8"]],
  ["VN", ["VN(越南)"], ["VN"], 2, ["useast8"]],
  ["UK", ["UK(英国)"], ["CD", "GB", "GG", "GI", "IE", "IM", "JE", "MT", "SJ"], 2, ["no1a"]],
  ["ID", ["ID(印尼)"], ["ID"], 2, ["useast8"]],
  ["TR", ["TR(土耳其)"], ["TR"], 1, ["useast8"]],
  ["TH", ["TH(泰国)"], ["TH"], 2, ["useast8"]],
  ["JP", ["JP(日本)"], ["JP"], 2, ["useast8"]],
  ["PH", ["PH(菲律宾)"], ["PH"], 2, ["useast8"]],
  ["FR", ["FR(法国)"], ["FR", "BE", "GF", "MC", "PF", "RE", "NC", "TF"], 2, ["useast8"]],
  ["DE", ["DE(德国)"], ["DE", "CH", "AT", "LI", "LU"], 2, ["useast8"]],
  ["LATAM", ["LATAM(哥伦比亚/秘鲁)", "LATAM(墨西哥)", "LATAM(其他)"], ["AR", "CL", "PE", "CO", "EC", "PA", "BO", "CR", "UY", "DO", "GT", "HN", "VE", "SV", "NI", "PY", "PR", "GN", "MX"], 2, ["useast8", "useast8", "useast8"]],
  ["CCA", ["CCA(阿塞拜疆-日榜)", "CCA(白俄罗斯-日榜)", "CCA(哈萨克斯坦-日榜)", "CCA(吉尔吉斯-日榜)", "CCA(亚美尼亚/格鲁吉亚/摩尔多瓦/土库曼/塔吉克-日榜)"], ["AM", "AZ", "BY", "GE", "KG", "KZ", "MD", "TJ", "TM", "UA", "UZ"], 2, ["useast8", "useast5", "useast8", "no1a", "no1a"]],
  ["IT", ["IT(意大利)"], ["IT", "SM"], 2, ["useast8"]],
  ["US", ["US(美国)", "US(加拿大)"], ["US", "CA", "AS", "GU", "MP", "UM", "PR", "VI"], 2, ["useast8", "useast8"]],
  ["MY", ["MY(马来西亚)"], ["MY", "SG"], 2, ["useast8"]],
  ["AU", ["AU(澳洲)"], ["AU", "CC", "CK", "CX", "FJ", "FM", "KI", "MH", "NF", "NR", "NU", "NZ", "PG", "PN", "PW", "SB", "TK", "TO", "TV", "VU", "WF", "WS"], 2, ["useast8"]],
  ["TW", ["TW(中国台湾)"], ["TW"], 2, ["useast8"]],
  ["RO", ["RO(罗马尼亚)"], ["RO"], 2, ["useast8"]],
  ["BR", ["BR(巴西)"], ["BR"], 2, ["useast8"]],
  ["ES", ["ES(西班牙)"], ["ES", "AD"], 2, ["useast8"]],
  ["KR", ["KR(韩国)"], ["KR"], 2, ["useast8"]],
  ["SE", ["SE(瑞典)", "SE(丹麦/挪威/芬兰/冰岛)"], ["SE", "FI", "NO", "DK", "IS", "GL", "FO"], 2, ["useast8", "useast8"]],
  ["NL", ["NL(荷兰)"], ["NL"], 2, ["useast8"]],
  ["PL", ["PL(波兰)"], ["PL"], 2, ["useast8"]],
  ["BK", ["BK(巴尔干)"], ["GR", "HR", "BA", "RS", "ME", "SI", "BG", "AL", "MK"], 2, ["useast5"]],
  ["PT", ["PT(葡萄牙)"], ["AO", "CV", "GQ", "GW", "MZ", "PT", "ST"], 2, ["useast5"]],
  ["HU", ["HU(捷克)", "HU(匈牙利/斯洛伐克)"], ["CZ", "HU", "SK"], 2, ["useast5", "useast5"]]
];

const CCA_VARIANT_COUNTRIES = Object.freeze({
  "CCA(阿塞拜疆-日榜)": Object.freeze(["AZ"]),
  "CCA(白俄罗斯-日榜)": Object.freeze(["BY"]),
  "CCA(哈萨克斯坦-日榜)": Object.freeze(["KZ"]),
  "CCA(吉尔吉斯-日榜)": Object.freeze(["KG"]),
  "CCA(亚美尼亚/格鲁吉亚/摩尔多瓦/土库曼/塔吉克-日榜)": Object.freeze([
    "AM", "GE", "MD", "TJ", "TM", "UA", "UZ"
  ])
});

const MULTI_VARIANT_SELECTION_COUNTRIES = Object.freeze({
  ...CCA_VARIANT_COUNTRIES,
  "LATAM(哥伦比亚/秘鲁)": ["CO", "PE"],
  "LATAM(墨西哥)": ["MX"],
  "LATAM(其他)": ["AR", "CL", "EC", "PA", "BO", "CR", "UY", "DO", "GT", "HN", "VE", "SV", "NI", "PY", "PR", "GN"],
  "US(美国)": ["US", "AS", "GU", "MP", "UM", "PR", "VI"],
  "US(加拿大)": ["CA"],
  "SE(瑞典)": ["SE"],
  "SE(丹麦/挪威/芬兰/冰岛)": ["FI", "NO", "DK", "IS", "GL", "FO"],
  "HU(捷克)": ["CZ"],
  "HU(匈牙利/斯洛伐克)": ["HU", "SK"]
});

function immutable(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, immutable(nested)])
  ));
}

export function originalTopCodeContracts(topCode) {
  const normalized = Number.isSafeInteger(topCode) ? topCode : null;
  const topRankTypeCode = normalized === 2 ? 8 : normalized === 3 ? 1 : 0;
  const historyRankTypeCode = normalized === 3 ? 1 : 8;
  return immutable({
    topCode: normalized,
    ranking: { rankTypeCode: 16, regionTypeCode: 1, gapInterval: 0 },
    topScore: { rankTypeCode: topRankTypeCode, regionTypeCode: 1, gapInterval: 0 },
    historyRankScore: normalized === 1
      ? { state: "skipped", reason: "top_code_1" }
      : { state: "requested", rankTypeCode: historyRankTypeCode, regionTypeCode: 1, gapInterval: -1 },
    hotListScore: {
      sourceKind: "mobile_discovery_prefill",
      templateLabel: "HotListURL",
      rankTypeCode: 15,
      regionTypeCode: 1,
      gapInterval: 0
    },
    rankRecordScore: {
      sourceKind: "mobile_discovery_prefill",
      templateLabel: "RankRecordURL",
      rankTypeCode: 15,
      regionTypeCode: 1,
      gapInterval: -1
    }
  });
}

function originalFixedTemplateContracts(topCode) {
  const scoreContracts = originalTopCodeContracts(topCode);
  return immutable({
    topList: { ...scoreContracts.topScore, templateLabel: "TopURL" },
    historyList: scoreContracts.historyRankScore.state === "skipped"
      ? scoreContracts.historyRankScore
      : { ...scoreContracts.historyRankScore, templateLabel: "HistoryRankURL" },
    hotList: scoreContracts.hotListScore,
    rankRecord: scoreContracts.rankRecordScore
  });
}

export const ORIGINAL_COUNTRY_CONFIGURATIONS = immutable(RAW_GROUPS.map(([
  routeCode,
  displayNames,
  memberCountryCodes,
  topCode,
  endpointKeys
]) => ({
  routeCode,
  displayNames,
  variantCount: displayNames.length,
  memberCountryCodes,
  topCode,
  requestContracts: originalTopCodeContracts(topCode),
  displayVariants: displayNames.map((displayName, index) => ({
    displayName,
    endpointProfileId: ENDPOINT_PROFILES[endpointKeys[index]].id,
    canonicalUrl: ENDPOINT_PROFILES[endpointKeys[index]].canonicalUrl,
    selectionCountryCodes: MULTI_VARIANT_SELECTION_COUNTRIES[displayName] ?? memberCountryCodes,
    safeFixedTemplateScope: {
      anchorId: SAFE_FIXED_SCOPE_BY_DISPLAY_NAME[displayName][0],
      roomId: SAFE_FIXED_SCOPE_BY_DISPLAY_NAME[displayName][1]
    },
    fixedTemplateContracts: originalFixedTemplateContracts(topCode)
  })),
  membershipProvenance: "source_defined_include_code",
  endpointProvenance: "sanitized_source_defined_origin_and_path",
  safeFixedTemplateScopeIncluded: true,
  opaqueTemplateValuesIncluded: false
})));

const COUNTRY_TO_ROUTES = new Map();
for (const configuration of ORIGINAL_COUNTRY_CONFIGURATIONS) {
  for (const countryCode of configuration.memberCountryCodes) {
    const routes = COUNTRY_TO_ROUTES.get(countryCode) ?? [];
    routes.push(configuration.routeCode);
    COUNTRY_TO_ROUTES.set(countryCode, routes);
  }
}

function normalizedRouteCode(value) {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z][A-Z0-9_-]{1,31}$/.test(text) ? text : null;
}

function normalizedCountryCode(value) {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(text) ? text : null;
}

export function originalCountryConfigurationForRoute(routeCode) {
  const normalized = normalizedRouteCode(routeCode);
  return normalized
    ? ORIGINAL_COUNTRY_CONFIGURATIONS.find((configuration) => configuration.routeCode === normalized) ?? null
    : null;
}

export function originalExecutableProfileForCountry({
  marketRegion,
  countryCode,
  displayName = null
} = {}) {
  const routeCode = normalizedRouteCode(marketRegion);
  const normalizedCountry = normalizedCountryCode(countryCode);
  if (!routeCode || !normalizedCountry) return null;
  const configuration = originalCountryConfigurationForRoute(routeCode);
  if (!configuration || !configuration.memberCountryCodes.includes(normalizedCountry)) return null;

  let variant = null;
  if (displayName !== null) {
    const normalizedDisplayName = typeof displayName === "string" ? displayName.trim() : "";
    variant = configuration.displayVariants.find(
      (candidate) => candidate.displayName === normalizedDisplayName
        && candidate.selectionCountryCodes.includes(normalizedCountry)
    ) ?? null;
  } else {
    const matching = configuration.displayVariants.filter(
      (candidate) => candidate.selectionCountryCodes.includes(normalizedCountry)
    );
    const endpointIds = new Set(matching.map((candidate) => candidate.endpointProfileId));
    if (matching.length > 0 && endpointIds.size === 1) variant = matching[0];
  }
  if (!variant) return null;

  return immutable({
    id: variant.endpointProfileId,
    marketRegion: configuration.routeCode,
    countryCode: normalizedCountry,
    displayName: variant.displayName,
    canonicalUrl: variant.canonicalUrl,
    topCode: configuration.topCode,
    requestContracts: configuration.requestContracts,
    fixedTemplateContracts: variant.fixedTemplateContracts,
    safeFixedTemplateScope: variant.safeFixedTemplateScope,
    sourceRecordCount: configuration.variantCount,
    secretValuesExposed: false,
    safeFixedTemplateScopeIncluded: true,
    opaqueTemplateValuesIncluded: false
  });
}

export function originalExecutableProfiles() {
  const profiles = [];
  for (const configuration of ORIGINAL_COUNTRY_CONFIGURATIONS) {
    for (const countryCode of configuration.memberCountryCodes) {
      const profile = originalExecutableProfileForCountry({
        marketRegion: configuration.routeCode,
        countryCode
      });
      if (profile) profiles.push(profile);
    }
  }
  return immutable(profiles);
}

export function originalRouteCodesForCountry(countryCode) {
  const normalized = normalizedCountryCode(countryCode);
  return Object.freeze(normalized ? [...(COUNTRY_TO_ROUTES.get(normalized) ?? [])] : []);
}

function publicCountryConfiguration(configuration) {
  return immutable({
    routeCode: configuration.routeCode,
    displayNames: configuration.displayNames,
    variantCount: configuration.variantCount,
    memberCountryCodes: configuration.memberCountryCodes,
    topCode: configuration.topCode,
    requestContracts: configuration.requestContracts,
    displayVariants: configuration.displayVariants.map((variant) => ({
      displayName: variant.displayName,
      endpointProfileId: variant.endpointProfileId,
      selectionCountryCodes: variant.selectionCountryCodes,
      fixedTemplateContracts: variant.fixedTemplateContracts,
      fixedTemplateScopeCompiledInternally: true,
      fixedTemplateScopeExposed: false,
      opaqueTemplateValuesIncluded: false
    })),
    membershipProvenance: configuration.membershipProvenance,
    endpointProvenance: configuration.endpointProvenance,
    fixedTemplateScopeCompiledInternally: true,
    fixedTemplateScopeExposed: false,
    opaqueTemplateValuesIncluded: false
  });
}

export function originalCountryCatalog({ routeCode = null, countryCode = null } = {}) {
  const normalizedRoute = routeCode === null ? null : normalizedRouteCode(routeCode);
  const normalizedCountry = countryCode === null ? null : normalizedCountryCode(countryCode);
  if ((routeCode !== null && !normalizedRoute) || (countryCode !== null && !normalizedCountry)) {
    return null;
  }
  const configurations = ORIGINAL_COUNTRY_CONFIGURATIONS.filter((configuration) => (
    (!normalizedRoute || configuration.routeCode === normalizedRoute)
    && (!normalizedCountry || configuration.memberCountryCodes.includes(normalizedCountry))
  )).map(publicCountryConfiguration);
  return immutable({
    schemaVersion: SOURCE_CONFIG_VERSION,
    sourceRecordCount: 36,
    routeCodeCount: ORIGINAL_COUNTRY_CONFIGURATIONS.length,
    displayVariantCount: ORIGINAL_COUNTRY_CONFIGURATIONS.reduce(
      (total, configuration) => total + configuration.variantCount,
      0
    ),
    topCodeRecordDistribution: { "1": 2, "2": 34, "3": 0 },
    overlappingMemberCountryCodes: [
      { countryCode: "PR", routeCodes: ["LATAM", "US"] }
    ],
    configurations,
    sourceDefinedMembershipPreserved: true,
    executableProfileCount: originalExecutableProfiles().length,
    endpointProfileCount: Object.keys(ENDPOINT_PROFILES).length,
    fixedTemplateScopeCompiledInternally: true,
    fixedTemplateScopeExposed: false,
    safeFixedTemplateScopeCount: ORIGINAL_COUNTRY_CONFIGURATIONS.reduce(
      (total, configuration) => total + configuration.displayVariants.length,
      0
    ),
    opaqueTemplateValuesIncluded: false,
    secretValuesExposed: false
  });
}

export const ORIGINAL_COUNTRY_CATALOG_PROFILE = originalCountryCatalog();
