import {ensure,MonitorError} from './core.js';

export const DISCORD_API='https://discord.com/api/v10';
export const READ_ONLY_BOT_PERMISSIONS='66560'; // VIEW_CHANNEL | READ_MESSAGE_HISTORY
export const VIEW_CHANNEL=1n<<10n,READ_HISTORY=1n<<16n;
const ADMINISTRATOR=1n<<3n;
const CONTENT_INTENTS=(1n<<18n)|(1n<<19n);
export const MESSAGE_CHANNELS=new Set([0,5,10,11,12]);
export const THREAD_PARENTS=new Set([0,5,15,16]);
export const THREAD_CHANNELS=new Set([10,11,12]);

export class DiscordError extends MonitorError {
  constructor(code,message,details={}){super(code,message);Object.assign(this,details);}
}
export function snowflake(value){ensure(typeof value==='string'&&/^\d{17,20}$/.test(value),'DISCORD_INVALID_ID','Discord 返回了无效的对象编号。');return value;}
function bits(value){ensure(typeof value==='string'&&/^\d{1,32}$/.test(value),'DISCORD_PERMISSIONS_UNVERIFIED','无法核实机器人权限，不能把空响应当成无新增。');return BigInt(value);}
export function beforeSnowflake(iso){const ms=Date.parse(iso);ensure(Number.isFinite(ms)&&ms>=1420070400000,'DISCORD_INVALID_WINDOW','统计窗口早于 Discord 的有效消息时间。');return ((BigInt(ms)-1420070400000n)<<22n).toString();}

// Discord can return [] when READ_MESSAGE_HISTORY is absent. Check effective
// role/member overwrites before interpreting any empty history response.
export function channelPermissions(guild,member,channel,botId){
  ensure(guild?.id===channel.guild_id&&Array.isArray(guild.roles)&&Array.isArray(member?.roles),'DISCORD_PERMISSIONS_UNVERIFIED','频道权限资料不完整，无法确认采集覆盖。');
  if(guild.owner_id===botId)return (1n<<64n)-1n;
  const roles=new Map(guild.roles.map(r=>[r.id,r]));
  ensure(roles.has(guild.id),'DISCORD_PERMISSIONS_UNVERIFIED','缺少服务器基础角色权限。');
  let permissions=bits(roles.get(guild.id).permissions);
  for(const id of member.roles){ensure(roles.has(id),'DISCORD_PERMISSIONS_UNVERIFIED','机器人角色已改变，请重新检查连接。');permissions|=bits(roles.get(id).permissions);}
  if((permissions&ADMINISTRATOR)!==0n)return (1n<<64n)-1n;
  ensure(channel.permission_overwrites===undefined||Array.isArray(channel.permission_overwrites),'DISCORD_PERMISSIONS_UNVERIFIED','频道权限覆盖格式无效。');
  const overwrites=channel.permission_overwrites??[];
  const apply=o=>{if(o)permissions=(permissions&~bits(o.deny))|bits(o.allow);};
  apply(overwrites.find(o=>o.type===0&&o.id===guild.id));
  let allow=0n,deny=0n;
  for(const o of overwrites)if(o.type===0&&member.roles.includes(o.id)){allow|=bits(o.allow);deny|=bits(o.deny);}
  permissions=(permissions&~deny)|allow;
  apply(overwrites.find(o=>o.type===1&&o.id===botId));
  return permissions;
}
export function canReadHistory(guild,member,channel,botId){const p=channelPermissions(guild,member,channel,botId);return (p&(VIEW_CHANNEL|READ_HISTORY))===(VIEW_CHANNEL|READ_HISTORY);}
export function botInviteUrl(applicationId,guildId){
  const q=new URLSearchParams({client_id:snowflake(applicationId),scope:'bot',permissions:READ_ONLY_BOT_PERMISSIONS,integration_type:'0'});
  if(guildId){q.set('guild_id',snowflake(guildId));q.set('disable_guild_select','true');}
  return 'https://discord.com/oauth2/authorize?'+q;
}

