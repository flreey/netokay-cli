import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT = 30_000;
const MAX_BUFFER = 2 * 1024 * 1024;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SCHEMA = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const WORKER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PRODUCTION_WORKER_NAME = 'netokay-control';
const EXACT_FIELDS = [
  'manifest_version',
  'phase',
  'allowlist_version',
  'exporter_version',
  'private_source_commit',
  'public_source_commit',
  'worker_version',
  'npm_version',
  'production_control_url',
  'schema_hashes',
  'tarball_sha256',
  'version_matrix',
];
const MATRIX_FIELDS = ['cli', 'contracts', 'control_profile', 'core', 'schema'];

const fail = () => {
  process.stderr.write('PUBLIC_RELEASE_MANIFEST_INVALID\n');
  process.exitCode = 1;
};

const exactKeys = (value, expected) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...expected].sort().join(',');

const validUrl = (value) => {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      return false;
    const hostname = url.hostname.toLowerCase();
    if (isIP(hostname) || !hostname.includes('.') || hostname.endsWith('.')) return false;
    if (
      hostname === 'localhost' ||
      hostname === 'example.com' ||
      hostname === 'example.net' ||
      hostname === 'example.org' ||
      hostname.endsWith('.example.com') ||
      hostname.endsWith('.example.net') ||
      hostname.endsWith('.example.org') ||
      [
        '.localhost',
        '.local',
        '.internal',
        '.invalid',
        '.test',
        '.example',
        '.home.arpa',
        '.onion',
      ].some((suffix) => hostname.endsWith(suffix))
    )
      return false;
    const labels = hostname.split('.');
    if (
      labels
        .slice(0, -1)
        .some((label) =>
          /(?:^|-)(?:preview|staging|stage|dev|development|test|testing|qa|sandbox)(?:-|$)/i.test(
            label,
          ),
        )
    )
      return false;
    if (
      hostname.endsWith('.workers.dev') &&
      (labels.length !== 4 || labels[0] !== PRODUCTION_WORKER_NAME)
    )
      return false;
    return true;
  } catch {
    return false;
  }
};

const validSchemaHashes = (value) =>
  exactKeys(value, ['control', 'evidence']) &&
  Object.values(value).every((item) => typeof item === 'string' && SHA256.test(item));

const validMatrix = (value) =>
  exactKeys(value, MATRIX_FIELDS) &&
  SEMVER.test(value.cli) &&
  SEMVER.test(value.core) &&
  SEMVER.test(value.contracts) &&
  SCHEMA.test(value.schema) &&
  SEMVER.test(value.control_profile);

const sameObject = (left, right, keys) => keys.every((key) => left?.[key] === right?.[key]);

const validCommon = (manifest) =>
  exactKeys(manifest, EXACT_FIELDS) &&
  manifest.manifest_version === 1 &&
  manifest.allowlist_version === '1' &&
  SEMVER.test(manifest.exporter_version) &&
  SEMVER.test(manifest.npm_version) &&
  validSchemaHashes(manifest.schema_hashes) &&
  validMatrix(manifest.version_matrix) &&
  manifest.npm_version === manifest.version_matrix.cli;

const validPrepare = (manifest) =>
  validCommon(manifest) &&
  manifest.phase === 'prepare' &&
  (manifest.private_source_commit === null || COMMIT.test(manifest.private_source_commit)) &&
  manifest.public_source_commit === null &&
  manifest.worker_version === null &&
  manifest.production_control_url === null &&
  manifest.tarball_sha256 === null;

const validFinal = (manifest) =>
  validCommon(manifest) &&
  manifest.phase === 'final' &&
  COMMIT.test(manifest.private_source_commit) &&
  COMMIT.test(manifest.public_source_commit) &&
  WORKER.test(manifest.worker_version) &&
  validUrl(manifest.production_control_url) &&
  SHA256.test(manifest.tarball_sha256);

const readJson = async (relative) => JSON.parse(await readFile(path.join(ROOT, relative), 'utf8'));
const sha256File = async (relative) =>
  createHash('sha256')
    .update(await readFile(path.join(ROOT, relative)))
    .digest('hex');

