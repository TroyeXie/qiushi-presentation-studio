import { env, json } from './platform';
import { resolveInputChars } from './limits';

export type ModelProfile = { id: string; name: string; apiUrl: string; model: string; inputChars: number; hasKey: boolean };
export type ResolvedModelConfig = { apiUrl: string; apiKey: string; backupApiKey?: string; model: string; inputChars: number; maxOutputTokens: number; profileId: string; label: string };
const publicColumns = "id,name,api_url AS apiUrl,model,input_chars AS inputChars,CASE WHEN key_ciphertext<>'' THEN 1 ELSE 0 END AS hasKey";
const encoder = new TextEncoder();
const unavailable = () => json({ error: '个人模型配置暂不可用，请使用平台模型或联系管理员。' }, 503);
const missing = () => json({ error: '模型配置不存在，请重新选择。' }, 404);
const badEndpoint = () => json({ error: '请输入公网 HTTPS 模型接口地址，仅支持 443 端口，且不能包含凭据、查询参数或片段。' }, 400);

/** Validate without fetching: model calls must keep redirect:'manual'. */
export function normalizeModelEndpoint(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\s\\]/.test(value.trim())) throw badEndpoint();
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw badEndpoint(); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || /[?#]/.test(value)
    || /^https:\/\/[^/]*@/i.test(value.trim())) throw badEndpoint();
  const host = url.hostname.toLowerCase();
  // Literal IP addresses are intentionally unsupported, including URL-normalized
  // decimal/hex IPv4 and IPv4-mapped IPv6. Use a public provider hostname.
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.endsWith('.') || !host.includes('.')) throw badEndpoint();
  if (!host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw badEndpoint();
  if (/(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|test|invalid|onion|arpa)$/.test(host)
    || /(?:^|\.)(?:localdomain|home\.arpa|metadata\.google\.internal|metadata\.azure\.internal)$/.test(host)) throw badEndpoint();
  const path = url.pathname.replace(/\/+$/, '');
  // Reject encoded delimiters rather than interpreting provider-specific URLs
  // with ambiguous path semantics.
  if (/%(?:2f|5c|00|0a|0d)/i.test(path)) throw badEndpoint();
  url.pathname = /\/chat\/completions$/.test(path) ? path : (path || '/v1') + '/chat/completions';
  return url.href;
}

