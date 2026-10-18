import JSZip from 'jszip';
import { getDocumentProxy } from 'unpdf';
import { resolveInputChars } from './limits.ts';

export type ExtractedMaterial = {
  text: string;
  kind: string;
  message?: string;
  status: 'ready' | 'needs_ocr' | 'needs_optimization';
};

export type StoredMaterialSource = {
  size: number;
  readRange(offset: number, length: number): Promise<Uint8Array>;
};
export type ExtractionOptions = { maxText?: number };

const MAX_FILE = 32 * 1024 * 1024;
const MAX_STORED_FILE = 200 * 1024 * 1024;
const MAX_XML = 2 * 1024 * 1024;
const MAX_EXPANDED = 48 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED = 512 * 1024 * 1024;
const MAX_PAGES = 300;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function checkTextLength(length: number, maxText: number): void {
  if (length > maxText) throw new Error(`材料文字超过当前 ${maxText.toLocaleString('en-US')} 字符处理预算，请减少所选内容或拆分材料；本次未截取或省略内容。`);
}

function checkedText(text: string, maxText: number): string {
  checkTextLength(text.length, maxText);
  return text;
}

function decode(bytes: Uint8Array): string {
  try { return utf8.decode(bytes); }
  catch { throw new Error('文件文字编码无法识别，请将文本文件另存为 UTF-8，或重新导出 Office 文件。'); }
}

// Adapted from public/pptx.js zipPreflight, with lower expansion bounds for a
// 128 MB Worker. No binary media are inflated when extracting Office text.
function zipPreflight(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.length - 65_557);
  let end = -1;
  for (let p = bytes.length - 22; p >= minimum; p--) {
    if (view.getUint32(p, true) === 0x06054b50 && p + 22 + view.getUint16(p + 20, true) === bytes.length) { end = p; break; }
  }
  if (end < 0) throw new Error('文件不是可识别的 Office 压缩包，请重新导出 .docx 或 .pptx。');
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), offset = view.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new Error('不支持 ZIP64 Office 文件。');
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count !== view.getUint16(end + 8, true)) throw new Error('不支持分卷压缩的 Office 文件。');
  if (!count || count > 4000 || offset + size !== end) throw new Error('Office 文件内部结构过大或损坏。');
  let p = offset, total = 0;
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || view.getUint32(p, true) !== 0x02014b50) throw new Error('Office 文件目录损坏。');
    const compressed = view.getUint32(p + 20, true), expanded = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true), extraLength = view.getUint16(p + 30, true), commentLength = view.getUint16(p + 32, true);
    const flags = view.getUint16(p + 8, true), method = view.getUint16(p + 10, true), local = view.getUint32(p + 42, true);
    if (p + 46 + nameLength + extraLength + commentLength > end) throw new Error('Office 文件目录范围无效。');
    const name = decode(bytes.subarray(p + 46, p + 46 + nameLength));
    if (flags & 1 || ![0, 8].includes(method)) throw new Error('不支持加密或特殊压缩方式的 Office 文件。');
    if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || name.includes('\0') || names.has(name)) throw new Error('Office 文件包含不安全或重复的内部文件名。');
    names.add(name);
    total += expanded;
    if (compressed === 0xffffffff || expanded === 0xffffffff || local === 0xffffffff || total > MAX_EXPANDED) throw new Error('Office 文件解压尺寸超过 48 MB，请使用精简文件。');
    if (local + 30 > offset || view.getUint32(local, true) !== 0x04034b50) throw new Error('Office 文件数据索引损坏。');
    const localNameLength = view.getUint16(local + 26, true), localExtraLength = view.getUint16(local + 28, true);
    if (local + 30 + localNameLength + localExtraLength + compressed > offset) throw new Error('Office 文件数据范围无效。');
    if (decode(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name || view.getUint16(local + 8, true) !== method || view.getUint16(local + 6, true) !== flags) throw new Error('Office 文件内部索引不一致。');
    if (/\.(xml|rels)$/i.test(name) && (expanded > MAX_XML || expanded > Math.max(1, compressed) * 400)) throw new Error('Office XML 结构过大，请精简或拆分文件。');
    if (/vbaproject\.bin$/i.test(name)) throw new Error('请使用不包含宏的 .docx 或 .pptx 文件。');
    p += 46 + nameLength + extraLength + commentLength;
  }
  if (p !== end) throw new Error('Office 文件目录长度不一致。');
}

