/* Editable PPTX export and bounded, local theme-parameter import. */
(function (root) {
  'use strict';
  const C = root.CampusPPT;
  const EMU = 914400;
  const mime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const hex = c => c.replace('#', '');

  function geometry(project) {
    const t = project.theme, profile = C.visualProfile(t), academic = profile.branded;
    const scale = Math.min(t.width / 13.333333, t.height / 7.5);
    const sx = t.width / 13.333333, sy = t.height / 7.5;
    const left = t.nav === 'left' ? (academic ? 1.887 : 1.91) * sx : .69 * sx;
    const right = t.width - (academic ? .492 : .65) * sx;
    const titleY = (t.nav === 'top' ? .96 : academic ? .30 : .43) * sy;
    return { width: t.width, height: t.height, sx, sy, scale, left, right,
      academic, profileId: profile.id, titleY,
      titleW: academic && t.nav !== 'top' && t.showBrand !== false ? 10.75 * sx - left : right - left,
      ruleY: titleY + (academic ? .65 : .79) * sy,
      ruleW: academic ? 2.66 * sx : right - left,
      contentY: (t.nav === 'top' ? 2.0 : academic ? 1.27 : 1.53) * sy,
      contentBottom: t.height - 1.0 * sy, footerY: t.height - .66 * sy,
      fontSize: { title: (academic ? 25.5 : 28) * scale, body: 20 * scale, subtitle: 16 * scale,
        nav: (academic ? 14 : 12) * scale, citation: 9 * scale, caption: 13 * scale,
        page: (academic ? 12 : 9) * scale, cover: 37 * scale } };
  }
  // Shared geometry for the editable PPT and the browser preview.
  function chrome(project, model, sections) {
    const t = project.theme, p = C.visualProfile(t), g = geometry(project);
    const rects = [], images = [], lines = [], navItems = [];
    if (!p.branded) return { rects, images, lines, navItems };
    const rect = (x,y,w,h,color,name) => rects.push({x:x*g.sx,y:y*g.sy,w:w*g.sx,h:h*g.sy,color,name});
    const img = (asset,x,y,w,h,name) => images.push({...asset,x:x*g.sx,y:y*g.sy,w:w*g.sx,h:h*g.sy,name});
    rect(0,7.432,13.333333,.068,t.accent,'AcademicFooterRule');
    rect(0,0,.068,7.5,t.accent,'AcademicEdge');
    if (model.type === 'cover') {
      if (t.showBrand !== false) img(p.wordmark,.69,.35,2.62,.726,'UniversityWordmark');
      return { rects, images, lines, navItems };
    }
    if (t.nav === 'left') {
      rect(.068,0,1.22,7.432,t.navBackground || p.navBackground,'NavigationBackground');
      if (t.showBrand !== false) img(p.seal,.1945,.1184,.9689,.9689,'UniversitySeal');
      const step = Math.min(.96875, 5.6 / Math.max(1,sections.length));
      const labelLines=Math.max(1,...sections.map(section=>wrappedTextLines(section,.9689*g.sx*72*.96,g.fontSize.nav)));
      const neededH=labelLines*g.fontSize.nav*1.15/72/g.sy+.04;
      const itemH = Math.min(step*.85,Math.max(.5729,neededH)), y0 = (7.5-(sections.length-1)*step-itemH)/2;
      sections.forEach((section,i) => {
        const y = y0+i*step, current = section === model.section;
        if (current) rect(.068,y,1.22,itemH,t.accent,'ActiveNavigation');
        navItems.push({section,current,x:.1945*g.sx,y:y*g.sy,w:.9689*g.sx,h:itemH*g.sy,
          color:current?p.activeText:t.accent,fontSize:g.fontSize.nav});
      });
      if (t.showBrand !== false) img(p.wordmark,11.0183,.3272,1.8227,.5055,'UniversityWordmark');
    } else if (t.nav === 'top') {
      rect(.068,0,13.265333,.76,t.navBackground || p.navBackground,'NavigationBackground');
      if (t.showBrand !== false) {
        img(p.seal,.19,.105,.55,.55,'UniversitySeal');
        img(p.wordmark,11.0183,.13,1.8227,.5055,'UniversityWordmark');
      }
      const x0=t.showBrand===false?.69:1.04, end=t.showBrand===false?12.84:10.72, gap=.13;
      const each=(end-x0-Math.max(0,sections.length-1)*gap)/Math.max(1,sections.length);
      sections.forEach((section,i) => {
        const x=x0+i*(each+gap),current=section===model.section;
        if(current)rect(x,.115,each,.53,t.accent,'ActiveNavigation');
        navItems.push({section,current,x:x*g.sx,y:.115*g.sy,w:each*g.sx,h:.53*g.sy,
          color:current?p.activeText:t.accent,fontSize:g.fontSize.nav});
      });
    } else if (t.showBrand !== false) img(p.wordmark,11.0183,.3272,1.8227,.5055,'UniversityWordmark');
    return { rects, images, lines, navItems };
  }
  const brandCache = new Map();
  async function brandData(src, assets) {
    if (assets && Object.hasOwn(assets, src)) {
      if (!C.isSafeImageDataUrl(assets[src])) throw new Error('校标资源格式无效。');
      return assets[src];
    }
    if (brandCache.has(src)) return brandCache.get(src);
    if (!/^\/brand\/zju-(seal|wordmark)\.png$/.test(src)) throw new Error('校标路径无效。');
    const response = await root.fetch(src, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('校标资源未能载入，请刷新页面后再导出。');
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length > 1024*1024) throw new Error('校标资源大小无效。');
    let binary=''; for (let i=0;i<data.length;i++) binary+=String.fromCharCode(data[i]);
    const url='data:image/png;base64,'+root.btoa(binary);
    if (!C.isSafeImageDataUrl(url)) throw new Error('校标资源格式无效。');
    brandCache.set(src,url); return url;
  }
  async function drawChrome(pptx,slide,project,model,g,sections,options) {
    const parts=chrome(project,model,sections);
    parts.rects.forEach(r=>slide.addShape(pptx.ShapeType.rect,{x:r.x,y:r.y,w:r.w,h:r.h,
      line:{color:hex(r.color),transparency:100},fill:{color:hex(r.color)},objectName:r.name}));
    for (const image of parts.images) slide.addImage({data:await brandData(image.src,options && options.brandAssets),x:image.x,y:image.y,w:image.w,h:image.h,altText:image.alt,objectName:image.name});
    parts.navItems.forEach((item,i)=>putText(slide,project,item.section,item.x,item.y,item.w,item.h,item.fontSize,
      {color:hex(item.color),bold:true,align:'center',valign:'mid',objectName:'Navigation '+(i+1)}));
  }
  function line(pptx, slide, x1, y1, x2, y2, color, width) {
    slide.addShape(pptx.ShapeType.line, { x: x1, y: y1, w: x2 - x1, h: y2 - y1, line: { color, width: width || .75 } });
  }
  function baseText(project, extra) {
    return { fontFace: project.theme.font, color: hex(project.theme.text), margin: 0, breakLine: false,
      lang: 'zh-CN', valign: 'top', fit: 'none', ...extra };
  }
  function putText(slide, project, text, x, y, w, h, size, extra) {
    const formatted=typeof text==='string'&&text.includes('**')?C.inlineRuns(text).map(run=>({text:run.text,options:run.bold?{bold:true}:{}})):text;
    slide.addText(formatted || '', baseText(project, { x, y, w, h, fontSize: size, ...extra }));
  }
  function putBody(slide, project, lines, x, y, w, h, size, objectName,layout) {
    if (!lines || !lines.length) return;
    const runs = lines.flatMap((text, i) => {
      const pieces=C.inlineRuns(text);
      return pieces.map((run,j)=>({text:run.text,options:{...(run.bold?{bold:true}:{}),
        ...(layout?{paraSpaceAfter:i<lines.length-1?size*layout.paragraphGap:0}:{}),
        ...(j===0?{bullet:{indent:size*.76},hanging:size*.18,paraSpaceAfterPt:size*.8}:{}),
        breakLine:j===pieces.length-1&&i<lines.length-1}}));
    });
    putText(slide, project, runs, x, y, w, h, size, { paraSpaceAfterPt: size * .7,
      ...(layout?{paraSpaceAfter:0,lineSpacing:size*layout.lineHeight}:{lineSpacingMultiple:1.15}),objectName });
  }
  function drawNavigation(pptx, slide, project, model, g, sections) {
    const t = project.theme;
    if (g.academic || t.nav === 'none' || model.type === 'cover') return;
    if (t.nav === 'top') {
      const gap = .22 * g.sx, navW = g.right - g.left, each = (navW - (sections.length - 1) * gap) / Math.max(1, sections.length);
      sections.forEach((section, i) => {
        const current = section === model.section, x = g.left + i * (each + gap);
        putText(slide, project, section, x, .27 * g.sy, each, .26 * g.sy, g.fontSize.nav, {
          color: current ? hex(t.accent) : '6F7C8C', bold: current, align: 'center', objectName: 'Navigation ' + (i + 1) });
        if (current) line(pptx, slide, x, .68 * g.sy, x + each, .68 * g.sy, hex(t.accent), 2);
      });
      line(pptx, slide, g.left, .72 * g.sy, g.right, .72 * g.sy, 'DEE4EC', .5);
    } else {
      line(pptx, slide, 1.49 * g.sx, .43 * g.sy, 1.49 * g.sx, g.height - .49 * g.sy, 'D8E0E9', .65);
      const step = Math.min(.93 * g.sy, 4.7 * g.sy / Math.max(1, sections.length));
      const y0 = (g.height - sections.length * step) / 2;
      sections.forEach((section, i) => {
        const current = section === model.section;
        putText(slide, project, section, .15 * g.sx, y0 + i * step, 1.2 * g.sx, .58 * g.sy, g.fontSize.nav,
          { color: current ? hex(t.accent) : '768396', bold: current, align: 'center', valign: 'mid', objectName: 'Navigation ' + (i + 1) });
        if (current) line(pptx, slide, .29 * g.sx, y0 + i * step + .63 * g.sy, 1.18 * g.sx, y0 + i * step + .63 * g.sy, hex(t.accent), 2);
      });
    }
  }
  function citationRuns(citations, project) {
    const runs = [];
    citations.forEach((c, i) => {
      const prefix = c.kind === 'data' ? '数据来源：' : c.kind === 'official' ? '官方来源：' : c.kind === 'synthetic' ? '教学示例：' : '';
      if (prefix) runs.push({ text: prefix, options: { color: hex(project.theme.accent), bold: c.kind !== 'synthetic' } });
      if (c.title) runs.push({ text: c.title + (c.venue ? ' | ' : ''), options: {} });
      if (c.venue) {
        const options = { bold: true, underline: { style: 'none' }, color: hex(project.theme.accent) };
        if (C.safeUrl(c.url)) options.hyperlink = { url: C.safeUrl(c.url), tooltip: c.venue };
        runs.push({ text: c.venue, options });
      }
      const suffix = [c.year ? ', ' + c.year : '', c.status ? ' ' + c.status : '', (c.year || c.venue || c.title) ? '.' : ''].join('');
      runs.push({ text: suffix, options: { breakLine: i < citations.length - 1 } });
    });
    return runs;
  }
  function citationHeight(model, g) {
    if (!model.citations.length) return .35 * g.sy;
    const capacity = (g.right - g.left - .7 * g.sx) * 72 / g.fontSize.citation;
    const lines = model.citations.reduce((n, c) => n + Math.max(1, Math.ceil((c.title.length + c.venue.length + c.year.length + c.status.length + 10) / capacity)), 0);
    return Math.max(.35 * g.sy, Math.min(1.55 * g.sy, lines * g.fontSize.citation * 1.3 / 72));
  }
  function drawFooter(pptx, slide, project, model, g, index, total) {
    const footerHeight = citationHeight(model, g);
    const bottom = g.height - .26 * g.sy;
    if (model.citations.length) {
      putText(slide, project, citationRuns(model.citations, project), g.left, bottom - footerHeight,
        g.right - g.left - .7 * g.sx, footerHeight, g.fontSize.citation, { valign: 'bottom', objectName: 'ReferenceFooter',
          paraSpaceAfterPt: 1.5 * g.scale, lineSpacingMultiple: 1.05 });
    }
    putText(slide, project, String(index + 1).padStart(2, '0') + ' / ' + String(total).padStart(2, '0'),
      g.right - .65 * g.sx, bottom - .24 * g.sy, .65 * g.sx, .22 * g.sy, g.fontSize.page,
      { align: 'right', color: '738196', objectName: 'PageNumber' });
  }
  function fitImage(width, height, box) {
    const factor = Math.min(box.w / width, box.h / height);
    const w = width * factor, h = height * factor;
    return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
  }
  function figurePlacement(image,width,height,box){
    const crop=C.normalizeCrop(image.crop),region=crop||{x:0,y:0,w:1,h:1};
    const fitted=fitImage(width*region.w,height*region.h,box);
    const fullW=fitted.w/region.w,fullH=fitted.h/region.h;
    return {...fitted,crop,fullW,fullH,offsetX:region.x*fullW,offsetY:region.y*fullH,
      ...(crop?{pptxSizing:{type:'crop',x:region.x*fullW,y:region.y*fullH,w:fitted.w,h:fitted.h}}:{})};
  }
  function wrappedTextLines(value,availablePoints,fontSize){
    let lines=1,used=0;
    const width=character=>/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(character)?1:
      /\s/.test(character)?.31:/[A-Z]/.test(character)?.63:/[0-9]/.test(character)?.54:
      /[.,:;!|'`]/.test(character)?.28:/[il]/.test(character)?.25:/[mw]/.test(character)?.74:.51;
    for(const run of C.inlineRuns(value)){
      const factor=run.bold?1.04:1;
      for(const token of run.text.match(/\r\n|\r|\n|[^\S\r\n]+|[A-Za-z0-9_\u00c0-\u024f\u0370-\u03ff]+(?:\.[A-Za-z0-9_\u00c0-\u024f\u0370-\u03ff]+)*|./gu)||[]){
        if(/^[\r\n]+$/.test(token)){lines++;used=0;continue;}
        const whitespace=/^\s+$/.test(token),characters=[...token];
        const points=characters.reduce((n,character)=>n+width(character)*fontSize*factor,0);
        if(whitespace&&used===0)continue;
        if(used>0&&used+points>availablePoints+.001){lines++;used=0;if(whitespace)continue;}
        if(points<=availablePoints+.001){used+=points;continue;}
        for(const character of characters){
          const characterPoints=width(character)*fontSize*factor;
          if(used>0&&used+characterPoints>availablePoints+.001){lines++;used=0;}
          used+=characterPoints;
        }
      }
    }
    return lines;
  }
  function titleGeometry(value,g){
    // All body slides share one title band and divider baseline. Fit the complete
    // heading inside that band instead of moving the divider/content for a wrap.
    // Keep the width allowance for bold mixed-language glyphs and the wordmark.
    const h=g.ruleY-g.titleY-.03*g.sy,minSize=g.fontSize.title*.78;
    const available=g.titleW*72*.9,padding=.05*g.sy;
    const steps=Math.ceil((g.fontSize.title-minSize)/(.5*g.scale));
    let fontSize=g.fontSize.title,lines=1,lineHeight=1.15;
    for(const maxLines of [1,2]){
      lineHeight=maxLines===1?1.15:1;
      for(let step=0;step<=steps;step++){
        fontSize=Math.max(minSize,g.fontSize.title-step*.5*g.scale);
        lines=wrappedTextLines(value,available,fontSize);
        if(lines<=maxLines&&lines*fontSize*lineHeight/72+padding<=h+.0001){
          return {fontSize,lines,lineHeight,h,ruleY:g.ruleY,contentY:g.contentY,overflow:false};
        }
      }
    }
    return {fontSize,lines,lineHeight,h,ruleY:g.ruleY,contentY:g.contentY,overflow:true};
  }
  function figureBodyGeometry(body,box,scale=1){
    const lineHeight=1.15,paragraphGap=.7,bulletIndent=1.05,hanging=.08;
    let fontSize=18*scale,height=0,lines=0;
    for(let step=0;step<=8;step++){
      fontSize=(18-step*.5)*scale;
      const available=Math.max(12,box.w*72-fontSize*(bulletIndent+hanging));
      lines=body.reduce((n,value)=>n+wrappedTextLines(value,available,fontSize),0);
      height=(lines*fontSize*lineHeight+Math.max(0,body.length-1)*fontSize*paragraphGap)/72+.04*scale;
      if(height<=box.h+.0001)break;
    }
    return {fontSize,lineHeight,paragraphGap,bulletIndent,hanging,height,lines,overflow:height>box.h+.0001};
  }
  function tableGeometry(table,box,scale=1){
    const all=[table.columns,...table.rows],padding=5*scale;
    const units=value=>[...C.plainInlineText(value)].reduce((n,c)=>n+(/[\u3400-\u9fff]/.test(c)?1:/\s/.test(c)?.28:.53),0);
    const weights=table.columns.map((_c,index)=>Math.sqrt(Math.max(4,Math.min(50,Math.max(...all.map(row=>units(row[index])))))));
    const total=weights.reduce((a,b)=>a+b,0),colW=weights.map(weight=>box.w*weight/total);
    let fontSize=18*scale,rowH=[],height=0;
    for(let step=0;step<=6;step++){
      fontSize=(18-step)*scale;
      rowH=all.map(row=>Math.max(.34*scale,...row.map((cell,index)=>{
        const available=Math.max(12,colW[index]*72-padding*2);
        const lines=wrappedTextLines(cell,available*.9,fontSize);
        return lines*fontSize*1.18/72+padding*2/72;
      })));
      height=rowH.reduce((a,b)=>a+b,0);
      if(height<=box.h+.0001)break;
    }
    return {fontSize,colW,rowH,height,padding,overflow:height>box.h+.0001};
  }
  function putTable(slide,project,table,box,scale){
    const layout=tableGeometry(table,box,scale);
    if(layout.overflow)throw new Error('本页表格超出可读范围，请将表格拆分为多页后导出。');
    const rows=[table.columns,...table.rows].map((row,index)=>row.map(cell=>({
      text:C.inlineRuns(cell).map(run=>({text:run.text,options:run.bold?{bold:true}:{}})),
      options:{...(index===0?{bold:true,color:hex(project.theme.accent),fill:hex(project.theme.navBackground||'#EBF4FC')}:{}),
        margin:layout.padding}
    })));
    slide.addTable(rows,baseText(project,{x:box.x,y:box.y,w:box.w,h:layout.height,fontSize:layout.fontSize,
      colW:layout.colW,rowH:layout.rowH,margin:layout.padding,border:{type:'solid',pt:.6,color:'CCD5E0'},
      autoPage:false,objectName:'EditableEvidenceTable'}));
    return layout;
  }
  async function imageDimensions(image) {
    if (!C.isSafeImageDataUrl(image.dataUrl)) throw new Error('图片格式无效，导出仅支持本地 PNG/JPEG。');
    if (typeof root.Image === 'function') {
      return new Promise((resolve, reject) => {
        const img = new root.Image();
        img.onload = () => img.naturalWidth > 0 && img.naturalHeight > 0
          ? resolve({ width: img.naturalWidth, height: img.naturalHeight }) : reject(new Error('图片尺寸无效。'));
        img.onerror = () => reject(new Error('图片无法解码，请重新选择 PNG/JPEG。'));
        img.src = image.dataUrl;
      });
    }
    // Node-only checks use explicitly supplied dimensions; browser export always decodes pixels.
    if (image.width > 0 && image.height > 0) return { width: image.width, height: image.height };
    throw new Error('图片缺少尺寸信息。');
  }

  async function exportPptx(raw, options) {
    if (typeof root.PptxGenJS !== 'function') throw new Error('离线导出组件未加载，请保留 vendor 文件夹后重新打开。');
    const review = C.validateProject(raw);
    if (review.errors.length) throw new Error(review.errors.map(e => e.message).join('\n'));
    const project = C.normalizeProject(raw), pptx = new root.PptxGenJS(), g = geometry(project);
    const sections = C.navigationSections(project);
    pptx.defineLayout({ name: 'CAMPUS', width: g.width, height: g.height });
    pptx.layout = 'CAMPUS';
    pptx.author = project.presenter || '求是·汇报用户'; pptx.subject = C.sceneTemplates[project.scene].label;
    pptx.title = project.title; pptx.company = '求是·汇报'; pptx.lang = 'zh-CN';
    pptx.theme = { headFontFace: project.theme.font, bodyFontFace: project.theme.font, lang: 'zh-CN' };
    for (let i = 0; i < project.slides.length; i++) {
      const model = project.slides[i], slide = pptx.addSlide();
      slide.background = { color: hex(project.theme.background) };
      await drawChrome(pptx, slide, project, model, g, sections, options);
      drawNavigation(pptx, slide, project, model, g, sections);
      const footerHeight = citationHeight(model, g), bottom = Math.min(g.contentBottom, g.height - footerHeight - .47 * g.sy);
      const contentW = g.right - g.left;
      if (model.type === 'cover') {
        const coverLeft = .95 * g.sx;
        putText(slide, project, C.sceneTemplates[project.scene].label, coverLeft, 1.20 * g.sy, g.width - 2 * coverLeft,
          .4 * g.sy, 14 * g.scale, { color: hex(project.theme.accent), objectName: 'CoverScene' });
        putText(slide, project, model.title || project.title, coverLeft, 2.1 * g.sy, g.width - 2 * coverLeft,
          1.53 * g.sy, g.fontSize.cover, { bold: true, color: hex(project.theme.accent), objectName: 'CoverTitle' });
        putText(slide, project, model.subtitle || project.subtitle, coverLeft, 3.88 * g.sy, g.width - 2 * coverLeft,
          .8 * g.sy, 19 * g.scale, { objectName: 'CoverSubtitle' });
        line(pptx, slide, coverLeft, 5.12 * g.sy, g.width - coverLeft, 5.12 * g.sy, 'C5D0DE', .8);
        putText(slide, project, project.presenter, coverLeft, 5.6 * g.sy, g.width - 2 * coverLeft,
          .4 * g.sy, 16 * g.scale, { color: '5E6D7F', objectName: 'Presenter' });
      } else if (model.type === 'section') {
        const n = Math.max(1, sections.indexOf(model.section) + 1);
        putText(slide, project, String(n).padStart(2, '0'), g.left, 2.15 * g.sy, 1.1 * g.sx, .75 * g.sy,
          35 * g.scale, { color: hex(project.theme.secondary), objectName: 'SectionNumber' });
        putText(slide, project, model.title, g.left + 1.35 * g.sx, 2.16 * g.sy, contentW - 1.35 * g.sx,
          1.1 * g.sy, 32 * g.scale, { color: hex(project.theme.accent), bold: true, objectName: 'SectionTitle' });
        putText(slide, project, model.subtitle, g.left + 1.35 * g.sx, 3.53 * g.sy, contentW - 1.35 * g.sx,
          1.0 * g.sy, 20 * g.scale, { objectName: 'SectionSubtitle' });
        if (model.body.length) putBody(slide, project, model.body, g.left + 1.35 * g.sx, 4.63 * g.sy,
          contentW - 1.35 * g.sx, bottom - 4.63 * g.sy, 18 * g.scale, 'SectionBody');
      } else {
        const titleLayout=titleGeometry(model.title,g);
        if(titleLayout.overflow)throw new Error('页面标题在可读字号下仍过长，请拆为标题与副标题后导出。');
        putText(slide, project, model.title, g.left, g.titleY, g.titleW, titleLayout.h,
          titleLayout.fontSize, { color: hex(project.theme.accent), bold: true, lineSpacing:titleLayout.fontSize*titleLayout.lineHeight,objectName: 'SlideTitle' });
        line(pptx, slide, g.left, titleLayout.ruleY, g.left + g.ruleW, titleLayout.ruleY, g.academic ? hex(project.theme.accent) : 'D8E1EC', .7);
        if (g.academic) line(pptx, slide, g.left, titleLayout.ruleY, g.left + .645 * g.sx, titleLayout.ruleY, hex(project.theme.accent), 3);
        let y = titleLayout.contentY;
        if (model.subtitle) {
          putText(slide, project, model.subtitle, g.left, y, contentW, .46 * g.sy, g.fontSize.subtitle, { color: '68778A', objectName: 'Subtitle' });
          y += .64 * g.sy;
        }
        const evidenceLabel = C.evidenceLabel(project, model);
        if (evidenceLabel) {
          putText(slide, project, evidenceLabel, g.left, y, contentW, .28 * g.sy, 11 * g.scale,
            { color: hex(project.theme.accent), objectName: 'EvidenceStatus' }); y += .44 * g.sy;
        }
        if (model.type === 'comparison') {
          const gap = .57 * g.sx, colW = (contentW - gap) / 2;
          if (model.body.length) {
            putBody(slide, project, model.body, g.left, y, contentW, .7 * g.sy, g.fontSize.subtitle, 'ComparisonIntro'); y += .83 * g.sy;
          }
          const columns = model.columns.length ? model.columns : [{ title: '左侧栏目', body: [] }, { title: '右侧栏目', body: [] }];
          columns.forEach((c, idx) => {
            const x = g.left + idx * (colW + gap);
            putText(slide, project, c.title, x, y, colW, .57 * g.sy, 22 * g.scale,
              { bold: true, color: hex(project.theme.accent), objectName: 'ColumnTitle ' + (idx + 1) });
            line(pptx, slide, x, y + .72 * g.sy, x + colW, y + .72 * g.sy, 'D5DFE9', .65);
            putBody(slide, project, c.body, x, y + 1.0 * g.sy, colW, Math.max(.3, bottom - y - 1.0 * g.sy),
              g.fontSize.body, 'ColumnBody ' + (idx + 1));
          });
        } else if (model.type === 'table') {
          if(model.body.length){
            putBody(slide,project,model.body,g.left,y,contentW,.7*g.sy,g.fontSize.subtitle,'TableIntro');y+=.83*g.sy;
          }
          const captionH=model.caption ? .55*g.sy : 0;
          putTable(slide,project,model.table,{x:g.left,y,w:contentW,h:Math.max(.4,bottom-y-captionH)},g.scale);
          if(model.caption)putText(slide,project,model.caption,g.left,bottom-captionH+.06*g.sy,contentW,
            captionH-.06*g.sy,g.fontSize.caption,{objectName:'TableCaption'});
        } else if (model.type === 'figure') {
          const hasBody = model.body.length > 0, figW = hasBody ? contentW * .61 : contentW;
          const captionH = model.caption ? .85 * g.sy : 0;
          const box = { x: g.left, y, w: figW, h: Math.max(.4, bottom - y - captionH) };
          if (model.image) {
            const dimensions = await imageDimensions(model.image);
            const placed=figurePlacement(model.image,dimensions.width,dimensions.height,box);
            slide.addImage({ data: model.image.dataUrl,x:placed.x,y:placed.y,w:placed.fullW,h:placed.fullH,
              ...(placed.pptxSizing?{sizing:placed.pptxSizing}:{}),
              altText: model.image.alt || model.caption || '汇报图像', objectName: 'EvidenceFigure' });
          } else {
            putText(slide, project, '添加本页图像', box.x, box.y + box.h / 2 - .4 * g.sy, box.w, .45 * g.sy,
              20 * g.scale, { align: 'center', color: '6D7E94', objectName: 'ImagePlaceholder' });
            putText(slide, project, '在应用中选择 PNG 或 JPEG', box.x, box.y + box.h / 2 + .12 * g.sy, box.w, .4 * g.sy,
              12 * g.scale, { align: 'center', color: '6D7E94', objectName: 'ImagePlaceholderHint' });
          }
          if (model.caption) putText(slide, project, model.caption, box.x, bottom - captionH + .11 * g.sy, box.w,
            captionH - .11 * g.sy, g.fontSize.caption, { align: 'center', objectName: 'FigureCaption' });
          if (hasBody) {
            const bodyBox={x:g.left+figW+.43*g.sx,y:y+.15*g.sy,w:contentW-figW-.43*g.sx,h:bottom-y-.15*g.sy};
            const layout=figureBodyGeometry(model.body,bodyBox,g.scale);
            if(layout.overflow)throw new Error('图文页的全部正文在 14 磅下仍超出可读范围，请拆分页面后导出。');
            putBody(slide,project,model.body,bodyBox.x,bodyBox.y,bodyBox.w,bodyBox.h,layout.fontSize,'FigureExplanation',layout);
          }
        } else {
          putBody(slide, project, model.body, g.left, y + .12 * g.sy, contentW, Math.max(.4, bottom - y - .12 * g.sy),
            g.fontSize.body, 'BodyText');
        }
      }
      drawFooter(pptx, slide, project, model, g, i, project.slides.length);
      const sources = model.citations.map(c => [c.kind === 'synthetic' ? '合成教学材料' : '来源', c.title, c.venue, c.year, c.status, c.url].filter(Boolean).join('；'));
      slide.addNotes([model.notes, sources.length ? '\n来源记录：\n' + sources.join('\n') : ''].filter(Boolean).join('\n'));
    }
    const result = await pptx.write({ outputType: 'blob', compression: true });
    return finalizePptxPackage(result instanceof Blob ? result : new Blob([result], { type: mime }));
  }

  /** PptxGenJS 4.0.1 declares one slide master per slide but writes only master1.
   * Repair that exporter metadata defect, then verify the complete package.
   * Repeated paragraph properties from rich runs are reduced to the first
   * paragraph-level style. Text runs, notes, native tables and media survive. */
  async function finalizePptxPackage(input) {
    let Zip=root.JSZip;
    if(typeof Zip!=='function'&&root.process?.versions?.node)Zip=(await import('jszip')).default;
    if(typeof Zip!=='function')throw new Error('PPTX 结构检查组件未加载，请保留 vendor 文件夹后重新打开。');
    const bytes=input instanceof Blob?await input.arrayBuffer():input,zip=await Zip.loadAsync(bytes);
    const exists=name=>!!zip.file(name),xmlByPart=new Map(),relationIds=new Map();
    const xml=async name=>{if(!xmlByPart.has(name))xmlByPart.set(name,await zip.file(name).async('string'));return xmlByPart.get(name);};
    const attrs=tag=>Object.fromEntries([...tag.matchAll(/([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].map(m=>[m[1],m[3]
      .replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')]));
    const resolve=(base,target)=>{
      if(typeof target!=='string'||/[\\\u0000]/.test(target)||/^[a-z][\w+.-]*:/i.test(target))throw new Error('PPTX 关系路径无效，导出已停止。');
      const clean=target.split('#')[0];if(!clean)return base;
      const parts=clean.startsWith('/')?[]:base.split('/').slice(0,-1);
      for(const bit of clean.split('/')){if(!bit||bit==='.')continue;if(bit==='..'){if(!parts.length)throw new Error('PPTX 关系超出文件范围，导出已停止。');parts.pop();}
        else parts.push(bit);}
      return parts.join('/');
    };
    if(!exists('[Content_Types].xml'))throw new Error('PPTX 缺少组件类型声明，导出已停止。');
    const originalTypes=await xml('[Content_Types].xml');let removed=0,paragraphRepairs=0;
    const types=originalTypes.replace(/<Override\b[^>]*\/>/g,tag=>{
      const item=attrs(tag),name=item.PartName?.replace(/^\//,''),master=/^ppt\/slideMasters\/slideMaster(\d+)\.xml$/.exec(name||'');
      if(master&&Number(master[1])>=2&&!exists(name)){removed++;return '';}
      return tag;
    });
    const declared=new Set(),extensions=new Set();
    for(const match of types.matchAll(/<Override\b[^>]*\/>/g)){
      const item=attrs(match[0]),name=item.PartName?.replace(/^\//,'');
      if(!name||!item.ContentType||!exists(name)||declared.has(name))throw new Error('PPTX 组件声明指向不存在或重复的部件，导出已停止。');
      declared.add(name);
    }
    for(const match of types.matchAll(/<Default\b[^>]*\/>/g)){const item=attrs(match[0]);if(item.Extension)extensions.add(item.Extension.toLowerCase());}
    for(const [name,entry]of Object.entries(zip.files)){
      if(entry.dir||name==='[Content_Types].xml')continue;
      if(!declared.has(name)&&!extensions.has(name.split('.').at(-1).toLowerCase()))throw new Error('PPTX 部件缺少类型声明，导出已停止。');
      if(/^ppt\/(?:slides|slideLayouts|slideMasters|notesSlides|notesMasters|theme)\/[^/]+\.xml$/.test(name)&&!declared.has(name))
        throw new Error('PPTX 页面或母版缺少类型声明，导出已停止。');
      if(!name.endsWith('.rels'))continue;
      const owner=name==='_rels/.rels'?'':name.replace(/(^|\/)\_rels\/([^/]+)\.rels$/,'$1$2');
      if(owner&&(!exists(owner)||owner===name))throw new Error('PPTX 关系所属部件不存在，导出已停止。');
      const ids=new Set();relationIds.set(owner,ids);
      for(const match of (await xml(name)).matchAll(/<Relationship\b[^>]*\/>/g)){
        const item=attrs(match[0]);if(!item.Id||ids.has(item.Id)||!item.Target||!item.Type)throw new Error('PPTX 关系声明无效或重复，导出已停止。');
        ids.add(item.Id);if(item.TargetMode==='External')continue;
        if(!exists(resolve(owner,item.Target)))throw new Error('PPTX 关系指向不存在的部件，导出已停止。');
      }
    }
    for(const [name,entry]of Object.entries(zip.files)){
      if(entry.dir||!name.endsWith('.xml')||name==='[Content_Types].xml')continue;
      const ids=relationIds.get(name)||new Set(),source=await xml(name);
      // PptxGenJS 4.0.1 repeats a:pPr before each rich text run. DrawingML
      // permits it once at the paragraph start; later buNone also hides bullets.
      const normalized=source.replace(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g,paragraph=>{
        let first=true;return paragraph.replace(/<a:pPr\b[^>]*(?:\/>|>[\s\S]*?<\/a:pPr>)/g,properties=>{
          if(first){first=false;return properties;}paragraphRepairs++;return '';
        });
      });
      if(normalized!==source)zip.file(name,normalized);
      for(const tag of normalized.matchAll(/<[^>]+>/g))for(const match of tag[0].matchAll(/\br:(?:id|embed|link)\s*=\s*(["'])(.*?)\1/g))
        if(!ids.has(match[2]))throw new Error('PPTX 页面引用了不存在的关系，导出已停止。');
    }
    if(!removed&&!paragraphRepairs)return input instanceof Blob?input:new Blob([bytes],{type:mime});
    zip.file('[Content_Types].xml',types);
    return new Blob([await zip.generateAsync({type:'uint8array',compression:'DEFLATE'})],{type:mime});
  }

  function zipPreflight(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (!bytes.length || bytes.length > C.limits.templateBytes) throw new Error('模板须小于 25 MB。');
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), min = Math.max(0, bytes.length - 65557);
    let eocd = -1;
    for (let p = bytes.length - 22; p >= min; p--) if (v.getUint32(p, true) === 0x06054b50 && p + 22 + v.getUint16(p + 20, true) === bytes.length) { eocd = p; break; }
    if (eocd < 0) throw new Error('文件不是可识别的 PPTX 压缩包。');
    const count = v.getUint16(eocd + 10, true), size = v.getUint32(eocd + 12, true), offset = v.getUint32(eocd + 16, true);
    if (count === 65535 || offset === 0xffffffff || size === 0xffffffff) throw new Error('当前原型不支持 ZIP64 模板。');
    if (v.getUint16(eocd + 4, true) || v.getUint16(eocd + 6, true) || count !== v.getUint16(eocd + 8, true)) throw new Error('不支持分卷压缩的模板。');
    if (!count || count > 4000 || offset + size > eocd) throw new Error('模板内部结构过大或损坏。');
    let p = offset, total = 0; const names = new Set();
    for (let i = 0; i < count; i++) {
      if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw new Error('模板目录损坏。');
      const compressed = v.getUint32(p + 20, true), expanded = v.getUint32(p + 24, true), nameLength = v.getUint16(p + 28, true);
      const extraLength = v.getUint16(p + 30, true), commentLength = v.getUint16(p + 32, true), flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true);
      if (p + 46 + nameLength + extraLength + commentLength > offset + size) throw new Error('模板目录范围无效。');
      const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(p + 46, p + 46 + nameLength));
      if (flags & 1 || ![0, 8].includes(method)) throw new Error('不支持加密或特殊压缩方式的模板。');
      if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || name.includes('\0') || names.has(name)) throw new Error('模板包含不安全或重复的内部文件名。');
      names.add(name); total += expanded;
      if (compressed === 0xffffffff || expanded === 0xffffffff || total > 200 * 1024 * 1024) throw new Error('模板解压尺寸过大。');
      if (/\.(xml|rels)$/i.test(name) && (expanded > 2 * 1024 * 1024 || expanded > Math.max(1, compressed) * 400)) throw new Error('模板 XML 结构过大，请使用精简模板。');
      p += 46 + nameLength + extraLength + commentLength;
    }
    return bytes;
  }
  function readBounded(entry) {
    return new Promise((resolve, reject) => {
      const chunks = []; let total = 0, failed = false;
      const stream = entry.internalStream('uint8array');
      stream.on('data', chunk => {
        if (failed) return; total += chunk.length;
        if (total > 2 * 1024 * 1024) { failed = true; stream.pause(); reject(new Error('模板 XML 解压超过安全大小。')); return; }
        chunks.push(chunk);
      }).on('error', err => { if (!failed) reject(err); }).on('end', () => {
        if (failed) return; const all = new Uint8Array(total); let offset = 0;
        chunks.forEach(c => { all.set(c, offset); offset += c.length; });
        try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(all)); } catch (_) { reject(new Error('模板 XML 编码无效。')); }
      }).resume();
    });
  }
  async function xmlPart(zip, path, optional) {
    const entry = zip.file(path);
    if (!entry) { if (optional) return null; throw new Error('模板缺少必要结构：' + path); }
    const text = await readBounded(entry);
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('模板包含不支持的 XML 实体声明。');
    const doc = new root.DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length || doc.documentElement.localName === 'parsererror') throw new Error('模板 XML 无法解析。');
    return doc;
  }
  function node(parent, local) { return parent && parent.getElementsByTagNameNS('*', local)[0] || null; }
  function resolvePart(base, target) {
    if (!target || /[\\:\u0000]/.test(target) || target.startsWith('/')) throw new Error('模板关系指向不支持的路径。');
    const bits = base.split('/').slice(0, -1);
    target.split('/').forEach(b => { if (b === '..') { if (!bits.length) throw new Error('模板关系超出包内范围。'); bits.pop(); } else if (b !== '.' && b) bits.push(b); });
    return bits.join('/');
  }
  async function readTemplate(arrayBuffer, fileName) {
    if (typeof root.JSZip !== 'function' || typeof root.DOMParser !== 'function') throw new Error('模板读取组件未加载。');
    if (fileName && !/\.pptx$/i.test(fileName)) throw new Error('请选择 .pptx 格式模板。');
    const bytes = zipPreflight(arrayBuffer), zip = await root.JSZip.loadAsync(bytes);
    if (Object.keys(zip.files).some(x => /vbaproject\.bin$/i.test(x))) throw new Error('请使用不包含宏的 PPTX 模板。');
    const presentation = await xmlPart(zip, 'ppt/presentation.xml'), rels = await xmlPart(zip, 'ppt/_rels/presentation.xml.rels');
    const size = node(presentation, 'sldSz');
    if (!size) throw new Error('模板未定义页面尺寸。');
    const width = Number(size.getAttribute('cx')) / EMU, height = Number(size.getAttribute('cy')) / EMU;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 6 || width > 20 || height < 4 || height > 15) throw new Error('当前原型支持宽 6–20 英寸、高 4–15 英寸的幻灯片。');
    const warnings = ['本版读取主题字体、主题色和页面尺寸。母版布局、校标、背景图、占位符及动画需后续适配。'];
    const masterId = node(presentation, 'sldMasterId');
    const rid = masterId && (masterId.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || masterId.getAttribute('r:id'));
    const masterRel = Array.from(rels.getElementsByTagNameNS('*', 'Relationship')).find(r => r.getAttribute('Id') === rid && r.getAttribute('TargetMode') !== 'External');
    let themePath;
    if (masterRel) {
      const master = resolvePart('ppt/presentation.xml', masterRel.getAttribute('Target'));
      const parts = master.split('/'), base = parts.pop();
      const mr = await xmlPart(zip, parts.join('/') + '/_rels/' + base + '.rels', true);
      const tr = mr && Array.from(mr.getElementsByTagNameNS('*', 'Relationship')).find(r => /\/theme$/.test(r.getAttribute('Type') || '') && r.getAttribute('TargetMode') !== 'External');
      if (tr) themePath = resolvePart(master, tr.getAttribute('Target'));
    }
    if (!themePath) {
      themePath = Object.keys(zip.files).filter(x => /^ppt\/theme\/[^/]+\.xml$/.test(x)).sort()[0];
      warnings.push('未能关联首个母版，改取包内首个主题。请核对提取结果。');
    }
    if (!themePath) throw new Error('模板没有可读取的主题。');
    const theme = await xmlPart(zip, themePath), scheme = node(theme, 'clrScheme'), fonts = node(theme, 'fontScheme');
    function colorAt(name, fallback) {
      const parent = node(scheme, name), srgb = node(parent, 'srgbClr'), sys = node(parent, 'sysClr');
      const value = srgb && srgb.getAttribute('val') || sys && sys.getAttribute('lastClr');
      return /^[0-9a-fA-F]{6}$/.test(value || '') ? '#' + value.toUpperCase() : fallback;
    }
    const minor = node(fonts, 'minorFont'), major = node(fonts, 'majorFont');
    function fontAt(fontRoot) {
      if (!fontRoot) return '';
      const hans = Array.from(fontRoot.getElementsByTagNameNS('*', 'font')).find(n => n.getAttribute('script') === 'Hans');
      const ea = node(fontRoot, 'ea'), latin = node(fontRoot, 'latin');
      return hans && hans.getAttribute('typeface') || ea && ea.getAttribute('typeface') || latin && latin.getAttribute('typeface') || '';
    }
    const font = fontAt(minor) || fontAt(major) || '华文楷体';
    if (font.length > 100 || /[<>"'&\u0000-\u001F]/.test(font)) throw new Error('模板字体名称无效。');
    if (Object.keys(zip.files).filter(x => /^ppt\/theme\/[^/]+\.xml$/.test(x)).length > 1) warnings.push('模板含多个主题，本次只读取首个母版对应主题。');
    warnings.push('读取字体名称不代表设备已安装该字体，实际显示与导出需在本机核对。');
    return { fileName: String(fileName || 'template.pptx').replace(/[\u0000-\u001F]/g, ''), scope: 'style-parameters',
      theme: { font, accent: colorAt('accent1', '#074591'), secondary: colorAt('accent2', '#8C9CAD'), width, height }, warnings };
  }
  root.CampusPPTExport = { exportPptx, finalizePptxPackage, readTemplate, geometry, chrome, fitImage, figurePlacement,titleGeometry,figureBodyGeometry,tableGeometry,citationRuns, zipPreflight };
})(typeof window !== 'undefined' ? window : globalThis);
