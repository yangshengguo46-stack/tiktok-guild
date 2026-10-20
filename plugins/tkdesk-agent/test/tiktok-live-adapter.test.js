import assert from "node:assert/strict";
import test from "node:test";
import {
  collectTikTokLive,
  isAllowedTikTokDiscoveryUrl,
  normalizeTikTokLiveLinks,
  sanitizeTikTokText,
  sanitizeTikTokUrl,
  sanitizeTikTokValue
} from "../mcp/adapters/tiktok-live.js";

test("TikTok discovery allowlist rejects lookalike hosts", () => {
  assert.equal(isAllowedTikTokDiscoveryUrl("https://www.tiktok.com/live"), true);
  assert.equal(isAllowedTikTokDiscoveryUrl("https://live-backstage.tiktok.com/portal"), false);
  assert.equal(isAllowedTikTokDiscoveryUrl("https://tiktok.com.example.org/live"), false);
  assert.equal(isAllowedTikTokDiscoveryUrl("http://www.tiktok.com/live"), false);
});

test("normalizes live creator links and deduplicates handles", () => {
  const observedAt = "2026-08-22T00:00:00.000Z";
  const rows = normalizeTikTokLiveLinks([
    { href: "https://www.tiktok.com/@Alice/live", text: "Alice · LIVE · 1.2K viewers" },
    { href: "https://www.tiktok.com/@alice/live", text: "Alice · LIVE" },
    { href: "https://www.tiktok.com/@not-live", text: "ordinary profile" },
    { href: "https://evil.example/@mallory/live", text: "LIVE" }
  ], observedAt);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].handle, "Alice");
  assert.equal(rows[0].viewerCount, 1_200);
  assert.equal(rows[0].source, "tiktok_live");
  assert.equal(rows[0].observedAt, observedAt);
});

test("redacts complete Bearer credentials with case and whitespace variants", () => {
  const exposed = [
    sanitizeTikTokText("Authorization: Bearer FIRST_BEARER_SECRET"),
    sanitizeTikTokText("authorization :   bearer SECOND_BEARER_SECRET"),
    sanitizeTikTokText("BEARER THIRD_BEARER_SECRET")
  ].join("\n");
  assert.doesNotMatch(exposed, /FIRST_BEARER_SECRET|SECOND_BEARER_SECRET|THIRD_BEARER_SECRET/);
  assert.match(exposed, /\[REDACTED\]/);
});

test("URL sanitizer preserves safe profile and ordinary paths but redacts sensitive path segments", () => {
  assert.equal(
    sanitizeTikTokUrl("https://www.tiktok.com/@alice/live?token=query-secret#cookie=hash-secret"),
    "https://www.tiktok.com/@alice/live"
  );
  assert.equal(
    sanitizeTikTokUrl("https://id.example/public/docs/v1?token=query-secret"),
    "https://id.example/public/docs/v1"
  );
  assert.equal(
    sanitizeTikTokUrl("https://id.example/users/owner@example.com"),
    "https://id.example/users/_redacted_"
  );
  assert.equal(
    sanitizeTikTokUrl("https://id.example/callback/token/CALLBACK_PATH_SECRET"),
    "https://id.example/callback/_redacted_"
  );
  assert.doesNotMatch(
    JSON.stringify([
      sanitizeTikTokValue({ redirectUrl: "https://id.example/users/owner@example.com" }),
      sanitizeTikTokValue({ redirectUrl: "https://id.example/callback/token/CALLBACK_PATH_SECRET" })
    ]),
    /owner@example\.com|CALLBACK_PATH_SECRET/
  );
});

