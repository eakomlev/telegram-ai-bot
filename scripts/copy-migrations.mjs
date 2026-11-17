import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src', 'core', 'migrations');
const destDir = path.join(root, 'dist', 'core', 'migrations');

fs.rmSync(destDir, { recursive: true, force: true });
fs.mkdirSync(destDir, { recursive: true });
for (const name of fs.readdirSync(srcDir)) {
  if (!name.endsWith('.sql')) continue;
  fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name));
}
