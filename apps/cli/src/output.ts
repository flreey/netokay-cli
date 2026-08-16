import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, unlink, link, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { validateEvidenceBundle, type EvidenceBundle } from '@netokay/contracts';

export class OutputError extends Error {
  readonly code: string;
  readonly committed: boolean;
  readonly cleanup_complete: boolean;
  readonly directory_synced: boolean;

  constructor(
    code: string,
    message = code,
    committed = false,
    cleanupComplete = false,
    directorySynced = false,
  ) {
    super(message);
    this.name = 'OutputError';
    this.code = code;
    this.committed = committed;
    this.cleanup_complete = cleanupComplete;
    this.directory_synced = directorySynced;
  }
}

export interface OutputFaultHooks {
  readonly write?: () => void | Promise<void>;
  readonly file_sync?: () => void | Promise<void>;
  readonly link?: () => void | Promise<void>;
  readonly unlink?: () => void | Promise<void>;
  readonly directory_sync?: () => void | Promise<void>;
}

export interface PublishEvidenceOptions {
  readonly faults?: OutputFaultHooks;
}

export interface PublishEvidenceResult {
  readonly committed: boolean;
  readonly cleanup_complete: boolean;
  readonly directory_synced: boolean;
}

const securityError = (): OutputError => new OutputError('ESECURITY');

const isUnsupportedDirectorySync = (error: unknown): boolean => {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return code === 'EINVAL' || code === 'ENOTSUP' || code === 'EOPNOTSUPP';
};

const currentUid = (): number | undefined =>
  typeof process.getuid === 'function' ? process.getuid() : undefined;

const assertNoSymlinkComponents = async (directory: string): Promise<void> => {
  const absolute = resolve(directory);
  const root = parse(absolute).root;
  let cursor = root;
  for (const component of absolute.slice(root.length).split('/').filter(Boolean)) {
    cursor = join(cursor, component);
    let stat;
    try {
      stat = await lstat(cursor);
    } catch (error) {
      const code = (error as { readonly code?: unknown } | null)?.code;
      if (code === 'ENOENT') throw new OutputError('ENOENT');
      throw securityError();
    }
    // System-owned aliases such as macOS /var -> /private/var are trusted;
    // user-owned symlink components are rejected to prevent traversal.
    if (stat.isSymbolicLink() && stat.uid !== 0) throw securityError();
  }
};

const assertSafeDirectory = async (directory: string): Promise<void> => {
  const uid = currentUid();
  if (uid === undefined) throw securityError();
  const requested = resolve(directory);
  await assertNoSymlinkComponents(requested);
  let direct;
  try {
    direct = await lstat(requested);
  } catch (error) {
    const code = (error as { readonly code?: unknown } | null)?.code;
    if (code === 'ENOENT') throw new OutputError('ENOENT');
    throw securityError();
  }
  if (
    !direct.isDirectory() ||
    (direct.isSymbolicLink() && direct.uid !== 0) ||
    direct.uid !== uid ||
    (direct.mode & 0o022) !== 0
  ) {
    throw securityError();
  }
  let cursor = await realpath(requested);
  while (true) {
    let stat;
    try {
      stat = await lstat(cursor);
    } catch (error) {
      const code = (error as { readonly code?: unknown } | null)?.code;
      if (code === 'ENOENT') throw new OutputError('ENOENT');
      throw securityError();
    }
    if (
      !stat.isDirectory() ||
      ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0))
    ) {
      throw securityError();
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
};

export const preflightEvidencePath = async (value: string): Promise<string> => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new OutputError('EINVAL');
  }
  const target = isAbsolute(value) ? value : resolve(process.cwd(), value);
  const directory = dirname(target);
  await assertSafeDirectory(directory);
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink()) throw securityError();
    throw new OutputError('EEXIST');
  } catch (error) {
    if (error instanceof OutputError) throw error;
    const code = (error as { readonly code?: unknown } | null)?.code;
    if (code !== 'ENOENT') throw securityError();
  }
  return target;
};

