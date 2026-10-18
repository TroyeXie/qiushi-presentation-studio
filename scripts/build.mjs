import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const routes = [];
async function scan(folder) {
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) await scan(full);
    else if (entry.name === 'route.ts') routes.push(full);
  }
}
await scan(path.join(root, 'app/api'));
const imports = routes.map((file, i) => `import * as r${i} from ${JSON.stringify(file)};`).join('\n');
const entries = routes.map((file, i) => {
  const route = '/' + path.relative(path.join(root, 'app'), path.dirname(file)).split(path.sep).join('/');
  const names = [...route.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]);
  const expression = '^' + route.replace(/\[[^\]]+\]/g, '([^/]+)') + '/?$';
  return `{pattern:new RegExp(${JSON.stringify(expression)}),names:${JSON.stringify(names)},handlers:r${i}}`;
}).join(',\n');
await build({
  absWorkingDir: root, entryPoints: ['runtime/server.ts'], outfile: 'dist/server.mjs',
  bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external',
  tsconfig: 'tsconfig.json', sourcemap: false,
  plugins: [{ name: 'runtime-assets', setup(api) {
    api.onResolve({ filter: /^virtual:routes$/ }, () => ({ path: 'routes', namespace: 'routes' }));
    api.onLoad({ filter: /.*/, namespace: 'routes' }, () => ({ contents: imports + '\nexport default [' + entries + '];', loader: 'ts', resolveDir: root }));
    api.onResolve({ filter: /\?(raw|inline)$/ }, args => ({
      path: path.resolve(args.importer ? path.dirname(args.importer) : root, args.path.replace(/^@\//, root + '/').replace(/\?(raw|inline)$/, '')),
      namespace: args.path.endsWith('?raw') ? 'raw' : 'inline'
    }));
    api.onLoad({ filter: /.*/, namespace: 'raw' }, async args => ({ contents: 'export default ' + JSON.stringify(await fs.readFile(args.path, 'utf8')), loader: 'js' }));
    api.onLoad({ filter: /.*/, namespace: 'inline' }, async args => ({ contents: 'export default ' + JSON.stringify('data:image/png;base64,' + (await fs.readFile(args.path)).toString('base64')), loader: 'js' }));
  }}]
});
console.log(`Built portable server with ${routes.length} API routes.`);
