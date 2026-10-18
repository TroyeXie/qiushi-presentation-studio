/* Generate owns PDF understanding: each original page is rendered and read
 * before the presentation request. Only metadata survives between pages. */
export const PDF_VISION_MAX_PAGES = 300;
const MAX_IMAGE_CHARS = Math.floor(1.5 * 1024 * 1024) - 16384;

export function pdfAbortError() {
  const error = new Error('已停止生成，已完成的材料识别会保留。');
  error.name = 'AbortError';
  return error;
}
const ensureActive = signal => { if (signal?.aborted) throw pdfAbortError(); };
const isPdf = material => material?.kind === 'pdf' || /\.pdf$/i.test(material?.name || '');

export function isCompletePdfAnalysis(page, modelProfileId = 'platform', requireCompatibility = false) {
  return page?.status === 'ready' && page.analysisVersion === 4 &&
    page.modelProfileId === (modelProfileId || 'platform') &&
    typeof page.summary === 'string' && Boolean(page.summary.trim()) &&
    typeof page.readingText === 'string' &&
    (page.pageType === 'blank' || page.pageType === 'content' && Boolean(page.readingText.trim())) &&
    typeof page.layoutNotes === 'string' && Array.isArray(page.tables) && Array.isArray(page.formulas) && Array.isArray(page.figureRegions) &&
    (page.figureRegions.length === 0 || page.cropAlignmentVersion === 2) &&
    (!requireCompatibility || page.compatible === true);
}
export function isCompletePdfPage(page, modelProfileId = 'platform', requireCompatibility = false) {
  return isCompletePdfAnalysis(page,modelProfileId,requireCompatibility) && page.figureRegions.every(region => region.ready === true);
}

export function figurePixelBounds(box, width, height) {
  if (!box || ![box.x,box.y,box.w,box.h].every(Number.isFinite) || box.x < 0 || box.y < 0 || box.w <= .001 || box.h <= .001 ||
    box.x+box.w > 1.000001 || box.y+box.h > 1.000001 || box.w*box.h > .92) throw new Error('Figure 裁剪范围无效，请重新读取此页。');
  const x=Math.floor(box.x*width),y=Math.floor(box.y*height);
  return {x,y,width:Math.min(width,Math.ceil((box.x+box.w)*width))-x,height:Math.min(height,Math.ceil((box.y+box.h)*height))-y};
}

/** Original image XObject transforms provide exact raster Figure boundaries. */
export function pdfImageBoxes(operatorList, viewport, ops) {
  if(!operatorList||!Array.isArray(operatorList.fnArray)||operatorList.fnArray.length>1_000_000||
    !Number.isFinite(viewport?.width)||!Number.isFinite(viewport?.height)||viewport.width<=0||viewport.height<=0)return [];
  const identity=()=>[1,0,0,1,0,0],multiply=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],
    a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
  const matrix=value=>value?.length===6&&Array.from(value).every(Number.isFinite);
  if(!matrix(viewport.transform))return [];
  let ctm=identity();const stack=[],found=[],seen=new Set();
  for(let i=0;i<operatorList.fnArray.length;i++){
    const fn=operatorList.fnArray[i],args=operatorList.argsArray[i] || [];
    if(fn===ops.save)stack.push([...ctm]);
    else if(fn===ops.restore)ctm=stack.pop() || identity();
    else if(fn===ops.transform&&matrix(args))ctm=multiply(ctm,args);
    else if(fn===ops.paintFormXObjectBegin){stack.push([...ctm]);if(matrix(args[0]))ctm=multiply(ctm,args[0]);}
    else if(fn===ops.paintFormXObjectEnd)ctm=stack.pop() || identity();
    else if(fn===ops.paintImageXObject||fn===ops.paintInlineImageXObject){
      const pixelWidth=fn===ops.paintImageXObject?args[1]:args[0]?.width,pixelHeight=fn===ops.paintImageXObject?args[2]:args[0]?.height;
      if(!Number.isInteger(pixelWidth)||!Number.isInteger(pixelHeight)||pixelWidth<1||pixelHeight<1||pixelWidth>100_000||pixelHeight>100_000)continue;
      const m=multiply(viewport.transform,ctm),xs=[m[4],m[0]+m[4],m[2]+m[4],m[0]+m[2]+m[4]],ys=[m[5],m[1]+m[5],m[3]+m[5],m[1]+m[3]+m[5]];
      const x=Math.max(0,Math.min(...xs)/viewport.width),y=Math.max(0,Math.min(...ys)/viewport.height),right=Math.min(1,Math.max(...xs)/viewport.width),bottom=Math.min(1,Math.max(...ys)/viewport.height);
      if(![x,y,right,bottom].every(Number.isFinite)||right<=x||bottom<=y)continue;
      const box={x,y,w:right-x,h:bottom-y},key=[x,y,right,bottom].map(value=>value.toFixed(6)).join(':');
      if(!seen.has(key)){seen.add(key);found.push({box,pixelWidth,pixelHeight});}
    }
  }
  return found.sort((a,b)=>b.box.w*b.box.h-a.box.w*a.box.h).slice(0,32);
}

