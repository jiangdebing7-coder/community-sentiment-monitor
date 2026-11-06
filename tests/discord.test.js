import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../core.js';
import {MonitorService} from '../service.js';
import {DiscordApi,beforeSnowflake,canReadHistory,channelPermissions,botInviteUrl} from '../discord-api.js';
import {DiscordCollector} from '../discord-collector.js';

const G='123456789012345678',CH='234567890123456789',BOT='345678901234567890',ROLE='456789012345678901',APP='567890123456789012';
const SOURCE=`https://discord.com/channels/${G}/${CH}`;
const DATE='2026-11-04',PERIOD=C.reportWindow('Asia/Shanghai',0,DATE);
const idAt=(time,n=0)=>(BigInt(beforeSnowflake(time))+BigInt(n)).toString();
const msg=(time,n=0,extra={})=>({id:idAt(time,n),channel_id:CH,timestamp:time,type:0,content:'玩家讨论',author:{id:'678901234567890123',username:'example-player',bot:false},...extra});
function environment(options={}){
 let state={},now=Date.parse('2026-11-05T03:00:00Z');const files=new Map(),requests=[],writes=[];
 const guild={id:G,name:'Example community',owner_id:'789012345678901234',roles:[{id:G,permissions:'0'},{id:ROLE,permissions:'66560'}]};
 const channel={id:CH,guild_id:G,name:'game-discussion',type:0,permission_overwrites:[]};
 const io={now:()=>now,readConfig:async()=>C.clone(state),writeConfig:async s=>{state=C.clone(s);},readReport:async p=>files.has(p)?C.clone(files.get(p)):null,writeReport:async(p,v)=>{writes.push(p);files.set(p,C.clone(v));},deleteReport:async p=>{files.delete(p);}};
 const service=new MonitorService(io);
 const defaults=(path)=>path==='/users/@me'?{id:BOT,username:'example-bot',bot:true}:path==='/oauth2/applications/@me'?{id:APP,flags:1<<19}:path===`/guilds/${G}`?guild:path===`/guilds/${G}/members/${BOT}`?{roles:[ROLE]}:path===`/guilds/${G}/channels`?[channel]:path===`/channels/${CH}`?channel:path.endsWith('/threads/active')?{threads:[]}:path.includes('/threads/archived/')?{threads:[],has_more:false}:path===`/channels/${CH}/messages`?[]:undefined;
 const fetch=async request=>{
  assert.equal(request.method,'GET');assert.ok(!Object.keys(request.headers).some(k=>k.toLowerCase()==='authorization'));
  const url=new URL(request.url);assert.equal(url.origin,'https://discord.com');const path=url.pathname.replace('/api/v10','');requests.push({path,query:Object.fromEntries(url.searchParams)});
  const override=options.respond?await options.respond(path,url,requests):undefined;
  if(override?.response)return override.response;
  const data=override===undefined?defaults(path):override;assert.notEqual(data,undefined,'Unexpected route '+path);
  return {ok:true,status:200,headers:{},body:JSON.stringify(data)};
 };
 const collector=new DiscordCollector(service,io,fetch,{batchRequests:options.batchRequests??25,chunkBytes:options.chunkBytes??2000000,sleep:async ms=>{now+=ms;}});
 return {service,collector,io,files,requests,writes,guild,channel,advance:ms=>{now+=ms;}};
}
async function ready(e,extra={}){
 let m=await e.service.save({name:'Example monitor',collectionMode:'bot',scope:'channels',sources:[SOURCE],recipients:[{type:'self'}],...extra},0);
 m=await e.service.bindDiscordPreflight(m.id,await e.collector.preflight(m));const scope=C.authorizationScope(m);
 await e.service.updateRuntime(m.id,r=>({...r,authorizedScope:scope,readyScope:scope,setupStatus:'ready',connection:{pluginId:'example-feishu',namespace:null,accountOpenId:'ou_exampleaccount123'}}));
 return (await e.service.monitor(m.id)).monitor;
}
async function finish(e,m){let r;for(let n=0;n<100;n++){r=await e.collector.sync(m.id,DATE);if(r.state!=='collecting')return r;}throw new Error('Collection never finished');}