test("successful discovery strips URL secrets from progress, candidates, and evidence", async () => {
  const pageUrl = "https://www.tiktok.com/live?access_token=PAGE_SECRET&email=owner@example.com&query=QUERY_SECRET#hash=HASH_SECRET";
  const candidateUrl = "https://www.tiktok.com/@alice/live?token=CARD_SECRET&cookie=COOKIE_SECRET#password=PASSWORD_SECRET";
  const progress = [];
  const batches = [];
  const page = {
    url: () => pageUrl,
    waitForTimeout: async () => {},
    evaluate: async () => {},
    goto: async () => {},
    locator: (selector) => selector === "body"
      ? { innerText: async () => "" }
      : {
          evaluateAll: async () => [{
            href: candidateUrl,
            text: "Alice · LIVE · 10 viewers email=card@example.com cookie=TEXT_COOKIE_SECRET",
            displayName: "card@example.com"
          }]
        }
  };

  const result = await collectTikTokLive({
    page,
    startUrl: pageUrl,
    maxCandidates: 1,
    maxScrolls: 1,
    onProgress: (event) => progress.push(event),
    onBatch: (batch) => batches.push(...batch)
  });

  assert.equal(progress[0].url, "https://www.tiktok.com/live");
  assert.equal(batches[0].sourceUrl, "https://www.tiktok.com/@alice/live");
  assert.equal(batches[0].rawEvidence.href, "https://www.tiktok.com/@alice/live");
  assert.equal(batches[0].profileUrl, "https://www.tiktok.com/@alice");
  assert.equal(result.candidates[0].profileUrl, "https://www.tiktok.com/@alice");

  const fallback = sanitizeTikTokValue({
    accessToken: "KEY_TOKEN_SECRET",
    email: "key@example.com",
    cookie: "KEY_COOKIE_SECRET",
    query: "KEY_QUERY_SECRET",
    hash: "KEY_HASH_SECRET",
    nested: { password: "KEY_PASSWORD_SECRET" },
    datasetHash: "safe-dataset-hash"
  });
  assert.equal(fallback.accessToken, "[REDACTED]");
  assert.equal(fallback.email, "[REDACTED]");
  assert.equal(fallback.cookie, "[REDACTED]");
  assert.equal(fallback.query, "[REDACTED]");
  assert.equal(fallback.hash, "[REDACTED]");
  assert.equal(fallback.nested.password, "[REDACTED]");
  assert.equal(fallback.datasetHash, "safe-dataset-hash");

  const exposed = JSON.stringify({ progress, batches, result, fallback });
  assert.doesNotMatch(exposed, /PAGE_SECRET|CARD_SECRET|COOKIE_SECRET|PASSWORD_SECRET|QUERY_SECRET|HASH_SECRET|owner@example\.com|card@example\.com|key@example\.com|[?#]/i);
});

test("navigation errors expose only sanitized messages, details, and stacks", async () => {
  const startUrl = "https://www.tiktok.com/live?access_token=START_SECRET#hash=START_HASH_SECRET";
  let navigatedTo = null;
  const page = {
    url: () => "about:blank",
    goto: async (url) => {
      navigatedTo = url;
      const error = new Error("Navigation failed for https://www.tiktok.com/live?access_token=NAV_SECRET#email=owner@example.com Authorization : Bearer NAV_BEARER_SECRET");
      error.details = {
        redirectUrl: "https://www.tiktok.com/callback?token=DETAIL_SECRET#cookie=DETAIL_COOKIE_SECRET",
        password: "DETAIL_PASSWORD_SECRET",
        query: "DETAIL_QUERY_SECRET",
        hash: "DETAIL_HASH_SECRET"
      };
      throw error;
    }
  };

  await assert.rejects(
    collectTikTokLive({ page, startUrl, maxScrolls: 1 }),
    (error) => {
      assert.equal(navigatedTo, "https://www.tiktok.com/live");
      assert.equal(error.name, "TikTokLiveError");
      assert.equal(error.details.redirectUrl, "https://www.tiktok.com/callback");
      assert.equal(error.details.password, "[REDACTED]");
      assert.equal(error.details.query, "[REDACTED]");
      assert.equal(error.details.hash, "[REDACTED]");
      const exposed = JSON.stringify({ message: error.message, details: error.details, stack: error.stack });
      assert.doesNotMatch(exposed, /START_SECRET|START_HASH_SECRET|NAV_SECRET|NAV_BEARER_SECRET|owner@example\.com|DETAIL_SECRET|DETAIL_COOKIE_SECRET|DETAIL_PASSWORD_SECRET|DETAIL_QUERY_SECRET|DETAIL_HASH_SECRET|[?#]/i);
      return true;
    }
  );
});
