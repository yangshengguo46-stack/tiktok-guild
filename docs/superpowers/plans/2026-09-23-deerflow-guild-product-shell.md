# TikTok Guild DeerFlow Product Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make native DeerFlow product changes reproducible and add a simple Guild Workbench entry immediately below New Chat, without inventing backend metrics.

**Architecture:** Keep the official pinned DeerFlow checkout as an immutable base and store its product delta as one cumulative patch in the tracked local package. That patch changes DeerFlow's native frontend navigation and adds a read-only Workbench page with an honest unavailable state; direct, evidenced overview data is a separate plan after the Guild Operator live response contract is captured.

**Tech Stack:** Node.js 22.16+, Git patch application, Next.js 16, React 19, TypeScript, pnpm 10.26.2, Node test runner, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-23-tiktok-guild-deerflow-product-design.md`

## Global Constraints

- Do not add a Custom Agent as the public product entry; this is a DeerFlow product change.
- Keep New Chat as the main entry. Workbench is a separate read-only page; no creator list or chat transcript in its UI.
- Do not add a Worker, Rust bridge, Guild ledger, projection database, container, or real TikTok write action.
- Preserve the official DeerFlow base commit `769589e8daee14c2587a634b6b43bd96471a41a1` and official origin URL.
- Existing `.agents/coordination.md` and `outputs/` changes are user-owned and must not be staged or edited.
- This plan covers only the first independently testable product slice. Separate plans cover proven overview fields, guild business state, and the TikTok user channel with admin/user authorization.

## File Structure

- `ops/deerflow-native-guild/src/product-patches.mjs`: apply or verify the one cumulative product patch against the pinned checkout.
- `ops/deerflow-native-guild/scripts/bootstrap.mjs`: apply patches after base verification and before dependency install.
- `ops/deerflow-native-guild/scripts/doctor.mjs`: verify that every declared patch is applied.
- `ops/deerflow-native-guild/config/local-manifest.json`: explicit zero-or-one product patch entry.
- `ops/deerflow-native-guild/patches/0001-feat-add-guild-workbench.patch`: generated, tracked product delta for the pinned DeerFlow source.
- Pinned DeerFlow `frontend/src/components/workspace/workspace-header.tsx`: New Chat followed by Workbench link.
- Pinned DeerFlow `frontend/src/app/workspace/guild/page.tsx`: native read-only Workbench page.
- Pinned DeerFlow `frontend/src/components/workspace/workspace-container.tsx`: Workbench breadcrumb label.
- Pinned DeerFlow `frontend/src/core/i18n/locales/{types,en-US,zh-CN}.ts`: localized Workbench strings.
- Pinned DeerFlow `frontend/tests/e2e/sidebar.spec.ts`: navigation and empty-state acceptance.

---

### Task 1: Reproducible Cumulative Product Patch

**Files:**
- Create: `ops/deerflow-native-guild/src/product-patches.mjs`
- Modify: `ops/deerflow-native-guild/scripts/bootstrap.mjs`
- Modify: `ops/deerflow-native-guild/scripts/doctor.mjs`
- Modify: `ops/deerflow-native-guild/config/local-manifest.json`
- Test: `ops/deerflow-native-guild/test/product-patches.test.mjs`

**Interfaces:**
- Consumes: the verified base checkout path and `manifest.product_patches: string[]`.
- Produces: `applyProductPatches({ packageRoot, destination, patches, run, pathExists, pathInfo }) -> Promise<void>` and `verifyProductPatches({ packageRoot, destination, patches, run, pathExists, pathInfo }) -> Promise<void>`; the last two filesystem dependencies have production defaults and are injected by tests.
- The manifest accepts zero or one package-relative patch path within `patches/`. Future product changes regenerate that single cumulative patch from the pinned base. Re-running bootstrap on an already patched checkout is idempotent; an incompatible patch fails without overwriting files. Unrelated local source edits are not validated by this patch check and must not be treated as part of the tracked product.

- [ ] **Step 1: Write failing tests for apply, already-applied, conflict, and path escape.**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyProductPatches } from '../src/product-patches.mjs';

test('applies one declared patch once', async () => {
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args.includes('--reverse')) return { code: 1, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  await applyProductPatches({ packageRoot: '/tmp/guild', destination: '/tmp/guild/.runtime/deer-flow', patches: ['patches/0001-example.patch'], run, pathExists: async () => true, pathInfo: async () => ({ isFile: () => true, isSymbolicLink: () => false }) });
  assert.equal(calls.filter((args) => args.includes('--check')).length, 2);
  assert.equal(calls.filter((args) => args.includes('apply') && !args.includes('--check')).length, 1);
});

test('rejects a patch outside the package patch directory', async () => {
  await assert.rejects(
    applyProductPatches({ packageRoot: '/tmp/guild', destination: '/tmp/guild/.runtime/deer-flow', patches: ['../outside.patch'], run: async () => { throw new Error('must not run'); }, pathExists: async () => true, pathInfo: async () => ({ isFile: () => true, isSymbolicLink: () => false }) }),
    /patch path must stay inside/i,
  );
});

test('does not reapply a patch already present', async () => {
  const calls = [];
  await applyProductPatches({
    packageRoot: '/tmp/guild', destination: '/tmp/guild/.runtime/deer-flow',
    patches: ['patches/0001-example.patch'],
    run: async (_command, args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; },
    pathExists: async () => true,
    pathInfo: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes('--reverse'), true);
});

test('rejects a conflict without applying the patch', async () => {
  const calls = [];
  await assert.rejects(
    applyProductPatches({
      packageRoot: '/tmp/guild', destination: '/tmp/guild/.runtime/deer-flow',
      patches: ['patches/0001-example.patch'],
      run: async (_command, args) => { calls.push(args); return { code: 1, stdout: '', stderr: '' }; },
      pathExists: async () => true,
      pathInfo: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
    }),
    /product patch conflicts/i,
  );
  assert.equal(calls.every((args) => args.includes('--check')), true);
});
```

