import { originalCountryConfigurationForRoute } from "./original-country-config.js";

export const ORIGINAL_WEB_LIVE_ORIGIN = "https://webcast.us.tiktok.com";
export const ORIGINAL_WEB_LIVE_PATH = "/webcast/feed/";

export const ORIGINAL_WEB_LIVE_PUBLIC_BASE_QUERY = immutable({
  aid: "1988",
  app_name: "tiktok_web",
  browser_name: "Mozilla",
  browser_online: "true",
  browser_platform: "Win32",
  browser_version: "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  channel: "tiktok_web",
  channel_id: "21",
  cookie_enabled: "true",
  data_collection_enabled: "true",
  device_platform: "web_pc",
  device_type: "web_h265",
  focus_state: "false",
  from_page: "user",
  hidden_banner: "true",
  history_len: "6",
  is_fullscreen: "false",
  is_non_personalized: "0",
  is_page_visible: "true",
  max_time: "0",
  os: "windows",
  referer: "https://www.tiktok.com/",
  req_from: "pc_web_recommend_room_loadmore",
  root_referer: "https://www.tiktok.com/",
  screen_height: "1080",
  screen_width: "1920",
  user_is_login: "true"
});

const VARIANT_QUERY_KEYS = Object.freeze([
  "app_language",
  "browser_language",
  "priority_region",
  "region",
  "tz_name",
  "webcast_language"
]);

function variant(marketRegion, displayName, selectionCountryCodes, [
  appLanguage,
  browserLanguage,
  priorityRegion,
  region,
  timeZone,
  webcastLanguage
]) {
  return {
    marketRegion,
    displayName,
    selectionCountryCodes,
    variantQuery: {
      app_language: appLanguage,
      browser_language: browserLanguage,
      priority_region: priorityRegion,
      region,
      tz_name: timeZone,
      webcast_language: webcastLanguage
    }
  };
}

