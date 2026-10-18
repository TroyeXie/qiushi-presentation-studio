import fs from 'node:fs';
import path from 'node:path';
const dataDir = path.resolve(process.env.DATA_DIR || '/mnt/workspace/qiushi');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
if (process.getuid?.() === 0) {
  function assign(target) {
    const stat = fs.lstatSync(target); if (stat.isSymbolicLink()) return;
    fs.chownSync(target, 1000, 1000);
    if (stat.isDirectory()) for (const entry of fs.readdirSync(target)) assign(path.join(target, entry));
  }
  assign(dataDir);
  process.setgid(1000); process.setuid(1000);
}
fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
await import('../dist/server.mjs');