type ZipTextStream = {
  on(event: 'data', callback: (chunk: Uint8Array) => void): ZipTextStream;
  on(event: 'error', callback: (error: Error) => void): ZipTextStream;
  on(event: 'end', callback: () => void): ZipTextStream;
  pause(): ZipTextStream;
  resume(): ZipTextStream;
};

async function readXml(zip: JSZip, path: string, optional = false): Promise<string | null> {
  const entry = zip.file(path);
  if (!entry) {
    if (optional) return null;
    throw new Error(`Office 文件缺少必要结构：${path}`);
  }
  return new Promise((resolve, reject) => {
    let length = 0, failed = false;
    const chunks: Uint8Array[] = [];
    // JSZip's runtime exposes internalStream, but its bundled TS declaration
    // only includes async(). Keep the bounded stream API typed locally.
    const stream = (entry as typeof entry & { internalStream(type: 'uint8array'): ZipTextStream }).internalStream('uint8array');
    stream.on('data', (chunk: Uint8Array) => {
      if (failed) return;
      length += chunk.length;
      if (length > MAX_XML) {
        failed = true;
        stream.pause();
        reject(new Error('Office XML 实际解压超过 2 MB，请拆分文件。'));
        return;
      }
      chunks.push(chunk);
    }).on('error', () => { if (!failed) { failed = true; reject(new Error('Office 文件解压失败，请重新导出。')); } })
      .on('end', () => {
        if (failed) return;
        const all = new Uint8Array(length);
        let at = 0;
        for (const chunk of chunks) { all.set(chunk, at); at += chunk.length; }
        try { resolve(decode(all)); } catch (error) { reject(error); }
      }).resume();
  });
}

type XmlEvent = { type: 'start' | 'end' | 'text'; name: string; attrs: Record<string, string>; text: string; depth: number };
function entityText(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&([^;\s<&]*);|&/g, (match, key: string | undefined) => {
    if (key && Object.hasOwn(entities, key)) return entities[key];
    if (key && /^#(?:[0-9]+|x[0-9a-f]+)$/i.test(key)) {
      const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (code === 9 || code === 10 || code === 13 || code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && code !== 0xfffe && code !== 0xffff) return String.fromCodePoint(code);
    }
    throw new Error('Office XML 包含无法识别的字符实体。');
  });
}

/** A bounded XML token reader: validates nesting/attributes; never resolves DTDs,
 * entities, URLs or XInclude. Office fields are selected by local element name. */
function walkXml(xml: string, visit: (event: XmlEvent) => void): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml)) throw new Error('Office XML 包含不支持的声明或控制字符。');
  const stack: string[] = [];
  let root = '', roots = 0, position = 0, nodes = 0;
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_][\w.:-]*(?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>|[^<]+/gy;
  for (;;) {
    token.lastIndex = position;
    const match = token.exec(xml);
    if (!match) break;
    const raw = match[0];
    position = token.lastIndex;
    if (++nodes > 120_000) throw new Error('Office XML 节点过多，请拆分文件。');
    if (raw.startsWith('<!--')) {
      if (raw.slice(4, -3).includes('--')) throw new Error('Office XML 注释损坏。');
      continue;
    }
    if (raw.startsWith('<?')) continue;
    if (raw.startsWith('<![CDATA[') || !raw.startsWith('<')) {
      const text = raw.startsWith('<![CDATA[') ? raw.slice(9, -3) : entityText(raw);
      if (!stack.length && text.trim()) throw new Error('Office XML 根元素外存在内容。');
      visit({ type: 'text', name: stack.at(-1)?.split(':').at(-1) || '', attrs: {}, text, depth: stack.length });
      continue;
    }
    const fullName = /^<\/?([^\s/>]+)/.exec(raw)![1], name = fullName.split(':').at(-1)!;
    if (raw.startsWith('</')) {
      if (!/^<\/[^\s/>]+\s*>$/.test(raw) || stack.pop() !== fullName) throw new Error('Office XML 标签不匹配。');
      visit({ type: 'end', name, attrs: {}, text: '', depth: stack.length });
      continue;
    }
    if (!stack.length) { roots++; root = name; }
    if (stack.length >= 100) throw new Error('Office XML 嵌套层级过深。');
    const attrs: Record<string, string> = Object.create(null);
    const attribute = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let found: RegExpExecArray | null;
    while ((found = attribute.exec(raw))) {
      if (Object.hasOwn(attrs, found[1])) throw new Error('Office XML 属性重复。');
      attrs[found[1]] = entityText(found[2] ?? found[3]);
    }
    visit({ type: 'start', name, attrs, text: '', depth: stack.length });
    if (/\/\s*>$/.test(raw)) visit({ type: 'end', name, attrs: {}, text: '', depth: stack.length });
    else stack.push(fullName);
  }
  if (position !== xml.length || stack.length || roots !== 1) throw new Error('Office XML 结构损坏，请重新导出文件。');
  return root;
}

