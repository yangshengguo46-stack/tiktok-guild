import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHandlers } from '../src/handlers.mjs';

async function fixture(t, { profileDir, sender, maxWorkflows, workflowTtlMs } = {}) {
  const profile=profileDir ?? await mkdtemp(path.join(os.tmpdir(),'guild-msg-stability-'));
  if (!profileDir) t.after(()=>rm(profile,{recursive:true,force:true}));
  let starts=0,pages=0;
  const context={pages:()=>[],newPage:async()=>{pages++;return {close:async()=>{}};}};
  const sessionOwner={profileDir:profile,getStatus:()=>({state:'running'}),ensureActive:async()=>{starts++;return context;}};
  const handlers=createHandlers({sessionOwner,liveReader:async()=>({data:{},evidence:[]}),guildDiscovery:async()=>({guild_id:'103785'}),
    senderAccountRef:'affiliate:mira.creator_01',senderIdentityText:'Mira',maxWorkflows,workflowTtlMs,
    sendMessage:sender??(async()=>({status:'unknown',provider_status:null,read_back:{visible:true}}))});
  const guild_ref=(await handlers.guild_workspace({})).structuredContent.data.guild_ref;
  const prepare=async(workflow,key,content='hello')=>(await handlers.guild_messaging({guild_ref,child:'prepare_message',params:{workflow_id:workflow,sender_account_ref:'affiliate:mira.creator_01',recipient_handle:'exact.creator',content,idempotency_key:key}})).structuredContent;
  const send=async workflow=>(await handlers.guild_messaging({guild_ref,child:'send_message',params:{workflow_id:workflow}})).structuredContent;
  return {profile,handlers,guild_ref,prepare,send,pages:()=>pages,starts:()=>starts};
}

test('legacy Guild entry retains one messaging page and serializes writes',async t=>{
  let active=0,peak=0,clicks=0;
  const f=await fixture(t,{sender:async()=>{active++;peak=Math.max(active,peak);clicks++;await new Promise(r=>setTimeout(r,20));active--;return {status:'unknown'};}});
  await f.prepare('wf1','one');await f.prepare('wf2','two');
  await Promise.all([f.send('wf1'),f.send('wf2')]);
  assert.equal(peak,1);assert.equal(clicks,2);assert.equal(f.pages(),2);
});

test('legacy Guild keys remain unknown after restart and reject changed payloads',async t=>{
  let clicks=0;const sender=async()=>{clicks++;return {status:'unknown'};};
  const f=await fixture(t,{sender});await f.prepare('wf1','durable');await f.send('wf1');
  const restarted=await fixture(t,{profileDir:f.profile,sender});await restarted.prepare('wf2','durable');
  const duplicate=await restarted.send('wf2');assert.equal(duplicate.errors[0].code,'duplicate_write');assert.equal(clicks,1);
  await restarted.prepare('wf3','durable','changed');const conflict=await restarted.send('wf3');assert.equal(conflict.errors[0].code,'idempotency_conflict');
  const stopped=createHandlers({sessionOwner:{profileDir:f.profile,getStatus:()=>({state:'stopped'}),ensureActive:async()=>{throw new Error('must stay stopped');}},liveReader:async()=>({data:{}}),senderAccountRef:'affiliate:mira.creator_01'});
  for(const child of ['get_operation_status','reconcile_message']) {
    const result=(await stopped.guild_messaging({guild_ref:f.guild_ref,child,params:{idempotency_key:'durable'}})).structuredContent;
    assert.equal(result.status,'ok');assert.equal(result.data.state,'unknown');
  }
});

test('workflow capacity frees after an attempted message and expiry is bounded',async t=>{
  const f=await fixture(t,{maxWorkflows:1,workflowTtlMs:80});
  assert.equal((await f.prepare('wf1','one')).status,'ok');
  assert.equal((await f.prepare('wf2','two')).errors[0].code,'workflow_capacity');
  await f.send('wf1');assert.equal((await f.prepare('wf2','two')).status,'ok');
  await new Promise(r=>setTimeout(r,90));assert.equal((await f.prepare('wf3','three')).status,'ok');
  assert.equal((await f.send('wf2')).errors[0].code,'guild_binding_not_found');
});
