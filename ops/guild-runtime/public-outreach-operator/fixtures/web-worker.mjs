// Only the external Chromium boundary is substituted. The worker protocol,
// production resource composition and executors are the shipped code.
import { readFile } from 'node:fs/promises';
import { createProductionExecutor } from '../src/production-executor.mjs';
import { serveExecutionWorker } from '../src/worker-protocol.mjs';
import { PILOT_LOCATORS } from '../src/web/page-objects.mjs';
function page() {
  let opened = false; let liked = false; let followed = false;
  const receipts = { comment: [], message: [] }; const values = {};
  const element = (attrs = {}, content = '', click = async () => {}) => ({ isVisible: async () => opened, getAttribute: async (key) => attrs[key] ?? null, textContent: async () => content, click, fill: async (value) => { values[content] = value; } });
  const controls = {
    loggedInSender: element({ 'data-sender-handle': '@alice' }),
    profileRoot: element({ 'data-creator-uid': 'creator' }),
    creatorIdentity: element({ 'data-creator-uid': 'creator' }),
    likeButton: { ...element(), getAttribute: async (key) => key === 'aria-pressed' ? String(liked) : null, click: async () => { liked = true; } },
    followButton: { ...element(), getAttribute: async (key) => key === 'aria-pressed' ? String(followed) : null, click: async () => { followed = true; } },
  };
  for (const action of ['comment','message']) {
    controls[`${action}Input`] = element({}, action);
    controls[`${action}Submit`] = element({}, '', async () => receipts[action].push(element({ 'data-receipt-id': `new-${action}`, 'data-sender-handle': '@alice', 'data-creator-uid': 'creator' }, values[action])));
  }
  return { async goto(url) {
      if (url === 'https://www.cloudflare.com/cdn-cgi/trace') return { status: () => 200, text: async () => 'ip=203.0.113.10\nloc=US\n' };
      if (url !== 'https://www.tiktok.com/') throw Error('untrusted navigation');
      opened = true;
    }, async close() {},
    locator(selector) { const key = Object.keys(PILOT_LOCATORS).find((name) => PILOT_LOCATORS[name] === selector);
      const elements = key?.endsWith('Receipt') ? receipts[key.slice(0,-7)] : controls[key] ? [controls[key]] : [];
      const missing = { isVisible: async () => false };
      return { first: () => elements[0] ?? missing, last: () => elements.at(-1) ?? missing, nth: (index) => elements[index] ?? missing, count: async () => elements.length };
    }, waitForTimeout: async () => {} };
}
const config = JSON.parse(await readFile(process.env.DEERFLOW_OUTREACH_EXECUTION_CONFIG, 'utf8'));
serveExecutionWorker(createProductionExecutor({ config, runtimeRoot: process.env.DEERFLOW_OUTREACH_RUNTIME_ROOT,
  chromium: { launchPersistentContext: async () => ({ newPage: async () => page(), close: async () => {} }) },
}));
