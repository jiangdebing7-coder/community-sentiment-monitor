import * as C from './core.js';

const ACTIVE=new Set(['queued','running','stopping','reconciling']);
const APPROVED=new Set(['auto','bypassPermissions']);
// Verified in Cindy 0.1.121: these errors occur before the send receipt is
// inserted. A timeout, lost response or idempotency conflict is NOT rejection.
const REJECTED=new Set(['PERMISSION_DENIED','TASK_BUSY','INVALID_REQUEST','ROUTE_UNAVAILABLE','REVISION_CONFLICT']);
const INCOMPLETE_SETUP='连接检查已结束，但结果尚未保存。请点击“重试连接检查”；已有账号连接会复用，无需重复登录。';

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
  assertApproved(task){
    C.ensure(task?.status==='active','TASK_UNAVAILABLE','原执行任务已归档或删除，请在 Cindy 中恢复后继续。');
    C.ensure(APPROVED.has(task.permissionMode)&&!task.planModeEnabled,'AUTHORIZATION_REQUIRED','原任务的执行授权已改变，请在该任务中恢复授权，再回配置页重试。');
  }
  async submit(monitor,task,text,requestKey,mode,setupToken){
    // Refresh immediately before dispatch; permission/plan confirmation can
    // change the native revision. Do not activate a new token before acceptance.
    task=await this.tasks.get({taskId:task.taskId});this.assertApproved(task);
    const pending={requestKey,expectedRevision:task.revision,text,mode,taskId:task.taskId,scope:C.authorizationScope(monitor),...(mode==='setup'?{setupToken}:{})};
    await this.service.updateRuntime(monitor.id,(r,m)=>{
      C.ensure(C.authorizationScope(m)===pending.scope&&r.taskId===task.taskId,'SETUP_EXPIRED','配置范围已改变，请使用当前配置重新检查。');
      return {...r,pendingInput:pending,...(mode==='setup'?{setupStatus:'dispatching'}:{})};
    });
    return this.sendPending(monitor.id,pending);
  }
  async sendPending(id,input){
    const pending=C.clone(input);let run;
    try{
      for(let attempt=0;;attempt++){
        const {monitor}=await this.service.monitor(id);
        C.ensure(monitor?.enabled&&C.authorizationScope(monitor)===pending.scope&&monitor.runtime.taskId===pending.taskId,'SETUP_EXPIRED','配置范围已改变，不能继续旧检查；请回配置页核对。');
        try{run=await this.tasks.send({taskId:pending.taskId,expectedRevision:pending.expectedRevision,requestKey:pending.requestKey,text:pending.text});break;}
        catch(error){
          // This particular error guarantees no receipt/dispatch exists, so it
          // is safe to refresh the revision once, retaining the key and text.
          if(error.code!=='REVISION_CONFLICT'||attempt!==0)throw error;
          const fresh=await this.tasks.get({taskId:pending.taskId});this.assertApproved(fresh);
          pending.expectedRevision=fresh.revision;
          await this.service.updateRuntime(id,(r,m)=>{
            C.ensure(C.authorizationScope(m)===pending.scope&&r.pendingInput?.requestKey===pending.requestKey,'SETUP_EXPIRED','当前检查已改变，请返回配置页。');
            return {...r,pendingInput:C.clone(pending)};
          });
        }
      }
    }catch(error){
      const rejected=REJECTED.has(error.code);
      const message=pending.mode==='setup'?(rejected?'本次检查未能派发，请点击“重试连接检查”。已有账号连接和先前检查令牌已保留。':'检查请求的派发结果待确认。请点击“重试连接检查”核对原请求，不会更换请求重复执行。')+' '+(error.message||''):error.message;
      await this.service.updateRuntime(id,(r,m)=>{
        if(r.pendingInput?.requestKey!==pending.requestKey)return r;
        const completed=pending.mode==='setup'&&r.completedSetupToken===pending.setupToken;
        return {...r,pendingInput:rejected?null:r.pendingInput,lastError:completed?r.lastError:message,...(pending.mode==='setup'&&C.authorizationScope(m)===pending.scope&&!completed?{setupStatus:rejected?'needs_attention':'dispatch_uncertain'}:{})};
      });
      await this.changed();throw new C.MonitorError(error.code||'DISPATCH_UNCERTAIN',message);
    }
    await this.service.updateRuntime(id,(r,m)=>{
      const next={...r,pendingInput:null,lastNativeRunId:run.runId,lastNativeStatus:run.status,lastRequestKey:pending.requestKey,lastMode:pending.mode,lastError:run.error??null};
      if(pending.mode==='setup'&&C.authorizationScope(m)===pending.scope&&r.taskId===pending.taskId){
        const completed=r.completedSetupToken===pending.setupToken;
        const incomplete=!ACTIVE.has(run.status)&&!completed;
        Object.assign(next,{setupRunId:run.runId,setupToken:pending.setupToken,setupStatus:completed?r.setupStatus:incomplete?'needs_attention':'checking',readyScope:completed?r.readyScope:null,lastError:completed&&r.setupStatus==='ready'?null:completed?r.lastError:run.error||(incomplete?INCOMPLETE_SETUP:null)});
      }
      return next;
    });
    await this.changed();
    return {accepted:true,state:run.status,taskId:pending.taskId,runId:run.runId,mode:pending.mode};
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
    if(monitor.runtime.pendingInput){
      const p=monitor.runtime.pendingInput;
      C.ensure(p.mode==='setup','DISPATCH_UNCERTAIN','原报告的派发结果待核对，请先查看原执行任务；本次不重复派发报告。');
      // 1.1.0 stored the exact input but not its metadata. Recover that same
      // input/token, never replace it with a new check or a new task.
      const pending={...p,taskId:p.taskId??monitor.runtime.taskId,scope:p.scope??monitor.runtime.taskScope,setupToken:p.setupToken??monitor.runtime.setupToken};
      C.ensure(pending.scope===C.authorizationScope(monitor)&&pending.taskId===task.taskId&&pending.setupToken,'DISPATCH_UNCERTAIN','旧检查与当前配置范围不一致，请先在原任务核对，不能自动重发。');
      await this.service.updateRuntime(id,r=>({...r,pendingInput:pending}));
      const result=await this.sendPending(id,pending);const latest=(await this.service.monitor(id)).monitor;
      return {...result,state:C.setupReady(latest)?'ready':latest.runtime.setupStatus};
    }
    if(C.setupReady(monitor))return {state:'ready',taskId:task.taskId};
    const active=await this.active(monitor);if(active)return {state:'checking',taskId:task.taskId,runId:active.runId,accepted:true};
    const scope=C.authorizationScope(monitor);const token=crypto.randomUUID();
    await this.service.updateRuntime(id,(r,m)=>{C.ensure(C.authorizationScope(m)===scope,'SETUP_EXPIRED','配置范围已改变，请使用当前配置重新检查。');return {...r,authorizedScope:scope,permissionMode:task.permissionMode,lastError:null};});
    const result=await this.submit(monitor,task,C.setupPrompt(id,token),'cm-setup-'+requestId,'setup',token);
    const latest=(await this.service.monitor(id)).monitor;
    return {...result,state:C.setupReady(latest)?'ready':latest.runtime.setupStatus};
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
    let {monitor}=await this.service.monitor(id);C.ensure(monitor,'MONITOR_NOT_FOUND','方案不存在。');
    const r=monitor.runtime??{};let native=null;
    if(r.lastNativeRunId&&!r.pendingInput){
      native=await this.tasks.getRun({runId:r.lastNativeRunId});
      const incomplete=r.lastMode==='setup'&&r.setupStatus==='checking'&&!r.pendingInput&&!ACTIVE.has(native.status)&&!C.setupReady(monitor);
      if(native.status!==r.lastNativeStatus||incomplete){
        monitor=await this.service.updateRuntime(id,(current,currentMonitor)=>({...current,lastNativeStatus:native.status,...(native.error?{lastError:native.error}:{}),...(current.lastMode==='setup'&&current.setupStatus==='checking'&&!current.pendingInput&&!ACTIVE.has(native.status)&&!C.setupReady(currentMonitor)?{setupStatus:'needs_attention',lastError:native.error||INCOMPLETE_SETUP}:{})}));
        await this.changed();
      }
    }
    return {ready:C.setupReady(monitor),runtime:monitor.runtime,native};
  }
}
