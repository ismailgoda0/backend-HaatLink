import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const conflictMarkers = ['<' + '<<<<<<', '=' + '======', '>' + '>>>>>>'];
const hasConflictMarkers = (content) => conflictMarkers.some((marker) => content.split('\n').some((line) => line.startsWith(marker)));
const required = ['package.json','package-lock.json','tsconfig.json','wrangler.jsonc','src/cloudflare/worker.ts'];

for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) {
    console.error(`[HAAT] Architecture check failed: missing ${file}`);
    process.exit(1);
  }
}

for (const file of ['package.json','package-lock.json','tsconfig.json','wrangler.jsonc','README.md']) {
  if (!fs.existsSync(path.join(root, file))) continue;
  const content = fs.readFileSync(path.join(root, file), 'utf8');
  if (hasConflictMarkers(content)) {
    console.error(`[HAAT] Architecture check failed: merge-conflict markers found in ${file}`);
    process.exit(1);
  }
}

const worker = fs.readFileSync(path.join(root, 'src', 'cloudflare', 'worker.ts'), 'utf8');
if (worker.includes('@cloudflare/containers') || worker.includes('Container')) {
  console.error('[HAAT] Architecture check failed: Free Worker must not depend on Cloudflare Containers.');
  process.exit(1);
}

const wrangler = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');
if (wrangler.includes('"containers"') || wrangler.includes('"durable_objects"')) {
  console.error('[HAAT] Architecture check failed: Containers/Durable Objects bindings are not allowed in the Free Worker deployment.');
  process.exit(1);
}

for (const generated of ['dist', 'build', 'node_modules']) {
  if (fs.existsSync(path.join(root, generated))) {
    console.error(`[HAAT] Architecture check failed: ${generated}/ must not be committed or supplied as source.`);
    process.exit(1);
  }
}

if (fs.existsSync(path.join(root, '.env'))) {
  console.error('[HAAT] Architecture check failed: .env must never be shipped.');
  process.exit(1);
}

console.log('[HAAT] Free Worker architecture check: OK');
