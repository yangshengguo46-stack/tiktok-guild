import path from 'node:path';
import os from 'node:os';
import { GUILD_EXTENSIONS_CONFIG } from './constants.mjs';

export function buildRuntimeEnvironment({ packageRoot, environment = process.env }) {
  const root = path.resolve(packageRoot);
  const opsRoot = path.join(root, 'ops', 'guild-runtime');
  const pnpmBinRoot = path.join(opsRoot, '.runtime', 'tools', 'pnpm', 'node_modules', '.bin');
  const home = environment.HOME ?? os.homedir();
  const outreachStateRoot = environment.PUBLIC_OUTREACH_RUNTIME_ROOT
    ?? path.join(home, '.codex', 'tiktok-live-public-outreach');
  return {
    ...environment,
    CI: 'true',
    // The workbench is local-only during this phase, so /setup does not block
    // product verification. The backend ignores this flag in explicit production mode.
    DEER_FLOW_AUTH_DISABLED: '1',
    PATH: `${pnpmBinRoot}${path.delimiter}${environment.PATH ?? ''}`,
    DEER_FLOW_CONFIG_PATH: path.join(opsRoot, 'config', 'config.yaml'),
    DEER_FLOW_EXTENSIONS_CONFIG_PATH: path.join(opsRoot, 'config', GUILD_EXTENSIONS_CONFIG),
    DEER_FLOW_SKILLS_PATH: path.join(root, 'skills'),
    DEER_FLOW_HOME: path.join(root, 'backend', '.deer-flow'),
    DEER_FLOW_SOCIAL_ASSETS_PATH: path.join(
      root,
      'docs',
      'product',
      'creator-agent-final-persona-rev1',
    ),
    // Public outreach execution state is deliberately outside the repository.
    // The operator owns Android device execution; DeerFlow owns claims and receipts.
    PUBLIC_OUTREACH_OPERATOR_ROOT: environment.PUBLIC_OUTREACH_OPERATOR_ROOT
      ?? path.join(opsRoot, 'public-outreach-operator'),
    PUBLIC_OUTREACH_RUNTIME_ROOT: environment.PUBLIC_OUTREACH_RUNTIME_ROOT
      ?? outreachStateRoot,
    // The broker MCP is already isolated from the guild and collection
    // profiles. Keep these non-secret defaults in the runtime so `npm start`
    // does not silently launch an unconfigured broker; operators can still
    // override all three values in their shell for another broker identity.
    TIKTOK_BROKER_PROFILE_DIR: environment.TIKTOK_BROKER_PROFILE_DIR
      ?? path.join(environment.HOME ?? '', '.codex', 'tiktok-live-broker-operator', 'profile'),
    TIKTOK_BROKER_ACCOUNT_REF: environment.TIKTOK_BROKER_ACCOUNT_REF
      ?? 'affiliate:mira.creator_01',
    TIKTOK_BROKER_IDENTITY_TEXT: environment.TIKTOK_BROKER_IDENTITY_TEXT
      ?? 'Mira',
  };
}
