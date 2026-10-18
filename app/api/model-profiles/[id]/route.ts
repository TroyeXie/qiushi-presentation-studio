import { json, requireUser, checkOrigin, readJSON, failure } from '../../../../server/platform';
import { readModelProfile, updateModelProfile, deleteModelProfile } from '../../../../server/model-profiles';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: any) {
  try { const user = await requireUser(request); return json({ profile: await readModelProfile(user.id, (await params).id) }); }
  catch (error) { return failure(error); }
}
export async function PUT(request: Request, { params }: any) {
  try {
    checkOrigin(request); const user = await requireUser(request);
    return json({ profile: await updateModelProfile(user.id, (await params).id, await readJSON(request, 16 * 1024)) });
  } catch (error) { return failure(error); }
}
export async function DELETE(request: Request, { params }: any) {
  try { checkOrigin(request); const user = await requireUser(request); await deleteModelProfile(user.id, (await params).id); return json({ deleted: true }); }
  catch (error) { return failure(error); }
}
