/* 求是·汇报 | Offline project model, outline parser and review rules. */
(function (root) {
  'use strict';

  const limits = Object.freeze({ slides: 60, outlineChars: 120000, textChars: 60000,
    projectBytes: 32 * 1024 * 1024, imageBytes: 8 * 1024 * 1024, templateBytes: 25 * 1024 * 1024 });
  const palettes = [
    { id: 'zju-blue', name: '求是蓝', label: '求是蓝', accent: '#074591', secondary: '#8C9CAD', background: '#FFFFFF', text: '#162233' },
    { id: 'pine-green', name: '松石绿', label: '松石绿', accent: '#346A5E', secondary: '#9BAE9C', background: '#FFFFFF', text: '#20302C' },
    { id: 'slate-purple', name: '岩灰紫', label: '岩灰紫', accent: '#675985', secondary: '#ADA3B7', background: '#FFFFFF', text: '#292537' },
    { id: 'warm-red', name: '陶土红', label: '陶土红', accent: '#994E48', secondary: '#C1A49B', background: '#FFFFFF', text: '#352824' }
  ];
  // Reusable visual parameters measured from the user-provided academic reference.
  // Original private slides and personal content are not part of this profile.
  const visualProfiles = [
    { id: 'standard', label: '简洁白底', branded: false },
    { id: 'zju-academic', label: '浙大蓝白（含校标）', branded: true,
      navBackground: '#EBF4FC', activeText: '#FFFFFF',
      seal: { src: '/brand/zju-seal.png', width: 600, height: 600, alt: '浙江大学校徽' },
      wordmark: { src: '/brand/zju-wordmark.png', width: 1000, height: 276, alt: '浙江大学校标' },
      defaults: { profile: 'zju-academic', palette: 'zju-blue', accent: '#074591', secondary: '#8C9CAD',
        background: '#FFFFFF', text: '#000000', navBackground: '#EBF4FC', font: '华文楷体',
        nav: 'left', width: 13.3333333333, height: 7.5, showBrand: true }
    }
  ];
  function visualProfile(theme) {
    return visualProfiles.find(p => p.id === (theme || {}).profile) || visualProfiles[0];
  }
  function applyVisualProfile(theme, id) {
    const profile = visualProfiles.find(p => p.id === id) || visualProfiles[0];
    return { ...(theme || {}), ...(profile.defaults || {}), profile: profile.id };
  }
  const sceneTemplates = {
    course: { id: 'course', label: '课程汇报', description: '教学目标、概念讲解、课堂应用与学习检查',
      sections: ['问题导入', '概念理解', '应用练习', '学习小结'],
      focus: '说明学习目标，先呈现具体问题，再组织概念、比较与应用。末尾安排可回答的检查题。' },
    lab: { id: 'lab', label: '组会汇报', description: '围绕研究问题组织依据、进展、限制与下一步',
      sections: ['研究问题', '方法与进展', '结果与解释', '下一步计划'],
      focus: '依据材料判断文献与本人工作的归属，混合时清楚区分；说明结果、待验证假说与下一步计划。保留阴性结果和影响结论的限制。' },
    journal: { id: 'journal', label: '文献分享', description: '研究问题、实验设计、核心证据与批判性讨论',
      sections: ['论文与问题', '研究设计', '核心证据', '讨论与启发'],
      focus: '交代论文身份、方法与证据链。区分作者结果与汇报者推断，核查原图、数据及复现材料的可及性。' }
  };
  const types = ['cover', 'section', 'bullets', 'comparison', 'figure', 'table'];
  const tableLimits = Object.freeze({columns:6,rows:10,cellChars:800,headingChars:200});
  // Only paired **bold** spans are formatting. HTML and other Markdown stay text.
  function inlineRuns(value) {
    const source=String(value ?? ''), runs=[];
    let at=0;
    for(const match of source.matchAll(/\*\*([^*\n]+)\*\*/g)){
      if(match.index>at)runs.push({text:source.slice(at,match.index),bold:false});
      runs.push({text:match[1],bold:true});at=match.index+match[0].length;
    }
    if(at<source.length)runs.push({text:source.slice(at),bold:false});
    return runs.length?runs:[{text:source,bold:false}];
  }
  function plainInlineText(value){return inlineRuns(value).map(run=>run.text).join('');}
  function renderInlineHtml(value){
    const escape=text=>text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    return inlineRuns(value).map(run=>run.bold?'<strong>'+escape(run.text)+'</strong>':escape(run.text)).join('');
  }
  function normalizeCrop(value){
    if(value===undefined||value===null)return null;
    if(!value||typeof value!=='object'||Array.isArray(value)||!['x','y','w','h'].every(key=>typeof value[key]==='number'&&Number.isFinite(value[key])))
      throw new Error('图片裁剪区域应包含有效的 x、y、w、h 数值。');
    const {x,y,w,h}=value;
    if(x<0||y<0||x>=1||y>=1||w<.001||h<.001||x+w>1.000001||y+h>1.000001)
      throw new Error('图片裁剪区域必须位于原图范围内。');
    return {x,y,w:Math.min(w,1-x),h:Math.min(h,1-y)};
  }
  function normalizeTable(value){
    if(value===undefined||value===null)return null;
    if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray(value.columns)||!Array.isArray(value.rows)||
      value.columns.length<1||value.columns.length>tableLimits.columns||value.rows.length>tableLimits.rows)
      throw new Error('单页表格支持 1–6 列、最多 10 行数据，请将较长表格拆页。');
    const columns=value.columns.map(cell=>plain(cell,tableLimits.headingChars,'表头'));
    const rows=value.rows.map(row=>{
      if(!Array.isArray(row)||row.length!==columns.length)throw new Error('表格每行的单元格数必须与表头一致。');
      return row.map(cell=>plain(cell,tableLimits.cellChars,'表格单元格'));
    });
    return {columns,rows};
  }
  function navigationSections(project){
    return [...new Set((project?.slides||[]).filter(slide=>slide.type!=='cover').map(slide=>String(slide.section||'').trim()).filter(Boolean))];
  }
  const evidenceLabels = { teaching: '教学内容', literature: '文献已有结果', analysis: '本项目分析', hypothesis: '待验证假说', plan: '研究计划' };
  const sourceOrigins = ['literature', 'user', 'mixed', 'unknown'];
  // Ownership is independent of result/hypothesis/plan status. Keep legacy
  // evidence metadata without assuming uploaded work belongs to its uploader.
  function sourceOrigin(slide) {
    if (sourceOrigins.includes(slide?.sourceOrigin)) return slide.sourceOrigin;
    return slide?.evidence === 'literature' ? 'literature' : slide?.evidence === 'analysis' ? 'user' : 'unknown';
  }
  function evidenceLabel(project, slide) {
    if (!slide || ['cover', 'section'].includes(slide.type)) return '';
    const origins = new Set((project?.slides || []).filter(s => !['cover', 'section'].includes(s.type)).map(sourceOrigin));
    const distinguish = origins.has('mixed') || origins.size > 1;
    const origin = sourceOrigin(slide);
    const status = ['teaching', 'hypothesis', 'plan'].includes(slide.evidence) ? evidenceLabels[slide.evidence] : '';
    if (!distinguish) return status;
    const label = origin === 'literature' ? (status ? '文献来源' : '文献已有结果')
      : origin === 'user' ? (slide.evidence === 'analysis' && !status ? '本项目分析' : '本人工作')
      : origin === 'mixed' ? '文献与本人工作' : '来源待确认';
    return [label, status].filter(Boolean).join(' · ');
  }

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function plain(value, max, label) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error((label || '字段') + '须为文字。');
    const s = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    if (s.length > (max || 12000)) throw new Error((label || '文字') + '过长，请分段后导入。');
    return s;
  }
  function safeUrl(value) {
    if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007F]/.test(value)) return '';
    try {
      const u = new URL(value);
      return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : '';
    } catch (_) { return ''; }
  }
  function isSafeImageDataUrl(value) {
    if (typeof value !== 'string' || value.length > Math.ceil(limits.imageBytes * 4 / 3) + 100) return false;
    const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!m || m[2].length % 4 !== 0) return false;
    try {
      const head = root.atob(m[2].slice(0, 32));
      return m[1] === 'png' ? head.startsWith('\x89PNG\r\n\x1a\n') : head.charCodeAt(0) === 255 && head.charCodeAt(1) === 216 && head.charCodeAt(2) === 255;
    } catch (_) { return false; }
  }
  function color(value, fallback) { return /^#[0-9a-fA-F]{6}$/.test(value || '') ? value.toUpperCase() : fallback; }
  function number(value, fallback, lo, hi) {
    const n = Number(value);
    return value !== '' && Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
  }
  function body(value, label) {
    const a = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/).filter(Boolean) : [];
    if (a.length > 60) throw new Error((label || '正文') + '包含过多段落，请拆页。');
    return a.map(v => plain(v, 8000, label));
  }
  function normalizeProject(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('项目文件应是 JSON 对象。');
    if (raw.version !== undefined && Number(raw.version) !== 1) throw new Error('此原型仅支持 version: 1 的项目格式。');
    if (!Array.isArray(raw.slides)) throw new Error('项目缺少 slides 页面数组。');
    if (raw.slides.length > limits.slides) throw new Error('当前原型最多支持 60 页，请拆分汇报。');
    const t = raw.theme && typeof raw.theme === 'object' ? raw.theme : {};
    const palette = palettes.find(p => p.id === t.palette) || palettes[0];
    const result = {
      version: 1, title: plain(raw.title || '未命名汇报', 300, '汇报题目'),
      subtitle: plain(raw.subtitle, 1000, '副标题'), presenter: plain(raw.presenter, 200, '汇报人'),
      scene: Object.hasOwn(sceneTemplates, raw.scene) ? raw.scene : 'course', duration: number(raw.duration, 10, 1, 180),
      theme: { profile: visualProfile(t).id, showBrand: t.showBrand !== false, navBackground: color(t.navBackground, visualProfile(t).navBackground || '#F3F6FA'),
        palette: t.palette === 'custom' ? 'custom' : palette.id, accent: color(t.accent, palette.accent), secondary: color(t.secondary, palette.secondary),
        background: color(t.background, palette.background), text: color(t.text, palette.text),
        font: plain(t.font || '华文楷体', 100, '字体'), nav: ['top', 'left', 'none'].includes(t.nav) ? t.nav : 'top',
        width: number(t.width, 13.333333, 6, 20), height: number(t.height, 7.5, 4, 15) },
      slides: raw.slides.map((s, i) => {
        if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('第 ' + (i + 1) + ' 页格式无效。');
        const citations = Array.isArray(s.citations) ? s.citations : [];
        if (citations.length > 12) throw new Error('第 ' + (i + 1) + ' 页引用过多，请分成多页。');
        const cols = Array.isArray(s.columns) ? s.columns.slice() : [];
        if (cols.length > 2) throw new Error('双栏比较布局只支持两个栏目。');
        if (s.type === 'comparison') while (cols.length < 2) cols.push({ title: '', body: [] });
        let image = null;
        if (s.image) {
          const dataUrl = typeof s.image === 'string' ? s.image : s.image.dataUrl;
          if (!isSafeImageDataUrl(dataUrl)) throw new Error('第 ' + (i + 1) + ' 页图片须为有效 PNG/JPEG，且小于 8 MB。');
          image = { dataUrl, width: number(s.image.width, 1, 1, 30000), height: number(s.image.height, 1, 1, 30000), alt: plain(s.image.alt, 800, '图片替代文本') };
          const crop=normalizeCrop(s.image.crop);if(crop)image.crop=crop;
        }
        const table=normalizeTable(s.table);
        if(s.type==='table'&&!table)throw new Error('表格页需要 columns 与 rows 表格数据。');
        if(s.figureRef?.regionId!==undefined&&(typeof s.figureRef.regionId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(s.figureRef.regionId)))
          throw new Error('图形区域标识无效。');
        return {
          id: plain(s.id || 'slide-' + (i + 1), 100, '页面 ID'), type: types.includes(s.type) ? s.type : 'bullets',
          section: plain(s.section, 120, '章节'), title: plain(s.title, 600, '页面标题'), subtitle: plain(s.subtitle, 2000, '页面副标题'),
          body: body(s.body, '页面正文'), columns: cols.map(c => ({ title: plain(c.title, 200, '栏目标题'), body: body(c.body, '栏目正文') })),
          table, image, figureRef: s.figureRef && typeof s.figureRef === 'object' && typeof s.figureRef.materialId === 'string' && Number.isInteger(s.figureRef.page) && s.figureRef.page >= 1 && s.figureRef.page <= 300
            ? {materialId:plain(s.figureRef.materialId,120,'图像素材标识'),page:s.figureRef.page,...(s.figureRef.regionId?{regionId:plain(s.figureRef.regionId,80,'图形区域标识')}:{})} : null,
          caption: plain(s.caption, 3000, '图注'),
          citations: citations.map(c => {
            if (!c || typeof c !== 'object') throw new Error('引用须包含题名、期刊或机构、年份等字段。');
            const url = plain(c.url, 4096, '来源网址').trim();
            if (url && !safeUrl(url)) throw new Error('来源链接仅支持不含账号口令的 http/https 完整网址。');
            return { title: plain(c.title, 2000, '来源题名'), venue: plain(c.venue, 300, '期刊或机构'), year: plain(c.year, 120, '年份'),
              url: url ? safeUrl(url) : '', kind: ['paper', 'data', 'official', 'synthetic'].includes(c.kind) ? c.kind : 'paper', status: plain(c.status, 300, '发表状态') };
          }), notes: plain(s.notes, 15000, '演讲备注'), evidence: Object.hasOwn(evidenceLabels, s.evidence) ? s.evidence : 'teaching',
          sourceOrigin: sourceOrigin(s),
          durationSec: number(s.durationSec, s.type === 'cover' ? 25 : 60, 0, 1800)
        };
      })
    };
    if (/[<>"'&\u0000-\u001F]/.test(result.theme.font)) throw new Error('字体名称包含不支持的字符。');
    const texts = result.slides.map(slideText).join('') + result.title + result.subtitle;
    if (texts.length > limits.textChars) throw new Error('项目文字超过 60,000 字符，请拆分汇报。');
    if (JSON.stringify(result).length > limits.projectBytes) throw new Error('项目过大，请压缩图片后再导入。');
    return result;
  }
  function slideText(s) {
    return [s.title, s.subtitle, ...(s.body || []), ...(s.columns || []).flatMap(c => [c.title, ...(c.body || [])]),
      ...(s.table?[...s.table.columns,...s.table.rows.flat()]:[]),s.caption, s.notes, ...(s.citations || []).map(c => [c.title, c.venue, c.year, c.status].join(' '))].join('\n');
  }
  function textUnits(s) {
    const text = String(s || '');
    return (text.match(/[\u3400-\u9FFF]/g) || []).length + (text.match(/[A-Za-z0-9]+(?:['.-][A-Za-z0-9]+)*/g) || []).length;
  }
  function estimateProject(project) {
    let wordCount = 0, speechCount = 0, extraSeconds = 0, scheduledSeconds = 0;
    (project.slides || []).forEach(s => {
      const visible = [s.title, s.subtitle, ...(s.body || []), ...(s.columns || []).flatMap(c => [c.title, ...(c.body || [])]),...(s.table?[...s.table.columns,...s.table.rows.flat()]:[]), s.caption].join(' ');
      wordCount += textUnits(visible);
      speechCount += Math.max(textUnits(visible), textUnits(s.notes));
      extraSeconds += s.type === 'cover' || s.type === 'section' ? 8 : s.type === 'figure' ? 25 : 15;
      scheduledSeconds += Number.isFinite(Number(s.durationSec)) ? Number(s.durationSec) : 60;
    });
    const minutes = Math.round((speechCount / 220 + extraSeconds / 60) * 10) / 10;
    return { wordCount, speechCount, minutes, scheduledMinutes: Math.round(scheduledSeconds / 6) / 10,
      basis: '按每分钟 220 个中文字或英文词估算，并为翻页、读图留时。演讲备注与正文取较长者，结果仅供排练参考。' };
  }
  function contrast(a, b) {
    function lum(c) {
      const n = c.replace('#', '');
      const [r, g, b] = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
      return .2126 * r + .7152 * g + .0722 * b;
    }
    const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
  }
  function validateProject(project) {
    const errors = [], warnings = [];
    const add = (bucket, code, message, s, i) => bucket.push({ code, message, ...(s ? { slideId: s.id, slideIndex: i + 1 } : {}) });
    let p;
    try { p = normalizeProject(project); } catch (e) { return { errors: [{ code: 'schema', message: e.message }], warnings, checks: [], minutes: 0, wordCount: 0 }; }
    if (!p.slides.length) add(errors, 'empty', '至少添加一页内容。');
    const ids = new Set(), nav = [];
    p.slides.forEach((s, i) => {
      if (ids.has(s.id)) add(errors, 'duplicate-id', '页面 ID 重复，无法可靠定位局部修改。', s, i); ids.add(s.id);
      if (!s.title.trim()) add(errors, 'empty-title', '请补充页面标题。', s, i);
      if (s.section && !nav.includes(s.section)) nav.push(s.section);
      if (plainInlineText(s.title).length > (s.type === 'cover' ? 46 : 36)) add(warnings, 'long-title', '标题较长，建议精炼或拆为标题与副标题。', s, i);
      const mainCount = textUnits([...(s.body || []), ...s.columns.flatMap(c => c.body),...(s.table?[...s.table.columns,...s.table.rows.flat()]:[])].join(''));
      const threshold = s.type === 'figure' ? 130 : s.type === 'comparison' ? 260 : 320;
      if (mainCount > threshold || s.body.length > 6 || s.columns.some(c => c.body.length > 5)) add(warnings, 'density', '正文偏密，建议拆页或将解释移到演讲备注。', s, i);
      if (s.type === 'comparison' && s.columns.length !== 2) add(warnings, 'columns', '比较页应提供两个栏目及其内容。', s, i);
      if (!['cover', 'section'].includes(s.type) && !s.body.length && !s.columns.some(c => c.body.length) && !s.image && !s.table?.columns.length) add(warnings, 'empty-body', '页面尚无核心内容。', s, i);
      if (s.type === 'figure' && !s.image) add(warnings, 'image-needed', '图文页尚未添加图片，导出时将显示可编辑的图片位置提示。', s, i);
      if (s.image && !s.caption.trim()) add(warnings, 'caption', '图片尚无图注，请说明它支持的具体判断。', s, i);
      if (s.evidence === 'literature' && !s.citations.some(c => c.kind !== 'synthetic' && c.title && c.venue)) add(warnings, 'source', '文献结果页缺少完整来源，请补充题名与期刊或机构。', s, i);
      if (s.evidence === 'analysis' && !s.citations.some(c => c.kind === 'data')) add(warnings, 'data-source', '本项目分析页建议注明原始数据来源。', s, i);
      s.citations.forEach(c => {
        if (c.kind !== 'synthetic' && (!c.title.trim() || !c.venue.trim() || !c.year.trim())) add(warnings, 'citation-fields', '引用信息不完整，请核对题名、期刊或机构及年份。', s, i);
        if (c.url && !c.venue.trim()) add(errors, 'anchor', '有来源链接时，必须填写期刊或机构名作为点击文字。', s, i);
        if (c.kind !== 'synthetic' && !c.url) add(warnings, 'citation-url', '此来源尚无可核查网址。', s, i);
      });
      if (s.citations.length > 3) add(errors, 'citation-count', '单页最多保留 3 条完整来源。请拆为多页后导出，避免页脚溢出。', s, i);
      if (s.citations.map(c => c.title + c.venue).join('').length > 700) add(errors, 'long-citations', '本页完整来源超过页脚容量，请将对应证据拆页后导出。', s, i);
      if (!s.notes.trim() && !['cover', 'section'].includes(s.type)) add(warnings, 'notes', '可添加演讲备注，保留读图顺序与可能的追问。', s, i);
    });
    if (navigationSections(p).length > 6 && p.theme.nav !== 'none') add(warnings, 'nav-density', '章节较多，导航可能拥挤，可合并章节或隐藏导航。');
    if (nav.some(x => x.length > (p.theme.nav === 'left' ? 8 : 10)) && p.theme.nav !== 'none') add(warnings, 'nav-label', '部分章节名较长，建议简化导航文字。');
    if (contrast(p.theme.accent, p.theme.background) < 3) add(warnings, 'contrast-accent', '主题色与背景对比偏低，投影时可能不清楚。');
    if (contrast(p.theme.text, p.theme.background) < 4.5) add(warnings, 'contrast-text', '正文与背景对比偏低，建议改用深色正文或浅色背景。');
    const estimated = estimateProject(p);
    if (estimated.minutes > p.duration * 1.2) add(warnings, 'duration', '估计讲述时长约 ' + estimated.minutes + ' 分钟，超过目标 ' + p.duration + ' 分钟，请排练后精简。');
    if (estimated.scheduledMinutes > p.duration * 1.1) add(warnings, 'scheduled-duration', '逐页安排合计 ' + estimated.scheduledMinutes + ' 分钟，超过目标 ' + p.duration + ' 分钟，请调整页面时长。');
    const checks = [
      { label: '可编辑结构', ok: !errors.length, detail: '标题、正文、导航、来源与备注作为原生 PPTX 对象导出。' },
      { label: '来源标注', ok: !warnings.some(w => /source|citation/.test(w.code)), detail: '仅检查字段与网址格式，不等于核验论文内容或结论。' },
      { label: '版面负荷', ok: !warnings.some(w => /density|long-title|nav-label/.test(w.code)), detail: '按长度与结构预检，最终需在 PowerPoint/WPS 检查字形和分页。' },
      { label: '演讲时长', ok: !warnings.some(w => w.code === 'duration' || w.code === 'scheduled-duration'), detail: estimated.basis }
    ];
    return { errors, warnings, checks, ...estimated };
  }

  function emptySlide(i, section, title) {
    return { id: 'slide-' + i, type: 'bullets', section, title, subtitle: '', body: [], columns: [], image: null,
      caption: '', citations: [], notes: '', evidence: 'teaching', durationSec: 60 };
  }
  function parseMarkdown(text, scene, givenTitle) {
    if (typeof text !== 'string' || text.length > limits.outlineChars) throw new Error('请导入不超过 120,000 字符的 Markdown 大纲。');
    const activeScene = Object.hasOwn(sceneTemplates, scene) ? scene : 'course';
    const slides = [], warnings = [];
    let title = givenTitle || '未命名汇报', section = sceneTemplates[activeScene].sections[0], current = null, column = null;
    function start(name) { current = emptySlide(slides.length + 1, section, name || '待补充标题'); slides.push(current); column = null; }
    for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const value = line.trim();
      if (!value) continue;
      if (/^```/.test(value)) continue;
      if (/^#\s+/.test(value)) { title = value.replace(/^#\s+/, ''); continue; }
      if (/^##\s+/.test(value)) { start(value.replace(/^##\s+/, '')); continue; }
      if (/^---+$/.test(value)) { current = null; column = null; continue; }
      if (!current) start(slides.length ? '待补充标题' : title);
      const directive = /^@([a-zA-Z]+)\s*:?\s*(.*)$/.exec(value);
      if (directive) {
        const key = directive[1].toLowerCase(), content = directive[2];
        if (key === 'section') { section = content; current.section = content; }
        else if (key === 'type' && types.includes(content)) current.type = content;
        else if (key === 'evidence' && Object.hasOwn(evidenceLabels, content)) current.evidence = content;
        else if (key === 'origin' && sourceOrigins.includes(content)) current.sourceOrigin = content;
        else if (key === 'notes' || key === 'note') current.notes += (current.notes ? '\n' : '') + content;
        else if (key === 'caption') current.caption = content;
        else if (key === 'subtitle') current.subtitle = content;
        else if (key === 'duration') current.durationSec = number(content, 60, 0, 1800);
        else if (key === 'source') {
          const parts = content.split('|').map(x => x.trim());
          const kinds = ['paper', 'data', 'official', 'synthetic'];
          const hasKind = kinds.includes(parts[0]);
          const [sourceTitle, venue, year, url, status] = hasKind ? parts.slice(1) : parts;
          current.citations.push({ kind: hasKind ? parts[0] : 'paper', title: sourceTitle || '', venue: venue || '', year: year || '', url: url || '', status: status || '' });
        } else {
          warnings.push('未识别的大纲指令已保留为正文：' + value);
          if (column) column.body.push(value); else current.body.push(value);
        }
        continue;
      }
      if (/^###\s+/.test(value)) {
        if (current.columns.length >= 2) throw new Error('一个比较页最多包含两个 ### 栏目，请新建页面。');
        current.type = 'comparison'; column = { title: value.replace(/^###\s+/, ''), body: [] }; current.columns.push(column); continue;
      }
      if (/^\|.*\|$/.test(value)) {
        const cells=value.slice(1,-1).split(/(?<!\\)\|/).map(cell=>cell.trim().replace(/\\\|/g,'|').replace(/<br\s*\/?>/gi,'\n'));
        if(cells.every(cell=>/^:?-{2,}:?$/.test(cell)))continue;
        if(!current.table){current.table={columns:cells,rows:[]};current.type='table';}
        else current.table.rows.push(cells);
        continue;
      }
      if (/^>\s?/.test(value)) { current.notes += (current.notes ? '\n' : '') + value.replace(/^>\s?/, ''); continue; }
      const content = value.replace(/^[-*+]\s+/, '').replace(/^\d+[.)、]\s*/, '');
      if (column) column.body.push(content); else current.body.push(content);
    }
    if (!slides.length) throw new Error('没有识别到页面内容。使用 ## 页面标题 和 - 正文条目组织大纲。');
    const result = normalizeProject({ version: 1, title, scene: activeScene, duration: 10, theme: {}, slides });
    if (warnings.length) result.importWarnings = warnings;
    return result;
  }
  function projectToMarkdown(project) {
    const p = normalizeProject(project);
    return '# ' + p.title + '\n\n' + p.slides.map(s => [
      '## ' + s.title, '@type ' + s.type, '@section ' + s.section, '@evidence ' + s.evidence, '@origin ' + s.sourceOrigin,
      s.subtitle ? '@subtitle ' + s.subtitle : '', ...s.body.map(x => '- ' + x),
      ...s.columns.flatMap(c => ['### ' + c.title, ...c.body.map(x => '- ' + x)]),
      ...(s.table?['| '+s.table.columns.map(x=>x.replace(/\|/g,'\\|')).join(' | ')+' |','| '+s.table.columns.map(()=>'---').join(' | ')+' |',...s.table.rows.map(row=>'| '+row.map(x=>x.replace(/\|/g,'\\|').replace(/\n/g,'<br>')).join(' | ')+' |')]:[]),
      s.caption ? '@caption ' + s.caption : '',
      ...s.citations.map(c => '@source ' + [c.kind, c.title, c.venue, c.year, c.url, c.status].join(' | ')),
      ...s.notes.split('\n').filter(Boolean).map(x => '> ' + x)
    ].filter(Boolean).join('\n')).join('\n\n');
  }
  function buildPrompt(project) {
    const p = normalizeProject(project), reference = clone(p);
    reference.slides.forEach(s => { if (s.image) s.image = null; });
    return '你将协助制作一份用于校园场景的中文汇报。请依据我提供的材料完善页面内容，输出严格 JSON，不输出代码围栏或额外说明。\n\n' +
      '场景：' + sceneTemplates[p.scene].label + '。目标时长：' + p.duration + ' 分钟。\n' + sceneTemplates[p.scene].focus + '\n\n' +
      '要求：\n1. 保留 version:1、现有页面 id 与 theme。除非现有内容确需拆页，不任意增删页面。\n' +
      '2. 一页围绕一个具体命题，title 简短，body 为字符串数组。可用 type: cover、section、bullets、comparison、figure、table。比较页用 columns:[{title,body},{title,body}]。\n' +
      '2a. 表格使用 type:table 与 table:{columns:string[],rows:string[][]}，每页最多6列、10行数据；超长表格按语义拆页。正文、栏目与表格单元格可用 **重点短语** 选择性加粗，不要把整段加粗。\n' +
      '2b. 综合现有内容，将非封面页归入4–6个语义章节（section）；较短汇报可更少，最多6个。多页复用同一章节，不以每页标题分别生成导航；章节归并不得删除页面。\n' +
      '3. 只依据提供的资料陈述事实。缺失数字、作者、年份或文献链接保持为空，不补造研究结果、论文或数据。evidence 保留 literature、analysis、hypothesis、plan、teaching 内容性质；另用 sourceOrigin:literature|user|mixed|unknown 判断每页主张属于外部文献、本人/本项目、混合或无法确认。按主张判断，上传者、PDF、DOI、作者的“我们”均不能证明本人归属；本人已发表论文仍属本人工作。纯文献（包括多篇论文）或纯本人工作不反复写归属标签；混合时在对应正文、双栏标题或表格中区分各项归属。保留假说、计划状态与完整引用，不把论文作者的分析或计划写成本人工作。\n' +
      '4. citations 每条使用 {kind,title,venue,year,url,status}。保留完整题名。venue 只填写期刊、机构或平台名，不能包含年份及发表状态。仅该名称在导出时成为超链接。\n' +
      '5. notes 记录讲述顺序、重要限制、读图提示与可能追问，核心不确定性也须保留在正文。\n' +
      '6. 保留已有 figureRef（含 materialId、page 与已验证的 regionId）及 sourceRefs，只引用已提供且已验证的 Figure 区域；缺失引用保持为空，不编造 regionId 或裁剪框，不用整页截图代替 Figure。image 保持 null，不生成图像 URL 或 base64；实际图像由应用依据已保存素材与有效引用绑定。\n' +
      '7. 不把计划写成已完成工作，不把相关性写成因果，不将演示样例当作试点应用成效。\n\n' +
      '当前项目 JSON：\n' + JSON.stringify(reference, null, 2);
  }
  root.CampusPPT = { limits, palettes, visualProfiles, visualProfile, applyVisualProfile, sceneTemplates, types, evidenceLabels, sourceOrigins, sourceOrigin, evidenceLabel, clone, normalizeProject, safeUrl,
    isSafeImageDataUrl, tableLimits,inlineRuns,plainInlineText,renderInlineHtml,normalizeCrop,normalizeTable,navigationSections,
    validateProject, estimateProject, parseMarkdown, projectToMarkdown, buildPrompt, textUnits, contrast };
})(typeof window !== 'undefined' ? window : globalThis);
