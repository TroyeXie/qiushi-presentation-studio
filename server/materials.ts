import {env,json} from './platform';
import {resolveInputChars} from './limits';
import {loadVisualPages,loadFigureRegion,callVisualModel,imageDimensions,parseVisualInput,VISION_LIMITS,VisionError} from './vision';
import {resolveModelConfig,type ResolvedModelConfig} from './model-profiles';
import {isOfficialDeepSeek,platformModelMetadata} from './model-provider';
export function reconstructPdfText(pages:any[]):string {
  return pages.map(page => [`[第 ${page.page} 页]`,page.pageType==='blank'?'[空白页]':page.readingText,
    page.tables?.length ? `[表格：保留行列关系]\n${page.tables.join('\n\n')}` : '',
    page.formulas?.length ? `[公式与页面可见定义]\n${page.formulas.join('\n\n')}` : ''].filter(Boolean).join('\n')).join('\n\n');
}
export async function loadMaterials(userId:string,ids:string[],maxInputChars=resolveInputChars(env.MODEL_MAX_INPUT_CHARS),reservedChars=0,
  selectedModel?:{profileId:string;model:string}){
  if(!Array.isArray(ids)||ids.length<1||new Set(ids).size!==ids.length)throw json({error:'请至少选择一份不同的材料，且不要重复选择。'},400);
  const result=[];let characters=reservedChars;
  const budget=resolveInputChars(maxInputChars),label=budget.toLocaleString('en-US');
  if(!Number.isSafeInteger(reservedChars)||reservedChars<0||reservedChars>budget)throw json({error:'制作要求超过当前输入预算。'},413);
  for(const id of ids){
    if(typeof id!=='string'||!id.trim()||id.length>100)throw json({error:'材料标识无效。'},400);
    const row=await env.DB.prepare('SELECT id,name,kind,status,text_length AS textLength FROM materials WHERE id=? AND user_id=?').bind(id,userId).first();
    if(!row)throw json({error:'未找到所选材料，请重新上传。'},404);
    if(row.status!=='ready'&&!(row.kind==='pdf'&&row.status==='needs_ocr'))throw json({error:'部分材料尚未完成上传或解析，请完成后重试。'},400);
    if(typeof row.name!=='string')throw json({error:'材料名称无效，请重新上传。'},400);
    const totalError=()=>json({error:`所选素材与制作要求合计超过 ${label} 字符，请减少素材或先拆分文件；本次未截断内容。`},413);
    if(characters+row.name.length>budget)throw totalError();
    if(Number.isSafeInteger(row.textLength)&&row.textLength>=0&&characters+row.name.length+row.textLength>budget)throw totalError();
    const data=await env.BUCKET.get(`materials/${userId}/${id}/text.json`);if(!data)throw json({error:'材料内容暂不可用。'},404);
    // R2 records contain only {text}; a UTF-16 unit takes at most six JSON bytes when escaped.
    if(typeof data.size==='number'&&data.size>budget*6+1024)throw json({error:`素材文字记录超过 ${label} 字符对应的读取预算，请拆分后重新上传。`},413);
    const parsed=await data.json();const sourceText=parsed?.text;
    if(typeof sourceText!=='string')throw json({error:'材料文字尚未正确解析，请重新上传。'},400);
    if(sourceText.length>budget)throw json({error:`单份素材文字超过 ${label} 字符，请拆分文件后上传；本次未截断内容。`},413);
    let text=sourceText,visuals:any[]=[],pdfPageCount:number|undefined;
    if(row.kind==='pdf'){
      if(!selectedModel)throw json({error:'PDF 图文识别必须使用当前已授权的生成模型。'},409);
      const pages=await loadVisualPages(userId,id,{requireComplete:true,modelProfileId:selectedModel.profileId,
        modelName:selectedModel.model,maxAnalysisChars:budget-characters-row.name.length});
      pdfPageCount=pages.length;text=reconstructPdfText(pages);
      // The ordered transcription is supplied once as text; visual evidence
      // retains provenance, layout, chart findings and actual ambiguities.
      visuals=pages.map(({readingText,tables,formulas,...visual})=>visual);
    }
    characters+=text.length+row.name.length+(visuals.length?JSON.stringify(visuals).length:0);
    if(characters>budget)throw totalError();
    if(row.kind==='pdf'&&visuals.every(page=>page.pageType==='blank'))throw json({error:'PDF 全部页面均为空白，没有可用于生成汇报的内容。'},400);
    result.push({id,name:row.name,kind:row.kind,text,visuals,...(pdfPageCount?{pdfPageCount,sourceText}:{})});
    if(row.kind==='pdf'&&row.status==='needs_ocr')await env.DB.prepare("UPDATE materials SET status='ready',message='PDF 全部页面已完成图文与版面识别，可继续生成汇报。' WHERE id=? AND user_id=? AND status='needs_ocr'").bind(id,userId).run();
  }return result;
}
/** Hydrate only model-selected, owner-verified Figure crops with original page provenance. */
export async function hydrateProjectImages(userId:string,project:any){
  const cache=new Map<string,any>();
  const encoder=new TextEncoder(),maxBytes=8*1024*1024;
  let projectBytes=encoder.encode(JSON.stringify(project)).length;
  const oversized=()=>json({error:'图像汇报超过 8 MB 保存容量，请减少图文页或缩小页面图像后重新生成。'},413);
  if(projectBytes>maxBytes)throw oversized();
  for(const slide of project.slides){
    if(slide.type!=='figure'||!slide.figureRef)continue;
    const {materialId,page,regionId}=slide.figureRef,key=`${materialId}:${page}:${regionId}`;
    if(typeof regionId!=='string')throw json({error:'论文 Figure 必须使用已完成的图像裁剪区域，请重新生成。'},409);
    let visual=cache.get(key);
    if(!visual){visual=await loadFigureRegion(userId,materialId,page,regionId);if(!visual||visual.status!=='ready')throw json({error:'汇报引用的图像已失效，请再次生成汇报以自动读取。'},409);cache.set(key,visual);}
    const image={dataUrl:visual.dataUrl,width:visual.width,height:visual.height,alt:visual.figureTitle||`素材第 ${page} 页 Figure`};
    const added=encoder.encode(JSON.stringify(image)).length-encoder.encode(JSON.stringify(slide.image)).length;
    if(projectBytes+added>maxBytes)throw oversized();
    projectBytes+=added;slide.image=image;
  }
  return project;
}
export function ocrText(value:any):string {
  const output:string[]=[];
  function visit(v:any,depth=0){
    if(depth>14||!v||typeof v!=='object')return;
    if(typeof v.markdown==='string'){output.push(v.markdown);return;}
    if(typeof v.markdown?.text==='string'){output.push(v.markdown.text);return;}
    if(typeof v.block_content==='string'){output.push(v.block_content);return;}
    if(Array.isArray(v.rec_texts)){output.push(v.rec_texts.filter((s:any)=>typeof s==='string').join('\n'));return;}
    if(typeof v.text==='string'){output.push(v.text);return;}
    for(const [k,item]of Object.entries(v))if(!/image|base64|url|token|key/i.test(k)){if(Array.isArray(item))item.forEach(x=>visit(x,depth+1));else if(typeof item==='object')visit(item,depth+1);}
  }visit(value);return output.join('\n\n').trim();
}
type ImageRecognitionOptions={userId?:string;modelProfileId?:string;model?:ResolvedModelConfig;materialName?:string;signal?:AbortSignal};
export async function recognizeImage(bytes:Uint8Array,maxText=resolveInputChars(env.MODEL_MAX_INPUT_CHARS),options:ImageRecognitionOptions={}){
  const budget=resolveInputChars(maxText);
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>8*1024*1024)
    throw new VisionError('图片需要在 8 MB 以内，请压缩后重新上传。',413);
  const selected=options.model||((options.userId&&(options.modelProfileId&&options.modelProfileId!=='platform'||env.MODEL_API_URL&&env.MODEL_API_KEY))
    ?await resolveModelConfig(options.userId,options.modelProfileId):null);
  if(selected&&isOfficialDeepSeek(selected.apiUrl)){
    if(platformModelMetadata(selected.apiUrl,selected.model).imageInput===false)
      throw new VisionError('当前 DeepSeek 模型不支持图像输入，请选择 deepseek-flash 后重新上传。',400);
    if(bytes.length>VISION_LIMITS.imageBytes)
      throw new VisionError('图片超过当前 1.5 MB 图像读取容量，请压缩后重新上传。',413);
    const mime=bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71?'png':'jpeg';
    const [width,height]=imageDimensions(bytes,mime);
    let encoded='';for(let i=0;i<bytes.length;i+=8192)encoded+=String.fromCharCode(...bytes.subarray(i,i+8192));
    const input=parseVisualInput({page:1,dataUrl:`data:image/${mime};base64,${btoa(encoded)}`,width,height,modelProfileId:selected.profileId});
    const analysis=await callVisualModel(input,'',options.materialName||'上传的图片',selected,fetch,options.signal);
    if(analysis.pageType==='blank')throw new VisionError('图片为空白，没有可用于生成汇报的内容。',400);
    const text=[reconstructPdfText([analysis]),`[图像内容摘要]\n${analysis.summary}`,
      analysis.findings.length?`[图像中的可见结果]\n${analysis.findings.join('\n')}`:'',
      analysis.uncertainties.length?`[具体辨识问题]\n${analysis.uncertainties.join('\n')}`:''].filter(Boolean).join('\n\n');
    if(text.length>budget)throw new VisionError(`图像内容超过 ${budget.toLocaleString('en-US')} 字符，请拆分图片后上传；本次未截断内容。`,413);
    return text;
  }
  if(!env.OCR_API_KEY||env.OCR_INPUT_MODE!=='base64')return null;
  let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  const response=await fetch(env.OCR_API_URL,{method:'POST',headers:{'Authorization':`Bearer ${env.OCR_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({file:btoa(binary)}),signal:AbortSignal.timeout(90000),redirect:'manual'});
  if(!response.ok)throw new Error(`OCR服务暂不可用（HTTP ${response.status}），请上传文字版PDF或TXT。`);
  const raw=await response.text();if(raw.length>4*1024*1024)throw new Error('OCR返回内容过大，请裁分图片后上传。');
  const text=ocrText(JSON.parse(raw));if(!text)throw new Error('OCR未返回可识别文字，请换用清晰图片或文字材料。');
  if(text.length>budget)throw new Error(`OCR文字超过 ${budget.toLocaleString('en-US')} 字符，请拆分材料；本次未截断内容。`);return text;
}
