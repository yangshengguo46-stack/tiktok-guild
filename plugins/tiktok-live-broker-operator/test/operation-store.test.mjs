import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const payload = { guild_id:'103785', sender_account_ref:'affiliate:mira.creator_01', recipient_handle:'exact.creator', content:'hello', idempotency_key:'reserved' };
async function stores(t) {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'msg-store-'));
  t.after(() => rm(profileDir, { recursive:true, force:true }));
  const { createOperationStore } = await import('../src/messaging/operation-store.mjs');
  const store = createOperationStore({ profileDir });
  return { profileDir, store, createOperationStore };
}

test('atomic reservation across processes dispatches the same key once', async t => {
  const { profileDir } = await stores(t);
  const source = `import {createOperationStore} from ${JSON.stringify(new URL('../src/messaging/operation-store.mjs', import.meta.url).href)}; const s=createOperationStore({profileDir:process.argv[1]}); try { await s.execute(${JSON.stringify(payload)},async g=>{g.markDispatched(); await new Promise(r=>setTimeout(r,80)); return {status:'unknown'};}); console.log('dispatched'); } catch(e){console.log(e.code);}`;
  const run = () => new Promise((resolve,reject) => { let out=''; const p=spawn(process.execPath,['--input-type=module','-e',source,profileDir]); p.stdout.on('data',c=>out+=c); p.on('error',reject); p.on('exit',code=> code===0 ? resolve(out.trim()) : reject(new Error(`child exit ${code}`))); });
  const outcomes=await Promise.all([run(),run()]);
  assert.equal(outcomes.filter(x=>x==='dispatched').length,1);
  assert.ok(outcomes.some(x=>['duplicate_write','profile_busy'].includes(x)), JSON.stringify(outcomes));
});

test('pending after process crash is unknown and cannot be sent after restart', async t => {
  const { profileDir, createOperationStore } = await stores(t);
  const source = `import {createOperationStore} from ${JSON.stringify(new URL('../src/messaging/operation-store.mjs',import.meta.url).href)}; await createOperationStore({profileDir:process.argv[1]}).execute(${JSON.stringify(payload)},async g=>{g.markDispatched(); process.exit(0);});`;
  await new Promise((resolve,reject) => {const p=spawn(process.execPath,['--input-type=module','-e',source,profileDir]); p.on('error',reject); p.on('exit',c=>c===0?resolve():reject(new Error(`exit ${c}`)));});
  const reopened=createOperationStore({profileDir});
  assert.equal(reopened.get('reserved').state,'unknown');
  await assert.rejects(reopened.execute(payload,async()=>({status:'verified'})),e=>e.code==='duplicate_write');
  await assert.rejects(reopened.execute({...payload,content:'changed'},async()=>({status:'verified'})),e=>e.code==='idempotency_conflict');
});

test('another live profile owner cannot acquire the browser lease', async t => {
  const { store, profileDir, createOperationStore } = await stores(t);
  const lease=store.acquireLease('browser');
  assert.throws(()=>createOperationStore({profileDir}).acquireLease('browser'),e=>e.code==='profile_busy');
  lease.release();
  createOperationStore({profileDir}).acquireLease('browser').release();
});

test('pre-dispatch errors are recorded as not_executed and keys remain reserved', async t => {
  const { store } = await stores(t);
  await assert.rejects(store.execute(payload,async()=>{throw new Error('preflight');}),/preflight/);
  assert.equal(store.get('reserved').state,'not_executed');
  await assert.rejects(store.execute(payload,async()=>({status:'verified'})),e=>e.code==='duplicate_write');
});

test('a durable guard is bound to the reserved sender recipient body and key', async t => {
  const { store }=await stores(t);
  await assert.rejects(store.execute(payload,async guard=>{
    guard.assertMessage({...payload,recipient_handle:'other.creator'});
    guard.markDispatched(); return {status:'verified'};
  }),e=>e.code==='authorization_required');
  assert.equal(store.get('reserved').state,'not_executed');
});


test('a SQLite writer lock blocks dispatch with the profile_busy contract', async t => {
  const { profileDir, store }=await stores(t); store.get('initialize');
  const { DatabaseSync }=await import('node:sqlite');
  const lock=new DatabaseSync(path.join(profileDir,'.message-operations','operations.sqlite'));
  lock.exec('BEGIN IMMEDIATE');
  t.after(()=>{lock.exec('ROLLBACK');lock.close();});
  const source=`import {createOperationStore} from ${JSON.stringify(new URL('../src/messaging/operation-store.mjs',import.meta.url).href)}; try { await createOperationStore({profileDir:process.argv[1]}).execute(${JSON.stringify(payload)}, async g=>{g.markDispatched();return {status:'unknown'};}); console.log('dispatched'); } catch(e) {console.log(e.code);}`;
  const result=await new Promise((resolve,reject)=>{let out='';const p=spawn(process.execPath,['--input-type=module','-e',source,profileDir]);p.stdout.on('data',c=>out+=c);p.on('error',reject);p.on('exit',code=>code===0?resolve(out.trim()):reject(new Error(`exit ${code}`)));});
  assert.equal(result,'profile_busy');
});


test('a SQLite lock after dispatch returns unknown and token cleanup permits a new key', async t => {
  const { profileDir, store, createOperationStore }=await stores(t);
  const { DatabaseSync }=await import('node:sqlite');
  let lock;
  let attempts=0;
  t.after(()=>{try{lock?.exec('ROLLBACK');}catch{}lock?.close();});
  const result=await store.execute(payload,async guard=>{
    guard.markDispatched(); attempts++;
    lock=new DatabaseSync(path.join(profileDir,'.message-operations','operations.sqlite'));
    lock.exec('BEGIN IMMEDIATE');
    return {status:'verified',provider_status:200,provider_receipt:{verified:true,provider_message_id:'real-id'}};
  });
  assert.equal(result.status,'unknown');
  assert.equal(result.reason,'operation_persistence_unavailable');
  assert.equal(store.get('reserved').state,'unknown');
  // A separate store in the same live PID must not reclaim an active/deferred token.
  await assert.rejects(createOperationStore({profileDir}).execute({...payload,idempotency_key:'other'},async()=>{attempts++;return {status:'unknown'};}),e=>e.code==='profile_busy');
  lock.exec('ROLLBACK');
  const next=await store.execute({...payload,idempotency_key:'new-key'},async guard=>{guard.markDispatched();attempts++;return {status:'unknown'};});
  assert.equal(next.status,'unknown');
  await assert.rejects(store.execute(payload,async()=>{attempts++;return {status:'verified'};}),e=>e.code==='duplicate_write');
  assert.equal(attempts,2);
});


test('lookup_handle is a search locator, not part of UID idempotency identity',async t=>{
  const {store}=await stores(t);
  const args={...payload,recipient_handle:undefined,creator_id:'7667651908912448533',lookup_handle:'exact.creator'};
  await store.execute(args,async g=>{g.assertMessage(args);g.markDispatched();return {status:'unknown'};});
  await assert.rejects(store.execute({...args,lookup_handle:'changed.creator'},async()=>({status:'verified'})),e=>e.code==='duplicate_write');
  await store.execute({...args,idempotency_key:'other'},async g=>{g.assertMessage({...args,idempotency_key:'other',lookup_handle:'changed.creator'});return {status:'verified'};});
});
