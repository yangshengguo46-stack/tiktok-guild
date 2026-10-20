import assert from "node:assert/strict";
import test from "node:test";
import {
  COLLECTION_BACKSTAGE_ENDPOINT,
  COLLECTION_BACKSTAGE_STARTUP_ENDPOINT,
  CollectionBackstageError,
  batchCheckCollectionBackstage,
  inspectCollectionBackstageCompatibility,
  inspectCollectionBackstageStartup,
  isAllowedCollectionBackstageUrl,
  normalizeCollectionBackstageProjection,
  normalizeManualCollectionBackstageResults,
  normalizeCollectionBackstageStartupProjection,
  normalizeCollectionHandles
} from "../mcp/adapters/collection-backstage.js";

test("current official rejection codes11 through14 retain their exact meaning", () => {
  const expected = ["identity_ineligible", "live_data_not_meet_requirement",
    "join_qualification_frozen", "account_performance_qualify_failed"];
  for (let code = 11; code <= 14; code++) {
    const result = normalizeCollectionBackstageProjection({ ok: true, statusCode: 0,
      rows: [{ displayId: "creator", anchorStatus: 3, displayReason: code }] }, ["creator"]);
    assert.equal(result.results[0].displayReason, expected[code - 11]);
    assert.equal(result.results[0].displayReasonCode, code);
    assert.equal(result.results[0].eligible, false);
    const imported = normalizeManualCollectionBackstageResults([{ handle: "creator", anchorStatusCode: 3, displayReasonCode: code }]);
    assert.equal(imported[0].displayReason, expected[code - 11]);
  }
});

class MockBackstagePage {
  constructor(
    response,
    url = "https://live-backstage.tiktok.com/portal/anchor/relation",
    transportMutation = {}
  ) {
    this.currentUrl = url;
    this.response = response;
    this.transportMutation = transportMutation;
    this.calls = [];
    this.requestConfigs = [];
    this.verificationRenders = [];
    this.verifier = null;
    this.windowState = {};
    this.bringToFrontCalls = 0;
  }

  url() {
    return this.currentUrl;
  }

  async bringToFront() {
    this.bringToFrontCalls += 1;
  }

