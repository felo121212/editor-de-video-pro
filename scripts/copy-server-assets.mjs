import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const assets = [
  ['src/server/db/schema.sql', 'dist/server/db/schema.sql']
];

for (const [source, destination] of assets) {
  const target = path.resolve(root, destination);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.resolve(root, source), target);
}
