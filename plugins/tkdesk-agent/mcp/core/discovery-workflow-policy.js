const TIKTOK_SOURCE = "tiktok_live";
const REGIONAL_METHOD = "regional_gift_ranking";
const PUBLIC_DIAGNOSTIC_METHOD = "public_live_cards";

export const SEMI_AUTO_WORKFLOW_EVIDENCE = Object.freeze({
  schemaVersion: "tkdesk.semi-auto-workflow.v1",
  workflowMode: "semi_auto",
  qualificationQueryState: "not_queried",
  automaticQualificationPerformed: false,
  recursiveRankingExpansionPerformed: false
});

/**
 * Keep mode semantics in one place. The implemented semi-auto path uses the
 * verified regional collector and stops before collection-backstage
 * qualification. Its current production integration proves the PC-Web Feed ->
 * DataProcessor branch; it must not be advertised as proof of the separate
 * original MobileProcessor whole-list sources. public_live_cards remains a
 * caller-selected non-ranking source and must never inherit regional parity evidence.
 */
export function discoveryWorkflowPolicy(run = {}) {
  const source = run?.source ?? null;
  const mode = run?.mode ?? "full_auto";
  const explicitMethod = run?.filters?.discoveryMethod ?? null;
  const discoveryMethod = source === TIKTOK_SOURCE
    ? (explicitMethod ?? REGIONAL_METHOD)
    : null;
  const regional = source === TIKTOK_SOURCE && discoveryMethod === REGIONAL_METHOD;
  const tikHubRankings = source === TIKTOK_SOURCE && discoveryMethod === 'tikhub_rankings';
  const fullAuto = mode === "full_auto";
  const publicCards = source === TIKTOK_SOURCE
    && discoveryMethod === PUBLIC_DIAGNOSTIC_METHOD;
  const publicDiagnostic = publicCards && !fullAuto;
  const semiAutoRegional = mode === "semi_auto" && regional;
  const automaticQualification = fullAuto;
  const recursiveRankingExpansion = fullAuto && regional;
  const requiresVerifiedRoute = automaticQualification || regional || tikHubRankings;
  const requiredRouteSessionTargets = [];
  if (regional || tikHubRankings || (publicCards && fullAuto)) requiredRouteSessionTargets.push("tiktok_discovery");
  if (automaticQualification) requiredRouteSessionTargets.push("collection_backstage");

  return Object.freeze({
    source,
    mode,
    discoveryMethod,
    regional,
    tikHubRankings,
    publicDiagnostic,
    semiAutoRegional,
    automaticQualification,
    recursiveRankingExpansion,
    requiresVerifiedRoute,
    requiredRouteSessionTargets: Object.freeze([...new Set(requiredRouteSessionTargets)]),
    workflowEvidence: semiAutoRegional ? SEMI_AUTO_WORKFLOW_EVIDENCE : null
  });
}

export function attachDiscoveryWorkflowEvidence(candidate, policy) {
  if (!policy?.workflowEvidence) return candidate;
  const workflow = policy.workflowEvidence;
  return {
    ...candidate,
    workflowMode: workflow.workflowMode,
    qualificationQueryState: workflow.qualificationQueryState,
    automaticQualificationPerformed: workflow.automaticQualificationPerformed,
    rawEvidence: {
      ...(candidate?.rawEvidence ?? {}),
      workflow
    }
  };
}
