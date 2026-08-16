import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'packages/contracts/schemas');
const destination = path.join(root, 'packages/contracts/dist/schemas');
await mkdir(destination, { recursive: true });
await mkdir(path.join(root, 'packages/contracts/dist/generated'), { recursive: true });
await cp(source, destination, { recursive: true });
await cp(
  path.join(root, 'packages/contracts/src/generated/evidence-bundle-validator.mjs'),
  path.join(root, 'packages/contracts/dist/generated/evidence-bundle-validator.mjs'),
);
await cp(
  path.join(root, 'packages/contracts/src/generated/control-api-validator.mjs'),
  path.join(root, 'packages/contracts/dist/generated/control-api-validator.mjs'),
);
