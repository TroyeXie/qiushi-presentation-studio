import {env,json,requireUser,failure} from '../../../../../server/platform';
export const dynamic='force-dynamic';
const PREVIEW_PART_BYTES=4*1024*1024;
export function restrictedPreviewManifest(meta:any){
 return meta?.readOnly===true&&meta.encryption==='AES-256'&&meta.permissions===0&&
  meta.mime==='application/pdf'&&/^[a-f0-9]{64}$/i.test(meta.sha256||'')&&
  Number.isInteger(meta.parts)&&meta.parts>=1&&meta.parts<=50&&
  Number.isSafeInteger(meta.size)&&meta.size>0&&meta.size<=200*1024*1024&&
  meta.partBytes===PREVIEW_PART_BYTES&&meta.parts===Math.ceil(meta.size/PREVIEW_PART_BYTES);
}
export async function GET(request:Request,{params}:any){
 try{
  await requireUser(request);const {id,asset}=await params;
  if(!['course','journal','green-space'].includes(id)||!['thumbnail','preview'].includes(asset))return json({error:'样片不存在。'},404);
  const prefix=asset==='preview'?`samples/${id}/preview-readonly`:`samples/${id}/${asset}`;
  const record=await env.BUCKET.get(`${prefix}/manifest.json`);
  if(!record)return json({error:'样片尚未发布。'},404);const meta:any=await record.json();
  if(asset==='preview'&&!restrictedPreviewManifest(meta))return json({error:'样片尚未完成只读保护，请稍后重试。'},409);
  let part=0,reader:ReadableStreamDefaultReader|undefined;
  const body=new ReadableStream({
   async pull(controller){
    try{
     while(true){
      if(!reader){
       if(part>=meta.parts){controller.close();return;}
       const key=asset==='preview'?`${prefix}/${meta.sha256}/${part++}`:`${prefix}/${part++}`;
       const obj=await env.BUCKET.get(key);
       if(!obj)throw new Error('missing');reader=obj.body.getReader();
      }
      const result=await reader!.read();if(result.done){reader=undefined;continue;}
      controller.enqueue(result.value);return;
     }
    }catch{controller.error(new Error('样片读取失败。'));}
   },
   async cancel(){await reader?.cancel();}
  });
  return new Response(body,{headers:{'Content-Type':meta.mime,'Content-Length':String(meta.size),
   'Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
   'Cache-Control':asset==='preview'?'private, no-store':'private, max-age=300','X-Content-Type-Options':'nosniff',
   ...(asset==='preview'?{'X-Qiushi-Read-Only':'1'}:{})}});
 }catch(error){return failure(error);}
}
