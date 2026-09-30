export function normalizeIdentity(value) {
  return typeof value === 'string' ? value.trim().replace(/^@/, '').toLowerCase() : null;
}
