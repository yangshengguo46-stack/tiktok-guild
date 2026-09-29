export async function createDeerflowOutreachAdapter({ gatewayUrl = process.env.DEERFLOW_OUTREACH_GATEWAY_URL, ownerUserId = process.env.DEERFLOW_OUTREACH_OWNER_USER_ID, internalToken = process.env.DEERFLOW_OUTREACH_INTERNAL_TOKEN, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!gatewayUrl || !ownerUserId || !internalToken) throw new Error('Trusted runtime owner and Gateway authentication are required.');
  const url = new URL(gatewayUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid Gateway URL.');
  function validate(params) {
    if (params.owner_user_id !== undefined && params.owner_user_id !== ownerUserId) throw new Error('Owner identity cannot be overridden.');
    if (['receipt', 'receipt_payload', 'verified', 'provider_ref', 'verification_source', 'lease_owner', 'lease_token'].some((key) => Object.hasOwn(params, key))) throw new Error('Caller supplied receipts or execution leases are not accepted.');
    const { owner_user_id: ignored, ...body } = params; return body;
  }
  async function call(method, params = {}) {
    const body = validate(params);
    const response = await fetchImpl(new URL(`/api/public-outreach/native/${method}`, url), { method: 'POST', redirect: 'error', headers: {
      'Content-Type': 'application/json', 'X-DeerFlow-Internal-Token': internalToken, 'X-DeerFlow-Owner-User-Id': ownerUserId,
    }, body: JSON.stringify(body), signal: AbortSignal.timeout(150000) });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Native outreach call rejected.');
    return result;
  }
  return Object.fromEntries(['listSenderAccounts', 'registerSenderAccount', 'healthSenderAccount', 'disableSenderAccount', 'enqueueAction', 'getAction', 'claimAction', 'executeAction', 'completeAction', 'failAction', 'reconcileActions'].map((method) => [method, (params) => call(method, params)]));
}
