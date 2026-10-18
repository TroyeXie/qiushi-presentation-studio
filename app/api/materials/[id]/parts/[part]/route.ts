import {env,json,requireUser,checkOrigin,readBytes,failure} from '../../../../../../server/platform';
import {partSize} from '../../../../../../server/uploads';
export const dynamic='force-dynamic';
export async function PUT(request:Request,{params}:any){try{
  checkOrigin(request);const u=await requireUser(request),{id,part}=await params;
  if(!/^\d{1,2}$/.test(part))return json({error:'上传分块无效。'},400);
  const row=await env.DB.prepare('SELECT bytes,status FROM materials WHERE id=? AND user_id=?').bind(id,u.id).first();
  if(!row)return json({error:'素材不存在。'},404);
  if(row.status!=='uploading')return json({error:'该素材已结束上传，请刷新素材列表。'},409);
  let expected:number;try{expected=partSize(row.bytes,Number(part));}catch{return json({error:'上传分块无效。'},400);}
  const bytes=await readBytes(request,expected);
  if(bytes.length!==expected)return json({error:'分块未完整上传，请重试。'},400);
  const key=`materials/${u.id}/${id}/parts/${Number(part)}`;
  // A retry may acknowledge an existing chunk, but can never replace it.
  const stored=await env.BUCKET.put(key,bytes,{onlyIf:new Headers({'If-None-Match':'*'})});
  const current=await env.DB.prepare('SELECT status FROM materials WHERE id=? AND user_id=?').bind(id,u.id).first();
  if(!current||current.status==='deleting'){
    if(stored)await env.BUCKET.delete(key);
    return json({error:'素材已移除。'},404);
  }
  if(!stored){const existing=await env.BUCKET.head(key);if(!existing||existing.size!==expected)return json({error:'已有分块不完整，请删除素材后重新上传。'},409);}
  return json({uploaded:true,part:Number(part)});
}catch(e){return failure(e);}}
