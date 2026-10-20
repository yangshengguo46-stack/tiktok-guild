import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../mcp/core/database.js';
import { DaemonClient } from '../mcp/core/daemon-client.js';
import { runtimePaths } from '../mcp/core/runtime-paths.js';

test('daemon freezes country context seeds and exposes TikHub as an explicit bounded source', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'tkdesk-tikhub-daemon-'));
  const store = new DatabaseStore(runtimePaths(dir).databasePath).init();
  const client = new DaemonClient({ pluginRoot: process.cwd(), dataDirectory: dir });
  t.after(async () => { await client.call('shutdown').catch(()=>{});store.close();await new Promise(r=>setTimeout(r,150));await rm(dir,{recursive:true,force:true}); });
  const route = store.upsertCollectionRoute({ marketRegion:'MENA',marketCountryCodes:['SA'],discoveryCountry:'US',discoveryProxyServer:'http://127.0.0.1:19680',collectionLanes:[{countryCode:'SA',proxyServer:'http://127.0.0.1:19681'}],proxyFingerprint:'sha256:tikhub-test' });
  store.recordCollectionRouteVerification(route.routeProfileId,{status:'verified',proxyFingerprint:'sha256:tikhub-test',discoveryProxyExitCountry:'US',proxyExitCountry:'SA',collectionProxyExitCountries:['SA']});
  store.setActiveCollectionRoute(route.routeProfileId);
  await mkdir(path.join(dir,'providers'),{mode:0o700});
  const key='TEST_ONLY_PROVIDER_KEY_NEVER_PUBLIC';
  await writeFile(path.join(dir,'providers','tikhub.json'),JSON.stringify({apiKey:key,ranking:{enabled:true}}),{mode:0o600});
  store.upsertProspect({ source:'tiktok_live', handle:'context.creator', userId:'6914237923885843458',roomId:'7689848338484579093',creatorCountryCode:'SA',observedAt:'2026-09-26T16:00:00Z' });
  const filters={discoveryMethod:'tikhub_rankings',marketRegion:'MENA',countryCodes:['SA']};
  const run=await client.call('create_discovery_run',{source:'tiktok_live',mode:'semi_auto',filters,routeProfileId:route.routeProfileId});
  assert.equal(run.filters.tikHubRankingKind,'league'); assert.equal(run.filters.tikHubRankingPeriod,'current'); assert.equal(run.filters.maxCandidates,100);
  assert.deepEqual(run.config.tikhubRankingSeeds,[{anchorId:'6914237923885843458',roomId:'7689848338484579093',countryCode:'SA'}]);
  for(const extra of [{tikHubRankingKind:'bad'},{tikHubRankingPeriod:'tomorrow'},{highQualityMode:true},{excludeSellers:true},{apiKey:key},{url:'https://example.invalid'}]){
    await assert.rejects(client.call('create_discovery_run',{source:'tiktok_live',mode:'semi_auto',filters:{...filters,...extra}}),e=>['unsupported_filter','unsupported_tikhub_filter','tikhub_request_invalid'].includes(e.code));
  }
  const status=await client.call('status');
  assert.equal(status.capabilities.discovery.tikhubRankings.state,'configured');
  assert.equal(status.capabilities.discovery.tikhubRankings.originalParity,false);
  assert.equal(status.capabilities.discovery.regionalGiftRanking.authorizationReady,false);
  assert.equal(JSON.stringify({run,status,audit:await client.call('audit_events')}).includes(key),false);
  const normal=await client.call('create_discovery_run',{source:'tiktok_live',mode:'semi_auto',filters:{marketRegion:'MENA',countryCodes:['SA']}});
  assert.equal(normal.filters.discoveryMethod,'regional_gift_ranking');
});