  async evaluate(callback, argument) {
    const previousWindow = globalThis.window;
    const previousLocation = globalThis.location;
    const page = this;
    const transportMutation = this.transportMutation;
    const endpointDefinition = transportMutation.batchDefinitionMismatch
      ? function endpointDefinitionBatchMismatch() {
        return "/common/startup/?requestFrom=portal v_ NeedAxiosResultRequest";
      }
      : transportMutation.startupDefinitionMismatch
      ? function endpointDefinitionMismatch() {
        return "/creators/live/union_platform_api/agency/union_invite/batch_check_anchor/ v_ NeedAxiosResultRequest";
      }
      : function endpointDefinition() {
        return "/creators/live/union_platform_api/agency/union_invite/batch_check_anchor/ /common/startup/?requestFrom=portal v_ NeedAxiosResultRequest";
      };
    const officialApiDefinition = transportMutation.batchDefinitionMismatch
      ? function officialApiDefinitionBatchMismatch() {
        return "/common/startup/?requestFrom=portal";
      }
      : transportMutation.startupDefinitionMismatch
      ? function officialApiDefinitionMismatch() {
        return "/creators/live/union_platform_api/agency/union_invite/batch_check_anchor/";
      }
      : function officialApiDefinition() {
        return "/creators/live/union_platform_api/agency/union_invite/batch_check_anchor/ /common/startup/?requestFrom=portal";
      };
    const requestConfigDefinition = function requestConfigDefinition() {
      return "x-csrf-token faction-id timeout:16e3";
    };
    const axiosDefinition = function axiosDefinition() {
      return "87662";
    };
    const axiosInstanceDefinition = function axiosInstanceDefinition() {
      return "96555";
    };
    const axiosDefaultsDefinition = function axiosDefaultsDefinition() {
      return "adapter: 10252";
    };
    const xhrAdapterDefinition = function xhrAdapterDefinition() {
      return "XMLHttpRequest.send(";
    };
    const verificationDefinition = transportMutation.verificationDefinitionMismatch
      ? function unknownVerificationDefinition() { return "changed"; }
      : function verificationDefinition() { return "captchaOptions showMode"; };
    const hostPack = function HostPack() {};
    if (!transportMutation.missingOfficialRequest) hostPack.HostPack_BatchCheckAnchor = async () => {};
    const xhrAdapter = async () => {
      throw new Error("mock XHR adapter should be driven through the Axios mock");
    };
    const axios = async (config) => {
      page.requestConfigs.push({
        method: config.method,
        url: config.url,
        data: config.data,
        params: config.params,
        timeout: config.timeout,
        adapterPinned: config.adapter === xhrAdapter
      });
      page.calls.push({
        endpoint: config.url,
        payload: config.data,
        options: { headers: { "content-type": config.headers["content-type"] } }
      });
      if (page.response instanceof Error) throw page.response;
      return page.response;
    };
    axios.VERSION = transportMutation.axiosVersionMismatch ? "0.28.0" : "0.27.2";
    axios.interceptors = {
      request: {
        handlers: Object.hasOwn(transportMutation, "requestHandlers")
          ? transportMutation.requestHandlers
          : []
      },
      response: {
        handlers: Object.hasOwn(transportMutation, "responseHandlers")
          ? transportMutation.responseHandlers
          : []
      }
    };
    axios.defaults = {
      adapter: transportMutation.defaultAdapterMismatch ? async () => {} : xhrAdapter,
      baseURL: transportMutation.defaultBaseURL
    };
    const runtime = (id) => {
      if (id === 29975) return { WY: hostPack };
      if (id === 76891) {
        return {
          v_: (endpoint, payload, options) => {
            if (transportMutation.mutateHandlersAfterConfig) {
              axios.interceptors.request.handlers.push({ fulfilled: () => {} });
            }
            const isStartup = endpoint === COLLECTION_BACKSTAGE_STARTUP_ENDPOINT;
            return {
              method: transportMutation.currentStartupBuilderShape && isStartup
                ? (options.method ?? "post")
                : (isStartup ? "get" : "post"),
              url: endpoint,
              data: transportMutation.currentStartupBuilderShape && isStartup
                ? "builder-only-body"
                : payload,
              headers: options.headers,
              timeout: 16_000,
              ...transportMutation.config
            };
          }
        };
      }
      if (id === 75740) return { default: axios };
      if (id === 87662) return axios;
      if (id === 96555) return axios.defaults;
      if (id === 10252) return xhrAdapter;
      if (id === 62636) {
        if (transportMutation.verificationExportMoved) return { default: async () => {} };
        return {
          t: async () => {
            page.verifier = {
              render: (decision) => page.verificationRenders.push(decision)
            };
            return page.verifier;
          }
        };
      }
      throw new Error(`unexpected module ${id}`);
    };
    runtime.m = {
      54026: endpointDefinition,
      29975: officialApiDefinition,
      76891: requestConfigDefinition,
      75740: axiosDefinition,
      87662: axiosInstanceDefinition,
      96555: axiosDefaultsDefinition,
      10252: xhrAdapterDefinition,
      62636: verificationDefinition
    };
    const chunks = [];
    chunks.push = (entry) => {
      entry[2](runtime);
      return 1;
    };
    this.windowState["@live-backstage/client"] = chunks;
    const startupEnvelope = page.response instanceof Error ? null : page.response?.data;
    const startupBody = startupEnvelope?.data && typeof startupEnvelope.data === "object"
      ? startupEnvelope.data
      : startupEnvelope;
    const defaultPortalState = {
      root: {
        visitorRegion: startupBody?.union?.region,
        user: startupBody?.user && typeof startupBody.user === "object"
          ? {
            ...startupBody.user,
            id: startupBody.user.id ?? "mock-user-id",
            unionID: startupBody?.union?.id
          }
          : null,
        appId: startupBody?.union?.appId
      }
    };
    const portalState = Object.hasOwn(transportMutation, "portalState")
      ? transportMutation.portalState
      : defaultPortalState;
    if (!transportMutation.portalStoreMissing) {
      this.windowState.__portalStore = {
        dispatch: () => {},
        subscribe: () => {},
        getState: () => {
          if (transportMutation.portalGetStateThrows) throw new Error("mock store failure");
          return portalState;
        },
        replaceReducer: () => {}
      };
      if (transportMutation.portalStoreInterfaceMismatch) {
        delete this.windowState.__portalStore.subscribe;
      }
    }
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: this.windowState
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      writable: true,
      value: new URL(this.currentUrl)
    });
    try {
      return await callback(argument);
    } finally {
      if (previousWindow === undefined) delete globalThis.window;
      else Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: previousWindow });
      if (previousLocation === undefined) delete globalThis.location;
      else Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: previousLocation });
    }
  }
}

