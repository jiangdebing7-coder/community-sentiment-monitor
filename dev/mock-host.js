// Loaded only by the local development server; never referenced by the plugin UI.
(() => {
 const qs=new URLSearchParams(location.search);const dark=qs.get('theme')==='dark';
 const style=document.createElement('style');style.textContent=dark?':root{color-scheme:dark;--panel-bg:#181a18;--surface:#222521;--surface-hover:#30342e;--text-primary:#eef0ea;--text-secondary:#a6ada0;--border-default:#41473c;--danger:#f2a7a3}':':root{color-scheme:light;--panel-bg:#f5f6f2;--surface:#fff;--surface-hover:#f0f2eb;--text-primary:#24291f;--text-secondary:#68725e;--border-default:#dce1d5;--danger:#b42318}';document.head.append(style);
 const originalFetch=window.fetch.bind(window);
 window.fetch=(input,options)=>String(input)==='/app-context'?Promise.resolve(new Response(JSON.stringify({ok:true,context:{region:'global',locale:qs.get('lang')||'zh-CN'}}),{headers:{'Content-Type':'application/json'}})):originalFetch(input,options);
 const listeners=[];const calls=new Map();let taskNumber=0,runNumber=0;const tasks=new Map(),runs=new Map(),receipts=new Map();
 const event=data=>fetch('/dev/event',{method:'POST',body:JSON.stringify(data)});
 window.cindy={
  fetch:async args=>{
   const status=await(await fetch('/secrets')).json();if(!status[0]?.saved)return {ok:false,message:'Development bot credential not configured'};
   const url=new URL(args.url),path=url.pathname.replace('/api/v10','');await event({kind:'discord-api-read',path});
   const guildId='123456789012345678',channelId='234567890123456789',botId='345678901234567890',roleId='456789012345678901';
   const channel={id:channelId,guild_id:guildId,name:'example-discussion',type:0,permission_overwrites:[]};
   const data=path==='/users/@me'?{id:botId,username:'Preview bot',bot:true}:path==='/oauth2/applications/@me'?{id:'567890123456789012',flags:1<<19}:path===`/guilds/${guildId}`?{id:guildId,name:'Development preview',roles:[{id:guildId,permissions:'0'},{id:roleId,permissions:'66560'}]}:path===`/guilds/${guildId}/members/${botId}`?{roles:[roleId]}:path===`/guilds/${guildId}/channels`?[channel]:path===`/channels/${channelId}`?channel:path.endsWith('/threads/active')?{threads:[]}:path.includes('/threads/archived/')?{threads:[],has_more:false}:path.endsWith('/messages')?[]:null;
   return {ok:true,status:data===null?404:200,headers:{},body:JSON.stringify(data)};
  },
  onHostMessage:fn=>{listeners.push(fn);return()=>{};},
  fs:async args=>(await fetch('/dev/fs',{method:'POST',body:JSON.stringify(args)})).json(),
  send:async data=>{if(data.type==='tool-result'){const finish=calls.get(data.callId);calls.delete(data.callId);finish?.(data);}return {ok:true};},
  tasks:{
   capabilities:async()=>({operations:['create','get','send','getRun','requestWriteAccess','setTeamPlan']}),
   create:async args=>{await event({kind:'task-create',...args});const task={taskId:'demo-task-'+(++taskNumber),revision:0,status:'active',permissionMode:'ask',workingDir:'/example/preview-workspace',resolvedConfig:{agentKind:'codex',providerId:'example',model:'example-model',effort:'',fastMode:false}};tasks.set(task.taskId,task);return {...task};},
   setTeamPlan:async args=>{await event({kind:'scope-registration',...args});return {ok:true};},
   get:async({taskId})=>({...tasks.get(taskId)}),
   requestWriteAccess:async({taskId,mode})=>{await event({kind:'permission-request',taskId,mode});const task=tasks.get(taskId);task.permissionMode=mode;task.revision++;return {granted:true};},
   getRun:async({runId})=>({...runs.get(runId)}),
   send:async args=>{
    await event({kind:'task-send-attempt',...args});
    const key=args.taskId+':'+args.requestKey,identity=JSON.stringify([args.text,args.expectedRevision]);
    if(receipts.has(key)){const prior=receipts.get(key);if(prior.identity!==identity)throw Object.assign(new Error('Request key conflict'),{code:'IDEMPOTENCY_CONFLICT'});return {...prior.run};}
    const setup=args.text.match(/方案 (m_[a-f0-9]+)，检查令牌 ([a-f0-9-]+)/);
    const fault=setup?window.__previewHost.setupFault:null;if(setup)window.__previewHost.setupFault=null;
    const task=tasks.get(args.taskId);
    if(fault==='revision_conflict'){task.revision++;throw Object.assign(new Error('Task configuration changed'),{code:'REVISION_CONFLICT'});}
    if(args.expectedRevision!==task.revision)throw Object.assign(new Error('Task configuration changed'),{code:'REVISION_CONFLICT'});
    await event({kind:'task-send',...args});const run={runId:'demo-run-'+(++runNumber),taskId:args.taskId,status:'completed'};runs.set(run.runId,run);receipts.set(key,{identity,run});
    if(setup){const plan=await window.__previewHost.invokeTool('prepare_setup',{monitor_id:setup[1],setup_token:setup[2]});if(fault==='write_rejected')await event({kind:'setup-write-rejected'});else await window.__previewHost.invokeTool('complete_setup',{monitor_id:setup[1],setup_token:setup[2],success:true,source_checks:plan.monitor.sources.map(s=>({url:s.url,accessible:true})),connection:{pluginId:'example-feishu',namespace:null,accountOpenId:'ou_previewaccount123',accountName:'开发预览账号',mailboxAddress:'preview@example.com'}});}
    if(fault==='unknown_after_accept')throw Object.assign(new Error('Send acknowledgement lost'),{code:'HOST_NOT_READY'});
    return {...run};}
  },
  agent:{requestSchedule:async args=>{await event({kind:'schedule-draft',...args});return {ok:true};}}
 };
 window.__previewHost={invokeTool:(tool,args)=>new Promise((resolve,reject)=>{const callId=crypto.randomUUID();calls.set(callId,result=>result.ok?resolve(result.result):reject(Object.assign(new Error(result.message),{code:result.errorCode})));for(const listener of listeners)listener({type:'tool-call',callId,tool,args});})};
 import('/main.js');
 document.addEventListener('DOMContentLoaded',()=>{const banner=document.createElement('p');banner.className='notice';banner.textContent='开发预览：仅使用虚构配置，不连接真实 Discord 或飞书。';document.querySelector('.app').prepend(banner);});
})();
