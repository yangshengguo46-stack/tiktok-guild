export function normalizeIdentity(value) {
  return typeof value === 'string' ? value.trim().replace(/^@/, '').toLowerCase() : null;
}

export async function readIdentity(element, kind) {
  const attr = async (...names) => {
    for (const name of names) {
      const value = await element?.getAttribute?.(name);
      if (value) return String(value);
    }
    return null;
  };
  return {
    uid: await attr(`data-${kind}-uid`, `${kind}_uid`),
    handle: await attr(`data-${kind}-handle`, `${kind}_handle`),
  };
}

export function senderMatches(observed, externalRef) {
  if (!externalRef || !observed) return false;
  return externalRef.startsWith('@')
    ? normalizeIdentity(observed.handle) === normalizeIdentity(externalRef)
    : observed.uid === externalRef;
}

export async function receiptItem(element) {
  let identity = null;
  for (const name of ['data-receipt-id', 'data-action-id', 'data-comment-id', 'data-message-id', 'data-provider-marker']) {
    identity = await element?.getAttribute?.(name);
    if (identity) break;
  }
  return {
    identity: identity ? String(identity) : null,
    text: (await element?.textContent?.()) ?? '',
    sender: await readIdentity(element, 'sender'),
    creator: await readIdentity(element, 'creator'),
  };
}

export function freshMatchingItem(before, after, text, observedSender, creatorUid) {
  // Every visible item in the baseline needs an identity. Count or a changing
  // WebDriver element reference is not provider creation evidence.
  if (before.some((item) => !item.identity)) return null;
  const existing = new Set(before.map((item) => item.identity));
  return after.find((item) => item.identity && !existing.has(item.identity)
    && item.text.trim() === text.trim()
    && item.creator.uid === creatorUid
    && (observedSender.uid ? item.sender.uid === observedSender.uid
      : normalizeIdentity(item.sender.handle) === normalizeIdentity(observedSender.handle))) ?? null;
}
