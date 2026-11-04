import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../core.js';
import {MonitorService} from '../service.js';

const SOURCE='https://discord.com/channels/123456789012345678/234567890123456789';
const GROUP='oc_examplegroup123456';
const config=(extra={})=>({name:'测试监测方案',sources:[SOURCE],recipients:[{type:'self'}],time:'10:00',timezone:'Asia/Shanghai',...extra});
function fixture(){let state={},now=Date.parse('2026-11-04T06:00:00Z');const files=new Map();const io={now:()=>now,readConfig:async()=>C.clone(state),writeConfig:async value=>{state=C.clone(value);},readReport:async path=>files.has(path)?C.clone(files.get(path)):null,writeReport:async(path,value)=>{files.set(path,C.clone(value));},deleteReport:async path=>{files.delete(path);}};return {service:new MonitorService(io),io,files,clock:value=>{now=Date.parse(value);}};}
async function saved(extra){const f=fixture();f.monitor=await f.service.save(config(extra),0);return f;}
async function report(f,date='2026-11-03'){return f.service.storeReport({monitor_id:f.monitor.id,expected_revision:f.monitor.revision,report_date:date,status:'no_new',body:'开发测试日报：无新增。',message_count:0});}
const begin=(f,key='self:',date='2026-11-03')=>f.service.beginDelivery({monitor_id:f.monitor.id,expected_revision:f.monitor.revision,report_date:date,recipient_key:key});
const complete=(f,attempt,extra={})=>f.service.completeDelivery({monitor_id:f.monitor.id,report_date:'2026-11-03',recipient_key:attempt.recipient.key,delivery_token:attempt.delivery_token,status:'sent',message_id:'om_test_message_123',...extra});

