/** Provider-specific request parameters apply only to the official endpoint,
 * never to a proxy or an unrelated personal provider with a similar model name. */
export function isOfficialDeepSeek(apiUrl: unknown): boolean {
  try { const url=new URL(String(apiUrl)); return url.origin==='https://api.deepseek.com' && !url.username && !url.password; }
  catch { return false; }
}
export function modelRequestOptions(apiUrl: string, structured = false) {
  if (!isOfficialDeepSeek(apiUrl)) return {};
  return {thinking:{type:'disabled'},...(structured ? {response_format:{type:'json_object'}} : {})};
}
export function modelImageOptions(apiUrl: string): {detail?:'original'} {
  return isOfficialDeepSeek(apiUrl) ? {detail:'original'} : {};
}
export function platformModelMetadata(apiUrl: unknown, model: unknown) {
  const name=typeof model==='string' ? model : '';
  let hostname='';try { hostname=new URL(String(apiUrl)).hostname; } catch {}
  const provider=isOfficialDeepSeek(apiUrl) ? 'deepseek' : hostname==='token.zju.edu.cn' ? 'qiushi-token' : 'custom';
  const prefix=provider==='deepseek' ? 'DeepSeek' : provider==='qiushi-token' ? '求是词元' : '平台模型';
  const imageInput=provider==='deepseek'
    ? /^deepseek-(?:flash|v4-flash(?:-vision-exp)?)$/.test(name) ? true : name==='deepseek-v4-pro' ? false : null : null;
  return {provider,label:prefix+(name ? ' · '+name : ''),imageInput};
}