function officeText(xml: string, expectedRoot: string, maxText: number): string {
  let result = '';
  const root = walkXml(xml, (event) => {
    if (event.type === 'text' && event.name === 't') result = checkedText(result + event.text, maxText);
    else if (event.type === 'start' && ['tab', 'br', 'cr'].includes(event.name)) result = checkedText(result + (event.name === 'tab' ? '\t' : '\n'), maxText);
    else if (event.type === 'end' && event.name === 'p') result = checkedText(result + '\n', maxText);
  });
  if (root !== expectedRoot) throw new Error('Office 文件内容与文件类型不符。');
  return result.trim();
}

type Relationship = { id: string; target: string; type: string; external: boolean };
function relationships(xml: string): Relationship[] {
  const list: Relationship[] = [], ids = new Set<string>();
  const root = walkXml(xml, (event) => {
    if (event.type !== 'start' || event.name !== 'Relationship') return;
    const { Id: id, Target: target, Type: type, TargetMode } = event.attrs;
    if (!id || !target || !type || ids.has(id)) throw new Error('Office 文件关系索引损坏。');
    ids.add(id);
    list.push({ id, target, type, external: TargetMode === 'External' });
  });
  if (root !== 'Relationships') throw new Error('Office 文件关系结构无效。');
  return list;
}

function resolvePart(base: string, target: string): string {
  if (!target || /[\\:\u0000?#]/.test(target) || target.startsWith('/')) throw new Error('Office 文件关系指向不支持的路径。');
  const parts = base.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '..') { if (!parts.length) throw new Error('Office 文件关系超出包内范围。'); parts.pop(); }
    else if (part !== '.' && part) parts.push(part);
  }
  return parts.join('/');
}

async function extractOffice(bytes: Uint8Array, kind: 'docx' | 'pptx', maxText: number): Promise<ExtractedMaterial> {
  zipPreflight(bytes);
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); }
  catch { throw new Error('Office 文件无法解压，请重新导出。'); }
  return extractOfficeXml((path, optional) => readXml(zip, path, optional), kind, maxText);
}

type XmlReader = (path: string, optional?: boolean) => Promise<string | null>;

