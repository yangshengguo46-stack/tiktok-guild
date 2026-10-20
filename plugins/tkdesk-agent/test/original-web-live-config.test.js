import assert from "node:assert/strict";
import test from "node:test";
import {
  ORIGINAL_WEB_LIVE_CATALOG,
  ORIGINAL_WEB_LIVE_DISPLAY_VARIANTS,
  ORIGINAL_WEB_LIVE_ORIGIN,
  ORIGINAL_WEB_LIVE_PATH,
  ORIGINAL_WEB_LIVE_PUBLIC_BASE_QUERY,
  originalWebLiveCatalog,
  originalWebLiveProfileForCountry
} from "../mcp/core/original-web-live-config.js";

test("sanitized PC Web LIVE catalog preserves 36 variants and 27 routes", () => {
  assert.equal(ORIGINAL_WEB_LIVE_CATALOG.sourceRecordCount, 36);
  assert.equal(ORIGINAL_WEB_LIVE_CATALOG.routeCodeCount, 27);
  assert.equal(ORIGINAL_WEB_LIVE_DISPLAY_VARIANTS.length, 36);
  assert.equal(new Set(ORIGINAL_WEB_LIVE_DISPLAY_VARIANTS.map((record) => record.marketRegion)).size, 27);
  assert.equal(ORIGINAL_WEB_LIVE_ORIGIN, "https://webcast.us.tiktok.com");
  assert.equal(ORIGINAL_WEB_LIVE_PATH, "/webcast/feed/");
});

test("public base query is the exact fixed original PC Web LIVE query", () => {
  assert.deepEqual(ORIGINAL_WEB_LIVE_PUBLIC_BASE_QUERY, {
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
});

test("variant queries retain exact public locale and region fields", () => {
  assert.deepEqual(
    originalWebLiveProfileForCountry({ marketRegion: "MENA", countryCode: "SA" }).publicQuery,
    {
      ...ORIGINAL_WEB_LIVE_PUBLIC_BASE_QUERY,
      app_language: "ar",
      browser_language: "ar",
      priority_region: "AE",
      region: "AE",
      tz_name: "Asia/Dubai",
      webcast_language: "ar"
    }
  );
  assert.deepEqual(
    originalWebLiveProfileForCountry({ marketRegion: "MY", countryCode: "SG" }).publicQuery,
    {
      ...ORIGINAL_WEB_LIVE_PUBLIC_BASE_QUERY,
      app_language: "ms-MY",
      browser_language: "ms",
      priority_region: "",
      region: "MY",
      tz_name: "Asia/Singapore",
      webcast_language: "en"
    }
  );
  assert.equal(
    originalWebLiveProfileForCountry({ marketRegion: "ES", countryCode: "ES" }).publicQuery.tz_name,
    "Asia/Hebron"
  );
});

test("multi-variant routes resolve every member through the original natural partition", () => {
  const cases = [
    ["LATAM", "CO", "LATAM(哥伦比亚/秘鲁)"],
    ["LATAM", "PE", "LATAM(哥伦比亚/秘鲁)"],
    ["LATAM", "MX", "LATAM(墨西哥)"],
    ["LATAM", "CL", "LATAM(其他)"],
    ["CCA", "AZ", "CCA(阿塞拜疆-日榜)"],
    ["CCA", "BY", "CCA(白俄罗斯-日榜)"],
    ["CCA", "KZ", "CCA(哈萨克斯坦-日榜)"],
    ["CCA", "KG", "CCA(吉尔吉斯-日榜)"],
    ["CCA", "GE", "CCA(亚美尼亚/格鲁吉亚/摩尔多瓦/土库曼/塔吉克-日榜)"],
    ["US", "CA", "US(加拿大)"],
    ["US", "US", "US(美国)"],
    ["SE", "SE", "SE(瑞典)"],
    ["SE", "NO", "SE(丹麦/挪威/芬兰/冰岛)"],
    ["HU", "CZ", "HU(捷克)"],
    ["HU", "SK", "HU(匈牙利/斯洛伐克)"]
  ];
  for (const [marketRegion, countryCode, displayName] of cases) {
    assert.equal(originalWebLiveProfileForCountry({ marketRegion, countryCode }).displayName, displayName);
    assert.equal(
      originalWebLiveProfileForCountry({ marketRegion, countryCode, displayName }).displayName,
      displayName
    );
  }
});

test("resolver fails closed for mismatches, ambiguity attempts, and malformed selectors", () => {
  assert.equal(originalWebLiveProfileForCountry({ marketRegion: "US", countryCode: "CA", displayName: "US(美国)" }), null);
  assert.equal(originalWebLiveProfileForCountry({ marketRegion: "LATAM", countryCode: "MX", displayName: "LATAM(其他)" }), null);
  assert.equal(originalWebLiveProfileForCountry({ marketRegion: "MENA", countryCode: "US" }), null);
  assert.equal(originalWebLiveProfileForCountry({ marketRegion: "bad route", countryCode: "SA" }), null);
  assert.equal(originalWebLiveProfileForCountry({ marketRegion: "MENA", countryCode: "SAU" }), null);
  assert.equal(originalWebLiveProfileForCountry({ marketRegion: "MENA", countryCode: "SA", displayName: "" }), null);
  assert.equal(originalWebLiveProfileForCountry(), null);
});

test("catalog contains only public feed configuration, never session or signed request material", () => {
  const serialized = JSON.stringify(ORIGINAL_WEB_LIVE_CATALOG);
  assert.doesNotMatch(serialized, /"(?:authorization|headers?|token|x-tt-token|signature|signed_url|webLiveUrl)"\s*:/i);
  assert.doesNotMatch(serialized, /(?:[?&](?:msToken|X-Bogus|_signature)=)|(?:Cookie:\s*)/i);
  assert.equal(ORIGINAL_WEB_LIVE_CATALOG.authenticationIncluded, false);
  assert.equal(ORIGINAL_WEB_LIVE_CATALOG.signedUrlIncluded, false);
  assert.equal(Object.isFrozen(ORIGINAL_WEB_LIVE_CATALOG), true);
  assert.equal(Object.isFrozen(ORIGINAL_WEB_LIVE_DISPLAY_VARIANTS[0].publicQuery), true);
  assert.equal(originalWebLiveCatalog({ marketRegion: "CCA" }).variants.length, 5);
  assert.equal(originalWebLiveCatalog({ marketRegion: "bad route" }), null);
});
