// Development-only host simulation. No credentials and no outbound business calls.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const allowed=new Set(['main-view.html','ui.css','ui.js','strings.js','core.js','service.js','main.js','dev/mock-host.js']);
let config={};const files=new Map();const events=[];
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
async function body(req){let s='';for await(const chunk of req){s+=chunk;if(s.length>200000)throw new Error('Request too large');}return s?JSON.parse(s):{};}
export function startPreview(port=0){return new Promise(resolveServer=>{
 const server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1');const path=url.pathname;
  if(path==='/kv'){if(req.method==='GET')return json(res,200,config);config=await body(req);res.writeHead(204);res.end();return;}
  if(path==='/wake')return json(res,200,{state:'running'});
  if(path==='/app-context')return json(res,200,{ok:true,context:{region:'global',locale:'zh-CN'}});
  if(path==='/dev/reset'){config={};files.clear();events.length=0;return json(res,200,{ok:true});}
  if(path==='/dev/events')return json(res,200,events);
  if(path==='/dev/event'){events.push(await body(req));return json(res,200,{ok:true});}
  if(path==='/dev/fs'){const a=await body(req);if(a.op==='read')return json(res,200,files.has(a.path)?{ok:true,content:files.get(a.path)}:{ok:false,message:`文件不存在:${a.path}`});if(a.op==='write'){files.set(a.path,a.content);return json(res,200,{ok:true});}if(a.op==='delete'){files.delete(a.path);return json(res,200,{ok:true});}return json(res,400,{ok:false});}
  const name=path==='/'?'main-view.html':path.slice(1);
  if(!allowed.has(name)){res.writeHead(404);res.end();return;}
  let content=await readFile(resolve(root,name));
  if(name==='main-view.html')content=Buffer.from(content.toString().replace('<head>','<head><script src="/dev/mock-host.js"></script>'));
  const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(name)]||'application/octet-stream';res.writeHead(200,{'Content-Type':mime+'; charset=utf-8','Cache-Control':'no-store'});res.end(content);
 }catch(e){json(res,500,{ok:false,message:e.message});}});
 server.listen(port,'127.0.0.1',()=>resolveServer({server,url:`http://127.0.0.1:${server.address().port}`}));
});}
if(process.argv[1]===fileURLToPath(import.meta.url)){const {url}=await startPreview(Number(process.env.PREVIEW_PORT||41731));process.stdout.write(url+'\n');}