const closeQuietly = async (handle: FileHandle | undefined): Promise<void> => {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // The original write error is the stable error; cleanup is best effort.
  }
};

const syncDirectory = async (
  directory: string,
  faults: OutputFaultHooks | undefined,
): Promise<void> => {
  await faults?.directory_sync?.();
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await closeQuietly(handle);
  }
};

export const publishEvidenceFile = async (
  value: string,
  serialized: string,
  options: PublishEvidenceOptions = {},
): Promise<PublishEvidenceResult> => {
  const target = await preflightEvidencePath(value);
  const directory = dirname(target);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const faults = options.faults;
  let handle: FileHandle | undefined;
  let targetPublished = false;
  let tempExists = false;
  let cleanupComplete = false;
  let directorySynced = false;

  const cleanupTemp = async (): Promise<boolean> => {
    if (!tempExists) {
      cleanupComplete = true;
      return true;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await faults?.unlink?.();
        await unlink(temporary);
        tempExists = false;
        cleanupComplete = true;
        return true;
      } catch {
        // Retry a bounded number of times. A persistent failure leaves the
        // complete 0600 temp file in place rather than deleting final output.
      }
    }
    cleanupComplete = false;
    return false;
  };

  const syncDirectoryWithRetry = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await syncDirectory(directory, faults);
        directorySynced = true;
        return true;
      } catch {
        // Retry bounded durability faults without touching the committed file.
      }
    }
    directorySynced = false;
    return false;
  };

  try {
    handle = await open(temporary, 'wx', 0o600);
    tempExists = true;
    await handle.chmod(0o600);
    await faults?.write?.();
    await handle.writeFile(`${serialized}\n`, 'utf8');
    await faults?.file_sync?.();
    await handle.sync();
    await handle.close();
    handle = undefined;
    await faults?.link?.();
    await link(temporary, target);
    targetPublished = true;
    cleanupComplete = false;
    // The link is the no-clobber commit point.  Errors after this point must
    // never produce a second EvidenceBundle.
    let postCommitError: unknown;
    try {
      await faults?.unlink?.();
      await unlink(temporary);
      tempExists = false;
      cleanupComplete = true;
    } catch (error) {
      postCommitError = error;
      await cleanupTemp();
    }
    await syncDirectoryWithRetry();
    if (!cleanupComplete || !directorySynced) {
      const code = (postCommitError as { readonly code?: unknown } | null)?.code;
      throw new OutputError(
        typeof code === 'string' ? code : 'EOUTPUT',
        typeof code === 'string' ? code : 'EOUTPUT',
        true,
        cleanupComplete,
        directorySynced,
      );
    }
    return {
      committed: targetPublished,
      cleanup_complete: cleanupComplete,
      directory_synced: directorySynced,
    };
  } catch (error) {
    await closeQuietly(handle);
    if (!targetPublished) await cleanupTemp();
    if (error instanceof OutputError) throw error;
    const code = (error as { readonly code?: unknown } | null)?.code;
    if (code === 'EEXIST') {
      throw new OutputError('EEXIST', 'EEXIST', false, cleanupComplete, directorySynced);
    }
    throw new OutputError(
      typeof code === 'string' ? code : 'EOUTPUT',
      typeof code === 'string' ? code : 'EOUTPUT',
      false,
      cleanupComplete,
      directorySynced,
    );
  }
};

const HIGH_RISK_KEY =
  /(?:authorization|cookie|proxy|password|secret|token|credential|raw|body|url|hostname|query|stack|exception|headers?|remote[_-]?address|ip[_-]?address|network[_-]?address|filepath|file[_-]?path|path|location)/i;
const SAFE_KEY =
  /^(?:proxy_env_present|no_proxy_present|extra_ca_present|body_observed|header_presence|location_present)$/;
