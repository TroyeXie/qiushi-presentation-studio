import {env,json,requireUser,checkOrigin,readJSON} from '../../../../../server/platform';
import {CHUNK_BYTES,partSize,storedSource} from '../../../../../server/uploads';
import {extractStoredMaterial} from '../../../../../server/extract';
import {recognizeImage} from '../../../../../server/materials';
import {MAX_INPUT_CHARS,resolveInputChars} from '../../../../../server/limits';
import {resolveModelConfig} from '../../../../../server/model-profiles';
import {validateBrowserPdf} from '../../../../../server/browser-pdf';
export const dynamic='force-dynamic';
export async function POST(request:Request,{params}:any){
  let uid='',id='',started=false;
  try{
    checkOrigin(request);const user=await requireUser(request);uid=user.id;({id}=await params);
    const row=await env.DB.prepare('SELECT name,kind,status,bytes FROM materials WHERE id=? AND user_id=?').bind(id,uid).first();
    if(!row)return json({error:'素材不存在。'},404);
    if(row.status!=='uploading')return json({error:'素材已在处理或已处理完成，请刷新列表。'},409);
    const body=request.body?await readJSON(request,MAX_INPUT_CHARS*6+20000):{};
    if(!body||typeof body!=='object'||Array.isArray(body))return json({error:'素材请求格式无效。'},400);
    const selectedModel=body.modelProfileId&&body.modelProfileId!=='platform'
      ?await resolveModelConfig(uid,body.modelProfileId):undefined;
    const maxText=selectedModel?.inputChars||resolveInputChars(env.MODEL_MAX_INPUT_CHARS);
    if(body.clientExtraction&&(row.kind!=='pdf'||row.bytes<=32*1024*1024))return json({error:'此素材无需浏览器PDF提取。'},400);
    const browserResult=body.clientExtraction?validateBrowserPdf(body.clientExtraction,maxText):null;
    const prefix=`materials/${uid}/${id}`;
    for(let i=0;i<Math.ceil(row.bytes/CHUNK_BYTES);i++){
      const part=await env.BUCKET.head(`${prefix}/parts/${i}`);
      if(!part||part.size!==partSize(row.bytes,i))return json({error:'文件尚未完整上传，请删除后重新上传。'},400);
    }
    const lock=await env.DB.prepare("UPDATE materials SET status='processing',message='正在提取素材内容。' WHERE id=? AND user_id=? AND status='uploading'").bind(id,uid).run();
    if(!lock.meta.changes)return json({error:'素材正在处理，请稍后刷新。'},409);
    started=true;
    const source=storedSource(env.BUCKET,prefix,row.bytes);
    if(browserResult&&new TextDecoder().decode(await source.readRange(0,5))!=='%PDF-')throw new Error('文件内容不是PDF，请重新上传。');
    const parsed=browserResult||await extractStoredMaterial(source,row.name,{maxText});
    if(parsed.status==='needs_ocr'&&['png','jpg','jpeg'].includes(row.kind)){
      if(row.bytes>8*1024*1024)parsed.message='图片原件已保存；识别前请将图片压缩到8 MB以内。原图也可在生成后的页面中添加。';
      else{
        const text=await recognizeImage(await source.readRange(0,row.bytes),maxText,{userId:uid,modelProfileId:body.modelProfileId||'platform',
          model:selectedModel,materialName:row.name,signal:request.signal});
        if(text){parsed.text=text;parsed.status='ready';parsed.message='图片内容已读取，文字、图表、公式与表格将参与汇报生成。';}
        else parsed.message='图片原件已保存；当前模型未提供可用的图片识别服务。请选择支持图像输入的模型后重新上传。';
      }
    }
    await env.BUCKET.put(`${prefix}/text.json`,JSON.stringify({text:parsed.text}));
    const updated=await env.DB.prepare("UPDATE materials SET status=?,message=?,text_length=? WHERE id=? AND user_id=? AND status='processing'").bind(parsed.status,parsed.message||'',parsed.text.length,id,uid).run();
    if(!updated.meta.changes){await env.BUCKET.delete(`${prefix}/text.json`);return json({error:'素材已移除。'},404);}
    return json({material:{id,name:row.name,kind:row.kind,bytes:row.bytes,status:parsed.status,message:parsed.message||'',textLength:parsed.text.length}});
  }catch(e){
    if(e instanceof Response)return e;
    const message=e instanceof Error&&!/fetch|network|parse JSON|Unexpected|SQL|D1|R2/i.test(e.message)?e.message:'素材原件已保存，但内容解析未完成，请检查格式或压缩后重新上传。';
    if(started&&uid&&id)await env.DB.prepare("UPDATE materials SET status='failed',message=? WHERE id=? AND user_id=? AND status='processing'").bind(message,id,uid).run();
    const status=e instanceof Error&&'status' in e&&typeof e.status==='number'&&Number.isInteger(e.status)&&e.status>=400&&e.status<=599?e.status:400;
    return json({error:message},status);
  }
}