async function extractOfficeXml(read: XmlReader, kind: 'docx' | 'pptx', maxText: number): Promise<ExtractedMaterial> {
  if (kind === 'docx') {
    const text = officeText((await read('word/document.xml'))!, 'document', maxText);
    if (!text) throw new Error('Word 文件没有可提取的正文文字；如内容为扫描图片，请上传 PDF 或图片进行 OCR。');
    return { text, kind, status: 'ready', message: '已提取正文与表格中的文字；未读取嵌入图片、页眉页脚、批注和脚注，请核对需要引用的图表与补充资料。' };
  }
  const presentation = (await read('ppt/presentation.xml'))!;
  const rels = relationships((await read('ppt/_rels/presentation.xml.rels'))!);
  const order: string[] = [];
  const root = walkXml(presentation, (event) => {
    if (event.type !== 'start' || event.name !== 'sldId') return;
    const id = Object.entries(event.attrs).find(([key]) => key.endsWith(':id'))?.[1];
    if (!id || order.includes(id)) throw new Error('PPT 页面顺序索引损坏。');
    order.push(id);
  });
  if (root !== 'presentation' || !order.length) throw new Error('PPT 文件没有可识别的幻灯片。');
  if (order.length > MAX_PAGES) throw new Error(`PPT 超过 ${MAX_PAGES} 页，请拆分文件后上传；本次未省略任何页面。`);
  const pages: string[] = [];
  let characters = 0, contentCharacters = 0, emptyPages = 0;
  for (const [index, id] of order.entries()) {
    const rel = rels.find((item) => item.id === id && /\/slide$/.test(item.type));
    if (!rel || rel.external) throw new Error('PPT 页面关系缺失或指向外部文件。');
    const path = resolvePart('ppt/presentation.xml', rel.target);
    const slideText = officeText((await read(path))!, 'sld', maxText);
    const pieces = path.split('/'), filename = pieces.pop()!;
    const slideRels = await read(`${pieces.join('/')}/_rels/${filename}.rels`, true);
    let notes = '';
    if (slideRels) {
      const notesRel = relationships(slideRels).find((item) => /\/notesSlide$/.test(item.type));
      if (notesRel) {
        if (notesRel.external) throw new Error('PPT 备注指向外部文件，无法读取。');
        notes = officeText((await read(resolvePart(path, notesRel.target)))!, 'notes', maxText);
      }
    }
    contentCharacters += slideText.length + notes.length;
    if (!slideText) emptyPages++;
    const page = `[第 ${index + 1} 页]\n${slideText || '（此页未检出文字，可能包含图片或空白内容）'}${notes ? '\n[讲者备注]\n' + notes : ''}`;
    characters += page.length + (pages.length ? 2 : 0);
    checkTextLength(characters, maxText);
    pages.push(page);
  }
  if (!contentCharacters) throw new Error('PPT 未检出可提取文字；如页面为图片，请另存为 PDF 后进行 OCR。');
  return {
    text: pages.join('\n\n'), kind, status: 'ready',
    message: `已按原始页序提取文字与讲者备注；未读取嵌入图片、图表数据和完整母版。${emptyPages ? `其中 ${emptyPages} 页未检出页面文字，请补充图片或 PDF。` : ''}`,
  };
}

async function extractPdf(bytes: Uint8Array, maxText: number): Promise<ExtractedMaterial> {
  if (!decode(bytes.subarray(0, 5)).startsWith('%PDF-')) throw new Error('文件内容不是 PDF，请检查文件后缀。');
  // Disable JavaScript evaluation and expensive image/font decoding. Iterate
  // pages and streamed text chunks, instead of extracting all pages in parallel.
  // PDF.js transfers ownership and detaches the supplied buffer, including in
  // its serverless build. Preserve the caller's bytes for source-file storage.
  const pdf = await getDocumentProxy(bytes.slice(), { isEvalSupported: false, disableFontFace: true, useSystemFonts: false, maxImageSize: 4_194_304, stopAtErrors: true });
  const deadline = Date.now() + 20_000;
  try {
    if (pdf.numPages < 1) throw new Error('PDF 没有可读取的页面。');
    if (pdf.numPages > MAX_PAGES) throw new Error(`PDF 超过 ${MAX_PAGES} 页，请拆分文件后上传；本次未省略任何页面。`);
    const pages: string[] = [], emptyPages: number[] = [];
    let count = 0;
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const reader = page.streamTextContent().getReader();
      let pageText = '';
      try {
        for (;;) {
          if (Date.now() > deadline) throw new Error('PDF 解析超时，请拆分文件后重试。');
          const { value, done } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (!('str' in item)) continue;
            const fragment = item.str + (item.hasEOL ? '\n' : ' ');
            count += fragment.length;
            checkTextLength(count, maxText);
            pageText += fragment;
          }
        }
      } finally { await reader.cancel().catch(() => {}); page.cleanup(); }
      if (!pageText.trim()) emptyPages.push(index);
      const prefix = `[第 ${index} 页]\n`;
      count += prefix.length + 2;
      checkTextLength(count, maxText);
      pages.push(prefix + pageText.trim());
    }
    if (emptyPages.length) {
      return { text: pages.join('\n\n'), kind: 'pdf', status: 'needs_ocr', message: `PDF 已保存；生成汇报时自动识别全部页面图文与版面，包括第 ${emptyPages.join('、')} 页的扫描或空白内容。` };
    }
    return { text: checkedText(pages.join('\n\n'), maxText), kind: 'pdf', status: 'ready', message: 'PDF 原件与页码已保存；生成汇报时自动读取图文，重建正文阅读顺序并整合图表、公式与表格。' };
  } finally { await pdf.destroy(); }
}

