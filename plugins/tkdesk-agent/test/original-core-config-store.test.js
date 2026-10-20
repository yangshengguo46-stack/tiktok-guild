import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMobileRankingAuthorizationProvider } from "../mcp/core/mobile-ranking-authorization-provider.js";
import { createTikTokRankingTransport } from "../mcp/core/tiktok-ranking-transport.js";
const moduleResult =
  await import("../mcp/core/original-core-config-store.js").catch((e) => {
    if (e.code !== "ERR_MODULE_NOT_FOUND") throw e;
    return null;
  });
const PASSWORD = Buffer.from("test-only-original-format-key");
const TOKEN = "test-only-not-real-original-authorization";
const UA =
  "com.zhiliaoapp.musically/2022602030 (Linux; U; Android 7.1.2; id; SM-G9750; Build/LMY47I;tt-ok/3.12.13.1)";
function fixture() {
  const url = (type) =>
    "https://webcast16-normal-useast5.tiktokv.us/webcast/ranklist/list/v2/?anchor_id=6905836807787742214&room_id=7320649238176615186&rank_type=" +
    type +
    "&region_type=1&gap_interval=0&use_simple_user=true&league_phase=0&ac=wifi&channel=googleplay&aid=1233&app_name=musical_ly&version_code=320701&version_name=32.7.1";
  return {
    countries: [
      {
        displayName: "MENA(中东)",
        countryCode: "MENA",
        IncludeCode: ["SA,QA,EG,AE"],
        topCode: 1,
        topUrl: url(0),
        historyRankURL: "",
        hotListURL: url(15),
        rankRecordURL: url(15).replace("gap_interval=0", "gap_interval=-1"),
      },
    ],
    mobileHeader: [
      {
        host: "webcast16-normal-c-alisg.tiktokv.com",
        httpHeader: {
          "User-Agent": UA,
          "X-Tt-Token": "test-only-wrong-host-authorization",
          "sdk-version": "2",
        },
      },
      {
        host: "webcast16-normal-useast5.tiktokv.us",
        httpHeader: {
          "User-Agent": UA,
          "X-Tt-Token": TOKEN,
          "sdk-version": "2",
        },
      },
    ],
  };
}
function encrypt(config) {
  const salt = Buffer.from("12345678");
  const nonce = Buffer.alloc(12, 4);
  const mask = crypto
    .createHash("sha256")
    .update(PASSWORD)
    .update(salt)
    .digest();
  const b = Buffer.from(JSON.stringify(config));
  for (let i = 0; i < b.length; i++) b[i] ^= mask[i % 32];
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    crypto.createHash("sha256").update(PASSWORD).digest(),
    nonce,
  );
  return Buffer.concat([
    salt,
    nonce,
    cipher.update(b),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}
async function setup(t, config = fixture(), opts = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "original-core-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "providers"), { mode: 0o700 });
  await writeFile(
    path.join(dir, "providers", "tksoft-original.Core.dll"),
    encrypt(config),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(dir, "providers", "tksoft-original.json"),
    JSON.stringify({
      enabled: opts.enabled ?? true,
      authorizationSource: "user_authorized_original_bundle",
      cachedAt: new Date().toISOString(),
      defaultMarketRegion: "MENA",
    }),
    { mode: 0o600 },
  );
  const source = moduleResult
    ? await moduleResult.createOriginalCoreConfigStore({
        dataDirectory: dir,
        passphraseReader: async () => Buffer.from(PASSWORD),
      })
    : null;
  return { source, dir };
}
const scope = {
  marketRegion: "MENA",
  countryCode: "SA",
  endpointProfileId: "tkdesk-country-bundle-mena-v1",
  proxyServer: "http://127.0.0.1:17891",
};
test("published host and its authorization reach the existing fixed-list pipeline without manual token provision", async (t) => {
  const { source } = await setup(t);
  assert.ok(source, "original configuration source is not implemented");
  const provider = createMobileRankingAuthorizationProvider({
    coreConfigStore: source,
    profileResolver: (s) => source.profileFor(s),
    requestContextFactory: {
      async newContext(o) {
        assert.equal(o.extraHTTPHeaders["x-tt-token"], TOKEN);
        return {
          async get(url) {
            assert.equal(
              new URL(url).hostname,
              "webcast16-normal-useast5.tiktokv.us",
            );
            return {
              status: () => 200,
              text: async () =>
                JSON.stringify({
                  status_code: 0,
                  data: {
                    rank_view: {
                      ranks: [
                        {
                          score: "23",
                          room_id_str: "7498765432109876543",
                          rank_user: {
                            display_id: "sample_creator",
                            id_str: "7412345678901234567",
                          },
                        },
                      ],
                      owner_rank: { score: "0" },
                    },
                  },
                }),
            };
          },
          async dispose() {},
        };
      },
    },
  });
  const transport = createTikTokRankingTransport({
    authorizationProvider: provider,
    profileResolver: (c, m, d) =>
      source.profileFor({ countryCode: c, marketRegion: m, displayName: d }),
  });
  const result = await transport.fetchOriginalCountryTemplateBundle({
    verifiedRoute: {
      marketRegion: "MENA",
      collectionLanes: [
        {
          workId: 1,
          countryCode: "SA",
          observedExitCountry: "SA",
          verified: true,
          proxyServer: scope.proxyServer,
        },
      ],
    },
    marketRegion: "MENA",
    countryCode: "SA",
    workId: 1,
  });
  assert.equal(result.status, "ready");
  assert.equal(result.candidates.length, 1);
  assert.equal(
    result.candidates[0].handle ??
      result.candidates[0].displayId ??
      result.candidates[0].username,
    "sample_creator",
  );
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});
test("status keeps the original credential source honest without revealing secrets", async (t) => {
  const { source } = await setup(t);
  assert.ok(source);
  const s = await source.status(scope);
  assert.equal(s.mobileAuthorization.state, "ready");
  assert.equal(
    s.mobileAuthorization.provenance,
    "user_authorized_original_bundle",
  );
  assert.ok(!JSON.stringify(s).includes(TOKEN));
  const a = await source.resolveMobileAuthorization(scope);
  assert.equal(a.status, "ready");
  assert.equal(a.value.toString(), TOKEN);
  a.value.fill(0);
  assert.equal(
    (
      await source.resolveMobileAuthorization({
        ...scope,
        marketRegion: "TR",
        countryCode: "TR",
      })
    ).status,
    "unsupported_country",
  );
});
test("missing opt-in leaves the original source disabled", async (t) => {
  const { source } = await setup(t, fixture(), { enabled: false });
  assert.equal(source, null);
});
test("foreign endpoint cannot receive the bundled authorization", async (t) => {
  const c = fixture();
  c.countries[0].topUrl = c.countries[0].topUrl.replace(
    "webcast16-normal-useast5.tiktokv.us",
    "example.com",
  );
  const { source } = await setup(t, c);
  assert.ok(source);
  assert.equal((await source.status(scope)).state, "invalid");
  await assert.rejects(
    () => source.resolveMobileAuthorization(scope),
    (e) => !String(e).includes(TOKEN),
  );
});
test("invalid ciphertext is reported without key or payload leakage", async (t) => {
  const { source, dir } = await setup(t);
  assert.ok(source);
  await writeFile(
    path.join(dir, "providers", "tksoft-original.Core.dll"),
    Buffer.alloc(64, 7),
  );
  const broken = await moduleResult.createOriginalCoreConfigStore({
    dataDirectory: dir,
    passphraseReader: async () => Buffer.from(PASSWORD),
  });
  assert.equal((await broken.status(scope)).state, "invalid");
  assert.ok(!JSON.stringify(await broken.status(scope)).includes(TOKEN));
});
test("explicit clear disables the original source and prevents future authorization leases", async (t) => {
  const { source } = await setup(t);
  assert.ok(source);
  await source.clearMobileAuthorization();
  assert.equal(
    (await source.status(scope)).mobileAuthorization.state,
    "missing",
  );
  assert.equal(
    (await source.resolveMobileAuthorization(scope)).status,
    "missing",
  );
});

test("original broad membership arrays retain display variant country selection", async (t) => {
  const c = fixture();
  const v = {
    ...c.countries[0],
    countryCode: "CCA",
    displayName: "CCA(白俄罗斯-日榜)",
    IncludeCode: ["AM,AZ,BY,GE,KG,KZ,MD,TJ,TM,UA,UZ"],
    topCode: 2,
  };
  v.topUrl = v.topUrl.replace("rank_type=0", "rank_type=8");
  v.historyRankURL = v.topUrl.replace("gap_interval=0", "gap_interval=-1");
  c.countries = [v];
  const { source } = await setup(t, c);
  assert.equal(
    (await source.status({ marketRegion: "CCA", countryCode: "BY" })).state,
    "ready",
  );
  assert.ok(
    source.profileFor({
      marketRegion: "CCA",
      countryCode: "BY",
      displayName: v.displayName,
    }),
  );
  assert.equal(
    source.profileFor({
      marketRegion: "CCA",
      countryCode: "AZ",
      displayName: v.displayName,
    }),
    null,
  );
});
test("refresh downloads only the fixed public bundle without login and validates before replacement", async (t) => {
  const { dir } = await setup(t);
  assert.equal(
    typeof moduleResult.refreshOriginalCoreConfiguration,
    "function",
  );
  let calls = 0;
  const r = await moduleResult.refreshOriginalCoreConfiguration({
    dataDirectory: dir,
    passphraseReader: async () => Buffer.from(PASSWORD),
    fetchImpl: async (url, o) => {
      calls++;
      assert.equal(url, "https://www.tiktokzb.com/Core/Core.dll");
      assert.equal(o.method, "GET");
      assert.equal(o.redirect, "error");
      assert.equal(o.headers, undefined);
      return new Response(encrypt(fixture()), { status: 200 });
    },
  });
  assert.equal(calls, 1);
  assert.equal(r.state, "ready");
  assert.equal(r.sourceRecordCount, 1);
  assert.ok(!JSON.stringify(r).includes(TOKEN));
});
test("failed refresh preserves the last valid encrypted cache and reports no sensitive diagnostics", async (t) => {
  const { dir } = await setup(t);
  assert.equal(
    typeof moduleResult.refreshOriginalCoreConfiguration,
    "function",
  );
  await assert.rejects(
    () =>
      moduleResult.refreshOriginalCoreConfiguration({
        dataDirectory: dir,
        passphraseReader: async () => Buffer.from(PASSWORD),
        fetchImpl: async () =>
          new Response(Buffer.alloc(64, 7), { status: 200 }),
      }),
    (e) => !String(e).includes(TOKEN),
  );
  const source = await moduleResult.createOriginalCoreConfigStore({
    dataDirectory: dir,
    passphraseReader: async () => Buffer.from(PASSWORD),
  });
  assert.equal((await source.status(scope)).mobileAuthorization.state, "ready");
});
