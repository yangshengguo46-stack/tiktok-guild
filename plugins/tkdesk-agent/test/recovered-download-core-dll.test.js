import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RECOVERED_DOWNLOAD_CORE_DLL_PROFILE,
  downloadRecoveredCoreDLL
} from "../mcp/core/recovered-download-core-dll.js";

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tkdesk-core-dll-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("recovered DownloadCoreDLL uses the exact path and atomically stores an opaque bundle", async (t) => {
  const targetDirectory = await temporaryDirectory(t);
  const bundle = Buffer.from("encrypted-user-owned-country-bundle");
  const calls = [];
  const result = await downloadRecoveredCoreDLL({
    authorizationSource: "user_owned_runtime",
    baseUrl: "https://user-owned.example.test/api",
    targetDirectory,
    proxyUrl: "http://127.0.0.1:10831",
    async request(url, options) {
      calls.push({ url, options });
      return new Response(bundle, { status: 200 });
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://user-owned.example.test/api/Core/Core.dll");
  assert.deepEqual(calls[0].options, {
    method: "GET",
    proxyUrl: "http://127.0.0.1:10831",
    signal: undefined
  });
  assert.equal(result.status, "downloaded_not_activated");
  assert.equal(result.supplierAuthorizationReused, false);
  assert.deepEqual(await readFile(path.join(targetDirectory, "Core.dll")), bundle);
  assert.equal((await stat(path.join(targetDirectory, "Core.dll"))).mode & 0o777, 0o600);
});

test("recovered DownloadCoreDLL rejects supplier/unknown authorization sources before I/O", async (t) => {
  const targetDirectory = await temporaryDirectory(t);
  let requested = false;
  await assert.rejects(
    downloadRecoveredCoreDLL({
      authorizationSource: "legacy_supplier_session",
      baseUrl: "https://legacy.example.test",
      targetDirectory,
      async request() {
        requested = true;
      }
    }),
    (error) => error.code === "core_bundle_user_authorization_required"
  );
  assert.equal(requested, false);
});

test("recovered DownloadCoreDLL keeps the previous file on HTTP and size failures", async (t) => {
  const targetDirectory = await temporaryDirectory(t);
  const destinationPath = path.join(targetDirectory, "Core.dll");
  await writeFile(destinationPath, "previous", { mode: 0o600 });

  await assert.rejects(
    downloadRecoveredCoreDLL({
      authorizationSource: "user_owned_runtime",
      baseUrl: "https://user-owned.example.test",
      targetDirectory,
      async request() {
        return new Response("not found", { status: 404 });
      }
    }),
    (error) => error.code === "core_bundle_http_status_invalid" && error.status === 404
  );
  assert.equal(await readFile(destinationPath, "utf8"), "previous");

  await assert.rejects(
    downloadRecoveredCoreDLL({
      authorizationSource: "user_owned_runtime",
      baseUrl: "https://user-owned.example.test",
      targetDirectory,
      maxBytes: 3,
      async request() {
        return new Response("four", { status: 200 });
      }
    }),
    (error) => error.code === "core_bundle_too_large"
  );
  assert.equal(await readFile(destinationPath, "utf8"), "previous");
});

test("recovered DownloadCoreDLL profile exposes mechanism but no supplier authorization", () => {
  assert.deepEqual({
    path: RECOVERED_DOWNLOAD_CORE_DLL_PROFILE.requestPath,
    status: RECOVERED_DOWNLOAD_CORE_DLL_PROFILE.successStatus,
    filename: RECOVERED_DOWNLOAD_CORE_DLL_PROFILE.localFilename,
    next: RECOVERED_DOWNLOAD_CORE_DLL_PROFILE.nextFunction,
    acceptsRawCredentials: RECOVERED_DOWNLOAD_CORE_DLL_PROFILE.acceptsRawCredentials,
    supplierAuthorizationReusable: RECOVERED_DOWNLOAD_CORE_DLL_PROFILE.supplierAuthorizationReusable
  }, {
    path: "/Core/Core.dll",
    status: 200,
    filename: "Core.dll",
    next: "playwright-go/countryloader.LoadCountryData",
    acceptsRawCredentials: false,
    supplierAuthorizationReusable: false
  });
});
