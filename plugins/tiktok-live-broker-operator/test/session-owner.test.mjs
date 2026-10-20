import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
function profile(t) { const directory=mkdtempSync(path.join(os.tmpdir(),"guild-session-")); t.after(()=>rmSync(directory,{recursive:true,force:true})); return directory; }

import { createSessionOwner } from "../src/session/session-owner.mjs";
import { createFakeBrowser } from "./support/fake-browser.mjs";

test("status is passive and concurrent starts share one headless session", async t => {
  const fake = createFakeBrowser();
  const owner = createSessionOwner({
    launchPersistentContext: fake.launchPersistentContext,
    profileDir: profile(t)
  });
  t.after(() => owner.close().catch(() => {}));

  assert.deepEqual(owner.getStatus(), { state: "stopped", visible: false });
  assert.equal(fake.launches.length, 0);

  const [left, right] = await Promise.all([owner.ensureActive(), owner.ensureActive()]);
  assert.equal(left, right);
  assert.equal(fake.launches.length, 1);
  assert.equal(fake.launches[0].options.headless, true);
  assert.equal(fake.launches[0].options.args, undefined);
  assert.equal(fake.launches[0].profileDir, owner.profileDir);
  assert.deepEqual(owner.getStatus(), { state: "running", visible: false });
});

test("login intervention relaunches the same profile visibly and returns to headless", async t => {
  const launches = [];
  const contexts = [];
  const profileDir = profile(t);
  const loginUrl = "https://live-backstage.tiktok.com/portal/login";
  const launchPersistentContext = async (launchedProfileDir, options) => {
    const context = new EventEmitter();
    const page = {
      navigations: [],
      url: () => options.headless ? loginUrl : "about:blank",
      async goto(url) { this.navigations.push(url); }
    };
    context.pages = () => [page];
    context.newPage = async () => page;
    context.close = async () => context.emit("close");
    launches.push({ profileDir: launchedProfileDir, options });
    contexts.push(context);
    return context;
  };
  const owner = createSessionOwner({
    launchPersistentContext,
    profileDir
  });
  t.after(() => owner.close().catch(() => {}));

  const background = await owner.ensureActive();
  const visible = await owner.reveal(background.pages()[0]);
  assert.deepEqual(owner.getStatus(), { state: "running", visible: true });
  assert.notEqual(visible, background);
  assert.equal(launches[1].profileDir, profileDir);
  assert.equal(launches[1].options.headless, false);
  assert.deepEqual(visible.pages()[0].navigations, [loginUrl]);

  const restored = await owner.minimize(visible.pages()[0]);
  assert.deepEqual(owner.getStatus(), { state: "running", visible: false });
  assert.notEqual(restored, visible);
  assert.deepEqual(launches.map(({ options }) => options.headless), [true, false, true]);
  assert.deepEqual(launches.map(({ profileDir: launchedProfileDir }) => launchedProfileDir), [profileDir, profileDir, profileDir]);
});

test("concurrent intervention requests open only one visible browser", async t => {
  const launches = [];
  let releaseVisible;
  const visibleGate = new Promise((resolve) => { releaseVisible = resolve; });
  const launchPersistentContext = async (_profileDir, options) => {
    launches.push(options);
    if (!options.headless) await visibleGate;
    const context = new EventEmitter();
    const page = { url: () => "https://live-backstage.tiktok.com/portal/login", async goto() {} };
    context.pages = () => [page];
    context.close = async () => context.emit("close");
    return context;
  };
  const owner = createSessionOwner({ launchPersistentContext, profileDir: profile(t) });
  const background = await owner.ensureActive();

  const first = owner.reveal(background.pages()[0]);
  const second = owner.reveal(background.pages()[0]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launches.length, 2);
  releaseVisible();

  assert.equal(await first, await second);
  assert.equal(launches.filter(({ headless }) => headless === false).length, 1);
});

test("a closed context returns the owner to stopped", async t => {
  const fake = createFakeBrowser();
  const owner = createSessionOwner({
    launchPersistentContext: fake.launchPersistentContext,
    profileDir: profile(t)
  });

  await owner.ensureActive();
  fake.context.emit("close");
  assert.deepEqual(owner.getStatus(), { state: "stopped", visible: false });
});

test("a launch failure is reported without opening another pending window", async t => {
  let rejectLaunch;
  const launchGate = new Promise((_, reject) => { rejectLaunch = reject; });
  const fake = createFakeBrowser({ launchGate });
  const owner = createSessionOwner({
    launchPersistentContext: fake.launchPersistentContext,
    profileDir: profile(t)
  });

  const first = owner.ensureActive();
  const second = owner.ensureActive();
  assert.equal(fake.launches.length, 1);
  rejectLaunch(new Error("browser unavailable"));
  await assert.rejects(first, /browser unavailable/);
  await assert.rejects(second, /browser unavailable/);
  assert.deepEqual(owner.getStatus(), { state: "error", visible: false });
});

test('a stalled launch times out while later starts stay fenced until it settles', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { default: os } = await import('node:os');
  const { default: path } = await import('node:path');
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'guild-timeout-'));
  t.after(() => rm(profileDir, { recursive: true, force: true }));
  let resolveLaunch, calls = 0, closes = 0;
  const gate = new Promise(r => { resolveLaunch = r; });
  const context = { close: async t => { closes++; } };
  const owner = createSessionOwner({ profileDir, transitionTimeoutMs: 20, launchPersistentContext: async t => { calls++; return gate; } });
  const outcome = await Promise.race([owner.ensureActive().then(() => 'launched', e => e.code), new Promise(r => setTimeout(() => r('hung'), 100))]);
  assert.equal(outcome, 'session_transition_timeout');
  const retry = owner.ensureActive().catch(e => e.code);
  await new Promise(r => setTimeout(r, 25));
  assert.equal(calls, 1);
  resolveLaunch(context);
  assert.equal(await retry, 'session_transition_timeout');
  await new Promise(r => setImmediate(r));
  assert.equal(closes, 1);
});

test('a stalled close fences the profile and cannot start a replacement context', async t => {
  const profileDir=profile(t);
  let calls=0, release;
  const gate=new Promise(r=>{release=r;});
  const owner=createSessionOwner({profileDir,transitionTimeoutMs:20,launchPersistentContext:async()=>{calls++;return {close:async()=>gate};}});
  await owner.ensureActive();
  await assert.rejects(owner.reveal(),e=>e.code==='session_transition_timeout');
  await assert.rejects(owner.ensureActive(),e=>e.code==='session_transition_timeout');
  assert.equal(calls,1);
  release(); await new Promise(r=>setImmediate(r));
  assert.equal(calls,1);
});

test('a close rejection keeps the unknown old context fenced', async t => {
  const profileDir=profile(t); let calls=0;
  const owner=createSessionOwner({profileDir,transitionTimeoutMs:30,launchPersistentContext:async()=>{calls++;return {close:async()=>{throw new Error('close outcome unknown');}};}});
  await owner.ensureActive();
  await assert.rejects(owner.reveal(),/close outcome unknown/);
  await assert.rejects(owner.ensureActive(),/close outcome unknown/);
  assert.equal(calls,1);
});