const URL_VALUE = /(?:https?|ftp):\/\//i;
const CREDENTIAL_VALUE = /\b[^\s/:]+:[^\s/@]+@/;
const IPV4_VALUE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const IPV6_VALUE = /\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]*\b/i;
const ABSOLUTE_PATH_VALUE = /^(?:\/(?:Users|home|tmp|var|private|etc)\/|[A-Za-z]:[\\/])/;
const STABLE_REASON_CODES = new Set([
  'AGENT_INTERNAL_RUNTIME_NOT_OBSERVED',
  'RUN_INTERNAL_ERROR',
  'RUN_POLICY_REJECTED',
  'RUN_POLICY_INCOMPATIBLE',
  'RUN_POLICY_UNAVAILABLE',
  'CONTROL_CANCELLED',
  'CONTROL_EXECUTION_FAILED',
  'CONTROL_HTTPS_NOT_PROVEN',
  'CONTROL_NOT_OBSERVED_S1',
  'CONTROL_PROFILE_INCOMPATIBLE',
  'CONTROL_PREVIEW_UNVERIFIED',
  'CONTROL_PUBLIC_UNVERIFIED',
  'CONTROL_RESPONSE_MALFORMED',
  'CONTROL_RESPONSE_TOO_LARGE',
  'CONTROL_SELF_PASSED',
  'CONTROL_ECHO_PASSED',
  'CONTROL_TIMEOUT',
  'CONTROL_UNAVAILABLE',
  'REQUEST_MUTATION_OBSERVED',
  'TARGET_CANCELLED',
  'TARGET_DIFFERS_FROM_CONTROL',
  'TARGET_DNS_FAILED',
  'TARGET_DNS_FORBIDDEN_ADDRESS',
  'TARGET_DNS_PASSED',
  'TARGET_DNS_TIMEOUT',
  'TARGET_DNS_TOO_MANY_ADDRESSES',
  'TARGET_EXECUTION_FAILED',
  'TARGET_HEADERS_FAILED',
  'TARGET_HEADERS_PASSED',
  'TARGET_NETWORK_NOT_IMPLEMENTED_S1',
  'TARGET_POLICY_ALLOWED',
  'TARGET_POLICY_BLOCKED',
  'TARGET_TCP_FAILED',
  'TARGET_TCP_PASSED',
  'TARGET_TIMEOUT',
  'TARGET_TLS_FAILED',
  'TARGET_TLS_PASSED',
  'TARGET_UNEXPECTED_BODY',
  'S1_NETWORK_NOT_IMPLEMENTED',
  'invalid_target',
  'target_host_forbidden',
  'destination_ip_not_observed',
  'target_dns_failed',
  'target_dns_timeout',
  'target_cancelled',
  'target_dns_forbidden_address',
  'target_dns_too_many_addresses',
]);

const REDACTION_TEXT = new Set([
  'non-allowlisted request header values',
  'authorization, cookie and proxy credentials',
  'request body',
  'full user-agent value',
  'exception details and stack traces',
  'raw Control response body after allowlisted parsing',
  'raw response headers outside the allowlist',
  'target URL, hostname and query values after policy evaluation',
  'transient approved-address verification data after socket validation',
  'target request input omitted from terminal Evidence',
]);

const SUMMARY_TEXT = new Set([
  'The CLI cannot observe an Agent internal network runtime.',
  'Control HTTPS was not observed by the S1 no-network runner.',
  'Control API or Profile compatibility was not proven.',
  'An allowlisted diagnostic request value changed before the echo response.',
  'The Control run was cancelled before completion.',
  'Control HTTPS was not observed by the bounded transport.',
  'TargetPolicy blocked the target before a target network check could complete.',
  'The approved HTTPS target did not produce the same transport evidence as Control.',
  'A target was provided, but S1 intentionally performs no target network request.',
  'The diagnostic runner could not assemble a safe terminal result.',
  'The diagnostic run was cancelled before all checks completed.',
]);

