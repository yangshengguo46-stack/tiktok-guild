import { randomUUID } from "node:crypto";
import { originalExecutableProfileForCountry } from "./original-country-config.js";
import { runOriginalCollector } from "./original-collector-runtime.js";

function invalidDisplay() {
  const error = new Error("地区显示配置必须来自原版目录，并匹配本次所选国家");
  error.code = "collection_display_variant_invalid";
  return error;
}

export function originalCollectorFailureState(code) {
  const safeCode = String(code ?? "").toLowerCase();
  if (/authentication_required|manual_verification/.test(safeCode)) return "authentication_required";
  if (/route_.*mismatch|route_restart_required|lane_evidence_mismatch|session_run_closed|session_unavailable|backend_quota_limit/.test(safeCode)) return "paused";
  return null;
}

/** Resolve public settings onto the original catalog; never accept request data. */
export function selectedOriginalCountryLanes({ route, filters = {} }) {
  const marketRegion = String(filters.marketRegion ?? filters.region ?? "").trim().toUpperCase();
  const countries = (filters.countryCodes ?? [filters.countryCode]).map(value => String(value).toUpperCase());
  const selections = filters.countryDisplayNames ?? [];
  if (!Array.isArray(selections) || selections.length > 3) throw invalidDisplay();
  const displayByCountry = new Map();
  for (const selection of selections) {
    const countryCode = String(selection?.countryCode ?? "").toUpperCase();
    if (!countries.includes(countryCode) || displayByCountry.has(countryCode)
      || typeof selection?.displayName !== "string"
      || Object.keys(selection).some(key => !["countryCode", "displayName"].includes(key))) throw invalidDisplay();
    displayByCountry.set(countryCode, selection.displayName);
  }
  return (route?.collectionLanes ?? []).filter(lane => countries.includes(lane.countryCode)).map(lane => {
    const profile = originalExecutableProfileForCountry({ marketRegion, countryCode: lane.countryCode, displayName: displayByCountry.get(lane.countryCode) ?? null });
    if (!profile) throw invalidDisplay();
    return { ...lane, displayName: profile.displayName };
  });
}

/** Each resume gets new HTTP jars; every engine exit drains/disposes its scope. */
export async function runOriginalCollectorWithSessions({ sessions, collector = runOriginalCollector, ...options }) {
  const scopeId = `${options.runId}:${randomUUID()}`;
  sessions.beginCountryWorkerRun(scopeId);
  try {
    return await collector(options);
  } finally {
    await sessions.endCountryWorkerRun(scopeId);
  }
}