export async function saveFigureCrops({analysis,renderer,prefix,request,modelProfileId='platform',signal,onProgress}) {
  let result=analysis;
  for(const region of analysis.figureRegions || []) {
    ensureActive(signal);if(region.ready===true)continue;
    onProgress?.(region);
    if(typeof renderer.renderRegion!=='function')throw new Error('PDF Figure 裁剪组件未载入，请刷新后重新生成。');
    const cropped=await renderer.renderRegion(analysis.page,region.box,signal);ensureActive(signal);
    result=await request(prefix+'/vision',{method:'POST',body:JSON.stringify({action:'save-crop',page:analysis.page,regionId:region.id,
      analysisUpdatedAt:analysis.updatedAt,modelProfileId,...cropped}),signal});
    ensureActive(signal);
    if(!isCompletePdfAnalysis(result,modelProfileId)||result.page!==analysis.page||result.updatedAt!==analysis.updatedAt||
      !result.figureRegions.some(item=>item.id===region.id&&item.ready===true))throw new Error('Figure 裁剪结果未完整保存，请重试。');
  }
  if(!isCompletePdfPage(result,modelProfileId))throw new Error('Figure 裁剪尚未完成，本页未标记为可用于生成。');
  return result;
}

/** Shared by automatic generation and the optional page-details window. */
export async function openPdfRenderer(options) {
  const {material, signal, onUnauthorized} = options;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const loadLibrary = options.loadLibrary || (() => import('/vendor/pdfjs.mjs'));
  const createCanvas = options.createCanvas || (() => document.createElement('canvas'));
  const local = new AbortController();
  let documentTask = null, pdf = null, renderTask = null, disposed = false, destroyPromise = null;
  const destroyDocument = () => {
    if (!documentTask) return Promise.resolve();
    if (!destroyPromise) destroyPromise = Promise.resolve().then(() => documentTask?.destroy?.());
    return destroyPromise;
  };
  const cancel = () => { local.abort(); renderTask?.cancel(); void destroyDocument().catch(() => {}); };
  signal?.addEventListener('abort', cancel, {once:true});
  if (signal?.aborted) cancel();
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', cancel);
    local.abort(); renderTask?.cancel();
    await destroyDocument().catch(() => {});
    documentTask = null; pdf = null; renderTask = null;
  };
  try {
    ensureActive(local.signal);
    const outcomes = await Promise.allSettled([
      (async () => {
        const response = await fetchImpl('/api/materials/' + encodeURIComponent(material.id) + '/source',
          {credentials:'same-origin', signal:local.signal});
        if (!response.ok) {
          if (response.status === 401) onUnauthorized?.();
          let data = {}; try { data = await response.json(); } catch {}
          const error = new Error(typeof data.error === 'string' ? data.error : 'PDF 原文件暂时无法载入，请稍后重新生成。');
          error.status = response.status;
          throw error;
        }
        return response.arrayBuffer();
      })(),
      loadLibrary()
    ]);
    ensureActive(local.signal);
    if (outcomes[0].status === 'rejected') throw outcomes[0].reason;
    if (outcomes[1].status === 'rejected') throw new Error('PDF 页面组件未能载入，请刷新页面后重新生成。');
    const bytes = new Uint8Array(outcomes[0].value), library = outcomes[1].value;
    if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') throw new Error('保存的原文件不是有效 PDF，请重新上传。');
    if (library.GlobalWorkerOptions) library.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs-worker.mjs';
    documentTask = library.getDocument({data:bytes, isEvalSupported:false, useSystemFonts:true,
      stopAtErrors:true, isOffscreenCanvasSupported:false, isImageDecoderSupported:false});
    pdf = await documentTask.promise;
    ensureActive(local.signal);
    if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1) throw new Error('PDF 没有可读取的页面，请重新导出后上传。');
    return {
      pageCount:pdf.numPages,
      async extractImageBoxes(pageNumber,pageSignal=signal){
        ensureActive(local.signal);ensureActive(pageSignal);if(disposed)throw pdfAbortError();let page=null;
        try{page=await pdf.getPage(pageNumber);const operators=await page.getOperatorList();ensureActive(local.signal);ensureActive(pageSignal);
          return pdfImageBoxes(operators,page.getViewport({scale:1}),library.OPS || {});
        }catch(error){if(disposed||local.signal.aborted||pageSignal?.aborted)throw pdfAbortError();return [];}
        finally{page?.cleanup();}
      },
      async renderPage(pageNumber, pageSignal = signal, renderOptions = {}) {
        ensureActive(local.signal); ensureActive(pageSignal);
        if (disposed) throw pdfAbortError();
        const maxEdge=renderOptions.maxEdge ?? 1800;
        if(!Number.isFinite(maxEdge)||maxEdge<1||maxEdge>3840)throw new Error('PDF 页面渲染分辨率无效。');
        let page = null, canvas = null, smaller = null;
        try {
          page = await pdf.getPage(pageNumber);
          ensureActive(local.signal); ensureActive(pageSignal);
          const unit = page.getViewport({scale:1});
          if (![unit.width, unit.height].every(value => Number.isFinite(value) && value > 0))
            throw new Error('本页尺寸无效，请重新导出 PDF 后上传。');
          const scale = Math.min(maxEdge / Math.max(unit.width, unit.height), maxEdge>1800?6:3);
          const viewport = page.getViewport({scale});
          canvas = createCanvas();
          canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height));
          if(canvas.width>4096||canvas.height>4096||canvas.width*canvas.height>16_000_000)
            throw new Error('PDF 页面像素尺寸超出处理容量。');
          const context = canvas.getContext('2d', {alpha:false});
          if (!context) throw new Error('浏览器无法渲染 PDF 页面，请更换支持 Canvas 的浏览器。');
          context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
          const task = page.render({canvasContext:context, viewport, background:'#ffffff'});
          renderTask = task;
          const stop = () => task.cancel();
          local.signal.addEventListener('abort', stop, {once:true});
          pageSignal?.addEventListener('abort', stop, {once:true});
          try { await task.promise; }
          finally {
            local.signal.removeEventListener('abort', stop); pageSignal?.removeEventListener('abort', stop);
            if (renderTask === task) renderTask = null;
          }
          ensureActive(local.signal); ensureActive(pageSignal);
          if (disposed) throw pdfAbortError();
          let dataUrl = '';
          for (const quality of [.88, .78, .68, .58, .48]) {
            dataUrl = canvas.toDataURL('image/jpeg', quality);
            if (dataUrl.length <= MAX_IMAGE_CHARS) break;
          }
          if (dataUrl.length > MAX_IMAGE_CHARS) {
            smaller = createCanvas();
            smaller.width = Math.max(1, Math.round(canvas.width * .8)); smaller.height = Math.max(1, Math.round(canvas.height * .8));
            const smallContext = smaller.getContext('2d', {alpha:false});
            if (!smallContext) throw new Error('浏览器无法压缩 PDF 页面，请更换浏览器后重新生成。');
            smallContext.drawImage(canvas, 0, 0, smaller.width, smaller.height);
            dataUrl = smaller.toDataURL('image/jpeg', .6);
            if (dataUrl.length > MAX_IMAGE_CHARS) throw new Error('本页图像压缩后仍超出读取容量，请拆分或降低 PDF 图像分辨率后重新上传。');
            return {dataUrl, width:smaller.width, height:smaller.height};
          }
          if (!/^data:image\/jpeg;base64,/.test(dataUrl)) throw new Error('本页图像未能导出，请重新生成。');
          return {dataUrl, width:canvas.width, height:canvas.height};
        } catch (error) {
          if (disposed || local.signal.aborted || pageSignal?.aborted) throw pdfAbortError();
          throw error;
        } finally {
          if (canvas) canvas.width = canvas.height = 0;
          if (smaller) smaller.width = smaller.height = 0;
          page?.cleanup();
        }
      },
      async renderRegion(pageNumber, box, pageSignal = signal) {
        ensureActive(local.signal);ensureActive(pageSignal);
        if(disposed)throw pdfAbortError();
        let page=null,canvas=null;
        try {
          page=await pdf.getPage(pageNumber);ensureActive(local.signal);ensureActive(pageSignal);
          const unit=page.getViewport({scale:1});
          figurePixelBounds(box,unit.width,unit.height);
          if(![unit.width,unit.height].every(value=>Number.isFinite(value)&&value>0))throw new Error('PDF 页面尺寸无效，无法裁剪 Figure。');
          // Render the source PDF directly into a small translated canvas. A
          // small Figure on a mostly empty page retains vector/text detail;
          // no huge whole-page pixel buffer is ever created.
          const scale=Math.min(2000/Math.max(unit.width*box.w,unit.height*box.h),12);
          const viewport=page.getViewport({scale}),pixels=figurePixelBounds(box,viewport.width,viewport.height);
          canvas=createCanvas();canvas.width=pixels.width;canvas.height=pixels.height;
          if(canvas.width<1||canvas.height<1||canvas.width>4096||canvas.height>4096||canvas.width*canvas.height>16_000_000)
            throw new Error('Figure 区域像素尺寸超出处理容量，请重新读取此页。');
          const context=canvas.getContext('2d',{alpha:false});if(!context)throw new Error('浏览器无法裁剪 PDF Figure，请使用支持 Canvas 的浏览器。');
          context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
          const task=page.render({canvasContext:context,viewport,transform:[1,0,0,1,-pixels.x,-pixels.y],background:'#ffffff'});
          renderTask=task;const stop=()=>task.cancel();local.signal.addEventListener('abort',stop,{once:true});pageSignal?.addEventListener('abort',stop,{once:true});
          try {await task.promise;}finally {local.signal.removeEventListener('abort',stop);pageSignal?.removeEventListener('abort',stop);if(renderTask===task)renderTask=null;}
          ensureActive(local.signal);ensureActive(pageSignal);if(disposed)throw pdfAbortError();
          let dataUrl=canvas.toDataURL('image/png');
          if(dataUrl.length>MAX_IMAGE_CHARS)for(const quality of [.94,.88,.8,.7]){dataUrl=canvas.toDataURL('image/jpeg',quality);if(dataUrl.length<=MAX_IMAGE_CHARS)break;}
          if(!/^data:image\/(png|jpeg);base64,/.test(dataUrl)||dataUrl.length>MAX_IMAGE_CHARS)
            throw new Error('Figure 裁剪图像仍超过保存容量，请拆分或压缩原图后重新上传。');
          return {dataUrl,width:canvas.width,height:canvas.height};
        }catch(error){if(disposed||local.signal.aborted||pageSignal?.aborted)throw pdfAbortError();throw error;}
        finally{if(canvas)canvas.width=canvas.height=0;page?.cleanup();}
      },
      cancelRender() { renderTask?.cancel(); },
      dispose
    };
  } catch (error) {
    const aborted = local.signal.aborted || signal?.aborted;
    try { await dispose(); } catch {}
    if (aborted) throw pdfAbortError();
    throw error;
  }
}

