import { EventEmitter } from "node:events";

export function createFakeBrowser({ launchError = null, launchGate = null } = {}) {
  const launches = [];
  const context = new EventEmitter();
  context.pages = () => [];
  context.newPage = async () => ({ url: () => "about:blank" });
  context.close = async () => context.emit("close");

  async function launchPersistentContext(profileDir, options) {
    launches.push({ profileDir, options });
    if (launchGate) await launchGate;
    if (launchError) throw launchError;
    return context;
  }

  return { launches, context, launchPersistentContext };
}
