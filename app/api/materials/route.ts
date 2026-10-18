import {env,json,requireUser,checkOrigin,readJSON,failure} from '../../../server/platform';
import {CHUNK_BYTES,MAX_UPLOAD_BYTES,MATERIAL_KINDS} from '../../../server/uploads';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{const u=await requireUser(request);const result=await env.DB.prepare('SELECT id,name,kind,status,message,bytes,text_length AS textLength FROM materials WHERE user_id=? ORDER BY created_at DESC').bind(u.id).all();return json({materials:result.results});}catch(e){return failure(e);}}
export async function POST(request:Request){try{
  checkOrigin(request);const u=await requireUser(request),data=await readJSON(request,4000);
  if(!data||typeof data.name!=='string'||!Number.isSafeInteger(data.size)||data.size<1||data.size>MAX_UPLOAD_BYTES)
    return json({error:'请选择非空文件，单份最高支持200 MB。'},400);
  const name=data.name.replace(/[\u0000-\u001f]/g,'').slice(0,220),kind=name.split('.').pop()?.toLowerCase()||'';
  if(!MATERIAL_KINDS.includes(kind))return json({error:'请上传PDF、DOCX、PPTX、TXT、MD、PNG或JPG。'},400);
  const id=crypto.randomUUID();
  await env.DB.prepare("INSERT INTO materials(id,user_id,name,kind,status,bytes,created_at) VALUES(?,?,?,?,'uploading',?,?)").bind(id,u.id,name,kind,data.size,new Date().toISOString()).run();
  return json({material:{id,name,kind,status:'uploading',message:'正在上传文件。',bytes:data.size,textLength:0},chunkBytes:CHUNK_BYTES});
}catch(e){return failure(e);}}