- [ ] **Step 2: Run the focused test and confirm failure.**

```sh
cd ops/deerflow-native-guild
node --test test/product-patches.test.mjs
```

Expected: module import fails because `product-patches.mjs` does not exist.

- [ ] **Step 3: Implement the minimal patch manager and wire bootstrap/doctor.**

```js
import { access, lstat } from 'node:fs/promises';
import path from 'node:path';

const defaultPathExists = async (value) => {
  try { await access(value); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};

async function paths({ packageRoot, patches, pathExists, pathInfo }) {
  if (patches.length > 1) throw new Error('Only one cumulative product patch is supported');
  const patchRoot = path.resolve(packageRoot, 'patches');
  const resolved = [];
  for (const entry of patches) {
    if (!/^patches\/[0-9]{4}-[a-z0-9-]+\.patch$/u.test(entry)) throw new Error('Patch path must stay inside patches/');
    const patchPath = path.resolve(packageRoot, entry);
    if (!patchPath.startsWith(`${patchRoot}${path.sep}`) || !await pathExists(patchPath)) throw new Error(`Missing product patch: ${entry}`);
    const info = await pathInfo(patchPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Invalid product patch: ${entry}`);
    resolved.push(patchPath);
  }
  return resolved;
}

export async function applyProductPatches({ packageRoot, destination, patches, run, pathExists = defaultPathExists, pathInfo = lstat }) {
  for (const patchPath of await paths({ packageRoot, patches, pathExists, pathInfo })) {
    const reverse = await run('git', ['-C', destination, 'apply', '--reverse', '--check', patchPath]);
    if (reverse.code === 0) continue;
    const forward = await run('git', ['-C', destination, 'apply', '--check', patchPath]);
    if (forward.code !== 0) throw new Error(`Product patch conflicts: ${patchPath}`);
    const applied = await run('git', ['-C', destination, 'apply', patchPath]);
    if (applied.code !== 0) throw new Error(`Product patch failed: ${patchPath}`);
  }
}