const RAW_VARIANTS = [
  variant("MENA", "MENA(中东)", null, ["ar", "ar", "AE", "AE", "Asia/Dubai", "ar"]),
  variant("VN", "VN(越南)", null, ["vi-VN", "vi", "VN", "VN", "Asia/Bangkok", "vi-VN"]),
  variant("UK", "UK(英国)", null, ["en", "en-GB", "GB", "GB", "Europe/London", "en"]),
  variant("ID", "ID(印尼)", null, ["id-ID", "id", "ID", "ID", "Asia/Bangkok", "id-ID"]),
  variant("TR", "TR(土耳其)", null, ["tr-TR", "tr", "TR", "TR", "Europe/Istanbul", "tr-TR"]),
  variant("TH", "TH(泰国)", null, ["th-TH", "th", "TH", "TH", "Asia/Bangkok", "th-TH"]),
  variant("JP", "JP(日本)", null, ["ja-JP", "ja", "JP", "JP", "Asia/Tokyo", "ja-JP"]),
  variant("PH", "PH(菲律宾)", null, ["fil-PH", "fil", "PH", "PH", "Asia/Singapore", "fil-PH"]),
  variant("FR", "FR(法国)", null, ["fr", "fr-FR", "FR", "FR", "Europe/Paris", "fr"]),
  variant("DE", "DE(德国)", null, ["de-DE", "de-DE", "DE", "DE", "Europe/Berlin", "de-DE"]),
  variant("LATAM", "LATAM(哥伦比亚/秘鲁)", ["CO", "PE"], ["es", "es-CO", "CO", "CO", "America/Bogota", "es"]),
  variant("LATAM", "LATAM(墨西哥)", ["MX"], ["es", "es-MX", "MX", "MX", "America/Mexico_City", "es"]),
  variant("LATAM", "LATAM(其他)", [
    "AR", "CL", "EC", "PA", "BO", "CR", "UY", "DO", "GT", "HN", "VE", "SV", "NI", "PY", "PR", "GN"
  ], ["es", "es-CL", "", "CL", "America/Santiago", "es"]),
  variant("CCA", "CCA(阿塞拜疆-日榜)", ["AZ"], ["ru-RU", "ru", "AZ", "AZ", "Asia/Baku", "ru-RU"]),
  variant("CCA", "CCA(白俄罗斯-日榜)", ["BY"], ["ru-RU", "ru", "BY", "BY", "Europe/Minsk", "ru-RU"]),
  variant("CCA", "CCA(哈萨克斯坦-日榜)", ["KZ"], ["ru-RU", "ru", "KZ", "KZ", "Asia/Urumqi", "ru-RU"]),
  variant("CCA", "CCA(吉尔吉斯-日榜)", ["KG"], ["ru-RU", "ru", "KG", "KG", "Asia/Urumqi", "ru-RU"]),
  variant("CCA", "CCA(亚美尼亚/格鲁吉亚/摩尔多瓦/土库曼/塔吉克-日榜)", [
    "AM", "GE", "MD", "TJ", "TM", "UA", "UZ"
  ], ["ru-RU", "ru", "AM", "AM", "Asia/Yerevan", "ru-RU"]),
  variant("IT", "IT(意大利)", null, ["it-IT", "it-IT", "IT", "IT", "Europe/Berlin", "it-IT"]),
  variant("US", "US(美国)", ["US", "AS", "GU", "MP", "UM", "PR", "VI"], [
    "en", "en-US", "US", "US", "America/Los_Angeles", "en"
  ]),
  variant("US", "US(加拿大)", ["CA"], ["en", "en-CA", "CA", "CA", "America/New_York", "en"]),
  variant("MY", "MY(马来西亚)", null, ["ms-MY", "ms", "", "MY", "Asia/Singapore", "en"]),
  variant("AU", "AU(澳洲)", null, ["en", "en-AU", "AU", "AU", "Australia/Sydney", "en"]),
  variant("TW", "TW(中国台湾)", null, ["zh-Hant-TW", "zh-TW", "TW", "TW", "Asia/Taipei", "zh-Hant-TW"]),
  variant("RO", "RO(罗马尼亚)", null, ["ro-RO", "ro", "RO", "RO", "Europe/Bucharest", "ro-RO"]),
  variant("BR", "BR(巴西)", null, ["pt-BR", "pt-BR", "BR", "BR", "America/Sao_Paulo", "pt-BR"]),
  variant("ES", "ES(西班牙)", null, ["es", "es", "ES", "ES", "Asia/Hebron", "es"]),
  variant("KR", "KR(韩国)", null, ["ko-KR", "ko", "KR", "KR", "Asia/Seoul", "ko-KR"]),
  variant("SE", "SE(瑞典)", ["SE"], ["sv-SE", "sv", "SE", "SE", "Europe/Stockholm", "sv-SE"]),
  variant("SE", "SE(丹麦/挪威/芬兰/冰岛)", ["FI", "NO", "DK", "IS", "GL", "FO"], [
    "sv-SE", "sv", "SE", "SE", "Europe/Stockholm", "sv-SE"
  ]),
  variant("NL", "NL(荷兰)", null, ["nl-NL", "nl", "NL", "NL", "Europe/Amsterdam", "nl-NL"]),
  variant("PL", "PL(波兰)", null, ["pl-PL", "pl", "PL", "PL", "Europe/Warsaw", "pl-PL"]),
  variant("BK", "BK(巴尔干)", null, ["en", "en-US", "US", "US", "America/Los_Angeles", "en"]),
  variant("PT", "PT(葡萄牙)", null, ["en", "en-US", "US", "US", "America/Los_Angeles", "en"]),
  variant("HU", "HU(捷克)", ["CZ"], ["en", "en-US", "US", "US", "America/Los_Angeles", "en"]),
  variant("HU", "HU(匈牙利/斯洛伐克)", ["HU", "SK"], [
    "en", "en-US", "US", "US", "America/Los_Angeles", "en"
  ])
];

function immutable(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, immutable(nested)])
  ));
}

function exactSourceConfiguration(marketRegion, displayName) {
  const configuration = originalCountryConfigurationForRoute(marketRegion);
  if (!configuration || !configuration.displayNames.includes(displayName)) return null;
  return configuration;
}