export async function extractMaterial(bytes: Uint8Array, name: string, options: ExtractionOptions = {}): Promise<ExtractedMaterial> {
  const maxText = resolveInputChars(options.maxText);
  if (!bytes.byteLength) throw new Error('文件为空，请重新选择。');
  if (bytes.byteLength > MAX_FILE) throw new Error('整文件解析上限为 32 MB；大型 Office 材料请使用分块上传。');
  const kind = name.split('.').at(-1)?.toLowerCase();
  if (kind === 'pdf') {
    try { return await extractPdf(bytes, maxText); }
    catch (error) {
      if (error instanceof Error && /[\u3400-\u9fff]/.test(error.message)) throw error;
      throw new Error('PDF 解析失败，文件可能损坏、受密码保护或使用不支持的编码；请重新导出。');
    }
  }
  if (kind === 'docx' || kind === 'pptx') return extractOffice(bytes, kind, maxText);
  if (kind === 'txt' || kind === 'md') {
    const text = checkedText(decode(bytes), maxText);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error('文本文件包含二进制内容，请另存为 UTF-8 文本。');
    if (!text.trim()) throw new Error('材料没有可读取的文字。');
    return { text, kind, status: 'ready' };
  }
  if (kind === 'png' || kind === 'jpg' || kind === 'jpeg') {
    const isPng = bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) && String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR';
    const isJpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
    if (!(kind === 'png' ? isPng : isJpeg)) throw new Error('图片内容与扩展名不符或文件损坏，请重新导出。');
    return { text: '', kind: kind === 'jpeg' ? 'jpg' : kind, status: 'needs_ocr', message: '图片需要 OCR 识别后才能用于文字生成；目前尚未提取其内容。' };
  }
  throw new Error('暂不支持此文件类型，请上传 PDF、DOCX、PPTX、TXT、Markdown、PNG 或 JPG。');
}

type StoredZipEntry = {
  name: string;
  flags: number;
  method: number;
  compressed: number;
  expanded: number;
  offset: number;
  crc: number;
  central: Uint8Array;
};

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function exactRange(source: StoredMaterialSource, offset: number, length: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || offset + length > source.size) throw new Error('材料内部读取范围无效。');
  const bytes = await source.readRange(offset, length);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) throw new Error('材料文件读取不完整，请重新上传或稍后重试。');
  return bytes;
}

function validateExtra(bytes: Uint8Array): void {
  const view = viewOf(bytes);
  let position = 0;
  while (position < bytes.length) {
    if (position + 4 > bytes.length) throw new Error('Office 压缩包扩展字段损坏。');
    const id = view.getUint16(position, true), length = view.getUint16(position + 2, true);
    if (id === 1) throw new Error('不支持 ZIP64 Office 文件。');
    position += 4 + length;
    if (position > bytes.length) throw new Error('Office 压缩包扩展字段越界。');
  }
}

/** Read only the bounded ZIP directory and requested XML members. Image/video
 * payloads remain in object storage and are never downloaded or decompressed. */
