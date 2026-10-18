import {env,json,requireUser,failure} from '../../../server/platform';
import {ensureSampleRelease,publicSampleCatalog} from '../../../server/sample-release';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 let installed=false;
 try{
  // Initialization accepts no client input; all catalog and asset reads remain authenticated.
  await ensureSampleRelease(env.BUCKET);installed=true;await requireUser(request);
  const obj=await env.BUCKET.get('samples/catalog.json');
  const response=json({samples:publicSampleCatalog(obj?await obj.json():[])});
  response.headers.set('X-Qiushi-Sample-Release','20261016-green-space-gallery-v2');return response;
 }catch(error){
  const response=failure(error);
  if(installed)response.headers.set('X-Qiushi-Sample-Release','20261016-green-space-gallery-v2');
  return response;
 }
}
