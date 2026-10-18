/** Server-only provider transport. Credentials and upstream error bodies never
 * enter public responses, storage, progress events, or logs. */
export type ModelCredentials = { apiKey: string; backupApiKey?: string; profileId?: string };
export const MAX_MODEL_ERROR_BYTES = 16 * 1024;

function quotaText(value: string): boolean {
  return /(?:insufficient[_\s-]+(?:quota|balance|credits?|funds)|quota[_\s-]+(?:exceeded|exhausted|depleted)|quota\s+(?:is\s+)?not\s+enough|quota\s+(?:has\s+been\s+|is\s+)?exhausted|(?:balance|credits?)[_\s-]+(?:insufficient|exhausted|depleted)|user[_\s-]+quota|billing[_\s-]+hard[_\s-]+limit[_\s-]+reached|(?:exceeded|exhausted)[_\s-]+(?:your[_\s-]+)?(?:current[_\s-]+)?quota|(?:额度|配额|余额)\s*(?:不足|耗尽|已耗尽|已用尽|用尽|用完)|(?:超出|超过|达到).{0,10}(?:额度|配额))/i.test(value);
}
function structuredQuota(value: unknown): boolean {
  const pending: Array<{value:unknown;depth:number}> = [{value,depth:0}]; let visited = 0;
  let explicitQuotaCode = false, otherErrorCode = false, quotaMessage = false;
  while (pending.length && visited++ < 128) {
    const item = pending.pop()!;
    if (!item.value || typeof item.value !== 'object' || item.depth > 6) continue;
    for (const [key,field] of Object.entries(item.value)) {
      if (typeof field === 'string' && /^(?:code|type|message|error|error_description|detail|reason)$/i.test(key)) {
        if (/^(?:code|type)$/i.test(key) && quotaText(field)) explicitQuotaCode = true;
        else if (/^(?:code|type)$/i.test(key) && /^(?:rate_limit_exceeded|rate_limit_error|too_many_requests|concurrency_limit_exceeded|invalid_api_key|authentication_error|context_length_exceeded)$/i.test(field)) otherErrorCode = true;
        else if (quotaText(field)) quotaMessage = true;
      }
      if (field && typeof field === 'object') pending.push({value:field,depth:item.depth+1});
    }
  }
  // A generic rate-limit code is decisive even if its explanation mentions a
  // per-minute quota. Explicit account-quota codes remain authoritative.
  return explicitQuotaCode || !otherErrorCode && quotaMessage;
}

/** Only explicit payment/quota failures qualify. Busy responses, bad keys,
 * unsupported requests, network failures, and server errors do not switch keys. */
export async function isQuotaResponse(response: Response, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (response.status === 402) { await response.body?.cancel(); signal?.throwIfAborted(); return true; }
  if (![400,403,429].includes(response.status)) { await response.body?.cancel(); signal?.throwIfAborted(); return false; }
  const announced = Number(response.headers.get('content-length') || 0);
  if (announced > MAX_MODEL_ERROR_BYTES) { await response.body?.cancel(); signal?.throwIfAborted(); return false; }
  const reader = response.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = []; let length = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort',cancel,{once:true});
  try {
    for (;;) {
      signal?.throwIfAborted();
      const part = await reader.read();
      signal?.throwIfAborted();
      if (part.done) break;
      length += part.value.length;
      if (length > MAX_MODEL_ERROR_BYTES) { await reader.cancel(); return false; }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length); let position = 0;
    for (const part of chunks) { bytes.set(part,position); position += part.length; }
    const body = new TextDecoder().decode(bytes);
    try { return structuredQuota(JSON.parse(body)); }
    catch { return quotaText(body); }
  } finally { signal?.removeEventListener('abort',cancel); reader.releaseLock(); }
}

export type ModelResponse = { response: Response; usedBackup: boolean; quotaExhausted: boolean };

/** The caller owns one deadline and AbortSignal for both attempts and response
 * parsing. There is at most one retry, and only the platform profile can use it. */
export async function requestModel(apiUrl: string, body: string, credentials: ModelCredentials,
  fetcher: typeof fetch = fetch, signal?: AbortSignal, onFallback?: () => void): Promise<ModelResponse> {
  const attempt = async (key: string) => {
    signal?.throwIfAborted();
    const response = await fetcher(apiUrl,{method:'POST',redirect:'manual',signal,
      headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body});
    signal?.throwIfAborted();
    if (response.ok) return {response,quotaExhausted:false};
    const quotaExhausted = await isQuotaResponse(response,signal);
    // Preserve only the HTTP status, never return provider plaintext error data.
    return {response:new Response(null,{status:response.status}),quotaExhausted};
  };
  const primary = await attempt(credentials.apiKey);
  const backup = credentials.profileId === 'platform' && typeof credentials.backupApiKey === 'string'
    ? credentials.backupApiKey.trim() : '';
  if (primary.response.ok || !primary.quotaExhausted || !backup || backup === credentials.apiKey)
    return {...primary,usedBackup:false};
  signal?.throwIfAborted();
  try { onFallback?.(); } catch { /* Progress reporting cannot change credential selection. */ }
  signal?.throwIfAborted();
  return {...await attempt(backup),usedBackup:true};
}
