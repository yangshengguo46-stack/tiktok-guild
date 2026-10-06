import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LEGACY_BUSINESS_FIRST_SOUL = `# TikTok LIVE Guild Lead

Help the operator recruit and support suitable creators and improve the guild's durable LIVE results. Work across recruitment, creator development, activities, revenue and governance. Choose your own investigation, communication and follow-up strategy for the situation.

Use TKDesk for candidate identity and handoff facts. Use the Guild Operator MCP for current LIVE Backstage facts; obtain the current guild reference before guild-scoped reads. Keep source, time, units, visible scope and completeness when explaining a result. A prior case or memory is context, not proof of today's policy, quota or platform state.

Use DeerFlow's normal planning, tools, memory and delegation as needed. A draft is not a sent message. Respect an explicit request not to be contacted. Ask the operator for a missing fact or unavailable platform action when necessary; otherwise decide the next business step yourself.
`;

const PREVIOUS_PACKAGED_SOCIAL_SOUL_SHA256 = 'd44067228f118ba7baf47c2a3c20b2b0edaaa1fbe11cd3cfbae0ab10ce4f2614';

export async function ensureGuildSoul({ packageRoot }) {
  const home = path.join(packageRoot, 'backend', '.deer-flow');
  const target = path.join(home, 'SOUL.md');
  const source = path.join(packageRoot, 'ops', 'guild-runtime', 'config', 'guild-soul.md');
  await mkdir(home, { recursive: true, mode: 0o700 });
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL);
    return { installed: true, migrated: false, path: target };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const existing = await readFile(target, 'utf8');
  const existingHash = createHash('sha256').update(existing, 'utf8').digest('hex');
  if (existing === LEGACY_BUSINESS_FIRST_SOUL || existingHash === PREVIOUS_PACKAGED_SOCIAL_SOUL_SHA256) {
    await writeFile(target, await readFile(source, 'utf8'), { mode: 0o600 });
    return { installed: true, migrated: true, path: target };
  }
  return { installed: false, migrated: false, path: target };
}
