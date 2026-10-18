import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const dataDir = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
export function durableSecret(name: string, bytes = 32) {
  const target = path.join(dataDir, name);
  try { return fs.readFileSync(target, 'utf8').trim(); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const value = randomBytes(bytes).toString('base64');
  fs.writeFileSync(target, value, { mode: 0o600, flag: 'wx' });
  return value;
}

const sqlite = new DatabaseSync(path.join(dataDir, 'workspace.sqlite'));
sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
sqlite.exec('CREATE TABLE IF NOT EXISTS runtime_migrations(name TEXT PRIMARY KEY NOT NULL)');
for (const name of fs.readdirSync('drizzle').filter(file => file.endsWith('.sql')).sort()) {
  if (!sqlite.prepare('SELECT name FROM runtime_migrations WHERE name=?').get(name)) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { sqlite.exec(fs.readFileSync(path.join('drizzle', name), 'utf8')); sqlite.prepare('INSERT INTO runtime_migrations(name) VALUES (?)').run(name); sqlite.exec('COMMIT'); }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }
}
class Statement {
  values: any[] = [];
  constructor(public sql: string) {}
  bind(...values: any[]) { const statement = new Statement(this.sql); statement.values = values; return statement; }
  async first(column?: string) { const row: any = sqlite.prepare(this.sql).get(...this.values) || null; return column ? row?.[column] ?? null : row; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.values), success: true }; }
  execute() { const result = sqlite.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
  async run() { return this.execute(); }
}
export const DB = {
  prepare(sql: string) { return new Statement(sql); },
  async batch(statements: Statement[]) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }
};

const bucketDir = path.join(dataDir, 'objects');
fs.mkdirSync(bucketDir, { recursive: true, mode: 0o700 });
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function objectPaths(key: string) { const digest = hash(key); return { body: path.join(bucketDir, digest + '.bin'), meta: path.join(bucketDir, digest + '.json') }; }
function metadata(key: string): any {
  try { return JSON.parse(fs.readFileSync(objectPaths(key).meta, 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}
export const BUCKET = {
  async get(key: string, options: any = {}) {
    const meta = metadata(key); if (!meta) return null;
    let bytes = fs.readFileSync(objectPaths(key).body);
    if (options.range) { const { offset = 0, length = bytes.length - offset } = options.range; bytes = bytes.subarray(offset, offset + length); }
    const data = new Uint8Array(bytes);
    return { ...meta, body: new Response(data).body!,
      async arrayBuffer() { return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength); },
      async text() { return new TextDecoder().decode(data); },
      async json() { return JSON.parse(new TextDecoder().decode(data)); } };
  },
  async head(key: string) { return metadata(key); },
  async put(key: string, value: string | Uint8Array | ArrayBuffer, options: any = {}) {
    const previous = metadata(key), condition = options.onlyIf;
    const matches = condition instanceof Headers ? condition.get('If-Match')?.replace(/^"|"$/g, '') : condition?.etagMatches;
    const excluded = condition instanceof Headers ? condition.get('If-None-Match')?.replace(/^"|"$/g, '') : condition?.etagDoesNotMatch;
    if (matches && (matches === '*' ? !previous : previous?.etag !== matches) || excluded && (excluded === '*' ? !!previous : previous?.etag === excluded)) return null;
    const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const meta = { key, size: bytes.length, etag: hash(bytes), httpMetadata: options.httpMetadata || {}, uploaded: new Date().toISOString() };
    const files = objectPaths(key), suffix = '.' + randomBytes(8).toString('hex') + '.tmp';
    fs.writeFileSync(files.body + suffix, bytes, { mode: 0o600 }); fs.renameSync(files.body + suffix, files.body);
    fs.writeFileSync(files.meta + suffix, JSON.stringify(meta), { mode: 0o600 }); fs.renameSync(files.meta + suffix, files.meta);
    return meta;
  },
  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) for (const file of Object.values(objectPaths(key))) fs.rmSync(file, { force: true });
  },
  async list(options: any = {}) {
    const all = fs.readdirSync(bucketDir).filter(file => file.endsWith('.json')).map(file => JSON.parse(fs.readFileSync(path.join(bucketDir, file), 'utf8'))).filter(meta => meta.key.startsWith(options.prefix || '')).sort((a, b) => a.key.localeCompare(b.key));
    const offset = Number(options.cursor || 0), limit = Math.min(1000, Math.max(1, options.limit || 1000));
    const objects = all.slice(offset, offset + limit), truncated = offset + limit < all.length;
    return { objects, truncated, ...(truncated ? { cursor: String(offset + limit) } : {}) };
  }
};
