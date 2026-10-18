import {env,json,requireUser,checkOrigin,failure} from '../../../../server/platform';
import {readProject} from '../../../../server/projects';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:any){try{const u=await requireUser(request);return json({project:await readProject(u.id,(await params).id)});}catch(e){return failure(e);}}
export async function DELETE(request:Request,{params}:any){try{checkOrigin(request);const u=await requireUser(request),{id}=await params;const row=await env.DB.prepare('SELECT object_key FROM projects WHERE id=? AND user_id=?').bind(id,u.id).first();if(!row)return json({error:'项目不存在。'},404);await env.DB.prepare('DELETE FROM projects WHERE id=? AND user_id=?').bind(id,u.id).run();await env.BUCKET.delete(row.object_key);return json({deleted:true});}catch(e){return failure(e);}}