test('bot invitation requests only view and history permissions for the configured guild',()=>{
 const url=new URL(botInviteUrl(APP,G));assert.equal(url.searchParams.get('permissions'),'66560');assert.equal(url.searchParams.get('scope'),'bot');assert.equal(url.searchParams.get('guild_id'),G);assert.equal(url.searchParams.get('disable_guild_select'),'true');
});
test('effective permissions apply everyone, role and member overrides in Discord order',()=>{
 const guild={id:G,roles:[{id:G,permissions:'66560'},{id:ROLE,permissions:'0'}]};const member={roles:[ROLE]};const channel={guild_id:G,permission_overwrites:[{id:G,type:0,deny:'65536',allow:'0'},{id:ROLE,type:0,deny:'0',allow:'65536'},{id:BOT,type:1,deny:'65536',allow:'0'}]};
 assert.equal(canReadHistory(guild,member,channel,BOT),false);channel.permission_overwrites.pop();assert.equal(canReadHistory(guild,member,channel,BOT),true);
 assert.throws(()=>channelPermissions({...guild,roles:[]},member,channel,BOT),{code:'DISCORD_PERMISSIONS_UNVERIFIED'});
});
test('a personal token response or missing content intent cannot pass bot setup',async()=>{
 const personal=environment({respond:path=>path==='/users/@me'?{id:BOT,bot:false}:undefined});const m=await personal.service.save({name:'Example',collectionMode:'bot',sources:[SOURCE],recipients:[{type:'self'}]},0);await assert.rejects(personal.collector.preflight(m),{code:'DISCORD_BOT_REQUIRED'});
 const noIntent=environment({respond:path=>path==='/oauth2/applications/@me'?{id:APP,flags:0}:undefined});await assert.rejects(noIntent.collector.preflight(m),{code:'DISCORD_CONTENT_INTENT_REQUIRED'});
});
test('100-item REST pages are date-filtered, deduplicated, cached and reused without another history scan',async()=>{
 const rows=Array.from({length:120},(_,i)=>msg('2026-11-04T12:00:00Z',i));rows.push(msg('2026-11-03T15:59:59Z',1));rows.sort((a,b)=>BigInt(a.id)>BigInt(b.id)?-1:1);
 const e=environment({respond:(path,url)=>path.endsWith('/messages')?rows.filter(m=>BigInt(m.id)<BigInt(url.searchParams.get('before'))).slice(0,100):undefined});const m=await ready(e);const r=await finish(e,m);
 assert.equal(r.state,'ready');assert.equal(r.statistics.total,120);assert.equal(e.requests.filter(r=>r.path.endsWith('/messages')).length,2);assert.ok(e.requests.filter(r=>r.path.endsWith('/messages')).every(r=>r.query.limit==='100'));
 const before=e.requests.filter(r=>r.path.endsWith('/messages')).length;await e.collector.sync(m.id,DATE);assert.equal(e.requests.filter(r=>r.path.endsWith('/messages')).length,before);
 let cursor='0:0',ids=[];do{const data=await e.collector.read(m.id,DATE,cursor);ids.push(...data.messages.map(x=>x.id));cursor=data.next_cursor;}while(cursor);assert.equal(ids.length,120);assert.equal(new Set(ids).size,120);assert.ok(e.writes.every(p=>p.startsWith('discord-cache/')));
});
test('small request budgets resume the same capture after an object restart',async()=>{
 const e=environment({batchRequests:3,respond:path=>path.endsWith('/messages')?[msg('2026-11-04T10:00:00Z')]:undefined});const m=await ready(e);const first=await e.collector.sync(m.id,DATE);assert.equal(first.state,'collecting');
 const fetch=e.collector.api.fetch;const restarted=new DiscordCollector(e.service,e.io,fetch,{batchRequests:6});e.collector=restarted;const result=await finish(e,m);assert.equal(result.state,'ready');assert.equal(result.statistics.total,1);
});
test('history permission denial is never accepted as an empty day',async()=>{
 const e=environment();e.guild.roles[1].permissions='1024';const m=await e.service.save({name:'Example',collectionMode:'bot',scope:'channels',sources:[SOURCE],recipients:[{type:'self'}]},0);await assert.rejects(e.collector.preflight(m),{code:'DISCORD_HISTORY_DENIED'});assert.equal(e.requests.some(r=>r.path.endsWith('/messages')),false);
});
test('an empty message response is rechecked against current permissions',async()=>{
 let deny=false;const e=environment({respond:path=>{if(path===`/guilds/${G}`&&deny)return {id:G,name:'Example',roles:[{id:G,permissions:'0'},{id:ROLE,permissions:'1024'}]};if(path.endsWith('/messages')){deny=true;return [];}return undefined;}});const m=await ready(e);const r=await finish(e,m);assert.equal(r.state,'failed');assert.equal(r.coverageComplete,false);await assert.rejects(e.collector.validateReport({monitor_id:m.id,report_date:DATE,status:'no_new',message_count:0}),{code:'DISCORD_COLLECTION_NOT_READY'});
});
test('rate limits preserve a resumable checkpoint and do not change account or use a browser',async()=>{
 let rate=true;const e=environment({respond:path=>path.endsWith('/messages')&&rate?{response:{ok:true,status:429,headers:{},body:JSON.stringify({retry_after:60,global:true})}}:undefined});const m=await ready(e);const blocked=await finish(e,m);assert.equal(blocked.state,'rate_limited');assert.ok(blocked.nextRetryAt);const count=e.requests.length;await e.collector.sync(m.id,DATE);assert.equal(e.requests.length,count);rate=false;e.advance(61000);const r=await finish(e,m);assert.equal(r.state,'ready');
});
test('management logs are counted but their bodies are not sent to the analyst',async()=>{
 const e=environment({respond:path=>path.endsWith('/messages')?[msg('2026-11-04T10:00:00Z',0,{author:{id:BOT,username:'logger',bot:true}})]:undefined});e.channel.name='member-log-channel';const m=await ready(e);const r=await finish(e,m);assert.equal(r.statistics.management,1);const read=await e.collector.read(m.id,DATE);assert.deepEqual(read.messages,[]);assert.equal(read.statistics.total,1);
});
test('cross-guild or non-progressing message results fail instead of looping or reporting no activity',async()=>{
 for(const mode of ['channel','cursor']){const e=environment({respond:(path,url)=>path.endsWith('/messages')?[mode==='channel'?msg('2026-11-04T10:00:00Z',0,{channel_id:'890123456789012345'}):msg('2026-11-05T00:00:00Z',0,{id:url.searchParams.get('before')})]:undefined});const m=await ready(e);const r=await finish(e,m);assert.equal(r.state,'failed');assert.equal(r.statistics.total,0);}
});
test('clearing message cache preserves reports and delivery receipts',async()=>{
 const e=environment();const m=await ready(e);await finish(e,m);e.files.set('reports/example/receipt.json',{messageId:'om_example_receipt'});await e.collector.clear(m.id);assert.deepEqual(e.files.get('reports/example/receipt.json'),{messageId:'om_example_receipt'});assert.equal((await e.collector.info(m.id,DATE)).state,'not_collected');
});
test('credential rotation invalidates setup and a different bot creates a new authorization scope',async()=>{
 const e=environment();let m=await ready(e);const scope=m.scopeRevision;await e.service.invalidateDiscordChecks();m=(await e.service.monitor(m.id)).monitor;assert.equal(C.setupReady(m),false);const proof=await e.collector.preflight(m);m=await e.service.bindDiscordPreflight(m.id,{...proof,botId:'890123456789012345'});assert.equal(m.scopeRevision,scope+1);assert.equal(m.runtime.authorizedScope,null);
});
test('forum posts and archived threads are collected without leaking sibling channel messages',async()=>{
 const forum='890123456789012345',active=idAt('2026-11-02T00:00:00Z',1),archived=idAt('2026-11-02T00:00:00Z',2),outside=idAt('2026-11-02T00:00:00Z',3);
 const thread=(id,parent)=>({id,guild_id:G,parent_id:parent,type:11,name:'Example post',thread_metadata:{archive_timestamp:'2026-11-04T12:00:00.123456Z'}});
 const e=environment({respond:(path)=>{
  if(path===`/guilds/${G}/channels`)return [{id:forum,guild_id:G,name:'forum',type:15,permission_overwrites:[]},{id:CH,guild_id:G,name:'other-channel',type:0,permission_overwrites:[]}];
  if(path.endsWith('/threads/active'))return {threads:[thread(active,forum),thread(outside,CH)]};
  if(path===`/channels/${forum}/threads/archived/public`)return {threads:[thread(archived,forum)],has_more:false};
  if(path===`/channels/${active}/messages`)return [msg('2026-11-04T10:00:00Z',1,{channel_id:active})];
  if(path===`/channels/${archived}/messages`)return [msg('2026-11-04T10:00:00Z',2,{channel_id:archived})];
 }});const m=await ready(e,{sources:[`https://discord.com/channels/${G}/${forum}`]});const result=await finish(e,m);assert.equal(result.statistics.total,2);assert.equal(result.coverageComplete,true);
 assert.equal(e.requests.some(r=>r.path===`/channels/${outside}/messages`||r.path===`/channels/${CH}/messages`||r.path===`/channels/${forum}/messages`),false);
});
test('public archive pagination preserves microsecond precision',async()=>{
 const t=idAt('2026-11-02T00:00:00Z'),boundary='2026-11-04T12:00:00.123456+00:00';let seen;
 const e=environment({respond:(path,url)=>{if(path===`/channels/${CH}/threads/archived/public`){seen=url.searchParams.get('before');return seen?{threads:[],has_more:false}:{threads:[{id:t,guild_id:G,parent_id:CH,type:11,name:'post',thread_metadata:{archive_timestamp:boundary}}],has_more:true};}if(path===`/channels/${t}/messages`)return [msg('2026-11-04T10:00:00Z',1,{channel_id:t})];}});const m=await ready(e);const r=await finish(e,m);assert.equal(r.state,'ready');assert.equal(seen,boundary);
});
test('a lost cache metadata commit can re-fetch its page without duplicating messages',async()=>{
 const e=environment({respond:path=>path.endsWith('/messages')?[msg('2026-11-04T10:00:00Z',1)]:undefined});const m=await ready(e),write=e.io.writeReport;let failed=false;
 e.io.writeReport=async(path,value)=>{if(!failed&&path.endsWith('/job.json')&&value.stats.total>0){failed=true;throw new Error('Simulated metadata failure');}return write(path,value);};
 const first=await finish(e,m);assert.equal(first.state,'failed');const final=await finish(e,m);assert.equal(final.statistics.total,1);const data=await e.collector.read(m.id,DATE);assert.equal(data.messages.length,1);assert.equal(e.requests.filter(r=>r.path.endsWith('/messages')).length,2);
});
test('missing known cache bytes are unavailable, never an empty report',async()=>{
 const e=environment({respond:path=>path.endsWith('/messages')?[msg('2026-11-04T10:00:00Z')]:undefined});const m=await ready(e);await finish(e,m);const path=[...e.files.keys()].find(p=>p.endsWith('/messages-0.json'));e.files.delete(path);
 await assert.rejects(e.collector.read(m.id,DATE),{code:'DISCORD_CACHE_UNAVAILABLE'});await e.collector.clear(m.id);assert.equal((await e.collector.info(m.id,DATE)).state,'not_collected');
});
test('cache cleaning rejects an injected report path before deleting anything',async()=>{
 const e=environment();const m=await ready(e);await finish(e,m);e.files.set('reports/do-not-delete.json',{messageId:'om_example'});const index=e.files.get('discord-cache/index.json');index.entries[0].files.push('reports/do-not-delete.json');const before=[...e.files.keys()];
 await assert.rejects(e.collector.clear(m.id),{code:'DISCORD_CACHE_UNAVAILABLE'});assert.deepEqual([...e.files.keys()],before);
});
test('a new bot identity cannot read the previous bot cache',async()=>{
 let changed=false;const e=environment({respond:path=>path==='/users/@me'&&changed?{id:'890123456789012345',username:'other-bot',bot:true}:undefined});const m=await ready(e);await finish(e,m);changed=true;await assert.rejects(e.collector.read(m.id,DATE),{code:'DISCORD_IDENTITY_CHANGED'});
});
test('bot reports use actual collected counts, and cache limits do not create no-new proof',async()=>{
 const e=environment();const m=await ready(e);await finish(e,m);await assert.rejects(e.collector.validateReport({monitor_id:m.id,report_date:DATE,status:'ok',message_count:1}),{code:'DISCORD_COUNT_MISMATCH'});
 const limited=environment();const lm=await ready(limited);limited.collector.maxBytes=100;await assert.rejects(limited.collector.sync(lm.id,DATE),{code:'DISCORD_CACHE_LIMIT'});assert.equal((await limited.service.monitor(lm.id)).monitor.lastRun,null);
});
test('fixing a late history denial resumes the failed channel without clearing cache',async()=>{
 let deny=false;const e=environment({respond:path=>{if(path===`/guilds/${G}`&&deny)return {id:G,roles:[{id:G,permissions:'0'},{id:ROLE,permissions:'1024'}]};if(path.endsWith('/messages')){return [];}return undefined;}});const m=await ready(e);deny=true;const first=await finish(e,m);assert.equal(first.state,'failed');deny=false;const final=await finish(e,m);assert.equal(final.state,'ready');assert.equal(final.coverageComplete,true);
});
test('newly granted channels are added without rescanning successful message pages',async()=>{
 const extra='890123456789012345';let allowed=false;
 const e=environment({respond:(path)=>{if(path===`/guilds/${G}/channels`)return [{id:CH,guild_id:G,name:'main',type:0,permission_overwrites:[]},{id:extra,guild_id:G,name:'extra',type:0,permission_overwrites:allowed?[]:[{id:ROLE,type:0,allow:'0',deny:'65536'}]}];if(path===`/channels/${CH}/messages`)return [msg('2026-11-04T10:00:00Z',1)];if(path===`/channels/${extra}/messages`)return [msg('2026-11-04T10:00:00Z',2,{channel_id:extra})];}});
 const m=await ready(e,{scope:'server'});const first=await finish(e,m);assert.equal(first.statistics.total,1);assert.equal(first.coverageComplete,false);allowed=true;const final=await finish(e,m);assert.equal(final.statistics.total,2);assert.equal(final.coverageComplete,true);assert.equal(e.requests.filter(r=>r.path===`/channels/${CH}/messages`).length,1);
});