test("collection backstage allowlist accepts only the relation page", () => {
  assert.equal(isAllowedCollectionBackstageUrl("https://live-backstage.tiktok.com/portal/anchor/relation"), true);
  assert.equal(isAllowedCollectionBackstageUrl("https://live-backstage.tiktok.com/portal/anchor/relation?safe=1"), true);
  assert.equal(isAllowedCollectionBackstageUrl("https://live-backstage.tiktok.com/portal/overview"), false);
  assert.equal(isAllowedCollectionBackstageUrl("https://live-backstage.tiktok.com.example.org/portal/anchor/relation"), false);
  assert.equal(isAllowedCollectionBackstageUrl("http://live-backstage.tiktok.com/portal/anchor/relation"), false);
});

test("normalizes, deduplicates, and bounds stored candidate handles", () => {
  assert.deepEqual(normalizeCollectionHandles(["@Alice.Live", "alice.live", "bob_2"]), ["Alice.Live", "bob_2"]);
  assert.throws(() => normalizeCollectionHandles([]), (error) => error.code === "EMPTY_COLLECTION_BATCH");
  assert.throws(() => normalizeCollectionHandles(["invalid handle"]), (error) => error.code === "INVALID_COLLECTION_HANDLE");
  assert.throws(
    () => normalizeCollectionHandles(Array.from({ length: 31 }, (_, index) => `creator_${index}`)),
    (error) => error.code === "COLLECTION_BATCH_TOO_LARGE"
  );
});

test("normalizes startup broad regions without exposing startup identities", () => {
  const projected = {
    ok: true,
    httpStatus: 200,
    statusCode: 0,
    observedMarketRegion: " MENA+BACKEND_SUFFIX ",
    accountAvailable: true,
    accountIdentityPresent: true,
    unionIdentityPresent: true,
    appIdentityPresent: true,
    email: "STARTUP_EMAIL_SECRET@example.com",
    id: "STARTUP_UNION_ID_SECRET",
    appId: "STARTUP_APP_ID_SECRET",
    raw: { cookie: "STARTUP_COOKIE_SECRET" }
  };
  const result = normalizeCollectionBackstageStartupProjection(projected, {
    expectedMarketRegion: "mena",
    observedAt: "2026-08-23T01:00:00.000Z"
  });

  assert.equal(result.expectedMarketRegion, "MENA");
  assert.equal(result.observedMarketRegion, "MENA");
  assert.equal(result.regionMatched, true);
  assert.equal(result.accountAvailable, true);
  assert.equal(result.accountIdentityPresent, true);
  assert.equal(result.unionIdentityPresent, true);
  assert.equal(result.appIdentityPresent, true);
  assert.equal(result.qualificationRequestConsumed, false);
  assert.equal(result.observedAt, "2026-08-23T01:00:00.000Z");
  assert.doesNotMatch(
    JSON.stringify(result),
    /STARTUP_EMAIL_SECRET|STARTUP_UNION_ID_SECRET|STARTUP_APP_ID_SECRET|STARTUP_COOKIE_SECRET/
  );

  for (const observedMarketRegion of ["TW", "中国台湾", "TW+PORTAL_SUFFIX"]) {
    const taiwan = normalizeCollectionBackstageStartupProjection({
      ...projected,
      observedMarketRegion
    }, { expectedMarketRegion: "TW" });
    assert.equal(taiwan.observedMarketRegion, "TW");
    assert.equal(taiwan.regionMatched, true);
  }
});

