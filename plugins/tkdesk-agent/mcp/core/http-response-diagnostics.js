// Project only bounded categories and measurements. Neither response text,
// arbitrary headers, request URLs nor exception messages cross this boundary.
export function safeContentType(value) {
  const type = typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
  return ["application/json", "text/html", "text/plain", "application/octet-stream"].includes(type)
    ? type : type ? "other" : null;
}

export function httpResponseDiagnostics(response, body, startedAt = Date.now()) {
  const status = typeof response?.status === "function" ? response.status() : response?.status;
  const elapsed = Number.isSafeInteger(response?.elapsedMs) ? response.elapsedMs : Date.now() - startedAt;
  const text = typeof body === "string" ? body : "";
  const trimmed = text.trimStart();
  return Object.freeze({
    httpStatus: Number.isSafeInteger(status) ? status : null,
    contentType: safeContentType(response?.contentType),
    bodyBytes: Buffer.byteLength(text, "utf8"),
    bodyKind: text.length === 0 ? "empty" : /^(?:<!doctype\s+html|<html\b)/i.test(trimmed) ? "html"
      : /^[{[]/.test(trimmed) ? "json_like" : "other",
    elapsedMs: Math.max(0, Math.min(3_600_000, elapsed))
  });
}

export function transportFailureDiagnostics(error, startedAt = Date.now()) {
  const inherited = error?.transportDiagnostics;
  const category = inherited?.category === "timeout" || error?.name === "TimeoutError"
    || error?.code === "ETIMEDOUT" || /timed out|timeout/i.test(String(error?.message ?? ""))
    ? "timeout" : "network_or_transport";
  const elapsed = Number.isSafeInteger(inherited?.elapsedMs) ? inherited.elapsedMs : Date.now() - startedAt;
  return Object.freeze({ category, elapsedMs: Math.max(0, Math.min(3_600_000, elapsed)) });
}
