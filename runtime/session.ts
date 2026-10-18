import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { durableSecret } from './storage';
const secret = process.env.SESSION_SECRET || durableSecret('session-secret');
if (secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
const users = new WeakMap<Request, { id: string; name: string; email: string }>();
const cookieName = 'qiushi_workspace';
function signature(value: string) { return createHmac('sha256', secret).update(value).digest('base64url'); }
export function sessionUser(request: Request) { return users.get(request); }
export function attachSession(request: Request, create = false) {
  const cookie = request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '';
  const match = /^([a-f0-9-]{36})\.(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(cookie);
  let id: string | undefined;
  if (match) {
    const expected = signature(match[1] + '.' + match[2]);
    if (Number(match[2]) > Date.now() / 1000 && timingSafeEqual(Buffer.from(expected), Buffer.from(match[3]))) id = match[1];
  }
  let setCookie: string | undefined;
  if (!id && create) {
    id = randomUUID(); const value = id + '.' + Math.floor(Date.now() / 1000 + 365 * 86400);
    setCookie = cookieName + '=' + value + '.' + signature(value) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000' + (new URL(request.url).protocol === 'https:' ? '; Secure' : '');
  }
  if (id) users.set(request, { id, name: '我的工作区', email: '' });
  return setCookie;
}
