import { env, json, requireUser, checkOrigin, readJSON } from '@/server/platform';
import { loadMaterials, hydrateProjectImages } from '@/server/materials';
import { saveProject } from '@/server/projects';
import { callModel, checkMaterials, parseGenerationInput, reserveGenerationJob, GenerationError } from '@/server/generation';
import { resolveInputChars } from '@/server/limits';
import { resolveModelConfig } from '@/server/model-profiles';
import { VisionError } from '@/server/vision';

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const user = await requireUser(request);
    const input = parseGenerationInput(await readJSON(request, 1024 * 1024));
    // Resolve and authorize one profile before reading materials or charging a generation slot.
    // Custom profiles never borrow platform credentials or silently fall back to the platform.
    const modelConfig = await resolveModelConfig(user.id, input.modelProfileId);
    const maxInputChars = resolveInputChars(modelConfig.inputChars);
    const materials = await loadMaterials(user.id, input.materialIds, maxInputChars, input.instructions.length, modelConfig);
    checkMaterials(materials, input, maxInputChars);
    const jobId = await reserveGenerationJob(env.DB, user.id);
    const abort = new AbortController();
    const cancel = () => abort.abort();
    request.signal.addEventListener('abort', cancel, { once: true });
    const encoder = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (value: unknown) => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(JSON.stringify(value) + '\n')); }
          catch { closed = true; abort.abort(); }
        };
        const heartbeat = setInterval(() => emit({ type: 'progress', message: '模型仍在生成页面，请保持此页面打开…' }), 15_000);
        try {
          emit({ type: 'progress', message: '素材图文与版面识别已完成，正在组织汇报…' });
          const result = await callModel(input, materials, modelConfig, fetch, abort.signal,
            () => emit({type:'progress',message:'主用额度不足，正在使用团队备用额度生成…'}));
          emit({ type:'progress',message:'正在关联已读取的原页图像与图注…' });
          await hydrateProjectImages(user.id,result.project);
          emit({ type: 'progress', message: '页面与来源检查已通过，正在保存项目…' });
          const saved = await saveProject(user.id, result.project);
          await env.DB.prepare("UPDATE jobs SET status='completed',usage_json=? WHERE id=? AND user_id=? AND status='running'")
            .bind(JSON.stringify(result.usage), jobId, user.id).run();
          emit({ type: 'result', project: result.project, projectId: saved.id, usage: result.usage, jobId });
        } catch (error) {
          const responseError:any=error instanceof Response?await error.json().catch(()=>({})):null;
          const message = error instanceof GenerationError || error instanceof VisionError ? error.message : responseError?.error || '生成或保存失败，请稍后重试。';
          try { await env.DB.prepare("UPDATE jobs SET status='failed',error=? WHERE id=? AND user_id=? AND status='running'").bind(message, jobId, user.id).run(); }
          catch { /* Stale-job cleanup frees the slot after an interrupted database connection. */ }
          emit({ type: 'error', message, jobId });
        } finally {
          clearInterval(heartbeat);
          request.signal.removeEventListener('abort', cancel);
          if (!closed) { closed = true; controller.close(); }
        }
      },
      cancel() { closed = true; abort.abort(); },
    });
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof GenerationError || error instanceof VisionError) return json({ error: error.message }, error.status);
    return json({ error: '暂时无法启动生成，请稍后重试。' }, 500);
  }
}
