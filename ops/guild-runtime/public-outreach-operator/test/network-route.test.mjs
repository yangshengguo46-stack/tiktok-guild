import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { parseWebRoute, checkProxyEndpoint, probeBrowserEgress } from '../src/web/network-route.mjs';

const config = (overrides = {}) => ({
  proxy_server: 'http://127.0.0.1:7890',
  expected_country: 'US',
  ...overrides,
});

test('a Web sender needs an explicit local proxy route', () => {
  assert.throws(() => parseWebRoute(), { code: 'web_route_unconfigured' });
  assert.throws(() => parseWebRoute(config({ proxy_server: 'http://proxy.example:7890' })), { code: 'web_route_invalid' });
  assert.throws(() => parseWebRoute(config({ proxy_server: 'http://user:pass@127.0.0.1:7890' })), { code: 'web_route_invalid' });
  assert.throws(() => parseWebRoute(config({ proxy_server: 'http://127.0.0.1:7890/path' })), { code: 'web_route_invalid' });
  assert.throws(() => parseWebRoute(config({ expected_country: 'USA' })), { code: 'web_route_invalid' });
  assert.throws(() => parseWebRoute(config({ expected_ip: 'not-an-ip' })), { code: 'web_route_invalid' });
  assert.deepEqual(parseWebRoute(config({ expected_ip: '203.0.113.7' })), {
    proxy: { server: 'http://127.0.0.1:7890' },
    expectedCountry: 'US',
    expectedIp: '203.0.113.7',
    endpoint: { host: '127.0.0.1', port: 7890 },
  });
});

test('proxy endpoint is checked on loopback and retries only the same address once', async (t) => {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const route = parseWebRoute(config({ proxy_server: `http://127.0.0.1:${server.address().port}` }));
  assert.deepEqual(await checkProxyEndpoint(route), { ready: true });

  const attempts = [];
  const failed = await checkProxyEndpoint(route, {
    connect: async (endpoint) => { attempts.push(endpoint); throw new Error('refused'); },
    retryDelayMs: 0,
  });
  assert.deepEqual(failed, { ready: false, error_code: 'proxy_unreachable' });
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
});

function fakeContext(body, { status = 200, navigationError = null } = {}) {
  const state = { navigations: [], closed: 0 };
  return {
    state,
    context: {
      async newPage() {
        return {
          async goto(url) {
            state.navigations.push(url);
            if (navigationError) throw navigationError;
            return { status: () => status, text: async () => body };
          },
          async close() { state.closed += 1; },
        };
      },
    },
  };
}

test('egress check uses the browser context and returns only a bounded country', async () => {
  const { context, state } = fakeContext('ip=203.0.113.7\nloc=US\nhttp=http/2\n');
  const result = await probeBrowserEgress(context, parseWebRoute(config({ expected_ip: '203.0.113.7' })));
  assert.deepEqual(result, { ready: true, observedCountry: 'US' });
  assert.deepEqual(state.navigations, ['https://www.cloudflare.com/cdn-cgi/trace']);
  assert.equal(state.closed, 1);
  assert.equal(JSON.stringify(result).includes('203.0.113.7'), false);
});

test('egress check fails closed on wrong country, wrong IP, and malformed response', async () => {
  const route = parseWebRoute(config({ expected_ip: '203.0.113.7' }));
  assert.deepEqual(await probeBrowserEgress(fakeContext('ip=203.0.113.8\nloc=CN\n').context, route), { ready: false, error_code: 'egress_country_mismatch' });
  assert.deepEqual(await probeBrowserEgress(fakeContext('ip=203.0.113.8\nloc=US\n').context, route), { ready: false, error_code: 'egress_ip_mismatch' });
  assert.deepEqual(await probeBrowserEgress(fakeContext('not trace').context, route), { ready: false, error_code: 'egress_check_failed' });
  assert.deepEqual(await probeBrowserEgress(fakeContext('ip=203.0.113.7\nloc=US\n', { status: 503 }).context, route), { ready: false, error_code: 'egress_check_failed' });
  assert.deepEqual(await probeBrowserEgress(fakeContext('', { navigationError: new Error('network') }).context, route), { ready: false, error_code: 'egress_check_failed' });
});
