(function () {
  'use strict';
  const Core = window.CampusPPT;
  const Export = window.CampusPPTExport;
  const Navigation = window.CampusPPTNavigation;
  let activePage = Navigation.resolve(window.location.pathname);
  let generationController = null;
  const STORAGE_PREFIX = 'qiushi-presentation-workspace-v1:';
  const typeNames = {cover:'封面',section:'章节页',bullets:'要点页',comparison:'双栏对照',figure:'图文页',table:'表格页'};
  const evidenceNames = {teaching:'教学内容',literature:'文献结果',analysis:'本项目分析',hypothesis:'待检验假说',plan:'后续计划'};
  const originNames = {literature:'文献 / 外部资料',user:'本人 / 本项目',mixed:'文献与本人工作',unknown:'尚未确认'};
  const sourceKinds = {paper:'论文',data:'数据来源',official:'官方材料',synthetic:'教学示例'};
  const iconPaths = {
    download:'M8 2v8m-3-3 3 3 3-3M3 11v3h10v-3',
    spark:'m8 1 1.6 4.8L14 8l-4.4 1.6L8 15l-1.6-5.4L2 8l4.4-2.2L8 1Z',
    plus:'M8 3v10M3 8h10',
    upload:'M8 11V2M4 6l4-4 4 4M2 11v3h12v-3',
    close:'m3 3 10 10M13 3 3 13',
    copy:'M6 2h8v9H6zM3 5H2v9h9v-1',
    undo:'M5 3 2 6l3 3M2 6h7a4 4 0 0 1 0 8',
    arrowUp:'M8 13V3m-4 4 4-4 4 4',
    arrowDown:'M8 3v10m-4-4 4 4 4-4',
    file:'M3 1h6l4 4v10H3V1Zm6 0v4h4M5 8h6M5 11h4',
    check:'m3 8 3 3 7-7',
    trash:'M2 4h12M5 4V2h6v2M4 4l1 10h6l1-10M7 7v4M9 7v4',
    image:'M2 2h12v12H2V2Zm0 10 4-5 3 4 2-2 3 3M10 5h.01'
    ,user:'M11 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM2 15v-2a6 6 0 0 1 12 0v2',
    cloud:'M4 12a3 3 0 0 1-.3-6A4.3 4.3 0 0 1 12 5a3.5 3.5 0 0 1 0 7M8 15V8m-3 3 3-3 3 3'
  };
  function icon(name) { return '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="'+(iconPaths[name]||iconPaths.file)+'"/></svg>'; }
  const h = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clone = value => JSON.parse(JSON.stringify(value));
  function validColor(v, fallback) { return /^#[0-9a-f]{6}$/i.test(v||'') ? v : fallback; }
  function cleanFont(v) { return String(v||'华文楷体').replace(/[;{}<>"'\\]/g,''); }
  const blankProject = () => Core.normalizeProject({version:1,title:'未命名汇报',scene:'lab',theme:Core.applyVisualProfile({},'zju-academic'),slides:[]});
  let project = blankProject();
  let session = {user:null,model:{configured:false},ocr:{configured:false},limits:{maxFileMB:200,maxFiles:null,chunkMB:8,pdfParseMB:32,inputChars:400000}};
  let sessionLoaded = false, sessionError = '', storageKey = null, saveState = '正在连接工作区…';
  let selected = 0, leftTab = 'content', editTab = 'text', templateResult = null, toastTimer, exporting = false;
  let materials = [], selectedMaterialIds = new Set(), uploading = false, uploadMessage = '', materialsLoading = false;
  let instructions = '', requestedDuration = '', requestedSlideCount = '', generating = false, generationError = '', progressEvents = [];
  let cloudProjectId = null, cloudSaving = false, projectList = [], projectsLoading = false, projectsError = '';
  let samples = [], samplesLoading = false;
  let sampleViewer=null, selectedSampleId=null, sampleViewerSequence=0;
  let modelProfiles=[],profilesAvailable=false,profilesLoading=false,modelProfilesError='',selectedModelProfileId='platform',modelEditingId=null,modelSaving=false;
  const history = [];
  let modalOpen = false, modalKind='';
  let visualController=null,visualBusy=false,visualOpening=false;
  const visionSummaries=new Map();
  function currentSlide() { return project.slides[selected]; }
  function remember() { history.push(clone(project)); if(history.length>25)history.shift(); }
  function persist() {
    if (!storageKey || !session.user) { saveState = sessionLoaded ? '连接后保存到你的工作区' : '正在连接工作区…';updateSaveState();return; }
    try { localStorage.setItem(storageKey, JSON.stringify({project,cloudProjectId,instructions,requestedDuration,requestedSlideCount,selectedModelProfileId})); saveState='修改已保存在此浏览器'; }
    catch(_) { saveState='存储空间不足，请保存项目'; }
    updateSaveState();
  }
  function updateSaveState(){const e=document.getElementById('save-state');if(e)e.textContent=saveState;const label=document.getElementById('session-status');if(label)label.classList.toggle('hidden',!saveState);}
  function toast(message) { const t=document.getElementById('toast');t.textContent=message;t.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('visible'),5000); }
  function mutate(callback, light) {
    const previousSelected=selected;
    remember();
    try { callback();project=Core.normalizeProject(project); }
    catch(error) { project=history.pop();selected=Math.max(0,Math.min(previousSelected,project.slides.length-1));renderAll();toast(error.message||'修改未能保存，请检查输入。');return; }
    persist();
    if(light){renderPreview();renderList(true);renderStats();const undo=document.querySelector('[data-action="undo"]');if(undo)undo.disabled=false;if(leftTab==='check')renderSettings();}else renderAll();
  }
  function selectSlide(index) { selected=Math.max(0,Math.min(index,project.slides.length-1));renderPreview();renderList();renderEditor(); }
  function options(values,current) { return Object.entries(values).map(([value,label])=>'<option value="'+h(value)+'"'+(value===current?' selected':'')+'>'+h(label)+'</option>').join(''); }
  function field(label,content,hint) { return '<label class="field"><span class="field-label">'+label+'</span>'+content+(hint?'<p class="hint">'+hint+'</p>':'')+'</label>'; }
  function inp(key,value,type='text',attributes='') { return '<input data-project="'+key+'" type="'+type+'" value="'+h(value)+'" '+attributes+'>'; }
  function slideInp(key,value,tag='input',attributes='') { return tag==='textarea'?'<textarea data-slide="'+key+'" '+attributes+'>'+h(value)+'</textarea>':'<input data-slide="'+key+'" value="'+h(value)+'" '+attributes+'>'; }
  function accountLabel(){return session.user ? (session.user.name || session.user.email || '我的工作区') : '连接工作区';}
  function materialIsReady(m){return m.status==='ready'||(m.status==='needs_ocr'&&(m.kind==='pdf'||/\.pdf$/i.test(m.name||'')));}
  function visualPageIsCurrent(p){const name=selectedModelProfileId==='platform'?session.model.name:selectedModelProfile()?.model;return p.status==='ready'&&p.analysisVersion===4&&p.summary&&p.modelProfileId===selectedModelProfileId&&p.modelName===name;}
  function readyMaterials(){return materials.filter(m=>materialIsReady(m)&&selectedMaterialIds.has(m.id));}
  function selectedModelProfile(){return modelProfiles.find(p=>p.id===selectedModelProfileId)||null;}
  function selectedModelReady(){return selectedModelProfileId==='platform'?Boolean(session.model.configured):Boolean(profilesAvailable&&selectedModelProfile()?.hasKey);}
  function selectedInputChars(){const value=selectedModelProfileId==='platform'?session.limits?.inputChars:selectedModelProfile()?.inputChars;return Number.isSafeInteger(value)?value:400000;}
  function platformModelLabel(){
    const name=String(session.model.name||'').trim(),provider=String(session.model.provider||'').toLowerCase();
    if(/^deepseek-flash$/i.test(name))return 'DeepSeek-V4.1-Flash';
    const label=String(session.model.label||'').trim();if(label)return label;
    return provider==='deepseek'||/^deepseek(?:[-_.]|$)/i.test(name)?'DeepSeek'+(name?' · '+name:''):name;
  }
  function platformPickerLabel(){const label=platformModelLabel();if(label==='DeepSeek-V4.1-Flash')return label;return (label?label+'（平台默认）':'平台默认')+(session.model.configured?'':'（未配置）');}
  function optionalRequestNumber(value,min,max,label){
    const text=String(value??'').trim();if(!text)return undefined;
    const number=Number(text);if(!/^\d+$/.test(text)||!Number.isSafeInteger(number)||number<min||number>max)throw new Error(label+'请填写 '+min+'–'+max+' 的整数，或留空由模型决定。');
    return number;
  }
  function generationPreferences(){
    const duration=optionalRequestNumber(requestedDuration,1,180,'时长'),slideCount=optionalRequestNumber(requestedSlideCount,2,24,'目标页数');
    return {...(duration===undefined?{}:{duration}),...(slideCount===undefined?{}:{slideCount})};
  }
  function savedRequestText(value){return typeof value==='string'||typeof value==='number'?String(value):'';}
  function modelPicker(){
    const labels={platform:platformPickerLabel()};
    modelProfiles.forEach(p=>{labels[p.id]=p.name+' · '+p.model;});
    return '<div class="model-picker"><div class="model-picker-heading"><span class="field-label">生成模型</span><button class="text-button" data-action="manage-models" '+(generating||uploading||visualBusy||modelSaving?'disabled':'')+'>管理模型</button></div><select id="model-profile-select" aria-label="生成模型" '+(generating||uploading||visualBusy||modelSaving||profilesLoading||!sessionLoaded?'disabled':'')+'>'+options(labels,selectedModelProfileId)+'</select><p class="hint">可使用平台默认模型，也可添加你自己的模型服务。</p>'+(selectedModelProfileId==='platform'&&session.model.imageInput===false?'<p class="model-inline-error">当前平台模型不支持图像输入。PDF 图文汇报请选用支持图像的个人模型。</p>':'')+(modelProfilesError?'<p class="model-inline-error">个人模型列表读取失败，可在“管理模型”中重试。</p>':'')+'</div>';
  }
  function pageNavigation() {
    return Object.entries(Navigation.pages).map(([key,value])=>'<a class="text-button '+(activePage===key?'current':'')+'" href="'+value.path+'" data-page="'+key+'" '+(activePage===key?'aria-current="page"':'')+'>'+value.label+'</a>').join('');
  }
  function pageHeader() {
    return '<header class="topbar"><a class="brand" href="/workbench" data-page="workbench" aria-label="求是·智汇 汇报工作台"><div class="brand-mark" aria-hidden="true">智</div><div><div class="brand-title">求是·智汇</div><div class="brand-sub">校园学术汇报 AI 工作台</div></div></a><nav class="toplinks" aria-label="工作区导航">'+pageNavigation()+'</nav><div class="top-actions"><button class="button account-button" data-action="account" title="'+h(accountLabel())+'" '+(!sessionLoaded?'disabled':'')+'>'+icon('user')+'<span>'+h(sessionLoaded?accountLabel():'连接中…')+'</span></button></div></header>';
  }
  function pageFooter() {
    return '<footer class="project-footer"><span>求是·智汇 · 面向校园学术表达</span><a class="text-button" href="/guide" data-page="guide">使用指南</a></footer>';
  }
  function guideContent() {
    return '<div class="guide-steps"><article><span>01</span><h2>上传材料，说明任务</h2><p>添加论文、文档或已有汇报，勾选用于本次生成的材料。时长、目标页数、听众与重点均可留空，由模型结合材料判断；有明确要求时再填写，并选择生成模型。</p></article><article><span>02</span><h2>让 AI 理解并生成</h2><p>点击“生成汇报”，AI 自动逐页读取 PDF 的文字与图像，整理双栏阅读顺序、表格和公式，再组织汇报逻辑、配图、来源与讲稿。</p></article><article><span>03</span><h2>编辑并导出 PPT</h2><p>在下方工作区查看初稿，修改每页的内容、样式与讲稿。保存汇报后，可导出文字可编辑、图片按比例显示的 PPTX。</p></article></div><div class="guide-details"><section><h2>保存与继续制作</h2><p>生成完成后会自动保存到工作区。后续修改保存在当前浏览器，点击“保存汇报”同步最新版本。在“我的汇报”打开项目，或通过工作区的“···”菜单导入、下载项目备份。</p></section><section><h2>论文插图与来源</h2><p>生成时自动识别并高清裁剪论文 Figure，保留图中的子图编号、坐标与图例，按内容选入汇报。来源页码与插图区域一同保留。“查看原页”用于查看出处、阅读解读或切换已识别的插图区域。</p></section><section><h2>模型与读取进度</h2><p>可使用平台模型，也可在“管理模型”中添加个人服务。图像读取需要所选模型支持图像输入。遇到额度或服务问题时会停止生成并保留已完成的读取记录，再次生成会继续处理。</p></section><section><h2>模板与交付</h2><p>在“样式”中选择主题，或导入 PPTX 模板应用字体、配色和页面尺寸。导出前查看最终论点、引用与版式；复杂母版及动画目前不支持完整迁移。</p></section></div><div class="page-cta"><a class="button primary" href="/workbench" data-page="workbench">开始制作汇报 →</a></div>';
  }
  function renderSubpage() {
    const pages={projects:{kicker:'YOUR PRESENTATIONS',title:'我的汇报',description:'找回已保存的内容，继续编辑与导出。'},guide:{kicker:'FROM MATERIALS TO PRESENTATION',title:'使用指南',description:'给出材料与任务，余下的从一次生成开始。'},samples:{kicker:'PRESENTATION GALLERY',title:'汇报样片',description:'从课程、组会与文献分享中，寻找内容与样式参考。'}};
    const page=pages[activePage];
    document.getElementById('app').innerHTML=pageHeader()+'<main class="subpage '+activePage+'-page"><header class="subpage-heading"><div class="eyebrow">'+page.kicker+'</div><h1 tabindex="-1">'+page.title+'</h1><p>'+page.description+'</p></header><div id="generation-status" aria-live="polite"></div>'+(activePage==='guide'?guideContent():activePage==='projects'?'<section id="projects-page-content" aria-live="polite"></section>':'<section id="sample-gallery" class="sample-gallery"></section>')+'</main>'+pageFooter();
    if(activePage==='projects')renderProjects();if(activePage==='samples')renderSamples();renderGenerationStatus();
  }
  function renderProjects() {
    const box=document.getElementById('projects-page-content');if(!box)return;
    if(!sessionLoaded){box.innerHTML='<div class="empty-state" role="status"><span class="spinner"></span><p>正在连接你的工作区…</p></div>';return;}
    if(!session.user){box.innerHTML='<div class="page-empty"><h2>你的汇报，随时继续。</h2><p>连接后查看已保存的汇报，继续编辑与导出。</p><button class="button primary" data-action="account">连接工作区</button></div>';return;}
    box.innerHTML='<div class="page-toolbar"><span>'+projectList.length+' 份已保存汇报</span><div><button class="button" data-action="import-project">导入项目文件</button><button class="button primary" data-action="new-project">'+icon('plus')+'新建汇报</button></div></div>'+(projectsLoading?'<div class="empty-state" role="status"><span class="spinner"></span><p>正在读取汇报…</p></div>':projectsError?'<div class="page-empty" role="alert"><p>'+h(projectsError)+'</p><button class="button" data-action="projects">重新加载</button></div>':projectList.length?'<div class="saved-projects">'+projectList.map(p=>'<button class="saved-project" data-open-project="'+h(p.id)+'"><span>'+icon('file')+'</span><div><strong>'+h(p.title||'未命名汇报')+'</strong><small>'+h(formatDate(p.updatedAt))+'</small></div><span>打开 →</span></button>').join('')+'</div>':'<div class="page-empty"><h2>从第一份汇报开始。</h2><p>生成完成后会自动保存，也可在编辑时点击“保存汇报”。</p><a class="button" href="/workbench" data-page="workbench">前往汇报工作台 →</a></div>');
  }
  function navigatePage(page,replace=false) {
    if(!Navigation.pages[page])return;closeModal();activePage=page;
    if(window.location.pathname!==Navigation.pages[page].path)window.history[replace?'replaceState':'pushState']({page},'',Navigation.pages[page].path);
    renderAll();window.scrollTo({top:0,behavior:'auto'});document.querySelector('.subpage-heading h1,.workspace-heading h1')?.focus();
  }
  function renderAll() {
    if(activePage!=='samples'){sampleViewer?.dispose();sampleViewer=null;selectedSampleId=null;++sampleViewerSequence;}
    document.title=Navigation.pages[activePage].label+' · 求是·智汇';
    if(activePage!=='workbench'){renderSubpage();return;}
    const hasSlides=project.slides.length>0;
    document.getElementById('app').innerHTML = pageHeader()+`
      <div class="workspace-heading"><div><div class="eyebrow">FROM YOUR MATERIALS TO YOUR PRESENTATION</div><h1 tabindex="-1">上传材料，让 <span class="latin-display" lang="en">AI</span> 完成汇报初稿</h1><p>自动理解 PDF 图文与版面，将材料、来源与讲述逻辑组织成可编辑的 PPT。</p></div><div id="session-status" class="session-label ${saveState?'':'hidden'}"><span class="dot ${sessionError?'offline':''}"></span><span id="save-state">${h(saveState)}</span></div></div>
      ${sessionError?'<div class="connection-notice">'+h(sessionError)+' <button class="text-button" data-action="retry-session">重新连接</button></div>':''}
      <main class="workspace ${hasSlides?'has-project':'is-empty'} ${generating?'is-generating':''}">
        <section class="setup-column panel" aria-label="汇报设置"><div class="left-tabs" role="tablist"><button role="tab" aria-selected="${leftTab==='content'}" class="${leftTab==='content'?'active':''}" data-tab="content"><span class="step-number">01</span> 素材</button><button role="tab" aria-selected="${leftTab==='style'}" class="${leftTab==='style'?'active':''}" data-tab="style"><span class="step-number">02</span> 样式</button><button role="tab" aria-selected="${leftTab==='check'}" class="${leftTab==='check'?'active':''}" data-tab="check"><span class="step-number">03</span> 自检</button></div><div id="settings-content" class="settings"></div></section>
        <section class="center-column" aria-label="演示文稿预览"><div class="result-heading"><div class="eyebrow">YOUR PRESENTATION</div><h2>你的汇报工作区</h2><p>初稿、页面预览与逐页编辑，都在这里。</p></div><div class="preview-toolbar"><h2>${hasSlides?'页面预览':'你的汇报工作区'} <span id="page-indicator"></span></h2><div class="preview-actions"><button class="button small" data-action="undo" title="撤销上一次修改" ${history.length&&!generating?'':'disabled'}>${icon('undo')}撤销</button><button class="button small" data-action="cloud-save" ${!hasSlides||cloudSaving||generating?'disabled':''}>${icon('cloud')}${cloudSaving?'保存中…':'保存汇报'}</button><button class="button primary small" data-action="export" ${exporting||!hasSlides||generating?'disabled':''}>${icon('download')}${exporting?'正在导出…':'导出 PPTX'}</button><button class="text-button more-button" data-action="project-options" aria-label="项目选项" title="项目选项">···</button></div></div>
        <div id="generation-status" aria-live="polite"></div>
        <div class="preview-stage ${hasSlides?'':'empty-stage'}"><div id="preview" class="slide-shell ${hasSlides?'':'empty-shell'}"></div></div>
        ${hasSlides?'<div class="preview-caption"><span>AI 生成内容可逐页修改</span><span>文字可编辑 · 图片按比例显示</span></div><div id="stats" class="stats"></div><div class="slide-list-header"><h3>汇报页面</h3><div class="preview-actions"><button class="button small" data-action="move-up" title="上移当前页" aria-label="上移当前页">'+icon('arrowUp')+'</button><button class="button small" data-action="move-down" title="下移当前页" aria-label="下移当前页">'+icon('arrowDown')+'</button><button class="button small" data-action="add-slide">'+icon('plus')+'添加页面</button></div></div><div id="slide-list" class="slide-list"></div>':'<div class="workflow-cards"><div><span>01</span><strong>给出材料与任务</strong><p>上传论文、已有汇报或文档，说明听众与重点。</p></div><div><span>02</span><strong>按汇报规范生成</strong><p>自动理解文字、图表与版面，组织证据、来源和讲稿。</p></div><div><span>03</span><strong>编辑并带走 PPT</strong><p>调整页面与样式，导出可继续编辑的文件。</p></div></div>'}
        </section>
        ${hasSlides?'<aside class="right-column" aria-label="当前页编辑"><div class="panel"><div class="panel-header"><span>编辑当前页</span><button class="text-button" data-action="delete-slide" aria-label="删除当前页" title="删除当前页">'+icon('trash')+'</button></div><div class="edit-tabs" role="tablist"><button role="tab" aria-selected="'+(editTab==='text')+'" class="'+(editTab==='text'?'active':'')+'" data-edit-tab="text">内容</button><button role="tab" aria-selected="'+(editTab==='sources')+'" class="'+(editTab==='sources'?'active':'')+'" data-edit-tab="sources">来源</button><button role="tab" aria-selected="'+(editTab==='notes')+'" class="'+(editTab==='notes'?'active':'')+'" data-edit-tab="notes">讲稿</button></div><div class="settings" id="slide-editor"></div><div class="editor-note">修改仅作用于当前页。章节、页码和导航随页面顺序更新。</div></div></aside>':''}
      </main>
      `+pageFooter();
    renderSettings();renderPreview();renderGenerationStatus();renderStats();renderList();renderEditor();applyBusyState();
  }
  function applyBusyState(){if(generating||visualBusy)document.querySelectorAll('.workspace input,.workspace select,.workspace textarea,.workspace button:not([data-tab]):not([data-edit-tab]):not([data-action=cancel-generation])').forEach(el=>el.disabled=true);}
  function renderGenerationStatus(){
    const box=document.getElementById('generation-status');if(!box)return;
    if(!generating&&!generationError){box.innerHTML='';return;}
    box.innerHTML=generating?'<div class="generation-progress"><span class="spinner" aria-hidden="true"></span><div><strong>AI 正在制作汇报</strong><p>'+h(progressEvents.at(-1)||'正在准备材料…')+'</p><span>可在子页面间切换，完成后将显示可编辑初稿。</span></div><button class="button small" data-action="cancel-generation">停止生成</button></div>':'<div class="generation-error"><strong>这次生成未完成</strong><p>'+h(generationError)+'</p><button class="text-button" data-action="dismiss-error">收起提示</button></div>';
  }
  function renderMaterials(){
    const box=document.getElementById('materials-list');if(!box)return;
    const labels={ready:'材料已就绪',needs_ocr:'生成时识别',needs_optimization:'已保存，待压缩',uploading:'上传未完成',processing:'正在提取',failed:'上传或解析未完成',deleting:'正在移除',error:'提取失败'};
    box.innerHTML=(materialsLoading?'<div class="materials-empty">正在读取素材…</div>':'')+materials.map(m=>{
      const isPdf=m.kind==='pdf'||/\.pdf$/i.test(m.name||''),visual=visionSummaries.get(m.id),ready=visual?.pages?.filter(visualPageIsCurrent).length||0,failed=visual?.pages?.filter(p=>p.status==='failed').length||0;
      const canRead=isPdf&&['ready','needs_ocr'].includes(m.status),disabled=generating||uploading||visualBusy||visualOpening;
      const message=canRead?'PDF 已就绪；生成汇报时将自动读取文字与图像，整理双栏顺序、表格和公式，并保留来源页码。':m.message;
      return '<div class="material-card '+h(m.status)+'"><label class="material-select"><input type="checkbox" data-material-select="'+h(m.id)+'" '+(selectedMaterialIds.has(m.id)?'checked':'')+' '+(!materialIsReady(m)||disabled?'disabled':'')+'><span class="material-icon">'+icon('file')+'</span><span class="material-text"><strong title="'+h(m.name)+'">'+h(m.name)+'</strong><small>'+h(m.status==='uploading'&&Number.isFinite(m.uploadPercent)?'正在上传 · '+m.uploadPercent+'%':labels[m.status]||'处理中')+(m.textLength?' · '+Number(m.textLength).toLocaleString()+' 字符':'')+'</small></span></label><button class="material-remove" data-delete-material="'+h(m.id)+'" aria-label="删除素材 '+h(m.name)+'" title="删除素材" '+(disabled?'disabled':'')+'>'+icon('close')+'</button>'+(message?'<p class="material-message">'+h(message)+'</p>':'')+(canRead?'<div class="material-visual-row"><span>'+h(visual?(ready?'已理解 '+ready+' 页'+(failed?' · 未完成页面将在生成时重试':''):'生成时自动理解图文'):'生成时自动理解图文')+'</span><button class="button small" data-read-pdf="'+h(m.id)+'" '+(disabled?'disabled':'')+'>'+icon('image')+'查看原页'+'</button></div>':'')+'</div>';
    }).join('')+(!materials.length&&!materialsLoading?'<p class="materials-empty">'+(session.user?'添加这次汇报需要的原始材料。':'连接后上传材料，开始制作。')+'</p>':'')+(uploading?'<p class="upload-status"><span class="spinner small-spinner"></span>'+h(uploadMessage||'正在上传并提取…')+'</p>':'');
  }
  function renderSettings() {
    const box=document.getElementById('settings-content');if(!box)return;
    if(leftTab==='content'){
      const scenes=Object.fromEntries(Object.entries(Core.sceneTemplates).map(([k,v])=>[k,v.label||v.name||k]));
      const limit=session.limits||{maxFileMB:200,maxFiles:null,chunkMB:8,pdfParseMB:32,inputChars:400000};
      box.innerHTML = '<div class="setup-grid"><section class="setup-materials"><div class="section-label"><span>01</span> 汇报素材</div><button class="material-dropzone" data-action="upload-materials" '+(uploading||generating||visualBusy||modelSaving||profilesLoading||!sessionLoaded?'disabled':'')+'>'+icon('upload')+'<strong>上传论文与汇报材料</strong><span>PDF · Word · PPT · 文本 · 图片</span><small>支持批量上传 · 单份最高'+h(limit.maxFileMB||200)+'MB</small></button><div id="materials-list" class="materials-list"></div><p class="hint">支持长文档与大文件。勾选参与生成的材料，PPT 模板请在“样式”中导入。</p></section><section class="setup-task"><div class="section-label"><span>02</span> 汇报要求</div>'+field('汇报场景','<select data-project="scene">'+options(scenes,project.scene)+'</select>')+field('汇报名称',inp('title',project.title==='未命名汇报'?'':project.title,'text','placeholder="可留空，由 AI 根据材料命名" maxlength="300"'))+field('汇报人',inp('presenter',project.presenter,'text','placeholder="姓名 / 团队（选填）" maxlength="200"'))+'<div class="field-row">'+field('时长（分钟，选填）','<input id="requested-duration" type="number" min="1" max="180" step="1" value="'+h(requestedDuration)+'" placeholder="由模型决定">')+field('目标页数（选填）','<input id="slide-count" type="number" min="2" max="24" step="1" value="'+h(requestedSlideCount)+'" placeholder="由模型决定">')+'</div>'+field('听众与汇报重点（选填）','<textarea id="generation-instructions" rows="4" maxlength="6000" placeholder="可留空，由模型结合材料判断听众与重点；也可填写希望重点讲解的科学问题、证据或局限。">'+h(instructions)+'</textarea>')+modelPicker()+'<button class="button primary full generate-button" data-action="generate" '+(generating||uploading||visualBusy||modelSaving||profilesLoading||!sessionLoaded||(session.user&&(!selectedModelReady()||!readyMaterials().length))?'disabled':'')+'>'+icon('spark')+(generating?'正在生成…':session.user?(project.slides.length?'重新生成汇报':'生成汇报'):'连接后生成汇报')+'</button><p class="generation-hint">'+(session.user?(selectedModelReady()?'生成时自动理解 PDF 图文、双栏顺序、表格与公式。':'请选择已配置的模型，或在“管理模型”中添加。'):'使用你的工作区保存素材与汇报。')+'</p></section></div>';
      renderMaterials();
    }else if(leftTab==='style'){
      const paletteButtons=Core.palettes.map(p=>'<button class="palette-option '+(project.theme.palette===p.id?'active':'')+'" data-palette="'+h(p.id)+'"><span class="swatch" style="background:'+validColor(p.accent,'#074591')+'"></span>'+h(p.label||p.name)+'</button>').join('');
      box.innerHTML = '<div class="style-grid"><section><div class="section-label"><span>01</span> 选择样式</div><div class="profile-options">'+Core.visualProfiles.map(p=>'<button class="profile-option '+(project.theme.profile===p.id?'active':'')+'" data-profile="'+h(p.id)+'">'+h(p.label)+'</button>').join('')+'</div>'+(Core.visualProfile(project.theme).branded?'<p class="hint">使用真实校徽、校标、浅蓝导航背景与章节高亮。</p>'+field('校徽与校标','<select data-theme="showBrand">'+options({'true':'显示','false':'隐藏'},String(project.theme.showBrand!==false))+'</select>'):'')+'</section><section><div class="section-label">导入模板与字体</div><div class="template-zone">'+icon('upload')+'<strong>使用自己的 PPT 模板</strong><p>提取主题字体、配色与页面尺寸<br>应用于本工作台的标准版式</p><button class="button small" data-action="import-template">选择 PPTX 模板</button></div>'+(templateResult?'<div class="template-result"><strong>'+h(templateResult.fileName)+'</strong>已应用可识别的样式参数；复杂母版与动画未迁入。</div>':'')+'<div style="margin-top:17px">'+field('正文与标题字体','<select data-theme="font">'+options({'华文楷体':'华文楷体','STKaiti':'STKaiti','楷体':'楷体','微软雅黑':'微软雅黑','宋体':'宋体',...(project.theme.font && !['华文楷体','STKaiti','楷体','微软雅黑','宋体'].includes(project.theme.font)?{[project.theme.font]:project.theme.font}:{})},project.theme.font)+'</select>','电脑需安装所选字体；原始图片中的字形保持不变。')+'</div>'+field('页面比例','<select id="aspect-ratio">'+options({'wide':'16:9 宽屏','standard':'4:3 标准','custom':'来自导入模板'},Math.abs(project.theme.width/project.theme.height-16/9)<.02?'wide':Math.abs(project.theme.width/project.theme.height-4/3)<.02?'standard':'custom')+'</select>')+'</section><section><div class="section-label"><span>02</span> 全稿主题色</div><div class="palette-grid">'+paletteButtons+'</div><label class="custom-color">自定主色<input type="color" id="custom-color" value="'+validColor(project.theme.accent,'#074591')+'"><code>'+h(project.theme.accent.toUpperCase())+'</code></label><hr><div class="section-label"><span>03</span> 章节导航</div><div class="nav-options">'+[['top','顶部横排'],['left','左侧竖排'],['none','无导航']].map(([v,l])=>'<button class="nav-option '+(project.theme.nav===v?'active':'')+'" data-nav="'+v+'"><div class="nav-sketch '+v+'" aria-hidden="true"></div>'+l+'</button>').join('')+'</div><p class="hint">导航取自当前页面的章节。调整顺序后，当前章节与页码同步更新。</p></section></div><div class="quiet-note style-note">样式应用于整份汇报。原图始终按比例放置，导出后仍可在 PowerPoint 中修改文字与图片。</div>';
    }else renderChecks(box);
  }
  function renderChecks(box) {
    const report=Core.validateProject(project);
    const errors=report.errors||[], warnings=report.warnings||[];
    const issues=[...errors.map(x=>({...x,level:'error'})),...warnings.map(x=>({...x,level:'warn'}))];
    box.innerHTML = '<div class="section-label">版式与材料自检</div><div class="checks-summary">'+(errors.length?'需要处理 '+errors.length+' 项错误。':'未发现已实现检查项的错误。')+'<br>'+warnings.length+' 项提醒可在导出前查看。</div>'+ (issues.length?issues.map(x=>'<div class="check-item"><span class="check-symbol '+x.level+'">!</span><div>'+h(x.message||String(x))+(x.slideId?'<br><button data-jump-id="'+h(x.slideId)+'">查看对应页面 →</button>':'')+'</div></div>').join(''):'<div class="check-item"><span class="check-symbol">✓</span><div>目前未发现需要提示的项目。</div></div>')+'<hr><div class="quiet-note">自检检查已实现的长度、来源字段、图片与时间等规则。来源与结论是否相符，以及 Office 中的实际字形和排版，需要人工确认。</div>';
  }
  function getSections(){return Core.navigationSections(project);}
  function renderPreview() {
    const shell=document.getElementById('preview'); if(!shell)return;
    const slide=currentSlide();if(!slide){
      shell.innerHTML='<div class="start-state"><div class="start-glyph" aria-hidden="true">'+icon('spark')+'</div><span class="start-kicker">从一份材料开始</span><h2>把你的研究，<br>讲清楚。</h2><p>上传论文或文档，告诉我们这次要讲什么。<br>AI 将整理内容、组织页面，生成汇报初稿。</p><button class="button primary" data-action="upload-materials" '+(!sessionLoaded||uploading||generating||modelSaving||profilesLoading?'disabled':'')+'>'+icon('plus')+'添加汇报素材</button><button class="text-button start-secondary" data-action="import-project">继续编辑已有项目 →</button></div>';
      const indicator=document.getElementById('page-indicator');if(indicator)indicator.textContent='';return;
    }
    const t=project.theme;const width=Number(t.width)||13.3333,height=Number(t.height)||7.5;
    shell.style.setProperty('--slide-ratio',width+' / '+height);
    shell.style.setProperty('--slide-accent',validColor(t.accent,'#074591'));
    shell.style.setProperty('--slide-bg',validColor(t.background,'#ffffff'));
    shell.style.setProperty('--slide-text',validColor(t.text,'#182333'));
    shell.style.setProperty('--slide-font','"'+cleanFont(t.font)+'", "STKaiti", "KaiTi", "Microsoft YaHei", serif');
    const g=Export.geometry(project),sections=getSections(),parts=[];
    function box(content,x,y,w,bh,size,extra='') { return '<div class="ppt-box" style="left:'+(x/width*100)+'%;top:'+(y/height*100)+'%;width:'+(w/width*100)+'%;height:'+(bh/height*100)+'%;font-size:'+(size/(width*72)*100)+'cqw;'+extra+'">'+content+'</div>'; }
    function text(value,x,y,w,bh,size,extra=''){return box(Core.renderInlineHtml(value),x,y,w,bh,size,extra);}
    function line(x1,y1,x2,y2,color,pt=.75){parts.push('<div class="ppt-line" style="left:'+(x1/width*100)+'%;top:'+(y1/height*100)+'%;width:'+Math.max(0,(x2-x1)/width*100)+'%;height:'+Math.max(0,(y2-y1)/height*100)+'%;'+(x1===x2?'border-left':'border-top')+':'+Math.max(.5,pt*.8)+'px solid '+color+'"></div>');}
    function bullets(body,x,y,w,bh,size,layout){
      if(!body?.length)return;
      const listStyle=layout?' style="padding-left:'+layout.bulletIndent+'em"':'';
      const items=body.map((value,index)=>'<li'+(layout?' style="padding-left:'+layout.hanging+'em;line-height:'+layout.lineHeight+';margin-bottom:'+(index<body.length-1?layout.paragraphGap:0)+'em"':'')+'>'+Core.renderInlineHtml(value)+'</li>').join('');
      parts.push(box('<ul'+listStyle+'>'+items+'</ul>',x,y,w,bh,size));
    }
    const accent='color:'+validColor(t.accent,'#074591')+';',bold='font-weight:700;';
    if(g.academic&&Export.chrome){
      const chrome=Export.chrome(project,slide,sections);
      chrome.rects.forEach(r=>parts.push(box('',r.x,r.y,r.w,r.h,0,'background:'+validColor(r.color,'#FFFFFF')+';')));
      chrome.images.forEach(r=>parts.push(box('<img class="ppt-image" src="'+h(r.src)+'" alt="'+h(r.alt)+'">',r.x,r.y,r.w,r.h,0)));
      chrome.navItems.forEach(item=>parts.push(box('<button data-jump-section="'+h(item.section)+'">'+h(item.section)+'</button>',item.x,item.y,item.w,item.h,item.fontSize,'display:flex;align-items:center;justify-content:center;text-align:center;font-weight:700;color:'+validColor(item.color,'#074591')+';')));
    }
    if(!g.academic&&t.nav!=='none'&&slide.type!=='cover'){
      if(t.nav==='top'){
        const gap=.22*g.sx,each=(g.right-g.left-(sections.length-1)*gap)/Math.max(1,sections.length);
        sections.forEach((s,i)=>{const x=g.left+i*(each+gap);parts.push(box('<button data-jump-section="'+h(s)+'">'+h(s)+'</button>',x,.27*g.sy,each,.26*g.sy,g.fontSize.nav,'text-align:center;'+(s===slide.section?accent+bold:'color:#6F7C8C;')));if(s===slide.section)line(x,.68*g.sy,x+each,.68*g.sy,t.accent,2);});
        line(g.left,.72*g.sy,g.right,.72*g.sy,'#DEE4EC',.5);
      }else{
        line(1.49*g.sx,.43*g.sy,1.49*g.sx,g.height-.49*g.sy,'#D8E0E9',.65);
        const step=Math.min(.93*g.sy,4.7*g.sy/Math.max(1,sections.length)),y0=(g.height-sections.length*step)/2;
        sections.forEach((s,i)=>{parts.push(box('<button data-jump-section="'+h(s)+'">'+h(s)+'</button>',.15*g.sx,y0+i*step,1.2*g.sx,.58*g.sy,g.fontSize.nav,'display:flex;align-items:center;justify-content:center;text-align:center;'+(s===slide.section?accent+bold:'color:#768396;')));if(s===slide.section)line(.29*g.sx,y0+i*step+.63*g.sy,1.18*g.sx,y0+i*step+.63*g.sy,t.accent,2);});
      }
    }
    const capacity=(g.right-g.left-.7*g.sx)*72/g.fontSize.citation;
    const nLines=(slide.citations||[]).reduce((n,c)=>n+Math.max(1,Math.ceil((c.title.length+c.venue.length+c.year.length+c.status.length+10)/capacity)),0);
    const footH=Math.max(.35*g.sy,Math.min(1.55*g.sy,nLines*g.fontSize.citation*1.3/72));
    const bottom=Math.min(g.contentBottom,g.height-footH-.47*g.sy),contentW=g.right-g.left;
    if(slide.type==='cover'){
      const x=.95*g.sx,w=width-2*x;
      parts.push(text(Core.sceneTemplates[project.scene]?.label||'校园汇报',x,1.20*g.sy,w,.4*g.sy,14*g.scale,accent));
      parts.push(text(slide.title||project.title,x,2.1*g.sy,w,1.53*g.sy,g.fontSize.cover,accent+bold));
      parts.push(text(slide.subtitle||project.subtitle,x,3.88*g.sy,w,.8*g.sy,19*g.scale));
      line(x,5.12*g.sy,width-x,5.12*g.sy,'#C5D0DE',.8);
      parts.push(text(project.presenter,x,5.6*g.sy,w,.4*g.sy,16*g.scale,'color:#5E6D7F;'));
    }else if(slide.type==='section'){
      parts.push(text(String(Math.max(1,sections.indexOf(slide.section)+1)).padStart(2,'0'),g.left,2.15*g.sy,1.1*g.sx,.75*g.sy,35*g.scale,'color:'+validColor(t.secondary,'#8C9CAD')+';'));
      parts.push(text(slide.title,g.left+1.35*g.sx,2.16*g.sy,contentW-1.35*g.sx,1.1*g.sy,32*g.scale,accent+bold));
      parts.push(text(slide.subtitle,g.left+1.35*g.sx,3.53*g.sy,contentW-1.35*g.sx,1*g.sy,20*g.scale));
      bullets(slide.body,g.left+1.35*g.sx,4.63*g.sy,contentW-1.35*g.sx,bottom-4.63*g.sy,18*g.scale);
    }else{
      const titleLayout=Export.titleGeometry(slide.title,g);
      parts.push(text(slide.title,g.left,g.titleY,g.titleW||contentW,titleLayout.h,titleLayout.fontSize,accent+bold+'line-height:'+titleLayout.lineHeight+';'));
      line(g.left,titleLayout.ruleY,g.left+g.ruleW,titleLayout.ruleY,g.academic?t.accent:'#D8E1EC',.7);
      if(g.academic)line(g.left,titleLayout.ruleY,g.left+.645*g.sx,titleLayout.ruleY,t.accent,3);
      let y=titleLayout.contentY;
      if(slide.subtitle){parts.push(text(slide.subtitle,g.left,y,contentW,.46*g.sy,g.fontSize.subtitle,'color:#68778A;'));y+=.64*g.sy;}
      const evidenceLabel=Core.evidenceLabel(project,slide);
      if(evidenceLabel){parts.push(text(evidenceLabel,g.left,y,contentW,.28*g.sy,11*g.scale,accent));y+=.44*g.sy;}
      if(slide.type==='comparison'){
        const gap=.57*g.sx,colW=(contentW-gap)/2;
        if(slide.body?.length){bullets(slide.body,g.left,y,contentW,.7*g.sy,g.fontSize.subtitle);y+=.83*g.sy;}
        (slide.columns||[]).slice(0,2).forEach((c,i)=>{const x=g.left+i*(colW+gap);parts.push(text(c.title,x,y,colW,.57*g.sy,22*g.scale,accent+bold));line(x,y+.72*g.sy,x+colW,y+.72*g.sy,'#D5DFE9',.65);bullets(c.body,x,y+1*g.sy,colW,Math.max(.3,bottom-y-1*g.sy),g.fontSize.body);});
      }else if(slide.type==='table'&&slide.table){
        if(slide.body?.length){bullets(slide.body,g.left,y,contentW,.7*g.sy,g.fontSize.subtitle);y+=.83*g.sy;}
        const captionH=slide.caption ? .55*g.sy : 0,rect={x:g.left,y,w:contentW,h:Math.max(.4,bottom-y-captionH)};
        const layout=Export.tableGeometry(slide.table,rect,g.scale),padding=layout.padding/(width*72)*100,gridLine=.6/(width*72)*100;
        const columns='<colgroup>'+layout.colW.map(w=>'<col style="width:'+(w/rect.w*100)+'%">').join('')+'</colgroup>';
        const rows=[slide.table.columns,...slide.table.rows].map((row,rowIndex)=>'<tr style="height:'+(layout.rowH[rowIndex]/layout.height*100)+'%">'+row.map(value=>{
          const tag=rowIndex===0?'th':'td';return '<'+tag+' style="border:0;box-shadow:inset -'+gridLine+'cqw -'+gridLine+'cqw 0 #CCD5E0;padding:'+padding+'cqw;text-align:left;vertical-align:middle;white-space:pre-wrap;overflow-wrap:anywhere;'+(rowIndex===0?'background:'+validColor(t.navBackground,'#EBF4FC')+';color:'+validColor(t.accent,'#074591')+';font-weight:700;':'font-weight:400;')+'">'+Core.renderInlineHtml(value)+'</'+tag+'>';
        }).join('')+'</tr>').join('');
        parts.push(box('<table class="ppt-table" style="border-collapse:collapse;box-shadow:inset '+gridLine+'cqw '+gridLine+'cqw 0 #CCD5E0;table-layout:fixed;width:100%;height:100%;font-size:inherit;line-height:1.18">'+columns+rows+'</table>',rect.x,rect.y,rect.w,Math.min(rect.h,layout.height),layout.fontSize,'overflow:hidden;font-weight:400;'));
        if(slide.caption)parts.push(text(slide.caption,g.left,bottom-captionH+.06*g.sy,contentW,captionH-.06*g.sy,g.fontSize.caption));
      }else if(slide.type==='figure'){
        const hasBody=slide.body?.length>0,figW=hasBody?contentW*.61:contentW,captionH=slide.caption ? .85*g.sy : 0;
        const rect={x:g.left,y,w:figW,h:Math.max(.4,bottom-y-captionH)};
        if(slide.image&&Core.isSafeImageDataUrl(slide.image.dataUrl)){
          const pos=Export.figurePlacement(slide.image,slide.image.width,slide.image.height,rect);
          const cropStyle=pos.crop?' style="position:absolute;max-width:none;left:'+(-pos.offsetX/pos.w*100)+'%;top:'+(-pos.offsetY/pos.h*100)+'%;width:'+(pos.fullW/pos.w*100)+'%;height:'+(pos.fullH/pos.h*100)+'%;object-fit:fill"':'';
          parts.push(box('<img class="ppt-image" src="'+h(slide.image.dataUrl)+'" alt="'+h(slide.image.alt||slide.caption)+'"'+cropStyle+'>',pos.x,pos.y,pos.w,pos.h,12*g.scale,pos.crop?'overflow:hidden;':''));
        }else{
          parts.push(text('添加本页图像',rect.x,rect.y+rect.h/2-.4*g.sy,rect.w,.45*g.sy,20*g.scale,'text-align:center;color:#6D7E94;'));
          parts.push(text('在应用中选择 PNG 或 JPEG',rect.x,rect.y+rect.h/2+.12*g.sy,rect.w,.4*g.sy,12*g.scale,'text-align:center;color:#6D7E94;'));
        }
        if(slide.caption)parts.push(text(slide.caption,rect.x,bottom-captionH+.11*g.sy,rect.w,captionH-.11*g.sy,g.fontSize.caption,'text-align:center;'));
        if(hasBody){
          const bodyBox={x:g.left+figW+.43*g.sx,y:y+.15*g.sy,w:contentW-figW-.43*g.sx,h:bottom-y-.15*g.sy};
          const bodyLayout=Export.figureBodyGeometry(slide.body,bodyBox,g.scale);
          bullets(slide.body,bodyBox.x,bodyBox.y,bodyBox.w,bodyBox.h,bodyLayout.fontSize,bodyLayout);
        }
      }else bullets(slide.body,g.left,y+.12*g.sy,contentW,Math.max(.4,bottom-y-.12*g.sy),g.fontSize.body);
    }
    const prefix={data:'数据来源：',official:'官方来源：',synthetic:'教学示例：',paper:''};
    const citations=(slide.citations||[]).map(c=>'<div>'+h(prefix[c.kind]||'')+h(c.title)+(c.venue?' | ':'')+(Core.safeUrl(c.url)?'<a href="'+h(Core.safeUrl(c.url))+'" target="_blank" rel="noopener noreferrer">'+h(c.venue)+'</a>':'<strong>'+h(c.venue)+'</strong>')+(c.year?', '+h(c.year):'')+(c.status?' '+h(c.status):'')+'.</div>').join('');
    if(citations)parts.push(box(citations,g.left,height-.26*g.sy-footH,contentW-.7*g.sx,footH,g.fontSize.citation,'display:flex;flex-direction:column;justify-content:flex-end;line-height:1.35;'));
    parts.push(text(String(selected+1).padStart(2,'0')+' / '+String(project.slides.length).padStart(2,'0'),g.right-.65*g.sx,height-.50*g.sy,.65*g.sx,.25*g.sy,g.fontSize.page||9*g.scale,'text-align:right;color:#738196;'));
    shell.innerHTML='<article class="slide ppt-precise">'+parts.join('')+'</article>';
    const indicator=document.getElementById('page-indicator');if(indicator)indicator.textContent=' / '+String(selected+1).padStart(2,'0')+' — '+String(project.slides.length).padStart(2,'0');
  }
  function renderStats(){
    if(!document.getElementById('stats'))return;
    const report=Core.validateProject(project);const count=(report.errors||[]).length+(report.warnings||[]).length;
    document.getElementById('stats').innerHTML='<div class="stat"><strong>'+project.slides.length+'</strong><span>页内容</span></div><div class="stat" title="按各页预计用时相加；字数估算约 '+Number(report.minutes||0).toFixed(1)+' 分钟"><strong>'+Number(report.scheduledMinutes||0).toFixed(1)+'</strong><span>已分配 / '+h(project.duration)+' 分钟</span></div><div class="stat"><strong>'+getSections().length+'</strong><span>个章节</span></div><div class="stat"><strong>'+count+'</strong><button data-tab="check">项自检提醒 →</button></div>';
  }
  function renderList(preserveNodes=false){
    const box=document.getElementById('slide-list');if(!box)return;
    const buttons=preserveNodes?[...box.querySelectorAll('button[data-slide-index]')]:[];
    const sameSlides=preserveNodes&&buttons.length===project.slides.length&&buttons.every((button,index)=>
      button.dataset.slideId===project.slides[index].id&&button.dataset.slideIndex===String(index)&&
      button.querySelector('.slide-item-title')&&button.querySelector('.slide-item-section'));
    if(sameSlides){
      // A field's blur/change can run between pointer-down and click on a
      // thumbnail. Keep that button connected so the pending click survives.
      project.slides.forEach((slide,index)=>{
        const button=buttons[index],title=button.querySelector('.slide-item-title'),section=button.querySelector('.slide-item-section');
        const titleHtml=Core.renderInlineHtml(slide.title||'未命名页面'),sectionText=(typeNames[slide.type]||'内容页')+' / '+(slide.section||'未设章节');
        button.classList.toggle('active',index===selected);
        button.setAttribute('aria-current',index===selected?'true':'false');
        button.setAttribute('aria-label','第'+(index+1)+'页 '+slide.title);
        if(title.innerHTML!==titleHtml)title.innerHTML=titleHtml;
        if(section.textContent!==sectionText)section.textContent=sectionText;
      });
      return;
    }
    box.innerHTML=project.slides.map((s,i)=>'<button class="slide-item '+(i===selected?'active':'')+'" data-slide-index="'+i+'" data-slide-id="'+h(s.id)+'" aria-label="第'+(i+1)+'页 '+h(s.title)+'" aria-current="'+(i===selected?'true':'false')+'"><span class="slide-number">'+String(i+1).padStart(2,'0')+'</span><div><div class="slide-item-title">'+Core.renderInlineHtml(s.title||'未命名页面')+'</div><div class="slide-item-section">'+h(typeNames[s.type]||'内容页')+' / '+h(s.section||'未设章节')+'</div></div></button>').join('');
  }
  function tableEditor(table){
    const limits=Core.tableLimits,grid='display:grid;grid-template-columns:repeat(auto-fit,minmax(min(140px,100%),1fr));gap:12px;';
    const cellField=(label,content,index)=>'<label class="field"><span class="field-label" data-table-label="'+index+'">'+h(label)+'</span>'+content+'</label>';
    const headings=table.columns.map((value,index)=>'<div>'+field('第 '+(index+1)+' 列表头','<input data-table-heading="'+index+'" value="'+h(value)+'" maxlength="'+limits.headingChars+'">')+'<button class="button small" data-action="remove-table-column" data-table-column="'+index+'" '+(table.columns.length<=1?'disabled':'')+'>删除此列</button></div>').join('');
    const rows=table.rows.map((row,rowIndex)=>'<section class="source-card"><div class="source-card-header"><span>第 '+(rowIndex+1)+' 行</span><button class="text-button" data-action="remove-table-row" data-table-row="'+rowIndex+'">删除此行</button></div><div style="'+grid+'">'+row.map((value,columnIndex)=>cellField(Core.plainInlineText(table.columns[columnIndex])||'第 '+(columnIndex+1)+' 列','<textarea data-table-row="'+rowIndex+'" data-table-column="'+columnIndex+'" rows="2" maxlength="'+limits.cellChars+'">'+h(value)+'</textarea>',columnIndex)).join('')+'</div></section>').join('');
    return '<div class="table-editor" style="overflow-wrap:anywhere"><div class="section-label">表头 · '+table.columns.length+' / '+limits.columns+' 列</div><div style="'+grid+'">'+headings+'</div><button class="button small" data-action="add-table-column" '+(table.columns.length>=limits.columns?'disabled':'')+'>添加一列</button><hr><div class="section-label">表格数据 · '+table.rows.length+' / '+limits.rows+' 行</div>'+rows+'<button class="button full" data-action="add-table-row" '+(table.rows.length>=limits.rows?'disabled':'')+'>添加一行</button></div>';
  }
  function renderEditor(){
    const s=currentSlide(),box=document.getElementById('slide-editor');if(!box)return;if(!s){box.innerHTML='<div class="empty-state">生成汇报后可在此编辑。</div>';return;}
    if(editTab==='notes'){
      box.innerHTML=field('本页讲稿与图号备注',slideInp('notes',s.notes||'','textarea','rows="12"'),'备注随 PPTX 导出，可在 PowerPoint 备注区查看。')+field('本页预计用时（秒）',slideInp('durationSec',s.durationSec??60,'input','type="number" min="0" max="1800"'))+'<div class="quiet-note">“已分配”按逐页预计用时相加。另按字数估计讲述时间，约 '+h(Core.estimateProject(project).minutes)+' 分钟。请结合实际试讲调整。</div>';
    }else if(editTab==='sources'){
      box.innerHTML=field('成果归属','<select data-slide="sourceOrigin">'+options(originNames,Core.sourceOrigin(s))+'</select>','模型依据素材判断；单一归属时省略重复标识，文献引用仍保留。')+field('内容性质','<select data-slide="evidence">'+options(evidenceNames,s.evidence||'teaching')+'</select>')+(s.citations||[]).map((c,i)=>'<div class="source-card"><div class="source-card-header"><span>来源 '+(i+1)+'</span><button class="text-button" data-remove-source="'+i+'" style="padding:0">移除</button></div>'+field('来源类型','<select data-citation="kind" data-source-index="'+i+'">'+options(sourceKinds,c.kind||'paper')+'</select>')+field('完整题名','<input data-citation="title" data-source-index="'+i+'" value="'+h(c.title)+'">')+field('期刊 / 机构（链接锚点）','<input data-citation="venue" data-source-index="'+i+'" value="'+h(c.venue)+'">')+field('年份','<input data-citation="year" data-source-index="'+i+'" value="'+h(c.year)+'">')+field('来源网址 / DOI 链接','<input data-citation="url" data-source-index="'+i+'" value="'+h(c.url)+'" placeholder="https://doi.org/…">')+field('发表状态（选填）','<input data-citation="status" data-source-index="'+i+'" value="'+h(c.status)+'" placeholder="如 Reviewed Preprint v2">')+'</div>').join('')+'<button class="button full" data-action="add-source">'+icon('plus')+'添加来源</button><p class="hint">只让期刊或机构名可点击。题名、年份和发表状态保持完整。保留链接不代表已经核实证据。</p>';
    }else{
      box.innerHTML=field('页面类型','<select data-slide="type">'+options(typeNames,s.type)+'</select>')+field('本页标题',slideInp('title',s.title))+field('所属章节',slideInp('section',s.section||'','input','list="section-options"'))+'<datalist id="section-options">'+getSections().map(x=>'<option value="'+h(x)+'">').join('')+'</datalist>';
      if(s.type==='cover'||s.type==='section')box.innerHTML+=field('副标题',slideInp('subtitle',s.subtitle||'','textarea','rows="3"'));
      else if(s.type==='comparison'){
        const columns=[0,1].map(i=>s.columns?.[i]||{title:i?'右栏':'左栏',body:[]});
        box.innerHTML+=columns.slice(0,2).map((c,i)=>field((i===0?'左':'右')+'栏标题','<input data-column="'+i+'" data-column-key="title" value="'+h(c.title)+'">')+field((i===0?'左':'右')+'栏要点（一行一条）','<textarea data-column="'+i+'" data-column-key="body" rows="4">'+h((c.body||[]).join('\n'))+'</textarea>')).join('');
      }else if(s.type==='table'){
        box.innerHTML+=tableEditor(s.table)+field('表格说明（选填）',slideInp('caption',s.caption||'','textarea','rows="2"'))+field('本页摘要（一行一条，可留空）',slideInp('body',(s.body||[]).join('\n'),'textarea','rows="3"'));
      }else{
        if(s.type==='figure')box.innerHTML+='<button class="button full" data-action="add-image">'+icon('image')+(s.image?'替换图片':'添加原始图片')+'</button><p class="hint">PNG / JPEG / WebP，单张不超过 8 MB。导出时保留比例。</p><div style="margin-top:14px">'+field('图注',slideInp('caption',s.caption||'','textarea','rows="2"'))+'</div>';
        box.innerHTML+=field('本页要点（一行一条）',slideInp('body',(s.body||[]).join('\n'),'textarea','rows="7"'));
      }
      box.innerHTML+='<p class="hint">需要强调的文字可写为 **重点**，预览与 PPT 中会显示为加粗。</p><hr>'+field('内容性质','<select data-slide="evidence">'+options(evidenceNames,s.evidence||'teaching')+'</select>');
    }
  }
  function download(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
  function safeFilename(v){return String(v||'校园汇报').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,80);}
  function saveProject(){download(new Blob([JSON.stringify(project,null,2)],{type:'application/json'}),safeFilename(project.title)+'.json');toast('项目文件已导出，可在下次导入继续编辑。');}
  async function exportPptx(){
    if(exporting)return;const r=Core.validateProject(project);if(r.errors?.length){leftTab='check';renderAll();toast('请先处理自检中列出的错误。');return;}
    exporting=true;renderAll();const snapshot=clone(project),payload=JSON.stringify({project:snapshot});
    try{
      let blob=null;
      if(session.user&&new Blob([payload]).size<=8*1024*1024&&snapshot.slides.length<=24){
        try{const response=await fetch('/api/export',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:payload});if(!response.ok){let data={};try{data=await response.json();}catch(_){}throw new Error(data.error||'服务暂不可用');}blob=await response.blob();if(!blob.size)throw new Error('导出文件为空。');}
        catch(_){toast('在线导出未完成，正在使用本地导出。');}
      }else if(session.user){toast('项目较大，正在使用本地导出。');}
      if(!blob)blob=await Export.exportPptx(snapshot);
      download(blob,safeFilename(snapshot.title)+'.pptx');toast('PPTX 已导出，可在 PowerPoint 或 WPS 中继续编辑。');
    }catch(e){toast('导出失败：'+(e.message||e));}finally{exporting=false;renderAll();}
  }
  function closeModal(){visualController?.dispose();visualController=null;visualOpening=false;const key=document.getElementById('model-api-key');if(key)key.value='';document.getElementById('modal-root').innerHTML='';modalOpen=false;modalKind='';}
  function openModal(kind){
    if(visualController||visualOpening)closeModal();
    let title='',sub='',body='';
    if(kind==='models'){
      title='管理生成模型';sub='选择平台模型，或添加你自己的模型服务。';body=modelManagerBody();
    }else if(kind==='delete-model'){
      const profile=modelProfiles.find(p=>p.id===modelEditingId);title='删除个人模型配置？';sub=profile?.name||'';body='<p>这项配置及其保存的密钥将被删除，已有素材和汇报会保留。</p><div class="modal-row"><button class="button primary" data-action="confirm-delete-model">删除配置</button><button class="button" data-action="manage-models">取消</button></div>';
    }else if(kind==='account'){
      title='你的工作区';sub='材料与汇报在这个浏览器的独立工作区保存。';
      body='<div class="account-summary"><span class="account-avatar">'+icon('user')+'</span><div><strong>'+h(session.user?.name||'访客工作区')+'</strong><p>下载项目备份后，可在其他浏览器继续编辑。</p></div></div><div class="modal-row"><button class="button" data-action="projects">查看我的汇报</button><button class="button" data-action="project-options">项目备份与导入</button>'+(!session.user?'<button class="button primary" data-action="retry-session">重新连接</button>':'')+'</div><p class="account-footnote">使用“管理模型”添加自己的模型服务。API Key 在服务器加密保存，不会出现在项目备份、PPTX 或公开样片中。</p>';
    }else if(kind==='project-options'){
      title='项目操作';sub='保存副本，或从新的材料开始。';
      body='<div class="modal-row"><button class="button" data-action="save-project" '+(!project.slides.length?'disabled':'')+'>下载项目备份（JSON）</button><button class="button" data-action="import-project">导入项目备份</button><button class="button" data-action="new-project">开始新汇报</button></div><p>项目备份保留文字、来源、图片与样式设置，可再次导入继续编辑。</p>';
    }else if(kind==='confirm-regenerate'){
      title='生成新的汇报初稿？';sub='将使用当前选中的素材与汇报要求。';
      body='<p>完成后，新的初稿将替换工作台中的当前内容。当前内容会保留在本次编辑的撤销记录中；你也可以先保存汇报或下载项目备份。</p><div class="modal-row"><button class="button primary" data-action="confirm-generate">生成新初稿</button><button class="button" data-action="close-modal">继续编辑</button></div>';
    }else if(kind==='confirm-new-project'){
      title='开始新的汇报？';sub='当前浏览器的编辑区将重置。';
      body='<p>已保存到工作区的汇报仍可从“我的汇报”打开。请先保存尚未同步的修改。</p><div class="modal-row"><button class="button primary" data-action="confirm-new-project">开始新汇报</button><button class="button" data-action="close-modal">取消</button></div>';
    }
    document.getElementById('modal-root').innerHTML='<div class="modal-backdrop" data-modal-backdrop="true"><section class="modal '+(kind==='account'?'account-modal':kind==='models'?'models-modal':'')+'" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><div><h2 id="modal-title">'+title+'</h2><p>'+sub+'</p></div><button class="close-button" data-action="close-modal" aria-label="关闭">'+icon('close')+'</button></header><div class="modal-content">'+body+'</div></section></div>';
    modalOpen=true;modalKind=kind;document.querySelector('.close-button').focus();
  }
  function formatDate(value){const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleString('zh-CN',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'});}
  function parseProjectText(text){
    if(text.length>Core.limits.projectBytes)throw new Error('项目内容过大，请压缩图片后导入。');
    const obj=JSON.parse(text);if(!obj||!Array.isArray(obj.slides)||!obj.slides.length)throw new Error('项目文件需要包含非空 slides 数组。');
    return Core.normalizeProject(obj);
  }
  function applyProject(next,message,id=null){remember();project=next;cloudProjectId=id;selected=0;persist();navigatePage('workbench');toast(message);}
  function expireSession(){generationController?.abort();closeModal();projectList=[];projectsError='';modelProfiles=[];profilesAvailable=false;profilesLoading=false;modelProfilesError='';selectedModelProfileId='platform';modelEditingId=null;session.user=null;storageKey=null;project=blankProject();materials=[];samples=[];instructions='';requestedDuration='';requestedSlideCount='';templateResult=null;progressEvents=[];selectedMaterialIds.clear();visionSummaries.clear();history.length=0;cloudProjectId=null;saveState='工作区连接已过期，请重新连接';renderAll();}
  async function request(path,options={}){
    let response;
    try{response=await fetch(path,{credentials:'same-origin',...options,headers:{...(options.body&&!(options.body instanceof FormData)?{'Content-Type':'application/json'}:{}),...options.headers}});}catch(cause){if(options.signal?.aborted)throw cause;const error=new Error('连接失败，请检查网络后重试。');error.status=503;throw error;}
    let data;try{data=await response.json();}catch(_){throw new Error('服务暂时无法返回结果，请稍后重试。');}
    if(!response.ok){if(response.status===401)expireSession();const error=new Error(typeof data.error==='string'?data.error:data.message||'请求未完成，请重试。');error.status=response.status;throw error;}
    return data;
  }
  async function initializeSession(){
    sessionLoaded=false;sessionError='';modelProfiles=[];profilesAvailable=false;profilesLoading=false;modelProfilesError='';modelEditingId=null;selectedModelProfileId='platform';renderAll();
    try{
      const next=await request('/api/session');session={...session,...next,limits:{...session.limits,...(next.limits||{})}};sessionLoaded=true;
      if(session.user){
        storageKey=STORAGE_PREFIX+encodeURIComponent(session.user.id);
        saveState='';
        try{const raw=localStorage.getItem(storageKey);if(raw){const saved=JSON.parse(raw);project=Core.normalizeProject(saved.project||saved);cloudProjectId=saved.cloudProjectId||null;instructions=typeof saved.instructions==='string'?saved.instructions:'';requestedDuration=savedRequestText(saved.requestedDuration);requestedSlideCount=savedRequestText(saved.requestedSlideCount);selectedModelProfileId=typeof saved.selectedModelProfileId==='string'?saved.selectedModelProfileId:'platform';saveState='';}}catch(_){saveState='';}
        renderAll();await Promise.allSettled([refreshMaterials(),loadSamples(),refreshModelProfiles(),activePage==='projects'?refreshProjects():Promise.resolve()]);
      }else{storageKey=null;saveState='连接后保存到你的工作区';renderAll();await loadSamples();}
    }catch(e){sessionLoaded=true;sessionError='工作区连接未完成：'+e.message;saveState='暂未连接';renderAll();}
  }
  function suggestedModels(){return [...new Set([session.model.name,...modelProfiles.map(p=>p.model),'deepseek-flash','deepseek-v4-pro'].map(value=>String(value||'').trim()).filter(Boolean))];}
  function publicModelProfile(value){return {id:String(value.id||''),name:String(value.name||''),apiUrl:String(value.apiUrl||''),model:String(value.model||''),inputChars:Number(value.inputChars)||400000,hasKey:Boolean(value.hasKey)};}
  function modelManagerBody(){
    if(profilesLoading)return '<div class="empty-state"><span class="spinner"></span><p>正在读取个人模型配置…</p></div>';
    if(modelProfilesError)return '<p class="model-inline-error">'+h(modelProfilesError)+'</p><button class="button" data-action="manage-models">重新加载</button>';
    const profile=modelProfiles.find(p=>p.id===modelEditingId)||null,disabled=(!profilesAvailable||modelSaving)?' disabled':'';
    const list='<div class="model-catalog"><div class="model-platform"><strong>平台默认模型</strong><span>'+h(platformModelLabel()||'未指定模型')+' · '+(session.model.configured?'已配置':'未配置')+'</span><p>可使用平台默认模型，也可添加你自己的模型服务。</p><button class="button small" data-use-model="platform" '+(!session.model.configured||modelSaving?'disabled':'')+'>使用平台默认</button></div>'+modelProfiles.map(p=>'<button class="model-profile-card '+(p.id===modelEditingId?'active':'')+'" data-edit-model="'+h(p.id)+'" '+(modelSaving?'disabled':'')+'><strong>'+h(p.name)+'</strong><span>'+h(p.model)+'</span><small>'+(p.hasKey?'密钥已保存':'尚未配置密钥')+(p.id===selectedModelProfileId?' · 当前使用':'')+'</small></button>').join('')+'<button class="button full" data-action="new-model"'+disabled+'>'+icon('plus')+'添加个人模型</button></div>';
    const form='<section class="model-form"><h3>'+(profile?'编辑个人配置':'添加个人模型')+'</h3>'+(!profilesAvailable?'<p class="model-inline-error">个人模型配置暂不可用，请稍后重试。</p>':'')+'<p class="model-form-intro">支持 OpenAI 兼容服务。请使用服务方提供的完整 HTTPS 接口地址。</p>'+field('配置名称','<input id="model-name" value="'+h(profile?.name||'')+'" maxlength="80" placeholder="例如：我的科研汇报模型"'+disabled+'>')+field('API 地址','<input id="model-api-url" type="url" inputmode="url" spellcheck="false" autocomplete="off" value="'+h(profile?.apiUrl||'')+'" maxlength="2048" placeholder="例如 https://api.deepseek.com/chat/completions"'+disabled+'>')+field('模型名','<input id="model-model" value="'+h(profile?.model||'')+'" maxlength="160" list="model-suggestions" spellcheck="false" placeholder="填写服务方提供的模型名"'+disabled+'>')+'<datalist id="model-suggestions">'+suggestedModels().map(name=>'<option value="'+h(name)+'"></option>').join('')+'</datalist>'+field('API 密钥','<input id="model-api-key" type="password" value="" autocomplete="new-password" spellcheck="false" autocapitalize="none" maxlength="4096" placeholder="'+(profile?.hasKey?'留空以保留已保存的密钥':'输入你的 API 密钥')+'"'+disabled+'>',profile?.hasKey?'修改 API 地址时，请重新填写密钥。':'密钥保存后不会在页面中显示。')+field('输入字符预算','<input id="model-input-chars" type="number" min="80000" max="1000000" step="1000" value="'+h(profile?.inputChars||400000)+'"'+disabled+'>','按实际模型容量设置；范围 80,000–1,000,000 字符。')+'<p id="model-form-error" class="model-inline-error" role="alert"></p><div class="modal-row"><button class="button primary" data-action="save-model"'+disabled+'>'+(modelSaving?'正在保存…':'保存并使用')+'</button>'+(profile?'<button class="button danger" data-action="delete-model"'+disabled+'>删除配置</button>':'')+'</div><p class="model-key-note">密钥不会写入项目文件或浏览器草稿。保存配置后，即可回到工作区选择生成模型。</p></section>';
    return '<div class="model-manager-grid">'+list+form+'</div>';
  }
  function showModelError(message){const box=document.getElementById('model-form-error');if(box)box.textContent=message;else toast(message);}
  function setModelFormBusy(busy){document.querySelectorAll('.models-modal input,.models-modal button:not(.close-button)').forEach(el=>{el.disabled=busy||!profilesAvailable;});}
  async function refreshModelProfiles(){
    if(!session.user)return;const accountId=session.user.id;profilesLoading=true;modelProfilesError='';if(leftTab==='content'){renderSettings();applyBusyState();}
    try{const data=await request('/api/model-profiles');if(session.user?.id!==accountId)return;profilesAvailable=data.available===true;modelProfiles=Array.isArray(data.profiles)?data.profiles.map(publicModelProfile).filter(p=>p.id):[];if(selectedModelProfileId!=='platform'&&!modelProfiles.some(p=>p.id===selectedModelProfileId))selectedModelProfileId='platform';}
    catch(error){if(session.user?.id===accountId){profilesAvailable=false;modelProfilesError=error.message||'个人模型配置暂时无法读取。';}}
    finally{profilesLoading=false;if(leftTab==='content'){renderSettings();applyBusyState();}if(modalOpen&&modalKind==='models'&&session.user)openModal('models');}
  }
  async function openModelManager(){if(visualBusy)return;if(!session.user){openModal('account');return;}if(generating||uploading||modelSaving){toast('当前任务完成后可管理模型。');return;}const work=refreshModelProfiles();openModal('models');await work;}
  async function saveModelProfile(){
    if(!session.user||!profilesAvailable||profilesLoading||modelSaving||uploading||generating||visualBusy)return;
    const keyInput=document.getElementById('model-api-key'),name=document.getElementById('model-name')?.value.trim()||'',rawUrl=document.getElementById('model-api-url')?.value.trim()||'',model=document.getElementById('model-model')?.value.trim()||'',inputChars=Number(document.getElementById('model-input-chars')?.value),profile=modelProfiles.find(p=>p.id===modelEditingId)||null;
    let apiUrl;
    try{const url=new URL(rawUrl);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error();apiUrl=url.href;}catch(_){showModelError('请填写不含工作区、密钥或查询参数的 HTTPS 接口地址。');return;}
    if(!name||!model){showModelError('请填写配置名称和模型名。');return;}
    if(!Number.isSafeInteger(inputChars)||inputChars<80000||inputChars>1000000){showModelError('输入字符预算须为 80,000–1,000,000 之间的整数。');return;}
    const apiKey=keyInput?.value.trim()||'';
    if(!apiKey&&(!profile?.hasKey||apiUrl!==profile.apiUrl)){showModelError(profile?'修改 API 地址后需要重新填写密钥。':'请填写 API 密钥。');return;}
    const accountId=session.user.id,payload={name,apiUrl,model,apiKey,inputChars};let savedSuccessfully=false;if(keyInput)keyInput.value='';modelSaving=true;showModelError('');setModelFormBusy(true);if(leftTab==='content')renderSettings();
    try{const data=await request('/api/model-profiles'+(profile?'/'+encodeURIComponent(profile.id):''),{method:profile?'PUT':'POST',body:JSON.stringify(payload)});if(session.user?.id!==accountId)return;if(!data.profile?.id)throw new Error('服务未返回保存结果，请重新加载列表确认。');const saved=publicModelProfile(data.profile);modelProfiles=[...modelProfiles.filter(p=>p.id!==saved.id),saved];selectedModelProfileId=saved.id;modelEditingId=saved.id;persist();savedSuccessfully=true;toast('模型配置已保存并选中。');}
    catch(error){if(session.user?.id===accountId)showModelError(error.message||'保存未完成，请重新填写密钥后重试。');}
    finally{payload.apiKey='';modelSaving=false;const input=document.getElementById('model-api-key');if(input)input.value='';if(savedSuccessfully&&modalOpen&&modalKind==='models')openModal('models');else setModelFormBusy(false);if(leftTab==='content'){renderSettings();applyBusyState();}}
  }
  async function deleteModelProfile(){
    if(!session.user||modelSaving||uploading||generating)return;const profile=modelProfiles.find(p=>p.id===modelEditingId);if(!profile)return;const accountId=session.user.id;modelSaving=true;
    document.querySelectorAll('.modal button:not(.close-button)').forEach(el=>el.disabled=true);
    try{await request('/api/model-profiles/'+encodeURIComponent(profile.id),{method:'DELETE'});if(session.user?.id!==accountId)return;modelProfiles=modelProfiles.filter(p=>p.id!==profile.id);if(selectedModelProfileId===profile.id)selectedModelProfileId='platform';modelEditingId=null;persist();toast('个人模型配置已删除。');if(modalOpen)openModal('models');}
    catch(error){toast('删除未完成：'+error.message);if(session.user&&modalOpen)openModal('models');}
    finally{modelSaving=false;if(session.user&&modalOpen&&modalKind==='models')openModal('models');if(leftTab==='content'){renderSettings();applyBusyState();}}
  }
  async function refreshMaterials(){
    if(!session.user)return;materialsLoading=true;renderMaterials();const accountId=session.user.id;
    try{const data=await request('/api/materials');if(session.user?.id!==accountId)return;materials=Array.isArray(data.materials)?data.materials:[];selectedMaterialIds=new Set(materials.filter(m=>materialIsReady(m)).map(m=>m.id));
      const pdfs=materials.filter(m=>(m.kind==='pdf'||/\.pdf$/i.test(m.name||''))&&['ready','needs_ocr'].includes(m.status));
      const outcomes=await Promise.allSettled(pdfs.map(m=>request('/api/materials/'+encodeURIComponent(m.id)+'/vision')));
      if(session.user?.id!==accountId)return;
      outcomes.forEach((outcome,i)=>{if(outcome.status==='fulfilled'){visionSummaries.set(pdfs[i].id,outcome.value);if(materialIsReady(pdfs[i]))selectedMaterialIds.add(pdfs[i].id);}});}
    catch(e){toast('素材列表读取失败：'+e.message);}finally{materialsLoading=false;if(leftTab==='content'){renderSettings();applyBusyState();}}
  }
  async function openPdfVisualModal(id){
    if(!session.user){openModal('account');return;}if(generating||uploading||visualBusy||visualOpening||modelSaving||profilesLoading)return;
    const material=materials.find(m=>m.id===id);if(!material||!['ready','needs_ocr'].includes(material.status))return;
    closeModal();visualOpening=true;modalOpen=true;modalKind='pdf-visuals';
    const root=document.getElementById('modal-root'),accountId=session.user.id,profileId=selectedModelProfileId;
    root.innerHTML='<div class="modal-backdrop" data-modal-backdrop="true"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><div><h2 id="modal-title">读取 PDF 图像</h2><p>'+h(material.name)+'</p></div><button class="close-button" data-action="close-modal" aria-label="关闭">'+icon('close')+'</button></header><div class="modal-content"><p>正在载入图像读取组件…</p></div></section></div>';
    try{
      const visualModule=await import('/pdf-visuals.js?v=20261016-publish36');
      if(!visualOpening||modalKind!=='pdf-visuals'||session.user?.id!==accountId)return;
      visualOpening=false;
      visualController=visualModule.createPdfVisuals({root,material,request,modelProfileId:profileId,modelLabel:profileId==='platform'?(platformModelLabel()||'平台默认'):selectedModelProfile()?.name+' · '+selectedModelProfile()?.model,modelReady:selectedModelReady(),canInsert:()=>Boolean(currentSlide()),onUnauthorized:expireSession,
        onBusy:value=>{visualBusy=value;renderAll();},
        onChange:value=>{visionSummaries.set(id,value);renderMaterials();},
        onCompleted:()=>{if(session.user?.id===accountId)void refreshMaterials();},
        onInsert:({result,dataUrl,width,height,regionId})=>{
          if(session.user?.id!==accountId||!currentSlide())throw new Error('当前汇报页已不可用，请重新打开汇报。');
          const selectedRegion=regionId||result.regionId;if(typeof selectedRegion!=='string'||!selectedRegion)throw new Error('请先选择识别出的论文插图区域。');
          const provenance=material.name+' · 第 '+result.page+' 页',brief=value=>value.length>90?value.slice(0,89)+'…':value,caption=brief(result.figureTitle||result.caption||'论文插图')+'（来源：'+(material.name.length>32?material.name.slice(0,31)+'…':material.name)+' · 第 '+result.page+' 页）';
          const next=clone(project),slide=next.slides[selected];
            slide.type='figure';slide.image={dataUrl,width,height,alt:result.figureTitle||provenance};slide.figureRef={materialId:id,page:result.page,regionId:selectedRegion};slide.caption=caption;
            slide.notes=[slide.notes,'原页来源：'+provenance,'原始图注：'+(result.caption||''),'图像解读：'+result.summary,...(Array.isArray(result.findings)?result.findings.map(x=>'图中信息：'+x):[]),...(Array.isArray(result.uncertainties)?result.uncertainties.map(x=>'待核对：'+x):[])].filter(Boolean).join('\n');
            slide.citations=slide.citations||[];if(!slide.citations.some(c=>c.title===material.name&&c.status==='第 '+result.page+' 页'))slide.citations.push({title:material.name,venue:'原始上传素材',year:'',url:'',kind:'paper',status:'第 '+result.page+' 页'});
          const checked=Core.normalizeProject(next);
          mutate(()=>{project=checked;});toast('第 '+result.page+' 页论文插图已加入当前页，来源与解读已保留。');
        }
      });
      root.querySelector('.close-button')?.focus();
    }catch(error){visualOpening=false;if(modalKind==='pdf-visuals')closeModal();throw error;}
  }
  function extractLargePdf(file,limits,onProgress){
    return new Promise((resolve,reject)=>{
      let worker=null,timer=null,settled=false;
      const finish=(error,result)=>{
        if(settled)return;settled=true;if(timer)clearTimeout(timer);
        if(worker){worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate();}
        if(error)reject(error);else resolve(result);
      };
      try{
        if(typeof Worker!=='function')throw new Error('当前浏览器不支持大文件读取，请使用支持 Web Worker 的浏览器后重试。');
        worker=new Worker('/pdf-extract-worker.js?v=20261016-publish36',{type:'module'});
        timer=setTimeout(()=>finish(new Error('PDF 读取超过 3 分钟，未取得完整结果。请删除记录后重试。')),180000);
        worker.onmessage=event=>{
          try{
            const data=event.data;
            if(!data||typeof data!=='object')throw new Error('PDF 读取返回了无效结果。');
            if(data.type==='progress'){
              if(Number.isFinite(data.page)&&Number.isFinite(data.total))onProgress(data.page,data.total);
            }else if(data.type==='error')finish(new Error(data.message||'PDF 读取失败，请删除记录后重试。'));
            else if(data.type==='result'){
              if(data.kind!=='pdf'||!['ready','needs_ocr'].includes(data.status)||typeof data.text!=='string')throw new Error('PDF 读取结果不完整，请删除记录后重试。');
              if(data.status==='ready'&&!data.text.trim())throw new Error('未能从 PDF 中读取可用文字。');
              finish(null,{text:data.text,kind:data.kind,status:data.status,message:data.message||'',pageCount:data.pageCount});
            }
          }catch(error){finish(error instanceof Error?error:new Error('PDF 读取异常，请重试。'));}
        };
        worker.onerror=event=>{if(event.preventDefault)event.preventDefault();finish(new Error('大文件读取组件未能完成处理，请删除记录后重试。'));};
        worker.onmessageerror=()=>finish(new Error('大文件读取结果无法接收，请删除记录后重试。'));
        worker.postMessage({file,maxText:limits.inputChars||400000,maxPages:300});
      }catch(error){finish(error instanceof Error?error:new Error('大文件读取组件无法启动，请重试。'));}
    });
  }
  async function uploadMaterials(files){
    if(visualBusy||visualOpening)return;if(!session.user){openModal('account');return;}if(uploading||generating)return;if(modelSaving||profilesLoading){toast('模型配置处理完成后即可上传。');return;}
    const incoming=Array.from(files),uploadModelProfileId=selectedModelProfileId,limits={...(session.limits||{maxFileMB:200,maxFiles:null,chunkMB:8,pdfParseMB:32}),inputChars:selectedInputChars()};
    const maxFileMB=Math.min(200,Number(limits.maxFileMB)||200);
    for(const file of incoming){if(!/\.(pdf|docx|pptx|txt|md|png|jpe?g)$/i.test(file.name)){toast('不支持 '+file.name+'，请选择 PDF、DOCX、PPTX、TXT、MD 或图片。');return;}if(file.size>maxFileMB*1024*1024){toast(file.name+' 超过 '+maxFileMB+' MB，请缩小后上传。');return;}}
    if(!incoming.length)return;
    const accountId=session.user.id;uploading=true;leftTab='content';renderAll();
    try{for(let index=0;index<incoming.length;index++){
      const file=incoming[index];let materialId=null;
      uploadMessage='正在准备 '+(index+1)+' / '+incoming.length+'：'+file.name;renderMaterials();
      try{
        const started=await request('/api/materials',{method:'POST',body:JSON.stringify({name:file.name,size:file.size,type:file.type})});
        if(session.user?.id!==accountId)return;if(!started.material?.id)throw new Error('服务未返回素材记录。');
        materialId=started.material.id;
        const row={...started.material,name:started.material.name||file.name,status:'uploading',uploadPercent:0,message:'正在分块上传，请保留当前页面。'};
        materials.push(row);selectedMaterialIds.delete(materialId);renderMaterials();
        const chunkBytes=Number.isSafeInteger(started.chunkBytes)&&started.chunkBytes>0&&started.chunkBytes<=16*1024*1024?started.chunkBytes:8*1024*1024;
        for(let start=0,part=0;start<file.size;start+=chunkBytes,part++){
          const end=Math.min(file.size,start+chunkBytes);
          uploadMessage='正在上传 '+(index+1)+' / '+incoming.length+'：'+file.name+' · '+Math.floor(start/file.size*100)+'%';renderMaterials();
          await request('/api/materials/'+encodeURIComponent(materialId)+'/parts/'+part,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:file.slice(start,end)});
          if(session.user?.id!==accountId)return;
          row.uploadPercent=Math.round(end/file.size*100);
          uploadMessage='正在上传 '+(index+1)+' / '+incoming.length+'：'+file.name+' · '+row.uploadPercent+'%';renderMaterials();
        }
        row.status='processing';row.message='文件已上传，正在提取可用文字。';delete row.uploadPercent;
        uploadMessage='正在提取 '+(index+1)+' / '+incoming.length+'：'+file.name;renderMaterials();
        let completionBody={modelProfileId:uploadModelProfileId};
        if(/\.pdf$/i.test(file.name)&&file.size>(Number(limits.pdfParseMB)||32)*1024*1024){
          row.message='文件已上传，正在读取 PDF 页面。';renderMaterials();
          const clientExtraction=await extractLargePdf(file,limits,(page,total)=>{
            if(session.user?.id!==accountId)return;
            row.message='正在读取第 '+page+' / '+total+' 页';
            uploadMessage=file.name+' · 正在读取第 '+page+' / '+total+' 页';renderMaterials();
          });
          if(session.user?.id!==accountId)return;
          completionBody={clientExtraction,modelProfileId:uploadModelProfileId};row.message='PDF 页面读取完成，正在保存提取结果。';
          uploadMessage='正在保存文字结果：'+file.name;renderMaterials();
        }
        const completed=await request('/api/materials/'+encodeURIComponent(materialId)+'/complete',{method:'POST',body:JSON.stringify(completionBody)});
        if(session.user?.id!==accountId)return;if(!completed.material?.id)throw new Error('未收到完整素材结果。');
        materials=materials.map(m=>m.id===materialId?completed.material:m);
        if(materialIsReady(completed.material))selectedMaterialIds.add(materialId);else selectedMaterialIds.delete(materialId);
      }catch(e){
        if(session.user?.id!==accountId)return;
        if(materialId){const row=materials.find(m=>m.id===materialId);if(row){row.status='failed';row.message=(e.message||'上传未完成。')+' 文件记录已保留，可删除后重新上传。';delete row.uploadPercent;}selectedMaterialIds.delete(materialId);}
        toast(file.name+'：'+e.message);
      }
      renderMaterials();
    }}finally{uploading=false;uploadMessage='';renderAll();}
  }
  async function deleteMaterial(id){if(!session.user||uploading||generating||visualBusy)return;await request('/api/materials/'+encodeURIComponent(id),{method:'DELETE'});materials=materials.filter(m=>m.id!==id);visionSummaries.delete(id);selectedMaterialIds.delete(id);renderSettings();toast('素材已移除。');}
  async function saveCloud(quiet=false){
    if(!session.user){openModal('account');return;}if(!project.slides.length||cloudSaving)return;
    const snapshot=clone(project),accountId=session.user.id;
    if(new Blob([JSON.stringify({project:snapshot})]).size>8*1024*1024){toast('图片较大，请压缩图片，或通过项目选项保存到本地。');return;}
    cloudSaving=true;renderAll();
    try{const data=await request('/api/projects',{method:'POST',body:JSON.stringify({project:snapshot,...(cloudProjectId?{id:cloudProjectId}:{})})});if(session.user?.id!==accountId)return;cloudProjectId=data.id||cloudProjectId;persist();saveState=JSON.stringify(snapshot)===JSON.stringify(project)?'汇报已保存至工作区':'新修改保存在浏览器，请再次同步';updateSaveState();if(!quiet)toast('汇报已保存。');}
    catch(e){if(!quiet)toast('保存未完成：'+e.message);else{saveState='已保留本地初稿，云保存未完成';updateSaveState();toast('初稿已生成，请稍后点击“保存汇报”重试。');}}
    finally{cloudSaving=false;renderAll();}
  }
  async function refreshProjects(){
    if(!session.user||projectsLoading)return;projectsLoading=true;projectsError='';renderProjects();const accountId=session.user.id;
    try{const data=await request('/api/projects');if(session.user?.id!==accountId)return;projectList=Array.isArray(data.projects)?data.projects:[];}
    catch(e){if(session.user?.id===accountId)projectsError=e.message;}
    finally{projectsLoading=false;renderProjects();}
  }
  async function openProjects(){navigatePage('projects');await refreshProjects();}
  async function openProject(id){if(generating)return;const data=await request('/api/projects/'+encodeURIComponent(id));applyProject(Core.normalizeProject(data.project),'汇报已打开。',id);saveState='已打开工作区中保存的汇报';updateSaveState();}
  async function generate(){
    if(visualBusy||visualOpening)return;if(!session.user){openModal('account');return;}if(generating||uploading)return;
    if(profilesLoading||modelSaving)return;if(!selectedModelReady()){toast('请选择已配置的模型，或在“管理模型”中添加。');return;}
    const selectedMaterials=readyMaterials().map(m=>({...m})),ids=selectedMaterials.map(m=>m.id);
    if(!ids.length){toast('请先上传并勾选已就绪的材料。');return;}
    if(selectedModelProfileId==='platform'&&session.model.imageInput===false&&selectedMaterials.some(m=>m.kind==='pdf'||/\.pdf$/i.test(m.name||''))){toast('当前平台模型不支持图像输入，请选择支持图像的个人模型后生成 PDF 汇报。');return;}
    let preferences;try{preferences=generationPreferences();}catch(error){toast(error.message);return;}
    const accountId=session.user.id,profileId=selectedModelProfileId,theme=clone(project.theme);
    const payload={materialIds:ids,modelProfileId:profileId,title:project.title==='未命名汇报'?'':project.title,instructions,scene:project.scene,...preferences,theme,presenter:project.presenter};
    closeModal();generating=true;generationError='';progressEvents=['正在准备所选材料…'];
    const controller=new AbortController();generationController=controller;renderAll();let result=null;
    function report(message){progressEvents.push(String(message||'正在生成…'));if(progressEvents.length>12)progressEvents.shift();renderGenerationStatus();}
    try{
      if(selectedMaterials.some(m=>m.kind==='pdf'||/\.pdf$/i.test(m.name||''))){
        const {preparePdfMaterials}=await import('/pdf-generation.js?v=20261016-publish36');
        if(controller.signal.aborted)throw new DOMException('已停止生成。','AbortError');
        await preparePdfMaterials({materials:selectedMaterials,request,modelProfileId:profileId,signal:controller.signal,onUnauthorized:expireSession,
          onProgress:event=>report(event.message),onChange:(id,value)=>{if(session.user?.id===accountId){visionSummaries.set(id,value);renderMaterials();}}});
        if(session.user?.id!==accountId)return;
      }
      report('材料图文理解完成，正在组织汇报与原图…');
      const response=await fetch('/api/generate',{method:'POST',credentials:'same-origin',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(!response.ok){let error={};try{error=await response.json();}catch(_){}if(response.status===401)expireSession();throw new Error(typeof error.error==='string'?error.error:error.message||'生成服务暂不可用，请重试。');}
      if(!response.body)throw new Error('浏览器未收到生成结果，请重试。');
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      function consume(line){if(!line.trim())return;let event;try{event=JSON.parse(line);}catch(_){throw new Error('生成结果格式不完整，请重试。');}if(event.type==='progress')report(event.message);else if(event.type==='error')throw new Error(event.message||'生成未完成。');else if(event.type==='result')result=event;}
      try{while(true){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});if(buffer.length>Core.limits.projectBytes*2)throw new Error('生成结果超过当前容量，请减少页数重试。');let newline;while((newline=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,newline));buffer=buffer.slice(newline+1);}}buffer+=decoder.decode();if(buffer.trim())consume(buffer);}catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
      if(session.user?.id!==accountId)return;if(!result?.project)throw new Error('未收到完整汇报，请重试。');
      const next=Core.normalizeProject({...result.project,theme});if(!next.slides.length)throw new Error('生成结果中没有页面，请补充材料后重试。');
      remember();project=next;selected=0;cloudProjectId=result.projectId||null;persist();saveState=cloudProjectId?'初稿已生成并保存至工作区':'初稿已生成，正在保存…';updateSaveState();generating=false;navigatePage('workbench');
      if(!cloudProjectId)await saveCloud(true);toast('汇报初稿已生成，可逐页修改。');
    }catch(e){if(session.user?.id===accountId){generationError=controller.signal.aborted?'已停止生成，已完成的图文理解记录会保留。再次生成将继续处理。':e.message||'连接中断，请稍后重试。';toast('生成未完成，当前内容已保留。');}}
    finally{if(generationController===controller)generationController=null;generating=false;renderAll();}
  }
  function safeSampleUrl(value){try{const url=new URL(value,window.location.href);return url.origin===window.location.origin&&['http:','https:'].includes(url.protocol)?url.pathname+url.search:'';}catch(_){return '';}}
  async function loadSamples(){samplesLoading=true;try{const response=await fetch('/api/samples',{credentials:'same-origin'});if(response.ok){const data=await response.json();samples=Array.isArray(data.samples)?data.samples:[];}}catch(_){}finally{samplesLoading=false;renderSamples();}}
  function renderSamples(){
    const box=document.getElementById('sample-gallery');if(!box)return;
    sampleViewer?.dispose();sampleViewer=null;const sequence=++sampleViewerSequence;
    const selectedSample=samples.find(s=>s.id===selectedSampleId);
    if(selectedSample&&session.user){
      box.innerHTML='<div class="empty-state" role="status"><span class="spinner"></span><p>正在载入只读样片…</p></div>';
      void import('/sample-viewer.js?v=20261016-publish36').then(module=>{
        if(sequence!==sampleViewerSequence||activePage!=='samples'||selectedSampleId!==selectedSample.id)return;
        sampleViewer=module.createSampleViewer({root:box,sample:selectedSample,onBack:()=>{selectedSampleId=null;renderSamples();document.querySelector('[data-sample-preview="'+selectedSample.id+'"]')?.focus();},onUnauthorized:expireSession});
      }).catch(()=>{if(sequence===sampleViewerSequence){box.innerHTML='<div class="page-empty"><p>样片查看器暂时无法加载，请稍后重试。</p><button class="button" data-action="sample-back">返回样片</button></div>';}});
      return;
    }
    if(samplesLoading){box.innerHTML='<div class="empty-state" role="status"><span class="spinner"></span><p>正在读取汇报样片…</p></div>';return;}
    if(!samples.length&&(session.user||!sessionLoaded)){box.innerHTML='<div class="page-empty"><p>样片暂时无法显示，请稍后重新加载。</p><button class="button" data-action="reload-samples">重新加载样片</button></div>';return;}
    const groups=[{id:'course',title:'课程汇报',ids:['course']},{id:'lab',title:'组会汇报',ids:['green-space']},{id:'journal',title:'文献分享',ids:['journal']}];
    const card=s=>'<article class="sample-card"><button class="sample-preview" data-sample-preview="'+h(s.id)+'" aria-label="只读预览 PDF：'+h(s.title)+'">'+(session.user&&safeSampleUrl(s.thumbnailUrl)?'<img loading="lazy" src="'+h(safeSampleUrl(s.thumbnailUrl))+'" alt="'+h(s.title)+'预览">':'<div class="sample-locked">'+icon('file')+'<span>打开查看样片</span></div>')+'</button><div class="sample-copy"><h3>'+h(s.title)+'</h3><p>'+h(s.description||'')+'</p><div><span>只读 PDF'+(s.slides?' · 全'+h(s.slides)+'页':'')+((s.sizeBytes||s.size)?' · '+(Number(s.sizeBytes||s.size)/1024/1024).toFixed(1)+' MB':'')+'</span><button class="text-button" data-sample-download="'+h(s.id)+'">只读预览 PDF →</button></div></div></article>';
    box.innerHTML='<div class="samples-heading"><div><span class="eyebrow">真实汇报样片</span><h2>看一份汇报，可以长什么样</h2></div><p>从不同汇报场景，寻找叙事与版式参考</p></div><div class="sample-sections">'+groups.map((group,index)=>{
      const entries=group.ids.map(id=>samples.find(s=>s.id===id)).filter(Boolean);
      return '<section class="sample-category" data-sample-category="'+group.id+'" aria-labelledby="sample-category-'+group.id+'"><header><span class="sample-category-number">'+String(index+1).padStart(2,'0')+'</span><h2 id="sample-category-'+group.id+'">'+group.title+'</h2></header><div class="sample-category-content">'+(entries.length?'<div class="samples-grid">'+entries.map(card).join('')+'</div>':group.ids.length&&!session.user?'<div class="sample-category-empty sample-category-locked"><span>连接后查看样片</span><button class="text-button" data-action="account">打开查看 →</button></div>':'<div class="sample-category-empty"><span>样片待补充</span></div>')+'</div></section>';
    }).join('')+'</div>';
  }
  function showSample(id){const sample=samples.find(s=>s.id===id);if(!sample)return;if(!session.user){openModal('account');return;}selectedSampleId=id;renderSamples();document.getElementById('sample-gallery')?.scrollIntoView({block:'start',behavior:'auto'});}
  async function handleAction(action,control){
    const allowedWhileBusy=['guide','projects','samples','account','close-modal','workbench','dismiss-error','cancel-generation'];
    if((generating||visualBusy)&&!allowedWhileBusy.includes(action))return;
    switch(action){
      case 'workbench':navigatePage('workbench');break;
      case 'guide':navigatePage('guide');break;
      case 'samples':navigatePage('samples');break;
      case 'reload-samples':await loadSamples();break;
      case 'sample-back':selectedSampleId=null;renderSamples();break;
      case 'account':case 'project-options':openModal(action);break;
      case 'cancel-generation':generationController?.abort();break;
      case 'projects':await openProjects();break;
      case 'manage-models':await openModelManager();break;
      case 'new-model':if(!uploading&&!generating&&!modelSaving){modelEditingId=null;openModal('models');}break;
      case 'save-model':await saveModelProfile();break;
      case 'delete-model':if(!uploading&&!generating&&!modelSaving)openModal('delete-model');break;
      case 'confirm-delete-model':await deleteModelProfile();break;
      case 'retry-session':await initializeSession();break;
      case 'close-modal':closeModal();break;
      case 'dismiss-error':generationError='';renderGenerationStatus();break;
      case 'undo':if(history.length){project=history.pop();cloudProjectId=null;selected=Math.max(0,Math.min(selected,project.slides.length-1));persist();renderAll();toast('已撤销上一次修改。');}break;
      case 'new-project':if(project.slides.length)openModal('confirm-new-project');else await handleAction('confirm-new-project');break;
      case 'confirm-new-project':remember();project=blankProject();cloudProjectId=null;selected=0;instructions='';requestedDuration='';requestedSlideCount='';selectedMaterialIds.clear();templateResult=null;generationError='';leftTab='content';persist();navigatePage('workbench');break;
      case 'cloud-save':await saveCloud();break;
      case 'save-project':saveProject();break;
      case 'import-project':document.getElementById('project-file').click();break;
      case 'import-template':document.getElementById('template-file').click();break;
      case 'upload-materials':if(!sessionLoaded)return;if(!session.user)openModal('account');else if(!uploading)document.getElementById('material-file').click();break;
      case 'generate':if(!session.user)openModal('account');else if(project.slides.length)openModal('confirm-regenerate');else await generate();break;
      case 'confirm-generate':await generate();break;
      case 'add-image':document.getElementById('image-file').click();break;
      case 'export':await exportPptx();break;
      case 'add-slide':mutate(()=>{const section=currentSlide()?.section||getSections()[0]||'主要内容';const s={id:'slide-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,6),type:'bullets',section,title:'新页面',body:[],columns:[{title:'左栏',body:[]},{title:'右栏',body:[]}],citations:[],notes:'',evidence:'teaching',durationSec:60};const index=project.slides.length?selected+1:0;project.slides.splice(index,0,s);selected=index;});break;
      case 'delete-slide':if(project.slides.length<=1){toast('请至少保留一页。');break;}mutate(()=>{project.slides.splice(selected,1);selected=Math.min(selected,project.slides.length-1);});break;
      case 'move-up':if(selected>0)mutate(()=>{[project.slides[selected-1],project.slides[selected]]=[project.slides[selected],project.slides[selected-1]];selected--;});break;
      case 'move-down':if(selected<project.slides.length-1)mutate(()=>{[project.slides[selected+1],project.slides[selected]]=[project.slides[selected],project.slides[selected+1]];selected++;});break;
      case 'add-source':if(currentSlide())mutate(()=>{currentSlide().citations=currentSlide().citations||[];currentSlide().citations.push({title:'',venue:'',year:'',url:'',kind:'paper',status:''});});break;
      case 'add-table-column':if(currentSlide()?.type==='table'&&currentSlide().table.columns.length<Core.tableLimits.columns)mutate(()=>{const table=currentSlide().table;table.columns.push('列 '+(table.columns.length+1));table.rows.forEach(row=>row.push(''));});break;
      case 'add-table-row':if(currentSlide()?.type==='table'&&currentSlide().table.rows.length<Core.tableLimits.rows)mutate(()=>{const table=currentSlide().table;table.rows.push(table.columns.map(()=>''));});break;
      case 'remove-table-column':{const table=currentSlide()?.table,index=Number(control?.dataset.tableColumn);if(currentSlide()?.type==='table'&&table.columns.length>1&&Number.isInteger(index)&&index>=0&&index<table.columns.length)mutate(()=>{table.columns.splice(index,1);table.rows.forEach(row=>row.splice(index,1));});break;}
      case 'remove-table-row':{const table=currentSlide()?.table,index=Number(control?.dataset.tableRow);if(currentSlide()?.type==='table'&&Number.isInteger(index)&&index>=0&&index<table.rows.length)mutate(()=>table.rows.splice(index,1));break;}
    }
  }
  document.addEventListener('click',async event=>{
    const link=event.target.closest('a[data-page]');
    if(link&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey&&event.button===0){event.preventDefault();if(link.dataset.page==='projects')await openProjects();else navigatePage(link.dataset.page);return;}
    const b=event.target.closest('button');
    if(b){
      if(b.dataset.action){try{await handleAction(b.dataset.action,b);}catch(e){toast(e.message||'操作失败，请重试。');}return;}
      if(b.dataset.tab){leftTab=b.dataset.tab;renderAll();return;}
      if(b.dataset.readPdf){try{await openPdfVisualModal(b.dataset.readPdf);}catch(e){toast(e.message||'图像读取窗口未能打开。');}return;}
      if(b.dataset.deleteMaterial){try{await deleteMaterial(b.dataset.deleteMaterial);}catch(e){toast(e.message);}return;}
      if(b.dataset.editModel){if(!uploading&&!generating&&!modelSaving){modelEditingId=b.dataset.editModel;openModal('models');}return;}
      if(b.dataset.useModel){if(!uploading&&!generating&&!modelSaving){selectedModelProfileId=b.dataset.useModel;persist();renderAll();closeModal();toast('已选择生成模型。');}return;}
      if(b.dataset.openProject){try{await openProject(b.dataset.openProject);}catch(e){toast(e.message);}return;}
      if(b.dataset.samplePreview){showSample(b.dataset.samplePreview);return;}
      if(b.dataset.sampleDownload){showSample(b.dataset.sampleDownload);return;}
      if(b.dataset.profile){mutate(()=>{project.theme=Core.applyVisualProfile(project.theme,b.dataset.profile);templateResult=null;});return;}
      if(b.dataset.editTab){editTab=b.dataset.editTab;renderAll();return;}
      if(b.dataset.slideIndex!==undefined){selectSlide(Number(b.dataset.slideIndex));return;}
      if(b.dataset.nav){mutate(()=>project.theme.nav=b.dataset.nav);return;}
      if(b.dataset.palette){const p=Core.palettes.find(p=>p.id===b.dataset.palette);if(p)mutate(()=>{Object.assign(project.theme,{palette:p.id,accent:p.accent,secondary:p.secondary,background:p.background,text:p.text});});return;}
      if(b.dataset.removeSource!==undefined){mutate(()=>currentSlide().citations.splice(Number(b.dataset.removeSource),1));return;}
      if(b.dataset.jumpId){const idx=project.slides.findIndex(s=>s.id===b.dataset.jumpId);if(idx>=0)selectSlide(idx);return;}
      if(b.dataset.jumpSection){const idx=project.slides.findIndex(s=>s.section===b.dataset.jumpSection);if(idx>=0)selectSlide(idx);return;}
    }
    if(event.target.dataset.modalBackdrop)closeModal();
  });
  document.addEventListener('change',event=>{
    const e=event.target;
    if(generating||visualBusy)return;
    if(e.id==='model-profile-select'){if(uploading||modelSaving||profilesLoading)return;selectedModelProfileId=e.value==='platform'||modelProfiles.some(p=>p.id===e.value)?e.value:'platform';persist();renderSettings();return;}
    if(e.dataset.materialSelect){if(e.checked)selectedMaterialIds.add(e.dataset.materialSelect);else selectedMaterialIds.delete(e.dataset.materialSelect);renderSettings();return;}
    if(e.id==='requested-duration'||e.id==='slide-count'){const value=e.validity?.badInput?'?':e.value;if(e.id==='requested-duration')requestedDuration=value;else requestedSlideCount=value;persist();return;}
    if(e.dataset.tableHeading!==undefined){const index=Number(e.dataset.tableHeading);if(currentSlide()?.type==='table'&&Number.isInteger(index)&&index>=0&&index<currentSlide().table.columns.length){mutate(()=>currentSlide().table.columns[index]=e.value,true);document.querySelectorAll('[data-table-label="'+index+'"]').forEach(label=>label.textContent=Core.plainInlineText(currentSlide().table.columns[index])||'第 '+(index+1)+' 列');}return;}
    if(e.dataset.tableRow!==undefined&&e.dataset.tableColumn!==undefined){const row=Number(e.dataset.tableRow),column=Number(e.dataset.tableColumn),table=currentSlide()?.table;if(currentSlide()?.type==='table'&&Number.isInteger(row)&&Number.isInteger(column)&&row>=0&&row<table.rows.length&&column>=0&&column<table.columns.length)mutate(()=>table.rows[row][column]=e.value,true);return;}
    if(e.dataset.project){const key=e.dataset.project;mutate(()=>project[key]=e.value,true);}
    else if(e.dataset.theme){mutate(()=>project.theme[e.dataset.theme]=e.dataset.theme==='showBrand'?e.value==='true':e.value);}
    else if(e.dataset.slide){const key=e.dataset.slide;mutate(()=>{currentSlide()[key]=key==='body'?e.value.split('\n').map(x=>x.trim()).filter(Boolean):key==='durationSec'?Math.max(0,Math.min(1800,Number(e.value)||0)):e.value;if(key==='type'&&e.value==='comparison'&&(!currentSlide().columns||currentSlide().columns.length<2))currentSlide().columns=[{title:'左栏',body:[]},{title:'右栏',body:[]}];if(key==='type'&&e.value==='table'&&!currentSlide().table)currentSlide().table={columns:['列 1','列 2'],rows:[['','']]};},key!=='type');if(key==='type')renderEditor();}
    else if(e.dataset.column!==undefined){mutate(()=>{if(!currentSlide().columns||currentSlide().columns.length<2)currentSlide().columns=[0,1].map(i=>currentSlide().columns?.[i]||{title:i?'右栏':'左栏',body:[]});const c=currentSlide().columns[Number(e.dataset.column)];c[e.dataset.columnKey]=e.dataset.columnKey==='body'?e.value.split('\n').filter(x=>x.trim()):e.value;},true);}
    else if(e.dataset.citation){mutate(()=>currentSlide().citations[Number(e.dataset.sourceIndex)][e.dataset.citation]=e.value,true);}
    else if(e.id==='custom-color'){mutate(()=>{project.theme.accent=e.value;project.theme.palette='custom';});}
    else if(e.id==='aspect-ratio'){if(e.value!=='custom')mutate(()=>{project.theme.width=e.value==='standard'?10:13.333333;project.theme.height=7.5;});}
  });
  document.addEventListener('input',e=>{if(e.target.id==='generation-instructions'){instructions=e.target.value;persist();}});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&modalOpen){closeModal();return;}if(modalOpen&&e.key==='Tab'){const controls=[...document.querySelectorAll('.modal button,.modal a,.modal textarea,.modal input,.modal select')].filter(x=>!x.disabled);if(!controls.length)return;const first=controls[0],last=controls[controls.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
  document.getElementById('material-file').addEventListener('change',async e=>{const files=Array.from(e.target.files);e.target.value='';if(files.length)await uploadMaterials(files);});
  document.addEventListener('dragover',e=>{if(e.target.closest('.material-dropzone')){e.preventDefault();e.target.closest('.material-dropzone').classList.add('dragging');}});
  document.addEventListener('dragleave',e=>{e.target.closest?.('.material-dropzone')?.classList.remove('dragging');});
  document.addEventListener('drop',async e=>{if(e.target.closest('.material-dropzone')){e.preventDefault();e.target.closest('.material-dropzone').classList.remove('dragging');await uploadMaterials(e.dataTransfer.files);}});
  document.getElementById('project-file').addEventListener('change',async e=>{
    const f=e.target.files[0];e.target.value='';if(!f)return;
    try{if(!/\.json$/i.test(f.name))throw new Error('请选择本工作台导出的 JSON 项目备份。');if(f.size>Core.limits.projectBytes)throw new Error('项目不能超过 '+Math.round(Core.limits.projectBytes/1024/1024)+' MB。');applyProject(parseProjectText(await f.text()),'已导入 '+f.name+'。');}catch(err){toast('导入失败：'+err.message);}
  });
  document.getElementById('template-file').addEventListener('change',async e=>{
    const f=e.target.files[0];e.target.value='';if(!f)return;
    try{if(f.size>Core.limits.templateBytes)throw new Error('首版模板文件限制为 '+Math.round(Core.limits.templateBytes/1024/1024)+' MB，请使用精简模板副本。');toast('正在读取模板样式…');const result=await Export.readTemplate(await f.arrayBuffer(),f.name);mutate(()=>{templateResult=result;Object.assign(project.theme,result.theme,{palette:'custom',profile:'standard',showBrand:false});});toast('已应用模板字体、主题色与尺寸。自定义校标及复杂母版需另行适配。');}catch(err){toast('模板读取失败：'+err.message);}
  });
  document.getElementById('image-file').addEventListener('change',async e=>{
    const f=e.target.files[0];e.target.value='';if(!f)return;const targetId=currentSlide()?.id;
    try{if(f.size>8*1024*1024)throw new Error('单张图片不能超过 8 MB。');if(!/^image\/(png|jpeg|webp)$/.test(f.type))throw new Error('请选择 PNG、JPEG 或 WebP 图片。');const dataUrl=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('图片无法读取。'));r.readAsDataURL(f);});const img=await new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>reject(new Error('图片格式损坏。'));im.src=dataUrl;});if(img.width*img.height>40000000)throw new Error('图片像素过大，请先缩小至 4000 万像素以内。');let output=dataUrl;if(f.type==='image/webp'){const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;canvas.getContext('2d').drawImage(img,0,0);output=canvas.toDataURL('image/png');}if(!Core.isSafeImageDataUrl(output))throw new Error('转换后的图片超过 8 MB，请缩小图片后重试。');const next=clone(project);const s=next.slides.find(s=>s.id===targetId);if(!s)throw new Error('目标页面已不存在。');s.image={dataUrl:output,width:img.width,height:img.height,alt:f.name};const checked=Core.normalizeProject(next);mutate(()=>{project=checked;});toast('图片已加入，保持原始比例。');}catch(err){toast(err.message);}
  });
  window.addEventListener('popstate',()=>{activePage=Navigation.resolve(window.location.pathname);closeModal();renderAll();if(activePage==='projects')void refreshProjects();});
  window.CampusPPTWorkbench={getProject:()=>clone(project),loadProject:value=>applyProject(Core.normalizeProject(value),'项目已载入。')};
  renderAll();
  initializeSession();
})();