async function storedOfficeReader(source: StoredMaterialSource): Promise<XmlReader> {
  const tailLength = Math.min(source.size, 65_557), tailOffset = source.size - tailLength;
  const tail = await exactRange(source, tailOffset, tailLength), endView = viewOf(tail);
  let end = -1;
  for (let p = tail.length - 22; p >= 0; p--) {
    if (endView.getUint32(p, true) === 0x06054b50 && p + 22 + endView.getUint16(p + 20, true) === tail.length) { end = p; break; }
  }
  if (end < 0) throw new Error('文件不是可识别的 Office 压缩包，请重新导出 .docx 或 .pptx。');
  const count = endView.getUint16(end + 10, true), directorySize = endView.getUint32(end + 12, true), directoryOffset = endView.getUint32(end + 16, true);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new Error('不支持 ZIP64 Office 文件。');
  if (endView.getUint16(end + 4, true) || endView.getUint16(end + 6, true) || count !== endView.getUint16(end + 8, true)) throw new Error('不支持分卷压缩的 Office 文件。');
  if (!count || count > 4000 || !directorySize || directorySize > 4 * 1024 * 1024 || directoryOffset + directorySize !== tailOffset + end) throw new Error('Office 文件目录过大或范围损坏。');
  const directory = directoryOffset >= tailOffset ? tail.subarray(directoryOffset - tailOffset, end) : await exactRange(source, directoryOffset, directorySize);
  const view = viewOf(directory), entries = new Map<string, StoredZipEntry>();
  const regions: Array<{ start: number; end: number }> = [];
  let position = 0, expandedTotal = 0, xmlTotal = 0;
  for (let i = 0; i < count; i++) {
    if (position + 46 > directory.length || view.getUint32(position, true) !== 0x02014b50) throw new Error('Office 文件目录损坏。');
    const flags = view.getUint16(position + 8, true), method = view.getUint16(position + 10, true);
    const crc = view.getUint32(position + 16, true), compressed = view.getUint32(position + 20, true), expanded = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true), extraLength = view.getUint16(position + 30, true), commentLength = view.getUint16(position + 32, true);
    const offset = view.getUint32(position + 42, true), recordSize = 46 + nameLength + extraLength + commentLength;
    if (position + recordSize > directory.length || !nameLength || nameLength > 1024) throw new Error('Office 文件目录字段损坏。');
    if (flags & 1 || ![0, 8].includes(method)) throw new Error('不支持加密或特殊压缩方式的 Office 文件。');
    if (view.getUint16(position + 34, true)) throw new Error('不支持分卷压缩的 Office 文件。');
    const nameBytes = directory.subarray(position + 46, position + 46 + nameLength), name = decode(nameBytes);
    if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || name.includes('\0') || entries.has(name)) throw new Error('Office 文件包含不安全或重复的内部文件名。');
    validateExtra(directory.subarray(position + 46 + nameLength, position + 46 + nameLength + extraLength));
    expandedTotal += expanded;
    if (compressed === 0xffffffff || expanded === 0xffffffff || offset === 0xffffffff) throw new Error('不支持 ZIP64 Office 文件。');
    if (expandedTotal > MAX_ARCHIVE_EXPANDED) throw new Error('Office 压缩包声明解压总量超过 512 MB，请精简媒体后重试。');
    if (offset + 30 + nameLength + compressed > directoryOffset || method === 0 && compressed !== expanded) throw new Error('Office 文件数据范围或压缩尺寸无效。');
    if (/\.(xml|rels)$/i.test(name)) {
      xmlTotal += expanded;
      if (expanded > MAX_XML || compressed > MAX_XML + 65_536 || expanded > Math.max(1, compressed) * 400) throw new Error('Office XML 结构过大，请精简或拆分文件。');
      if (xmlTotal > MAX_EXPANDED) throw new Error('Office XML 声明解压总量超过 48 MB，请精简文件。');
    }
    if (/vbaproject\.bin$/i.test(name)) throw new Error('请使用不包含宏的 .docx 或 .pptx 文件。');
    regions.push({ start: offset, end: offset + 30 + nameLength + compressed });
    entries.set(name, { name, flags, method, crc, compressed, expanded, offset, central: directory.subarray(position, position + recordSize) });
    position += recordSize;
  }
  if (position !== directory.length) throw new Error('Office 文件目录长度不一致。');
  regions.sort((a, b) => a.start - b.start);
  for (let i = 1; i < regions.length; i++) if (regions[i].start < regions[i - 1].end) throw new Error('Office 文件包含重叠数据范围。');
  let expandedRead = 0;
  return async (path, optional = false) => {
    const entry = entries.get(path);
    if (!entry) {
      if (optional) return null;
      throw new Error(`Office 文件缺少必要结构：${path}`);
    }
    if (!/\.(xml|rels)$/i.test(path)) throw new Error('Office 文本关系未指向 XML 文件。');
    expandedRead += entry.expanded;
    if (expandedRead > MAX_EXPANDED) throw new Error('Office XML 累计解析超过 48 MB，请精简文件。');
    const localHeader = await exactRange(source, entry.offset, 30), localView = viewOf(localHeader);
    if (localView.getUint32(0, true) !== 0x04034b50 || localView.getUint16(6, true) !== entry.flags || localView.getUint16(8, true) !== entry.method) throw new Error('Office 文件内部索引不一致。');
    const nameLength = localView.getUint16(26, true), extraLength = localView.getUint16(28, true);
    const localLength = 30 + nameLength + extraLength + entry.compressed;
    const nextRegion = regions.find(region => region.start > entry.offset);
    if (!nameLength || nameLength > 1024 || entry.offset + localLength > (nextRegion?.start ?? directoryOffset)) throw new Error('Office XML 数据读取范围无效。');
    const payload = await exactRange(source, entry.offset + 30, localLength - 30);
    if (decode(payload.subarray(0, nameLength)) !== path) throw new Error('Office XML 内部文件名不一致。');
    validateExtra(payload.subarray(nameLength, nameLength + extraLength));
    if (!(entry.flags & 8) && (localView.getUint32(14, true) !== entry.crc || localView.getUint32(18, true) !== entry.compressed || localView.getUint32(22, true) !== entry.expanded)) throw new Error('Office XML 内部压缩尺寸不一致。');

    // Construct a bounded one-member archive so the existing streaming JSZip
    // reader enforces the actual expanded-byte limit, even if headers lie.
    const single = new Uint8Array(localLength + entry.central.length + 22);
    single.set(localHeader); single.set(payload, 30); single.set(entry.central, localLength);
    const singleView = viewOf(single), flags = entry.flags & ~8;
    singleView.setUint16(6, flags, true);
    singleView.setUint32(14, entry.crc, true);
    singleView.setUint32(18, entry.compressed, true);
    singleView.setUint32(22, entry.expanded, true);
    singleView.setUint16(localLength + 8, flags, true);
    singleView.setUint32(localLength + 42, 0, true);
    const footer = localLength + entry.central.length;
    singleView.setUint32(footer, 0x06054b50, true);
    singleView.setUint16(footer + 8, 1, true); singleView.setUint16(footer + 10, 1, true);
    singleView.setUint32(footer + 12, entry.central.length, true); singleView.setUint32(footer + 16, localLength, true);
    try { return await readXml(await JSZip.loadAsync(single), path); }
    catch (error) {
      if (error instanceof Error && /[\u3400-\u9fff]/.test(error.message)) throw error;
      throw new Error('Office XML 无法解压，请重新导出文件。');
    }
  };
}

