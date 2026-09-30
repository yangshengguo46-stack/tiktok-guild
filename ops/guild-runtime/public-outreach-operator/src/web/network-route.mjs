import net from 'node:net';

const DIAGNOSTIC_URL = 'https://www.cloudflare.com/cdn-cgi/trace';

function routeError(code) {
  return Object.assign(new Error(code), { code });
}

export function parseWebRoute(value) {
  if (value === undefined || value === null) throw routeError('web_route_unconfigured');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw routeError('web_route_invalid');
  let url;
  try { url = new URL(value.proxy_server); } catch { throw routeError('web_route_invalid'); }
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  const port = Number(url.port);
  const country = value.expected_country;
  const expectedIp = value.expected_ip ?? null;
  if (!['http:', 'socks5:'].includes(url.protocol)
    || !['127.0.0.1', '::1', 'localhost'].includes(host)
    || !Number.isInteger(port) || port < 1 || port > 65535
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || typeof country !== 'string' || !/^[A-Z]{2}$/u.test(country)
    || (expectedIp !== null && (typeof expectedIp !== 'string' || net.isIP(expectedIp) === 0))) {
    throw routeError('web_route_invalid');
  }
  return {
    proxy: { server: `${url.protocol}//${url.hostname}:${url.port}` },
    expectedCountry: country,
    expectedIp,
    endpoint: { host, port },
  };
}

function dial(endpoint, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('timeout')));
    socket.once('connect', () => { socket.end(); resolve(); });
    socket.once('error', reject);
  });
}

export async function checkProxyEndpoint(route, { connect = dial, timeoutMs = 1500, retryDelayMs = 100 } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await connect(route.endpoint, timeoutMs);
      return { ready: true };
    } catch {
      if (attempt === 0 && retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return { ready: false, error_code: 'proxy_unreachable' };
}

export async function probeBrowserEgress(context, route, { diagnosticUrl = DIAGNOSTIC_URL } = {}) {
  let page;
  let result;
  try {
    page = await context.newPage();
    const response = await page.goto(diagnosticUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
    if (!response || response.status() < 200 || response.status() >= 300) {
      result = { ready: false, error_code: 'egress_check_failed' };
    } else {
      const fields = Object.fromEntries((await response.text()).split(/\r?\n/u)
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
      if (!/^[A-Z]{2}$/u.test(fields.loc ?? '') || net.isIP(fields.ip ?? '') === 0) {
        result = { ready: false, error_code: 'egress_check_failed' };
      } else if (fields.loc !== route.expectedCountry) {
        result = { ready: false, error_code: 'egress_country_mismatch' };
      } else if (route.expectedIp && fields.ip !== route.expectedIp) {
        result = { ready: false, error_code: 'egress_ip_mismatch' };
      } else {
        result = { ready: true, observedCountry: fields.loc };
      }
    }
  } catch {
    result = { ready: false, error_code: 'egress_check_failed' };
  } finally {
    try { await page?.close(); } catch { result = { ready: false, error_code: 'browser_cleanup_failed' }; }
  }
  return result;
}
