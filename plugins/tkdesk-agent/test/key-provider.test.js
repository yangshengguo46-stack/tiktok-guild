import assert from "node:assert/strict";
import test from "node:test";
import {
  CORE_KEYCHAIN_SERVICE,
  CORE_MASTER_KEY_BYTES,
  MacOSKeychainKeyProvider,
  coreKeychainAccount
} from "../mcp/core/key-provider.js";

function result(exitCode, stdout = "", stderr = "") {
  return {
    exitCode,
    stdout: Buffer.from(stdout, "utf8"),
    stderr: Buffer.from(stderr, "utf8")
  };
}

test("macOS Keychain provider reads a 32-byte key without putting it in argv", async () => {
  const expected = Buffer.alloc(CORE_MASTER_KEY_BYTES, 0x5a);
  const encoded = expected.toString("base64");
  const calls = [];
  const provider = new MacOSKeychainKeyProvider({
    dataDirectory: "/tmp/tkdesk-key-provider-read",
    platform: "darwin",
    runner: async (executable, args, options) => {
      calls.push({ executable, args: [...args], options });
      return result(0, `${encoded}\n`);
    }
  });

  const key = await provider.getKey();
  assert.deepEqual(key, expected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, "/usr/bin/security");
  assert.deepEqual(calls[0].args.slice(0, 1), ["find-generic-password"]);
  assert.equal(calls[0].args.includes(CORE_KEYCHAIN_SERVICE), true);
  assert.equal(JSON.stringify(calls[0].args).includes(encoded), false);
  assert.equal(calls[0].options.stdin, undefined);
  key.fill(0);
});

test("macOS Keychain provider creates a random key through prompted stdin only", async () => {
  const expected = Buffer.alloc(CORE_MASTER_KEY_BYTES, 0x31);
  const encoded = expected.toString("base64");
  const calls = [];
  const provider = new MacOSKeychainKeyProvider({
    dataDirectory: "/tmp/tkdesk-key-provider-create",
    platform: "darwin",
    randomBytes: () => Buffer.from(expected),
    runner: async (executable, args, options = {}) => {
      calls.push({ executable, args: [...args], stdin: options.stdin ? Buffer.from(options.stdin) : null });
      if (args[0] === "find-generic-password") return result(44, "", "item not found");
      if (args[0] === "add-generic-password") return result(0);
      throw new Error("unexpected command");
    }
  });

  const key = await provider.getOrCreateKey();
  assert.deepEqual(key, expected);
  assert.equal(calls.length, 2);
  const add = calls[1];
  assert.equal(add.args.at(-1), "-w");
  assert.equal(add.args.includes("-A"), false);
  assert.equal(add.args.includes("-U"), false);
  assert.equal(JSON.stringify(add.args).includes(encoded), false);
  assert.equal(add.stdin.toString("ascii"), `${encoded}\n`);
  add.stdin.fill(0);
  key.fill(0);
});

test("macOS Keychain provider fails closed off macOS with no file fallback", async () => {
  let called = false;
  const provider = new MacOSKeychainKeyProvider({
    dataDirectory: "/tmp/tkdesk-key-provider-linux",
    platform: "linux",
    runner: async () => {
      called = true;
      return result(0);
    }
  });

  await assert.rejects(
    provider.getOrCreateKey(),
    (error) => error.code === "core_keychain_unsupported"
  );
  assert.equal(called, false);
  assert.deepEqual(await provider.status(), { state: "unsupported", available: false });
});

test("macOS Keychain provider rejects malformed values and redacts command failures", async () => {
  const malformed = new MacOSKeychainKeyProvider({
    dataDirectory: "/tmp/tkdesk-key-provider-malformed",
    platform: "darwin",
    runner: async () => result(0, Buffer.alloc(31, 1).toString("base64"))
  });
  await assert.rejects(
    malformed.getKey(),
    (error) => error.code === "core_keychain_key_invalid"
  );

  const sentinel = "SHOULD_NOT_APPEAR_IN_ERROR";
  const failed = new MacOSKeychainKeyProvider({
    dataDirectory: "/tmp/tkdesk-key-provider-failed",
    platform: "darwin",
    runner: async () => result(1, sentinel, sentinel)
  });
  await assert.rejects(failed.getKey(), (error) => {
    assert.equal(error.code, "core_keychain_read_failed");
    assert.equal(String(error).includes(sentinel), false);
    return true;
  });
});

test("Keychain account is stable per resolved data directory without exposing its path", () => {
  const first = coreKeychainAccount("/tmp/tkdesk-key-provider-account/../account");
  const second = coreKeychainAccount("/tmp/account");
  assert.equal(first, second);
  assert.match(first, /^core-v1-[a-f0-9]{32}$/);
  assert.equal(first.includes("/tmp"), false);
});
