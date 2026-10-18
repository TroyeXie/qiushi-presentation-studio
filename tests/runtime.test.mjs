import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import '../public/core.js';

test('portable runtime preserves private workspaces, encrypted profiles, file processing and academic previews', async t => {
  const root = path.resolve(import.meta.dirname, '..');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'qiushi-runtime-'));
  const port = 18000 + Math.floor(Math.random() * 15000), origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist/server.mjs'], { cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: data, MODEL_API_KEY: '', MODEL_BACKUP_API_KEY: '', PUBLIC_URL: '', SESSION_COOKIE_MODE: '', SESSION_SECRET: '', MODEL_CONFIG_ENCRYPTION_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', bytes => { logs += bytes; }); child.stderr.on('data', bytes => { logs += bytes; });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); } await fs.rm(data, { recursive: true, force: true }); });
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(origin + '/healthz')).ok) break; } catch {}
    if (attempt >= 100 || child.exitCode !== null) throw new Error('Runtime did not start: ' + logs);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const session = async () => { const response = await fetch(origin + '/api/session'); assert.equal(response.status, 200); const attributes = response.headers.get('set-cookie'); assert.match(attributes, /; HttpOnly;/); assert.match(attributes, /; SameSite=Lax/); assert.doesNotMatch(attributes, /Partitioned|SameSite=None/); return { cookie: attributes.split(';')[0], body: await response.json() }; };
  const one = await session(), two = await session(); assert.notEqual(one.body.user.id, two.body.user.id);
  assert.equal(one.body.model.configured, false); assert.equal(one.body.user.name, '我的工作区');
  const call = (url, cookie = one.cookie, method = 'GET', body, headers = {}) => fetch(origin + url, { method, headers: { cookie, ...(method !== 'GET' ? { Origin: origin } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) } : {}) });

  assert.equal((await fetch(origin + '/api/projects', { headers: { 'oai-authenticated-user-id': one.body.user.id, 'oai-authenticated-user-email': 'forged@example.org' } })).status, 401);
  assert.equal((await call('/api/projects', one.cookie.slice(0, -1) + (one.cookie.endsWith('A') ? 'B' : 'A'))).status, 401);
  assert.equal((await call('/api/materials', one.cookie, 'POST', { name: 'x.txt', size: 10 }, { Origin: 'https://untrusted.example.org' })).status, 403);
  for (const page of ['/workbench', '/projects', '/guide', '/samples']) { const response = await fetch(origin + page); assert.equal(response.status, 200); assert.match(await response.text(), /core\.js/); }
  for (const file of ['/core.js', '/pptx.js', '/styles.css', '/vendor/pdfjs.mjs', '/fonts/STKaiti.woff2']) assert.equal((await fetch(origin + file)).status, 200);
  for (const target of ['/server/sample-release-data.json', '/.env', '/data/workspace.sqlite']) assert.equal((await fetch(origin + target)).status, 404);

  const profileResponse = await call('/api/model-profiles', one.cookie, 'POST', { name: 'Synthetic model', apiUrl: 'https://api.example.org/v1', model: 'synthetic', apiKey: 'synthetic-test-key', inputChars: 80000 });
  assert.equal(profileResponse.status, 201); const profile = (await profileResponse.json()).profile;
  const profileList = await (await call('/api/model-profiles')).json(); assert.equal(profileList.profiles.length, 1); assert.equal(JSON.stringify(profileList).includes('synthetic-test-key'), false);
  assert.equal((await call('/api/model-profiles/' + profile.id, two.cookie)).status, 404);
  const database = new DatabaseSync(path.join(data, 'workspace.sqlite'));
  const stored = database.prepare('SELECT key_ciphertext FROM model_profiles WHERE id=?').get(profile.id); assert.match(stored.key_ciphertext, /^v1\./); assert.equal(stored.key_ciphertext.includes('synthetic-test-key'), false); database.close();

  async function upload(name, bytes) {
    const started = await call('/api/materials', one.cookie, 'POST', { name, size: bytes.length }); assert.equal(started.status, 200);
    const id = (await started.json()).material.id;
    assert.equal((await call('/api/materials/' + id + '/parts/0', one.cookie, 'PUT', bytes)).status, 200);
    const changed = bytes.slice(); changed[changed.length - 1] ^= 1;
    assert.equal((await call('/api/materials/' + id + '/parts/0', one.cookie, 'PUT', changed)).status, 200);
    const objectName = createHash('sha256').update(`materials/${one.body.user.id}/${id}/parts/0`).digest('hex') + '.bin';
    assert.deepEqual(new Uint8Array(await fs.readFile(path.join(data, 'objects', objectName))), bytes);
    const completed = await call('/api/materials/' + id + '/complete', one.cookie, 'POST', {}); assert.equal(completed.status, 200, await completed.clone().text());
    assert.equal((await completed.json()).material.status, 'ready');
    return id;
  }
  const materialId = await upload('synthetic.txt', new TextEncoder().encode('Synthetic evidence for an academic presentation. No private data.'));
  assert.equal((await (await call('/api/materials', two.cookie)).json()).materials.length, 0);
  assert.equal((await call('/api/materials/' + materialId, two.cookie, 'DELETE')).status, 404);
  const noKey = await call('/api/generate', one.cookie, 'POST', { materialIds: [materialId], scene: 'lab', title: 'Synthetic', instructions: '' }); assert.equal(noKey.status, 503);

  const project = globalThis.CampusPPT.normalizeProject({ version: 1, title: 'Synthetic verification', scene: 'lab', slides: [{ id: 'slide-one', type: 'bullets', section: 'Verification', title: 'Synthetic verification', body: ['Only synthetic data'], citations: [], notes: 'Synthetic speaker notes.', evidence: 'teaching' }] });
  const saved = await call('/api/projects', one.cookie, 'POST', { project }); assert.equal(saved.status, 200); const projectId = (await saved.json()).id;
  assert.equal((await call('/api/projects/' + projectId, two.cookie)).status, 404);
  assert.equal((await (await call('/api/projects/' + projectId)).json()).project.title, project.title);
  const exported = await call('/api/export', one.cookie, 'POST', { project }); assert.equal(exported.status, 200, await exported.clone().text());
  const pptx = new Uint8Array(await exported.arrayBuffer()); assert.equal(pptx[0], 80); assert.equal(pptx[1], 75);
  await upload('synthetic.pptx', pptx);
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const contents = 'BT /F1 12 Tf 30 100 Td (Synthetic evidence for PDF extraction.) Tj ET';
  objects.push('<< /Length ' + contents.length + ' >>\nstream\n' + contents + '\nendstream');
  let pdf = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += (index + 1) + ' 0 obj\n' + object + '\nendobj\n'; });
  const xref = pdf.length; pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  await upload('synthetic.pdf', new TextEncoder().encode(pdf));

  const catalog = await (await call('/api/samples')).json(); assert.deepEqual(catalog.samples.map(sample => sample.id).sort(), ['course', 'green-space', 'journal']);
  for (const id of ['clinical', 'practice', 'svep1']) assert.equal((await call('/api/samples/' + id + '/preview')).status, 404);
  const release = JSON.parse(await fs.readFile(path.join(root, 'server/sample-release-data.json'), 'utf8'));
  for (const sample of release.samples) {
    const preview = await call('/api/samples/' + sample.id + '/preview'); assert.equal(preview.status, 200); assert.equal(preview.headers.get('x-qiushi-read-only'), '1');
    const bytes = new Uint8Array(await preview.arrayBuffer()); assert.equal(bytes.length, sample.previewManifest.size); assert.equal(createHash('sha256').update(bytes).digest('hex'), sample.previewManifest.sha256);
    assert.equal((await call('/api/samples/' + sample.id + '/thumbnail')).status, 200);
  }
  const health = await fetch(origin + '/healthz'); assert.equal(health.status, 200);
});

