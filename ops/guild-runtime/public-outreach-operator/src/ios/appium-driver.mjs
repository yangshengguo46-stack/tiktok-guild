const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

export async function createAppiumDriver({ appiumUrl, wdaUrl, udid, platformVersion, bundleId, wdaBundleId, fetch: fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  if (!udid || !wdaUrl || !wdaBundleId || !appiumUrl) throw new Error('Explicit Appium, WDA and device bindings are required.');
  let sessionId;
  let capabilities;
  let closed = false;
  async function request(method, pathname, body, base = appiumUrl) {
    const response = await fetchImpl(`${base.replace(/\/$/, '')}${pathname}`, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json();
    if (!response.ok || data.value?.error) {
      const error = new Error('Appium/WDA command failed.');
      error.error_code = data.value?.error === 'no such element' ? 'selector_missing' : 'wda_unavailable'; throw error;
    }
    return data.value;
  }
  const created = await request('POST', '/session', { capabilities: { alwaysMatch: {
    platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:udid': udid,
    'appium:platformVersion': platformVersion, 'appium:bundleId': bundleId,
    'appium:noReset': true, 'appium:autoLaunch': false, 'appium:newCommandTimeout': 180,
    'appium:webDriverAgentUrl': wdaUrl,
  }, firstMatch: [{}] } });
  sessionId = created.sessionId; capabilities = created.capabilities;
  if (!sessionId) throw new Error('Appium returned no session id.');
  const prefix = `/session/${encodeURIComponent(sessionId)}`;
  const execute = (script, args = {}) => request('POST', `${prefix}/execute/sync`, { script, args: [args] });
  function element(raw) {
    const id = raw?.[ELEMENT_KEY] ?? raw?.ELEMENT;
    if (!id) return null;
    const endpoint = `${prefix}/element/${encodeURIComponent(id)}`;
    return {
      getAttribute: (name) => request('GET', `${endpoint}/attribute/${encodeURIComponent(name)}`),
      getText: () => request('GET', `${endpoint}/text`),
      isDisplayed: () => request('GET', `${endpoint}/displayed`),
      click: () => request('POST', `${endpoint}/click`, {}),
      clear: () => request('POST', `${endpoint}/clear`, {}),
      setValue: (text) => request('POST', `${endpoint}/value`, { text, value: [...text] }),
      sendKeys: (text) => request('POST', `${endpoint}/value`, { text: text === 'Enter' ? '\uE007' : text }),
    };
  }
  return {
    async verifyHealth() {
      const [info, locked, wda] = await Promise.all([execute('mobile: deviceInfo'), execute('mobile: isLocked'), request('GET', '/status', undefined, wdaUrl)]);
      const observedUdid = info?.UniqueDeviceID ?? info?.udid;
      const bound = observedUdid === udid && (capabilities?.['appium:udid'] ?? capabilities?.udid) === udid;
      const ios = capabilities?.platformName?.toLowerCase() === 'ios'
        && (capabilities?.['appium:automationName'] ?? capabilities?.automationName)?.toLowerCase() === 'xcuitest';
      const signedWda = wda?.build?.productBundleIdentifier === wdaBundleId && Boolean(wda?.build?.time)
        && wda?.os?.name?.toLowerCase() === 'ios';
      return { ok: bound && ios && signedWda && locked === false, state: bound && ios && signedWda && locked === false ? 'ready' : 'manual_required',
        error_code: locked === true ? 'device_locked' : 'wda_unavailable',
        prerequisites: { platform: ios, xcode: signedWda, wda: signedWda, paired: bound, online: bound, locked: locked !== false },
        probe: { ready: signedWda && wda.ready !== false, device_verified: bound, wda_verified: signedWda } };
    },
    findElement: async (using, value) => element(await request('POST', `${prefix}/element`, { using, value })),
    findElements: async (using, value) => (await request('POST', `${prefix}/elements`, { using, value })).map(element),
    activateApp: (app) => execute('mobile: activateApp', { bundleId: app }),
    openProfile: async (url, app) => { await execute('mobile: deepLink', { url, bundleId: app }); return { ok: true }; },
    takeScreenshot: () => request('GET', `${prefix}/screenshot`),
    getPageSource: () => request('GET', `${prefix}/source`),
    async deleteSession() { if (closed) return; closed = true; await request('DELETE', prefix); },
  };
}
