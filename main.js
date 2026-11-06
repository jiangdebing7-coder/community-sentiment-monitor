// Only the logic page has the Cindy bridge. UI pages use a same-origin channel.
const ready = (async () => {
  const C = await import('/core.js');
  const {MonitorService} = await import('/service.js');
  const {MonitorRuntime} = await import('/runtime.js');
  const {DiscordCollector} = await import('/discord-collector.js');
  const channel = new BroadcastChannel('community-sentiment-monitor-v1');
  const unwrap = r => { C.ensure(r?.ok, r?.errorCode || 'HOST_STORAGE_UNAVAILABLE', r?.message || '宿主私有存储暂时不可用，请稍后重试。'); return r; };
  const io = {
    now: () => Date.now(),
    async readConfig() { const r=await fetch('/kv',{cache:'no-store'}); C.ensure(r.ok,'HOST_STORAGE_UNAVAILABLE','无法读取配置，请重新打开插件。'); return r.json(); },
    async writeConfig(state) { const r=await fetch('/kv',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(state)}); C.ensure(r.ok,'HOST_STORAGE_UNAVAILABLE',r.status===413?'配置容量已满，请精简后再试。':'配置保存失败，请保留输入后重试。'); },
    async readReport(path) {const r=await cindy.fs({op:'read',root:'data',path}); if(!r?.ok && (r?.errorCode==='NOT_FOUND'||r?.message===`文件不存在:${path}`))return null; unwrap(r); try{return JSON.parse(r.content);}catch{throw new C.MonitorError('REPORT_UNAVAILABLE','已有日报记录损坏，已停止发送以避免重复。');}},
    async writeReport(path,data) {unwrap(await cindy.fs({op:'write',root:'data',path,content:JSON.stringify(data)}));},
    async deleteReport(path) {const r=await cindy.fs({op:'delete',root:'data',path});if(!r?.ok&&(r?.errorCode==='NOT_FOUND'||r?.message===`文件不存在:${path}`))return;unwrap(r);}
  };
  const service = new MonitorService(io);
  async function changed() {channel.postMessage({type:'changed'});}
  const collector = new DiscordCollector(service,io,args=>cindy.fetch(args));
  const runtime = new MonitorRuntime(service,cindy.tasks,changed,collector);
  const tools = {
    list_monitors: () => service.getState(),
    save_monitor: a => service.save(a.monitor,a.expected_revision),
    delete_monitor: a => service.remove(a.monitor_id,a.expected_revision),
    async prepare_run(a) {const plan=await service.prepare(a.monitor_id,a.mode??'preview',a.report_date,a.execution_token);if(plan.state==='ready'&&plan.monitor.collectionMode==='bot')plan.collection=await collector.info(a.monitor_id,plan.period.date);return plan;},
    sync_messages: a => collector.sync(a.monitor_id,a.report_date),
    read_messages: a => collector.read(a.monitor_id,a.report_date,a.cursor??'0:0'),
    prepare_setup: a => service.prepareSetup(a.monitor_id,a.setup_token),
    complete_setup: a => service.completeSetup(a),
    dispatch_report: a => runtime.dispatch(a.monitor_id),
    async store_report(a) {const {monitor}=await service.monitor(a.monitor_id);if(monitor?.collectionMode==='bot')await collector.validateReport(a);const r=await service.storeReport(a);await service.cleanup(a.monitor_id);await cindy.send({type:'badge',unread:true,summary:`${a.report_date} 日报已更新`});return r;},
    begin_delivery: a => service.beginDelivery(a),
    complete_delivery: a => service.completeDelivery(a),
    prepare_schedule: a => service.schedule(a.monitor_id)
  };
  const mutations=new Set(['save_monitor','delete_monitor','store_report','begin_delivery','complete_delivery','complete_setup']);
  async function dispatch(tool,args) {C.ensure(Object.hasOwn(tools,tool),'UNKNOWN_ACTION','此操作不可用。');const r=await tools[tool](args??{});if(mutations.has(tool))await changed();return r;}
  async function ui(action,args,reqId) {
    switch(action) {
      case 'state': return service.getState();
      case 'save': return dispatch('save_monitor',args);
      case 'delete': return dispatch('delete_monitor',args);
      case 'report': return service.getReport(args.monitor_id,args.report_date);
      case 'setup': return runtime.configure(args.monitor_id,reqId);
      case 'runtime_status': return runtime.status(args.monitor_id);
      case 'discord_status': {const monitor=args.monitor_id?(await service.monitor(args.monitor_id)).monitor:null;return collector.connectionStatus(monitor);}
      case 'discord_credentials_changed': {const result=await service.invalidateDiscordChecks();await changed();return result;}
      case 'discord_sync': return collector.sync(args.monitor_id);
      case 'discord_collection': return collector.info(args.monitor_id);
      case 'discord_clear_cache': return collector.clear(args.monitor_id);
      case 'preview': case 'send': return runtime.start(args.monitor_id,action,reqId);
      case 'schedule': {
        const plan=await service.schedule(args.monitor_id);
        C.ensure(typeof cindy.agent?.requestSchedule==='function','UNSUPPORTED','当前 Cindy 不支持自动化草稿入口。');
        // The verified 0.1.121 API accepts name/prompt/intervalMs, not cron/timezone.
        // Never pretend it applied a clock time, or that a draft is an active job.
        const r=await cindy.agent.requestSchedule({name:plan.name,prompt:`建议执行时间：每天 ${plan.time}（${plan.timezone}）；cron ${plan.cronExpr}。请在自动化页面核对时间和时区后保存。\n${plan.prompt}`});
        C.ensure(r?.ok,r?.errorCode||'SCHEDULE_UNAVAILABLE',r?.message||'无法打开自动化创建页，请稍后再试。');
        return {...plan,draftRequested:true};
      }
      case 'schedule_plan': return service.schedule(args.monitor_id);
      case 'mark_read': await cindy.send({type:'badge',unread:false}); return {ok:true};
      default: throw new C.MonitorError('UNKNOWN_ACTION','此操作不可用。');
    }
  }
  const requests=new Map();
  channel.onmessage=event=>{
    const msg=event.data;
    if(msg?.type!=='request'||typeof msg.id!=='string'||msg.id.length>80)return;
    const signature=JSON.stringify([msg.action,msg.args]);
    if(requests.has(msg.id)&&requests.get(msg.id).signature!==signature) {channel.postMessage({type:'response',id:msg.id,ok:false,error:{code:'REQUEST_KEY_CONFLICT',message:'同一次操作内容发生变化，请重新发起。'}});return;}
    if(!requests.has(msg.id)) {
      const promise=ui(msg.action,msg.args??{},msg.id).then(result=>({type:'response',id:msg.id,ok:true,result}),error=>({type:'response',id:msg.id,ok:false,error:{code:error.code||'OPERATION_FAILED',message:error.message||'操作失败，请稍后再试。'}}));
      const record={signature,promise,response:null};requests.set(msg.id,record);
      promise.then(response=>{record.response=response;channel.postMessage(response);});
      if(requests.size>100)requests.delete(requests.keys().next().value);
    }else if(requests.get(msg.id).response)channel.postMessage(requests.get(msg.id).response);
  };
  return {dispatch,channel};
})();

// Subscribe synchronously: a tool arriving during module loading must not be lost.
cindy.onHostMessage(async msg=>{
  if(msg.type==='host-context-changed') {try{(await ready).channel.postMessage({type:'locale-changed'});}catch{} return;}
  if(msg.type!=='tool-call')return;
  try {const {dispatch}=await ready;const result=await dispatch(msg.tool,msg.args);await cindy.send({type:'tool-result',callId:msg.callId,ok:true,result});}
  catch(error) {await cindy.send({type:'tool-result',callId:msg.callId,ok:false,errorCode:error.code||'OPERATION_FAILED',message:error.message||'操作失败，请检查配置后重试。'});}
});
