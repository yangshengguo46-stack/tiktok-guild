import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { GuildError } from "../src/errors.mjs";
import { createHandlers } from "../src/handlers.mjs";
import { projectIdentity } from "../src/workspace/project-identity.mjs";
import { discoverGuild } from "../src/workspace/discover.mjs";

const IDENTITY_BODY = {
  union: { id: "103785", name: "Atlantis", country: "AE", region: "MENA" },
  user: { unionID: "103785", unionName: "Atlantis", roleType: 4 },
  roles: [{ id: "role-1", name: "Owner", orgID: "org-1", roleLevel: 1, roleStatus: 1, roleType: 4, roleTypeName: "Owner", unionID: "103785" }]
};

function fakeSessionOwner() {
  const page = {};
  const context = { pages: () => [page], newPage: async () => page };
  return {
    ensureCalls: 0,
    windowEvents: [],
    getStatus: () => ({ state: "stopped", visible: false }),
    async ensureActive() {
      this.ensureCalls += 1;
      return context;
    },
    async reveal(target) { this.windowEvents.push({ action: "reveal", target }); },
    async minimize(target) { this.windowEvents.push({ action: "minimize", target }); }
  };
}

test("identity projection preserves authorized guild identity", () => {
  assert.deepEqual(projectIdentity(IDENTITY_BODY), {
    guild_id: "103785",
    guild_name: "Atlantis",
    registered_country: "AE",
    portal_region: "MENA",
    account_role: 4,
    roles: IDENTITY_BODY.roles
  });
  assert.throws(
    () => projectIdentity({ ...IDENTITY_BODY, user: { ...IDENTITY_BODY.user, unionID: "other" } }),
    (error) => error.code === "adapter_mismatch"
  );
});

test("an empty startup identity is classified as login_required", () => {
  assert.throws(
    () => projectIdentity({
      union: { id: "", name: "", country: "", region: "" },
      user: { unionID: "", unionName: "", roleType: 0 },
      roles: []
    }),
    (error) => error.code === "login_required"
  );
});

test("passive status does not start a browser", async () => {
  const sessionOwner = fakeSessionOwner();
  const handlers = createHandlers({
    sessionOwner,
    guildDiscovery: async () => projectIdentity(IDENTITY_BODY),
    liveReader: async () => ({})
  });

  const result = await handlers.guild_workspace({ child: "get_status" });
  assert.equal(result.structuredContent.data.state, "stopped");
  assert.equal(sessionOwner.ensureCalls, 0);
});

test("active discovery scopes login_required to workspace", async () => {
  const sessionOwner = fakeSessionOwner();
  const handlers = createHandlers({
    sessionOwner,
    guildDiscovery: async () => { throw new GuildError("login_required", "Login is required."); },
    liveReader: async () => ({})
  });

  const result = await handlers.guild_workspace({});
  assert.equal(result.structuredContent.errors[0].code, "login_required");
  assert.equal(sessionOwner.ensureCalls, 1);
  assert.deepEqual(sessionOwner.windowEvents.map(({ action }) => action), ["reveal"]);
});

test("authenticated discovery returns an opaque ref and raw guild identity", async () => {
  const sessionOwner = fakeSessionOwner();
  const handlers = createHandlers({
    sessionOwner,
    guildDiscovery: async () => projectIdentity(IDENTITY_BODY),
    liveReader: async () => ({})
  });

  const result = await handlers.guild_workspace({});
  assert.equal(result.structuredContent.status, "ok");
  assert.equal(result.structuredContent.data.guild_id, "103785");
  assert.equal(result.structuredContent.data.guild_name, "Atlantis");
  assert.match(result.structuredContent.data.guild_ref, /^guild_[a-f0-9]{24}$/);
  assert.deepEqual(sessionOwner.windowEvents.map(({ action }) => action), ["minimize"]);
});

test("live discovery reads only the fixed startup response", async () => {
  class FakePage extends EventEmitter {
    constructor() {
      super();
      this.currentUrl = "about:blank";
    }
    url() { return this.currentUrl; }
    async goto(url) {
      this.currentUrl = url;
      this.emit("response", {
        url: () => "https://live-backstage.tiktok.com/creators/live/union_platform_api/agency/common/startup/",
        status: () => 200,
        headers: () => ({ "content-type": "application/json" }),
        body: async () => Buffer.from(JSON.stringify(IDENTITY_BODY))
      });
    }
    async waitForTimeout() {}
  }

  const result = await discoverGuild({ page: new FakePage() });
  assert.equal(result.guild_id, "103785");
  assert.equal(result.portal_region, "MENA");
});

test("live discovery waits for a delayed startup response", async () => {
  class DelayedPage extends EventEmitter {
    constructor() {
      super();
      this.currentUrl = "about:blank";
    }
    url() { return this.currentUrl; }
    async goto(url) {
      this.currentUrl = url;
      setTimeout(() => this.emit("response", {
        url: () => "https://live-backstage.tiktok.com/creators/live/union_platform_api/agency/common/startup/",
        status: () => 200,
        headers: async () => ({ "content-type": "application/json; charset=utf-8" }),
        body: async () => Buffer.from(JSON.stringify(IDENTITY_BODY))
      }), 300);
    }
    async waitForTimeout(milliseconds) {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
  }

  const result = await discoverGuild({ page: new DelayedPage(), responseTimeoutMs: 1_000 });
  assert.equal(result.guild_id, "103785");
});

test("live discovery accepts a valid duplicate when another response body is unavailable", async () => {
  class DuplicatePage extends EventEmitter {
    constructor() {
      super();
      this.currentUrl = "about:blank";
    }
    url() { return this.currentUrl; }
    async goto(url) {
      this.currentUrl = url;
      const response = (body) => ({
        url: () => "https://live-backstage.tiktok.com/creators/live/union_platform_api/agency/common/startup/",
        status: () => 200,
        headers: async () => ({ "content-type": "application/json; charset=utf-8" }),
        body
      });
      this.emit("response", response(async () => { throw new Error("response body unavailable"); }));
      this.emit("response", response(async () => Buffer.from(JSON.stringify(IDENTITY_BODY))));
    }
  }

  const result = await discoverGuild({ page: new DuplicatePage(), responseTimeoutMs: 1_000 });
  assert.equal(result.guild_id, "103785");
});