export class DiscordApi {
  constructor(fetch,now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms))){this.fetch=fetch;this.now=now;this.sleep=sleep;this.retryAt=0;}
  async get(path,query={},deadline=Infinity){
    // Fixed official host, GET only. Authorization is injected by Cindy's vault;
    // this module never receives a token or accepts an arbitrary URL.
    const legal=/^\/(?:users\/@me|oauth2\/applications\/@me|invites\/[a-zA-Z0-9_-]{2,64}|guilds\/\d{17,20}(?:\/channels|\/members\/\d{17,20}|\/threads\/active)?|channels\/\d{17,20}(?:\/messages|\/threads\/archived\/public|\/users\/@me\/threads\/archived\/private)?)$/;
    ensure(legal.test(path),'DISCORD_INVALID_ROUTE','此 Discord 请求不在只读采集范围内。');
    const q=new URLSearchParams(Object.entries(query).filter(([,v])=>v!==null&&v!==undefined).map(([k,v])=>[k,String(v)]));
    for(let attempt=0;attempt<3;attempt++){
      this.beforeRequest?.();
      if(this.now()+1000>=deadline)throw new DiscordError('DISCORD_SYNC_YIELD','本批采集已到时间预算，已保留断点。');
      const wait=this.retryAt-this.now();
      if(wait>0){if(wait>3000||this.now()+wait>=deadline)throw new DiscordError('DISCORD_RATE_LIMITED','Discord 正在限流，已保留采集断点，请到提示时间后继续。',{retryAt:this.retryAt});await this.sleep(wait);}
      const response=await this.fetch({url:DISCORD_API+path+(q.size?'?'+q:''),method:'GET',headers:{Accept:'application/json','User-Agent':'DiscordBot (https://github.com/jiangdebing7-coder/community-sentiment-monitor, 1.2.0)'},timeoutMs:Math.max(1000,Math.min(15000,deadline-this.now()))});
      if(!response?.ok)throw new DiscordError('DISCORD_CONNECTION_UNAVAILABLE','Discord 连接不可用；请检查机器人安全配置和网络。');
      ensure(!response.truncated,'DISCORD_RESPONSE_TRUNCATED','Discord 响应被截断，采集未完成。');
      let data;try{data=JSON.parse(response.body);}catch{throw new DiscordError('DISCORD_INVALID_RESPONSE','Discord 没有返回有效 JSON，不能视为无新增。');}
      if(response.status===429){const seconds=Number(data.retry_after??response.headers?.['retry-after']);this.retryAt=this.now()+(Number.isFinite(seconds)&&seconds>=0?Math.max(100,seconds*1000):30000);continue;}
      if(response.status===401)throw new DiscordError('DISCORD_AUTH_EXPIRED','Discord 机器人凭证无效或已撤销，请在插件安全配置中更新。',{status:401});
      if(response.status===403)throw new DiscordError('DISCORD_FORBIDDEN','机器人没有读取此频道的权限，请核对查看频道和读取历史消息权限。',{status:403});
      if(response.status===404)throw new DiscordError('DISCORD_NOT_FOUND','机器人尚未加入目标服务器，或目标频道/邀请已失效。',{status:404});
      if(response.status>=500){if(attempt<2&&this.now()+500<deadline){await this.sleep(300*(attempt+1));continue;}throw new DiscordError('DISCORD_SERVER_UNAVAILABLE','Discord 服务暂时不可用，已保留断点。',{status:response.status});}
      if(response.status<200||response.status>=300)throw new DiscordError('DISCORD_REQUEST_FAILED',`Discord 只读请求失败（HTTP ${response.status}）。`,{status:response.status});
      return data;
    }
    throw new DiscordError('DISCORD_RATE_LIMITED','Discord 限流尚未解除，采集未完成，请稍后从原断点继续。',{retryAt:this.retryAt});
  }
  async identity(){
    const user=await this.get('/users/@me');ensure(user?.bot===true,'DISCORD_BOT_REQUIRED','请使用专用机器人的 Bot Token，不能使用个人账号凭证。');snowflake(user.id);
    const application=await this.get('/oauth2/applications/@me');snowflake(application.id);
    ensure(Number.isSafeInteger(application.flags)&&application.flags>=0,'DISCORD_INTENT_UNVERIFIED','无法核实机器人消息内容权限，请在开发者后台检查。');
    const contentEnabled=(BigInt(application.flags)&CONTENT_INTENTS)!==0n;
    return {botId:user.id,botName:String(user.global_name||user.username||'Discord Bot').slice(0,100),applicationId:application.id,contentEnabled};
  }
  async resolve(source){
    if(source.guildId)return {url:source.url,guildId:snowflake(source.guildId),channelId:source.channelId?snowflake(source.channelId):null};
    const code=new URL(source.url).pathname.slice(1);const invite=await this.get('/invites/'+code);
    ensure(invite?.guild?.id,'DISCORD_INVALID_INVITE','邀请没有指向可监测的服务器。');
    return {url:source.url,guildId:snowflake(invite.guild.id),channelId:invite.channel?.id?snowflake(invite.channel.id):null,guildName:String(invite.guild.name||'').slice(0,100)};
  }
}

export function normalizeDiscordMessage(raw,channel,period){
  snowflake(raw?.id);ensure(raw.channel_id===channel.id,'DISCORD_SCOPE_MISMATCH','消息所属频道与采集范围不一致。');
  const time=Date.parse(raw.timestamp);ensure(Number.isFinite(time),'DISCORD_INVALID_MESSAGE','消息时间无效，无法核实统计日期。');
  if(time<Date.parse(period.start)||time>=Date.parse(period.endExclusive))return null;
  const pieces=[raw.content];
  for(const embed of raw.embeds??[]){pieces.push(embed.title,embed.description);for(const field of embed.fields??[])pieces.push(field.name,field.value);pieces.push(embed.footer?.text);}
  if(raw.poll){pieces.push(raw.poll.question?.text);for(const a of raw.poll.answers??[])pieces.push(a.poll_media?.text);}
  const text=pieces.filter(x=>typeof x==='string'&&x.trim()).join('\n');
  ensure(text.length<=20000,'DISCORD_MESSAGE_TOO_LARGE','单条消息内容超过采集保护上限，请人工核对该来源。');
  const bot=raw.author?.bot===true||!!raw.webhook_id;
  const management=bot&&/(?:join.?leave|member.?log|moderation.?log|mod.?log|audit.?log)/i.test(channel.name||'');
  const announcement=channel.type===5||/(?:announcement|^news$|公告)/i.test(channel.name||'');
  const category=management?'management':announcement?'announcement':![0,19].includes(raw.type??0)?'system':bot?'automation':'player';
  return {id:raw.id,guildId:channel.guild_id,channelId:channel.id,channelName:channel.name||'',parentId:channel.parent_id??null,timestamp:new Date(time).toISOString(),editedAt:raw.edited_timestamp??null,author:{id:String(raw.author?.id||''),name:String(raw.author?.global_name||raw.author?.username||'').slice(0,100),bot},category,text,source:`https://discord.com/channels/${channel.guild_id}/${channel.id}/${raw.id}`,replyTo:raw.message_reference?.message_id??null,attachments:(raw.attachments??[]).slice(0,10).map(a=>({name:String(a.filename||'').slice(0,256),url:String(a.url||'').slice(0,2048),type:String(a.content_type||'')})),attachmentCount:(raw.attachments??[]).length,stickerCount:(raw.sticker_items??[]).length};
}