const checkoutReleaseValues = async () => {
  const [cli, core, contracts] = await Promise.all([
    readJson('apps/cli/package.json'),
    readJson('packages/core/package.json'),
    readJson('packages/contracts/package.json'),
  ]);
  const version_matrix = {
    cli: cli.version,
    core: core.version,
    contracts: contracts.version,
    schema: '1.0',
    control_profile: '1.0.0',
  };
  const schema_hashes = {
    control: await sha256File('packages/contracts/schemas/control-api.schema.json'),
    evidence: await sha256File('packages/contracts/schemas/evidence-bundle.schema.json'),
  };
  const cliRun = await execFileAsync(process.execPath, ['apps/cli/dist/netokay.js', 'version'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '' },
    timeout: COMMAND_TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_BUFFER,
  });
  if (cliRun.stderr !== '') throw new Error('cli version stderr');
  const versionLines = cliRun.stdout.trim().split('\n').filter(Boolean);
  if (versionLines.length !== 1) throw new Error('cli version output');
  const cliRuntime = JSON.parse(versionLines[0]);
  if (
    cliRuntime.cli_version !== version_matrix.cli ||
    cliRuntime.evidence_schema_version !== version_matrix.schema ||
    cliRuntime.control_profile_version !== version_matrix.control_profile
  )
    throw new Error('cli version mismatch');
  return { npm_version: cli.version, version_matrix, schema_hashes };
};

const option = (args, name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const finalize = async (prepared, args) => {
  if (!validPrepare(prepared) || !COMMIT.test(prepared.private_source_commit ?? ''))
    throw new Error('prepare');
  const privateSourceCommit = option(args, '--private-source-commit');
  if (privateSourceCommit !== undefined && privateSourceCommit !== prepared.private_source_commit)
    throw new Error('private commit');
  const publicSourceCommit = option(args, '--public-source-commit');
  const workerVersion = option(args, '--worker-version');
  const productionControlUrl = option(args, '--production-control-url');
  const tarballSha256 = option(args, '--tarball-sha256');
  const tarball = option(args, '--tarball');
  const npmVersion = option(args, '--npm-version') ?? prepared.npm_version;
  const tag = option(args, '--tag') ?? process.env.GITHUB_REF_NAME;
  if (tag !== undefined && tag !== `v${prepared.npm_version}`) throw new Error('tag');
  if (!publicSourceCommit || !workerVersion || !productionControlUrl) throw new Error('runtime');
  if (tarball && tarballSha256) throw new Error('tarball');
  const computedTarballHash = tarball
    ? createHash('sha256')
        .update(await readFile(tarball))
        .digest('hex')
    : tarballSha256;
  if (!computedTarballHash) throw new Error('tarball');
  const checkout = await checkoutReleaseValues();
  if (
    checkout.npm_version !== prepared.npm_version ||
    !sameObject(checkout.version_matrix, prepared.version_matrix, MATRIX_FIELDS) ||
    !sameObject(checkout.schema_hashes, prepared.schema_hashes, ['control', 'evidence']) ||
    npmVersion !== checkout.npm_version
  )
    throw new Error('checkout mismatch');
  const manifest = {
    manifest_version: 1,
    phase: 'final',
    allowlist_version: prepared.allowlist_version,
    exporter_version: prepared.exporter_version,
    private_source_commit: prepared.private_source_commit,
    public_source_commit: publicSourceCommit,
    worker_version: workerVersion,
    npm_version: npmVersion,
    production_control_url: productionControlUrl,
    schema_hashes: checkout.schema_hashes,
    tarball_sha256: computedTarballHash,
    version_matrix: checkout.version_matrix,
  };
  if (!validFinal(manifest)) throw new Error('invalid');
  return manifest;
};

const verifyTarball = async (manifest, args) => {
  if (!validFinal(manifest)) throw new Error('manifest');
  const tarball = option(args, '--tarball');
  if (!tarball || !path.isAbsolute(tarball)) throw new Error('tarball');
  const actual = createHash('sha256')
    .update(await readFile(tarball))
    .digest('hex');
  if (actual !== manifest.tarball_sha256) throw new Error('tarball hash');
  return actual;
};

const [, , command, ...args] = process.argv;
const file = option(args, '--file') ?? 'release-manifest.json';
const outputFile = option(args, '--output') ?? file;
try {
  if (!file || !['validate', 'finalize', 'verify'].includes(command)) throw new Error('command');
  const input = await readJson(path.relative(ROOT, path.resolve(file)));
  const manifest = command === 'finalize' ? await finalize(input, args) : input;
  if (
    command === 'validate'
      ? !(validPrepare(manifest) || validFinal(manifest))
      : !validFinal(manifest)
  )
    throw new Error('invalid');
  if (command === 'verify') {
    const tarballSha256 = await verifyTarball(manifest, args);
    process.stdout.write(`${JSON.stringify({ ok: true, tarball_sha256: tarballSha256 })}\n`);
  } else if (command === 'finalize')
    await writeFile(outputFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  else process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
} catch {
  fail();
}