const LIMITATION_TEXT = new Set([
  'Agent internal runtime remains not observed.',
  'TLS was observed and certificate verification was performed for the Preview Edge.',
  'Cloudflare Edge was observed for the Preview smoke.',
  'Preview Control trust, TLS authorization or Edge self evidence was not proven.',
  'Cloudflare Edge was not observed for the Preview smoke.',
  'Public Control trust, TLS authorization or Edge self evidence was not proven.',
  'Cloudflare Edge was observed for public Control.',
  'Cloudflare Edge was not observed for public Control.',
  'TLS was observed and certificate verification was performed for public Control.',
  'TLS was attempted with default certificate verification for public Control.',
  'TLS was observed and certificate verification was performed for the local loopback harness.',
  'Cloudflare Edge was not observed for the local loopback harness.',
  'TLS and Cloudflare Edge were not observed for the local loopback harness.',
  'S1 does not perform network requests.',
  'The diagnostic lane failed before producing a complete observation.',
  'Only the invoking runtime is observed.',
  'S1 does not make network requests, so connectivity is unproven.',
  'Target checks are deferred to a later issue.',
  'Differential compares bounded HTTPS observations only.',
  'Internal details are intentionally omitted.',
  'Cancellation may have occurred before a lane emitted an observation.',
  'A trusted Control response was not available for this check.',
  'TLS was attempted with default certificate verification for the Preview Edge.',
  'TLS was attempted with default certificate verification for the local loopback harness.',
  'The Control response or transport was not available for this check.',
  'Full target URL, IP addresses, certificate chain and raw headers/body are not retained.',
]);
const PROFILE_IDS = new Set([
  'netokay-control-s1',
  'netokay-control-s2-local',
  'netokay-control-s3-local',
  'netokay-control-s2-public',
  'netokay-control-s3-public',
  'netokay-control-s4-test',
]);

const safeStringByKey = (key: string | undefined, value: string): boolean => {
  if (key === 'summary') return SUMMARY_TEXT.has(value);
  if (key === 'limitations') {
    return (
      LIMITATION_TEXT.has(value) ||
      STABLE_REASON_CODES.has(value) ||
      /^Actual Control scheme (?:observed|attempted) by this runner: (?:http|https)\.$/.test(value)
    );
  }
  if (key === 'not_collected' || key === 'removed' || key === 'truncated') {
    return REDACTION_TEXT.has(value);
  }
  if (key === 'missing') {
    return (
      value === 'runner internal terminalization' ||
      value === 'control network observation' ||
      /^(?:control|target) (?:control|target)-[A-Za-z0-9._-]+ (?:failed|incomplete|cancelled|skipped|not_observed) observation$/.test(
        value,
      )
    );
  }
  if (key === 'possible_layers') {
    return [
      'runner',
      'execution_context',
      'control_transport',
      'target_policy',
      'target_transport',
    ].includes(value);
  }
  if (key === 'evidence_refs' || key === 'left_ref' || key === 'right_ref') {
    return /^observations\.[A-Za-z0-9._-]{1,128}$/.test(value);
  }
  if (key === 'suggested_next_steps') return false;
  if (key === 'bundle_id') return /^(?:bundle|netokay)[_-][A-Za-z0-9._-]{1,127}$/.test(value);
  if (key === 'profile_id') return PROFILE_IDS.has(value);
  if (key === 'schema_version') return /^1\.[0-9]+$/.test(value);
  if (key === 'version') return /^[a-z0-9][A-Za-z0-9._-]{1,63}$/.test(value);
  if (key === 'reasons' || key === 'result_code' || key === 'reason_code' || key === 'code') {
    return STABLE_REASON_CODES.has(value);
  }
  if (key === 'check_id') return /^(?:control|target)-[A-Za-z0-9._-]{1,96}$/.test(value);
  if (key === 'transport') return value === 'http' || value === 'https';
  if (key === 'source') return value === 'local_runner' || value === 'cloudflare_control';
  if (key === 'colo') return /^[A-Za-z0-9_-]{1,32}$/.test(value);
  if (key === 'scope') return value === 'control' || value === 'target';
  if (key === 'stage') return ['control', 'policy', 'dns', 'tcp', 'tls', 'headers'].includes(value);
  if (key === 'status') {
    return ['passed', 'failed', 'incomplete', 'skipped', 'not_observed', 'cancelled'].includes(
      value,
    );
  }
  if (key === 'run_status')
    return ['completed', 'rejected', 'cancelled', 'errored'].includes(value);
  if (key === 'outcome')
    return ['ready', 'attention', 'incomplete', 'rejected', 'error'].includes(value);
  if (key === 'kind') {
    return [
      'control_passed_target_failed',
      'local_shell',
      'agent_spawned_process',
      'container',
      'ci',
      'unknown',
    ].includes(value);
  }
  if (key === 'differential_id') return value === 'control-target-transport-001';
  if (key === 'target_decision')
    return ['not_applicable', 'not_requested', 'skipped', 'allowed', 'rejected'].includes(value);
  if (key === 'run_decision') return value === 'allowed' || value === 'rejected';
  if (key === 'control' || key === 'target')
    return [
      'passed',
      'failed',
      'incomplete',
      'not_observed',
      'cancelled',
      'skipped',
      'not_applicable',
    ].includes(value);
  if (key === 'agent_host') return ['codex', 'claude_code', 'cline', 'unknown'].includes(value);
  if (key === 'os_family') return ['darwin', 'linux', 'unknown'].includes(value);
  if (key === 'architecture') return ['arm64', 'x64', 'unknown'].includes(value);
  if (
    key === 'container' ||
    key === 'proxy_env_present' ||
    key === 'no_proxy_present' ||
    key === 'extra_ca_present'
  ) {
    return value === 'true' || value === 'false' || value === 'unknown';
  }
  if (key === 'agent_internal_runtime')
    return ['observed', 'not_observed', 'unknown'].includes(value);
  if (key && key.endsWith('_version')) return /^\d+\.[0-9]+(?:\.\d+)?$/.test(value);
  if (key === 'started_at' || key === 'completed_at' || key === 'observed_at') {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);
  }
  return false;
};