test("startup preflight reads only portal state and projects region plus identity-presence booleans", async () => {
  const rawSecrets = {
    email: "STARTUP_PAGE_EMAIL_SECRET@example.com",
    unionId: "STARTUP_PAGE_UNION_ID_SECRET",
    appId: "STARTUP_PAGE_APP_ID_SECRET",
    token: "STARTUP_PAGE_TOKEN_SECRET"
  };
  const page = new MockBackstagePage({
    status: 200,
    headers: {},
    data: {
      status_code: 0,
      data: {
        union: {
          region: "MENA+PORTAL_SUFFIX",
          id: rawSecrets.unionId,
          appId: rawSecrets.appId,
          token: rawSecrets.token
        },
        user: {
          email: rawSecrets.email,
          token: rawSecrets.token
        },
        raw: rawSecrets
      }
    }
  });

  const result = await inspectCollectionBackstageStartup({
    page,
    expectedMarketRegion: "MENA",
    observedAt: "2026-08-23T01:02:03.000Z"
  });

  assert.equal(page.calls.length, 0);
  assert.deepEqual(page.requestConfigs, []);
  assert.deepEqual({
    observedMarketRegion: result.observedMarketRegion,
    regionMatched: result.regionMatched,
    accountAvailable: result.accountAvailable,
    accountIdentityPresent: result.accountIdentityPresent,
    unionIdentityPresent: result.unionIdentityPresent,
    appIdentityPresent: result.appIdentityPresent,
    qualificationRequestConsumed: result.qualificationRequestConsumed
  }, {
    observedMarketRegion: "MENA",
    regionMatched: true,
    accountAvailable: true,
    accountIdentityPresent: true,
    unionIdentityPresent: true,
    appIdentityPresent: true,
    qualificationRequestConsumed: false
  });
  assert.equal(result.adapterVersion, "collection-backstage-startup.v4");
  assert.equal(result.transportMode, "pinned-portal-redux-state");
  const exposed = JSON.stringify({ result, calls: page.calls, requestConfigs: page.requestConfigs });
  assert.doesNotMatch(
    exposed,
    /STARTUP_PAGE_EMAIL_SECRET|STARTUP_PAGE_UNION_ID_SECRET|STARTUP_PAGE_APP_ID_SECRET|STARTUP_PAGE_TOKEN_SECRET|DisplayIDList/
  );
});

test("qualification compatibility preflight identifies pinned module drift without a request", async () => {
  const response = { status: 200, headers: {}, data: { status_code: 0, data: { AnchorList: [] } } };
  const page = new MockBackstagePage(response,
    "https://live-backstage.tiktok.com/portal/anchor/relation",
    { batchDefinitionMismatch: true });

  const result = await inspectCollectionBackstageCompatibility({ page });

  assert.deepEqual(result, {
    adapterVersion: "collection-backstage-qualification.v1",
    ready: false,
    failureStage: "endpoint_definition",
    qualificationRequestConsumed: false
  });
  assert.equal(page.calls.length, 0);
  assert.equal(page.requestConfigs.length, 0);
});

test("qualification compatibility preflight detects transport drift before sending", async () => {
  const response = { status: 200, headers: {}, data: { status_code: 0, data: { AnchorList: [] } } };
  const page = new MockBackstagePage(response,
    "https://live-backstage.tiktok.com/portal/anchor/relation",
    { defaultAdapterMismatch: true });

  const result = await inspectCollectionBackstageCompatibility({ page });

  assert.equal(result.ready, false);
  assert.equal(result.failureStage, "transport_defaults");
  assert.equal(result.qualificationRequestConsumed, false);
  assert.equal(page.calls.length, 0);
});

test("qualification compatibility preflight identifies the exact missing runtime export", async () => {
  const response = { status: 200, headers: {}, data: { status_code: 0, data: { AnchorList: [] } } };
  for (const [mutation, failureStage] of [
    [{ missingOfficialRequest: true }, "official_request_export"],
    [{ axiosVersionMismatch: true }, "axios_version"]
  ]) {
    const page = new MockBackstagePage(response,
      "https://live-backstage.tiktok.com/portal/anchor/relation", mutation);
    const result = await inspectCollectionBackstageCompatibility({ page });
    assert.equal(result.failureStage, failureStage);
    assert.equal(page.calls.length, 0);
  }
});

test("verification export drift does not block a safe query and reports bounded shape", async () => {
  const page = new MockBackstagePage(
    { status: 200, headers: {}, data: { status_code: 0, data: { AnchorList: [] } } },
    "https://live-backstage.tiktok.com/portal/anchor/relation",
    { verificationExportMoved: true }
  );
  const result = await inspectCollectionBackstageCompatibility({ page });
  assert.equal(result.ready, true);
  assert.equal(result.failureStage, null);
  assert.equal(result.verificationPresentationReady, false);
  assert.deepEqual(result.verificationExportShape, [{ name: "default", type: "function" }]);
  assert.equal(page.calls.length, 0);
});

test("missing challenge renderer never replays a qualification request", async () => {
  const page = new MockBackstagePage({
    status: 200,
    headers: { "bdturing-verify": { type: "verify", decision_conf: "LOCAL_TEST_ONLY" } },
    data: { status_code: 0, data: {} }
  }, "https://live-backstage.tiktok.com/portal/anchor/relation", { verificationExportMoved: true });
  await assert.rejects(
    batchCheckCollectionBackstage({ page, handles: ["alice"] }),
    (error) => error.code === "manual_verification"
      && error.details.verificationRenderCalled === false
      && error.details.verificationPresented === false
  );
  assert.equal(page.calls.length, 1);
  assert.equal(page.verificationRenders.length, 0);
});

