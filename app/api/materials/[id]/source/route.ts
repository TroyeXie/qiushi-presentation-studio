import {env,json,requireUser,failure} from '../../../../../server/platform';
import {CHUNK_BYTES,MAX_UPLOAD_BYTES,partSize} from '../../../../../server/uploads';
export const dynamic='force-dynamic';

/** Stream one owned original without assembling a 200 MB file in a Worker. */
export async function GET(request:Request,{params}:any){
  try{
    const user=await requireUser(request),{id}=await params;
    const row=await env.DB.prepare('SELECT name,kind,status,bytes FROM materials WHERE id=? AND user_id=?').bind(id,user.id).first();
    if(!row||row.kind!=='pdf'||!['ready','needs_ocr'].includes(row.status))return json({error:'未找到可读取的 PDF 原件。'},404);
    if(!Number.isSafeInteger(row.bytes)||row.bytes<5||row.bytes>MAX_UPLOAD_BYTES)return json({error:'PDF 原件记录无效，请重新上传。'},409);
    const count=Math.ceil(row.bytes/CHUNK_BYTES),prefix=`materials/${user.id}/${id}`;
    let legacy=false;
    for(let i=0;i<count;i++){
      const part=await env.BUCKET.head(`${prefix}/parts/${i}`);
      if(!part||part.size!==partSize(row.bytes,i)){
        const old=await env.BUCKET.head(`${prefix}/source`);
        if(old?.size===row.bytes){legacy=true;break;}
        return json({error:'PDF 原件尚未完整保存。'},409);
      }
    }
    if(legacy){const original=await env.BUCKET.get(`${prefix}/source`);if(!original)return json({error:'PDF 原件已不可用。'},409);
      return new Response(original.body,{headers:{'Content-Type':'application/pdf','Content-Length':String(row.bytes),'Cache-Control':'no-store',
        'X-Content-Type-Options':'nosniff','Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(row.name)}`}});}
    let index=0,reader:ReadableStreamDefaultReader<Uint8Array>|null=null;
    const stream=new ReadableStream<Uint8Array>({
      async pull(controller){
        try{
          for(;;){
            if(!reader){if(index>=count){controller.close();return;}const part=await env.BUCKET.get(`${prefix}/parts/${index++}`);if(!part)throw new Error('Missing source part');reader=part.body.getReader();}
            const active=reader!;
            const chunk=await active.read();
            if(chunk.done){active.releaseLock();reader=null;continue;}
            controller.enqueue(chunk.value);return;
          }
        }catch(error){controller.error(error);}
      },
      async cancel(){await reader?.cancel();reader=null;}
    });
    return new Response(stream,{headers:{'Content-Type':'application/pdf','Content-Length':String(row.bytes),
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(row.name)}`}});
  }catch(error){return failure(error);}
}