const safeFact = (key: string, value: unknown): boolean => {
  switch (key) {
    case 'api_version':
    case 'control_profile_version':
    case 'schema_version':
      return typeof value === 'string' && /^\d+\.[0-9]+(?:\.\d+)?$/.test(value);
    case 'capabilities':
      return (
        Array.isArray(value) &&
        value.length <= 16 &&
        value.every(
          (entry) => typeof entry === 'string' && /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/.test(entry),
        )
      );
    case 'control_environment':
      return (
        value === 'local_loopback_harness' ||
        value === 'cloudflare_edge' ||
        value === 'cloudflare_preview_unverified' ||
        value === 'cloudflare_public_unverified' ||
        value === 'cloudflare_public_edge'
      );
    case 'actual_scheme':
      return value === 'http' || value === 'https';
    case 'ip_family':
      return value === null || value === 'ipv4' || value === 'ipv6';
    case 'country':
      return value === null || (typeof value === 'string' && /^[A-Z]{2}$/.test(value));
    case 'asn':
    case 'client_tcp_rtt_ms':
    case 'address_count':
    case 'attempt_count':
      return (
        value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      );
    case 'colo':
      return value === null || (typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value));
    case 'http_protocol':
      return (
        value === null || ['HTTP/1.0', 'HTTP/1.1', 'HTTP/2', 'HTTP/3'].includes(value as string)
      );
    case 'tls_version':
    case 'tls_protocol':
      return value === null || value === 'TLSv1.2' || value === 'TLSv1.3';
    case 'missing_fields':
      return (
        Array.isArray(value) &&
        value.length <= 7 &&
        new Set(value).size === value.length &&
        value.every((entry) =>
          [
            'ip_family',
            'country',
            'asn',
            'colo',
            'http_protocol',
            'tls_version',
            'client_tcp_rtt_ms',
          ].includes(entry as string),
        )
      );
    case 'method':
      return value === 'GET' || value === 'HEAD';
    case 'x_netokay_run_id':
    case 'x_netokay_challenge':
    case 'x_netokay_client_version':
      return (
        value === null || (typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value))
      );
    case 'mismatched_fields':
      return (
        Array.isArray(value) &&
        value.length <= 3 &&
        value.every((entry) =>
          ['x_netokay_run_id', 'x_netokay_challenge', 'x_netokay_client_version'].includes(
            entry as string,
          ),
        )
      );
    case 'user_agent_class':
      return ['none', 'browser', 'node', 'curl', 'agent', 'other'].includes(value as string);
    case 'policy_reason':
    case 'diagnosis_code':
      return typeof value === 'string' && STABLE_REASON_CODES.has(value);
    case 'ip_families':
      return (
        Array.isArray(value) &&
        value.length <= 8 &&
        value.every((entry) => entry === 'ipv4' || entry === 'ipv6')
      );
    case 'phase_timings_ms':
      return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.entries(value).every(
          ([stage, duration]) =>
            ['dns', 'tcp', 'tls', 'headers'].includes(stage) &&
            typeof duration === 'number' &&
            Number.isSafeInteger(duration) &&
            duration >= 0,
        )
      );
    case 'alpn_protocol':
      return value === null || value === 'h2' || value === 'http/1.1';
    case 'authorized':
    case 'location_present':
    case 'redirect_present':
    case 'body_observed':
      return typeof value === 'boolean';
    case 'status':
      return (
        value === null ||
        (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599)
      );
    case 'status_class':
      return (
        value === null ||
        (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5)
      );
    case 'content_type':
      return (
        value === null ||
        (typeof value === 'string' && /^[a-z0-9!#$&^_.+*-]+\/[a-z0-9!#$&^_.+*-]{1,96}$/.test(value))
      );
    case 'failed_stage':
      return value === 'dns' || value === 'tcp' || value === 'tls' || value === 'headers';
    case 'fixture':
      return typeof value === 'boolean';
    default:
      return false;
  }
};

