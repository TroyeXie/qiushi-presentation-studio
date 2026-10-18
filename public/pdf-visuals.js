import {openPdfRenderer, isCompletePdfPage, isCompletePdfAnalysis, saveFigureCrops, PDF_VISION_MAX_PAGES} from './pdf-generation.js?v=20261015-smart27';
const MAX_PAGES = PDF_VISION_MAX_PAGES;
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const lines = value => Array.isArray(value) ? value.filter(x => typeof x === 'string' && x.trim()) : typeof value === 'string' && value.trim() ? [value] : [];

export function parsePageRanges(value, pageCount, maxPages = MAX_PAGES) {
  const limit = Math.min(pageCount, maxPages);
  const tokens = String(value || '').trim().split(/[\s,，;；]+/).filter(Boolean);
  if (!tokens.length) throw new Error('请填写需要读取的页码，例如 1-6, 9。');
  const pages = new Set();
  for (const token of tokens) {
    const match = /^(\d+)(?:[-–—](\d+))?$/.exec(token);
    if (!match) throw new Error('页码格式有误，请使用 1-6, 9 这样的范围。');
    const first = Number(match[1]), last = match[2] ? Number(match[2]) : first;
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last > limit) {
      throw new Error('请选择第 1–' + limit + ' 页以内的有效范围。');
    }
    for (let page = first; page <= last; page++) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

function abortError() {
  const error = new Error('已停止读取，已完成的页面保留。');
  error.name = 'AbortError';
  return error;
}

export function createPdfVisuals(options) {
  const {root, material, request, modelProfileId, modelLabel, modelReady} = options;
  const prefix = '/api/materials/' + encodeURIComponent(material.id);
  const results = new Map();
  let pdfRenderer = null, disposed = false;
  let activeController = null, running = false, inserting = false, loading = true;
  let error = '', progress = '正在载入原始 PDF 与图像读取记录…', range = '', all = true;
  let previewPage = 1, previewUrl = '', previewSequence = 0, previewLoading = false, selectedRegionId = '';
  let pageCount = 0, completed = 0, selectedCount = 0, stopped = false, lastFailures = [];
  const complete = result => isCompletePdfPage(result, modelProfileId || 'platform', result?.compatible !== undefined);
  const cleanSummary = result => ({...result, page:Number(result.page), status:complete(result)?'ready':'failed', findings:lines(result.findings), uncertainties:lines(result.uncertainties)});
  const notifyChange = () => options.onChange?.({pages:[...results.values()].sort((a,b)=>a.page-b.page),pageCount});
  function setBusy(value) { running = value; options.onBusy?.(running || inserting); }
  function finishLoadingError(reason) { error = reason?.message || 'PDF 图像组件未能载入，请关闭后重试。'; loading = false; render(); }
  async function fetchBytes(path, signal) {
    const response = await fetch(path, {credentials:'same-origin', signal});
    if (!response.ok) {
      if (response.status === 401) options.onUnauthorized?.();
      let data = {}; try { data = await response.json(); } catch {}
      throw new Error(typeof data.error === 'string' ? data.error : '原始页面暂时无法读取，请稍后重试。');
    }
    return response;
  }
  function readyCount() { return [...results.values()].filter(r => r.status === 'ready' && r.summary).length; }
  function render() {
    if (disposed) return;
    const ready = readyCount(), readingLimit = Math.min(MAX_PAGES, pageCount), selectedResult = results.get(previewPage);
    const successful = selectedResult?.status === 'ready' && selectedResult.summary;
    const regions = successful ? selectedResult.figureRegions?.filter(region=>region.ready===true) || [] : [];
    if(!regions.some(region=>region.id===selectedRegionId))selectedRegionId=regions[0]?.id || '';
    const state = successful ? 'AI 已读取' : selectedResult?.status === 'failed' ? '读取失败，可重试' : 'AI 尚未读取';
    const resultsHtml = [...results.values()].sort((a,b)=>a.page-b.page).map(result => '<button class="visual-result '+(result.page===previewPage?'active':'')+' '+h(result.status)+'" data-visual-action="page" data-page="'+result.page+'" '+(running||inserting?'disabled':'')+'><span>第 '+result.page+' 页</span><small>'+(result.status==='ready'&&result.summary?'AI 已读取':'读取失败')+'</small></button>').join('');
    root.innerHTML = '<div class="modal-backdrop" data-modal-backdrop="true"><section class="modal pdf-visual-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><div><h2 id="modal-title">PDF 图文详情</h2><p>'+h(material.name)+'</p></div><button class="close-button" data-action="close-modal" aria-label="关闭并停止读取">×</button></header><div class="modal-content">' +
      (loading ? '<div class="empty-state" role="status"><span class="spinner"></span><p>'+h(progress)+'</p></div>' :
       '<p class="visual-intro">点击“生成汇报”时，会自动读取全部 PDF 页面，理解图表、公式、扫描文字与双栏顺序。本窗口用于查看解读、提前读取或重新读取指定页面；识别出的 Figure 会自动裁剪并以清晰原图加入汇报。</p><div class="visual-model-note">当前模型：<strong>'+h(modelLabel)+'</strong>。图像读取需要模型支持图像输入；如额度不足或服务不支持，可换模型后重试。</div>' +
       (pageCount ? '<div class="visual-controls"><div class="visual-range"><label class="visual-all"><input id="visual-all-pages" type="checkbox" '+(all?'checked':'')+' '+(running||inserting||pageCount>MAX_PAGES?'disabled':'')+'>读取全部 '+pageCount+' 页</label><label class="field"><span class="field-label">需要读取的页码</span><input id="visual-page-range" value="'+h(range)+'" placeholder="例如 1-6, 9" '+(running||inserting||all?'disabled':'')+'><p class="hint">这里可提前读取指定页面。生成汇报仍会自动完成全部页面的图文理解。</p></label></div><div class="visual-read-actions"><button class="button primary" data-visual-action="start" '+(running||inserting||!modelReady?'disabled':'')+'>'+(ready?'读取所选未完成页面':'开始读取图像')+'</button>'+(running?'<button class="button" data-visual-action="cancel">停止读取</button>':'')+'<button class="button" data-visual-action="retry" '+(running||inserting||!modelReady||![...results.values()].some(r=>r.status==='failed')?'disabled':'')+'>重试失败页面</button></div></div>'+ (pageCount>MAX_PAGES?'<p class="visual-warning">此 PDF 共 '+pageCount+' 页；当前图像读取支持第 1–'+MAX_PAGES+' 页。第 '+(MAX_PAGES+1)+'–'+pageCount+' 页尚未读取，请拆分文件后补充。</p>':'') : '') +
       (!modelReady?'<p class="visual-warning">当前模型未配置。请先在“管理模型”中添加支持图像输入的模型，再打开此窗口。</p>':'') +
       '<div class="visual-status" role="status" aria-live="polite"><strong>'+h(progress || (ready ? '已读取 '+ready+' 页图像内容。' : '生成汇报时会自动读取全部页面。'))+'</strong>'+(selectedCount?'<span>'+completed+' / '+selectedCount+' 页完成'+(stopped?' · 已停止':'')+'</span>':'')+'</div>'+
       (error?'<p class="visual-error" role="alert">'+h(error)+'</p>':'') +
       (lastFailures.length?'<p class="visual-warning">未完成的页码：'+h(lastFailures.join('、'))+'。可点击“重试失败页面”；已完成页面会保留。</p>':'') +
       (pageCount?'<div class="visual-layout"><section class="visual-preview-section"><div class="visual-preview-toolbar"><label>原始页码 <input id="visual-preview-page" type="number" min="1" max="'+readingLimit+'" value="'+previewPage+'" '+(running||inserting?'disabled':'')+'></label><span>第 '+previewPage+' / '+pageCount+' 页</span></div><div class="visual-preview '+(previewLoading?'loading':'')+'">'+(previewUrl?'<img src="'+h(previewUrl)+'" alt="'+h(material.name)+' 第 '+previewPage+' 页原图">':'<span>'+(previewLoading?'正在提取页面图像…':'页面图像尚未提取')+'</span>')+'</div><p class="visual-preview-state">'+(previewUrl?'图像已提取 · ':'')+h(state)+'</p></section><section class="visual-reading"><div class="visual-reading-header"><h3>'+h(successful?(selectedResult.figureTitle||'本页图像解读'):'本页图像读取')+'</h3><span class="visual-state '+(successful?'ready':selectedResult?.status==='failed'?'failed':'')+'">'+h(state)+'</span></div>'+
         (successful?'<p class="visual-summary">'+h(selectedResult.summary)+'</p>'+(selectedResult.caption?'<div class="visual-detail"><strong>图注</strong><p>'+h(selectedResult.caption)+'</p></div>':'')+(selectedResult.findings?.length?'<div class="visual-detail"><strong>图像中的关键信息</strong><ul>'+selectedResult.findings.map(item=>'<li>'+h(item)+'</li>').join('')+'</ul></div>':'')+(selectedResult.uncertainties?.length?'<div class="visual-detail"><strong>待核对</strong><ul>'+selectedResult.uncertainties.map(item=>'<li>'+h(item)+'</li>').join('')+'</ul></div>':'')+(regions.length?'<label class="field"><span class="field-label">本页 Figure</span><select id="visual-figure-region" '+(running||inserting?'disabled':'')+'>'+regions.map(region=>'<option value="'+h(region.id)+'" '+(region.id===selectedRegionId?'selected':'')+'>'+h(region.title)+'</option>').join('')+'</select></label><button class="button" data-visual-action="insert" '+(running||inserting||!options.canInsert?.()?'disabled':'')+'>'+(inserting?'正在加入…':'将裁剪 Figure 加入当前页')+'</button><p class="hint">裁剪图完整保留坐标、图例与面板，来源页码及图注随讲稿保留。'+(!options.canInsert?.()?'生成初稿后可加入当前页。':'')+'</p>':'<p class="hint">本页没有可插入的 Figure，原始论文页仅供预览。</p>') : '<p>'+(selectedResult?.status==='failed'?h(selectedResult.error || selectedResult.summary || '本页未取得完整图像解读，请重试。'):'生成汇报时将自动完成本页的图文理解。你也可以在这里提前读取，或查看、重试解读结果。')+'</p>') +
         '</section></div><div class="visual-results" aria-label="已处理的页面">'+resultsHtml+'</div>' : '')) + '</div></section></div>';
  }
  async function renderPage(pageNumber, signal) {
    if (!pdfRenderer || disposed || signal?.aborted) throw abortError();
    return pdfRenderer.renderPage(pageNumber, signal);
  }
  async function preview(pageNumber) {
    if (!pdfRenderer || running || inserting || disposed) return;
    const sequence=++previewSequence;previewPage=pageNumber;previewLoading=true;previewUrl='';render();
    try {
      const image=await renderPage(pageNumber);
      if(disposed||sequence!==previewSequence)return;
      previewUrl=image.dataUrl;
    } catch(reason) { if(!disposed&&sequence===previewSequence)error='原页预览未完成：'+(reason.message||'请重试。'); }
    finally { if(!disposed&&sequence===previewSequence){previewLoading=false;render();} }
  }
  async function start(retryOnly=false) {
    if(disposed||running||inserting||loading||!modelReady||!pdfRenderer)return;
    let pages;
    try { pages=retryOnly?[...results.values()].filter(r=>r.status==='failed').map(r=>r.page):all?Array.from({length:pageCount},(_,i)=>i+1):parsePageRanges(range,pageCount); }
    catch(reason){error=reason.message;render();return;}
    pages=pages.filter(page=>page<=MAX_PAGES&&!complete(results.get(page)));
    if(!pages.length){progress='所选页面均已读取。可调整页码范围后继续。';error='';render();return;}
    ++previewSequence;pdfRenderer?.cancelRender();previewLoading=false;
    activeController=new AbortController();const controller=activeController;
    stopped=false;lastFailures=[];selectedCount=pages.length;completed=0;error='';setBusy(true);render();
    try {
      for(const page of pages){
        if(disposed||controller.signal.aborted)throw abortError();
        previewPage=page;previewUrl='';progress='正在提取第 '+page+' 页图像…';render();
        try{
          const image=await renderPage(page,controller.signal),imageBoxes=await pdfRenderer.extractImageBoxes(page,controller.signal);
          if(disposed||controller.signal.aborted)throw abortError();
          previewUrl=image.dataUrl;progress='正在读取第 '+page+' 页图像内容…';render();
          let result=await request(prefix+'/vision',{method:'POST',body:JSON.stringify({page,...image,...(imageBoxes.length?{imageBoxes}:{}),modelProfileId}),signal:controller.signal});
          if(disposed||controller.signal.aborted)throw abortError();
          if(Number(result.page)!==page||!isCompletePdfAnalysis(result,modelProfileId||'platform'))throw new Error('未取得完整的图像解读，本页未标记为已读取。');
          result=await saveFigureCrops({analysis:result,renderer:pdfRenderer,prefix,request,modelProfileId:modelProfileId||'platform',signal:controller.signal,
            onProgress:region=>{progress='正在裁剪第 '+page+' 页 '+region.title+'…';render();}});
          results.set(page,cleanSummary(result));completed++;notifyChange();
        }catch(reason){
          if(disposed||controller.signal.aborted||reason.name==='AbortError')throw abortError();
          results.set(page,{page,status:'failed',error:reason.message||'图像读取未完成，请重试。',summary:'',findings:[],uncertainties:[]});
          lastFailures.push(page);notifyChange();
          if([401,403,404,429,502,503,504].includes(reason.status)){
            error=reason.message+' 已停止后续请求，剩余未开始页面可在服务恢复后继续读取。';
            break;
          }
        }
        render();
      }
      const remaining=pages.length-completed-lastFailures.length;
      progress=lastFailures.length?'本轮读取结束：'+completed+' 页成功，'+lastFailures.length+' 页失败'+(remaining?'，'+remaining+' 页尚未开始':'')+'。':'图像读取完成：本轮 '+completed+' 页均已取得 AI 解读。';
    }catch{
      if(!disposed){stopped=true;progress='已停止读取，已完成页面会保留。';error='未完成页面仍未标记为已读取。停止时正在处理的页面可在重新打开后确认。';}
    }finally{
      if(activeController===controller)activeController=null;setBusy(false);render();options.onCompleted?.();
    }
  }
  async function insert() {
    const result=results.get(previewPage);if(disposed||running||inserting||result?.status!=='ready'||!result.summary)return;
    const region=result.figureRegions?.find(item=>item.id===selectedRegionId&&item.ready===true);if(!region)return;
    inserting=true;options.onBusy?.(true);error='';render();
    try{
      const response=await fetchBytes(prefix+'/vision/image?page='+previewPage+'&regionId='+encodeURIComponent(region.id));
      const blob=await response.blob();if(!/^image\/(png|jpeg)$/.test(blob.type)||blob.size>8*1024*1024)throw new Error('保存的原页图像无效或过大，请重新读取此页。');
      const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('原页图像无法读取。'));reader.readAsDataURL(blob);});
      if(disposed)return;
      await options.onInsert?.({result:{...result,figureTitle:region.title,caption:region.caption,regionId:region.id},dataUrl,width:region.width,height:region.height,material,regionId:region.id});
    }catch(reason){if(!disposed)error=reason.message||'原页加入未完成，请重试。';}
    finally{inserting=false;options.onBusy?.(false);render();}
  }
  const click=event=>{
    const button=event.target.closest('[data-visual-action]');if(!button||button.disabled)return;
    if(button.dataset.visualAction==='start')void start();
    else if(button.dataset.visualAction==='retry')void start(true);
    else if(button.dataset.visualAction==='cancel'){stopped=true;progress='正在停止读取…';activeController?.abort();pdfRenderer?.cancelRender();render();}
    else if(button.dataset.visualAction==='page'){const page=Number(button.dataset.page);if(page>=1&&page<=Math.min(MAX_PAGES,pageCount))void preview(page);}
    else if(button.dataset.visualAction==='insert')void insert();
  };
  const change=event=>{
    if(running||inserting)return;
    if(event.target.id==='visual-figure-region'){selectedRegionId=event.target.value;render();}
    if(event.target.id==='visual-all-pages'){all=event.target.checked;range=all?'1-'+pageCount:range;render();}
    if(event.target.id==='visual-preview-page'){const page=Number(event.target.value);if(Number.isInteger(page)&&page>=1&&page<=Math.min(MAX_PAGES,pageCount))void preview(page);else{error='预览页码须为第 1–'+Math.min(MAX_PAGES,pageCount)+' 页。';render();}}
  };
  const input=event=>{if(event.target.id==='visual-page-range')range=event.target.value;};
  root.addEventListener('click',click);root.addEventListener('change',change);root.addEventListener('input',input);render();
  const initialController=new AbortController();activeController=initialController;
  const ready=(async()=>{
    const outcomes=await Promise.allSettled([
      request(prefix+'/vision?modelProfileId='+encodeURIComponent(modelProfileId || 'platform'),{signal:initialController.signal}),
      openPdfRenderer({material,signal:initialController.signal,onUnauthorized:options.onUnauthorized})
    ]);
    if(disposed){if(outcomes[1].status==='fulfilled')await outcomes[1].value.dispose();return;}
    const saved=outcomes[0];if(saved.status==='fulfilled')for(const result of saved.value?.pages||[]){if(Number.isInteger(Number(result.page))&&Number(result.page)>=1&&Number(result.page)<=MAX_PAGES)results.set(Number(result.page),cleanSummary(result));}
    if(outcomes[1].status==='rejected')throw outcomes[1].reason;
    pdfRenderer=outcomes[1].value;
    pageCount=pdfRenderer.pageCount;all=pageCount<=MAX_PAGES;range=pageCount===1?'1':'1-'+Math.min(pageCount,MAX_PAGES);
    if(saved.status==='rejected')error='已保存的图像读取记录暂时无法载入：'+(saved.reason.message||'请关闭后重试。');
    loading=false;activeController=null;progress=readyCount()?'已读取 '+readyCount()+' 页图像内容。':'点击“生成汇报”时会自动理解全部页面，也可在此提前读取。';notifyChange();render();await preview(1);
  })().catch(reason=>{if(!disposed)finishLoadingError(reason);});
  return {
    ready,
    dispose(){if(disposed)return;disposed=true;++previewSequence;activeController?.abort();pdfRenderer?.cancelRender();void pdfRenderer?.dispose();root.removeEventListener('click',click);root.removeEventListener('change',change);root.removeEventListener('input',input);if(running||inserting)options.onBusy?.(false);previewUrl='';},
    get isBusy(){return running||inserting;}
  };
}
