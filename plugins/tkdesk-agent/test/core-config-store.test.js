import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CoreConfigStore } from "../mcp/core/core-config-store.js";
import { runtimePaths } from "../mcp/core/runtime-paths.js";

class MemoryKeyProvider {
  constructor(key = Buffer.alloc(32, 0x42)) {
    this.key = Buffer.from(key);
    this.created = 0;
    this.reads = 0;
  }

  async getKey() {
    this.reads += 1;
    return this.key ? Buffer.from(this.key) : null;
  }

  async getOrCreateKey() {
    this.created += 1;
    if (!this.key) this.key = Buffer.alloc(32, 0x42);
    return Buffer.from(this.key);
  }
}

async function withStore(t, callback) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-core-config-"));
  const keyProvider = new MemoryKeyProvider();
  const store = new CoreConfigStore({
    dataDirectory,
    keyProvider,
    now: () => new Date("2026-08-23T04:00:00.000Z")
  });
  t.after(async () => rm(dataDirectory, { recursive: true, force: true }));
  await callback({ store, keyProvider, dataDirectory, paths: runtimePaths(dataDirectory) });
}

test("CoreConfigStore stays uninitialized without touching the key provider", async (t) => {
  await withStore(t, async ({ store, keyProvider, paths }) => {
    const status = await store.status();
    assert.equal(status.state, "uninitialized");
    assert.equal(status.mobileAuthorization.state, "missing");

    const resolved = await store.resolveMobileAuthorization({
      marketRegion: "MENA",
      countryCode: "SA",
      endpointProfileId: "tkdesk-country-bundle-mena-v1"
    });
    assert.equal(resolved.status, "missing");

    const cleared = await store.clearMobileAuthorization();
    assert.equal(cleared.state, "uninitialized");
    assert.equal(keyProvider.reads, 0);
    assert.equal(keyProvider.created, 0);
    assert.deepEqual(await readdir(paths.coreDirectory), []);
  });
});

test("invalid mobile authorization input cannot initialize Core or Keychain state", async (t) => {
  await withStore(t, async ({ store, keyProvider, paths }) => {
    const common = {
      value: Buffer.from("USER_OWNED_TEST_TOKEN_1234567890"),
      marketRegion: "MENA",
      provenance: "user_owned_local_secure_terminal"
    };
    await assert.rejects(
      store.installMobileAuthorization({ ...common, countryCodes: ["ZZ"] }),
      (error) => error.code === "mobile_authorization_scope_unsupported"
    );
    await assert.rejects(
      store.installMobileAuthorization({
        ...common,
        countryCodes: ["SA"],
        expiresAt: "2026-08-22T04:00:00.000Z"
      }),
      (error) => error.code === "mobile_authorization_expiry_invalid"
    );
    assert.equal(keyProvider.reads, 0);
    assert.equal(keyProvider.created, 0);
    await assert.rejects(readdir(paths.coreDirectory), (error) => error.code === "ENOENT");
    common.value.fill(0);
  });
});

test("CoreConfigStore encrypts with an injected provider and never writes a local key file", async (t) => {
  await withStore(t, async ({ store, keyProvider, paths }) => {
    const status = await store.initialize();
    assert.equal(status.state, "ready");
    assert.equal(status.mobileAuthorization.state, "missing");
    assert.equal(keyProvider.created, 1);

    const names = await readdir(paths.coreDirectory);
    assert.deepEqual(names, ["Core.tkd"]);
    assert.equal(Object.hasOwn(paths, "coreKeyPath"), false);
    assert.equal((await stat(paths.coreDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.coreBundlePath)).mode & 0o777, 0o600);
  });
});

test("CoreConfigStore returns a caller-clearable Buffer while all public state stays redacted", async (t) => {
  await withStore(t, async ({ store, paths }) => {
    await store.initialize();
    const secretText = "USER_OWNED_TEST_TOKEN_1234567890";
    const input = Buffer.from(secretText, "utf8");
    try {
      const installed = await store.installMobileAuthorization({
        value: input,
        marketRegion: "MENA",
        countryCodes: ["SA", "QA", "EG"],
        expiresAt: "2026-09-23T04:00:00.000Z",
        provenance: "user_owned_local_secure_terminal"
      });
      assert.equal(installed.mobileAuthorization.state, "ready");
      assert.equal(JSON.stringify(installed).includes(secretText), false);

      const ciphertext = await readFile(paths.coreBundlePath);
      assert.equal(ciphertext.includes(Buffer.from(secretText, "utf8")), false);

      const resolved = await store.resolveMobileAuthorization({
        marketRegion: "MENA",
        countryCode: "SA",
        endpointProfileId: "tkdesk-country-bundle-mena-v1"
      });
      assert.equal(resolved.status, "ready");
      assert.equal(Buffer.isBuffer(resolved.value), true);
      assert.equal(resolved.value.toString("utf8"), secretText);
      resolved.value.fill(0);
      assert.equal(resolved.value.every((byte) => byte === 0), true);

      const cleared = await store.clearMobileAuthorization();
      assert.equal(cleared.mobileAuthorization.state, "missing");
    } finally {
      input.fill(0);
    }
  });
});

test("CoreConfigStore fails closed when an existing bundle loses its Keychain key", async (t) => {
  await withStore(t, async ({ store, keyProvider }) => {
    await store.initialize();
    keyProvider.key.fill(0);
    keyProvider.key = null;
    const status = await store.status();
    assert.equal(status.state, "invalid");
    assert.equal(status.errorCode, "core_keychain_key_missing");
    assert.equal(status.mobileAuthorization.configured, false);
  });
});
