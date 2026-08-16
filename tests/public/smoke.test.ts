import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('public release mirror', () => {
  it('contains source-build inputs and the canonical schemas', async () => {
    await expect(access(path.resolve('apps/cli/src/index.ts'))).resolves.toBeUndefined();
    await expect(access(path.resolve('packages/core/src/index.ts'))).resolves.toBeUndefined();
    await expect(access(path.resolve('packages/contracts/src/index.ts'))).resolves.toBeUndefined();
    const evidence = await readFile(
      'packages/contracts/schemas/evidence-bundle.schema.json',
      'utf8',
    );
    const distribution = await readFile('apps/cli/schema/evidence-bundle.schema.json', 'utf8');
    expect(distribution).toBe(evidence);

    const cliPackage = JSON.parse(await readFile('apps/cli/package.json', 'utf8'));
    expect(cliPackage).toMatchObject({
      name: 'netokay',
      private: false,
      license: 'Apache-2.0',
      bin: { netokay: 'dist/netokay.js' },
      repository: { type: 'git', url: 'https://github.com/flreey/netokay-cli.git' },
      publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' },
    });
  });
});
