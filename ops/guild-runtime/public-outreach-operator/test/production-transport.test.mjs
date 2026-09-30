import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAppiumDriver } from '../src/ios/appium-driver.mjs';
import { createProductionExecutor } from '../src/production-executor.mjs';
import { createDeerflowOutreachAdapter } from '../src/native-adapter.mjs';
import { acquireResourceSlot } from '../src/resource-slots.mjs';
async function server(handler) { const http = createServer(handler); await new Promise((r) => http.listen(0, '127.0.0.1', r)); return { url: `http://127.0.0.1:${http.address().port}`, close: () => new Promise((r) => http.close(r)) }; }
test('Appium transport checks device UDID and actual WDA build, then deletes the session', async () => {
 const commands = [];
 const http = await server(async (req, res) => { let body='';for await (const chunk of req) body+=chunk; const data=body?JSON.parse(body):{}; commands.push({url:req.url,method:req.method,data}); let value={};
 if(req.url==='/session' && req.method==='POST') value={sessionId:'session',capabilities:{platformName:'iOS','appium:automationName':'XCUITest','appium:udid':'test-udid'}};
 else if(data.script==='mobile: deviceInfo') value={UniqueDeviceID:'test-udid'};
 else if(data.script==='mobile: isLocked') value=false;
 else if(req.url==='/status') value={ready:true,build:{productBundleIdentifier:'test.wda',time:'today'},os:{name:'iOS'}};
 else if(req.url.endsWith('/elements')) value=[{'element-6066-11e4-a52e-4f735466cecf':'element'}];
 else if(req.url.endsWith('/displayed')) value=true;
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({value})); });
 try { const driver = await createAppiumDriver({ appiumUrl:http.url,wdaUrl:http.url,udid:'test-udid',wdaBundleId:'test.wda',bundleId:'test.tiktok',platformVersion:'18' });
 assert.equal((await driver.verifyHealth()).probe.device_verified,true);
 await driver.findElements('-ios predicate string','label == "hello"');await driver.activateApp('test.tiktok');await driver.deleteSession();
 assert.equal(commands.at(-1).method,'DELETE');assert.equal(commands.find((c)=>c.url==='/session').data.capabilities.alwaysMatch['appium:noReset'],true);
 } finally { await http.close(); }
});
test('default production gate performs no Chromium import, driver creation or action', async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),'production-gate-'));
 const executor=createProductionExecutor({runtimeRoot:root,config:{},chromium:{launchPersistentContext:()=>{throw Error('must not launch');}}});
 assert.equal((await executor.execute({account:{owner_user_id:'owner',sender_account_id:'alice',channel:'web'},creator:{creator_uid:'creator'},action:'like'})).error_code,'pilot_required'); await executor.close();
});
test('native MCP adapter rejects supplied owner override and completion receipt before HTTP', async () => {
 let calls=0; const adapter=await createDeerflowOutreachAdapter({gatewayUrl:'http://127.0.0.1:1',ownerUserId:'alice',internalToken:'test',fetch:async()=>{calls++;throw Error('must not fetch');}});
 await assert.rejects(adapter.listSenderAccounts({owner_user_id:'bob'}), /identity/);
 await assert.rejects(adapter.completeAction({task_id:'task',receipt:{verified:true}}), /receipt/);assert.equal(calls,0);
});
test('global slot leases fence ten active web sessions across independent executors', async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),'global-slots-'));const slots=await Promise.all(Array.from({length:11},()=>acquireResourceSlot({root,kind:'web',maximum:10})));
 assert.equal(slots.filter((slot)=>slot.ok).length,10);assert.equal(slots.filter((slot)=>!slot.ok)[0].error_code,'capacity_exhausted');
 await Promise.all(slots.filter((slot)=>slot.ok).map((slot)=>slot.release()));
 assert.equal((await acquireResourceSlot({root,kind:'web',maximum:10})).ok,true);
});
test('production Web opens trusted TikTok home before reading sender from a blank page', async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),'web-startup-'));let url='about:blank';let active=false;let closed=false;
 const proxy=await server((_req,res)=>res.end());
 const element=(attrs={})=>({isVisible:async()=>url!=='about:blank',getAttribute:async(key)=>attrs[key]??null,textContent:async()=>'',click:async()=>{active=true;}});
 const controls={'[sender]':element({'data-sender-handle':'@alice'}),'[profile]':element({'data-creator-uid':'creator'}),'[like]':{...element(),getAttribute:async()=>String(active)}};
 const page={goto:async(target)=>{if(target.includes('cloudflare.com'))return {status:()=>200,text:async()=> 'ip=203.0.113.7\nloc=US\n'};assert.equal(target,'https://www.tiktok.com/');url=target;},locator:(selector)=>({first:()=>controls[selector]??{isVisible:async()=>false},count:async()=>controls[selector]?1:0}),close:async()=>{}};
 const config={pilot:{enabled:true,owner_user_id:'owner',sender_account_id:'alice',creator_uid:'creator',actions:['like']},sender:{owner_user_id:'owner',sender_account_id:'alice',channel:'web',web_route:{proxy_server:proxy.url,expected_country:'US'},locators:{loggedInSender:'[sender]',creatorIdentity:'[profile]',profileRoot:'[profile]',likeButton:'[like]'}}};
 const executor=createProductionExecutor({runtimeRoot:root,config,chromium:{launchPersistentContext:async()=>({newPage:async()=>page,close:async()=>{closed=true;}})}});
 try {const account={owner_user_id:'owner',sender_account_id:'alice',channel:'web',external_ref:'@alice'};
 const preparation=await executor.prepareWeb({account});assert.equal(preparation.ready,true);
 const result=await executor.execute({account,creator:{creator_uid:'creator'},action:'like',preparation_id:preparation.preparation_id});
 assert.equal(result.verified,true);assert.equal(closed,true);await executor.close();} finally {await proxy.close();}
});
test('an orphaned iPhone slot requires manual Appium session cleanup before reuse', async () => {
 const { spawn } = await import('node:child_process');
 const root=await mkdtemp(path.join(os.tmpdir(),'ios-orphan-'));
 const moduleUrl=new URL('../src/resource-slots.mjs',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`import { acquireResourceSlot } from ${JSON.stringify(moduleUrl)};await acquireResourceSlot({root:${JSON.stringify(root)},kind:'ios',maximum:1});process.exit(0);`]);
 await new Promise((resolve,reject)=>{child.once('exit',(code)=>code===0?resolve():reject(Error('child failed')));});
 assert.equal((await acquireResourceSlot({root,kind:'ios',maximum:1})).error_code,'capacity_exhausted');
});
test('eleven real Node processes sharing one root cannot exceed ten active Web slots', async () => {
 const { spawn } = await import('node:child_process');
 const root=await mkdtemp(path.join(os.tmpdir(),'web-process-cap-'));
 const moduleUrl=new URL('../src/resource-slots.mjs',import.meta.url).href;
 const children=[];
 try {
   const results=await Promise.all(Array.from({length:11},async()=>{
     const code=`import { acquireResourceSlot } from ${JSON.stringify(moduleUrl)};const slot=await acquireResourceSlot({root:${JSON.stringify(root)},kind:'web',maximum:10});process.stdout.write(JSON.stringify({ok:slot.ok,error_code:slot.error_code})+'\\n');process.stdin.resume();process.stdin.on('end',async()=>{await slot.release?.();process.exit(0);});`;
     const child=spawn(process.execPath,['--input-type=module','-e',code]);children.push(child);
     return await new Promise((resolve,reject)=>{child.stdout.once('data',(data)=>resolve(JSON.parse(data.toString())));child.once('error',reject);});
   }));
   assert.equal(results.filter((result)=>result.ok).length,10);
   assert.equal(results.find((result)=>!result.ok).error_code,'capacity_exhausted');
 } finally {
   await Promise.all(children.map((child)=>new Promise((resolve)=>{child.once('exit',resolve);child.stdin.end();})));
 }
 const slot=await acquireResourceSlot({root,kind:'web',maximum:10});assert.equal(slot.ok,true);await slot.release();
});
