import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const targets = ['dist','tmp','temp','.cache','.wrangler','coverage',path.join('data','server_cache')];
for (const relative of targets) {
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) continue;
  if (relative === path.join('data','server_cache')) {
    for (const entry of fs.readdirSync(target)) if (entry !== '.gitkeep') fs.rmSync(path.join(target, entry), {recursive:true,force:true});
  } else fs.rmSync(target,{recursive:true,force:true});
}
fs.mkdirSync(path.join(root,'data','server_cache'),{recursive:true});
fs.writeFileSync(path.join(root,'data','server_cache','.gitkeep'),'');
console.log('[HAAT] Temporary files and previous build artifacts cleaned.');
