import os from 'node:os';
import path from 'node:path';
import { GuildError } from '../errors.mjs';
import { createMutex, createOperationStore } from '../messaging/operation-store.mjs';

const DEFAULT_PROFILE_DIR = path.join(os.homedir(), '.codex', 'tiktok-live-guild-operator', 'browser-profile');
const OVERVIEW_URL = 'https://live-backstage.tiktok.com/portal/overview';
function interventionUrl(page) {
  try { const url = page?.url?.(); if (typeof url === 'string' && url.startsWith('https://live-backstage.tiktok.com/')) return url; } catch {}
  return OVERVIEW_URL;
}

export function createSessionOwner({ launchPersistentContext, profileDir = process.env.TIKTOK_GUILD_PROFILE_DIR || DEFAULT_PROFILE_DIR, transitionTimeoutMs = 30_000 }) {
  if (typeof launchPersistentContext !== 'function') throw new TypeError('launchPersistentContext must be a function.');
  if (!Number.isFinite(transitionTimeoutMs) || transitionTimeoutMs <= 0) throw new TypeError('A positive transition timeout is required.');
  const operationStore = createOperationStore({ profileDir });
  const withExclusive = createMutex();
  let state = 'stopped', context = null, runtimeMode = null, transition = null, lease = null;
  const getStatus = () => Object.freeze({ state, visible: state === 'running' && context !== null && runtimeMode === 'visible' });
  const releaseLease = () => { lease?.release(); lease = null; };
  const install = (launched, mode) => {
    context = launched; runtimeMode = mode; state = 'running';
    launched.once?.('close', () => { if (context === launched) { context = null; runtimeMode = null; state = 'stopped'; releaseLease(); } });
    return launched;
  };
  const transitionTo = (mode, navigateTo = null) => {
    if (transition) {
      if (transition.expired || transition.mode === mode) return transition.promise;
      return transition.promise.then(() => transitionTo(mode, navigateTo));
    }
    if (context && runtimeMode === mode) return Promise.resolve(context);
    const previous = context;
    context = null; runtimeMode = null; state = 'starting';
    const item = { mode, expired: false, promise: null, failedFence: false };
    let previousClosed = !previous;
    const timeoutError = new GuildError('session_transition_timeout', 'The browser transition timed out; its profile remains fenced until the pending launch or close settles.');
    let launched = null;
    const raw = (async () => {
      try {
        if (previous) { await previous.close?.(); previousClosed = true; }
        if (item.expired) throw timeoutError;
        if (mode === 'stopped') { releaseLease(); state = 'stopped'; return null; }
        lease ??= operationStore.acquireLease('browser');
        launched = await launchPersistentContext(profileDir, { headless: mode === 'headless' });
        if (!launched || typeof launched !== 'object') throw new TypeError('Browser launcher did not return a context.');
        if (item.expired) throw timeoutError;
        if (mode === 'visible') {
          const pages = typeof launched.pages === 'function' ? launched.pages() : [];
          const page = pages.at(-1) ?? await launched.newPage?.();
          if (page && navigateTo && typeof page.goto === 'function') { try { await page.goto(navigateTo, { waitUntil: 'domcontentloaded', timeout: 15_000 }); } catch {} }
          try { await page?.bringToFront?.(); } catch {}
        }
        if (item.expired) throw timeoutError;
        return install(launched, mode);
      } catch (error) {
        // Never release the profile while a timed-out launch/close still has
        // work in flight. This catch runs only after that work has settled.
        if (!previousClosed) { item.failedFence = true; state = 'error'; throw error; }
        if (launched) {
          try { await launched.close?.(); } catch { item.failedFence = true; state = 'error'; throw error; }
        }
        releaseLease(); context = null; runtimeMode = null; state = 'error';
        throw error;
      }
    })();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { item.expired = true; state = 'error'; reject(timeoutError); }, transitionTimeoutMs); });
    item.promise = Promise.race([raw, timeout]).finally(() => clearTimeout(timer));
    transition = item;
    // The bounded promise can reject early; the underlying transition remains
    // the barrier. Late contexts are closed before any next start is allowed.
    raw.then(() => { if (transition === item && !item.failedFence) transition = null; }, () => { if (transition === item && !item.failedFence) transition = null; });
    return item.promise;
  };
  const ensureActive = () => transition ? transition.promise : context ? Promise.resolve(context) : transitionTo('headless');
  const reveal = page => transitionTo('visible', interventionUrl(page));
  const minimize = () => transitionTo('headless');
  const close = () => transitionTo('stopped');
  return Object.freeze({ profileDir, operationStore, withExclusive, getStatus, ensureActive, reveal, minimize, close });
}
