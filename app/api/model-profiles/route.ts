import { json, requireUser, checkOrigin, readJSON, failure } from '../../../server/platform';
import { listModelProfiles, createModelProfile, modelProfilesAvailable } from '../../../server/model-profiles';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    return json({ profiles: await listModelProfiles(user.id), available: await modelProfilesAvailable() });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    checkOrigin(request); const user = await requireUser(request);
    return json({ profile: await createModelProfile(user.id, await readJSON(request, 16 * 1024)) }, 201);
  } catch (error) { return failure(error); }
}