test('normalizes and deduplicates server entry points, never preserving credentials or query strings',()=>{
 const m=C.normalizeMonitor(config({sources:[SOURCE+'?token=discarded',SOURCE.replace('234567890123456789','345678901234567890')],token:'never store me'}));
 assert.equal(m.sources.length,1);assert.equal(m.sources[0].url,SOURCE);assert.ok(!JSON.stringify(m).includes('token'));
 assert.equal(C.normalizeSource('https://discord.com/invite/exampleCode').url,'https://discord.gg/exampleCode');
});
test('rejects lookalike domains, credentials, HTTP and DM links',()=>{
 for(const url of ['https://discord.com.evil.example/channels/123456789012345678/234567890123456789','https://user:secret@discord.com/invite/example','http://discord.gg/example','https://discord.com/channels/@me/234567890123456789','https://discord.gg:8443/example'])assert.throws(()=>C.normalizeSource(url),C.MonitorError);
});
test('channel-only coverage requires exact channels and keeps different channel IDs',()=>{
 assert.throws(()=>C.normalizeSource('https://discord.gg/example','channels'),{code:'CHANNEL_LINK_REQUIRED'});
 assert.equal(C.normalizeMonitor(config({scope:'channels',sources:[SOURCE,SOURCE.replace('234567890123456789','345678901234567890')]})).sources.length,2);
});
test('recipient values are typed, normalized and deduplicated',()=>{
 assert.equal(C.normalizeRecipient({type:'email',value:'Owner@Example.com'}).key,'email:owner@example.com');
 assert.equal(C.normalizeRecipient({type:'chat_id',value:`https://applink.feishu.cn/client/chat/open?openChatId=${GROUP}`}).value,GROUP);
 assert.throws(()=>C.normalizeRecipient({type:'chat_id',value:'ou_exampleuser123'}),{code:'INVALID_RECIPIENT'});
 assert.throws(()=>C.normalizeRecipient({type:'email',value:'not-an-email'}),{code:'INVALID_RECIPIENT'});
 assert.equal(C.normalizeMonitor(config({recipients:[{type:'self'},{type:'self'}]})).recipients.length,1);
});
test('previous calendar day respects Shanghai midnight, not UTC midnight',()=>{
 const p=C.reportWindow('Asia/Shanghai',Date.parse('2026-11-03T16:05:00Z'));
 assert.deepEqual(p,{date:'2026-11-03',timezone:'Asia/Shanghai',start:'2026-11-02T16:00:00.000Z',endExclusive:'2026-11-03T16:00:00.000Z'});
});
test('daylight-saving days span 23 or 25 hours',()=>{
 for(const [date,hours]of [['2026-03-08',23],['2026-11-01',25]]){const p=C.reportWindow('America/New_York',0,date);assert.equal((Date.parse(p.endExclusive)-Date.parse(p.start))/3600000,hours);}
});
test('invalid dates, zones and times produce actionable domain errors',()=>{
 for(const date of ['2026-02-30','2026-13-01','not-a-date'])assert.throws(()=>C.validDate(date),{code:'INVALID_DATE'});
 assert.throws(()=>C.validateTimeZone('Mars/Olympus'),{code:'INVALID_TIMEZONE'});
 assert.throws(()=>C.normalizeMonitor(config({time:'25:00'})),{code:'INVALID_TIME'});
});
test('stale editors cannot overwrite configuration and updates use fresh recipients',async()=>{
 const f=await saved();const a=await f.service.save({...config(),id:f.monitor.id,name:'新名称'},1);
 await assert.rejects(f.service.save({...config(),id:f.monitor.id,name:'旧页面'},1),{code:'REVISION_CONFLICT'});
 const b=await f.service.save({...config({sources:['https://discord.gg/newCommunity'],recipients:[{type:'email',value:'team@example.com'}]}),id:a.id},a.revision);
 const plan=await f.service.prepare(b.id,'send');assert.equal(plan.recipients[0].value,'team@example.com');assert.equal(plan.scope.sources[0].url,'https://discord.gg/newCommunity');
});
test('a disabled or deleted monitor causes a run to skip',async()=>{
 const f=await saved({enabled:false});assert.equal((await f.service.prepare(f.monitor.id)).state,'paused');
 await f.service.remove(f.monitor.id,1);assert.equal((await f.service.prepare(f.monitor.id)).state,'deleted');
});
test('preview is the default and schedule preparation is not activation',async()=>{
 const f=await saved();assert.equal((await f.service.prepare(f.monitor.id)).mode,'preview');
 const p=await f.service.schedule(f.monitor.id);assert.equal(p.cronExpr,'0 10 * * *');assert.equal(p.timezone,'Asia/Shanghai');assert.ok(p.prompt.length<1800);assert.ok(!Object.hasOwn(p,'active'));
});
test('a delivery needs a saved, successfully collected report',async()=>{
 const f=await saved();await assert.rejects(begin(f),{code:'REPORT_NOT_READY'});
 await f.service.storeReport({monitor_id:f.monitor.id,expected_revision:1,report_date:'2026-11-03',status:'collection_failed',body:'采集失败。',message_count:null});
 await assert.rejects(begin(f),{code:'REPORT_NOT_READY'});
 await assert.rejects(f.service.storeReport({monitor_id:f.monitor.id,expected_revision:1,report_date:'2026-11-03',status:'no_new',body:'无新增。',message_count:null}),{code:'INVALID_REPORT'});
});
test('concurrent delivery attempts acquire only one reservation',async()=>{
 const f=await saved();await report(f);const results=await Promise.all([begin(f),begin(f)]);
 assert.equal(results.filter(r=>r.state==='claimed').length,1);assert.equal(results.filter(r=>r.state==='needs_review').length,1);
 assert.ok(results[0].uuid.length<=50);
});
test('success requires a genuine-shaped receipt and a matching claim token',async()=>{
 const f=await saved();await report(f);const attempt=await begin(f);
 await assert.rejects(complete(f,attempt,{message_id:''}),{code:'RECEIPT_REQUIRED'});
 await assert.rejects(complete(f,attempt,{delivery_token:'other-token'}),{code:'INVALID_DELIVERY_TOKEN'});
 await complete(f,attempt);assert.equal((await begin(f)).state,'already_sent');
});
test('partial multi-recipient delivery does not resend successful recipients',async()=>{
 const f=await saved({recipients:[{type:'self'},{type:'chat_id',value:GROUP}]});await report(f);
 const first=await begin(f);await complete(f,first);
 const second=await begin(f,'chat_id:'+GROUP);await complete(f,second,{status:'failed',message_id:undefined,note:'上游明确未执行'});
 assert.equal((await begin(f)).state,'already_sent');
 const retry=await begin(f,'chat_id:'+GROUP);assert.equal(retry.state,'claimed');assert.equal(retry.uuid,second.uuid);
 await assert.rejects(complete(f,retry,{chat_id:'oc_wrongtarget123'}),{code:'RECEIPT_TARGET_MISMATCH'});
 await complete(f,retry,{chat_id:GROUP});const run=await f.service.getReport(f.monitor.id,'2026-11-03');assert.ok(Object.values(run.deliveries).every(d=>d.status==='sent'));
});
test('unknown outcomes remain held, even after a long delay',async()=>{
 const f=await saved();await report(f);const a=await begin(f);await complete(f,a,{status:'uncertain',message_id:undefined,note:'网络超时，执行结果未知'});
 f.clock('2026-12-03T06:00:00Z');assert.equal((await begin(f)).state,'needs_review');
 await assert.rejects(report(f),{code:'DELIVERY_PENDING'});
});
test('changing a recipient invalidates stale send plans',async()=>{
 const f=await saved();await report(f);await f.service.save({...config({recipients:[{type:'email',value:'new@example.com'}]}),id:f.monitor.id},1);
 await assert.rejects(begin(f),{code:'REVISION_CONFLICT'});
});
test('missing known report data fails closed instead of recreating an empty delivery ledger',async()=>{
 const f=await saved();await report(f);f.files.clear();await assert.rejects(f.service.prepare(f.monitor.id,'send'),{code:'REPORT_UNAVAILABLE'});
});
test('failed private-storage writes cannot grant permission to send',async()=>{
 const f=await saved();await report(f);f.io.writeReport=async()=>{throw new Error('storage unavailable');};await assert.rejects(begin(f),/storage unavailable/);
});
test('retention removes completed history but preserves unresolved deliveries',async()=>{
 const f=await saved({historyDays:7});await report(f,'2026-10-20');await report(f,'2026-10-21');
 const a=await begin(f,'self:','2026-10-21');assert.equal(a.state,'claimed');
 const r=await f.service.cleanup(f.monitor.id);assert.equal(r.removed,1);assert.ok(!f.files.has(C.reportPath(f.monitor.id,'2026-10-20')));assert.ok(f.files.has(C.reportPath(f.monitor.id,'2026-10-21')));
});
test('corrupt configuration is not interpreted as a fresh installation',()=>{assert.throws(()=>C.validateState({version:0,monitors:[]}),{code:'STATE_UNAVAILABLE'});});
test('delivery idempotency keys are stable per target and distinct across targets and dates',async()=>{
 const a=await C.deliveryKey('m_example','2026-11-03','self:');assert.equal(a,await C.deliveryKey('m_example','2026-11-03','self:'));assert.notEqual(a,await C.deliveryKey('m_example','2026-11-03','email:team@example.com'));assert.notEqual(a,await C.deliveryKey('m_example','2026-11-04','self:'));
});