export class PdfPreparationError extends Error {
  constructor(material, page, cause) {
    const location = page ? '第 ' + page + ' 页' : '原文件';
    super('“' + material.name + '”' + location + '读取未完成：' + (cause?.message || '请稍后重新生成。') +
      ' 已完成的页面会保留；问题解决后再次点击“生成汇报”即可继续。');
    this.name = 'PdfPreparationError'; this.materialId = material.id; this.page = page || null;
    if (cause?.status) this.status = cause.status;
    this.cause = cause;
  }
}

export async function preparePdfMaterials(options) {
  const {materials, request, signal, onProgress, onChange, onUnauthorized} = options;
  const modelProfileId = options.modelProfileId || 'platform';
  const openPdf = options.openPdf || openPdfRenderer;
  let unauthorizedNotified = false;
  const unauthorized = () => { if (!unauthorizedNotified) { unauthorizedNotified = true; onUnauthorized?.(); } };
  const completed = {pdfs:[], readPages:0, reusedPages:0, totalPages:0};
  for (const material of (materials || []).filter(isPdf)) {
    ensureActive(signal);
    let renderer = null, currentPage = 0;
    const update = (phase, page, pageCount, count, message) => onProgress?.({phase, materialId:material.id,
      materialName:material.name, page, pageCount, completed:count, message});
    try {
      if (!['ready', 'needs_ocr'].includes(material.status)) throw new Error('PDF 尚未上传或解析完成，请等待完成后重新生成。');
      update('pdf-loading', 0, 0, 0, '正在准备“' + material.name + '”的图文内容…');
      const prefix = '/api/materials/' + encodeURIComponent(material.id);
      const saved = await request(prefix + '/vision?modelProfileId=' + encodeURIComponent(modelProfileId), {signal});
      ensureActive(signal);
      renderer = await openPdf({material, signal, onUnauthorized:unauthorized});
      ensureActive(signal);
      const pageCount = renderer.pageCount;
      if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('PDF 页数无效，请重新上传。');
      if (pageCount > PDF_VISION_MAX_PAGES) throw new Error('PDF 共 ' + pageCount + ' 页，超过当前 ' + PDF_VISION_MAX_PAGES + ' 页处理范围，请按章节拆分后上传。');
      if (Number(saved?.pageCount) !== pageCount) throw new Error('PDF 页码记录与原文件不一致，请重新上传。');
      completed.totalPages += pageCount;
      const results = new Map((saved?.pages || []).filter(page => Number.isInteger(page.page) && page.page >= 1 && page.page <= pageCount).map(page => [page.page, page]));
      const notify = () => onChange?.(material.id, {pages:[...results.values()].sort((a, b) => a.page - b.page), pageCount});
      for (let page = 1; page <= pageCount; page++) {
        currentPage = page; ensureActive(signal);
        if (isCompletePdfPage(results.get(page), modelProfileId, true)) {
          completed.reusedPages++;
          update('pdf-reused', page, pageCount, page, '已复用“' + material.name + '”第 ' + page + ' / ' + pageCount + ' 页的完整图文解读。');
          continue;
        }
        update('pdf-rendering', page, pageCount, page - 1, '正在准备“' + material.name + '”第 ' + page + ' / ' + pageCount + ' 页…');
        let rendered = null;
        try {
          rendered = await renderer.renderPage(page, signal);
          const imageBoxes=await renderer.extractImageBoxes?.(page,signal);
          if(imageBoxes?.length)rendered={...rendered,imageBoxes};
          ensureActive(signal);
          update('pdf-reading', page, pageCount, page - 1, '正在理解“' + material.name + '”第 ' + page + ' / ' + pageCount + ' 页的文字、图表与版面…');
          let result;
          try {
            result=await request(prefix + '/vision', {method:'POST', body:JSON.stringify({page, ...rendered, modelProfileId}), signal});
          }catch(error){
            ensureActive(signal);
            if(error?.name==='AbortError'||error?.status!==502||typeof error.message!=='string'||!error.message.includes('图像结果达到输出上限'))throw error;
            update('pdf-rereading',page,pageCount,page-1,'正在清晰重读“'+material.name+'”第 '+page+' / '+pageCount+' 页的密集内容…');
            // Render the original PDF again; never enlarge the previous JPEG.
            // Only this explicit server output-limit failure permits one retry.
            rendered=null;
            rendered=await renderer.renderPage(page,signal,{maxEdge:3840});
            if(imageBoxes?.length)rendered={...rendered,imageBoxes};
            ensureActive(signal);
            result=await request(prefix+'/vision',{method:'POST',body:JSON.stringify({page,...rendered,modelProfileId}),signal});
          }
          ensureActive(signal);
          if (Number(result?.page) !== page || !isCompletePdfAnalysis(result, modelProfileId))
            throw new Error('模型未返回完整的文字顺序、图表或公式解读，本页未标记为完成。');
          result=await saveFigureCrops({analysis:result,renderer,prefix,request,modelProfileId,signal,
            onProgress:region=>update('pdf-cropping',page,pageCount,page-1,'正在裁剪“'+material.name+'”第 '+page+' 页 '+region.title+'…')});
          results.set(page, {...result, compatible:true});
          completed.readPages++; notify();
        } catch (error) {
          if (!signal?.aborted && error?.name !== 'AbortError') {
            results.set(page, {page, status:'failed', summary:'', error:error?.message || '本页图文理解未完成，请重新生成。'});
            notify();
          }
          throw error;
        } finally { rendered = null; }
      }
      currentPage = 0; notify();
      completed.pdfs.push({materialId:material.id, pageCount, pages:[...results.values()].sort((a, b) => a.page - b.page)});
      update('pdf-ready', pageCount, pageCount, pageCount, '“' + material.name + '”全部 ' + pageCount + ' 页图文理解完成。');
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw pdfAbortError();
      if (error?.status === 401) unauthorized();
      throw new PdfPreparationError(material, currentPage, error);
    } finally { try { await renderer?.dispose(); } catch {} }
  }
  return completed;
}