export async function verifyProductPatches({ packageRoot, destination, patches, run, pathExists = defaultPathExists, pathInfo = lstat }) {
  for (const patchPath of await paths({ packageRoot, patches, pathExists, pathInfo })) {
    const result = await run('git', ['-C', destination, 'apply', '--reverse', '--check', patchPath]);
    if (result.code !== 0) throw new Error(`Product patch is not applied: ${patchPath}`);
  }
}
```

Bootstrap calls `applyProductPatches({ packageRoot: root, destination, patches: loaded.manifest.product_patches ?? [], run })` after exact origin/HEAD validation and before `make install`; doctor calls `verifyProductPatches` after its `deerflow_head` check. Start the manifest with `"product_patches": []`, so the original checkout remains runnable until Task 2 adds the patch.

- [ ] **Step 4: Run focused and package tests.**

```sh
cd ops/deerflow-native-guild
node --test test/product-patches.test.mjs
npm test
```

Expected: all tests pass, existing pinned-commit and MCP catalog tests unchanged.

- [ ] **Step 5: Commit only this task's files.**

```sh
git add ops/deerflow-native-guild/src/product-patches.mjs ops/deerflow-native-guild/scripts/bootstrap.mjs ops/deerflow-native-guild/scripts/doctor.mjs ops/deerflow-native-guild/config/local-manifest.json ops/deerflow-native-guild/test/product-patches.test.mjs
git commit -m "feat(deerflow): support tracked product patches"
```

### Task 2: Native Guild Workbench Entry and Honest Empty State

**Files:**
- Modify in isolated DeerFlow source worktree: `frontend/src/components/workspace/workspace-header.tsx`
- Create in isolated DeerFlow source worktree: `frontend/src/app/workspace/guild/page.tsx`
- Modify in isolated DeerFlow source worktree: `frontend/src/components/workspace/workspace-container.tsx`
- Modify in isolated DeerFlow source worktree: `frontend/src/core/i18n/locales/types.ts`, `en-US.ts`, `zh-CN.ts`
- Test in isolated DeerFlow source worktree: `frontend/tests/e2e/sidebar.spec.ts`
- Create in parent project: `ops/deerflow-native-guild/patches/0001-feat-add-guild-workbench.patch`
- Modify in parent project: `ops/deerflow-native-guild/config/local-manifest.json`

**Interfaces:**
- Consumes: Task 1 patch manager and DeerFlow's existing `WorkspaceContainer`, `WorkspaceHeader`, `WorkspaceBody`, and i18n API.
- Produces: native route `/workspace/guild`, sidebar link immediately after `/workspace/chats/new`, localized heading and explicit “backend overview not connected” state. No fabricated numeric values and no creator navigation.

- [ ] **Step 1: Add a failing E2E assertion to `sidebar.spec.ts`.**

```ts
test("Guild Workbench follows New Chat and stays separate from chat", async ({ page }) => {
  mockLangGraphAPI(page);
  await page.goto("/workspace/chats/new");
  const sidebar = page.locator("[data-sidebar='sidebar']");
  await expect(sidebar.locator("a[href='/workspace/guild']")).toBeVisible();
  const workspaceLinks = sidebar.locator("a[href^='/workspace/']");
  await expect(workspaceLinks.nth(0)).toHaveAttribute("href", "/workspace/chats/new");
  await expect(workspaceLinks.nth(1)).toHaveAttribute("href", "/workspace/guild");
  await sidebar.locator("a[href='/workspace/guild']").click();
  await expect(page).toHaveURL(/\/workspace\/guild$/);
  await expect(page.getByRole("heading", { name: "Guild Workbench" })).toBeVisible();
  await expect(page.getByText("Overview data is not connected yet")).toBeVisible();
});
```

- [ ] **Step 2: Run the focused E2E and confirm the link is absent.**

```sh
cd frontend
pnpm exec playwright test tests/e2e/sidebar.spec.ts --grep "Guild Workbench follows"
```

Expected: failure because no `/workspace/guild` link exists.

- [ ] **Step 3: Add native navigation, route, and localization.**

```tsx
// workspace-header.tsx: a second SidebarMenuItem immediately after New Chat.
<SidebarMenuItem>
  <SidebarMenuButton isActive={pathname === "/workspace/guild"} asChild>
    <Link href="/workspace/guild"><LayoutDashboard size={16} /><span>{t.sidebar.guildWorkbench}</span></Link>
  </SidebarMenuButton>
