// Loaded only by the local development server; never referenced by the plugin UI.
(() => {
 const qs=new URLSearchParams(location.search);const dark=qs.get('theme')==='dark';
 const style=document.createElement('style');style.textContent=dark?':root{color-scheme:dark;--panel-bg:#181a18;--surface:#222521;--surface-hover:#30342e;--text-primary:#eef0ea;--text-secondary:#a6ada0;--border-default:#41473c;--danger:#f2a7a3}':':root{color-scheme:light;--panel-bg:#f5f6f2;--surface:#fff;--surface-hover:#f0f2eb;--text-primary:#24291f;--text-secondary:#68725e;--border-default:#dce1d5;--danger:#b42318}';document.head.append(style);
 const originalFetch=window.fetch.bind(window);
 window.fetch=(input,options)=>String(input)==='/app-context'?Promise.resolve(new Response(JSON.stringify({ok:true,context:{region:'global',locale:qs.get('lang')||'zh-CN'}}),{headers:{'Content-Type':'application/json'}})):originalFetch(input,options);
 const listeners=[];const calls=new Map();let taskNumber=0;
 const event=data=>fetch('/dev/event',{method:'POST',body:JSON.stringify(data)});
 window.cindy={
  onHostMessage:fn=>{listeners.push(fn);return()=>{};},
  fs:async args=>(await fetch('/dev/fs',{method:'POST',body:JSON.stringify(args)})).json(),
  send:async data=>{if(data.type==='tool-result'){const finish=calls.get(data.callId);calls.delete(data.callId);finish?.(data);}return {ok:true};},
  tasks:{capabilities:async()=>({operations:['create','send']}),create:async args=>{await event({kind:'task-create',...args});return {taskId:'demo-task-'+(++taskNumber),revision:0};},send:async args=>{await event({kind:'task-send',...args});return {runId:'demo-run-'+taskNumber,accepted:true};}},
  agent:{requestSchedule:async args=>{await event({kind:'schedule-draft',...args});return {ok:true};}}
 };
 window.__previewHost={invokeTool:(tool,args)=>new Promise((resolve,reject)=>{const callId=crypto.randomUUID();calls.set(callId,result=>result.ok?resolve(result.result):reject(Object.assign(new Error(result.message),{code:result.errorCode})));for(const listener of listeners)listener({type:'tool-call',callId,tool,args});})};
 import('/main.js');
 document.addEventListener('DOMContentLoaded',()=>{const banner=document.createElement('p');banner.className='notice';banner.textContent='开发预览：仅使用虚构配置，不连接真实 Discord 或飞书。';document.querySelector('.app').prepend(banner);});
})();
