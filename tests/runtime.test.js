import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../core.js';
import {MonitorService} from '../service.js';
import {MonitorRuntime} from '../runtime.js';
const SOURCE='https://discord.com/channels/123456789012345678/234567890123456789';
const config=extra=>({name:'测试方案',sources:[SOURCE],recipients:[{type:'self'}],...extra});
function environment(){let cfg={},time=Date.parse('2026-11-05T03:00:00Z');const files=new Map(),tasks=new Map(),runs=new Map();const calls={create:0,grant:0,send:0,plan:0};let denied=false,failSend=false;
 const io={now:()=>time,readConfig:async()=>C.clone(cfg),writeConfig:async v=>{cfg=C.clone(v);},readReport:async p=>files.has(p)?C.clone(files.get(p)):null,writeReport:async(p,v)=>{files.set(p,C.clone(v));},deleteReport:async p=>{files.delete(p);}};
 const sdk={capabilities:async()=>({operations:['create','get','send','getRun','requestWriteAccess','setTeamPlan']}),create:async args=>{calls.create++;const t={taskId:'task-'+calls.create,status:'active',revision:0,permissionMode:'ask',workingDir:'/example/task-workspace',resolvedConfig:{agentKind:'codex',providerId:'example',model:'example-model',effort:'',fastMode:false},args};tasks.set(t.taskId,t);return C.clone(t);},get:async({taskId})=>C.clone(tasks.get(taskId)),setTeamPlan:async({taskId,plan})=>{calls.plan++;tasks.get(taskId).plan=plan;return {ok:true};},requestWriteAccess:async({taskId,mode})=>{calls.grant++;if(denied)return {granted:false};const t=tasks.get(taskId);t.permissionMode=mode;t.revision++;return {granted:true};},send:async args=>{calls.send++;if(failSend)throw Object.assign(new Error('unknown dispatch'),{code:'HOST_NOT_READY'});assert.equal(args.expectedRevision,tasks.get(args.taskId).revision);const run={runId:'run-'+calls.send,status:'completed',args,taskId:args.taskId};runs.set(run.runId,run);return C.clone(run);},getRun:async({runId})=>C.clone(runs.get(runId))};
 const service=new MonitorService(io),runtime=new MonitorRuntime(service,sdk);return {service,runtime,sdk,calls,files,tasks,runs,deny:()=>{denied=true;},fail:()=>{failSend=true;},advance:()=>{time+=86400000;}};
}
async function configured(extra={}){const e=environment();e.monitor=await e.service.save(config(extra),0);await e.runtime.configure(e.monitor.id,'setup-click');await finishSetup(e);return e;}
async function finishSetup(e){const {monitor}=await e.service.monitor(e.monitor.id);return e.service.completeSetup({monitor_id:monitor.id,setup_token:monitor.runtime.setupToken,success:true,source_checks:monitor.sources.map(s=>({url:s.url,accessible:true})),connection:{pluginId:'example-feishu',namespace:null,accountOpenId:'ou_exampleowner123',accountName:'测试账号',mailboxAddress:'owner@example.com'}});}
test('first configuration requests native permission once; later sends reuse the same task',async()=>{
 const e=await configured();assert.deepEqual(e.calls,{create:1,grant:1,send:1,plan:1});
 await e.runtime.start(e.monitor.id,'preview','preview-click');await e.runtime.start(e.monitor.id,'send','send-click');
 assert.equal(e.calls.create,1);assert.equal(e.calls.grant,1);assert.equal(e.calls.send,3);
 const restarted=new MonitorRuntime(e.service,e.sdk);await restarted.start(e.monitor.id,'preview','after-restart');assert.equal(e.calls.create,1);assert.equal(e.calls.grant,1);
});
test('send before setup never creates a task or asks for permission',async()=>{
 const e=environment();const m=await e.service.save(config(),0);await assert.rejects(e.runtime.start(m.id,'send','click'),{code:'SETUP_REQUIRED'});assert.deepEqual(e.calls,{create:0,grant:0,send:0,plan:0});
});
test('denied native permission is not bypassed by creating another worker on send',async()=>{
 const e=environment();e.deny();const m=await e.service.save(config(),0);await assert.rejects(e.runtime.configure(m.id,'setup'),{code:'AUTHORIZATION_REQUIRED'});await assert.rejects(e.runtime.start(m.id,'send','send'),{code:'SETUP_REQUIRED'});assert.deepEqual(e.calls,{create:1,grant:1,send:0,plan:1});
});
test('a revoked native permission blocks send without automatically re-prompting',async()=>{
 const e=await configured();e.tasks.get('task-1').permissionMode='ask';await assert.rejects(e.runtime.start(e.monitor.id,'send','click'),{code:'AUTHORIZATION_REQUIRED'});assert.equal(e.calls.grant,1);assert.equal(e.calls.create,1);
});
test('sources, recipients or channel changes invalidate setup, but time/focus changes do not',async()=>{
 const e=await configured();let {monitor:m}=await e.service.monitor(e.monitor.id);m=await e.service.save({...m,sources:m.sources.map(s=>s.url),time:'11:30',focus:'玩家期待'},m.revision);assert.ok(C.setupReady(m));
 m=await e.service.save({...m,sources:m.sources.map(s=>s.url),deliveryChannel:'mail'},m.revision);assert.ok(!C.setupReady(m));await assert.rejects(e.runtime.start(m.id,'send','click'),{code:'SETUP_REQUIRED'});
 await e.runtime.configure(m.id,'configure-mail');await finishSetup(e);assert.equal(e.calls.create,2);assert.equal(e.calls.grant,2);
});
test('a running report is reused instead of queued twice',async()=>{
 const e=await configured();const first=await e.runtime.start(e.monitor.id,'send','click-one');e.runs.get(first.runId).status='running';const second=await e.runtime.start(e.monitor.id,'send','click-two');assert.ok(second.reused);assert.equal(second.runId,first.runId);assert.equal(e.calls.send,2);
});
test('each daily reporting date dispatches once, including duplicate schedule triggers',async()=>{
 const e=await configured();const first=await e.runtime.dispatch(e.monitor.id);const again=await e.runtime.dispatch(e.monitor.id);assert.equal(again.state,'already_triggered');assert.equal(e.calls.send,2);e.advance();const next=await e.runtime.dispatch(e.monitor.id);assert.notEqual(first.runId,next.runId);assert.equal(e.calls.send,3);
});
test('unknown dispatch does not get a new key or worker on retry',async()=>{
 const e=await configured();e.fail();await assert.rejects(e.runtime.start(e.monitor.id,'send','one'),{code:'HOST_NOT_READY'});await assert.rejects(e.runtime.start(e.monitor.id,'send','two'),{code:'DISPATCH_UNCERTAIN'});assert.equal(e.calls.create,1);assert.equal(e.calls.grant,1);assert.equal(e.calls.send,2);
});
test('connection completion cannot invent a native grant or accept stale setup tokens',async()=>{
 const e=environment();e.monitor=await e.service.save(config(),0);await assert.rejects(e.service.completeSetup({monitor_id:e.monitor.id,setup_token:'invented',success:true}),{code:'SETUP_EXPIRED'});await e.runtime.configure(e.monitor.id,'setup');const old=(await e.service.monitor(e.monitor.id)).monitor.runtime.setupToken;
 let m=(await e.service.monitor(e.monitor.id)).monitor;await e.service.save({...m,sources:['https://discord.gg/anotherCommunity']},m.revision);await assert.rejects(e.service.completeSetup({monitor_id:m.id,setup_token:old,success:true}),{code:'SETUP_EXPIRED'});
});
test('chat email lookup and real mail use different delivery identities',()=>{
 const chat=C.normalizeMonitor(config({recipients:[{type:'email',value:'reader@example.com'}]}));const mail=C.normalizeMonitor(config({deliveryChannel:'mail',recipients:[{type:'email',value:'reader@example.com'}]}));assert.notEqual(chat.recipients[0].key,mail.recipients[0].key);assert.throws(()=>C.normalizeMonitor(config({deliveryChannel:'mail',recipients:[{type:'chat_id',value:'oc_examplegroup123'}]})),{code:'INVALID_RECIPIENT'});
});
test('mail success requires a mail receipt and matching email addresses, not a chat receipt',async()=>{
 const e=await configured({deliveryChannel:'mail',recipients:[{type:'email',value:'reader@example.com'}]});const m=(await e.service.monitor(e.monitor.id)).monitor;await e.service.storeReport({monitor_id:m.id,expected_revision:m.revision,report_date:'2026-11-04',status:'no_new',body:'邮件渠道测试样报',message_count:0});const a=await e.service.beginDelivery({monitor_id:m.id,expected_revision:m.revision,report_date:'2026-11-04',recipient_key:m.recipients[0].key});
 const args={monitor_id:m.id,report_date:'2026-11-04',recipient_key:m.recipients[0].key,delivery_token:a.delivery_token,status:'sent'};await assert.rejects(e.service.completeDelivery({...args,message_id:'om_chat_only_123'}),{code:'MAIL_RECEIPT_REQUIRED'});
 await assert.rejects(e.service.completeDelivery({...args,mail_message_id:'provider-mail-123',recipient_address:'wrong@example.com',sender_address:'owner@example.com',mail_delivery_status:'delivered'}),{code:'RECEIPT_TARGET_MISMATCH'});
 const result=await e.service.completeDelivery({...args,mail_message_id:'provider-mail-123',recipient_address:'reader@example.com',sender_address:'owner@example.com',mail_delivery_status:'accepted'});assert.ok(result.all_sent);assert.equal(result.all_delivered,false);assert.equal((await e.service.getReport(m.id,'2026-11-04')).deliveries[m.recipients[0].key].mailDeliveryStatus,'accepted');
 const delivered=await e.service.completeDelivery({...args,mail_message_id:'provider-mail-123',recipient_address:'reader@example.com',sender_address:'owner@example.com',mail_delivery_status:'delivered'});assert.ok(delivered.all_delivered);assert.equal((await e.service.beginDelivery({monitor_id:m.id,expected_revision:m.revision,report_date:'2026-11-04',recipient_key:m.recipients[0].key})).state,'already_sent');
});
test('legacy v1 configurations stay in chat instead of silently switching to email',()=>{const raw={version:1,revision:1,monitors:[{...C.normalizeMonitor(config()),deliveryChannel:undefined,runtime:undefined}]};const migrated=C.validateState(JSON.parse(JSON.stringify(raw)));assert.equal(migrated.monitors[0].deliveryChannel,'chat');assert.ok(!C.setupReady(migrated.monitors[0]));});
test('old automation prompts get redirected to the approved reusable worker',async()=>{const e=await configured();const plan=await e.service.prepare(e.monitor.id,'send');assert.equal(plan.state,'dispatch_required');assert.equal(plan.next_tool,'dispatch_report');const spec=await e.service.schedule(e.monitor.id);assert.ok(spec.prompt.includes('dispatch_report'));});
test('legacy update callers cannot silently change an email monitor back to chat',async()=>{const e=await configured({deliveryChannel:'mail',time:'13:45'});const m=(await e.service.monitor(e.monitor.id)).monitor;const saved=await e.service.save({id:m.id,name:m.name,sources:m.sources.map(s=>s.url),recipients:m.recipients,focus:'更新关注事项'},m.revision);assert.equal(saved.deliveryChannel,'mail');assert.equal(saved.time,'13:45');assert.ok(C.setupReady(saved));});
test('native configuration approval receives the exact bounded scope before any input is sent',async()=>{const e=await configured({deliveryChannel:'mail',recipients:[{type:'email',value:'reader@example.com'}]});const plan=e.tasks.get('task-1').plan;assert.equal(plan.concurrency,1);assert.ok(plan.task.includes(SOURCE));assert.ok(plan.task.includes('reader@example.com'));assert.ok(plan.task.includes('飞书邮件'));assert.equal(plan.items[0].workingDir,'/example/task-workspace');assert.equal(e.calls.plan,1);});