function materializeVariant(raw) {
  const configuration = exactSourceConfiguration(raw.marketRegion, raw.displayName);
  if (!configuration) throw new Error(`original_web_live_source_variant_missing:${raw.marketRegion}:${raw.displayName}`);
  const selectionCountryCodes = raw.selectionCountryCodes ?? configuration.memberCountryCodes;
  if (selectionCountryCodes.length < 1
    || selectionCountryCodes.some((countryCode) => !configuration.memberCountryCodes.includes(countryCode))) {
    throw new Error(`original_web_live_selection_invalid:${raw.marketRegion}:${raw.displayName}`);
  }
  if (Object.keys(raw.variantQuery).length !== VARIANT_QUERY_KEYS.length
    || VARIANT_QUERY_KEYS.some((key) => typeof raw.variantQuery[key] !== "string")) {
    throw new Error(`original_web_live_query_invalid:${raw.marketRegion}:${raw.displayName}`);
  }
  return {
    marketRegion: raw.marketRegion,
    displayName: raw.displayName,
    sourceMemberCountryCodes: configuration.memberCountryCodes,
    selectionCountryCodes,
    origin: ORIGINAL_WEB_LIVE_ORIGIN,
    path: ORIGINAL_WEB_LIVE_PATH,
    publicQuery: {
      ...ORIGINAL_WEB_LIVE_PUBLIC_BASE_QUERY,
      ...raw.variantQuery
    },
    sourceProvenance: "sanitized_original_core_web_live_url",
    authenticationIncluded: false,
    signedUrlIncluded: false
  };
}

export const ORIGINAL_WEB_LIVE_DISPLAY_VARIANTS = immutable(RAW_VARIANTS.map(materializeVariant));

function validateNaturalPartition() {
  const routes = new Set(ORIGINAL_WEB_LIVE_DISPLAY_VARIANTS.map((record) => record.marketRegion));
  if (ORIGINAL_WEB_LIVE_DISPLAY_VARIANTS.length !== 36 || routes.size !== 27) {
    throw new Error("original_web_live_catalog_cardinality_invalid");
  }
  for (const routeCode of routes) {
    const configuration = originalCountryConfigurationForRoute(routeCode);
    const records = ORIGINAL_WEB_LIVE_DISPLAY_VARIANTS.filter((record) => record.marketRegion === routeCode);
    const selected = records.flatMap((record) => record.selectionCountryCodes);
    if (new Set(selected).size !== selected.length
      || selected.length !== configuration.memberCountryCodes.length
      || configuration.memberCountryCodes.some((countryCode) => !selected.includes(countryCode))) {
      throw new Error(`original_web_live_natural_partition_invalid:${routeCode}`);
    }
  }
}

validateNaturalPartition();

function normalizedMarketRegion(value) {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z][A-Z0-9_-]{1,31}$/.test(text) ? text : null;
}

function normalizedCountryCode(value) {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(text) ? text : null;
}

export function originalWebLiveProfileForCountry({
  marketRegion,
  countryCode,
  displayName
} = {}) {
  const normalizedRegion = normalizedMarketRegion(marketRegion);
  const normalizedCountry = normalizedCountryCode(countryCode);
  const displayNameProvided = displayName !== undefined && displayName !== null;
  const normalizedDisplayName = displayNameProvided && typeof displayName === "string"
    ? displayName.trim()
    : null;
  if (!normalizedRegion || !normalizedCountry || (displayNameProvided && !normalizedDisplayName)) return null;

  const matches = ORIGINAL_WEB_LIVE_DISPLAY_VARIANTS.filter((record) => (
    record.marketRegion === normalizedRegion
    && record.selectionCountryCodes.includes(normalizedCountry)
    && (!displayNameProvided || record.displayName === normalizedDisplayName)
  ));
  if (matches.length !== 1) return null;
  const record = matches[0];
  return immutable({
    marketRegion: record.marketRegion,
    countryCode: normalizedCountry,
    displayName: record.displayName,
    origin: record.origin,
    path: record.path,
    publicQuery: record.publicQuery,
    sourceProvenance: record.sourceProvenance,
    authenticationIncluded: false,
    signedUrlIncluded: false
  });
}

export function originalWebLiveCatalog({ marketRegion = null } = {}) {
  const normalizedRegion = marketRegion === null ? null : normalizedMarketRegion(marketRegion);
  if (marketRegion !== null && !normalizedRegion) return null;
  const variants = ORIGINAL_WEB_LIVE_DISPLAY_VARIANTS.filter(
    (record) => !normalizedRegion || record.marketRegion === normalizedRegion
  );
  return immutable({
    schemaVersion: "tksoft-core-web-live-catalog-v1",
    sourceRecordCount: 36,
    routeCodeCount: 27,
    origin: ORIGINAL_WEB_LIVE_ORIGIN,
    path: ORIGINAL_WEB_LIVE_PATH,
    publicBaseQuery: ORIGINAL_WEB_LIVE_PUBLIC_BASE_QUERY,
    variants,
    authenticationIncluded: false,
    signedUrlIncluded: false
  });
}

export const ORIGINAL_WEB_LIVE_CATALOG = originalWebLiveCatalog();