const safeEvidenceString = (key: string | undefined, value: string): boolean => {
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (
    URL_VALUE.test(value) ||
    CREDENTIAL_VALUE.test(value) ||
    IPV4_VALUE.test(value) ||
    IPV6_VALUE.test(value)
  ) {
    return false;
  }
  if (ABSOLUTE_PATH_VALUE.test(value)) return false;
  if (/(?:^|[?&#])[^\s=&]+=[^\s]+/.test(value)) return false;
  return true;
};

const walkRedactedEvidence = (
  value: unknown,
  key: string | undefined,
  parentKey: string | undefined,
  observationIds: ReadonlySet<string>,
): boolean => {
  if (parentKey === 'facts' && key) return safeFact(key, value);
  if (typeof value === 'string') {
    if (key === 'evidence_refs' || key === 'left_ref' || key === 'right_ref') {
      // Keep the reference-specific membership check, but also run the
      // generic allowlist so malformed reference strings cannot bypass the
      // sink's stable-string contract.
      return safeStringByKey(key, value) && observationIds.has(value);
    }
    return safeEvidenceString(key, value) && safeStringByKey(key, value);
  }
  if (Array.isArray(value)) {
    return value.every((entry) => walkRedactedEvidence(entry, key, parentKey, observationIds));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).every(
      ([entryKey, entryValue]) =>
        safeEvidenceString(undefined, entryKey) &&
        (!HIGH_RISK_KEY.test(entryKey) || SAFE_KEY.test(entryKey)) &&
        walkRedactedEvidence(entryValue, entryKey, key, observationIds),
    );
  }
  return value === null || typeof value === 'number' || typeof value === 'boolean';
};

/** Independent sink guard for high-risk values omitted by the JSON Schema. */
export const validateRedactedEvidenceBundle = (bundle: EvidenceBundle): boolean => {
  const observationIds = new Set(
    Array.isArray(bundle.observations)
      ? bundle.observations.flatMap((observation) =>
          typeof observation?.check_id === 'string' ? [`observations.${observation.check_id}`] : [],
        )
      : [],
  );
  return walkRedactedEvidence(bundle, undefined, undefined, observationIds);
};

export const serializeEvidenceBundle = (bundle: EvidenceBundle): string => {
  if (!validateEvidenceBundle(bundle) || !validateRedactedEvidenceBundle(bundle)) {
    throw new OutputError('ESERIALIZE');
  }
  try {
    return JSON.stringify(bundle);
  } catch {
    throw new OutputError('ESERIALIZE');
  }
};
