import * as C from './core.js';

const ACTIVE=new Set(['queued','running','stopping','reconciling']);
const APPROVED=new Set(['auto','bypassPermissions']);

// Native permissions remain owned by Cindy. Only the configuration action may
// request Auto; send/scheduled actions can only reuse an already approved task.
export class MonitorRuntime {
  constructor(service,tasks,changed=()=>{}){this.service=service;this.tasks=tasks;this.changed=changed;this.locks=new Map();}
  exclusive(id,fn){const prior=this.locks.get(id)??Promise.resolve();const next=prior.catch(()=>{}).then(fn);this.locks.set(id,next);return next;}
  async capabilities(){C.ensure(typeof this.tasks?.capabilities==='function','UNSUPPORTED','当前 Cindy 不支持插件执行任务。');const caps=await this.tasks.capabilities();C.ensure(['create','get','send','getRun','requestWriteAccess','setTeamPlan'].every(op=>caps.operations?.includes(op)),'UNSUPPORTED','当前 Cindy 缺少一次性授权所需接口。');return caps;}
  async task(monitor,create=false){
    const runtime=monitor.runtime??{};
    const scope=C.authorizationScope(monitor);
    if(runtime.taskId&&runtime.taskScope===scope)return this.tasks.get({taskId:runtime.taskId});
    C.ensure(create,'SETUP_REQUIRED','请先在配置页完成授权；发送报告不会临时新建审批任务。');
    const intent=runtime.createIntent?.scope===scope?runtime.createIntent:{scope,requestKey:'cm-worker-'+monitor.id+'-'+(monitor.scopeRevision??0),title:('社群日报｜'+monitor.name).slice(0,100)};
    if(runtime.createIntent?.scope!==scope)await this.service.updateRuntime(monitor.id,r=>({...r,createIntent:intent}));
    const task=await this.tasks.create({requestKey:intent.requestKey,title:intent.title,isolatedWorkspace:true});
    await this.service.updateRuntime(monitor.id,r=>({...r,previousTaskId:r.taskId??r.previousTaskId??null,taskId:task.taskId,taskScope:scope,planScope:null,lastNativeRunId:null,lastNativeStatus:null,pendingInput:null,executionToken:null}));
    return task;
  }
  async active(monitor){
    const r=monitor.runtime??{};
    if(r.pendingInput)throw new C.MonitorError('DISPATCH_UNCERTAIN','上次任务派发结果待核对，请在原执行任务查看，不会更换请求重复派发。');
    if(!r.lastNativeRunId)return null;
    const run=await this.tasks.getRun({runId:r.lastNativeRunId});
    return ACTIVE.has(run.status)?run:null;
  }
  async submit(monitor,task,text,requestKey,mode){
    const pending={requestKey,expectedRevision:task.revision,text,mode};
    await this.service.updateRuntime(monitor.id,r=>({...r,pendingInput:pending}));
    let run;
    try{run=await this.tasks.send({taskId:task.taskId,expectedRevision:pending.expectedRevision,requestKey,text});}
    catch(error){
      if(['PERMISSION_DENIED','TASK_BUSY','INVALID_REQUEST','ROUTE_UNAVAILABLE'].includes(error.code))await this.service.updateRuntime(monitor.id,r=>({...r,pendingInput:null,lastError:error.message}));
      throw error;
    }
    await this.service.updateRuntime(monitor.id,r=>({...r,pendingInput:null,lastNativeRunId:run.runId,lastNativeStatus:run.status,lastRequestKey:requestKey,lastMode:mode,lastError:run.error??null,...(mode==='setup'?{setupRunId:run.runId}:{})}));
    await this.changed();
    return {accepted:true,state:run.status,taskId:task.taskId,runId:run.runId,mode};
  }
  async configure(id,requestId){return this.exclusive(id,async()=>{
    await this.capabilities();
    let {monitor}=await this.service.monitor(id);C.ensure(monitor?.enabled,'MONITOR_UNAVAILABLE','请先保存并启用监测方案。');
    if(monitor.runtime?.taskId&&monitor.runtime.taskScope!==C.authorizationScope(monitor)){const oldRun=await this.active(monitor);C.ensure(!oldRun,'TASK_BUSY','旧范围的任务仍在执行，请先在 Cindy 中完成或停止，再为新范围配置授权。');}
    let task=await this.task(monitor,true);
    C.ensure(task.status==='active','TASK_UNAVAILABLE','原执行任务已归档或删除，请在 Cindy 中恢复该任务后继续配置。');
    ({monitor}=await this.service.monitor(id));
    if(monitor.runtime.planScope!==C.authorizationScope(monitor)){
      C.ensure(task.workingDir&&task.resolvedConfig,'TASK_CONTEXT_REQUIRED','宿主没有返回可核实的任务目录和模型，请检查任务设置。');
      const scopeText=C.executionScopeText(monitor);
      // This registers the main task's bounded scope. The Host requires a plan
      // item, but this code never starts a team or creates any worker agent.
      await this.tasks.setTeamPlan({taskId:task.taskId,plan:{concurrency:1,task:scopeText,items:[{label:'report',workingDir:task.workingDir,route:task.resolvedConfig,task:scopeText}]}});
      await this.service.updateRuntime(id,r=>({...r,planScope:C.authorizationScope(monitor)}));
    }
    if(!APPROVED.has(task.permissionMode)||task.planModeEnabled){
      // Real native confirmation; never synthesize a confirmed/granted flag.
      const grant=await this.tasks.requestWriteAccess({taskId:task.taskId,mode:'auto'});
      C.ensure(grant?.granted!==false,'AUTHORIZATION_REQUIRED','未完成执行授权。请在原任务的权限菜单中确认自动执行，再回配置页检查。');
      task=await this.tasks.get({taskId:task.taskId});
    }
    C.ensure(APPROVED.has(task.permissionMode)&&!task.planModeEnabled,'AUTHORIZATION_REQUIRED','原任务尚未获得自动执行授权，请在该任务权限菜单中完成确认。');
    ({monitor}=await this.service.monitor(id));
    if(C.setupReady(monitor))return {state:'ready',taskId:task.taskId};
    const active=await this.active(monitor);if(active)return {state:'checking',taskId:task.taskId,runId:active.runId,accepted:true};
    const scope=C.authorizationScope(monitor);const token=crypto.randomUUID();
    await this.service.updateRuntime(id,r=>({...r,authorizedScope:scope,permissionMode:task.permissionMode,setupStatus:'checking',setupToken:token,lastError:null}));
    const result=await this.submit(monitor,task,C.setupPrompt(id,token),'cm-setup-'+requestId,'setup');
    const latest=(await this.service.monitor(id)).monitor;
    return {...result,state:C.setupReady(latest)?'ready':'checking'};
  });}
  async start(id,mode,requestId){return this.exclusive(id,async()=>{
    await this.capabilities();
    let {monitor}=await this.service.monitor(id);C.ensure(monitor?.enabled,'MONITOR_UNAVAILABLE','方案已停用或删除。');
    C.ensure(C.setupReady(monitor),'SETUP_REQUIRED','请先在配置页点击“完成授权与连接检查”；发送时不会临时重复授权。');
    const task=await this.task(monitor,false);
    C.ensure(task.status==='active'&&APPROVED.has(task.permissionMode)&&!task.planModeEnabled,'AUTHORIZATION_REQUIRED','原任务的授权已改变，请回配置页恢复；本次不会弹出新的审批任务。');
    const active=await this.active(monitor);if(active)return {accepted:true,state:'running',taskId:task.taskId,runId:active.runId,reused:true};
    const date=C.reportWindow(monitor.timezone,this.service.io.now()).date;
    const prior=await this.service.getReport(id,date);
    if(mode==='send'&&prior&&monitor.recipients.every(r=>prior.deliveries[r.key]?.status==='sent'))return {state:'already_sent',report_date:date,taskId:task.taskId};
    if(monitor.runtime.lastRequestKey==='cm-run-'+requestId)return {state:'already_triggered',taskId:task.taskId,runId:monitor.runtime.lastNativeRunId,instruction:'同一次触发已提交，请查看原任务结果，不更换执行令牌重复派发。'};
    const token=crypto.randomUUID();
    await this.service.updateRuntime(id,r=>({...r,executionToken:token,lastError:null}));
    ({monitor}=await this.service.monitor(id));
    return this.submit(monitor,task,C.taskPrompt(id,mode,token),'cm-run-'+requestId,mode);
  });}
  async dispatch(id){
    const {monitor}=await this.service.monitor(id);
    if(!monitor)return {state:'deleted'};
    if(!monitor.enabled)return {state:'paused'};
    if(!C.setupReady(monitor))return {state:'setup_required',instruction:'配置授权或连接未完成，停止无人值守执行，回配置页修复。'};
    const date=C.reportWindow(monitor.timezone,this.service.io.now()).date;
    return this.start(id,'send','daily-'+id+'-'+date);
  }
  async status(id){
    const {monitor}=await this.service.monitor(id);C.ensure(monitor,'MONITOR_NOT_FOUND','方案不存在。');
    const r=monitor.runtime??{};let native=null;
    if(r.lastNativeRunId){native=await this.tasks.getRun({runId:r.lastNativeRunId});if(native.status!==r.lastNativeStatus){await this.service.updateRuntime(id,(current,currentMonitor)=>({...current,lastNativeStatus:native.status,...(native.error?{lastError:native.error}:{}),...(current.lastMode==='setup'&&current.setupStatus==='checking'&&['completed','failed','cancelled','interrupted'].includes(native.status)&&!C.setupReady(currentMonitor)?{setupStatus:'needs_attention',lastError:native.error||'连接检查尚未确认完成，请打开原执行任务查看并回配置页重试。'}:{})}));await this.changed();}}
    return {ready:C.setupReady(monitor),runtime:monitor.runtime,native};
  }
}