export async function extractStoredMaterial(source: StoredMaterialSource, name: string, options: ExtractionOptions = {}): Promise<ExtractedMaterial> {
  const maxText = resolveInputChars(options.maxText);
  if (!Number.isSafeInteger(source.size) || source.size < 1) throw new Error('文件为空或文件大小无效，请重新上传。');
  if (source.size > MAX_STORED_FILE) throw new Error('单个材料须不超过 200 MB，请压缩或拆分后上传。');
  const kind = name.split('.').at(-1)?.toLowerCase() || '';
  if (kind === 'pptx' || kind === 'docx') return extractOfficeXml(await storedOfficeReader(source), kind, maxText);
  if (!['pdf', 'txt', 'md', 'png', 'jpg', 'jpeg'].includes(kind)) throw new Error('暂不支持此文件类型，请上传 PDF、DOCX、PPTX、TXT、Markdown、PNG 或 JPG。');
  if (source.size > MAX_FILE) {
    if (kind === 'pdf' && decode(await exactRange(source, 0, 5)) !== '%PDF-') throw new Error('文件内容不是 PDF，请检查文件后缀。');
    return { text: '', kind: kind === 'jpeg' ? 'jpg' : kind, status: 'needs_optimization', message: kind === 'pdf'
      ? '原始 PDF 已保存；此文件超过服务端整文件解析的 32 MB 内存预算，请在浏览器完成文字提取后继续生成。若浏览器无法处理，可压缩或按章节拆分原文件；原文件未截取或修改。'
      : '原文件已保存；此类文件超过 32 MB，当前无法直接解析。请压缩图片或拆分文字后上传用于生成，原文件未截取或修改。' };
  }
  return extractMaterial(await exactRange(source, 0, source.size), name, { maxText });
}
