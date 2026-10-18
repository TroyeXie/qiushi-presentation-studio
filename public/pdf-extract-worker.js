/* PDF text extraction runs in a browser module Worker, outside the server's
 * 128 MB memory budget. PDF.js is bundled by unpdf; see vendor license files. */
import { getDocument } from './vendor/pdfjs.mjs';

let busy = false;
const FILE_LIMIT = 200 * 1024 * 1024;
const PAGE_LIMIT = 300;
// Keep the fallback aligned with server/limits.ts. The UI passes the active
// server budget; no model credentials or API calls are present in this worker.
function resolveTextBudget(value) {
  if (value === undefined || value === null || value === '') return 400_000;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1_000_000, Math.max(80_000, Math.floor(number))) : 400_000;
}

self.onmessage = async ({ data }) => {
  if (!data || typeof data !== 'object' || !data.file) return;
  if (busy) {
    self.postMessage({ type: 'error', message: '正在提取另一份 PDF，请等待当前文件完成。' });
    return;
  }
  busy = true;
  let task, pdf;
  try {
    const { file } = data;
    if (typeof file.arrayBuffer !== 'function' || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > FILE_LIMIT) throw new Error('请选择 1 字节至 200 MB 的 PDF 文件。');
    const maxText = resolveTextBudget(data.maxText);
    const maxPages = Number.isInteger(data.maxPages) ? Math.min(PAGE_LIMIT, Math.max(1, data.maxPages)) : PAGE_LIMIT;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') throw new Error('文件内容不是 PDF，请检查文件后缀。');
    task = getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
      maxImageSize: 4_194_304, stopAtErrors: true, isOffscreenCanvasSupported: false, isImageDecoderSupported: false });
    pdf = await task.promise;
    if (pdf.numPages < 1) throw new Error('PDF 没有可读取的页面。');
    if (pdf.numPages > maxPages) throw new Error(`PDF 超过当前 ${maxPages} 页处理范围，请按章节拆分；本次未截取或省略任何页面。`);
    const pages = [], emptyPages = [];
    let characters = 0;
    const checkBudget = () => {
      if (characters > maxText) throw new Error(`材料文字超过当前 ${maxText.toLocaleString('en-US')} 字符处理预算，请拆分材料；本次未截取或省略内容。`);
    };
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index), reader = page.streamTextContent().getReader();
      let text = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          for (const item of chunk.value.items) {
            if (!('str' in item)) continue;
            const fragment = item.str + (item.hasEOL ? '\n' : ' ');
            characters += fragment.length;
            checkBudget();
            text += fragment;
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        page.cleanup();
      }
      if (!text.trim()) emptyPages.push(index);
      const prefix = `[第 ${index} 页]\n`;
      characters += prefix.length + 2;
      checkBudget();
      pages.push(prefix + text.trim());
      self.postMessage({ type: 'progress', page: index, total: pdf.numPages });
    }
    const result = { type: 'result', text: pages.join('\n\n'), kind: 'pdf', status: emptyPages.length ? 'needs_ocr' : 'ready',
      message: emptyPages.length
        ? `浏览器已读取全部 ${pdf.numPages} 页；第 ${emptyPages.join('、')} 页未检出文字，生成汇报时将自动识别扫描内容、图表与版面。`
        : `PDF 全部 ${pdf.numPages} 页已保存；生成汇报时自动读取图文并整理阅读顺序。`,
      pageCount: pdf.numPages };
    await pdf.destroy();
    pdf = null; task = null;
    self.postMessage(result);
  } catch (error) {
    const message = error instanceof Error && /[\u3400-\u9fff]/.test(error.message) ? error.message
      : 'PDF 提取失败，文件可能损坏、受密码保护，或超过当前设备的处理能力。请重新导出、压缩或按章节拆分后重试。';
    self.postMessage({ type: 'error', message });
  } finally {
    if (pdf) await pdf.destroy().catch(() => {});
    else if (task) await task.destroy().catch(() => {});
    busy = false;
  }
};
