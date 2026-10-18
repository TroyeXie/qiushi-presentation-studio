/* Sample PDFs have actual PDF permission restrictions. This viewer deliberately
 * renders canvas only: it has no text layer, editing, printing or export tools.
 * These controls cannot prevent screenshots or bypasses outside the viewer. */
export function isRestrictedPdfPermissions(permissions) {
  return Array.isArray(permissions) && permissions.length === 0;
}

export function createSampleViewer({root, sample, onBack, onUnauthorized, loadLibrary, fetchImpl} = {}) {
  const abort = new AbortController();
  const fetchPdf = fetchImpl || globalThis.fetch;
  let disposed = false, task = null, pdf = null, renderTask = null;
  let currentPage = 1, renderSequence = 0, resizeTimer = null;
  root.innerHTML = '<section class="sample-reader" aria-label="只读 PDF 样片"><header class="sample-reader-heading"><button class="button small" data-sample-back>← 返回样片</button><div><h2></h2><span>只读预览</span></div></header><div class="sample-reader-toolbar"><button class="button small" data-sample-previous disabled>上一页</button><label>第 <input data-sample-page type="number" min="1" step="1" value="1" aria-label="样片页码" disabled> / <span data-sample-total>—</span> 页</label><button class="button small" data-sample-next disabled>下一页</button></div><p class="sample-reader-status" role="status" aria-live="polite">正在载入样片…</p><div class="sample-reader-stage" tabindex="0" aria-label="样片页面，使用左右方向键翻页"><canvas aria-label="样片 PDF 页面"></canvas></div></section>';
  root.querySelector('h2').textContent = sample.title;
  const stage = root.querySelector('.sample-reader-stage'), canvas = root.querySelector('canvas');
  const previous = root.querySelector('[data-sample-previous]'), next = root.querySelector('[data-sample-next]');
  const input = root.querySelector('[data-sample-page]'), total = root.querySelector('[data-sample-total]');
  const status = root.querySelector('.sample-reader-status');
  const active = () => !disposed && !abort.signal.aborted;
  const showError = error => {
    if (!active()) return;
    status.setAttribute('role','alert');status.textContent = error.message || '样片暂时无法读取，请返回后重试。';
  };
  const updateControls = () => {
    previous.disabled = !pdf || currentPage <= 1;
    next.disabled = !pdf || currentPage >= pdf.numPages;
    input.disabled = !pdf;input.value = String(currentPage);
  };
  async function renderPage(number) {
    if (!active() || !pdf) return;
    const sequence = ++renderSequence;
    currentPage = Math.max(1,Math.min(pdf.numPages,Math.trunc(Number(number)) || currentPage));
    renderTask?.cancel();renderTask = null;updateControls();
    status.setAttribute('role','status');status.textContent = '正在显示第 '+currentPage+' 页…';
    let page = null;
    try {
      page = await pdf.getPage(currentPage);
      if (!active() || sequence !== renderSequence) return;
      const natural = page.getViewport({scale:1});
      const availableWidth = Math.max(160,stage.clientWidth - 32);
      const cssScale = Math.min(availableWidth / natural.width, 2);
      const density = Math.min(globalThis.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({scale:cssScale * density});
      canvas.width = Math.ceil(viewport.width);canvas.height = Math.ceil(viewport.height);
      canvas.style.width = (viewport.width / density)+'px';canvas.style.height = (viewport.height / density)+'px';
      canvas.setAttribute('aria-label','样片第 '+currentPage+' 页，共 '+pdf.numPages+' 页');
      renderTask = page.render({canvasContext:canvas.getContext('2d',{alpha:false}),viewport});
      await renderTask.promise;
      if (active() && sequence === renderSequence) status.textContent = '第 '+currentPage+' 页，共 '+pdf.numPages+' 页';
    } catch (error) {
      if (error.name !== 'RenderingCancelledException' && sequence === renderSequence) showError(error);
    } finally { page?.cleanup(); }
  }
  const stopContentAction = event => event.preventDefault();
  const back = () => onBack?.();
  const prevPage = () => void renderPage(currentPage - 1);
  const nextPage = () => void renderPage(currentPage + 1);
  const inputPage = () => void renderPage(input.value);
  const keyPage = event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {event.preventDefault();void renderPage(currentPage + (event.key === 'ArrowRight' ? 1 : -1));}
  };
  root.querySelector('[data-sample-back]').addEventListener('click',back);
  previous.addEventListener('click',prevPage);next.addEventListener('click',nextPage);input.addEventListener('change',inputPage);
  stage.addEventListener('keydown',keyPage);
  for (const action of ['contextmenu','dragstart','copy','selectstart']) stage.addEventListener(action,stopContentAction);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (!pdf || !active()) return;
    clearTimeout(resizeTimer);resizeTimer = setTimeout(() => void renderPage(currentPage),120);
  }) : null;
  observer?.observe(stage);
  const ready = (async () => {
    try {
      const [response,library] = await Promise.all([
        fetchPdf('/api/samples/'+encodeURIComponent(sample.id)+'/preview',{credentials:'same-origin',cache:'no-store',signal:abort.signal}),
        (loadLibrary || (() => import('/vendor/pdfjs.mjs')))()
      ]);
      if (!active()) return;
      if (!response.ok) {
        if (response.status === 401) onUnauthorized?.();
        let result={};try{result=await response.json();}catch{}
        throw new Error(result.error || '样片暂时无法读取，请返回后重试。');
      }
      const data = new Uint8Array(await response.arrayBuffer());if (!active()) return;
      if (String.fromCharCode(...data.subarray(0,5)) !== '%PDF-') throw new Error('样片文件格式异常。');
      if (library.GlobalWorkerOptions) library.GlobalWorkerOptions.workerSrc='/vendor/pdfjs-worker.mjs';
      task=library.getDocument({data,password:'',isEvalSupported:false,useSystemFonts:true,
        stopAtErrors:true,isOffscreenCanvasSupported:false,isImageDecoderSupported:false});
      const loaded=await task.promise;
      if (!active()) return;
      if (!isRestrictedPdfPermissions(await loaded.getPermissions())) throw new Error('样片尚未完成只读保护，请稍后重试。');
      if (!active()) return;
      if (!Number.isInteger(loaded.numPages) || loaded.numPages<1) throw new Error('样片没有可显示的页面。');
      pdf=loaded;
      total.textContent=String(pdf.numPages);input.max=String(pdf.numPages);
      await renderPage(1);
    } catch (error) { if (error.name !== 'AbortError') showError(error); }
  })();
  return {ready,dispose(){
    if (disposed) return;disposed=true;abort.abort();++renderSequence;
    clearTimeout(resizeTimer);observer?.disconnect();renderTask?.cancel();
    void Promise.resolve().then(()=>task?.destroy()).catch(()=>{});pdf=null;
    canvas.width=canvas.height=0;
  }};
}
