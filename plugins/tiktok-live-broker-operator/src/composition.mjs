import { chromium } from "playwright";

import { readView } from "./live/read-view.mjs";
import { getView } from "./live/view-registry.mjs";
import { createSessionOwner } from "./session/session-owner.mjs";

async function launchPersistentContext(profileDir, options) {
  return chromium.launchPersistentContext(profileDir, options);
}

export function createBrokerComposition({ profileDir, accountRef, identityText } = {}) {
  if (!profileDir || !accountRef || !identityText) {
    throw new TypeError("Broker profileDir, accountRef, and identityText are required.");
  }
  const sessionOwner = createSessionOwner({ launchPersistentContext, profileDir });
  return Object.freeze({
    sessionOwner,
    profileDir,
    operationStore: sessionOwner.operationStore,
    brokerAccountRef: accountRef,
    brokerIdentityText: identityText,
    liveReader: ({ page, domain, child, params, clock }) => readView({
      page,
      view: getView(domain, child),
      params,
      clock,
    }),
  });
}
