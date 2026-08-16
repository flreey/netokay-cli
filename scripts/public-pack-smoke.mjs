import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timeout = 120_000;
const maxBuffer = 8 * 1024 * 1024;

const run = async (command, args, cwd, options = {}) =>
  execFile(command, args, {
    cwd,
    timeout: options.timeout ?? timeout,
    killSignal: 'SIGKILL',
    maxBuffer: options.maxBuffer ?? maxBuffer,
    env: { ...process.env, npm_config_loglevel: 'error', npm_config_update_notifier: 'false' },
  });

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const jsonLine = (value, label) => {
  if (value.stderr !== '') throw new Error(`${label} wrote stderr`);
  const lines = value.stdout.trim().split('\n').filter(Boolean);
  if (lines.length !== 1) throw new Error(`${label} must emit one JSON line`);
  return JSON.parse(lines[0]);
};

const main = async () => {
  const tarball = arg('--tarball');
  if (!tarball || !path.isAbsolute(tarball)) throw new Error('tarball must be absolute');
  const packageJson = JSON.parse(await readFile(path.join(root, 'apps/cli/package.json'), 'utf8'));
  const expectedEntries = [
    'package/README.md',
    'package/dist/netokay.js',
    'package/package.json',
    'package/schema/control-api.schema.json',
    'package/schema/evidence-bundle.schema.json',
  ];
  const listing = (await run('tar', ['-tzf', tarball], root)).stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();
  if (listing.join('\n') !== expectedEntries.join('\n')) throw new Error('tarball tree mismatch');

  const temp = await mkdtemp(path.join(tmpdir(), 'netokay-public-pack-smoke-'));
  try {
    await run('npm', ['init', '-y', '--silent'], temp);
    await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], temp);
    const installed = path.join(temp, 'node_modules', packageJson.name);
    const bin = path.join(temp, 'node_modules', '.bin', 'netokay');
    if (((await stat(bin)).mode & 0o777) !== 0o755)
      throw new Error('installed bin is not executable');
    const installedPackage = JSON.parse(
      await readFile(path.join(installed, 'package.json'), 'utf8'),
    );
    if (
      installedPackage.name !== 'netokay' ||
      installedPackage.version !== packageJson.version ||
      installedPackage.private !== false ||
      installedPackage.type !== 'module' ||
      installedPackage.license !== 'Apache-2.0' ||
      installedPackage.bin?.netokay !== 'dist/netokay.js' ||
      installedPackage.repository?.url !== 'https://github.com/flreey/netokay-cli.git' ||
      installedPackage.publishConfig?.access !== 'public' ||
      installedPackage.publishConfig?.registry !== 'https://registry.npmjs.org'
    ) {
      throw new Error('installed package metadata mismatch');
    }
    const evidence = await readFile(path.join(installed, 'schema/evidence-bundle.schema.json'));
    const control = await readFile(path.join(installed, 'schema/control-api.schema.json'));
    for (const [relative, expected] of [
      ['packages/contracts/schemas/evidence-bundle.schema.json', evidence],
      ['packages/contracts/schemas/control-api.schema.json', control],
    ]) {
      const canonical = await readFile(path.join(root, relative));
      if (!canonical.equals(expected)) throw new Error(`schema bytes mismatch: ${relative}`);
    }
    const version = await run(bin, ['version'], temp);
    const versionJson = jsonLine(version, 'version');
    if (versionJson.cli_version !== packageJson.version) throw new Error('version mismatch');
    const entry = path.join(installed, installedPackage.bin.netokay ?? installedPackage.bin);
    const direct = await run(process.execPath, [entry, 'version'], temp);
    if (direct.stdout !== version.stdout || direct.stderr !== version.stderr)
      throw new Error('ESM entry mismatch');
    const schema = jsonLine(await run(bin, ['schema'], temp), 'schema');
    if (!schema.schema_path?.endsWith('evidence-bundle.schema.json'))
      throw new Error('schema output mismatch');
    const diagnosis = await run(bin, ['diagnose'], temp).catch((error) => error);
    if (diagnosis.code !== 2 || diagnosis.stderr !== '')
      throw new Error('diagnose exit/output mismatch');
    const evidenceBundle = JSON.parse((diagnosis.stdout ?? '').trim());
    const contracts = await import(
      pathToFileURL(path.join(root, 'packages/contracts/dist/index.js')).href
    );
    if (!contracts.validateEvidenceBundle(evidenceBundle))
      throw new Error('canonical validator rejected diagnose');
    const tarballHash = createHash('sha256')
      .update(await readFile(tarball))
      .digest('hex');
    process.stdout.write(`${JSON.stringify({ ok: true, tarball_sha256: tarballHash })}\n`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
};

main().catch(() => {
  process.stderr.write('PUBLIC_RELEASE_PACK_SMOKE_FAILED\n');
  process.exitCode = 1;
});