test("qualification succeeds once when only challenge presentation has drifted", async () => {
  const page = new MockBackstagePage({
    status: 200,
    headers: {},
    data: { status_code: 0, data: { AnchorList: [{
      AnchorStatus: 0,
      DisplayReason: 0,
      UserBaseInfo: { DisplayID: "alice" }
    }] } }
  }, "https://live-backstage.tiktok.com/portal/anchor/relation", {
    verificationDefinitionMismatch: true
  });
  const preflight = await inspectCollectionBackstageCompatibility({ page });
  assert.equal(preflight.ready, true);
  assert.equal(preflight.verificationPresentationReady, false);
  const result = await batchCheckCollectionBackstage({ page, handles: ["alice"] });
  assert.equal(result.results[0].qualificationStatus, "available");
  assert.equal(page.calls.length, 1);
});

test("startup preflight ignores the retired startup route and performs zero requests", async () => {
  const page = new MockBackstagePage(
    new Error("RETIRED_STARTUP_ROUTE_MUST_NOT_BE_CALLED"),
    "https://live-backstage.tiktok.com/portal/anchor/relation",
    {
      portalState: {
        root: {
          visitorRegion: "MENA",
          user: {
            id: "opaque-user",
            email: "opaque-account@example.com",
            unionID: "opaque-union"
          },
          appId: 1234
        }
      }
    }
  );

  const result = await inspectCollectionBackstageStartup({
    page,
    expectedMarketRegion: "MENA"
  });

  assert.equal(result.regionMatched, true);
  assert.equal(result.qualificationRequestConsumed, false);
  assert.equal(page.calls.length, 0);
  assert.equal(page.requestConfigs.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /RETIRED_STARTUP_ROUTE_MUST_NOT_BE_CALLED/);
});

test("startup preflight fails closed on unavailable accounts and broad-region mismatch", async () => {
  assert.throws(
    () => normalizeCollectionBackstageStartupProjection({
      ok: true,
      httpStatus: 200,
      statusCode: 0,
      observedMarketRegion: null,
      accountAvailable: false,
      accountIdentityPresent: false,
      unionIdentityPresent: false,
      appIdentityPresent: false
    }, { expectedMarketRegion: "MENA" }),
    (error) => error.code === "COLLECTION_BACKSTAGE_PREFLIGHT_UNAVAILABLE"
  );

  assert.throws(
    () => normalizeCollectionBackstageStartupProjection({
      ok: true,
      httpStatus: 200,
      statusCode: 0,
      observedMarketRegion: "MENA",
      accountAvailable: true,
      accountIdentityPresent: false,
      unionIdentityPresent: true,
      appIdentityPresent: true
    }, { expectedMarketRegion: "MENA" }),
    (error) => {
      assert.equal(error.code, "COLLECTION_BACKSTAGE_PREFLIGHT_UNAVAILABLE");
      assert.equal(error.details.accountAvailable, true);
      assert.equal(error.details.accountIdentityPresent, false);
      return true;
    }
  );

  assert.throws(
    () => normalizeCollectionBackstageStartupProjection({
      ok: true,
      httpStatus: 200,
      statusCode: 0,
      observedMarketRegion: "CCA",
      accountAvailable: true,
      accountIdentityPresent: true,
      unionIdentityPresent: true,
      appIdentityPresent: true,
      email: "MISMATCH_EMAIL_SECRET@example.com",
      id: "MISMATCH_ID_SECRET"
    }, { expectedMarketRegion: "MENA" }),
    (error) => {
      assert.equal(error.code, "COLLECTION_BACKSTAGE_MARKET_MISMATCH");
      assert.deepEqual(error.details, {
        expectedMarketRegion: "MENA",
        observedMarketRegion: "CCA",
        accountAvailable: true
      });
      assert.doesNotMatch(JSON.stringify(error), /MISMATCH_EMAIL_SECRET|MISMATCH_ID_SECRET/);
      return true;
    }
  );

  for (const projected of [
    {
      ok: true,
      httpStatus: 200,
      statusCode: 0,
      observedMarketRegion: "MENA",
      accountAvailable: true,
      accountIdentityPresent: null,
      unionIdentityPresent: true,
      appIdentityPresent: true
    },
    {
      ok: true,
      httpStatus: "not-a-status",
      statusCode: 0,
      observedMarketRegion: "MENA",
      accountAvailable: true,
      accountIdentityPresent: true,
      unionIdentityPresent: true,
      appIdentityPresent: true
    }
  ]) {
    assert.throws(
      () => normalizeCollectionBackstageStartupProjection(projected, { expectedMarketRegion: "MENA" }),
      (error) => error.code === "COLLECTION_ADAPTER_MISMATCH"
    );
  }
});

