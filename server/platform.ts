import { DB, BUCKET, durableSecret } from '../runtime/storage';
import { sessionUser } from '../runtime/session';
export const env = { ...process.env, DB, BUCKET,
  MODEL_API_URL: process.env.MODEL_API_URL || 'https://api.deepseek.com/chat/completions',
  MODEL_NAME: process.env.MODEL_NAME || 'deepseek-flash',
  MODEL_CONFIG_ENCRYPTION_KEY: process.env.MODEL_CONFIG_ENCRYPTION_KEY || durableSecret('model-encryption-key') } as any;
export function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
export async function requireUser(request: Request) {
  const user = sessionUser(request);
  if (!user) throw json({error:'工作区连接已过期，请重新连接。'},401);
  return user;
}
export function checkOrigin(request: Request) {
  if(request.headers.get('Origin')!==new URL(request.url).origin) throw json({error:'请求来源不匹配，请刷新页面重试。'},403);
}
export async function readBytes(request: Request, maxBytes: number) {
  const size=Number(request.headers.get('content-length')||0);
  if(size>maxBytes) throw json({error:'请求过大。'},413);
  const reader=request.body?.getReader();
  if(!reader)return new Uint8Array();
  const chunks: Uint8Array[]=[];let n=0;
  for(;;){const {done,value}=await reader.read();if(done)break;n+=value.byteLength;if(n>maxBytes){await reader.cancel();throw json({error:'请求过大。'},413);}chunks.push(value);}
  const out=new Uint8Array(n);let offset=0;for(const c of chunks){out.set(c,offset);offset+=c.length;}return out;
}
export async function readJSON(request:Request,maxBytes=1024*1024) {
  try{return JSON.parse(new TextDecoder().decode(await readBytes(request,maxBytes)));}catch(e){if(e instanceof Response)throw e;throw json({error:'请求格式无效。'},400);}
}
export function failure(error:unknown) {return error instanceof Response?error:json({error:'操作未完成，请稍后重试。'},500);}
export function requireAdmin(request:Request){
  const actual=request.headers.get('X-Qiushi-Admin')||'', expected=env.SITE_ADMIN_TOKEN||'';
  let mismatch=actual.length^expected.length;for(let i=0;i<expected.length;i++)mismatch|=expected.charCodeAt(i)^(actual.charCodeAt(i)||0);
  if(!expected||mismatch)throw json({error:'无权执行此操作。'},403);
}
