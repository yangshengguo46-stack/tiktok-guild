import crypto from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  COLLECTION_PROXY_LANE_COUNT,
  COLLECTION_PROXY_LANE_MODE_COUNTRY,
  COLLECTION_PROXY_LANE_MODE_LEGACY_AMBIGUOUS,
  normalizeCollectionLanes,
  normalizeCountryCode,
  normalizeProxyServer
} from "./route-policy.js";

const TERMINAL_RUN_STATUSES = new Set(["completed", "partial", "failed", "cancelled"]);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 2_000;
const QUALIFICATION_HOURLY_WINDOW_MS = 60 * 60 * 1_000;
const QUALIFICATION_DAILY_WINDOW_MS = 24 * QUALIFICATION_HOURLY_WINDOW_MS;
const QUALIFICATION_HOURLY_HARD_LIMIT = 55;
const QUALIFICATION_DAILY_HARD_LIMIT = 150;
const QUALIFICATION_ATTEMPTS_SQL = `
  SELECT attempted_at, minimum_spacing_seconds FROM qualification_batches
  UNION ALL
  SELECT occurred_at AS attempted_at,
    CAST(json_extract(details_json, '$.minimumSpacingSeconds') AS INTEGER) AS minimum_spacing_seconds
  FROM audit_events WHERE action = 'startup_qualification_attempt'
`;
export const ORIGINAL_FEED_SEED_DEDUPE_SECONDS = 300;
export const ORIGINAL_RANKING_SEED_DEDUPE_SECONDS = 600;
export const ORIGINAL_RANKING_DEFAULT_COUNTDOWN_SECONDS = 180;
export const COLLECTION_CLEANUP_SCOPE_VERSION = "tkdesk.collection-cleanup.v1";
const ORIGINAL_SEED_KINDS = new Set(["feed", "ranking"]);
const CLEANUP_RUN_STATUSES = new Set(["completed", "partial", "failed", "cancelled"]);
const CLEANUP_QUALIFICATION_SAFETY_WINDOW_MS = 24 * 60 * 60 * 1_000;

const MIGRATIONS = [
  {
    version: 1,
    name: "initial_agent_store",
    sql: `
      CREATE TABLE sessions (
        session_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        profile_path TEXT,
        status TEXT NOT NULL DEFAULT 'logged_out',
        login_url TEXT,
        current_url TEXT,
        authenticated_at TEXT,
        last_checked_at TEXT,
        error_json TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE collection_runs (
        run_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'semi_auto',
        source TEXT NOT NULL DEFAULT 'tiktok',
        status TEXT NOT NULL DEFAULT 'queued',
        filters_json TEXT,
        config_json TEXT,
        progress_json TEXT,
        expected_count INTEGER,
        received_count INTEGER NOT NULL DEFAULT 0,
        new_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        error_json TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        CHECK (expected_count IS NULL OR expected_count >= 0),
        CHECK (received_count >= 0),
        CHECK (new_count >= 0),
        CHECK (duplicate_count >= 0)
      ) STRICT;

      CREATE TABLE checkpoints (
        run_id TEXT NOT NULL REFERENCES collection_runs(run_id) ON DELETE CASCADE,
        adapter TEXT NOT NULL DEFAULT 'default',
        checkpoint_key TEXT NOT NULL,
        value_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, adapter, checkpoint_key)
      ) STRICT;

      CREATE TABLE prospects (
        candidate_id TEXT PRIMARY KEY,
        identity_key TEXT NOT NULL UNIQUE,
        user_id TEXT UNIQUE,
        sec_uid TEXT UNIQUE,
        handle TEXT,
        handle_normalized TEXT UNIQUE,
        display_name TEXT,
        region TEXT,
        follower_count INTEGER,
        is_live INTEGER,
        is_seller INTEGER,
        is_high_quality INTEGER,
        invitation_eligibility TEXT,
        rank TEXT,
        room_id TEXT,
        profile_url TEXT,
        latest_source TEXT,
        data_json TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (follower_count IS NULL OR follower_count >= 0),
        CHECK (is_live IS NULL OR is_live IN (0, 1)),
        CHECK (is_seller IS NULL OR is_seller IN (0, 1)),
        CHECK (is_high_quality IS NULL OR is_high_quality IN (0, 1))
      ) STRICT;

      CREATE TABLE prospect_observations (
        observation_id TEXT PRIMARY KEY,
        observation_key TEXT NOT NULL UNIQUE,
        prospect_id TEXT NOT NULL REFERENCES prospects(candidate_id) ON DELETE CASCADE,
        run_id TEXT REFERENCES collection_runs(run_id) ON DELETE SET NULL,
        source TEXT NOT NULL,
        source_url TEXT,
        observed_at TEXT NOT NULL,
        region TEXT,
        follower_count INTEGER,
        is_live INTEGER,
        is_seller INTEGER,
        is_high_quality INTEGER,
        invitation_eligibility TEXT,
        rank TEXT,
        room_id TEXT,
        confidence REAL,
        data_json TEXT,
        evidence_json TEXT,
        created_at TEXT NOT NULL,
        CHECK (follower_count IS NULL OR follower_count >= 0),
        CHECK (is_live IS NULL OR is_live IN (0, 1)),
        CHECK (is_seller IS NULL OR is_seller IN (0, 1)),
        CHECK (is_high_quality IS NULL OR is_high_quality IN (0, 1)),
        CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0))
      ) STRICT;

      CREATE TABLE handoff_batches (
        batch_id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        run_id TEXT REFERENCES collection_runs(run_id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'pending_review',
        purpose TEXT,
        criteria_json TEXT,
        payload_json TEXT,
        candidate_count INTEGER NOT NULL DEFAULT 0,
        approved_by TEXT,
        approved_at TEXT,
        dispatched_at TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (candidate_count >= 0)
      ) STRICT;

      CREATE TABLE outbox (
        outbox_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        locked_at TEXT,
        delivered_at TEXT,
        last_error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (attempts >= 0)
      ) STRICT;

      CREATE TABLE audit_events (
        audit_id TEXT PRIMARY KEY,
        actor TEXT NOT NULL DEFAULT 'system',
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        run_id TEXT REFERENCES collection_runs(run_id) ON DELETE SET NULL,
        outcome TEXT NOT NULL DEFAULT 'success',
        details_json TEXT,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX idx_sessions_kind_status ON sessions(kind, status);
      CREATE INDEX idx_runs_status_created ON collection_runs(status, created_at DESC);
      CREATE INDEX idx_runs_source_mode ON collection_runs(source, mode, created_at DESC);
      CREATE INDEX idx_prospects_region_followers ON prospects(region, follower_count);
      CREATE INDEX idx_prospects_latest_source_seen ON prospects(latest_source, last_seen_at DESC);
      CREATE INDEX idx_observations_run_seen ON prospect_observations(run_id, observed_at DESC);
      CREATE INDEX idx_observations_prospect_seen ON prospect_observations(prospect_id, observed_at DESC, observation_id DESC);
      CREATE INDEX idx_observations_source_seen ON prospect_observations(source, observed_at DESC);
      CREATE INDEX idx_handoffs_status_created ON handoff_batches(status, created_at);
      CREATE INDEX idx_outbox_pending ON outbox(status, available_at, created_at);
      CREATE INDEX idx_audit_run_time ON audit_events(run_id, occurred_at DESC);
      CREATE INDEX idx_audit_target_time ON audit_events(target_type, target_id, occurred_at DESC);
    `
  },
  {
    version: 2,
    name: "full_auto_routes_and_qualification_budget",
    sql: `
      ALTER TABLE prospects ADD COLUMN market_region TEXT;
      ALTER TABLE prospects ADD COLUMN creator_country_code TEXT;
      ALTER TABLE prospect_observations ADD COLUMN market_region TEXT;
      ALTER TABLE prospect_observations ADD COLUMN creator_country_code TEXT;

      CREATE TABLE collection_routes (
        route_profile_id TEXT PRIMARY KEY,
        market_region TEXT NOT NULL,
        route_country TEXT NOT NULL,
        backstage_country TEXT NOT NULL,
        market_countries_json TEXT NOT NULL,
        proxy_server TEXT NOT NULL,
        proxy_fingerprint TEXT NOT NULL,
        proxy_exit_country TEXT,
        verification_status TEXT NOT NULL DEFAULT 'unverified',
        verification_json TEXT,
        verified_at TEXT,
        active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (active IN (0, 1))
      ) STRICT;

      CREATE UNIQUE INDEX idx_collection_routes_single_active
        ON collection_routes(active) WHERE active = 1;

      CREATE TABLE qualification_batches (
        batch_id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES collection_runs(run_id) ON DELETE SET NULL,
        candidate_count INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'reserved',
        hourly_limit INTEGER NOT NULL,
        daily_limit INTEGER NOT NULL,
        hourly_used_before INTEGER NOT NULL,
        daily_used_before INTEGER NOT NULL,
        minimum_spacing_seconds INTEGER NOT NULL DEFAULT 0,
        attempted_at TEXT NOT NULL,
        finished_at TEXT,
        error_code TEXT,
        details_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (candidate_count BETWEEN 1 AND 30),
        CHECK (hourly_limit BETWEEN 1 AND 60),
        CHECK (daily_limit BETWEEN 1 AND 300),
        CHECK (hourly_used_before >= 0),
        CHECK (daily_used_before >= 0),
        CHECK (minimum_spacing_seconds >= 0)
      ) STRICT;

      CREATE TABLE qualification_batch_items (
        batch_id TEXT NOT NULL REFERENCES qualification_batches(batch_id) ON DELETE CASCADE,
        candidate_id TEXT NOT NULL REFERENCES prospects(candidate_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        result_status TEXT,
        PRIMARY KEY (batch_id, candidate_id),
        UNIQUE (batch_id, ordinal),
        CHECK (ordinal >= 0)
      ) STRICT;

      CREATE TABLE qualification_policy_state (
        state_key TEXT PRIMARY KEY,
        hourly_target INTEGER NOT NULL,
        daily_target INTEGER NOT NULL,
        epoch_started_at TEXT NOT NULL,
        epoch_ends_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (state_key = 'global'),
        CHECK (hourly_target BETWEEN 1 AND 55),
        CHECK (daily_target BETWEEN 1 AND 150)
      ) STRICT;

      CREATE INDEX idx_qualification_batches_attempted
        ON qualification_batches(attempted_at DESC, batch_id);
      CREATE INDEX idx_qualification_batches_run_attempted
        ON qualification_batches(run_id, attempted_at DESC, batch_id);
      CREATE INDEX idx_qualification_items_candidate
        ON qualification_batch_items(candidate_id, batch_id);
      CREATE INDEX idx_prospects_market_country
        ON prospects(market_region, creator_country_code, last_seen_at DESC);
      CREATE INDEX idx_observations_market_country
        ON prospect_observations(market_region, creator_country_code, observed_at DESC);
    `
  },
  {
    version: 3,
    name: "preserve_qualification_items_across_prospect_merges",
    sql: `
      DROP INDEX idx_qualification_items_candidate;

      ALTER TABLE qualification_batch_items RENAME TO qualification_batch_items_v2;

      CREATE TABLE qualification_batch_items (
        batch_id TEXT NOT NULL REFERENCES qualification_batches(batch_id) ON DELETE CASCADE,
        candidate_id TEXT NOT NULL REFERENCES prospects(candidate_id) ON DELETE CASCADE,
        requested_candidate_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        result_status TEXT,
        PRIMARY KEY (batch_id, ordinal),
        UNIQUE (batch_id, requested_candidate_id),
        CHECK (ordinal >= 0)
      ) STRICT;

      INSERT INTO qualification_batch_items(
        batch_id, candidate_id, requested_candidate_id, ordinal, result_status
      )
      SELECT batch_id, candidate_id, candidate_id, ordinal, result_status
      FROM qualification_batch_items_v2;

      DROP TABLE qualification_batch_items_v2;

      CREATE INDEX idx_qualification_items_candidate
        ON qualification_batch_items(candidate_id, batch_id);
      CREATE INDEX idx_qualification_items_requested_candidate
        ON qualification_batch_items(requested_candidate_id, batch_id);
    `
  },
  {
    version: 4,
    name: "split_discovery_and_collection_routes",
    sql: `
      ALTER TABLE collection_routes RENAME TO collection_routes_v3;
      DROP INDEX idx_collection_routes_single_active;

      CREATE TABLE collection_routes (
        route_profile_id TEXT PRIMARY KEY,
        market_region TEXT NOT NULL,
        discovery_country TEXT NOT NULL,
        discovery_proxy_server TEXT NOT NULL,
        route_country TEXT NOT NULL,
        backstage_country TEXT NOT NULL,
        market_countries_json TEXT NOT NULL,
        collection_proxy_server TEXT NOT NULL,
        proxy_server TEXT NOT NULL,
        proxy_fingerprint TEXT NOT NULL,
        discovery_proxy_exit_country TEXT,
        proxy_exit_country TEXT,
        verification_status TEXT NOT NULL DEFAULT 'unverified',
        verification_json TEXT,
        verified_at TEXT,
        active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (active IN (0, 1)),
        CHECK (proxy_server = collection_proxy_server)
      ) STRICT;

      INSERT INTO collection_routes(
        route_profile_id, market_region, discovery_country, discovery_proxy_server,
        route_country, backstage_country, market_countries_json,
        collection_proxy_server, proxy_server, proxy_fingerprint,
        discovery_proxy_exit_country, proxy_exit_country,
        verification_status, verification_json, verified_at, active,
        created_at, updated_at
      )
      SELECT
        route_profile_id, market_region, route_country, proxy_server,
        route_country, backstage_country, market_countries_json,
        proxy_server, proxy_server, proxy_fingerprint,
        NULL, NULL,
        'unverified', verification_json, NULL, 0,
        created_at, updated_at
      FROM collection_routes_v3;

      DROP TABLE collection_routes_v3;

      CREATE UNIQUE INDEX idx_collection_routes_single_active
        ON collection_routes(active) WHERE active = 1;
      CREATE INDEX idx_collection_routes_discovery_country
        ON collection_routes(discovery_country, updated_at DESC);
    `
  },
  {
    version: 5,
    name: "add_exact_three_collection_proxy_lanes",
    sql: `
      ALTER TABLE collection_routes RENAME TO collection_routes_v4;
      DROP INDEX idx_collection_routes_single_active;
      DROP INDEX idx_collection_routes_discovery_country;

      CREATE TABLE collection_routes (
        route_profile_id TEXT PRIMARY KEY,
        market_region TEXT NOT NULL,
        discovery_country TEXT NOT NULL,
        discovery_proxy_server TEXT NOT NULL,
        route_country TEXT NOT NULL,
        backstage_country TEXT NOT NULL,
        market_countries_json TEXT NOT NULL,
        collection_proxy_server TEXT NOT NULL,
        collection_proxy_servers_json TEXT NOT NULL,
        collection_proxy_lane_mode TEXT NOT NULL,
        proxy_server TEXT NOT NULL,
        proxy_fingerprint TEXT NOT NULL,
        discovery_proxy_exit_country TEXT,
        collection_proxy_exit_countries_json TEXT NOT NULL,
        proxy_exit_country TEXT,
        verification_status TEXT NOT NULL DEFAULT 'unverified',
        verification_json TEXT,
        verified_at TEXT,
        active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (active IN (0, 1)),
        CHECK (proxy_server = collection_proxy_server),
        CHECK (json_valid(collection_proxy_servers_json)),
        CHECK (json_type(collection_proxy_servers_json) = 'array'),
        CHECK (json_array_length(collection_proxy_servers_json) IN (1, 3)),
        CHECK (json_valid(collection_proxy_exit_countries_json)),
        CHECK (json_type(collection_proxy_exit_countries_json) = 'array'),
        CHECK (json_array_length(collection_proxy_exit_countries_json) IN (0, 1, 3)),
        CHECK (collection_proxy_lane_mode IN ('exact_three_lane', 'degraded_single_lane')),
        CHECK (
          (collection_proxy_lane_mode = 'exact_three_lane'
            AND json_array_length(collection_proxy_servers_json) = 3
            AND json_array_length(collection_proxy_exit_countries_json) IN (0, 3))
          OR
          (collection_proxy_lane_mode = 'degraded_single_lane'
            AND json_array_length(collection_proxy_servers_json) = 1
            AND json_array_length(collection_proxy_exit_countries_json) IN (0, 1))
        )
      ) STRICT;

      INSERT INTO collection_routes(
        route_profile_id, market_region, discovery_country, discovery_proxy_server,
        route_country, backstage_country, market_countries_json,
        collection_proxy_server, collection_proxy_servers_json,
        collection_proxy_lane_mode, proxy_server, proxy_fingerprint,
        discovery_proxy_exit_country, collection_proxy_exit_countries_json,
        proxy_exit_country,
        verification_status, verification_json, verified_at, active,
        created_at, updated_at
      )
      SELECT
        route_profile_id, market_region, discovery_country, discovery_proxy_server,
        route_country, backstage_country, market_countries_json,
        collection_proxy_server, json_array(collection_proxy_server),
        'degraded_single_lane', proxy_server, proxy_fingerprint,
        discovery_proxy_exit_country,
        CASE WHEN proxy_exit_country IS NULL THEN '[]' ELSE json_array(proxy_exit_country) END,
        proxy_exit_country,
        'unverified', verification_json, NULL, 0,
        created_at, updated_at
      FROM collection_routes_v4;

      DROP TABLE collection_routes_v4;

      CREATE UNIQUE INDEX idx_collection_routes_single_active
        ON collection_routes(active) WHERE active = 1;
      CREATE INDEX idx_collection_routes_discovery_country
        ON collection_routes(discovery_country, updated_at DESC);
    `
  },
  {
    version: 6,
    name: "invalidate_degraded_single_lane_verification",
    sql: `
      UPDATE collection_routes
      SET verification_status = 'unverified',
          verified_at = NULL,
          active = 0
      WHERE collection_proxy_lane_mode = 'degraded_single_lane';
    `
  },
  {
    version: 7,
    name: "map_one_proxy_to_each_collection_country",
    sql: `
      ALTER TABLE collection_routes RENAME TO collection_routes_v6;
      DROP INDEX idx_collection_routes_single_active;
      DROP INDEX idx_collection_routes_discovery_country;

      CREATE TABLE collection_routes (
        route_profile_id TEXT PRIMARY KEY,
        market_region TEXT NOT NULL,
        discovery_country TEXT NOT NULL,
        discovery_proxy_server TEXT NOT NULL,
        route_country TEXT NOT NULL,
        backstage_country TEXT NOT NULL,
        market_countries_json TEXT NOT NULL,
        collection_country_codes_json TEXT NOT NULL,
        collection_proxy_server TEXT NOT NULL,
        collection_proxy_servers_json TEXT NOT NULL,
        collection_proxy_lane_mode TEXT NOT NULL,
        proxy_server TEXT NOT NULL,
        proxy_fingerprint TEXT NOT NULL,
        discovery_proxy_exit_country TEXT,
        collection_proxy_exit_countries_json TEXT NOT NULL,
        proxy_exit_country TEXT,
        verification_status TEXT NOT NULL DEFAULT 'unverified',
        verification_json TEXT,
        verified_at TEXT,
        active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (active IN (0, 1)),
        CHECK (proxy_server = collection_proxy_server),
        CHECK (json_valid(market_countries_json)),
        CHECK (json_type(market_countries_json) = 'array'),
        CHECK (json_valid(collection_country_codes_json)),
        CHECK (json_type(collection_country_codes_json) = 'array'),
        CHECK (json_array_length(collection_country_codes_json) BETWEEN 0 AND 3),
        CHECK (json_valid(collection_proxy_servers_json)),
        CHECK (json_type(collection_proxy_servers_json) = 'array'),
        CHECK (json_array_length(collection_proxy_servers_json) BETWEEN 1 AND 3),
        CHECK (json_valid(collection_proxy_exit_countries_json)),
        CHECK (json_type(collection_proxy_exit_countries_json) = 'array'),
        CHECK (
          json_array_length(collection_proxy_exit_countries_json) = 0
          OR json_array_length(collection_proxy_exit_countries_json)
            = json_array_length(collection_proxy_servers_json)
        ),
        CHECK (collection_proxy_lane_mode IN ('country_lanes', 'legacy_ambiguous_v5')),
        CHECK (
          (collection_proxy_lane_mode = 'country_lanes'
            AND json_array_length(collection_country_codes_json)
              = json_array_length(collection_proxy_servers_json))
          OR
          (collection_proxy_lane_mode = 'legacy_ambiguous_v5'
            AND json_array_length(collection_proxy_servers_json) = 3
            AND json_array_length(collection_country_codes_json) = 0)
        )
      ) STRICT;

      INSERT INTO collection_routes(
        route_profile_id, market_region, discovery_country, discovery_proxy_server,
        route_country, backstage_country, market_countries_json,
        collection_country_codes_json,
        collection_proxy_server, collection_proxy_servers_json,
        collection_proxy_lane_mode, proxy_server, proxy_fingerprint,
        discovery_proxy_exit_country, collection_proxy_exit_countries_json,
        proxy_exit_country,
        verification_status, verification_json, verified_at, active,
        created_at, updated_at
      )
      SELECT
        route_profile_id, market_region, discovery_country, discovery_proxy_server,
        route_country, backstage_country, market_countries_json,
        CASE
          WHEN json_array_length(collection_proxy_servers_json) = 1
          THEN json_array(route_country)
          ELSE '[]'
        END,
        collection_proxy_server, collection_proxy_servers_json,
        CASE
          WHEN json_array_length(collection_proxy_servers_json) = 1
          THEN 'country_lanes'
          ELSE 'legacy_ambiguous_v5'
        END,
        proxy_server, proxy_fingerprint,
        discovery_proxy_exit_country, collection_proxy_exit_countries_json,
        proxy_exit_country,
        'unverified', verification_json, NULL, 0,
        created_at, updated_at
      FROM collection_routes_v6;

      DROP TABLE collection_routes_v6;

      CREATE UNIQUE INDEX idx_collection_routes_single_active
        ON collection_routes(active) WHERE active = 1;
      CREATE INDEX idx_collection_routes_discovery_country
        ON collection_routes(discovery_country, updated_at DESC);
    `
  },
  {
    version: 8,
    name: "durable_original_discovery_seed_queue",
    sql: `
      CREATE TABLE IF NOT EXISTS discovery_seed_queue (
        queue_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES collection_runs(run_id) ON DELETE CASCADE,
        seed_kind TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        due_at TEXT NOT NULL,
        dedupe_until TEXT NOT NULL,
        claim_token TEXT,
        claimed_at TEXT,
        lease_expires_at TEXT,
        completed_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        result_json TEXT,
        last_error_json TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (run_id, seed_kind, identity_key),
        CHECK (seed_kind IN ('feed', 'ranking')),
        CHECK (status IN ('pending', 'processing', 'completed', 'skipped', 'failed')),
        CHECK (attempt_count >= 0),
        CHECK (json_valid(payload_json)),
        CHECK (result_json IS NULL OR json_valid(result_json)),
        CHECK (last_error_json IS NULL OR json_valid(last_error_json))
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_discovery_seed_queue_due
        ON discovery_seed_queue(run_id, seed_kind, status, due_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_discovery_seed_queue_lease
        ON discovery_seed_queue(status, lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_discovery_seed_queue_dedupe
        ON discovery_seed_queue(run_id, seed_kind, identity_key, dedupe_until);
    `
  }
];

