import { json, requireUser, checkOrigin, readJSON } from '../../../../../server/platform';
import { VISION_LIMITS, analyzeVisualPage, saveVisualCrop, listVisualPages, visionFailure } from '../../../../../server/vision';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: any) {
  try {
    const user = await requireUser(request), { id } = await params;
    const profile = new URL(request.url).searchParams.get('modelProfileId');
    return json(await listVisualPages(user.id,id,profile === null ? undefined : profile));
  }
  catch (error) { return visionFailure(error); }
}

export async function POST(request: Request, { params }: any) {
  try {
    checkOrigin(request); const user = await requireUser(request), { id } = await params;
    const input = await readJSON(request,VISION_LIMITS.bodyBytes);
    return json(input?.action === 'save-crop' ? await saveVisualCrop(user.id,id,input) : await analyzeVisualPage(user.id,id,input,request.signal));
  } catch (error) { return visionFailure(error); }
}
