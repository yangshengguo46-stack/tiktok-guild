const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

export async function createAndroidDriver({ appiumUrl, udid, systemPort, appPackage = null, appActivity = null, fetch: fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  if (!appiumUrl || !/^https?:\/\//.test(appiumUrl)) throw new Error('Explicit Appium URL is required.');
  if (typeof udid !== 'string' || !udid) throw new Error('Explicit Android serial is required.');
  if (!Number.isInteger(systemPort) || systemPort < 1024 || systemPort > 65535) throw new Error('Unique systemPort is required.');
  const base = appiumUrl.replace(/\/$/, '');
  async function request(method, pathname, body) {
    const response = await fetchImpl(`${base}${pathname}`, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json();
    if (!response.ok || data.value?.error) {
      const error = new Error('Appium Android command failed.');
      error.error_code = data.value?.error === 'no such element' ? 'selector_missing' : 'appium_unavailable';
      throw error;
    }
    return data.value;
  }
  const alwaysMatch = {
    platformName: 'Android', 'appium:automationName': 'UiAutomator2', 'appium:udid': udid,
    'appium:systemPort': systemPort, 'appium:noReset': true, 'appium:autoLaunch': false,
    'appium:newCommandTimeout': 180,
  };
  if (appPackage) alwaysMatch['appium:appPackage'] = appPackage;
  if (appActivity) alwaysMatch['appium:appActivity'] = appActivity;
  const created = await request('POST', '/session', { capabilities: { alwaysMatch, firstMatch: [{}] } });
  const sessionId = created?.sessionId;
  if (!sessionId || created.capabilities?.platformName?.toLowerCase() !== 'android'
    || (created.capabilities?.['appium:udid'] ?? created.capabilities?.udid) !== udid) {
    if (sessionId) await request('DELETE', `/session/${encodeURIComponent(sessionId)}`);
    throw Object.assign(new Error('Appium session did not confirm the requested Android device.'), { error_code: 'device_mismatch' });
  }
  const prefix = `/session/${encodeURIComponent(sessionId)}`;
  let closed = false;
  const execute = (script, args) => request('POST', `${prefix}/execute/sync`, { script, args: [args] });
  function element(raw) {
    const id = raw?.[ELEMENT_KEY] ?? raw?.ELEMENT;
    if (!id) throw Object.assign(new Error('Appium returned no element.'), { error_code: 'selector_missing' });
    const endpoint = `${prefix}/element/${encodeURIComponent(id)}`;
    return {
      click: () => request('POST', `${endpoint}/click`, {}),
      clear: () => request('POST', `${endpoint}/clear`, {}),
      setValue: (text) => request('POST', `${endpoint}/value`, { text, value: [...text] }),
      getText: () => request('GET', `${endpoint}/text`),
      getAttribute: (name) => request('GET', `${endpoint}/attribute/${encodeURIComponent(name)}`),
      isDisplayed: () => request('GET', `${endpoint}/displayed`),
    };
  }
  return {
    udid,
    findElement: async (using, value) => element(await request('POST', `${prefix}/element`, { using, value })),
    findElements: async (using, value) => (await request('POST', `${prefix}/elements`, { using, value })).map(element),
    getPageSource: () => request('GET', `${prefix}/source`),
    back: () => request('POST', `${prefix}/back`, {}),
    activateApp: (app) => execute('mobile: activateApp', { appId: app }),
    openDeepLink: (url, app) => execute('mobile: deepLink', { url, package: app }),
    startActivity: (app, activity) => execute('mobile: startActivity', { appPackage: app, appActivity: activity }),
    swipe: (from, to, duration = 500) => request('POST', `${prefix}/actions`, { actions: [{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions: [
      { type: 'pointerMove', duration: 0, x: from.x, y: from.y }, { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', duration, x: to.x, y: to.y }, { type: 'pointerUp', button: 0 },
    ] }] }),
    async deleteSession() { if (closed) return; closed = true; await request('DELETE', prefix); },
  };
}