function asText(value, maxLength = 2_000) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function asNonNegativeInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : null;
}

function asPositiveInteger(value) {
  const number = asNonNegativeInteger(value);
  return number !== null && number > 0 ? number : null;
}

function asIsoTimestamp(value, fieldName = "timestamp") {
  const text = asText(value, 80);
  if (!text) throw new TypeError(`${fieldName} is required`);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${fieldName} must be a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

function normalizedTextList(value, {
  fieldName,
  itemLength = 80,
  uppercase = false,
  sort = true
} = {}) {
  if (!Array.isArray(value)) throw new TypeError(`${fieldName ?? "value"} must be an array`);
  const items = value.map((item) => {
    const text = asText(item, itemLength);
    if (!text) throw new TypeError(`${fieldName ?? "value"} must not contain empty values`);
    return uppercase ? text.toUpperCase() : text;
  });
  const unique = [...new Set(items)];
  return sort ? unique.sort() : unique;
}

function databasePolicyError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function collectionLaneConfiguration(input, existing, routeProfileId) {
  const explicitLegacyProxy = input.proxyServer === undefined || input.proxyServer === null
    ? null
    : normalizeProxyServer(input.proxyServer, "proxyServer");
  const explicitCollectionProxy = input.collectionProxyServer === undefined
    || input.collectionProxyServer === null
    ? null
    : normalizeProxyServer(input.collectionProxyServer, "collectionProxyServer");
  if (explicitLegacyProxy && explicitCollectionProxy
    && explicitLegacyProxy !== explicitCollectionProxy) {
    throw databasePolicyError(
      "COLLECTION_PROXY_ALIAS_MISMATCH",
      "proxyServer must match collectionProxyServer when both are supplied",
      { routeProfileId }
    );
  }
  const explicitAlias = explicitCollectionProxy ?? explicitLegacyProxy;
  const explicitRouteCountry = input.routeCountry === undefined || input.routeCountry === null
    ? null
    : normalizeCountryCode(input.routeCountry, "routeCountry");
  const explicitBackstageCountry = input.backstageCountry === undefined
    || input.backstageCountry === null
    ? null
    : normalizeCountryCode(input.backstageCountry, "backstageCountry");
  if (explicitRouteCountry && explicitBackstageCountry
    && explicitRouteCountry !== explicitBackstageCountry) {
    throw databasePolicyError(
      "COLLECTION_COUNTRY_ALIAS_MISMATCH",
      "routeCountry and backstageCountry are compatibility aliases for collectionLanes[0]",
      { routeProfileId, routeCountry: explicitRouteCountry, backstageCountry: explicitBackstageCountry }
    );
  }
  const explicitCountryAlias = explicitRouteCountry ?? explicitBackstageCountry;
  const hasExplicitLanes = input.collectionLanes !== undefined
    && input.collectionLanes !== null;
  const hasExplicitProxyServers = input.collectionProxyServers !== undefined
    && input.collectionProxyServers !== null;
  const hasExplicitCountryCodes = input.collectionCountryCodes !== undefined
    && input.collectionCountryCodes !== null;

  let collectionLanes;
  if (hasExplicitLanes) {
    collectionLanes = normalizeCollectionLanes(input.collectionLanes);
  } else if (hasExplicitProxyServers || hasExplicitCountryCodes) {
    const proxyServers = hasExplicitProxyServers
      ? input.collectionProxyServers
      : existing?.collectionProxyServers;
    if (!Array.isArray(proxyServers)
      || proxyServers.length < 1
      || proxyServers.length > COLLECTION_PROXY_LANE_COUNT) {
      throw databasePolicyError(
        "COLLECTION_PROXY_LANE_COUNT_INVALID",
        `collectionProxyServers must contain between 1 and ${COLLECTION_PROXY_LANE_COUNT} proxy URLs`,
        {
          routeProfileId,
          laneCount: Array.isArray(proxyServers)
            ? proxyServers.length
            : null
        }
      );
    }
    let countries = hasExplicitCountryCodes
      ? input.collectionCountryCodes
      : existing?.collectionCountryCodes;
    if (countries === undefined || countries === null) {
      if (proxyServers.length !== 1) {
        throw databasePolicyError(
          "COLLECTION_LANE_COUNTRIES_REQUIRED",
          "legacy multi-proxy input is ambiguous; supply collectionLanes with one country per proxy",
          { routeProfileId, laneCount: proxyServers.length }
        );
      }
      countries = [explicitCountryAlias ?? existing?.routeCountry];
    }
    if (!Array.isArray(countries) || countries.length !== proxyServers.length) {
      throw databasePolicyError(
        "COLLECTION_COUNTRY_COUNT_INVALID",
        "collectionCountryCodes must match collectionProxyServers by index",
        { routeProfileId }
      );
    }
    collectionLanes = normalizeCollectionLanes(proxyServers.map(
      (proxyServer, index) => ({ countryCode: countries[index], proxyServer })
    ));
  } else if (existing) {
    if (existing.migrationRequired || !existing.collectionLanes?.length) {
      throw databasePolicyError(
        "COLLECTION_LANE_MIGRATION_REQUIRED",
        "legacy ambiguous three-slot routes require an explicit country for every preserved endpoint",
        { routeProfileId }
      );
    }
    if (existing.collectionLanes.length === 1) {
      collectionLanes = normalizeCollectionLanes([{
        countryCode: explicitCountryAlias ?? existing.collectionLanes[0].countryCode,
        proxyServer: explicitAlias ?? existing.collectionLanes[0].proxyServer
      }]);
    } else {
      collectionLanes = normalizeCollectionLanes(existing.collectionLanes);
    }
  } else {
    const proxyServer = explicitAlias;
    const countryCode = explicitCountryAlias;
    if (!proxyServer || !countryCode) {
      throw databasePolicyError(
        "COLLECTION_LANES_REQUIRED",
        "collectionLanes is required",
        { routeProfileId }
      );
    }
    collectionLanes = normalizeCollectionLanes([{ countryCode, proxyServer }]);
  }

  const collectionProxyServers = collectionLanes.map((lane) => lane.proxyServer);
  const collectionCountryCodes = collectionLanes.map((lane) => lane.countryCode);
  const collectionProxyServer = collectionProxyServers[0];
  if (explicitAlias && explicitAlias !== collectionProxyServer) {
    throw databasePolicyError(
      "COLLECTION_PROXY_ALIAS_MISMATCH",
      "collectionProxyServer and proxyServer are compatibility aliases for collectionLanes[0]",
      { routeProfileId }
    );
  }
  if (explicitCountryAlias && explicitCountryAlias !== collectionCountryCodes[0]) {
    throw databasePolicyError(
      "COLLECTION_COUNTRY_ALIAS_MISMATCH",
      "routeCountry and backstageCountry are compatibility aliases for collectionLanes[0]",
      {
        routeProfileId,
        aliasCountry: explicitCountryAlias,
        firstLaneCountry: collectionCountryCodes[0]
      }
    );
  }
  return {
    collectionProxyServer,
    collectionProxyServers,
    collectionCountryCodes,
    collectionLanes,
    collectionProxyLaneMode: COLLECTION_PROXY_LANE_MODE_COUNTRY
  };
}

function normalizedCollectionProxyExitCountries(value, {
  expectedCount,
  routeProfileId,
  allowEmpty = true
}) {
  if (!Array.isArray(value)) {
    throw databasePolicyError(
      "COLLECTION_PROXY_EXIT_COUNTRIES_INVALID",
      "collectionProxyExitCountries must be an array",
      { routeProfileId }
    );
  }
  if (!(allowEmpty && value.length === 0) && value.length !== expectedCount) {
    throw databasePolicyError(
      "COLLECTION_PROXY_EXIT_COUNTRY_COUNT_INVALID",
      `collectionProxyExitCountries must contain exactly ${expectedCount} country codes`,
      { routeProfileId, laneCount: value.length }
    );
  }
  return value.map((countryCode, index) => (
    normalizeCountryCode(countryCode, `collectionProxyExitCountries[${index}]`)
  ));
}

function asNullableBoolean(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") {
    if (/^(true|1|yes|是)$/i.test(value.trim())) return 1;
    if (/^(false|0|no|否)$/i.test(value.trim())) return 0;
    return null;
  }
  return value ? 1 : 0;
}

function asConfidence(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(1, Math.max(0, number));
}

function json(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parseJson(value) {
  if (value === undefined || value === null || value === "") return null;
  try { return JSON.parse(value); } catch { return null; }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function normalizeHandle(value) {
  const text = asText(value, 128);
  return text ? text.normalize("NFKC").replace(/^@+/, "").toLocaleLowerCase("en-US") : null;
}

function buildIdentity(input) {
  const userId = asText(input.userId ?? input.user_id ?? input.tiktokUserId, 256);
  const secUid = asText(input.secUid ?? input.sec_uid, 512);
  const handle = asText(input.handle ?? input.uniqueId ?? input.username, 256);
  const handleNormalized = normalizeHandle(handle);
  if (userId) return { identityKey: `user_id:${userId}`, userId, secUid, handle, handleNormalized };
  if (secUid) return { identityKey: `sec_uid:${secUid}`, userId, secUid, handle, handleNormalized };
  if (handleNormalized) return { identityKey: `handle:${handleNormalized}`, userId, secUid, handle, handleNormalized };
  throw new TypeError("prospect requires userId, secUid, or handle");
}

function finiteLimit(value, fallback = DEFAULT_LIMIT) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(number))) : fallback;
}

