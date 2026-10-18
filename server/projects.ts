import {env,json} from './platform';
import {Core} from './core';
export async function saveProject(userId:string,raw:any,id?:string){
  const project=Core.normalizeProject(raw), now=new Date().toISOString();
  if(id){const row=await env.DB.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').bind(id,userId).first();if(!row)throw json({error:'未找到该项目。'},404);}
  else {const count=await env.DB.prepare('SELECT COUNT(*) AS n FROM projects WHERE user_id=?').bind(userId).first();if(count.n>=100)throw json({error:'项目已达100份，请删除不用的项目后重试。'},400);}
  id=id||crypto.randomUUID();
  // Unique immutable revision keys make object upload independent of DB commit.
  const key=`projects/${userId}/${id}/${crypto.randomUUID()}.json`;
  const old=await env.DB.prepare('SELECT object_key FROM projects WHERE id=? AND user_id=?').bind(id,userId).first();
  await env.BUCKET.put(key,JSON.stringify(project),{httpMetadata:{contentType:'application/json'}});
  try{await env.DB.prepare('INSERT INTO projects (id,user_id,title,object_key,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,object_key=excluded.object_key,updated_at=excluded.updated_at WHERE projects.user_id=excluded.user_id').bind(id,userId,project.title,key,now).run();}
  catch(e){await env.BUCKET.delete(key);throw e;}
  if(old?.object_key)try{await env.BUCKET.delete(old.object_key);}catch{/* The committed revision is authoritative; stale object cleanup must not undo a saved project. */}
  return {id};
}
export async function readProject(userId:string,id:string){
  const row=await env.DB.prepare('SELECT object_key FROM projects WHERE id=? AND user_id=?').bind(id,userId).first();
  if(!row)throw json({error:'未找到该项目。'},404);
  const obj=await env.BUCKET.get(row.object_key);if(!obj)throw json({error:'项目内容暂不可用。'},404);
  return obj.json();
}
