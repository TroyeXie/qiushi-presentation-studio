import {env,json,requireUser} from '../../../server/platform';
import {UPLOAD_LIMITS} from '../../../server/uploads';
import {resolveInputChars} from '../../../server/limits';
import {platformModelMetadata} from '../../../server/model-provider';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  let user=null;try{user=await requireUser(request);}catch{}
  return json({user,model:{configured:!!(env.MODEL_API_KEY&&env.MODEL_API_URL&&env.MODEL_NAME),name:env.MODEL_NAME||'',...platformModelMetadata(env.MODEL_API_URL,env.MODEL_NAME),backupConfigured:!!(env.MODEL_BACKUP_ENABLED!=='false'&&env.MODEL_BACKUP_API_KEY&&env.MODEL_API_KEY&&env.MODEL_API_URL&&env.MODEL_NAME)},ocr:{configured:!!(env.OCR_API_KEY&&env.OCR_INPUT_MODE==='base64')},limits:{...UPLOAD_LIMITS,maxFiles:null,inputChars:resolveInputChars(env.MODEL_MAX_INPUT_CHARS)}});
}