function finiteOffset(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function sessionFromRow(row) {
  if (!row) return null;
  return {
    sessionKey: row.session_key,
    kind: row.kind,
    profilePath: row.profile_path,
    status: row.status,
    loginUrl: row.login_url,
    currentUrl: row.current_url,
    authenticatedAt: row.authenticated_at,
    lastCheckedAt: row.last_checked_at,
    error: parseJson(row.error_json),
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function runFromRow(row) {
  if (!row) return null;
  return {
    runId: row.run_id,
    mode: row.mode,
    source: row.source,
    status: row.status,
    filters: parseJson(row.filters_json),
    config: parseJson(row.config_json),
    progress: parseJson(row.progress_json),
    expected: row.expected_count,
    received: row.received_count,
    new: row.new_count,
    duplicate: row.duplicate_count,
    error: parseJson(row.error_json),
    result: parseJson(row.result_json),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at
  };
}

function observationFromRow(row) {
  if (!row) return null;
  return {
    observationId: row.observation_id,
    observationKey: row.observation_key,
    candidateId: row.prospect_id,
    runId: row.run_id,
    source: row.source,
    sourceUrl: row.source_url,
    observedAt: row.observed_at,
    region: row.region,
    marketRegion: row.market_region ?? null,
    creatorCountryCode: row.creator_country_code ?? null,
    followers: row.follower_count,
    live: row.is_live === null ? null : Boolean(row.is_live),
    seller: row.is_seller === null ? null : Boolean(row.is_seller),
    highQuality: row.is_high_quality === null ? null : Boolean(row.is_high_quality),
    invitationEligibility: row.invitation_eligibility,
    rank: row.rank,
    roomId: row.room_id,
    confidence: row.confidence,
    data: parseJson(row.data_json),
    evidence: parseJson(row.evidence_json),
    createdAt: row.created_at
  };
}

function prospectFromRow(
  row,
  latestDiscoveryObservation = undefined,
  latestQualificationObservation = undefined
) {
  if (!row) return null;
  const result = {
    candidateId: row.candidate_id,
    identityKey: row.identity_key,
    userId: row.user_id,
    secUid: row.sec_uid,
    handle: row.handle,
    displayName: row.display_name,
    region: row.region,
    marketRegion: row.market_region ?? null,
    creatorCountryCode: row.creator_country_code ?? null,
    followers: row.follower_count,
    live: row.is_live === null ? null : Boolean(row.is_live),
    seller: row.is_seller === null ? null : Boolean(row.is_seller),
    highQuality: row.is_high_quality === null ? null : Boolean(row.is_high_quality),
    invitationEligibility: row.invitation_eligibility,
    rank: row.rank,
    roomId: row.room_id,
    profileUrl: row.profile_url,
    latestSource: row.latest_source,
    data: parseJson(row.data_json),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (latestDiscoveryObservation !== undefined) {
    // Backward-compatible alias: latestObservation continues to mean the
    // latest discovery/source observation, never a later qualification check.
    result.latestObservation = latestDiscoveryObservation;
    result.latestDiscoveryObservation = latestDiscoveryObservation;
  }
  if (latestQualificationObservation !== undefined) {
    result.latestQualificationObservation = latestQualificationObservation;
  }
  return result;
}

function routeFromRow(row) {
  if (!row) return null;
  const collectionProxyServer = row.collection_proxy_server ?? row.proxy_server;
  const storedProxyServers = parseJson(row.collection_proxy_servers_json);
  const collectionProxyServers = Array.isArray(storedProxyServers)
    && storedProxyServers.length > 0
    ? storedProxyServers
    : [collectionProxyServer];
  const storedCollectionCountries = parseJson(row.collection_country_codes_json);
  const collectionCountryCodes = Array.isArray(storedCollectionCountries)
    ? storedCollectionCountries
    : [];
  const collectionProxyLaneMode = row.collection_proxy_lane_mode
    ?? COLLECTION_PROXY_LANE_MODE_LEGACY_AMBIGUOUS;
  const migrationRequired = collectionProxyLaneMode === COLLECTION_PROXY_LANE_MODE_LEGACY_AMBIGUOUS
    || collectionCountryCodes.length !== collectionProxyServers.length;
  const collectionLanes = migrationRequired
    ? []
    : collectionProxyServers.map((proxyServer, index) => ({
      workId: index + 1,
      countryCode: collectionCountryCodes[index],
      proxyServer
    }));
  const storedProxyExitCountries = parseJson(row.collection_proxy_exit_countries_json);
  const collectionProxyExitCountries = Array.isArray(storedProxyExitCountries)
    ? storedProxyExitCountries
    : (row.proxy_exit_country ? [row.proxy_exit_country] : []);
  const routeFingerprint = row.proxy_fingerprint;
  return {
    routeProfileId: row.route_profile_id,
    marketRegion: row.market_region,
    discoveryCountry: row.discovery_country,
    discoveryProxyServer: row.discovery_proxy_server,
    routeCountry: row.route_country,
    backstageCountry: row.backstage_country,
    marketCountryCodes: parseJson(row.market_countries_json) ?? [],
    collectionCountryCodes,
    collectionLanes,
    collectionProxyServer,
    collectionProxyServers,
    collectionProxyLaneMode,
    collectionProxyLaneCount: collectionProxyServers.length,
    collectionProxyExitCountries,
    proxyServer: collectionProxyServer,
    routeFingerprint,
    proxyFingerprint: routeFingerprint,
    discoveryProxyExitCountry: row.discovery_proxy_exit_country,
    proxyExitCountry: row.proxy_exit_country,
    verificationStatus: row.verification_status,
    verification: parseJson(row.verification_json),
    verifiedAt: row.verified_at,
    migrationRequired,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function qualificationBatchFromRow(row, items = undefined) {
  if (!row) return null;
  const result = {
    batchId: row.batch_id,
    runId: row.run_id,
    candidateCount: row.candidate_count,
    status: row.status,
    hourlyLimit: row.hourly_limit,
    dailyLimit: row.daily_limit,
    hourlyUsedBefore: row.hourly_used_before,
    dailyUsedBefore: row.daily_used_before,
    minimumSpacingSeconds: row.minimum_spacing_seconds,
    attemptedAt: row.attempted_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
    details: parseJson(row.details_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (items !== undefined) {
    result.items = items;
    result.candidateIds = items.map((item) => item.candidateId);
    result.requestedCandidateIds = items.map((item) => item.requestedCandidateId);
  }
  return result;
}

function qualificationPolicyStateFromRow(row, at = undefined) {
  if (!row) return null;
  const result = {
    hourlyTarget: row.hourly_target,
    dailyTarget: row.daily_target,
    epochStartedAt: row.epoch_started_at,
    epochEndsAt: row.epoch_ends_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (at !== undefined) {
    const atMs = Date.parse(at);
    result.active = atMs >= Date.parse(result.epochStartedAt) && atMs < Date.parse(result.epochEndsAt);
  }
  return result;
}

function handoffFromRow(row) {
  if (!row) return null;
  return {
    batchId: row.batch_id,
    idempotencyKey: row.idempotency_key,
    runId: row.run_id,
    status: row.status,
    purpose: row.purpose,
    criteria: parseJson(row.criteria_json),
    payload: parseJson(row.payload_json),
    candidateCount: row.candidate_count,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    dispatchedAt: row.dispatched_at,
    error: parseJson(row.error_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function outboxFromRow(row) {
  if (!row) return null;
  return {
    outboxId: row.outbox_id,
    idempotencyKey: row.idempotency_key,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: parseJson(row.payload_json),
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    lockedAt: row.locked_at,
    deliveredAt: row.delivered_at,
    lastError: parseJson(row.last_error_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function discoverySeedFromRow(row) {
  if (!row) return null;
  return {
    queueId: row.queue_id,
    runId: row.run_id,
    seedKind: row.seed_kind,
    identityKey: row.identity_key,
    payload: parseJson(row.payload_json) ?? {},
    status: row.status,
    dueAt: row.due_at,
    dedupeUntil: row.dedupe_until,
    claimToken: row.claim_token,
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    completedAt: row.completed_at,
    attemptCount: row.attempt_count,
    result: parseJson(row.result_json),
    lastError: parseJson(row.last_error_json),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeOriginalSeedKind(value) {
  const seedKind = asText(value, 32)?.toLowerCase() ?? null;
  if (!ORIGINAL_SEED_KINDS.has(seedKind)) {
    throw new TypeError("seedKind must be feed or ranking");
  }
  return seedKind;
}

function timestampPlusSeconds(timestamp, seconds) {
  return new Date(Date.parse(timestamp) + seconds * 1_000).toISOString();
}

function originalSeedTiming(seedKind, { at, countdownSeconds = null, rankingTiming = null } = {}) {
  if (seedKind === "feed") {
    return {
      dueAt: at,
      dedupeUntil: timestampPlusSeconds(at, ORIGINAL_FEED_SEED_DEDUPE_SECONDS)
    };
  }
  const parsedCountdown = Number(countdownSeconds);
  const countdown = Number.isFinite(parsedCountdown) && parsedCountdown > 0
    ? Math.max(1, Math.trunc(parsedCountdown))
    : ORIGINAL_RANKING_DEFAULT_COUNTDOWN_SECONDS;
  if (rankingTiming === "eligibility_ttl_v1") {
    // 9.9 LiveProcessor SetNX Ranking:%s stores an immediately scannable
    // value with countdown as its TTL. Keep the existing local 600s minimum
    // duplicate fence; a longer league period extends that fence, not dueAt.
    return { dueAt: at, dedupeUntil: timestampPlusSeconds(at, Math.max(countdown, ORIGINAL_RANKING_SEED_DEDUPE_SECONDS)) };
  }
  return {
    dueAt: timestampPlusSeconds(at, countdown),
    dedupeUntil: timestampPlusSeconds(at, ORIGINAL_RANKING_SEED_DEDUPE_SECONDS)
  };
}

function originalSourceQueueClause(sourceKind, params) {
  if (!["original_pc_web_feed", "original_mobile_processor_fixed_country_lists"].includes(sourceKind)) {
    throw new TypeError("unknown original discovery source kind");
  }
  params.push(sourceKind);
  const matches = "EXISTS (SELECT 1 FROM json_each(payload_json, '$.discoverySourceKinds') WHERE value = ?)";
  // Older pending Feed checkpoints predate explicit source provenance.
  return sourceKind === "original_pc_web_feed"
    ? `(${matches} OR COALESCE(json_array_length(payload_json, '$.discoverySourceKinds'), 0) = 0)`
    : matches;
}

function auditFromRow(row) {
  if (!row) return null;
  return {
    auditId: row.audit_id,
    actor: row.actor,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    runId: row.run_id,
    outcome: row.outcome,
    details: parseJson(row.details_json),
    occurredAt: row.occurred_at,
    createdAt: row.created_at
  };
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function collectionCleanupPreviewFromPlan(plan) {
  return {
    scopeVersion: COLLECTION_CLEANUP_SCOPE_VERSION,
    cutoff: plan.cutoff,
    previewHash: plan.previewHash,
    deleteCounts: { ...plan.deleteCounts },
    protectedCounts: { ...plan.protectedCounts },
    protections: {
      auditEvents: true,
      committedHandoffs: true,
      outbox: true,
      sessionsAndLoginMaterials: true,
      collectionRoutesAndConfiguration: true,
      qualificationRollingBudgetWindow: true
    },
    recoverability: {
      recoverable: false,
      backupCreated: false,
      state: "irreversible_without_external_backup",
      preservedArtifacts: ["audit_events", "committed_handoffs", "outbox"]
    }
  };
}

function collectionCleanupPlan(database, cutoff, now) {
  const cutoffMs = Date.parse(cutoff);
  const nowMs = Date.parse(now);
  if (cutoffMs > nowMs) throw new TypeError("cleanup cutoff must not be in the future");

  const runRows = database.prepare(`
    SELECT run_id, status, created_at, updated_at, finished_at
    FROM collection_runs WHERE created_at < ?
    ORDER BY run_id
  `).all(cutoff);
  const runIds = sortedUnique(runRows
    .filter((row) => (
      CLEANUP_RUN_STATUSES.has(row.status)
        && Date.parse(row.finished_at ?? row.updated_at ?? row.created_at) < cutoffMs
    ))
    .map((row) => row.run_id));
  const runIdSet = new Set(runIds);

  const checkpointRows = database.prepare(`
    SELECT run_id, adapter, checkpoint_key FROM checkpoints ORDER BY run_id, adapter, checkpoint_key
  `).all().filter((row) => runIdSet.has(row.run_id));
  const queueRows = database.prepare(`
    SELECT queue_id, run_id FROM discovery_seed_queue ORDER BY queue_id
  `).all().filter((row) => runIdSet.has(row.run_id));

  const observationRows = database.prepare(`
    SELECT observation_id, prospect_id, run_id, observed_at
    FROM prospect_observations WHERE observed_at < ? ORDER BY observation_id
  `).all(cutoff).filter((row) => row.run_id === null || runIdSet.has(row.run_id));
  const observationIds = sortedUnique(observationRows.map((row) => row.observation_id));
  const observationIdSet = new Set(observationIds);

  const qualificationSafetyCutoff = new Date(Math.min(
    cutoffMs,
    nowMs - CLEANUP_QUALIFICATION_SAFETY_WINDOW_MS
  )).toISOString();
  const allOldQualificationRows = database.prepare(`
    SELECT batch_id, run_id, status, attempted_at
    FROM qualification_batches WHERE attempted_at < ? ORDER BY batch_id
  `).all(cutoff).filter((row) => row.run_id === null || runIdSet.has(row.run_id));
  const qualificationRows = allOldQualificationRows.filter((row) => (
    row.status !== "reserved" && row.attempted_at < qualificationSafetyCutoff
  ));
  const qualificationBatchIds = sortedUnique(qualificationRows.map((row) => row.batch_id));
  const qualificationBatchIdSet = new Set(qualificationBatchIds);
  const qualificationItemRows = database.prepare(`
    SELECT batch_id, ordinal, candidate_id FROM qualification_batch_items
    ORDER BY batch_id, ordinal
  `).all();
  const qualificationItemKeys = qualificationItemRows
    .filter((row) => qualificationBatchIdSet.has(row.batch_id))
    .map((row) => `${row.batch_id}:${row.ordinal}`);

  const outboxHandoffIds = new Set(database.prepare(`
    SELECT aggregate_id FROM outbox WHERE aggregate_type = 'handoff_batch'
  `).all().map((row) => row.aggregate_id));
  const handoffRows = database.prepare(`
    SELECT batch_id, run_id, status, payload_json, approved_at, dispatched_at, created_at
    FROM handoff_batches ORDER BY batch_id
  `).all();
  const pendingHandoffIds = sortedUnique(handoffRows.filter((row) => (
    row.status === "pending_review"
      && row.approved_at === null
      && row.dispatched_at === null
      && row.created_at < cutoff
      && !outboxHandoffIds.has(row.batch_id)
      && (row.run_id === null || runIdSet.has(row.run_id))
  )).map((row) => row.batch_id));
  const pendingHandoffIdSet = new Set(pendingHandoffIds);
  const protectedHandoffCandidateIds = new Set();
  for (const row of handoffRows) {
    if (pendingHandoffIdSet.has(row.batch_id)) continue;
    const payload = parseJson(row.payload_json);
    for (const candidate of Array.isArray(payload?.candidates) ? payload.candidates : []) {
      const candidateId = asText(candidate?.candidateId, 256);
      if (candidateId) protectedHandoffCandidateIds.add(candidateId);
    }
  }

  const remainingObservationCandidateIds = new Set(database.prepare(`
    SELECT observation_id, prospect_id FROM prospect_observations
  `).all().filter((row) => !observationIdSet.has(row.observation_id)).map((row) => row.prospect_id));
  const remainingQualificationCandidateIds = new Set(qualificationItemRows
    .filter((row) => !qualificationBatchIdSet.has(row.batch_id))
    .map((row) => row.candidate_id));
  const prospectIds = sortedUnique(database.prepare(`
    SELECT candidate_id FROM prospects WHERE last_seen_at < ? ORDER BY candidate_id
  `).all(cutoff).map((row) => row.candidate_id).filter((candidateId) => (
    !remainingObservationCandidateIds.has(candidateId)
      && !remainingQualificationCandidateIds.has(candidateId)
      && !protectedHandoffCandidateIds.has(candidateId)
  )));

  const deletionKeys = {
    collectionRuns: runIds,
    checkpoints: checkpointRows.map(
      (row) => `${row.run_id}:${row.adapter}:${row.checkpoint_key}`
    ),
    discoverySeedQueue: queueRows.map((row) => row.queue_id),
    prospectObservations: observationIds,
    qualificationBatches: qualificationBatchIds,
    qualificationBatchItems: qualificationItemKeys,
    handoffBatches: pendingHandoffIds,
    prospects: prospectIds
  };
  const previewHash = crypto.createHash("sha256").update(stableJson({
    scopeVersion: COLLECTION_CLEANUP_SCOPE_VERSION,
    cutoff,
    deletionKeys
  })).digest("hex");
  const committedHandoffCount = handoffRows.filter((row) => (
    row.status === "approved"
      || row.approved_at !== null
      || row.dispatched_at !== null
      || outboxHandoffIds.has(row.batch_id)
  )).length;
  const deleteCounts = {
    sessions: 0,
    collectionRuns: runIds.length,
    checkpoints: checkpointRows.length,
    prospects: prospectIds.length,
    prospectObservations: observationIds.length,
    handoffBatches: pendingHandoffIds.length,
    outbox: 0,
    auditEvents: 0,
    collectionRoutes: 0,
    qualificationBatches: qualificationBatchIds.length,
    qualificationBatchItems: qualificationItemKeys.length,
    qualificationPolicyState: 0,
    discoverySeedQueue: queueRows.length
  };
  return {
    cutoff,
    previewHash,
    deletionKeys,
    deleteCounts,
    protectedCounts: {
      auditEvents: database.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count,
      committedHandoffs: committedHandoffCount,
      handoffBatches: handoffRows.length - pendingHandoffIds.length,
      outbox: database.prepare("SELECT COUNT(*) AS count FROM outbox").get().count,
      sessions: database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count,
      collectionRoutes: database.prepare("SELECT COUNT(*) AS count FROM collection_routes").get().count,
      qualificationPolicyState: database.prepare("SELECT COUNT(*) AS count FROM qualification_policy_state").get().count,
      nonterminalOrRecentlyFinishedRuns: runRows.length - runIds.length,
      qualificationBatchesInRollingWindowOrReserved:
        allOldQualificationRows.length - qualificationBatchIds.length
    }
  };
}

function deleteByIds(database, table, column, values) {
  let deleted = 0;
  for (let index = 0; index < values.length; index += 400) {
    const chunk = values.slice(index, index + 400);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    deleted += Number(database.prepare(
      `DELETE FROM ${table} WHERE ${column} IN (${placeholders})`
    ).run(...chunk).changes ?? 0);
  }
  return deleted;
}

export class DatabaseStore {
  #transactionDepth = 0;
  constructor(databasePath, { clock = () => new Date(), idFactory = () => crypto.randomUUID() } = {}) {
    if (!databasePath) throw new TypeError("databasePath is required");
    this.databasePath = databasePath;
    this.clock = clock;
    this.idFactory = idFactory;
    this.database = null;
  }

  now() {
    const value = this.clock();
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  init() {
    if (this.database) return this;
    if (this.databasePath !== ":memory:") mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (this.databasePath !== ":memory:") {
      this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 1000;");
      try { chmodSync(this.databasePath, 0o600); } catch { /* best-effort for non-POSIX filesystems */ }
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const applied = new Set(this.database.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.database.exec(migration.sql);
        this.database.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, this.now());
        this.database.exec(`PRAGMA user_version = ${migration.version}`);
      });
    }
    return this;
  }

  close() {
    if (!this.database) return;
    this.database.close();
    this.database = null;
  }

  transaction(callback) {
    if (!this.database) throw new Error("database is not initialized");
    const savepoint = this.#transactionDepth > 0 ? `tkdesk_nested_${this.#transactionDepth}` : null;
    this.database.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.#transactionDepth += 1;
    try {
      const value = callback();
      if (value && typeof value.then === "function") throw new TypeError("database transactions must be synchronous");
      this.database.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
      return value;
    } catch (error) {
      try {
        this.database.exec(savepoint ? `ROLLBACK TO SAVEPOINT ${savepoint}` : "ROLLBACK");
        if (savepoint) this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } catch { /* retain the original error */ }
      throw error;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  upsertSession(input) {
    const sessionKey = asText(input.sessionKey ?? input.key, 256);
    if (!sessionKey) throw new TypeError("sessionKey is required");
    const now = this.now();
    const existing = this.getSession(sessionKey);
    const kind = asText(input.kind ?? existing?.kind, 80);
    if (!kind) throw new TypeError("session kind is required");
    this.database.prepare(`
      INSERT INTO sessions(
        session_key, kind, profile_path, status, login_url, current_url,
        authenticated_at, last_checked_at, error_json, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        kind = excluded.kind,
        profile_path = COALESCE(excluded.profile_path, sessions.profile_path),
        status = excluded.status,
        login_url = excluded.login_url,
        current_url = excluded.current_url,
        authenticated_at = excluded.authenticated_at,
        last_checked_at = COALESCE(excluded.last_checked_at, sessions.last_checked_at),
        error_json = excluded.error_json,
        metadata_json = COALESCE(excluded.metadata_json, sessions.metadata_json),
        updated_at = excluded.updated_at
    `).run(
      sessionKey,
      kind,
      asText(input.profilePath ?? existing?.profilePath, 2_000),
      asText(input.status ?? existing?.status ?? "logged_out", 80),
      asText(Object.hasOwn(input, "loginUrl") ? input.loginUrl : existing?.loginUrl, 4_000),
      asText(Object.hasOwn(input, "currentUrl") ? input.currentUrl : existing?.currentUrl, 4_000),
      asText(Object.hasOwn(input, "authenticatedAt") ? input.authenticatedAt : existing?.authenticatedAt, 80),
      asText(input.lastCheckedAt ?? existing?.lastCheckedAt, 80),
      json(input.error),
      input.metadata === undefined ? json(existing?.metadata) : json(input.metadata),
      existing?.createdAt ?? now,
      now
    );
    return this.getSession(sessionKey);
  }

  setSessionStatus(sessionKey, status, patch = {}) {
    const existing = this.getSession(sessionKey);
    if (!existing) throw new Error(`session not found: ${sessionKey}`);
    return this.upsertSession({ ...existing, ...patch, sessionKey, status });
  }

  getSession(sessionKey) {
    return sessionFromRow(this.database.prepare("SELECT * FROM sessions WHERE session_key = ?").get(sessionKey));
  }

  listSessions({ kind, status, limit = DEFAULT_LIMIT, offset = 0 } = {}) {
    const clauses = [];
    const params = [];
    if (kind) { clauses.push("kind = ?"); params.push(kind); }
    if (status) { clauses.push("status = ?"); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database.prepare(`SELECT * FROM sessions ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, finiteLimit(limit), finiteOffset(offset)).map(sessionFromRow);
  }

  createRun(input = {}) {
    const now = this.now();
    const runId = asText(input.runId, 256) ?? this.idFactory();
    this.database.prepare(`
      INSERT INTO collection_runs(
        run_id, mode, source, status, filters_json, config_json, progress_json,
        expected_count, received_count, new_count, duplicate_count, error_json,
        result_json, created_at, started_at, finished_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      asText(input.mode, 80) ?? "semi_auto",
      asText(input.source, 160) ?? "tiktok",
      asText(input.status, 80) ?? "queued",
      json(input.filters ?? {}),
      json(input.config ?? {}),
      json(input.progress),
      asNonNegativeInteger(input.expected ?? input.expectedCount),
      asNonNegativeInteger(input.received ?? input.receivedCount) ?? 0,
      asNonNegativeInteger(input.new ?? input.newCount) ?? 0,
      asNonNegativeInteger(input.duplicate ?? input.duplicateCount) ?? 0,
      json(input.error),
      json(input.result),
      asText(input.createdAt, 80) ?? now,
      asText(input.startedAt, 80),
      asText(input.finishedAt, 80),
      now
    );
    return this.getRun(runId);
  }

  #updateRun(runId, patch = {}) {
    const existing = this.getRun(runId);
    if (!existing) throw new Error(`collection run not found: ${runId}`);
    const status = asText(patch.status ?? existing.status, 80);
    const now = this.now();
    const startedAt = patch.startedAt !== undefined
      ? asText(patch.startedAt, 80)
      : (existing.startedAt ?? (status !== "queued" ? now : null));
    const finishedAt = patch.finishedAt !== undefined
      ? asText(patch.finishedAt, 80)
      : (existing.finishedAt ?? (TERMINAL_RUN_STATUSES.has(status) ? now : null));
    this.database.prepare(`
      UPDATE collection_runs SET
        mode = ?, source = ?, status = ?, filters_json = ?, config_json = ?, progress_json = ?,
        expected_count = ?, received_count = ?, new_count = ?, duplicate_count = ?,
        error_json = ?, result_json = ?, started_at = ?, finished_at = ?, updated_at = ?
      WHERE run_id = ?
    `).run(
      asText(patch.mode ?? existing.mode, 80),
      asText(patch.source ?? existing.source, 160),
      status,
      patch.filters === undefined ? json(existing.filters) : json(patch.filters),
      patch.config === undefined ? json(existing.config) : json(patch.config),
      patch.progress === undefined ? json(existing.progress) : json(patch.progress),
      patch.expected === undefined && patch.expectedCount === undefined ? existing.expected : asNonNegativeInteger(patch.expected ?? patch.expectedCount),
      patch.received === undefined && patch.receivedCount === undefined ? existing.received : asNonNegativeInteger(patch.received ?? patch.receivedCount) ?? 0,
      patch.new === undefined && patch.newCount === undefined ? existing.new : asNonNegativeInteger(patch.new ?? patch.newCount) ?? 0,
      patch.duplicate === undefined && patch.duplicateCount === undefined ? existing.duplicate : asNonNegativeInteger(patch.duplicate ?? patch.duplicateCount) ?? 0,
      patch.error === undefined ? json(existing.error) : json(patch.error),
      patch.result === undefined ? json(existing.result) : json(patch.result),
      startedAt,
      finishedAt,
      now,
      runId
    );
    return this.getRun(runId);
  }

  updateRun(runId, patch = {}) {
    return this.#updateRun(runId, patch);
  }

  getRun(runId) {
    return runFromRow(this.database.prepare("SELECT * FROM collection_runs WHERE run_id = ?").get(runId));
  }

  listRuns({ status, mode, source, limit = DEFAULT_LIMIT, offset = 0 } = {}) {
    const clauses = [];
    const params = [];
    if (status) { clauses.push("status = ?"); params.push(status); }
    if (mode) { clauses.push("mode = ?"); params.push(mode); }
    if (source) { clauses.push("source = ?"); params.push(source); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database.prepare(`SELECT * FROM collection_runs ${where} ORDER BY created_at DESC, run_id DESC LIMIT ? OFFSET ?`)
      .all(...params, finiteLimit(limit), finiteOffset(offset)).map(runFromRow);
  }

  saveCheckpoint(runId, checkpointKey, value, { adapter = "default" } = {}) {
    if (!this.getRun(runId)) throw new Error(`collection run not found: ${runId}`);
    const key = asText(checkpointKey, 256);
    if (!key) throw new TypeError("checkpointKey is required");
    const adapterName = asText(adapter, 160) ?? "default";
    const now = this.now();
    this.database.prepare(`
      INSERT INTO checkpoints(run_id, adapter, checkpoint_key, value_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id, adapter, checkpoint_key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(runId, adapterName, key, json(value), now);
    return this.getCheckpoint(runId, key, { adapter: adapterName });
  }

  getCheckpoint(runId, checkpointKey, { adapter = "default" } = {}) {
    const row = this.database.prepare(`
      SELECT * FROM checkpoints WHERE run_id = ? AND adapter = ? AND checkpoint_key = ?
    `).get(runId, adapter, checkpointKey);
    return row ? { runId: row.run_id, adapter: row.adapter, checkpointKey: row.checkpoint_key, value: parseJson(row.value_json), updatedAt: row.updated_at } : null;
  }

  listCheckpoints(runId) {
    return this.database.prepare("SELECT * FROM checkpoints WHERE run_id = ? ORDER BY adapter, checkpoint_key")
      .all(runId).map((row) => ({ runId: row.run_id, adapter: row.adapter, checkpointKey: row.checkpoint_key, value: parseJson(row.value_json), updatedAt: row.updated_at }));
  }

  enqueueOriginalDiscoverySeed(input = {}) {
    const runId = asText(input.runId, 256);
    if (!runId || !this.getRun(runId)) throw new Error(`collection run not found: ${runId}`);
    const seedKind = normalizeOriginalSeedKind(input.seedKind);
    const identityKey = asText(input.identityKey, 1_000);
    if (!identityKey) throw new TypeError("identityKey is required");
    const at = asIsoTimestamp(input.at ?? this.now(), "at");
    const timing = originalSeedTiming(seedKind, {
      at,
      countdownSeconds: input.countdownSeconds,
      rankingTiming: input.rankingTiming
    });
    const payload = input.payload && typeof input.payload === "object"
      ? input.payload
      : {};

    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT * FROM discovery_seed_queue
        WHERE run_id = ? AND seed_kind = ? AND identity_key = ?
      `).get(runId, seedKind, identityKey);
      const existing = discoverySeedFromRow(row);
      const leaseActive = existing?.status === "processing"
        && Number.isFinite(Date.parse(existing.leaseExpiresAt ?? ""))
        && Date.parse(existing.leaseExpiresAt) > Date.parse(at);
      if (existing && (Date.parse(existing.dedupeUntil) > Date.parse(at) || leaseActive)) {
        if (seedKind === "ranking" && input.rankingTiming === "eligibility_ttl_v1"
          && existing.status === "pending" && Date.parse(existing.dueAt) > Date.parse(at)) {
          // Only the native qualified-candidate seam selects this mode. Do
          // not wake paused runs, overwrite completed work, or steal claims.
          this.database.prepare(`UPDATE discovery_seed_queue
            SET due_at = ?, dedupe_until = ?, last_seen_at = ?, updated_at = ?
            WHERE queue_id = ? AND status = 'pending'`).run(at, timing.dedupeUntil, at, at, existing.queueId);
          return { accepted: false, duplicate: true, timingRepaired: true, seed: this.getDiscoverySeed(existing.queueId) };
        }
        // Independent PC and Mobile processors can encounter the same
        // DisplayID at different times. Merge only through an internal policy;
        // ordinary enqueue callers keep the original TTL-only behavior.
        if (typeof input.mergePayload === "function") {
          const merged = input.mergePayload(existing.payload, payload);
          if (merged && typeof merged === "object" && json(merged) !== json(existing.payload)) {
            const reopen = existing.status !== "processing" && existing.status !== "pending";
            this.database.prepare(`
              UPDATE discovery_seed_queue
              SET payload_json = ?, status = ?, due_at = ?, last_seen_at = ?, updated_at = ?,
                  completed_at = CASE WHEN ? THEN NULL ELSE completed_at END,
                  result_json = CASE WHEN ? THEN NULL ELSE result_json END,
                  last_error_json = CASE WHEN ? THEN NULL ELSE last_error_json END
              WHERE queue_id = ?
            `).run(json(merged), reopen ? "pending" : existing.status,
              reopen ? at : existing.dueAt, at, at, Number(reopen), Number(reopen), Number(reopen), existing.queueId);
            return { accepted: reopen, duplicate: !reopen, merged: true, seed: this.getDiscoverySeed(existing.queueId) };
          }
        }
        this.database.prepare(`
          UPDATE discovery_seed_queue
          SET last_seen_at = ?, updated_at = ?
          WHERE queue_id = ?
        `).run(at, at, existing.queueId);
        return {
          accepted: false,
          duplicate: true,
          seed: this.getDiscoverySeed(existing.queueId)
        };
      }

      if (existing) {
        this.database.prepare(`
          UPDATE discovery_seed_queue SET
            payload_json = ?, status = 'pending', due_at = ?, dedupe_until = ?,
            claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL,
            completed_at = NULL, attempt_count = 0, result_json = NULL,
            last_error_json = NULL, last_seen_at = ?, updated_at = ?
          WHERE queue_id = ?
        `).run(
          json(payload), timing.dueAt, timing.dedupeUntil,
          at, at, existing.queueId
        );
        return {
          accepted: true,
          duplicate: false,
          refreshed: true,
          seed: this.getDiscoverySeed(existing.queueId)
        };
      }

      const queueId = asText(input.queueId, 256) ?? this.idFactory();
      this.database.prepare(`
        INSERT INTO discovery_seed_queue(
          queue_id, run_id, seed_kind, identity_key, payload_json, status,
          due_at, dedupe_until, attempt_count, first_seen_at, last_seen_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?, ?, ?)
      `).run(
        queueId, runId, seedKind, identityKey, json(payload),
        timing.dueAt, timing.dedupeUntil, at, at, at, at
      );
      return {
        accepted: true,
        duplicate: false,
        refreshed: false,
        seed: this.getDiscoverySeed(queueId)
      };
    });
  }

  getDiscoverySeed(queueId) {
    return discoverySeedFromRow(
      this.database.prepare("SELECT * FROM discovery_seed_queue WHERE queue_id = ?")
        .get(queueId)
    );
  }

  listDiscoverySeeds({
    runId,
    seedKind = null,
    status = null,
    dueBefore = null,
    limit = DEFAULT_LIMIT,
    offset = 0
  } = {}) {
    const clauses = [];
    const params = [];
    if (runId) { clauses.push("run_id = ?"); params.push(runId); }
    if (seedKind) { clauses.push("seed_kind = ?"); params.push(normalizeOriginalSeedKind(seedKind)); }
    if (status) { clauses.push("status = ?"); params.push(asText(status, 32)); }
    if (dueBefore) { clauses.push("due_at <= ?"); params.push(asIsoTimestamp(dueBefore, "dueBefore")); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database.prepare(`
      SELECT * FROM discovery_seed_queue ${where}
      ORDER BY due_at, created_at, queue_id LIMIT ? OFFSET ?
    `).all(...params, finiteLimit(limit), finiteOffset(offset)).map(discoverySeedFromRow);
  }

  listActiveOriginalDiscoverySeeds({ runId, seedKind, countryCode, at = this.now() } = {}) {
    const timestamp = asIsoTimestamp(at, "at");
    const kind = normalizeOriginalSeedKind(seedKind);
    // No pagination: truncating active aliases would let a newer DisplayID
    // silently bypass the conflict guard. Expired rows do not block renames.
    return this.database.prepare(`
      SELECT * FROM discovery_seed_queue
      WHERE run_id = ? AND seed_kind = ?
        AND UPPER(json_extract(payload_json, '$.rankingScopeCountryCode')) = ?
        AND (dedupe_until > ? OR (status = 'processing' AND lease_expires_at > ?))
      ORDER BY created_at, queue_id
    `).all(runId, kind, String(countryCode).trim().toUpperCase(), timestamp, timestamp)
      .map(discoverySeedFromRow);
  }

  releaseRunDiscoverySeedLeases(runId, { at = this.now() } = {}) {
    const timestamp = asIsoTimestamp(at, "at");
    const result = this.database.prepare(`
      UPDATE discovery_seed_queue SET
        status = 'pending', claim_token = NULL, claimed_at = NULL,
        lease_expires_at = NULL, updated_at = ?
      WHERE run_id = ? AND status = 'processing'
    `).run(timestamp, runId);
    return Number(result.changes ?? 0);
  }

  claimDueOriginalDiscoverySeeds({
    runId,
    seedKind,
    at = this.now(),
    limit = DEFAULT_LIMIT,
    leaseSeconds = 300,
    preferredSourceKind = null,
    preferredCountryCodes = []
  } = {}) {
    if (!runId || !this.getRun(runId)) throw new Error(`collection run not found: ${runId}`);
    const kind = normalizeOriginalSeedKind(seedKind);
    const timestamp = asIsoTimestamp(at, "at");
    const lease = Math.min(3_600, Math.max(30, asPositiveInteger(leaseSeconds) ?? 300));
    const leaseExpiresAt = timestampPlusSeconds(timestamp, lease);
    const boundedLimit = finiteLimit(limit);
    const priorityParams = [];
    const sourceOrder = preferredSourceKind === null ? "" : `CASE WHEN ${originalSourceQueueClause(preferredSourceKind, priorityParams)} THEN 0 ELSE 1 END,`;
    if (!Array.isArray(preferredCountryCodes) || preferredCountryCodes.length > 3
      || preferredCountryCodes.some(code => !/^[A-Z]{2}$/.test(code))) {
      throw new TypeError("preferredCountryCodes must contain up to three country codes");
    }
    const countryOrder = preferredCountryCodes.length
      ? `CASE UPPER(json_extract(payload_json, '$.rankingScopeCountryCode')) ${preferredCountryCodes.map((code, index) => {
        priorityParams.push(code); return `WHEN ? THEN ${index}`;
      }).join(" ")} ELSE ${preferredCountryCodes.length} END,`
      : "";
    return this.transaction(() => {
      this.database.prepare(`
        UPDATE discovery_seed_queue SET
          status = 'pending', claim_token = NULL, claimed_at = NULL,
          lease_expires_at = NULL, updated_at = ?
        WHERE run_id = ? AND seed_kind = ? AND status = 'processing'
          AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
      `).run(timestamp, runId, kind, timestamp);
      const rows = this.database.prepare(`
        SELECT queue_id FROM discovery_seed_queue
        WHERE run_id = ? AND seed_kind = ? AND status = 'pending' AND due_at <= ?
        ORDER BY ${sourceOrder} ${countryOrder} due_at, created_at, queue_id LIMIT ?
      `).all(runId, kind, timestamp, ...priorityParams, boundedLimit);
      return rows.map(({ queue_id: queueId }) => {
        const claimToken = this.idFactory();
        const result = this.database.prepare(`
          UPDATE discovery_seed_queue SET
            status = 'processing', claim_token = ?, claimed_at = ?,
            lease_expires_at = ?, attempt_count = attempt_count + 1,
            updated_at = ?
          WHERE queue_id = ? AND status = 'pending'
        `).run(claimToken, timestamp, leaseExpiresAt, timestamp, queueId);
        return Number(result.changes ?? 0) === 1
          ? this.getDiscoverySeed(queueId)
          : null;
      }).filter(Boolean);
    });
  }

  completeOriginalDiscoverySeed(queueId, {
    claimToken,
    status = "completed",
    result = null,
    error = null,
    at = this.now()
  } = {}) {
    if (!["completed", "skipped", "failed"].includes(status)) {
      throw new TypeError("completed seed status must be completed, skipped, or failed");
    }
    const token = asText(claimToken, 256);
    if (!token) throw new TypeError("claimToken is required");
    const timestamp = asIsoTimestamp(at, "at");
    const changed = this.database.prepare(`
      UPDATE discovery_seed_queue SET
        status = ?, claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL,
        completed_at = ?, result_json = ?, last_error_json = ?, updated_at = ?
      WHERE queue_id = ? AND status = 'processing' AND claim_token = ?
    `).run(
      status, timestamp, json(result), json(error), timestamp, queueId, token
    );
    if (Number(changed.changes ?? 0) !== 1) {
      throw databasePolicyError(
        "DISCOVERY_SEED_CLAIM_STALE",
        "discovery seed claim is no longer active",
        { queueId }
      );
    }
    return this.getDiscoverySeed(queueId);
  }

  releaseOriginalDiscoverySeed(queueId, {
    claimToken,
    dueAt = null,
    error = null,
    at = this.now()
  } = {}) {
    const token = asText(claimToken, 256);
    if (!token) throw new TypeError("claimToken is required");
    const timestamp = asIsoTimestamp(at, "at");
    const nextDueAt = dueAt === null ? null : asIsoTimestamp(dueAt, "dueAt");
    const changed = this.database.prepare(`
      UPDATE discovery_seed_queue SET
        status = 'pending', due_at = COALESCE(?, due_at), claim_token = NULL,
        claimed_at = NULL, lease_expires_at = NULL, last_error_json = ?,
        updated_at = ?
      WHERE queue_id = ? AND status = 'processing' AND claim_token = ?
    `).run(nextDueAt, json(error), timestamp, queueId, token);
    if (Number(changed.changes ?? 0) !== 1) {
      throw databasePolicyError(
        "DISCOVERY_SEED_CLAIM_STALE",
        "discovery seed claim is no longer active",
        { queueId }
      );
    }
    return this.getDiscoverySeed(queueId);
  }

  originalDiscoveryQueueStatus(runId, { seedKind = null, sourceKind = null, at = this.now() } = {}) {
    const timestamp = asIsoTimestamp(at, "at");
    const params = [runId];
    const kindClause = seedKind ? " AND seed_kind = ?" : "";
    if (seedKind) params.push(normalizeOriginalSeedKind(seedKind));
    const sourceClause = sourceKind === null ? "" : ` AND ${originalSourceQueueClause(sourceKind, params)}`;
    const rows = this.database.prepare(`
      SELECT status, COUNT(*) AS count
      FROM discovery_seed_queue
      WHERE run_id = ?${kindClause}${sourceClause}
      GROUP BY status
    `).all(...params);
    const counts = Object.fromEntries(rows.map((row) => [row.status, row.count]));
    const pendingParams = [runId];
    if (seedKind) pendingParams.push(normalizeOriginalSeedKind(seedKind));
    if (sourceKind !== null) originalSourceQueueClause(sourceKind, pendingParams);
    const pending = this.database.prepare(`
      SELECT
        MIN(due_at) AS next_due_at,
        SUM(CASE WHEN due_at <= ? THEN 1 ELSE 0 END) AS due_count
      FROM discovery_seed_queue
      WHERE run_id = ?${kindClause}${sourceClause} AND status = 'pending'
    `).get(timestamp, ...pendingParams);
    return {
      runId,
      seedKind: seedKind ? normalizeOriginalSeedKind(seedKind) : null,
      counts,
      total: Object.values(counts).reduce((sum, value) => sum + Number(value), 0),
      dueCount: Number(pending?.due_count ?? 0),
      nextDueAt: pending?.next_due_at ?? null,
      observedAt: timestamp
    };
  }

  originalCollectionAutomaticResumeReadiness(runId) {
    const run = this.getRun(runId);
    if (run?.status !== "partial") return { ready: false, reason: "run_not_resumable" };
    const checkpoint = this.getCheckpoint(runId, "original_collectors", { adapter: "tiktok_original_cascade" })?.value;
    // Partial describes source coverage, not permission to start another run.
    // A bounded collector has finished even if its preserved queue is nonempty.
    if (checkpoint?.executionFinished === true
      || run.result?.selectionComplete === true
      || run.result?.discovery?.selectionComplete === true) {
      return { ready: false, reason: "run_collection_finished" };
    }
    return { ready: true };
  }

  listRunsWithDueOriginalDiscoverySeeds({
    seedKind = "ranking",
    statuses = ["partial"],
    at = this.now(),
    limit = DEFAULT_LIMIT
  } = {}) {
    const kind = normalizeOriginalSeedKind(seedKind);
    const timestamp = asIsoTimestamp(at, "at");
    const allowedStatuses = normalizedTextList(statuses, {
      fieldName: "statuses",
      itemLength: 32,
      sort: true
    });
    if (!allowedStatuses.length) return [];
    const placeholders = allowedStatuses.map(() => "?").join(", ");
    return this.database.prepare(`
      SELECT runs.*, MIN(queue.due_at) AS queue_due_at
      FROM collection_runs AS runs
      JOIN discovery_seed_queue AS queue ON queue.run_id = runs.run_id
      WHERE queue.seed_kind = ? AND queue.status = 'pending' AND queue.due_at <= ?
        AND runs.status IN (${placeholders})
        AND COALESCE(json_extract(runs.result_json, '$.selectionComplete'), 0) != 1
        AND COALESCE(json_extract(runs.result_json, '$.discovery.selectionComplete'), 0) != 1
        AND NOT EXISTS (
          SELECT 1 FROM checkpoints AS checkpoint
          WHERE checkpoint.run_id = runs.run_id
            AND checkpoint.adapter = 'tiktok_original_cascade'
            AND checkpoint.checkpoint_key = 'original_collectors'
            AND json_extract(checkpoint.value_json, '$.executionFinished') = 1
        )
      GROUP BY runs.run_id
      ORDER BY queue_due_at, runs.created_at, runs.run_id
      LIMIT ?
    `).all(kind, timestamp, ...allowedStatuses, finiteLimit(limit)).map(runFromRow);
  }

  previewCollectionCleanup({ cutoff } = {}) {
    const normalizedCutoff = asIsoTimestamp(cutoff, "cutoff");
    const plan = collectionCleanupPlan(this.database, normalizedCutoff, this.now());
    return collectionCleanupPreviewFromPlan(plan);
  }

  commitCollectionCleanup({
    cutoff,
    expectedPreviewHash,
    actor = "user"
  } = {}) {
    const normalizedCutoff = asIsoTimestamp(cutoff, "cutoff");
    const expectedHash = asText(expectedPreviewHash, 64)?.toLowerCase() ?? null;
    if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new TypeError("expectedPreviewHash must be a SHA-256 hex digest");
    }
    return this.transaction(() => {
      const plan = collectionCleanupPlan(this.database, normalizedCutoff, this.now());
      if (plan.previewHash !== expectedHash) {
        throw databasePolicyError(
          "COLLECTION_CLEANUP_PREVIEW_STALE",
          "collection cleanup preview is stale; run preview again before committing",
          {
            cutoff: normalizedCutoff,
            expectedPreviewHash: expectedHash,
            actualPreviewHash: plan.previewHash
          }
        );
      }
      const actual = {
        sessions: 0,
        collectionRuns: 0,
        checkpoints: 0,
        prospects: 0,
        prospectObservations: 0,
        handoffBatches: 0,
        outbox: 0,
        auditEvents: 0,
        collectionRoutes: 0,
        qualificationBatches: 0,
        qualificationBatchItems: 0,
        qualificationPolicyState: 0,
        discoverySeedQueue: 0
      };
      actual.qualificationBatchItems = deleteByIds(
        this.database,
        "qualification_batch_items",
        "batch_id",
        plan.deletionKeys.qualificationBatches
      );
      actual.qualificationBatches = deleteByIds(
        this.database,
        "qualification_batches",
        "batch_id",
        plan.deletionKeys.qualificationBatches
      );
      actual.checkpoints = deleteByIds(
        this.database,
        "checkpoints",
        "run_id",
        plan.deletionKeys.collectionRuns
      );
      actual.discoverySeedQueue = deleteByIds(
        this.database,
        "discovery_seed_queue",
        "run_id",
        plan.deletionKeys.collectionRuns
      );
      actual.prospectObservations = deleteByIds(
        this.database,
        "prospect_observations",
        "observation_id",
        plan.deletionKeys.prospectObservations
      );
      actual.handoffBatches = deleteByIds(
        this.database,
        "handoff_batches",
        "batch_id",
        plan.deletionKeys.handoffBatches
      );
      actual.collectionRuns = deleteByIds(
        this.database,
        "collection_runs",
        "run_id",
        plan.deletionKeys.collectionRuns
      );
      actual.prospects = deleteByIds(
        this.database,
        "prospects",
        "candidate_id",
        plan.deletionKeys.prospects
      );
      for (const field of [
        "collectionRuns",
        "checkpoints",
        "prospects",
        "prospectObservations",
        "handoffBatches",
        "qualificationBatches",
        "qualificationBatchItems",
        "discoverySeedQueue"
      ]) {
        if (actual[field] !== plan.deleteCounts[field]) {
          throw databasePolicyError(
            "COLLECTION_CLEANUP_COUNT_MISMATCH",
            "collection cleanup changed while the transaction was executing",
            { field, expected: plan.deleteCounts[field], actual: actual[field] }
          );
        }
      }
      const deletedAt = this.now();
      const audit = this.appendAudit({
        actor: asText(actor, 80) ?? "user",
        action: "collection_cleanup_committed",
        targetType: "collection_cleanup",
        targetId: expectedHash,
        outcome: "success",
        details: {
          scopeVersion: COLLECTION_CLEANUP_SCOPE_VERSION,
          cutoff: normalizedCutoff,
          previewHash: expectedHash,
          deleteCounts: actual,
          recoverable: false,
          backupCreated: false
        },
        occurredAt: deletedAt
      });
      const result = collectionCleanupPreviewFromPlan({
        ...plan,
        deleteCounts: actual,
        protectedCounts: {
          ...plan.protectedCounts,
          auditEvents: plan.protectedCounts.auditEvents + 1
        }
      });
      return {
        ...result,
        committed: true,
        deletedAt,
        auditId: audit.auditId
      };
    });
  }

  upsertCollectionRoute(input = {}) {
    const routeProfileId = asText(input.routeProfileId ?? input.id, 256) ?? this.idFactory();
    const existing = this.getCollectionRoute(routeProfileId);
    const marketRegion = asText(input.marketRegion ?? existing?.marketRegion, 80);
    const discoveryCountry = asText(
      input.discoveryCountry ?? existing?.discoveryCountry,
      16
    )?.toUpperCase() ?? null;
    const discoveryProxyServer = asText(
      input.discoveryProxyServer ?? existing?.discoveryProxyServer,
      4_000
    );
    const {
      collectionLanes,
      collectionCountryCodes,
      collectionProxyServer,
      collectionProxyServers,
      collectionProxyLaneMode
    } = collectionLaneConfiguration(input, existing, routeProfileId);
    const routeCountry = collectionCountryCodes[0];
    const backstageCountry = collectionCountryCodes[0];
    const routeFingerprint = asText(
      input.routeFingerprint
        ?? input.proxyFingerprint
        ?? existing?.routeFingerprint
        ?? existing?.proxyFingerprint,
      256
    );
    const marketCountryCodes = normalizedTextList(
      input.marketCountryCodes ?? existing?.marketCountryCodes ?? [],
      { fieldName: "marketCountryCodes", itemLength: 16, uppercase: true }
    ).map((countryCode) => normalizeCountryCode(countryCode, "marketCountryCodes[]"));
    if (!marketRegion || !discoveryCountry || !discoveryProxyServer
      || !collectionProxyServer || !routeFingerprint) {
      throw new TypeError(
        "marketRegion, discoveryCountry, discoveryProxyServer, collectionLanes, "
          + "and routeFingerprint are required"
      );
    }
    if (!marketCountryCodes.length) throw new TypeError("marketCountryCodes must not be empty");
    const countriesOutsideMarket = collectionCountryCodes.filter(
      (countryCode) => !marketCountryCodes.includes(countryCode)
    );
    if (countriesOutsideMarket.length > 0) {
      throw databasePolicyError(
        "COLLECTION_COUNTRY_NOT_IN_MARKET",
        "every collection lane country must be included in marketCountryCodes",
        { routeProfileId, countriesOutsideMarket, marketCountryCodes }
      );
    }

    const identityChanged = Boolean(existing) && (
      existing.migrationRequired
      ||
      marketRegion !== existing.marketRegion
      || discoveryCountry !== existing.discoveryCountry
      || discoveryProxyServer !== existing.discoveryProxyServer
      || routeCountry !== existing.routeCountry
      || backstageCountry !== existing.backstageCountry
      || collectionProxyServer !== existing.collectionProxyServer
      || collectionProxyLaneMode !== existing.collectionProxyLaneMode
      || stableJson(collectionCountryCodes) !== stableJson(existing.collectionCountryCodes)
      || stableJson(collectionProxyServers) !== stableJson(existing.collectionProxyServers)
      || routeFingerprint !== existing.routeFingerprint
      || stableJson(marketCountryCodes) !== stableJson(existing.marketCountryCodes)
    );
    const verificationStatus = asText(
      input.verificationStatus
        ?? (identityChanged ? "unverified" : existing?.verificationStatus)
        ?? "unverified",
      80
    );
    const discoveryProxyExitCountry = asText(
      input.discoveryProxyExitCountry
        ?? (identityChanged ? null : existing?.discoveryProxyExitCountry),
      16
    )?.toUpperCase() ?? null;
    const hasExplicitCollectionProxyExitCountries =
      input.collectionProxyExitCountries !== undefined
      && input.collectionProxyExitCountries !== null;
    let collectionProxyExitCountries = hasExplicitCollectionProxyExitCountries
      ? normalizedCollectionProxyExitCountries(input.collectionProxyExitCountries, {
        expectedCount: collectionLanes.length,
        routeProfileId
      })
      : (identityChanged ? [] : existing?.collectionProxyExitCountries ?? []);
    const explicitProxyExitCountry = input.proxyExitCountry === undefined
      || input.proxyExitCountry === null
      ? null
      : normalizeCountryCode(input.proxyExitCountry, "proxyExitCountry");
    let proxyExitCountry = explicitProxyExitCountry
      ?? (identityChanged ? null : existing?.proxyExitCountry)
      ?? null;
    if (collectionLanes.length === 1
      && explicitProxyExitCountry
      && !hasExplicitCollectionProxyExitCountries) {
      collectionProxyExitCountries = [explicitProxyExitCountry];
    }
    if (collectionProxyExitCountries.length > 0) {
      proxyExitCountry ??= collectionProxyExitCountries[0];
      if (proxyExitCountry !== collectionProxyExitCountries[0]) {
        throw databasePolicyError(
          "COLLECTION_PROXY_EXIT_ALIAS_MISMATCH",
          "proxyExitCountry must match collectionProxyExitCountries[0]",
          { routeProfileId }
        );
      }
    }
    const verification = input.verification === undefined
      ? (identityChanged ? null : existing?.verification)
      : input.verification;
    const verifiedAt = input.verifiedAt === undefined
      ? (identityChanged ? null : existing?.verifiedAt ?? null)
      : (input.verifiedAt === null ? null : asIsoTimestamp(input.verifiedAt, "verifiedAt"));
    const active = input.active === undefined
      ? (identityChanged ? false : Boolean(existing?.active))
      : Boolean(input.active);
    const collectionExitsMatch = collectionProxyExitCountries.length === collectionLanes.length
      && collectionProxyExitCountries.every(
        (countryCode, index) => countryCode === collectionCountryCodes[index]
      );
    if (verificationStatus === "verified"
      && (discoveryProxyExitCountry !== discoveryCountry
        || proxyExitCountry !== collectionCountryCodes[0]
        || !collectionExitsMatch)) {
      throw databasePolicyError(
        "ROUTE_VERIFICATION_COUNTRY_MISMATCH",
        "verified discovery and every collection proxy exit must match their route countries",
        {
          discoveryCountry,
          discoveryProxyExitCountry,
          routeCountry,
          proxyExitCountry,
          collectionCountryCodes,
          collectionProxyExitCountries
        }
      );
    }
    if (active && verificationStatus !== "verified") {
      throw databasePolicyError(
        "ROUTE_NOT_VERIFIED",
        "only a verified collection route can be active",
        { routeProfileId, verificationStatus }
      );
    }

    return this.transaction(() => {
      const now = this.now();
      if (active) this.database.prepare("UPDATE collection_routes SET active = 0, updated_at = ? WHERE active = 1").run(now);
      this.database.prepare(`
        INSERT INTO collection_routes(
          route_profile_id, market_region, discovery_country, discovery_proxy_server,
          route_country, backstage_country, market_countries_json,
          collection_country_codes_json,
          collection_proxy_server, collection_proxy_servers_json,
          collection_proxy_lane_mode, proxy_server, proxy_fingerprint,
          discovery_proxy_exit_country, collection_proxy_exit_countries_json,
          proxy_exit_country,
          verification_status, verification_json, verified_at, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(route_profile_id) DO UPDATE SET
          market_region = excluded.market_region,
          discovery_country = excluded.discovery_country,
          discovery_proxy_server = excluded.discovery_proxy_server,
          route_country = excluded.route_country,
          backstage_country = excluded.backstage_country,
          market_countries_json = excluded.market_countries_json,
          collection_country_codes_json = excluded.collection_country_codes_json,
          collection_proxy_server = excluded.collection_proxy_server,
          collection_proxy_servers_json = excluded.collection_proxy_servers_json,
          collection_proxy_lane_mode = excluded.collection_proxy_lane_mode,
          proxy_server = excluded.proxy_server,
          proxy_fingerprint = excluded.proxy_fingerprint,
          discovery_proxy_exit_country = excluded.discovery_proxy_exit_country,
          collection_proxy_exit_countries_json = excluded.collection_proxy_exit_countries_json,
          proxy_exit_country = excluded.proxy_exit_country,
          verification_status = excluded.verification_status,
          verification_json = excluded.verification_json,
          verified_at = excluded.verified_at,
          active = excluded.active,
          updated_at = excluded.updated_at
      `).run(
        routeProfileId, marketRegion, discoveryCountry, discoveryProxyServer,
        routeCountry, backstageCountry, json(marketCountryCodes),
        json(collectionCountryCodes),
        collectionProxyServer, json(collectionProxyServers),
        collectionProxyLaneMode, collectionProxyServer, routeFingerprint,
        discoveryProxyExitCountry, json(collectionProxyExitCountries), proxyExitCountry,
        verificationStatus, json(verification), verifiedAt, active ? 1 : 0,
        existing?.createdAt ?? now, now
      );
      return this.getCollectionRoute(routeProfileId);
    });
  }

  getCollectionRoute(routeProfileId) {
    return routeFromRow(this.database.prepare(
      "SELECT * FROM collection_routes WHERE route_profile_id = ?"
    ).get(routeProfileId));
  }

  listCollectionRoutes({
    marketRegion,
    discoveryCountry,
    routeCountry,
    verificationStatus,
    active,
    limit = DEFAULT_LIMIT,
    offset = 0
  } = {}) {
    const clauses = [];
    const params = [];
    if (marketRegion) { clauses.push("market_region = ?"); params.push(marketRegion); }
    if (discoveryCountry) { clauses.push("discovery_country = ?"); params.push(discoveryCountry); }
    if (routeCountry) { clauses.push("route_country = ?"); params.push(routeCountry); }
    if (verificationStatus) { clauses.push("verification_status = ?"); params.push(verificationStatus); }
    if (active !== undefined && active !== null) { clauses.push("active = ?"); params.push(active ? 1 : 0); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database.prepare(`
      SELECT * FROM collection_routes ${where}
      ORDER BY active DESC, updated_at DESC, route_profile_id
      LIMIT ? OFFSET ?
    `).all(...params, finiteLimit(limit), finiteOffset(offset)).map(routeFromRow);
  }

  getActiveCollectionRoute() {
    return routeFromRow(this.database.prepare(
      "SELECT * FROM collection_routes WHERE active = 1 LIMIT 1"
    ).get());
  }

  setActiveCollectionRoute(routeProfileId) {
    if (routeProfileId === null || routeProfileId === undefined || routeProfileId === "") {
      return this.transaction(() => {
        this.database.prepare("UPDATE collection_routes SET active = 0, updated_at = ? WHERE active = 1").run(this.now());
        return null;
      });
    }
    const route = this.getCollectionRoute(routeProfileId);
    if (!route) throw new Error(`collection route not found: ${routeProfileId}`);
    if (route.migrationRequired) {
      throw databasePolicyError(
        "COLLECTION_LANE_MIGRATION_REQUIRED",
        "legacy ambiguous three-slot routes must be mapped to explicit countries before activation",
        { routeProfileId }
      );
    }
    if (route.verificationStatus !== "verified") {
      throw databasePolicyError(
        "ROUTE_NOT_VERIFIED",
        "only a verified collection route can be active",
        { routeProfileId, verificationStatus: route.verificationStatus }
      );
    }
    const collectionExitsMatch = route.collectionProxyExitCountries.length
      === route.collectionLanes.length
      && route.collectionProxyExitCountries.every(
        (countryCode, index) => countryCode === route.collectionCountryCodes[index]
      );
    const firstLane = route.collectionLanes[0];
    const compatibilityAliasesMatch = route.routeCountry === firstLane.countryCode
      && route.backstageCountry === firstLane.countryCode
      && route.collectionProxyServer === firstLane.proxyServer
      && route.proxyServer === firstLane.proxyServer
      && route.proxyExitCountry === route.collectionProxyExitCountries[0];
    if (route.discoveryProxyExitCountry !== route.discoveryCountry
      || !collectionExitsMatch
      || !compatibilityAliasesMatch) {
      throw databasePolicyError(
        "ROUTE_VERIFICATION_COUNTRY_MISMATCH",
        "discovery and every collection proxy exit must match its configured country lane",
        {
          discoveryCountry: route.discoveryCountry,
          discoveryProxyExitCountry: route.discoveryProxyExitCountry,
          routeCountry: route.routeCountry,
          backstageCountry: route.backstageCountry,
          proxyExitCountry: route.proxyExitCountry,
          collectionCountryCodes: route.collectionCountryCodes,
          collectionProxyExitCountries: route.collectionProxyExitCountries
        }
      );
    }
    return this.transaction(() => {
      const now = this.now();
      this.database.prepare("UPDATE collection_routes SET active = 0, updated_at = ? WHERE active = 1").run(now);
      this.database.prepare("UPDATE collection_routes SET active = 1, updated_at = ? WHERE route_profile_id = ?")
        .run(now, routeProfileId);
      return this.getCollectionRoute(routeProfileId);
    });
  }

  recordCollectionRouteVerification(routeProfileId, patch = {}) {
    const expectedRouteFingerprint = asText(
      patch.routeFingerprint ?? patch.proxyFingerprint,
      256
    );
    if (!expectedRouteFingerprint) {
      throw databasePolicyError(
        "ROUTE_FINGERPRINT_REQUIRED",
        "route verification requires the probed route fingerprint",
        { routeProfileId }
      );
    }
    return this.transaction(() => {
      const route = this.getCollectionRoute(routeProfileId);
      if (!route) throw new Error(`collection route not found: ${routeProfileId}`);
      if (route.migrationRequired) {
        throw databasePolicyError(
          "COLLECTION_LANE_MIGRATION_REQUIRED",
          "legacy ambiguous three-slot routes must be mapped to explicit countries before verification",
          { routeProfileId }
        );
      }
      if (expectedRouteFingerprint !== route.routeFingerprint) {
        throw databasePolicyError(
          "ROUTE_FINGERPRINT_MISMATCH",
          "route configuration changed after the proxy probe",
          { routeProfileId }
        );
      }
      const verificationStatus = asText(patch.verificationStatus ?? patch.status, 80) ?? "unverified";
      const hasExplicitCollectionProxyExitCountries =
        patch.collectionProxyExitCountries !== undefined
        && patch.collectionProxyExitCountries !== null;
      let collectionProxyExitCountries = hasExplicitCollectionProxyExitCountries
        ? normalizedCollectionProxyExitCountries(patch.collectionProxyExitCountries, {
          expectedCount: route.collectionLanes.length,
          routeProfileId
        })
        : [];
      let proxyExitCountry = patch.proxyExitCountry === undefined
        || patch.proxyExitCountry === null
        ? null
        : normalizeCountryCode(patch.proxyExitCountry, "proxyExitCountry");
      if (route.collectionLanes.length === 1
        && proxyExitCountry && !hasExplicitCollectionProxyExitCountries) {
        collectionProxyExitCountries = [proxyExitCountry];
      }
      if (collectionProxyExitCountries.length > 0) {
        proxyExitCountry ??= collectionProxyExitCountries[0];
        if (proxyExitCountry !== collectionProxyExitCountries[0]) {
          throw databasePolicyError(
            "COLLECTION_PROXY_EXIT_ALIAS_MISMATCH",
            "proxyExitCountry must match collectionProxyExitCountries[0]",
            { routeProfileId }
          );
        }
      }
      const legacySingleRoute = route.discoveryCountry === route.routeCountry
        && route.discoveryProxyServer === route.collectionProxyServer;
      const discoveryProxyExitCountry = asText(
        patch.discoveryProxyExitCountry
          ?? (legacySingleRoute ? patch.proxyExitCountry : null),
        16
      )?.toUpperCase() ?? null;
      const collectionExitsMatch = collectionProxyExitCountries.length
        === route.collectionLanes.length
        && collectionProxyExitCountries.every(
          (countryCode, index) => countryCode === route.collectionCountryCodes[index]
        );
      if (verificationStatus === "verified"
        && (discoveryProxyExitCountry !== route.discoveryCountry
          || proxyExitCountry !== route.collectionCountryCodes[0]
          || !collectionExitsMatch)) {
        throw databasePolicyError(
          "ROUTE_VERIFICATION_COUNTRY_MISMATCH",
          "verified discovery and every collection proxy exit must match their route countries",
          {
            discoveryCountry: route.discoveryCountry,
            discoveryProxyExitCountry,
            routeCountry: route.routeCountry,
            proxyExitCountry,
            collectionCountryCodes: route.collectionCountryCodes,
            collectionProxyExitCountries
          }
        );
      }
      const now = this.now();
      const verifiedAt = verificationStatus === "verified"
        ? (patch.verifiedAt ? asIsoTimestamp(patch.verifiedAt, "verifiedAt") : now)
        : null;
      const result = this.database.prepare(`
        UPDATE collection_routes SET
          discovery_proxy_exit_country = ?, collection_proxy_exit_countries_json = ?,
          proxy_exit_country = ?,
          verification_status = ?, verification_json = ?,
          verified_at = ?, active = CASE WHEN ? = 'verified' THEN active ELSE 0 END,
          updated_at = ?
        WHERE route_profile_id = ? AND proxy_fingerprint = ?
      `).run(
        discoveryProxyExitCountry,
        json(collectionProxyExitCountries),
        proxyExitCountry,
        verificationStatus,
        json(patch.verification ?? patch.details ?? null),
        verifiedAt,
        verificationStatus,
        now,
        routeProfileId,
        expectedRouteFingerprint
      );
      if (Number(result.changes) !== 1) {
        throw databasePolicyError(
          "ROUTE_FINGERPRINT_MISMATCH",
          "route configuration changed while verification was being recorded",
          { routeProfileId }
        );
      }
      return this.getCollectionRoute(routeProfileId);
    });
  }

  upsertQualificationPolicyState(input = {}) {
    const existing = this.getQualificationPolicyState();
    const hourlyTarget = asPositiveInteger(input.hourlyTarget ?? existing?.hourlyTarget);
    const dailyTarget = asPositiveInteger(input.dailyTarget ?? existing?.dailyTarget);
    if (!hourlyTarget || hourlyTarget > QUALIFICATION_HOURLY_HARD_LIMIT) {
      throw new RangeError(`hourlyTarget must be between 1 and ${QUALIFICATION_HOURLY_HARD_LIMIT}`);
    }
    if (!dailyTarget || dailyTarget > QUALIFICATION_DAILY_HARD_LIMIT) {
      throw new RangeError(`dailyTarget must be between 1 and ${QUALIFICATION_DAILY_HARD_LIMIT}`);
    }
    const epochStartedAt = asIsoTimestamp(
      input.epochStartedAt ?? existing?.epochStartedAt ?? this.now(),
      "epochStartedAt"
    );
    const epochEndsAt = asIsoTimestamp(input.epochEndsAt ?? existing?.epochEndsAt, "epochEndsAt");
    if (Date.parse(epochEndsAt) <= Date.parse(epochStartedAt)) {
      throw new RangeError("epochEndsAt must be later than epochStartedAt");
    }
    const now = this.now();
    this.database.prepare(`
      INSERT INTO qualification_policy_state(
        state_key, hourly_target, daily_target, epoch_started_at, epoch_ends_at, created_at, updated_at
      ) VALUES ('global', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(state_key) DO UPDATE SET
        hourly_target = excluded.hourly_target,
        daily_target = excluded.daily_target,
        epoch_started_at = excluded.epoch_started_at,
        epoch_ends_at = excluded.epoch_ends_at,
        updated_at = excluded.updated_at
    `).run(
      hourlyTarget, dailyTarget, epochStartedAt, epochEndsAt,
      existing?.createdAt ?? now, now
    );
    return this.getQualificationPolicyState();
  }

  getQualificationPolicyState({ at, activeOnly = false } = {}) {
    const atIso = at === undefined ? undefined : asIsoTimestamp(at, "at");
    const state = qualificationPolicyStateFromRow(
      this.database.prepare("SELECT * FROM qualification_policy_state WHERE state_key = 'global'").get(),
      atIso
    );
    if (activeOnly && (!state || state.active !== true)) return null;
    return state;
  }

  upsertProspect(input, observationInput = undefined) {
    const identity = buildIdentity(input);
    const observation = observationInput === undefined ? input.observation : observationInput;
    return this.transaction(() => {
      const matchingRows = this.database.prepare(`
        SELECT * FROM prospects
        WHERE identity_key = ?
          OR (? IS NOT NULL AND user_id = ?)
          OR (? IS NOT NULL AND sec_uid = ?)
          OR (? IS NOT NULL AND handle_normalized = ?)
        ORDER BY CASE
          WHEN user_id = ? THEN 1
          WHEN sec_uid = ? THEN 2
          WHEN handle_normalized = ? THEN 3
          ELSE 4 END,
          created_at
      `).all(
        identity.identityKey,
        identity.userId, identity.userId,
        identity.secUid, identity.secUid,
        identity.handleNormalized, identity.handleNormalized,
        identity.userId, identity.secUid, identity.handleNormalized
      );
      const existingRow = matchingRows[0] ?? null;
      if (matchingRows.length > 1) this.#mergeDuplicateProspects(existingRow.candidate_id, matchingRows.slice(1).map((row) => row.candidate_id));
      const now = this.now();
      const seenAt = asText(input.observedAt ?? input.lastSeenAt, 80) ?? now;
      const candidateId = existingRow?.candidate_id ?? asText(input.candidateId, 256) ?? this.idFactory();
      const current = existingRow ? prospectFromRow(existingRow) : null;
      const source = asText(input.source ?? observation?.source ?? current?.latestSource, 160);
      const field = (names, fallback) => {
        for (const name of names) if (input[name] !== undefined) return input[name];
        return fallback;
      };
      const followers = field(["followers", "followerCount", "follower_count"], current?.followers);
      const live = field(["live", "isLive", "is_live"], current?.live);
      const seller = field(["seller", "isSeller", "is_seller"], current?.seller);
      const highQuality = field(["highQuality", "isHighQuality", "is_high_quality"], current?.highQuality);
      const preferredIdentity = identity.userId
        ? `user_id:${identity.userId}`
        : identity.secUid ? `sec_uid:${identity.secUid}` : identity.identityKey;
      this.database.prepare(`
        INSERT INTO prospects(
          candidate_id, identity_key, user_id, sec_uid, handle, handle_normalized,
          display_name, region, market_region, creator_country_code,
          follower_count, is_live, is_seller, is_high_quality,
          invitation_eligibility, rank, room_id, profile_url, latest_source, data_json,
          first_seen_at, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(candidate_id) DO UPDATE SET
          identity_key = excluded.identity_key,
          user_id = COALESCE(excluded.user_id, prospects.user_id),
          sec_uid = COALESCE(excluded.sec_uid, prospects.sec_uid),
          handle = COALESCE(excluded.handle, prospects.handle),
          handle_normalized = COALESCE(excluded.handle_normalized, prospects.handle_normalized),
          display_name = COALESCE(excluded.display_name, prospects.display_name),
          region = COALESCE(excluded.region, prospects.region),
          market_region = COALESCE(excluded.market_region, prospects.market_region),
          creator_country_code = COALESCE(excluded.creator_country_code, prospects.creator_country_code),
          follower_count = COALESCE(excluded.follower_count, prospects.follower_count),
          is_live = COALESCE(excluded.is_live, prospects.is_live),
          is_seller = COALESCE(excluded.is_seller, prospects.is_seller),
          is_high_quality = COALESCE(excluded.is_high_quality, prospects.is_high_quality),
          invitation_eligibility = COALESCE(excluded.invitation_eligibility, prospects.invitation_eligibility),
          rank = COALESCE(excluded.rank, prospects.rank),
          room_id = COALESCE(excluded.room_id, prospects.room_id),
          profile_url = COALESCE(excluded.profile_url, prospects.profile_url),
          latest_source = COALESCE(excluded.latest_source, prospects.latest_source),
          data_json = COALESCE(excluded.data_json, prospects.data_json),
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at
      `).run(
        candidateId,
        preferredIdentity,
        identity.userId ?? current?.userId ?? null,
        identity.secUid ?? current?.secUid ?? null,
        identity.handle ?? current?.handle ?? null,
        identity.handleNormalized ?? normalizeHandle(current?.handle),
        asText(field(["displayName", "name", "nickname"], current?.displayName), 512),
        asText(field(["region", "country"], current?.region), 160),
        asText(field(["marketRegion", "market_region"], current?.marketRegion), 80),
        asText(field(["creatorCountryCode", "creator_country_code", "countryCode"], current?.creatorCountryCode), 16),
        asNonNegativeInteger(followers),
        asNullableBoolean(live),
        asNullableBoolean(seller),
        asNullableBoolean(highQuality),
        asText(field(["invitationEligibility", "eligibility"], current?.invitationEligibility), 160),
        asText(field(["rank", "ranking"], current?.rank), 160),
        asText(field(["roomId", "room_id"], current?.roomId), 256),
        asText(field(["profileUrl", "url"], current?.profileUrl), 4_000),
        source,
        input.data === undefined ? json(current?.data) : json(input.data),
        current?.firstSeenAt ?? asText(input.firstSeenAt, 80) ?? seenAt,
        seenAt,
        current?.createdAt ?? now,
        now
      );

      let observationResult = null;
      const runId = input.runId ?? observation?.runId;
      if (observation !== undefined || runId || source) {
        observationResult = this.#addObservation(candidateId, {
          ...input,
          ...(observation ?? {}),
          runId,
          source: observation?.source ?? source ?? "unknown",
          observedAt: observation?.observedAt ?? seenAt
        });
      }
      return { prospect: this.getProspect(candidateId), observation: observationResult, created: !existingRow };
    });
  }

  #mergeDuplicateProspects(canonicalId, duplicateIds) {
    for (const duplicateId of duplicateIds) {
      this.database.prepare(`
        UPDATE OR IGNORE prospect_observations SET prospect_id = ? WHERE prospect_id = ?
      `).run(canonicalId, duplicateId);
      // A qualification batch is historical evidence of every candidate sent
      // to the backend. The requested ID remains immutable while the live FK
      // follows the canonical prospect. Multiple requested IDs may therefore
      // resolve to the same canonical candidate without dropping either item.
      this.database.prepare(`
        UPDATE qualification_batch_items SET candidate_id = ? WHERE candidate_id = ?
      `).run(canonicalId, duplicateId);
      this.database.prepare("DELETE FROM prospects WHERE candidate_id = ?").run(duplicateId);
    }
  }

  #addObservation(candidateId, input = {}) {
    if (!this.database.prepare("SELECT 1 FROM prospects WHERE candidate_id = ?").get(candidateId)) {
      throw new Error(`prospect not found: ${candidateId}`);
    }
    if (input.runId && !this.getRun(input.runId)) throw new Error(`collection run not found: ${input.runId}`);
    const now = this.now();
    const observedAt = asText(input.observedAt, 80) ?? now;
    const source = asText(input.source, 160) ?? "unknown";
    const normalized = {
      runId: asText(input.runId, 256),
      source,
      sourceUrl: asText(input.sourceUrl ?? input.url, 4_000),
      region: asText(input.region ?? input.country ?? input.countryCode, 160),
      marketRegion: asText(input.marketRegion ?? input.market_region, 80),
      creatorCountryCode: asText(
        input.creatorCountryCode ?? input.creator_country_code ?? input.countryCode,
        16
      ),
      followers: asNonNegativeInteger(input.followers ?? input.followerCount ?? input.follower_count),
      live: asNullableBoolean(input.live ?? input.isLive ?? input.is_live),
      seller: asNullableBoolean(input.seller ?? input.isSeller ?? input.is_seller),
      highQuality: asNullableBoolean(input.highQuality ?? input.isHighQuality ?? input.is_high_quality),
      invitationEligibility: asText(input.invitationEligibility ?? input.eligibility, 160),
      rank: asText(input.rank ?? input.ranking, 160),
      roomId: asText(input.roomId ?? input.room_id, 256),
      confidence: asConfidence(input.confidence),
      data: input.data ?? input.payload ?? null,
      evidence: input.evidence ?? null
    };
    const observationKey = asText(input.observationKey, 512) ?? crypto.createHash("sha256").update(stableJson({ candidateId, ...normalized })).digest("hex");
    const observationId = asText(input.observationId, 256) ?? this.idFactory();
    this.database.prepare(`
      INSERT INTO prospect_observations(
        observation_id, observation_key, prospect_id, run_id, source, source_url,
        observed_at, region, market_region, creator_country_code,
        follower_count, is_live, is_seller, is_high_quality,
        invitation_eligibility, rank, room_id, confidence, data_json, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(observation_key) DO UPDATE SET
        source_url = COALESCE(excluded.source_url, prospect_observations.source_url),
        observed_at = excluded.observed_at,
        region = COALESCE(excluded.region, prospect_observations.region),
        market_region = COALESCE(excluded.market_region, prospect_observations.market_region),
        creator_country_code = COALESCE(excluded.creator_country_code, prospect_observations.creator_country_code),
        follower_count = COALESCE(excluded.follower_count, prospect_observations.follower_count),
        is_live = COALESCE(excluded.is_live, prospect_observations.is_live),
        is_seller = COALESCE(excluded.is_seller, prospect_observations.is_seller),
        is_high_quality = COALESCE(excluded.is_high_quality, prospect_observations.is_high_quality),
        invitation_eligibility = COALESCE(excluded.invitation_eligibility, prospect_observations.invitation_eligibility),
        rank = COALESCE(excluded.rank, prospect_observations.rank),
        room_id = COALESCE(excluded.room_id, prospect_observations.room_id),
        confidence = COALESCE(excluded.confidence, prospect_observations.confidence),
        data_json = COALESCE(excluded.data_json, prospect_observations.data_json),
        evidence_json = COALESCE(excluded.evidence_json, prospect_observations.evidence_json)
    `).run(
      observationId, observationKey, candidateId, normalized.runId, source, normalized.sourceUrl,
      observedAt, normalized.region, normalized.marketRegion, normalized.creatorCountryCode,
      normalized.followers, normalized.live, normalized.seller, normalized.highQuality,
      normalized.invitationEligibility, normalized.rank, normalized.roomId, normalized.confidence,
      json(normalized.data), json(normalized.evidence), now
    );
    return observationFromRow(this.database.prepare("SELECT * FROM prospect_observations WHERE observation_key = ?").get(observationKey));
  }

  addObservation(candidateId, input = {}) {
    return this.transaction(() => this.#addObservation(candidateId, input));
  }

  #recordQualificationRecords({ batchId, runId, records = [] } = {}) {
    const normalizedBatchId = asText(batchId, 256);
    if (!normalizedBatchId) throw new TypeError("qualification batchId is required");
    if (!Array.isArray(records) || records.length < 1 || records.length > 30) {
      throw new TypeError("qualification records must contain 1 to 30 candidates");
    }
    if (runId && !this.getRun(runId)) throw new Error(`collection run not found: ${runId}`);
    const saved = [];
    for (const record of records) {
      const candidateId = asText(record.candidateId, 256);
      if (!candidateId || !this.database.prepare("SELECT 1 FROM prospects WHERE candidate_id = ?").get(candidateId)) {
        throw new Error(`prospect not found: ${candidateId ?? "(empty)"}`);
      }
      const eligibility = asText(record.qualificationStatus ?? record.invitationEligibility, 160);
      if (!eligibility) throw new TypeError("qualificationStatus is required");
      const observedAt = asText(record.observedAt, 80) ?? this.now();
      const observation = this.#addObservation(candidateId, {
        observationKey: `qualification:${normalizedBatchId}:${candidateId}`,
        runId: runId ?? record.runId,
        source: "collection_backstage",
        sourceUrl: record.sourceUrl,
        observedAt,
        marketRegion: record.marketRegion ?? record.market_region,
        creatorCountryCode: record.creatorCountryCode ?? record.creator_country_code,
        invitationEligibility: eligibility,
        confidence: record.confidence,
        data: record.data ?? null,
        evidence: record.evidence ?? null
      });
      // Qualification is an aggregate attribute, but it must not overwrite
      // discovery data, source, first/last seen timestamps, or identity.
      this.database.prepare(`
        UPDATE prospects SET invitation_eligibility = ?, updated_at = ?
        WHERE candidate_id = ?
      `).run(eligibility, this.now(), candidateId);
      saved.push({ candidateId, observation });
    }
    return { batchId: normalizedBatchId, count: saved.length, records: saved };
  }

  recordQualificationBatch(input = {}) {
    return this.transaction(() => this.#recordQualificationRecords(input));
  }

  commitManualQualificationImport({
    importId,
    runId,
    records = [],
    importedAt,
    reason
  } = {}) {
    const normalizedImportId = asText(importId, 256);
    const normalizedRunId = asText(runId, 256);
    const safeReason = asText(reason, 300);
    if (!normalizedImportId) throw new TypeError("manual qualification importId is required");
    if (!normalizedRunId || !this.getRun(normalizedRunId)) {
      throw new Error(`collection run not found: ${normalizedRunId ?? "(empty)"}`);
    }
    if (!safeReason) throw new TypeError("manual qualification import reason is required");
    const committedAt = asText(importedAt, 80) ?? this.now();

    return this.transaction(() => {
      const saved = this.#recordQualificationRecords({
        batchId: normalizedImportId,
        runId: normalizedRunId,
        records
      });
      const statusCounts = Object.fromEntries([...records.reduce((counts, record) => {
        const status = asText(record.qualificationStatus ?? record.invitationEligibility, 160);
        counts.set(status, (counts.get(status) ?? 0) + 1);
        return counts;
      }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)));

      const pendingCandidates = Number(this.database.prepare(`
        SELECT COUNT(*) AS count
        FROM prospects p
        WHERE EXISTS (
          SELECT 1 FROM prospect_observations discovery
          WHERE discovery.prospect_id = p.candidate_id
            AND discovery.run_id = ?
            AND discovery.source <> 'collection_backstage'
        )
        AND COALESCE((
          SELECT qualification.invitation_eligibility
          FROM prospect_observations qualification
          WHERE qualification.prospect_id = p.candidate_id
            AND qualification.run_id = ?
            AND qualification.source = 'collection_backstage'
            AND qualification.invitation_eligibility IS NOT NULL
          ORDER BY qualification.observed_at DESC,
            qualification.created_at DESC,
            qualification.observation_id DESC
          LIMIT 1
        ), 'not_queried') IN ('not_queried', 'quota_limit')
      `).get(normalizedRunId, normalizedRunId).count ?? 0);
      const run = this.getRun(normalizedRunId);
      const previousSummary = run.result?.semiAutoManualQualification ?? {};
      const cumulativeStatusCounts = { ...(previousSummary.statusCounts ?? {}) };
      for (const [status, count] of Object.entries(statusCounts)) {
        cumulativeStatusCounts[status] = Number(cumulativeStatusCounts[status] ?? 0) + count;
      }
      const summary = {
        schemaVersion: "tkdesk.semi-auto-manual-qualification.v1",
        lastImportId: normalizedImportId,
        lastImportedAt: committedAt,
        importsCompleted: Number(previousSummary.importsCompleted ?? 0) + 1,
        creatorsClassified: Number(previousSummary.creatorsClassified ?? 0) + records.length,
        statusCounts: Object.fromEntries(Object.entries(cumulativeStatusCounts).sort()),
        pendingCandidates,
        qualificationComplete: pendingCandidates === 0,
        automaticBackstageRequests: 0,
        qualificationBudgetRequestsConsumed: 0,
        automaticRetry: false,
        recursiveRankingExpansionTriggered: false
      };
      const updatedRun = this.#updateRun(normalizedRunId, {
        result: {
          ...(run.result ?? {}),
          semiAutoManualQualification: summary
        }
      });

      const audit = this.#appendAudit({
        action: "manual_qualification_results_imported",
        actor: "user",
        targetType: "manual_qualification_import",
        targetId: normalizedImportId,
        runId: normalizedRunId,
        details: {
          reason: safeReason,
          imported: records.length,
          statusCounts,
          qualificationBudgetRequestsConsumed: 0,
          automaticBackstageRequest: false,
          automaticRetry: false,
          recursiveRankingExpansionTriggered: false
        }
      });
      return {
        importId: normalizedImportId,
        runId: normalizedRunId,
        count: saved.count,
        records: saved.records,
        statusCounts,
        pendingCandidates,
        qualificationComplete: pendingCandidates === 0,
        summary,
        updatedRun,
        audit
      };
    });
  }

  getProspect(candidateId) {
    const row = this.database.prepare("SELECT * FROM prospects WHERE candidate_id = ?").get(candidateId);
    if (!row) return null;
    const discoveryObservation = this.database.prepare(`
      SELECT * FROM prospect_observations
      WHERE prospect_id = ? AND source <> 'collection_backstage'
      ORDER BY observed_at DESC, created_at DESC, observation_id DESC LIMIT 1
    `).get(candidateId);
    const qualificationObservation = this.database.prepare(`
      SELECT * FROM prospect_observations
      WHERE prospect_id = ? AND source = 'collection_backstage' AND invitation_eligibility IS NOT NULL
      ORDER BY observed_at DESC, created_at DESC, observation_id DESC LIMIT 1
    `).get(candidateId);
    return prospectFromRow(
      row,
      observationFromRow(discoveryObservation),
      observationFromRow(qualificationObservation)
    );
  }

  queryProspects({
    runId,
    candidateIds,
    source,
    region,
    marketRegion,
    creatorCountryCode,
    minFollowers,
    maxFollowers,
    limit = DEFAULT_LIMIT,
    offset = 0
  } = {}) {
    const clauses = [];
    const params = [];
    if (Array.isArray(candidateIds) && candidateIds.length) {
      const normalizedCandidateIds = [...new Set(candidateIds.map((value) => asText(value, 256)).filter(Boolean))];
      if (normalizedCandidateIds.length) {
        clauses.push(`p.candidate_id IN (${normalizedCandidateIds.map(() => "?").join(", ")})`);
        params.push(...normalizedCandidateIds);
      }
    }
    if (region) { clauses.push("p.region = ?"); params.push(region); }
    if (marketRegion) { clauses.push("p.market_region = ?"); params.push(marketRegion); }
    if (creatorCountryCode) { clauses.push("p.creator_country_code = ?"); params.push(creatorCountryCode); }
    if (minFollowers !== undefined && minFollowers !== null) { clauses.push("p.follower_count >= ?"); params.push(asNonNegativeInteger(minFollowers) ?? 0); }
    if (maxFollowers !== undefined && maxFollowers !== null) { clauses.push("p.follower_count <= ?"); params.push(asNonNegativeInteger(maxFollowers) ?? 0); }
    if (runId || source) {
      const observationClauses = ["po.prospect_id = p.candidate_id"];
      if (runId) { observationClauses.push("po.run_id = ?"); params.push(runId); }
      if (source) { observationClauses.push("po.source = ?"); params.push(source); }
      clauses.push(`EXISTS (SELECT 1 FROM prospect_observations po WHERE ${observationClauses.join(" AND ")})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database.prepare(`
      SELECT p.* FROM prospects p ${where}
      ORDER BY p.last_seen_at DESC, p.candidate_id
      LIMIT ? OFFSET ?
    `).all(...params, finiteLimit(limit), finiteOffset(offset));
    const latestDiscovery = this.database.prepare(`
      SELECT * FROM prospect_observations
      WHERE prospect_id = ?
        AND source <> 'collection_backstage'
        AND (? IS NULL OR run_id = ?)
        AND (? IS NULL OR source = ?)
      ORDER BY observed_at DESC, created_at DESC, observation_id DESC LIMIT 1
    `);
    const latestQualification = this.database.prepare(`
      SELECT * FROM prospect_observations
      WHERE prospect_id = ?
        AND source = 'collection_backstage'
        AND invitation_eligibility IS NOT NULL
        AND (? IS NULL OR run_id = ?)
      ORDER BY observed_at DESC, created_at DESC, observation_id DESC LIMIT 1
    `);
    return rows.map((row) => prospectFromRow(
      row,
      observationFromRow(latestDiscovery.get(
        row.candidate_id,
        runId ?? null, runId ?? null,
        source ?? null, source ?? null
      )),
      observationFromRow(latestQualification.get(
        row.candidate_id,
        runId ?? null, runId ?? null
      ))
    ));
  }

  getQualificationUsage({
    at = this.now(),
    hourlyLimit,
    dailyLimit,
    minimumSpacingSeconds = 0
  } = {}) {
    const atIso = asIsoTimestamp(at, "at");
    const atMs = Date.parse(atIso);
    const policyState = this.getQualificationPolicyState({ at: atIso, activeOnly: true });
    const requestedHourlyLimit = asPositiveInteger(
      hourlyLimit ?? policyState?.hourlyTarget ?? QUALIFICATION_HOURLY_HARD_LIMIT
    );
    const requestedDailyLimit = asPositiveInteger(
      dailyLimit ?? policyState?.dailyTarget ?? QUALIFICATION_DAILY_HARD_LIMIT
    );
    if (!requestedHourlyLimit || requestedHourlyLimit > QUALIFICATION_HOURLY_HARD_LIMIT) {
      throw databasePolicyError(
        "QUALIFICATION_LIMIT_EXCEEDS_HARD_CAP",
        `hourly qualification limit must be between 1 and ${QUALIFICATION_HOURLY_HARD_LIMIT}`,
        { requested: requestedHourlyLimit, hardLimit: QUALIFICATION_HOURLY_HARD_LIMIT }
      );
    }
    if (!requestedDailyLimit || requestedDailyLimit > QUALIFICATION_DAILY_HARD_LIMIT) {
      throw databasePolicyError(
        "QUALIFICATION_LIMIT_EXCEEDS_HARD_CAP",
        `daily qualification limit must be between 1 and ${QUALIFICATION_DAILY_HARD_LIMIT}`,
        { requested: requestedDailyLimit, hardLimit: QUALIFICATION_DAILY_HARD_LIMIT }
      );
    }
    const effectiveHourlyLimit = Math.min(
      requestedHourlyLimit,
      policyState?.hourlyTarget ?? QUALIFICATION_HOURLY_HARD_LIMIT,
      QUALIFICATION_HOURLY_HARD_LIMIT
    );
    const effectiveDailyLimit = Math.min(
      requestedDailyLimit,
      policyState?.dailyTarget ?? QUALIFICATION_DAILY_HARD_LIMIT,
      QUALIFICATION_DAILY_HARD_LIMIT
    );
    const dailyCutoff = new Date(atMs - QUALIFICATION_DAILY_WINDOW_MS).toISOString();
    const hourlyCutoffMs = atMs - QUALIFICATION_HOURLY_WINDOW_MS;
    const attempts = this.database.prepare(`
      SELECT attempted_at, minimum_spacing_seconds FROM (${QUALIFICATION_ATTEMPTS_SQL})
      WHERE attempted_at > ? ORDER BY attempted_at
    `).all(dailyCutoff).map((row) => ({
      attemptedAt: row.attempted_at,
      attemptedAtMs: Date.parse(row.attempted_at),
      minimumSpacingSeconds: row.minimum_spacing_seconds
    })).filter((row) => Number.isFinite(row.attemptedAtMs));
    const hourlyAttempts = attempts.filter((row) => row.attemptedAtMs > hourlyCutoffMs);
    const releaseAt = (rows, limit, windowMs) => {
      if (rows.length < limit) return null;
      return new Date(rows[rows.length - limit].attemptedAtMs + windowMs).toISOString();
    };
    const hourlyReleaseAt = releaseAt(
      hourlyAttempts,
      effectiveHourlyLimit,
      QUALIFICATION_HOURLY_WINDOW_MS
    );
    const dailyReleaseAt = releaseAt(
      attempts,
      effectiveDailyLimit,
      QUALIFICATION_DAILY_WINDOW_MS
    );
    const latest = attempts.at(-1) ?? this.database.prepare(`
      SELECT attempted_at, minimum_spacing_seconds FROM (${QUALIFICATION_ATTEMPTS_SQL})
      ORDER BY attempted_at DESC LIMIT 1
    `).get();
    const requestedSpacing = asNonNegativeInteger(minimumSpacingSeconds) ?? 0;
    const latestAttemptMs = latest
      ? Date.parse(latest.attemptedAt ?? latest.attempted_at)
      : null;
    const latestSpacing = latest
      ? asNonNegativeInteger(latest.minimumSpacingSeconds ?? latest.minimum_spacing_seconds) ?? 0
      : 0;
    const enforcedSpacingSeconds = Math.max(requestedSpacing, latestSpacing);
    const spacingReleaseAt = Number.isFinite(latestAttemptMs) && enforcedSpacingSeconds > 0
      ? new Date(latestAttemptMs + enforcedSpacingSeconds * 1_000).toISOString()
      : null;

    const blockedBy = [];
    if (hourlyAttempts.length >= effectiveHourlyLimit) blockedBy.push("hourly_limit");
    if (attempts.length >= effectiveDailyLimit) blockedBy.push("daily_limit");
    if (spacingReleaseAt && Date.parse(spacingReleaseAt) > atMs) blockedBy.push("minimum_spacing");
    const releases = [
      blockedBy.includes("hourly_limit") ? hourlyReleaseAt : null,
      blockedBy.includes("daily_limit") ? dailyReleaseAt : null,
      blockedBy.includes("minimum_spacing") ? spacingReleaseAt : null
    ].filter(Boolean);
    const nextEligibleAt = releases.length
      ? new Date(Math.max(...releases.map((value) => Date.parse(value)))).toISOString()
      : null;

    return {
      allowed: blockedBy.length === 0,
      blockedBy,
      at: atIso,
      hourlyUsed: hourlyAttempts.length,
      hourlyLimit: effectiveHourlyLimit,
      hourlyHardLimit: QUALIFICATION_HOURLY_HARD_LIMIT,
      hourlyRemaining: Math.max(0, effectiveHourlyLimit - hourlyAttempts.length),
      hourlyReleaseAt,
      dailyUsed: attempts.length,
      dailyLimit: effectiveDailyLimit,
      dailyHardLimit: QUALIFICATION_DAILY_HARD_LIMIT,
      dailyRemaining: Math.max(0, effectiveDailyLimit - attempts.length),
      dailyReleaseAt,
      minimumSpacingSeconds: enforcedSpacingSeconds,
      spacingReleaseAt,
      nextEligibleAt,
      policyState
    };
  }

  reserveStartupQualificationAttempt({requestId,routeProfileId,minimumSpacingSeconds=75}={}) {
    const auditId=asText(requestId,256);
    const route=asText(routeProfileId,256);
    if(!auditId||!route)throw new TypeError('startup request and route IDs are required');
    const spacing=asNonNegativeInteger(minimumSpacingSeconds);
    if(spacing<60||spacing>80)throw new RangeError('startup spacing must be60–80seconds');
    return this.transaction(()=>{
      const previous=this.database.prepare('SELECT * FROM audit_events WHERE audit_id=?').get(auditId);
      if(previous){
        if(previous.action!=='startup_qualification_attempt'||previous.target_id!==route)throw databasePolicyError('QUALIFICATION_BATCH_ID_CONFLICT','startup attempt identity conflict');
        return auditFromRow(previous);
      }
      const usage=this.getQualificationUsage({minimumSpacingSeconds:spacing});
      if(!usage.allowed)throw databasePolicyError('QUALIFICATION_BUDGET_EXHAUSTED','startup query is subject to rolling qualification budget',usage);
      return this.#appendAudit({auditId,action:'startup_qualification_attempt',targetType:'collection_route',targetId:route,outcome:'attempted',details:{minimumSpacingSeconds:spacing,syntheticLookup:true,realCandidates:0}});
    });
  }

  reserveQualificationBatch(input = {}) {
    const batchId = asText(input.batchId, 256) ?? this.idFactory();
    const runId = asText(input.runId, 256);
    if (!runId || !this.getRun(runId)) throw new Error(`collection run not found: ${runId ?? "(empty)"}`);
    const candidateIds = normalizedTextList(input.candidateIds ?? [], {
      fieldName: "candidateIds",
      itemLength: 256,
      sort: false
    });
    if (candidateIds.length < 1 || candidateIds.length > 30) {
      throw new RangeError("qualification batch must contain 1 to 30 unique candidates");
    }
    const attemptedAt = asIsoTimestamp(input.attemptedAt ?? this.now(), "attemptedAt");
    const minimumSpacingSeconds = asNonNegativeInteger(input.minimumSpacingSeconds) ?? 0;

    return this.transaction(() => {
      const existing = this.getQualificationBatch(batchId);
      if (existing) {
        const existingRequestedCandidateIds = existing.requestedCandidateIds ?? existing.candidateIds;
        if (
          existing.runId !== runId
          || stableJson([...existingRequestedCandidateIds].sort()) !== stableJson([...candidateIds].sort())
        ) {
          throw databasePolicyError(
            "QUALIFICATION_BATCH_ID_CONFLICT",
            "qualification batch ID is already reserved for a different request",
            { batchId }
          );
        }
        return { ...existing, alreadyReserved: true };
      }

      const placeholders = candidateIds.map(() => "?").join(", ");
      const eligibleRows = this.database.prepare(`
        SELECT p.candidate_id
        FROM prospects p
        WHERE p.candidate_id IN (${placeholders})
          AND EXISTS (
            SELECT 1 FROM prospect_observations po
            WHERE po.prospect_id = p.candidate_id AND po.run_id = ?
          )
      `).all(...candidateIds, runId);
      if (eligibleRows.length !== candidateIds.length) {
        throw databasePolicyError(
          "QUALIFICATION_CANDIDATE_NOT_IN_RUN",
          "every qualification candidate must belong to the selected run",
          { runId, requested: candidateIds.length, found: eligibleRows.length }
        );
      }
      if (input.allowPreviouslyAttempted !== true) {
        const alreadyAttempted = this.database.prepare(`
          SELECT qbi.candidate_id
          FROM qualification_batch_items qbi
          JOIN qualification_batches qb ON qb.batch_id = qbi.batch_id
          WHERE qb.run_id = ? AND qbi.candidate_id IN (${placeholders})
          ORDER BY qbi.candidate_id
        `).all(runId, ...candidateIds).map((row) => row.candidate_id);
        if (alreadyAttempted.length) {
          throw databasePolicyError(
            "QUALIFICATION_CANDIDATE_ALREADY_ATTEMPTED",
            "qualification candidates already have an attempted batch in this run",
            { runId, candidateIds: alreadyAttempted }
          );
        }
      }

      const usage = this.getQualificationUsage({
        at: attemptedAt,
        hourlyLimit: input.hourlyLimit,
        dailyLimit: input.dailyLimit,
        minimumSpacingSeconds
      });
      if (!usage.allowed) {
        throw databasePolicyError(
          "QUALIFICATION_BUDGET_EXHAUSTED",
          "rolling qualification budget does not allow another batch",
          usage
        );
      }
      const now = this.now();
      this.database.prepare(`
        INSERT INTO qualification_batches(
          batch_id, run_id, candidate_count, status, hourly_limit, daily_limit,
          hourly_used_before, daily_used_before, minimum_spacing_seconds,
          attempted_at, finished_at, error_code, details_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
      `).run(
        batchId, runId, candidateIds.length,
        usage.hourlyLimit, usage.dailyLimit, usage.hourlyUsed, usage.dailyUsed,
        minimumSpacingSeconds, attemptedAt, json(input.details), now, now
      );
      const insertItem = this.database.prepare(`
        INSERT INTO qualification_batch_items(
          batch_id, candidate_id, requested_candidate_id, ordinal, result_status
        ) VALUES (?, ?, ?, ?, NULL)
      `);
      candidateIds.forEach((candidateId, ordinal) => (
        insertItem.run(batchId, candidateId, candidateId, ordinal)
      ));
      return { ...this.getQualificationBatch(batchId), usageBefore: usage, alreadyReserved: false };
    });
  }

  getQualificationBatch(batchId) {
    const row = this.database.prepare("SELECT * FROM qualification_batches WHERE batch_id = ?").get(batchId);
    if (!row) return null;
    const items = this.database.prepare(`
      SELECT candidate_id, requested_candidate_id, ordinal, result_status
      FROM qualification_batch_items
      WHERE batch_id = ? ORDER BY ordinal
    `).all(batchId).map((item) => ({
      candidateId: item.candidate_id,
      requestedCandidateId: item.requested_candidate_id,
      ordinal: item.ordinal,
      resultStatus: item.result_status
    }));
    return qualificationBatchFromRow(row, items);
  }

  listReservedQualificationBatches({ runId, limit = DEFAULT_LIMIT, offset = 0 } = {}) {
    const clauses = ["status = 'reserved'"];
    const params = [];
    if (runId) { clauses.push("run_id = ?"); params.push(runId); }
    return this.database.prepare(`
      SELECT batch_id FROM qualification_batches
      WHERE ${clauses.join(" AND ")}
      ORDER BY attempted_at, batch_id
      LIMIT ? OFFSET ?
    `).all(...params, finiteLimit(limit), finiteOffset(offset))
      .map((row) => this.getQualificationBatch(row.batch_id));
  }

  recoverReservedQualificationBatches({
    runId,
    recoveredAt = this.now(),
    errorCode = "QUALIFICATION_OUTCOME_AMBIGUOUS",
    details = null
  } = {}) {
    const normalizedRunId = asText(runId, 256);
    if (normalizedRunId && !this.getRun(normalizedRunId)) {
      throw new Error(`collection run not found: ${normalizedRunId}`);
    }
    const normalizedRecoveredAt = asIsoTimestamp(recoveredAt, "recoveredAt");
    const normalizedErrorCode = asText(errorCode, 160) ?? "QUALIFICATION_OUTCOME_AMBIGUOUS";
    const recoveryDetails = details && typeof details === "object" && !Array.isArray(details)
      ? details
      : {};
    return this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT batch_id FROM qualification_batches
        WHERE status = 'reserved' AND (? IS NULL OR run_id = ?)
        ORDER BY attempted_at, batch_id
      `).all(normalizedRunId, normalizedRunId);
      const recovered = [];
      const markItems = this.database.prepare(`
        UPDATE qualification_batch_items SET result_status = 'ambiguous'
        WHERE batch_id = ? AND result_status IS NULL
      `);
      const finishBatch = this.database.prepare(`
        UPDATE qualification_batches SET
          status = 'ambiguous', finished_at = ?, error_code = ?, details_json = ?, updated_at = ?
        WHERE batch_id = ? AND status = 'reserved'
      `);
      for (const row of rows) {
        const current = this.getQualificationBatch(row.batch_id);
        const mergedDetails = {
          ...(current?.details && typeof current.details === "object" && !Array.isArray(current.details)
            ? current.details
            : {}),
          ...recoveryDetails,
          recovery: {
            outcome: "ambiguous",
            qualificationComplete: false,
            automaticRetry: false,
            recoveredAt: normalizedRecoveredAt
          }
        };
        markItems.run(row.batch_id);
        const result = finishBatch.run(
          normalizedRecoveredAt,
          normalizedErrorCode,
          json(mergedDetails),
          normalizedRecoveredAt,
          row.batch_id
        );
        if (Number(result.changes) === 1) recovered.push(this.getQualificationBatch(row.batch_id));
      }
      return {
        recoveredAt: normalizedRecoveredAt,
        count: recovered.length,
        batches: recovered,
        candidateIds: [...new Set(recovered.flatMap((batch) => batch.candidateIds))]
      };
    });
  }

  finishQualificationBatch(batchId, patch = {}) {
    return this.transaction(() => {
      const current = this.getQualificationBatch(batchId);
      if (!current) throw new Error(`qualification batch not found: ${batchId}`);
      const status = asText(patch.status, 80) ?? "completed";
      const finishedAt = asIsoTimestamp(patch.finishedAt ?? this.now(), "finishedAt");
      const resultItems = patch.results ?? patch.items ?? [];
      if (!Array.isArray(resultItems)) throw new TypeError("qualification results must be an array");
      const updateItem = this.database.prepare(`
        UPDATE qualification_batch_items SET result_status = ?
        WHERE batch_id = ? AND ordinal = ?
      `);
      for (const item of resultItems) {
        const candidateId = asText(item?.candidateId, 256);
        const ordinal = item?.ordinal === undefined
          ? null
          : asNonNegativeInteger(item.ordinal);
        const requestedMatches = current.items.filter((currentItem) => (
          currentItem.requestedCandidateId === candidateId
          && (ordinal === null || currentItem.ordinal === ordinal)
        ));
        const canonicalMatches = current.items.filter((currentItem) => (
          currentItem.candidateId === candidateId
          && (ordinal === null || currentItem.ordinal === ordinal)
        ));
        const matchingItems = requestedMatches.length ? requestedMatches : canonicalMatches;
        if (!candidateId || matchingItems.length !== 1) {
          throw databasePolicyError(
            "QUALIFICATION_RESULT_CANDIDATE_MISMATCH",
            "qualification result does not belong to the reserved batch",
            { batchId, candidateId, ordinal }
          );
        }
        updateItem.run(
          asText(item.resultStatus ?? item.status, 160),
          batchId,
          matchingItems[0].ordinal
        );
      }
      this.database.prepare(`
        UPDATE qualification_batches SET
          status = ?, finished_at = ?, error_code = ?, details_json = ?, updated_at = ?
        WHERE batch_id = ?
      `).run(
        status,
        finishedAt,
        patch.errorCode === undefined ? current.errorCode : asText(patch.errorCode, 160),
        patch.details === undefined ? json(current.details) : json(patch.details),
        this.now(),
        batchId
      );
      return this.getQualificationBatch(batchId);
    });
  }

  listUnattemptedRunProspects(input = {}, options = {}) {
    const filters = typeof input === "string" ? { ...options, runId: input } : (input ?? {});
    const runId = asText(filters.runId, 256);
    if (!runId || !this.getRun(runId)) throw new Error(`collection run not found: ${runId ?? "(empty)"}`);
    const rows = this.database.prepare(`
      SELECT p.*
      FROM prospects p
      WHERE EXISTS (
        SELECT 1 FROM prospect_observations po
        WHERE po.prospect_id = p.candidate_id
          AND po.run_id = ?
          AND po.source <> 'collection_backstage'
      )
        AND NOT EXISTS (
          SELECT 1
          FROM qualification_batch_items qbi
          JOIN qualification_batches qb ON qb.batch_id = qbi.batch_id
          WHERE qbi.candidate_id = p.candidate_id AND qb.run_id = ?
        )
      ORDER BY p.last_seen_at DESC, p.candidate_id
      LIMIT ? OFFSET ?
    `).all(runId, runId, finiteLimit(filters.limit, 30), finiteOffset(filters.offset));
    const latestDiscovery = this.database.prepare(`
      SELECT * FROM prospect_observations
      WHERE prospect_id = ? AND source <> 'collection_backstage' AND run_id = ?
      ORDER BY observed_at DESC, created_at DESC, observation_id DESC LIMIT 1
    `);
    const latestQualification = this.database.prepare(`
      SELECT * FROM prospect_observations
      WHERE prospect_id = ? AND source = 'collection_backstage'
        AND invitation_eligibility IS NOT NULL AND run_id = ?
      ORDER BY observed_at DESC, created_at DESC, observation_id DESC LIMIT 1
    `);
    return rows.map((row) => prospectFromRow(
      row,
      observationFromRow(latestDiscovery.get(row.candidate_id, runId)),
      observationFromRow(latestQualification.get(row.candidate_id, runId))
    ));
  }

  createHandoffBatch(input = {}) {
    const now = this.now();
    const batchId = asText(input.batchId, 256) ?? this.idFactory();
    const idempotencyKey = asText(input.idempotencyKey, 512);
    if (idempotencyKey) {
      const existing = this.database.prepare("SELECT * FROM handoff_batches WHERE idempotency_key = ?").get(idempotencyKey);
      if (existing) return handoffFromRow(existing);
    }
    this.database.prepare(`
      INSERT INTO handoff_batches(
        batch_id, idempotency_key, run_id, status, purpose, criteria_json, payload_json,
        candidate_count, approved_by, approved_at, dispatched_at, error_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      batchId, idempotencyKey, input.runId ?? null, asText(input.status, 80) ?? "pending_review",
      asText(input.purpose, 512), json(input.criteria), json(input.payload),
      asNonNegativeInteger(input.candidateCount) ?? 0, asText(input.approvedBy, 256),
      asText(input.approvedAt, 80), asText(input.dispatchedAt, 80), json(input.error), now, now
    );
    return this.getHandoffBatch(batchId);
  }

  getHandoffBatch(batchId) {
    return handoffFromRow(this.database.prepare("SELECT * FROM handoff_batches WHERE batch_id = ?").get(batchId));
  }

  updateHandoffBatch(batchId, patch = {}) {
    const current = this.getHandoffBatch(batchId);
    if (!current) throw new Error(`handoff batch not found: ${batchId}`);
    const status = asText(patch.status ?? current.status, 80);
    const now = this.now();
    this.database.prepare(`
      UPDATE handoff_batches SET status = ?, purpose = ?, criteria_json = ?, payload_json = ?,
        candidate_count = ?, approved_by = ?, approved_at = ?, dispatched_at = ?, error_json = ?, updated_at = ?
      WHERE batch_id = ?
    `).run(
      status,
      asText(patch.purpose ?? current.purpose, 512),
      patch.criteria === undefined ? json(current.criteria) : json(patch.criteria),
      patch.payload === undefined ? json(current.payload) : json(patch.payload),
      patch.candidateCount === undefined ? current.candidateCount : asNonNegativeInteger(patch.candidateCount) ?? 0,
      asText(patch.approvedBy ?? current.approvedBy, 256),
      patch.approvedAt === undefined ? current.approvedAt : asText(patch.approvedAt, 80),
      patch.dispatchedAt === undefined ? current.dispatchedAt : asText(patch.dispatchedAt, 80),
      patch.error === undefined ? json(current.error) : json(patch.error),
      now,
      batchId
    );
    return this.getHandoffBatch(batchId);
  }

  listPendingHandoffs({ limit = DEFAULT_LIMIT, offset = 0 } = {}) {
    return this.database.prepare(`
      SELECT * FROM handoff_batches
      WHERE status IN ('pending_review', 'approved', 'retry_wait')
      ORDER BY created_at, batch_id LIMIT ? OFFSET ?
    `).all(finiteLimit(limit), finiteOffset(offset)).map(handoffFromRow);
  }

  createOutboxEvent(input = {}) {
    const idempotencyKey = asText(input.idempotencyKey, 512);
    if (!idempotencyKey) throw new TypeError("outbox idempotencyKey is required");
    const existing = this.database.prepare("SELECT * FROM outbox WHERE idempotency_key = ?").get(idempotencyKey);
    if (existing) return outboxFromRow(existing);
    const now = this.now();
    const outboxId = asText(input.outboxId, 256) ?? this.idFactory();
    const aggregateType = asText(input.aggregateType, 160);
    const aggregateId = asText(input.aggregateId, 256);
    const eventType = asText(input.eventType, 160);
    if (!aggregateType || !aggregateId || !eventType) throw new TypeError("aggregateType, aggregateId, and eventType are required");
    this.database.prepare(`
      INSERT INTO outbox(
        outbox_id, idempotency_key, aggregate_type, aggregate_id, event_type, payload_json,
        status, attempts, available_at, locked_at, delivered_at, last_error_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      outboxId, idempotencyKey, aggregateType, aggregateId, eventType, json(input.payload),
      asText(input.status, 80) ?? "pending", asNonNegativeInteger(input.attempts) ?? 0,
      asText(input.availableAt, 80) ?? now, asText(input.lockedAt, 80),
      asText(input.deliveredAt, 80), json(input.lastError), now, now
    );
    return this.getOutboxEvent(outboxId);
  }

  getOutboxEvent(outboxId) {
    return outboxFromRow(this.database.prepare("SELECT * FROM outbox WHERE outbox_id = ?").get(outboxId));
  }

  updateOutboxEvent(outboxId, patch = {}) {
    const current = this.getOutboxEvent(outboxId);
    if (!current) throw new Error(`outbox event not found: ${outboxId}`);
    const now = this.now();
    this.database.prepare(`
      UPDATE outbox SET payload_json = ?, status = ?, attempts = ?, available_at = ?, locked_at = ?,
        delivered_at = ?, last_error_json = ?, updated_at = ? WHERE outbox_id = ?
    `).run(
      patch.payload === undefined ? json(current.payload) : json(patch.payload),
      asText(patch.status ?? current.status, 80),
      patch.attempts === undefined ? current.attempts : asNonNegativeInteger(patch.attempts) ?? 0,
      asText(patch.availableAt ?? current.availableAt, 80),
      patch.lockedAt === undefined ? current.lockedAt : asText(patch.lockedAt, 80),
      patch.deliveredAt === undefined ? current.deliveredAt : asText(patch.deliveredAt, 80),
      patch.lastError === undefined ? json(current.lastError) : json(patch.lastError),
      now,
      outboxId
    );
    return this.getOutboxEvent(outboxId);
  }

  listPendingOutbox({ now = this.now(), limit = DEFAULT_LIMIT, offset = 0 } = {}) {
    return this.database.prepare(`
      SELECT * FROM outbox
      WHERE status IN ('pending', 'retry_wait') AND available_at <= ?
      ORDER BY available_at, created_at, outbox_id LIMIT ? OFFSET ?
    `).all(now, finiteLimit(limit), finiteOffset(offset)).map(outboxFromRow);
  }

  #appendAudit(input = {}) {
    const now = this.now();
    const auditId = asText(input.auditId, 256) ?? this.idFactory();
    const action = asText(input.action, 160);
    if (!action) throw new TypeError("audit action is required");
    this.database.prepare(`
      INSERT INTO audit_events(
        audit_id, actor, action, target_type, target_id, run_id, outcome,
        details_json, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      auditId, asText(input.actor, 256) ?? "system", action,
      asText(input.targetType, 160), asText(input.targetId, 256), asText(input.runId, 256),
      asText(input.outcome, 80) ?? "success", json(input.details),
      asText(input.occurredAt, 80) ?? now, now
    );
    return auditFromRow(this.database.prepare("SELECT * FROM audit_events WHERE audit_id = ?").get(auditId));
  }

  appendAudit(input = {}) {
    return this.#appendAudit(input);
  }

  listAuditEvents({ runId, action, actor, targetType, targetId, limit = DEFAULT_LIMIT, offset = 0 } = {}) {
    const clauses = [];
    const params = [];
    for (const [column, value] of [
      ["run_id", runId], ["action", action], ["actor", actor],
      ["target_type", targetType], ["target_id", targetId]
    ]) {
      if (value) { clauses.push(`${column} = ?`); params.push(value); }
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database.prepare(`SELECT * FROM audit_events ${where} ORDER BY occurred_at DESC, audit_id DESC LIMIT ? OFFSET ?`)
      .all(...params, finiteLimit(limit), finiteOffset(offset)).map(auditFromRow);
  }
}

export function createDatabase(databasePath, options) {
  return new DatabaseStore(databasePath, options).init();
}