test("startup preflight rejects portal-store drift without sending", async () => {
  const validState = {
    root: {
      visitorRegion: "MENA",
      user: {
        id: "opaque-user",
        email: "opaque-account@example.com",
        unionID: "opaque-union"
      },
      appId: 1234
    }
  };
  const mutations = [
    { portalStoreMissing: true },
    { portalStoreInterfaceMismatch: true },
    { portalGetStateThrows: true },
    { portalState: null },
    { portalState: {} },
    { portalState: { root: [] } }
  ];

  for (const mutation of mutations) {
    const page = new MockBackstagePage(
      new Error("PORTAL_STORE_DRIFT_MUST_NOT_REACH_NETWORK"),
      "https://live-backstage.tiktok.com/portal/anchor/relation",
      { portalState: validState, ...mutation }
    );
    await assert.rejects(
      inspectCollectionBackstageStartup({ page, expectedMarketRegion: "MENA" }),
      (error) => error.code === "COLLECTION_ADAPTER_MISMATCH"
    );
    assert.equal(page.calls.length, 0, `portal drift must never send: ${Object.keys(mutation)}`);
  }
});

test("startup preflight never reaches network or challenge handling", async () => {
  const portalState = {
    root: {
      visitorRegion: "MENA",
      user: {
        id: "opaque-user",
        email: "opaque-account@example.com",
        unionID: "opaque-union"
      },
      appId: 1234
    }
  };
  const challengePage = new MockBackstagePage({
    status: 200,
    headers: { "bdturing-verify": { type: "verify", decision_conf: "STARTUP_CHALLENGE_SECRET" } },
    data: {}
  }, "https://live-backstage.tiktok.com/portal/anchor/relation", { portalState });
  const challengeResult = await inspectCollectionBackstageStartup({
    page: challengePage,
    expectedMarketRegion: "MENA"
  });
  assert.equal(challengeResult.regionMatched, true);
  assert.equal(challengePage.calls.length, 0);
  assert.equal(challengePage.bringToFrontCalls, 0);
  assert.equal(challengePage.verificationRenders.length, 0);
  assert.doesNotMatch(JSON.stringify(challengeResult), /STARTUP_CHALLENGE_SECRET/);

  const networkPage = new MockBackstagePage(
    new Error("STARTUP_NETWORK_SECRET"),
    "https://live-backstage.tiktok.com/portal/anchor/relation",
    { portalState }
  );
  const networkResult = await inspectCollectionBackstageStartup({
    page: networkPage,
    expectedMarketRegion: "MENA"
  });
  assert.equal(networkResult.regionMatched, true);
  assert.equal(networkPage.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(networkResult), /STARTUP_NETWORK_SECRET/);
});

test("startup preflight rejects a wrong page before sending", async () => {
  const page = new MockBackstagePage(
    { status: 200, headers: {}, data: { union: { region: "MENA" }, user: {} } },
    "https://live-backstage.tiktok.com/portal/overview"
  );
  await assert.rejects(
    inspectCollectionBackstageStartup({ page, expectedMarketRegion: "MENA" }),
    (error) => error instanceof CollectionBackstageError && error.code === "COLLECTION_NAVIGATION_BLOCKED"
  );
  assert.equal(page.calls.length, 0);
});

