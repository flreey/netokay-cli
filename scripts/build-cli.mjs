import { chmod, cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliRoot = path.join(root, 'apps/cli');
const outputDir = path.join(cliRoot, 'dist');
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await build({
  entryPoints: [path.join(cliRoot, 'src/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outfile: path.join(outputDir, 'netokay.js'),
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: false,
});
await chmod(path.join(outputDir, 'netokay.js'), 0o755);
await mkdir(path.join(cliRoot, 'schema'), { recursive: true });
await cp(
  path.join(root, 'packages/contracts/schemas/evidence-bundle.schema.json'),
  path.join(cliRoot, 'schema/evidence-bundle.schema.json'),
);
await cp(
  path.join(root, 'packages/contracts/schemas/control-api.schema.json'),
  path.join(cliRoot, 'schema/control-api.schema.json'),
);