</SidebarMenuItem>
```

```tsx
"use client";

import { WorkspaceBody, WorkspaceContainer, WorkspaceHeader } from "@/components/workspace/workspace-container";
import { useI18n } from "@/core/i18n/hooks";

export default function GuildWorkbenchPage() {
  const { t } = useI18n();
  return (
    <WorkspaceContainer>
      <WorkspaceHeader />
      <WorkspaceBody>
        <section className="w-full max-w-3xl p-6">
          <h1 className="text-2xl font-semibold">{t.sidebar.guildWorkbench}</h1>
          <p className="mt-4 text-muted-foreground">{t.guildWorkbench.overviewUnavailable}</p>
        </section>
      </WorkspaceBody>
    </WorkspaceContainer>
  );
}
```

Add `guildWorkbench: string` to the sidebar i18n type, `guildWorkbench: { overviewUnavailable: string }` to the root translation type, English `Guild Workbench` / `Overview data is not connected yet`, and Chinese `工作台` / `公会概览尚未接入`. Add `guild: true` to `LINKABLE_SECTIONS` and `segment === "guild"` to `nameOfSegment`. Do not add a chat-side panel or creator list.

- [ ] **Step 4: Run frontend checks, E2E, and review UI states.**

```sh
cd frontend
pnpm check
pnpm exec playwright test tests/e2e/sidebar.spec.ts
```

Expected: type/lint and sidebar E2E pass; the page renders in English and Chinese, including collapsed-sidebar mode.

- [ ] **Step 5: Export and register the product patch, then verify a clean bootstrap.**

Commit the isolated DeerFlow worktree delta with subject `feat: add guild workbench`, then export its single commit:

```sh
git format-patch -1 --output-directory '/Users/yangyucheng/Documents/ChatGPT/妹子攻略计划/ops/deerflow-native-guild/patches'
```

This subject generates `0001-feat-add-guild-workbench.patch`; add that exact package-relative path as the sole entry of `manifest.product_patches`. Bootstrap from a clean pinned checkout and run doctor; both must apply/verify the same patch without changing the pinned HEAD. Re-run bootstrap and verify it is idempotent. Later product changes regenerate this one cumulative patch from the pinned base rather than appending overlapping patches; if the previous patch is already applied, use a fresh verified checkout for the revised patch instead of mutating or resetting that checkout automatically.

```sh
cd ops/deerflow-native-guild
npm test
npm run bootstrap
npm run doctor
```

- [ ] **Step 6: Commit only the patch and manifest.**

```sh
git add ops/deerflow-native-guild/patches/0001-feat-add-guild-workbench.patch ops/deerflow-native-guild/config/local-manifest.json
git commit -m "feat(deerflow): add native guild workbench entry"
```

## Scope Boundary and Next Plans

This plan intentionally ends before live metrics, creator relationship state, and automatic TikTok messaging. Next, write separate plans after obtaining a sanitized, read-only Guild Operator overview fixture and a verified TikTok message/receipt contract. The dashboard must not label a value “today” until its source field and time range are proven. The admin/user split must be enforced server-side before any real creator message enters DeerFlow; this patch introduces no external message channel.