test("uses one pinned official request, maps codes, and drops raw identity secrets in-page", async () => {
  const rawSecrets = {
    userId: "BACKSTAGE_USER_ID_SECRET",
    searchId: "BACKSTAGE_SEARCH_ID_SECRET",
    avatar: "https://cdn.example/avatar?refresh_token=BACKSTAGE_AVATAR_SECRET"
  };
  const page = new MockBackstagePage({
    status: 200,
    headers: {},
    data: {
      status_code: 0,
      message: "success",
      data: {
        SearchID: rawSecrets.searchId,
        IsBanned: false,
        DontHaveInviteBenefit: false,
        TestAccountLimit: false,
        AnchorList: [{
          AnchorStatus: 0,
          DisplayReason: 0,
          CanUseInvitationType: [3, 4],
          PopupInvitationType: [0],
          HasBricRisk: false,
          IsFollow: false,
          MultiAccountNotMeetBasicQualification: false,
          TrialLiveRequirement: { TrialLiveEndTimestamp: "1787992772" },
          UserBaseInfo: {
            DisplayID: "alice.live",
            UserID: rawSecrets.userId,
            Avatar: rawSecrets.avatar,
            NickName: "PRIVATE_NICKNAME_SECRET",
            NoPermission: false,
            InEmergency: false
          }
        }]
      }
    }
  });

  const result = await batchCheckCollectionBackstage({
    page,
    handles: ["@alice.live"],
    observedAt: "2026-08-22T04:00:00.000Z"
  });

  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].endpoint, "/creators/live/union_platform_api/agency/union_invite/batch_check_anchor/");
  assert.deepEqual(page.calls[0].payload, { DisplayIDList: ["alice.live"] });
  assert.deepEqual(page.calls[0].options, { headers: { "content-type": "application/json" } });
  assert.equal(result.requestCount, 1);
  assert.equal(result.adapterVersion, "collection-backstage.v2");
  assert.equal(result.transportMode, "pinned-config-direct-axios");
  assert.equal(result.results[0].qualificationStatus, "available");
  assert.equal(result.results[0].eligible, true);
  assert.deepEqual(result.results[0].canUseInvitationTypes, ["regular", "elite"]);
  assert.equal(result.results[0].trialLiveEndAt, "2026-08-29T08:39:32.000Z");
  assert.equal(result.results[0].flags.noPermission, false);

  const exposed = JSON.stringify({ result, calls: page.calls });
  assert.doesNotMatch(
    exposed,
    /BACKSTAGE_USER_ID_SECRET|BACKSTAGE_SEARCH_ID_SECRET|BACKSTAGE_AVATAR_SECRET|PRIVATE_NICKNAME_SECRET|UserID|SearchID|Avatar|refresh_token/i
  );
});

test("maps current LIVE Backstage status 2 to region mismatch", () => {
  const result = normalizeCollectionBackstageProjection({
    ok: true,
    statusCode: 0,
    rows: [{
      displayId: "alice",
      anchorStatus: 2,
      displayReason: 0,
      canUseInvitationTypes: null,
      popupInvitationTypes: null,
      trialLiveEndTimestamp: "",
      hasBricRisk: false,
      isFollow: false,
      noPermission: false,
      inEmergency: false,
      multiAccountNotMeetBasicQualification: false
    }]
  }, ["alice"], "2026-08-22T04:00:00.000Z");
  assert.equal(result.results[0].qualificationStatus, "region_mismatch");
  assert.equal(result.results[0].eligible, false);
});

test("keeps quota exhaustion distinct from a negative creator decision", () => {
  const result = normalizeCollectionBackstageProjection({
    ok: true,
    statusCode: 0,
    rows: [{ displayId: "alice", anchorStatus: 7, displayReason: 0 }]
  }, ["alice"], "2026-08-22T04:00:00.000Z");
  assert.equal(result.results[0].qualificationStatus, "quota_limit");
  assert.equal(result.results[0].eligible, null);
});

test("drops untrusted backend error messages and identity-shaped secrets", () => {
  const secretMessage = "UserID=UID_SECRET SearchID=SID_SECRET Avatar=AVATAR_SECRET";
  assert.throws(
    () => normalizeCollectionBackstageProjection({
      ok: false,
      code: "UNTRUSTED_REMOTE_CODE",
      message: secretMessage,
      error: { message: secretMessage },
      httpStatus: 500,
      statusCode: 9001
    }, ["alice"]),
    (error) => {
      assert.equal(error.code, "COLLECTION_BACKSTAGE_REQUEST_FAILED");
      assert.doesNotMatch(JSON.stringify({
        message: error.message,
        code: error.code,
        details: error.details
      }), /UID_SECRET|SID_SECRET|AVATAR_SECRET|UserID|SearchID|Avatar/i);
      return true;
    }
  );
});

