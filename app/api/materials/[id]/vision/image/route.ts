import {json,requireUser} from '../../../../../../server/platform';
import {loadVisualPage,loadFigureRegion,visionFailure} from '../../../../../../server/vision';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:any){
  try{
    const user=await requireUser(request),{id}=await params,page=Number(new URL(request.url).searchParams.get('page'));
    if(!Number.isInteger(page)||page<1||page>300)return json({error:'图像页码无效。'},400);
    const regionId=new URL(request.url).searchParams.get('regionId');
    if(regionId!==null&&!/^fig[1-8]$/.test(regionId))return json({error:'Figure 区域标识无效。'},400);
    const visual=regionId===null?await loadVisualPage(user.id,id,page):await loadFigureRegion(user.id,id,page,regionId);
    if(!visual?.dataUrl)return json({error:'该页图像尚未成功读取。'},404);
    const match=/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(visual.dataUrl);
    if(!match)return json({error:'图像记录不可用，请重新读取。'},409);
    const bytes=Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0));
    return new Response(bytes,{headers:{'Content-Type':match[1],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }catch(error){return visionFailure(error);}
}