function profileId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value) || value === 'platform') throw json({ error: '模型配置标识无效。' }, 400);
  return value;
}
function field(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) throw json({ error: `${label}格式无效。` }, 400);
  return value.trim();
}
function apiKey(value: unknown): string {
  const result = field(value, 'API Key', 4096);
  if (/\s/.test(result)) throw json({ error: 'API Key 格式无效。' }, 400);
  return result;
}
function inputFields(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw json({ error: '模型配置格式无效。' }, 400);
  const body = value as Record<string, unknown>;
  if (body.inputChars !== undefined && body.inputChars !== null && body.inputChars !== ''
    && (typeof body.inputChars !== 'number' && typeof body.inputChars !== 'string' || !Number.isFinite(Number(body.inputChars)))) throw json({ error: '输入字符预算格式无效。' }, 400);
  return { name: field(body.name, '配置名称', 80), apiUrl: normalizeModelEndpoint(body.apiUrl), model: field(body.model, '模型名称', 160),
    inputChars: resolveInputChars(body.inputChars), key: body.apiKey === undefined || body.apiKey === '' ? null : apiKey(body.apiKey) };
}
function base64(bytes: Uint8Array): string { let binary = ''; for (const b of bytes) binary += String.fromCharCode(b); return btoa(binary); }
function unbase64(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
async function encryptionKey(): Promise<CryptoKey | null> {
  const raw = env.MODEL_CONFIG_ENCRYPTION_KEY;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) return null;
  try {
    const bytes = unbase64(raw);
    if (bytes.length !== 32 || base64(bytes) !== raw) return null;
    return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } catch { return null; }
}
export async function modelProfilesAvailable(): Promise<boolean> { return !!await encryptionKey(); }
async function requireEncryptionKey() { const key = await encryptionKey(); if (!key) throw unavailable(); return key; }
function aad(userId: string, id: string) { return encoder.encode(JSON.stringify(['model-profile-v1', userId, id])); }
async function encrypt(key: CryptoKey, userId: string, id: string, value: string): Promise<string> {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(userId, id), tagLength: 128 }, key, encoder.encode(value));
    return `v1.${base64(iv)}.${base64(new Uint8Array(encrypted))}`;
  } catch { throw unavailable(); }
}
async function decrypt(key: CryptoKey, userId: string, id: string, value: string): Promise<string> {
  try {
    const parts = value.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') throw new Error();
    const iv = unbase64(parts[1]), data = unbase64(parts[2]);
    if (iv.length !== 12 || data.length < 17 || data.length > 16_400) throw new Error();
    const result = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(userId, id), tagLength: 128 }, key, data);
    return apiKey(new TextDecoder('utf-8', { fatal: true }).decode(result));
  } catch { throw json({ error: '无法读取此配置的 API Key，请重新保存密钥后再试。' }, 503); }
}
function publicProfile(row: any): ModelProfile {
  return { id: row.id, name: row.name, apiUrl: row.apiUrl, model: row.model, inputChars: row.inputChars, hasKey: !!row.hasKey };
}
export async function listModelProfiles(userId: string): Promise<ModelProfile[]> {
  const rows = await env.DB.prepare(`SELECT ${publicColumns} FROM model_profiles WHERE user_id=? ORDER BY created_at DESC,id`).bind(userId).all();
  return rows.results.map(publicProfile);
}
export async function readModelProfile(userId: string, idValue: unknown): Promise<ModelProfile> {
  const id = profileId(idValue);
  const row = await env.DB.prepare(`SELECT ${publicColumns} FROM model_profiles WHERE id=? AND user_id=?`).bind(id, userId).first();
  if (!row) throw missing(); return publicProfile(row);
}
export async function createModelProfile(userId: string, value: unknown): Promise<ModelProfile> {
  const key = await requireEncryptionKey(), input = inputFields(value);
  if (!input.key) throw json({ error: '请填写此模型配置的 API Key。' }, 400);
  const id = crypto.randomUUID(), now = new Date().toISOString();
  const ciphertext = await encrypt(key, userId, id, input.key);
  await env.DB.prepare('INSERT INTO model_profiles (id,user_id,name,api_url,model,input_chars,key_ciphertext,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, userId, input.name, input.apiUrl, input.model, input.inputChars, ciphertext, now, now).run();
  return readModelProfile(userId, id);
}
export async function updateModelProfile(userId: string, idValue: unknown, value: unknown): Promise<ModelProfile> {
  const id = profileId(idValue);
  const current = await readModelProfile(userId, id);
  const key = await requireEncryptionKey(), input = inputFields(value);
  if (input.apiUrl !== current.apiUrl && !input.key) throw json({ error: '更换接口地址时请重新填写 API Key。' }, 400);
  const ciphertext = input.key ? await encrypt(key, userId, id, input.key) : null;
  // A concurrent endpoint edit must not silently reuse a key for a different host.
  const changed = await env.DB.prepare('UPDATE model_profiles SET name=?,api_url=?,model=?,input_chars=?,key_ciphertext=COALESCE(?,key_ciphertext),updated_at=? WHERE id=? AND user_id=? AND api_url=?')
    .bind(input.name, input.apiUrl, input.model, input.inputChars, ciphertext, new Date().toISOString(), id, userId, current.apiUrl).run();
  if (!changed.meta?.changes) throw json({ error: '模型配置已变更或删除，请刷新后重试。' }, 409);
  return readModelProfile(userId, id);
}
export async function deleteModelProfile(userId: string, idValue: unknown): Promise<void> {
  const id = profileId(idValue);
  const result = await env.DB.prepare('DELETE FROM model_profiles WHERE id=? AND user_id=?').bind(id, userId).run();
  if (!result.meta?.changes) throw missing();
}
function maxOutputTokens(): number {
  const value = Number(env.MODEL_MAX_OUTPUT_TOKENS);
  return Number.isFinite(value) && value >= 2048 ? Math.min(24_000, Math.floor(value)) : 18_000;
}
export async function resolveModelConfig(userId: string, idValue?: unknown): Promise<ResolvedModelConfig> {
  if (idValue === undefined || idValue === null || idValue === '' || idValue === 'platform') {
    if (!env.MODEL_API_URL || !env.MODEL_API_KEY || !env.MODEL_NAME) throw json({ error: '平台模型尚未配置，请选择个人模型配置或联系管理员。' }, 503);
    return { apiUrl: env.MODEL_API_URL, apiKey: env.MODEL_API_KEY, model: env.MODEL_NAME,
      ...(env.MODEL_BACKUP_ENABLED !== 'false' && typeof env.MODEL_BACKUP_API_KEY === 'string' && env.MODEL_BACKUP_API_KEY.trim() ? {backupApiKey:env.MODEL_BACKUP_API_KEY.trim()} : {}),
      inputChars: resolveInputChars(env.MODEL_MAX_INPUT_CHARS), maxOutputTokens: maxOutputTokens(), profileId: 'platform', label: '平台模型' };
  }
  const id = profileId(idValue);
  const row = await env.DB.prepare('SELECT api_url,model,input_chars,key_ciphertext,name FROM model_profiles WHERE id=? AND user_id=?').bind(id, userId).first();
  if (!row) throw missing();
  const key = await requireEncryptionKey();
  return { apiUrl: normalizeModelEndpoint(row.api_url), apiKey: await decrypt(key, userId, id, row.key_ciphertext), model: row.model,
    inputChars: resolveInputChars(row.input_chars), maxOutputTokens: maxOutputTokens(), profileId: id, label: row.name };
}
