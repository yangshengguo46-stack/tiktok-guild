import { normalizeGuildError } from "./errors.mjs";

const VALID_SUCCESS = new Set(["ok", "partial"]);

export function successEnvelope({
  status = "ok",
  domain,
  child,
  data,
  evidence = [],
  completeness = { state: "complete", missing: [] },
  pagination = null
}) {
  if (!VALID_SUCCESS.has(status)) throw new TypeError("Success status must be ok or partial.");
  return Object.freeze({
    status,
    domain,
    child,
    data,
    evidence: Object.freeze([...evidence]),
    completeness,
    pagination,
    errors: Object.freeze([])
  });
}

export function errorEnvelope({ domain, child, error, evidence = [] }) {
  return Object.freeze({
    status: "error",
    domain,
    child,
    data: null,
    evidence: Object.freeze([...evidence]),
    completeness: Object.freeze({ state: "unavailable", missing: Object.freeze([child]) }),
    pagination: null,
    errors: Object.freeze([normalizeGuildError(error)])
  });
}

export function toolResult(envelope) {
  const summary = envelope.status === "error"
    ? `${envelope.domain}.${envelope.child ?? "discover"} failed: ${envelope.errors[0].message}`
    : `${envelope.domain}.${envelope.child ?? "discover"}: ${envelope.status}`;
  return {
    ...(envelope.status === "error" ? { isError: true } : {}),
    content: [{ type: "text", text: summary }],
    structuredContent: envelope
  };
}
