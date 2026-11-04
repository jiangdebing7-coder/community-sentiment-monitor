export const PLUGIN_ID = 'community-sentiment-monitor';
export const MAX_MONITORS = 12;
// Reserve room in the host's 64 KiB /kv limit for the report-date index.
export const MAX_CONFIG_BYTES = 40 * 1024;
export class MonitorError extends Error {
  constructor(code, message) { super(message); this.name = 'MonitorError'; this.code = code; }
}
export function ensure(condition, code, message) { if (!condition) throw new MonitorError(code, message); }
export function clone(value) { return JSON.parse(JSON.stringify(value)); }
export function newId() { return 'm_' + crypto.randomUUID().replaceAll('-', ''); }
export function safeId(value) {
  ensure(typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value), 'INVALID_ID', '监测方案编号无效。');
  return value;
}
function bounded(value, max, label, required = false) {
  const result = typeof value === 'string' ? value.trim() : '';
  ensure((!required || result.length > 0) && result.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(result), 'INVALID_CONFIG', `${label}为空、过长或包含无效字符。`);
  return result;
}
export function validateTimeZone(zone) {
  ensure(typeof zone === 'string' && zone.length <= 80, 'INVALID_TIMEZONE', '请填写有效的 IANA 时区。');
  try { new Intl.DateTimeFormat('en', {timeZone: zone}).format(new Date()); }
  catch { throw new MonitorError('INVALID_TIMEZONE', '时区无效，例如 Asia/Shanghai、America/Los_Angeles。'); }
  return zone;
}
export function normalizeSource(raw, scope = 'server') {
  const input = typeof raw === 'string' ? raw : raw?.url;
  let url;
  try { url = new URL(bounded(input, 256, 'Discord 链接', true)); } catch { throw new MonitorError('INVALID_SOURCE', '请填写完整的 Discord HTTPS 邀请或频道链接。'); }
  ensure(url.protocol === 'https:' && !url.username && !url.password && !url.port, 'INVALID_SOURCE', '社区链接必须是 Discord HTTPS 地址，不能包含账号或端口。');
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname.replace(/\/+$/, '');
  let match;
  if (host === 'discord.gg' && /^\/[a-zA-Z0-9_-]{2,64}$/.test(path)) {
    ensure(scope === 'server', 'CHANNEL_LINK_REQUIRED', '仅监测指定频道时，请使用 discord.com/channels/服务器ID/频道ID 链接。');
    return {kind:'invite', url:'https://discord.gg' + path, guildId:null, channelId:null};
  }
  ensure(host === 'discord.com', 'INVALID_SOURCE', '目前只支持 discord.com 和 discord.gg 的社区链接。');
  if ((match = path.match(/^\/invite\/([a-zA-Z0-9_-]{2,64})$/))) {
    ensure(scope === 'server', 'CHANNEL_LINK_REQUIRED', '仅监测指定频道时，请填写频道完整链接。');
    return {kind:'invite', url:'https://discord.gg/' + match[1], guildId:null, channelId:null};
  }
  match = path.match(/^\/channels\/(\d{17,20})\/(\d{17,20})(?:\/\d{17,20})?$/);
  ensure(match, 'INVALID_SOURCE', '请填写服务器中的文字频道链接，不能使用私聊链接。');
  return {kind:'channel', url:`https://discord.com/channels/${match[1]}/${match[2]}`, guildId:match[1], channelId:match[2]};
}
export function normalizeRecipient(raw) {
  const type = raw?.type;
  ensure(['self','email','open_id','chat_id'].includes(type), 'INVALID_RECIPIENT', '接收人类型无效。');
  let value = type === 'self' ? '' : bounded(raw.value, 254, '飞书接收目标', true);
  if (type === 'email') {
    ensure(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'INVALID_RECIPIENT', '请填写有效的飞书账号邮箱。');
    value = value.toLowerCase();
  }
  if (type === 'open_id') ensure(/^ou_[a-zA-Z0-9]{8,100}$/.test(value), 'INVALID_RECIPIENT', '飞书用户 open_id 应以 ou_ 开头。');
  if (type === 'chat_id') {
    if (value.startsWith('https://')) {
      let url; try { url = new URL(value); } catch { throw new MonitorError('INVALID_RECIPIENT','飞书群链接无效。'); }
      ensure(url.hostname === 'applink.feishu.cn' && !url.username && !url.password && !url.port, 'INVALID_RECIPIENT','请填写飞书群 chat_id 或官方会话链接。');
      value = url.searchParams.get('openChatId') || '';
    }
    ensure(/^oc_[a-zA-Z0-9]{8,100}$/.test(value), 'INVALID_RECIPIENT', '飞书群 chat_id 应以 oc_ 开头。');
  }
  return {type,value,label:bounded(raw.label,80,'接收人备注'),key:type+':'+value};
}
export function normalizeMonitor(input, id = input?.id || newId()) {
  ensure(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_CONFIG','监测配置必须是对象。');
  const scope = input.scope ?? 'server';
  ensure(['server','channels'].includes(scope), 'INVALID_CONFIG','监测范围无效。');
  const rawSources = input.sources;
  ensure(Array.isArray(rawSources) && rawSources.length >= 1 && rawSources.length <= 8, 'INVALID_SOURCE','每个方案请填写 1–8 个社区链接。');
  const sourceMap = new Map();
  for(const raw of rawSources){const s=normalizeSource(raw,scope);const key=scope==='server'&&s.guildId?s.guildId:s.url;if(!sourceMap.has(key))sourceMap.set(key,s);}
  const sources=[...sourceMap.values()];
  ensure(Array.isArray(input.recipients) && input.recipients.length >= 1 && input.recipients.length <= 8, 'INVALID_RECIPIENT','每个方案请设置 1–8 个飞书接收目标。');
  const recipients = [...new Map(input.recipients.map(raw => {const r=normalizeRecipient(raw); return [r.key,r];})).values()];
  const time = input.time ?? '10:00';
  ensure(/^([01]\d|2[0-3]):[0-5]\d$/.test(time), 'INVALID_TIME','日报时间应为 24 小时制 HH:MM。');
  const historyDays = input.historyDays ?? 90;
  ensure(Number.isInteger(historyDays) && historyDays >= 7 && historyDays <= 120, 'INVALID_CONFIG','报告保留时间应为 7–120 天。');
  const language = input.language ?? 'zh-CN';
  ensure(['zh-CN','en'].includes(language), 'INVALID_CONFIG','目前支持中文和英文日报。');
  return {id:safeId(id),name:bounded(input.name,80,'方案名称',true),enabled:input.enabled !== false,scope,sources,recipients,time,timezone:validateTimeZone(input.timezone ?? 'Asia/Shanghai'),language,focus:bounded(input.focus,1200,'关注事项'),historyDays};
}
export function initialState() { return {version:1,revision:0,monitors:[]}; }
export function validateState(raw) {
  if (!raw || Object.keys(raw).length === 0) return initialState();
  ensure(raw.version === 1 && Array.isArray(raw.monitors) && Number.isInteger(raw.revision), 'STATE_UNAVAILABLE','已有插件配置无法读取，已停止覆盖。请检查当前插件数据。');
  return clone(raw);
}
export function saveMonitor(state, input, expectedRevision, now = new Date().toISOString()) {
  const next = validateState(state);
  const existing = input.id ? next.monitors.find(m=>m.id===input.id) : null;
  if (input.id && !existing) throw new MonitorError('MONITOR_NOT_FOUND','方案已删除，请刷新后重新创建。');
  ensure((existing?.revision ?? 0) === expectedRevision, 'REVISION_CONFLICT','配置已经更新，请刷新后再保存，避免覆盖其他页面的修改。');
  ensure(existing || next.monitors.length < MAX_MONITORS, 'TOO_MANY_MONITORS',`最多保存 ${MAX_MONITORS} 个监测方案。`);
  const monitor={...normalizeMonitor(input,existing?.id),revision:(existing?.revision??0)+1,createdAt:existing?.createdAt??now,updatedAt:now,knownRunDates:existing?.knownRunDates??[],lastRun:existing?.lastRun??null};
  if(existing)next.monitors[next.monitors.findIndex(m=>m.id===monitor.id)]=monitor; else next.monitors.push(monitor);
  next.revision++;
  ensure(new TextEncoder().encode(JSON.stringify(next)).length <= MAX_CONFIG_BYTES, 'CONFIG_TOO_LARGE','配置容量已满，请精简社区链接、接收目标或关注事项。');
  return {state:next,monitor};
}
export function deleteMonitor(state,id,expectedRevision) {
  safeId(id); const next=validateState(state); const monitor=next.monitors.find(m=>m.id===id);
  ensure(monitor,'MONITOR_NOT_FOUND','监测方案不存在。');
  ensure(monitor.revision===expectedRevision,'REVISION_CONFLICT','配置已经更新，请刷新后再删除。');
  next.monitors=next.monitors.filter(m=>m.id!==id); next.revision++; return next;
}
export function validDate(date) {
  const parsed=typeof date==='string'?Date.parse(date+'T00:00:00Z'):NaN;
  ensure(typeof date==='string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0,10)===date,'INVALID_DATE','统计日期无效，请使用 YYYY-MM-DD。');
  return date;
}
function partsAt(ms, timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms)).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
}
export function localDate(ms,timezone) {const p=partsAt(ms,timezone); return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;}
export function shiftDate(date,days) {validDate(date); const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
export function zonedMidnight(date,timezone) {
  validDate(date);validateTimeZone(timezone);
  const target=Date.parse(date+'T00:00:00Z');let guess=target;
  for(let i=0;i<6;i++) { const p=partsAt(guess,timezone);const rendered=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);const delta=target-rendered;if(delta===0)return guess;guess+=delta; }
  throw new MonitorError('DATE_BOUNDARY_UNAVAILABLE','该时区的日期边界无法确定，请检查时区设置。');
}
export function reportWindow(timezone,now=Date.now(),date) {
  const reportDate=date?validDate(date):shiftDate(localDate(now,timezone),-1);
  return {date:reportDate,timezone,start:new Date(zonedMidnight(reportDate,timezone)).toISOString(),endExclusive:new Date(zonedMidnight(shiftDate(reportDate,1),timezone)).toISOString()};
}
export function scheduleSpec(monitor) {const [h,m]=monitor.time.split(':');return {name:`社群日报｜${monitor.name}`.slice(0,60),time:monitor.time,cronExpr:`${Number(m)} ${Number(h)} * * *`,timezone:monitor.timezone,recurring:true};}
export function taskPrompt(id,mode='send') {
  safeId(id);ensure(['send','preview'].includes(mode),'INVALID_MODE','执行模式无效。');
  return `执行“社群舆情监控”的${mode==='send'?'生成并发送日报':'只预览日报'}任务。监测方案编号：${id}。先使用 ghost_info 精确发现插件 ${PLUGIN_ID}，沿用发现结果的 namespace（包括 null），读取 daily-report 手册，再调用 prepare_run，monitor_id=${id}，mode=${mode}。每次读取最新配置，按该方案时区统计运行当天的前一自然日。只监测配置内的 Discord 社区或频道；沿用使用者已经认可的模型与账号。遵循返回的时间范围、来源范围、接收目标及投递流程。无新增也生成日报，采集失败不能当成无新增。${mode==='send'?'按手册逐个取得投递占用，再向配置目标发送；每条真实回执立即写回 complete_delivery。发送结果未知时不盲目重发。':'本次仅在 Cindy 和插件内展示样报，不向飞书发送。'}将报告通过 store_report 保存到插件。配置停用或删除时停止本次执行，不改用其他方案。`;
}
export async function deliveryKey(monitorId,date,recipientKey) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${PLUGIN_ID}|${safeId(monitorId)}|${validDate(date)}|${recipientKey}`));
  return 'cm_'+Array.from(new Uint8Array(bytes)).map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,40);
}
export function reportPath(id,date) {return `reports/${safeId(id)}/${validDate(date)}.json`;}