test("fails before send when the pinned Axios transport or destination drifts", async () => {
  const response = { status: 200, headers: {}, data: { status_code: 0, data: { AnchorList: [] } } };
  const mutations = [
    { batchDefinitionMismatch: true },
    { requestHandlers: null },
    { responseHandlers: [{ fulfilled: () => {} }] },
    { config: { adapter: async () => {} } },
    { config: { baseURL: "https://outside.example" } },
    { defaultBaseURL: "https://outside.example" },
    { defaultAdapterMismatch: true },
    { mutateHandlersAfterConfig: true }
  ];
  for (const mutation of mutations) {
    const page = new MockBackstagePage(
      response,
      "https://live-backstage.tiktok.com/portal/anchor/relation",
      mutation
    );
    await assert.rejects(
      batchCheckCollectionBackstage({ page, handles: ["alice"] }),
      (error) => error.code === "COLLECTION_ADAPTER_MISMATCH"
    );
    assert.equal(page.calls.length, 0, `transport mutation must fail before send: ${Object.keys(mutation)}`);
  }
});

test("presents a manual challenge without replaying the qualification request", async () => {
  const decision = { type: "verify", decision_conf: "LOCAL_TEST_ONLY" };
  for (const { response, renderedDecision } of [
    {
      response: { status: 200, headers: { "bdturing-verify": decision }, data: { status_code: 0, data: {} } },
      renderedDecision: decision
    },
    {
      response: { status: 200, headers: {}, data: { status_code: 0, data: { block_data: decision } } },
      renderedDecision: decision.decision_conf
    }
  ]) {
    const page = new MockBackstagePage(response);
    await assert.rejects(
      batchCheckCollectionBackstage({ page, handles: ["alice"] }),
      (error) => {
        assert.equal(error.code, "manual_verification");
        assert.deepEqual(error.details, {
          verificationRenderCalled: true,
          verificationPresented: true
        });
        return true;
      }
    );
    assert.equal(page.calls.length, 1);
    assert.equal(page.bringToFrontCalls, 1);
    assert.deepEqual(page.verificationRenders, [renderedDecision]);
    page.verifier.onsuccess();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(page.calls.length, 1);
  }
});

test("fails closed on incomplete, duplicate, challenge, and wrong-page responses", async () => {
  assert.throws(
    () => normalizeCollectionBackstageProjection({ ok: true, statusCode: 0, rows: [] }, ["alice"]),
    (error) => error.code === "COLLECTION_INCOMPLETE_RESPONSE"
  );
  assert.throws(
    () => normalizeCollectionBackstageProjection({
      ok: true,
      statusCode: 0,
      rows: [
        { displayId: "alice", anchorStatus: 0 },
        { displayId: "alice", anchorStatus: 0 }
      ]
    }, ["alice"]),
    (error) => error.code === "COLLECTION_ADAPTER_MISMATCH"
  );
  assert.throws(
    () => normalizeCollectionBackstageProjection({
      ok: true,
      statusCode: 0,
      rows: [{ displayId: "alice" }]
    }, ["alice"]),
    (error) => error.code === "COLLECTION_ADAPTER_MISMATCH"
  );
  assert.throws(
    () => normalizeCollectionBackstageProjection({
      ok: true,
      statusCode: 0,
      rows: [{ displayId: "alice", anchorStatus: 99 }]
    }, ["alice"]),
    (error) => error.code === "COLLECTION_ADAPTER_MISMATCH"
  );
  for (const invalidStatus of [false, true, " ", {}, "0.0", "0x0"]) {
    assert.throws(
      () => normalizeCollectionBackstageProjection({
        ok: true,
        statusCode: 0,
        rows: [{ displayId: "alice", anchorStatus: invalidStatus }]
      }, ["alice"]),
      (error) => error.code === "COLLECTION_ADAPTER_MISMATCH",
      `AnchorStatus ${JSON.stringify(invalidStatus)} must fail closed`
    );
  }
  assert.throws(
    () => normalizeCollectionBackstageProjection({ verificationRequired: true }, ["alice"]),
    (error) => error.code === "manual_verification"
  );
  await assert.rejects(
    batchCheckCollectionBackstage({
      page: new MockBackstagePage({}, "https://live-backstage.tiktok.com/portal/overview"),
      handles: ["alice"]
    }),
    (error) => error instanceof CollectionBackstageError && error.code === "COLLECTION_NAVIGATION_BLOCKED"
  );
  await assert.rejects(
    batchCheckCollectionBackstage({
      page: new MockBackstagePage({
        status: 200,
        headers: {},
        data: {
          status_code: 0,
          data: { AnchorList: [{ AnchorStatus: false, UserBaseInfo: { DisplayID: "alice" } }] }
        }
      }),
      handles: ["alice"]
    }),
    (error) => error instanceof CollectionBackstageError && error.code === "COLLECTION_ADAPTER_MISMATCH"
  );
});
