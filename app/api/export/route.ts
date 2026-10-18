import { json, requireUser, checkOrigin, readJSON } from '@/server/platform';
import { Core } from '@/server/core';
import PptxGenJS from 'pptxgenjs';
import '@/public/pptx.js';
import sealData from '@/public/brand/zju-seal.png?inline';
import wordmarkData from '@/public/brand/zju-wordmark.png?inline';

type ExportRuntime = {
  PptxGenJS?: typeof PptxGenJS;
  CampusPPTExport: { exportPptx(project: unknown, options?: { brandAssets: Record<string, string> }): Promise<Blob> };
};

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    await requireUser(request);
    const raw = await readJSON(request, 8 * 1024 * 1024);
    const project = Core.normalizeProject(raw.project ?? raw);
    const review = Core.validateProject(project);
    if (review.errors.length) return json({ error: '请先修正项目中的结构或排版错误后导出。', issues: review.errors }, 422);
    if (project.slides.length > 24) return json({ error: '在线导出最多支持 24 页，请拆分项目。' }, 413);
    const runtime = globalThis as unknown as ExportRuntime;
    runtime.PptxGenJS = PptxGenJS;
    const blob = await runtime.CampusPPTExport.exportPptx(project, { brandAssets: {
      '/brand/zju-seal.png': sealData,
      '/brand/zju-wordmark.png': wordmarkData,
    } });
    const fileName = `${project.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 80) || '求是汇报'}.pptx`;
    return new Response(blob, { headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': `attachment; filename="presentation.pptx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    } });
  } catch (error) {
    if (error instanceof Response) return error;
    return json({ error: '导出失败，请检查页面内容、来源格式与图片大小后重试。' }, 422);
  }
}
