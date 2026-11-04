import * as C from './core.js';

// One writer serves every tool and UI surface. Reports/receipts live in the
// host-owned private data directory; configuration alone uses /kv.
export class MonitorService {
  constructor(io) {this.io=io;this.queue=Promise.resolve();}
  serial(fn) {const job=this.queue.then(fn);this.queue=job.catch(()=>{});return job;}
  async state() {return C.validateState(await this.io.readConfig());}
  async monitor(id) {C.safeId(id);const state=await this.state();return {state,monitor:state.monitors.find(m=>m.id===id)};}
  async getState() {return this.serial(()=>this.state());}
  async save(input,revision) {return this.serial(async()=>{const r=C.saveMonitor(await this.state(),input,revision);await this.io.writeConfig(r.state);return r.monitor;});}
  async remove(id,revision) {return this.serial(async()=>{await this.io.writeConfig(C.deleteMonitor(await this.state(),id,revision));return {deleted:true,note:'如果已创建对应自动化，请在 Cindy 自动化页暂停或删除。'};});}
  async readRun(monitor,date) {
    const r=await this.io.readReport(C.reportPath(monitor.id,date));
    if(!r && (monitor.knownRunDates??[]).includes(date))throw new C.MonitorError('REPORT_UNAVAILABLE','日报记录暂时无法读取，已停止发送以避免重复。');
    return r;
  }
  async prepare(id,mode='preview',date) {return this.serial(async()=>{
    C.ensure(['preview','send'].includes(mode),'INVALID_MODE','执行模式无效。');
    const {monitor}=await this.monitor(id);
    if(!monitor)return {state:'deleted',monitor_id:id,instruction:'方案已删除，停止执行；在 Cindy 自动化页管理旧任务。'};
    if(!monitor.enabled)return {state:'paused',monitor_id:id,instruction:'方案已停用，不采集也不发送。'};
    const period=C.reportWindow(monitor.timezone,this.io.now(),date);
    const run=await this.readRun(monitor,period.date);
    return {state:'ready',mode,monitor:C.clone(monitor),period,run,scope:{platform:'discord',range:monitor.scope,sources:monitor.sources},recipients:monitor.recipients,history:(monitor.knownRunDates??[]).filter(d=>d<period.date).slice(-7),instructions:'按照 daily-report 手册读取真实消息并保存日报。发送前逐个调用 begin_delivery；已投递、被占用或结果未知的目标不得重复发送。'};
  });}
  async storeReport(args) {return this.serial(async()=>{
    const {state,monitor}=await this.monitor(args.monitor_id);
    C.ensure(monitor?.enabled,'MONITOR_UNAVAILABLE','监测方案已删除或停用。');
    C.ensure(monitor.revision===args.expected_revision,'REVISION_CONFLICT','配置已改变，请重新获取方案并采集。');
    C.validDate(args.report_date);
    C.ensure(['ok','no_new','collection_failed'].includes(args.status),'INVALID_REPORT','日报状态无效。');
    C.ensure(typeof args.body==='string'&&args.body.trim().length>0&&args.body.length<=24000,'INVALID_REPORT','日报正文为空或超过 24000 字符。');
    C.ensure(args.message_count===null||(Number.isSafeInteger(args.message_count)&&args.message_count>=0),'INVALID_REPORT','消息数必须是可核实的非负整数，未知时填 null。');
    C.ensure(args.status!=='no_new'||args.message_count===0,'INVALID_REPORT','无新增日报的消息数必须为 0。');
    const old=await this.readRun(monitor,args.report_date);
    if(Object.values(old?.deliveries??{}).some(d=>['sending','uncertain'].includes(d.status)))throw new C.MonitorError('DELIVERY_PENDING','已有投递尚未核对，不能覆盖该份日报。');
    const run={version:1,monitorId:monitor.id,date:args.report_date,configRevision:monitor.revision,timezone:monitor.timezone,status:args.status,body:args.body.trim(),messageCount:args.message_count,coverage:typeof args.coverage==='string'?args.coverage.slice(0,2000):'',updatedAt:new Date(this.io.now()).toISOString(),deliveries:old?.deliveries??{}};
    await this.io.writeReport(C.reportPath(monitor.id,run.date),run);
    monitor.knownRunDates=[...new Set([...(monitor.knownRunDates??[]),run.date])].sort();
    monitor.lastRun={date:run.date,status:run.status,messageCount:run.messageCount,updatedAt:run.updatedAt};
    state.revision++;await this.io.writeConfig(state);
    return {saved:true,monitor_id:monitor.id,report_date:run.date,status:run.status};
  });}
  async beginDelivery(args) {return this.serial(async()=>{
    const {monitor}=await this.monitor(args.monitor_id);
    C.ensure(monitor?.enabled,'MONITOR_UNAVAILABLE','监测方案已删除或停用。');
    C.ensure(monitor.revision===args.expected_revision,'REVISION_CONFLICT','接收配置已改变，请重新获取方案。');
    const recipient=monitor.recipients.find(r=>r.key===args.recipient_key);
    C.ensure(recipient,'RECIPIENT_CHANGED','此目标已不在当前接收列表中。');
    const run=await this.readRun(monitor,C.validDate(args.report_date));
    C.ensure(run && run.status!=='collection_failed','REPORT_NOT_READY','日报尚未准备好或采集失败，不能作为正常日报发送。');
    C.ensure(run.configRevision===monitor.revision,'REVISION_CONFLICT','日报使用了旧配置，请重新生成。');
    const old=run.deliveries[recipient.key];
    if(old?.status==='sent')return {state:'already_sent',receipt:old};
    if(old && ['sending','uncertain'].includes(old.status))return {state:'needs_review',delivery:old,instruction:'先核对飞书真实投递结果，不能自动重新发送。'};
    const claim={status:'sending',token:crypto.randomUUID(),recipient:C.clone(recipient),uuid:await C.deliveryKey(monitor.id,run.date,recipient.key),startedAt:new Date(this.io.now()).toISOString()};
    run.deliveries[recipient.key]=claim;
    await this.io.writeReport(C.reportPath(monitor.id,run.date),run);
    return {state:'claimed',delivery_token:claim.token,uuid:claim.uuid,recipient,body:run.body,report_date:run.date};
  });}
  async completeDelivery(args) {return this.serial(async()=>{
    const {state,monitor}=await this.monitor(args.monitor_id);
    C.ensure(monitor,'MONITOR_NOT_FOUND','方案已删除；请保留真实回执供人工核对。');
    const run=await this.readRun(monitor,C.validDate(args.report_date));
    C.ensure(run,'REPORT_NOT_READY','日报记录不存在。');
    const attempt=run.deliveries[args.recipient_key];
    C.ensure(attempt&&attempt.token===args.delivery_token,'INVALID_DELIVERY_TOKEN','投递凭证不匹配，不能修改该回执。');
    C.ensure(['sent','failed','uncertain'].includes(args.status),'INVALID_DELIVERY','投递状态无效。');
    if(attempt.status==='sent')return {state:'already_sent',receipt:attempt};
    if(args.status==='sent') {
      C.ensure(typeof args.message_id==='string'&&/^om_[a-zA-Z0-9_-]+$/.test(args.message_id),'RECEIPT_REQUIRED','成功状态必须提供飞书实际返回的 message_id。');
      if(attempt.recipient.type==='chat_id')C.ensure(args.chat_id===attempt.recipient.value,'RECEIPT_TARGET_MISMATCH','飞书回执的群聊与配置不一致。');
      if(args.chat_id)C.ensure(/^oc_[a-zA-Z0-9]+$/.test(args.chat_id),'INVALID_DELIVERY','飞书 chat_id 无效。');
    }
    Object.assign(attempt,{status:args.status,finishedAt:new Date(this.io.now()).toISOString(),messageId:args.status==='sent'?args.message_id:null,chatId:args.chat_id??null,senderId:args.sender_id??null,note:typeof args.note==='string'?args.note.slice(0,1000):''});
    await this.io.writeReport(C.reportPath(monitor.id,run.date),run);
    const statuses=monitor.recipients.map(r=>run.deliveries[r.key]?.status);
    if(monitor.lastRun?.date===run.date)monitor.lastRun.deliveryStatus=statuses.every(s=>s==='sent')?'sent':statuses.includes('uncertain')?'uncertain':'partial';
    state.revision++;await this.io.writeConfig(state);
    return {saved:true,status:attempt.status,message_id:attempt.messageId,all_delivered:statuses.every(s=>s==='sent')};
  });}
  async getReport(id,date) {return this.serial(async()=>{const {monitor}=await this.monitor(id);C.ensure(monitor,'MONITOR_NOT_FOUND','方案不存在。');return this.readRun(monitor,C.validDate(date));});}
  async schedule(id) {return this.serial(async()=>{const {monitor}=await this.monitor(id);C.ensure(monitor?.enabled,'MONITOR_UNAVAILABLE','请先保存并启用该监测方案。');return {...C.scheduleSpec(monitor),monitor_id:id,prompt:C.taskPrompt(id,'send'),note:'插件只请求打开 Cindy 自动化创建页。请将时间设为上述 cronExpr 和 timezone，并亲手保存；返回草稿不代表已启用。'};});}
  async cleanup(id) {return this.serial(async()=>{
    const {state,monitor}=await this.monitor(id);if(!monitor)return {removed:0};
    const cutoff=C.shiftDate(C.localDate(this.io.now(),monitor.timezone),-monitor.historyDays);
    let removed=0;const keep=[];
    for(const date of monitor.knownRunDates??[]) {
      if(date>=cutoff){keep.push(date);continue;}
      const run=await this.readRun(monitor,date);
      if(Object.values(run?.deliveries??{}).some(d=>['sending','uncertain'].includes(d.status))){keep.push(date);continue;}
      await this.io.deleteReport(C.reportPath(monitor.id,date));removed++;
    }
    monitor.knownRunDates=keep;if(removed){state.revision++;await this.io.writeConfig(state);}return {removed};
  });}
}
