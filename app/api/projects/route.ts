import {env,json,requireUser,checkOrigin,readJSON,failure} from '../../../server/platform';
import {saveProject} from '../../../server/projects';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{const u=await requireUser(request);const r=await env.DB.prepare('SELECT id,title,updated_at AS updatedAt FROM projects WHERE user_id=? ORDER BY updated_at DESC').bind(u.id).all();return json({projects:r.results});}catch(e){return failure(e);}}
export async function POST(request:Request){try{checkOrigin(request);const u=await requireUser(request);const b=await readJSON(request,8*1024*1024);return json(await saveProject(u.id,b.project,b.id));}catch(e){return failure(e);}}
