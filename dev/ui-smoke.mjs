// Zero-dependency UI smoke test using a fresh headless Chrome profile and CDP.
// Never attaches to the user's Discord/browser profile.
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {startPreview} from './preview.mjs';
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile=await mkdtemp(join(tmpdir(),'community-monitor-ui-'));
const {server,url}=await startPreview();
const child=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'--disable-extensions','about:blank'],{stdio:'ignore'});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const sockets=[];
try{
 let port;for(let i=0;i<80;i++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);if(port)break;}catch{}await pause(150);}assert.ok(port,'Chrome did not start');
 async function page(path,width){const target=await(await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url+path)}`,{method:'PUT'})).json();const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});sockets.push(ws);let seq=0;const promises=new Map();const errors=[];
  ws.addEventListener('message',e=>{const msg=JSON.parse(e.data);if(msg.id){const p=promises.get(msg.id);promises.delete(msg.id);msg.error?p?.reject(new Error(msg.error.message)):p?.resolve(msg.result);}if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.text+': '+(msg.params.exceptionDetails.exception?.description||''));});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;promises.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  await call('Runtime.enable');await call('Page.enable');await call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
  const until=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await pause(80);}throw new Error('UI condition timed out: '+expression);};
  await until("document.documentElement.dataset.appReady === 'true'");
  return {call,evaluate,until,errors};
 }
 const desktop=await page('/?lang=zh-CN',1180);
 await desktop.evaluate("document.querySelector('#empty-new').click()");
 const previewToken='preview-only-not-a-real-credential-1234';
 await desktop.evaluate(`document.querySelector('#discord-bot-token').value=${JSON.stringify(previewToken)};document.querySelector('#discord-save-token').click()`);
 await desktop.until("document.querySelector('#discord-secret-status').textContent.includes('已配置') && !document.querySelector('#monitor-form').inert");
 assert.equal(await desktop.evaluate("document.querySelector('#discord-bot-token').value"),'');
 await desktop.evaluate("(() => { const set=(id,value)=>{const e=document.querySelector(id);e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));};set('#monitor-name','示例社区日报（开发预览）');set('#sources','https://discord.com/channels/123456789012345678/234567890123456789');document.querySelector('#monitor-form').requestSubmit(); })()");
 await desktop.until("document.querySelector('#monitor-count').textContent === '1' && document.querySelector('#setup-status').textContent.includes('配置已就绪') && !document.querySelector('#monitor-form').inert");
 await desktop.evaluate("document.querySelector('#preview').click()");await desktop.until("document.querySelector('#status').textContent.includes('已创建')");
 await desktop.evaluate("document.querySelector('#schedule').click()");await desktop.until("document.querySelector('#status').textContent.includes('尚未启用')");
 let events=await(await fetch(url+'/dev/events')).json();assert.equal(events.filter(e=>e.kind==='task-create').length,1);assert.equal(events.filter(e=>e.kind==='permission-request').length,1);assert.ok(events.some(e=>e.kind==='task-send'&&e.text.includes('mode=preview')));assert.ok(events.find(e=>e.kind==='schedule-draft').prompt.includes('10:00'));assert.ok(!events.find(e=>e.kind==='schedule-draft').prompt.includes('ou_'));assert.ok(events.find(e=>e.kind==='schedule-draft').prompt.includes('dispatch_report'));
 await desktop.evaluate("document.querySelector('#quick-send').click()");await desktop.until("!document.querySelector('#monitor-form').inert");events=await(await fetch(url+'/dev/events')).json();assert.equal(events.filter(e=>e.kind==='task-create').length,1);assert.equal(events.filter(e=>e.kind==='permission-request').length,1);
 // A denied result write finishes honestly; retry uses the same worker/grant.
 await desktop.evaluate("window.__previewHost.setupFault='write_rejected';document.querySelector('#delivery-channel').value='mail';document.querySelector('#delivery-channel').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#monitor-form').requestSubmit()");
 await desktop.until("document.querySelector('#setup-status').textContent.includes('结果尚未保存') && !document.querySelector('#monitor-form').inert");
 assert.equal(await desktop.evaluate("document.querySelector('#monitor-form button[type=submit]').textContent"),'重试连接检查');
 const beforeRetry=await(await fetch(url+'/kv')).json();
 await desktop.evaluate("window.__previewHost.setupFault='revision_conflict';document.querySelector('#monitor-form').requestSubmit()");
 await desktop.until("document.querySelector('#setup-status').textContent.includes('配置已就绪') && !document.querySelector('#monitor-form').inert");
 const afterRetry=await(await fetch(url+'/kv')).json();assert.equal(beforeRetry.monitors[0].revision,afterRetry.monitors[0].revision);
 events=await(await fetch(url+'/dev/events')).json();assert.equal(events.filter(e=>e.kind==='task-create').length,2);assert.equal(events.filter(e=>e.kind==='permission-request').length,2);
 const attempts=events.filter(e=>e.kind==='task-send-attempt');const refreshed=attempts.slice(-2);assert.equal(refreshed[0].requestKey,refreshed[1].requestKey);assert.equal(refreshed[0].text,refreshed[1].text);assert.equal(refreshed[1].expectedRevision,refreshed[0].expectedRevision+1);
 // Lost native acknowledgement is reconciled by exact replay, not a fresh send.
 await desktop.evaluate("window.__previewHost.setupFault='unknown_after_accept';document.querySelector('#delivery-channel').value='chat';document.querySelector('#delivery-channel').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#monitor-form').requestSubmit()");
 await desktop.until("document.querySelector('#setup-status').textContent.includes('请求待确认') && !document.querySelector('#monitor-form').inert");assert.equal(await desktop.evaluate("document.querySelector('#quick-send').disabled"),true);
 await desktop.evaluate("document.querySelector('#monitor-form').requestSubmit()");await desktop.until("document.querySelector('#setup-status').textContent.includes('配置已就绪') && !document.querySelector('#monitor-form').inert");
 events=await(await fetch(url+'/dev/events')).json();const replays=events.filter(e=>e.kind==='task-send-attempt').slice(-2);assert.equal(replays[0].requestKey,replays[1].requestKey);assert.equal(events.filter(e=>e.kind==='task-send'&&e.requestKey===replays[0].requestKey).length,1);assert.equal(events.filter(e=>e.kind==='task-create').length,3);assert.equal(events.filter(e=>e.kind==='permission-request').length,3);
 await desktop.evaluate("document.querySelector('#delivery-channel').value='mail';document.querySelector('#delivery-channel').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#monitor-form').requestSubmit()");await desktop.until("document.querySelector('#setup-status').textContent.includes('配置已就绪') && !document.querySelector('#monitor-form').inert");assert.ok(await desktop.evaluate("document.querySelector('#setup-detail').textContent.includes('preview@example.com')"));
 const cfg=await(await fetch(url+'/kv')).json();const monitor=cfg.monitors[0];
 await desktop.evaluate(`window.__previewHost.invokeTool('sync_messages',${JSON.stringify({monitor_id:monitor.id,report_date:'2026-11-03'})})`);
 await desktop.evaluate(`window.__previewHost.invokeTool('store_report',${JSON.stringify({monitor_id:monitor.id,expected_revision:monitor.revision,report_date:'2026-11-03',status:'no_new',body:'开发预览样报（虚构测试数据）\n\n昨日未检索到新增消息。\n玩家态度：数据不足，无法判断。\n本内容只用于测试界面，不代表真实社群情况。',message_count:0})})`);
 await desktop.until("!document.querySelector('#latest-card').hidden");
 await desktop.until("document.querySelector('#report-length').textContent.includes(' / 3000 字符')");
 assert.ok(await desktop.evaluate("document.querySelector('[data-i18n=reportLengthHelp]').textContent.includes('500–1000')"));
 // Viewing history must not mark the configuration dirty.
 await desktop.evaluate("document.querySelector('#report-date').dispatchEvent(new Event('change',{bubbles:true}))");assert.equal(await desktop.evaluate("document.querySelector('#dirty').hidden"),true);
 // Edits cannot silently disappear when changing monitors.
 await desktop.evaluate("document.querySelector('#focus').value='未保存修改';document.querySelector('#focus').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#new-monitor').click()");assert.equal(await desktop.evaluate("document.querySelector('#focus').value"),'未保存修改');
 await desktop.evaluate("document.querySelector('#discard').click()");await desktop.until("document.querySelector('#dirty').hidden");
 assert.ok(!JSON.stringify(await(await fetch(url+'/kv')).json()).includes(previewToken));
 assert.ok(!JSON.stringify(await(await fetch(url+'/dev/events')).json()).includes(previewToken));
 await mkdir('docs/screenshots',{recursive:true});
 for(const [name,path,width]of [['desktop-light','/?lang=zh-CN',1180],['mobile-dark','/?lang=zh-CN&theme=dark',320],['english-light','/?lang=en',760]]){
  const p=await page(path,width);await p.until("!document.querySelector('#monitor-form').hidden");
  assert.ok(await p.evaluate('document.documentElement.scrollWidth <= innerWidth'),name+' overflows horizontally');
  assert.equal(await p.evaluate("document.querySelector('#monitor-name').value"),monitor.name);
  if(name==='english-light')assert.equal(await p.evaluate("document.querySelector('h1').textContent"),'A useful daily view of your community.');
  const shot=await p.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});await writeFile(`docs/screenshots/${name}.png`,Buffer.from(shot.data,'base64'));assert.deepEqual(p.errors,[]);
 }
 assert.deepEqual(desktop.errors,[]);console.log(JSON.stringify({passed:true,checks:['vault-only bot credential input','official REST batch sync','raw credential excluded from config and events','configuration-time authorization','reused worker and one grant per scope','rejected setup result and explicit retry','native revision conflict retry','lost acknowledgement reconciliation without duplicate dispatch','retry does not rewrite configuration','chat and mail selection','preview dispatch','honest schedule draft','stored report UI','unsaved-edit protection','history browsing','320 px dark layout','1180 px light layout','English host locale'],screenshots:'docs/screenshots'},null,2));
}finally{for(const ws of sockets)ws.close();child.kill();await new Promise(r=>child.once('exit',r));server.close();await rm(profile,{recursive:true,force:true});}
