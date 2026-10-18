import type {ExtractedMaterial} from './extract';
export function validateBrowserPdf(value:any,maxText:number):ExtractedMaterial {
  if(!value||value.kind!=='pdf'||!['ready','needs_ocr'].includes(value.status)||
     !Number.isInteger(value.pageCount)||value.pageCount<1||value.pageCount>300||
     typeof value.text!=='string'||!value.text.trim())throw new Error('PDF文字提取结果不完整，请重新上传。');
  if(value.text.length>maxText)throw new Error(`材料文字超过当前配置的 ${maxText.toLocaleString('en-US')} 字符预算，请减少内容或调整模型配置。`);
  const headings=[...value.text.matchAll(/^\[第 (\d+) 页\](?:\r?\n|$)/gm)];
  if(headings.length!==value.pageCount||headings.some((m,i)=>Number(m[1])!==i+1))throw new Error('PDF页码不完整，请重新提取；未省略任何页面。');
  const empty=headings.some((m,i)=>!value.text.slice((m.index||0)+m[0].length,i+1<headings.length?headings[i+1].index:value.text.length).trim());
  const status=value.status==='needs_ocr'||empty?'needs_ocr':'ready';
  return {kind:'pdf',text:value.text,status,message:status==='ready'
    ?`PDF 全部 ${value.pageCount} 页已保存；生成汇报时自动读取图文，重建正文阅读顺序并整合图表、公式与表格。`
    :'PDF 原件与页码已保存；生成汇报时自动识别扫描内容、图表与版面阅读顺序。'};
}