test('HTTPS embedded mode sets a signed partitioned cookie and keeps exact-origin write protection', async t => {
  const root = path.resolve(import.meta.dirname, '..');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'qiushi-embedded-'));
  const port = 33000 + Math.floor(Math.random() * 10000), origin = `http://127.0.0.1:${port}`;
  const publicOrigin = 'https://presentation.example.org';
  const child = spawn(process.execPath, ['dist/server.mjs'], { cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: data, PUBLIC_URL: publicOrigin, SESSION_COOKIE_MODE: 'embedded', SESSION_SECRET: '', MODEL_CONFIG_ENCRYPTION_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', bytes => { logs += bytes; }); child.stderr.on('data', bytes => { logs += bytes; });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); } await fs.rm(data, { recursive: true, force: true }); });
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(origin + '/healthz')).ok) break; } catch {}
    if (attempt >= 100 || child.exitCode !== null) throw new Error('Embedded runtime did not start: ' + logs);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const response = await fetch(origin + '/api/session'); assert.equal(response.status, 200);
  const attributes = response.headers.get('set-cookie'), cookie = attributes.split(';')[0];
  for (const value of ['HttpOnly', 'SameSite=None', 'Secure', 'Partitioned']) assert.match(attributes, new RegExp('; ' + value + '(?:;|$)'));
  assert.doesNotMatch(attributes, /SameSite=Lax|Domain=/);
  const first = (await response.json()).user;
  const repeated = await fetch(origin + '/api/session', { headers: { Cookie: cookie } });
  assert.equal((await repeated.json()).user.id, first.id); assert.equal(repeated.headers.get('set-cookie'), null);
  const input = { name: 'embedded.txt', size: 12 };
  const allowed = await fetch(origin + '/api/materials', { method: 'POST', headers: { Cookie: cookie, Origin: publicOrigin }, body: JSON.stringify(input) });
  assert.equal(allowed.status, 200);
  const denied = await fetch(origin + '/api/materials', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://embedding-site.example.org' }, body: JSON.stringify(input) });
  assert.equal(denied.status, 403);
  const tampered = cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A');
  assert.equal((await fetch(origin + '/api/projects', { headers: { Cookie: tampered } })).status, 401);
});
