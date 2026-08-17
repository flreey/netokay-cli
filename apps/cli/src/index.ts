import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  runDiagnosticAsync,
  finalizeRun,
  CORE_VERSION,
  type DiagnosticRequest,
  type DiagnosticPorts,
  type ControlExecution,
  type ExecutionCollectionMetadata,
  type RunPolicyPort,
  type TerminalizationFaultPort,
} from '@netokay/core';
import type { Observation } from '@netokay/contracts';
import type { EvidenceBundle } from '@netokay/contracts';
import {
  assessControlCompatibility,
  echoObservation,
  failedControlObservation,
  readControlEchoResponse,
  readControlSelfResponse,
  selfObservation,
} from './control.js';
import {
  createNodeTransportExecutor,
  type TransportExecutor,
  type TransportResult,
} from './transport.js';
import { createTargetPort } from './target.js';
import {
  evaluateTargetPolicy,
  normalizeTargetUrl,
  rawTargetScheme,
  type TargetPolicyDecision,
  type TargetPolicyOptions,
} from './target-policy.js';
import {
  OutputError,
  preflightEvidencePath,
  publishEvidenceFile,
  serializeEvidenceBundle,
  type PublishEvidenceResult,
  type PublishEvidenceOptions,
} from './output.js';
import { createNetworkRouteResolver, type NetworkRoute } from './network-route.js';

const CLI_VERSION = '0.2.0' as const;
const SCHEMA_VERSION = '2.0' as const;
const CONTROL_PROFILE_VERSION = '1.0.0' as const;
const CONTROL_TOTAL_DEADLINE_MS = 20_000;
const CONTROL_ATTEMPT_DEADLINE_MS = 5_000;
export const PUBLIC_CONTROL_BASE_URL = 'https://netokay.net/' as const;
type ControlMode = 'local' | 'preview' | 'public';

/** The published CLI has a deliberate Node 24-only runtime contract. */
export const isSupportedNodeRuntime = (version = process.versions.node): boolean => {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return Number.isInteger(major) && major === 24;
};

/** Test-only application seam; production uses the deterministic defaults below. */
export interface CliRuntimeDependencies {
  readonly runPolicy?: RunPolicyPort;
  readonly faults?: TerminalizationFaultPort;
  readonly serializeEvidence?: (bundle: EvidenceBundle) => string;
  readonly publishEvidenceFile?: (
    path: string,
    serialized: string,
  ) => Promise<PublishEvidenceResult>;
  /** Test-only publisher options; production entrypoints leave this unset. */
  readonly publishEvidenceFileOptions?: PublishEvidenceOptions;
  /** Test-only Preview policy seam; production always evaluates the real policy. */
  readonly previewPolicyEvaluator?: (
    value: string | URL,
    options: Omit<TargetPolicyOptions, 'proxy_configured'>,
  ) => Promise<TargetPolicyDecision>;
  /** Test-only public Control policy seam; production always evaluates the real policy. */
  readonly publicControlPolicyEvaluator?: (
    value: string | URL,
    options: Omit<TargetPolicyOptions, 'proxy_configured'>,
  ) => Promise<TargetPolicyDecision>;
  /** Test-only transport seam; production always uses the bounded Node executor. */
  readonly controlTransport?: TransportExecutor;
  /** Test-only control endpoint/mode seam; never parsed from public argv. */
  readonly testControl?: Readonly<{ baseUrl: URL; mode: ControlMode }>;
}

const writeStdout = async (value: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let writeCallback = false;
    const cleanup = (): void => {
      process.stdout.removeListener('error', onError);
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    process.stdout.once('error', onError);
    try {
      process.stdout.write(`${value}\n`, () => {
        writeCallback = true;
        // A closed pipe reports EPIPE immediately after the write callback on
        // Node streams. Defer success by one turn so that error is observed
        // and terminalized instead of becoming an uncaught process exception.
        setImmediate(() => {
          if (settled || !writeCallback) return;
          settled = true;
          cleanup();
          resolve();
        });
      });
    } catch (error) {
      onError(error instanceof Error ? error : new Error('stdout unavailable'));
    }
  });
};

const writeStderr = async (value: string): Promise<void> => {
  await new Promise<void>((resolve) => {
    let settled = false;
    let writeCallback = false;
    const cleanup = (): void => {
      process.stderr.removeListener('error', onError);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (): void => finish();
    process.stderr.once('error', onError);
    try {
      process.stderr.write(value, () => {
        writeCallback = true;
        setImmediate(() => {
          if (!writeCallback) return;
          finish();
        });
      });
    } catch {
      finish();
    }
  });
};

const safeStderr = async (): Promise<void> => {
  try {
    await writeStderr('NetOkay output unavailable.\n');
  } catch {
    // stderr may be unavailable too; never surface the original exception.
  }
};

const postCommitWarning = (error: OutputError): string => {
  if (!error.cleanup_complete) {
    return 'NetOkay output warning: committed Evidence retained; temporary cleanup incomplete.\n';
  }
  if (!error.directory_synced) {
    return 'NetOkay output warning: committed Evidence retained; directory durability not confirmed.\n';
  }
  return 'NetOkay output warning: committed Evidence retained after output fault.\n';
};

const writePostCommitWarning = async (error: OutputError): Promise<void> => {
  try {
    await writeStderr(postCommitWarning(error));
  } catch {
    // stderr may be unavailable; the committed Bundle remains authoritative.
  }
};

const defaultRunPolicy: RunPolicyPort = {
  evaluate: (request) => {
    if (
      !request ||
      (request.transport !== 'http' && request.transport !== 'https') ||
      typeof request.profile_id !== 'string' ||
      request.profile_id.length === 0 ||
      request.profile_id.length > 128
    ) {
      return { decision: 'reject', reason_code: 'RUN_POLICY_REJECTED' };
    }
    return { decision: 'allow' };
  },
};

const terminalErrorBundle = (
  request: DiagnosticRequest,
  dependencies: CliRuntimeDependencies = {},
): EvidenceBundle =>
  finalizeRun({
    request,
    ports: ports(dependencies),
    status: 'errored',
    controlObservations: [],
    targetObservations: [],
    targetPolicy: request.target
      ? { target_decision: 'skipped', reasons: ['RUN_INTERNAL_ERROR'] }
      : { target_decision: 'not_applicable', reasons: ['RUN_INTERNAL_ERROR'] },
  });

const emitBundle = async (
  request: DiagnosticRequest,
  bundle: EvidenceBundle,
  outputPath?: string,
  dependencies: CliRuntimeDependencies = {},
): Promise<number> => {
  let serialized: string | undefined;
  let committed = false;
  let stdoutAttempted = false;
  let committedWarning: OutputError | undefined;
  const primarySerializer = dependencies.serializeEvidence ?? serializeEvidenceBundle;
  const publisher =
    dependencies.publishEvidenceFile ??
    ((path: string, value: string) =>
      publishEvidenceFile(path, value, dependencies.publishEvidenceFileOptions));
  try {
    serialized = primarySerializer(bundle);
    if (outputPath) {
      const result = await publisher(outputPath, serialized);
      committed = result.committed;
      if (result.committed && (!result.cleanup_complete || !result.directory_synced)) {
        committedWarning = new OutputError(
          !result.cleanup_complete
            ? 'OUTPUT_COMMITTED_CLEANUP_INCOMPLETE'
            : 'OUTPUT_COMMITTED_DURABILITY_UNCONFIRMED',
          'committed Evidence retained after output fault',
          true,
          result.cleanup_complete,
          result.directory_synced,
        );
      }
    }
    stdoutAttempted = true;
    await writeStdout(serialized);
    if (committedWarning) await writePostCommitWarning(committedWarning);
    return exitCodeFor(bundle.outcome);
  } catch (error) {
    if (error instanceof OutputError && error.committed) committedWarning = error;
    if (committed || committedWarning) {
      try {
        if (stdoutAttempted) {
          if (committedWarning) await writePostCommitWarning(committedWarning);
          else await safeStderr();
          return exitCodeFor(bundle.outcome);
        }
        if (!stdoutAttempted && serialized !== undefined) {
          stdoutAttempted = true;
          await writeStdout(serialized);
        }
        if (committedWarning) await writePostCommitWarning(committedWarning);
        return exitCodeFor(bundle.outcome);
      } catch {
        if (committedWarning) await writePostCommitWarning(committedWarning);
        else await safeStderr();
        return exitCodeFor(bundle.outcome);
      }
    }
    if (error instanceof OutputError || error instanceof Error) {
      if (stdoutAttempted) {
        await safeStderr();
        return 4;
      }
      try {
        const fallback = terminalErrorBundle(request, dependencies);
        stdoutAttempted = true;
        await writeStdout(serializeEvidenceBundle(fallback));
        return 4;
      } catch {
        await safeStderr();
        return 4;
      }
    }
    await safeStderr();
    return 4;
  }
};

const detectExecutionContext = (): DiagnosticRequest['execution_context'] => {
  const platform = process.platform;
  const architecture = process.arch;
  const isContainer = process.env.NETOKAY_CONTAINER === '1';
  const proxyEnvPresent = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ].some((key) => process.env[key] !== undefined);
  const noProxyPresent = ['NO_PROXY', 'no_proxy'].some((key) => process.env[key] !== undefined);
  return {
    kind: process.env.CI ? 'ci' : isContainer ? 'container' : 'local_shell',
    agent_host: 'unknown',
    os_family: platform === 'darwin' || platform === 'linux' ? platform : 'unknown',
    architecture: architecture === 'arm64' || architecture === 'x64' ? architecture : 'unknown',
    container: isContainer ? 'true' : 'unknown',
    proxy_env_present: proxyEnvPresent ? 'true' : 'false',
    no_proxy_present: noProxyPresent ? 'true' : 'false',
    extra_ca_present: 'unknown',
    agent_internal_runtime: 'not_observed',
  };
};

const ports = (dependencies: CliRuntimeDependencies = {}): DiagnosticPorts => ({
  clock: {
    now: () => new Date().toISOString(),
    monotonic_ms: () => performance.now(),
  },
  ids: { next: () => `netokay_${randomUUID()}` },
  versions: {
    cli: CLI_VERSION,
    core: CORE_VERSION,
    schema: SCHEMA_VERSION,
    control_profile: CONTROL_PROFILE_VERSION,
  },
  runPolicy: dependencies.runPolicy ?? defaultRunPolicy,
  faults: dependencies.faults,
});

const schemaPath = (): string =>
  fileURLToPath(new URL('../schema/evidence-bundle.schema.json', import.meta.url));

const printVersion = (): Record<string, string> => ({
  cli_version: CLI_VERSION,
  evidence_schema_version: SCHEMA_VERSION,
  control_profile_version: CONTROL_PROFILE_VERSION,
});

const printSchema = (): Record<string, string> => {
  const path = schemaPath();
  return {
    schema_version: SCHEMA_VERSION,
    schema_format: 'json-schema-2020-12',
    schema_path: path,
    schema_uri: new URL('../schema/evidence-bundle.schema.json', import.meta.url).href,
  };
};

const isLoopbackHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost') return true;
  const family = isIP(normalized);
  if (family === 4) {
    const firstOctet = Number(normalized.split('.')[0]);
    return firstOctet === 127;
  }
  return family === 6 && normalized === '::1';
};

export const parseControlBaseUrl = (value: string, _allowPreviewEdge = false): URL | null => {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.pathname !== '/' ||
      !isLoopbackHost(url.hostname)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
};

const parseTestControlUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.pathname !== '/' ||
      !url.hostname.includes('.')
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
};

/** Test-only Control policy seam; public invocations use the fixed service. */
export const evaluatePreviewControlPolicy = async (
  value: string | URL,
  options: Omit<TargetPolicyOptions, 'proxy_configured'> = {},
): Promise<TargetPolicyDecision> => {
  const url = parseTestControlUrl(typeof value === 'string' ? value : value.href);
  if (!url) {
    return {
      kind: 'blocked',
      reason_code: 'TARGET_POLICY_BLOCKED',
      safe_reason: 'invalid_target',
    };
  }
  return evaluateTargetPolicy(url.href, { ...options, proxy_configured: false });
};

/** The public service is a fixed root and is never selected from caller input. */
export const evaluatePublicControlPolicy = async (
  value: string | URL,
  options: Omit<TargetPolicyOptions, 'proxy_configured'> = {},
): Promise<TargetPolicyDecision> => {
  let url: URL;
  try {
    url = typeof value === 'string' ? new URL(value) : value;
  } catch {
    return {
      kind: 'blocked',
      reason_code: 'TARGET_POLICY_BLOCKED',
      safe_reason: 'invalid_target',
    };
  }
  if (url.href !== PUBLIC_CONTROL_BASE_URL) {
    return {
      kind: 'blocked',
      reason_code: 'TARGET_POLICY_BLOCKED',
      safe_reason: 'invalid_target',
    };
  }
  return evaluateTargetPolicy(url.href, { ...options, proxy_configured: false });
};

const transportReason = (transport: TransportResult): string => {
  if (transport.phase === 'timeout') return 'CONTROL_TIMEOUT';
  if (transport.phase === 'cancelled') return 'CONTROL_CANCELLED';
  if (transport.phase === 'response_too_large') return 'CONTROL_RESPONSE_TOO_LARGE';
  return 'CONTROL_UNAVAILABLE';
};

const exitCodeFor = (outcome: string): number =>
  outcome === 'ready'
    ? 0
    : outcome === 'attention'
      ? 1
      : outcome === 'incomplete'
        ? 2
        : outcome === 'rejected'
          ? 3
          : 4;

const intentTransportForTarget = (target: string | undefined): 'http' | 'https' => {
  if (!target) return 'https';
  const normalized = normalizeTargetUrl(target);
  return normalized.ok ? normalized.value.scheme : rawTargetScheme(target);
};

const runControlDiagnose = async (
  baseUrl: URL,
  target?: string,
  outputPath?: string,
  dependencies: CliRuntimeDependencies = {},
  mode: ControlMode = 'local',
): Promise<number> => {
  const executor =
    dependencies.controlTransport ?? createNodeTransportExecutor({ maxResponseBytes: 32 * 1024 });
  const runId = `run_${randomUUID()}`;
  const challenge = randomUUID();
  const controller = new AbortController();
  const started = Date.now();
  const deadlineAt = started + CONTROL_TOTAL_DEADLINE_MS;
  const deadlineTimer = setTimeout(() => controller.abort(), CONTROL_TOTAL_DEADLINE_MS);
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);
  const remotePreview = mode !== 'local';
  const routeResolver = createNetworkRouteResolver();
  type ControlObservationContext = {
    source: 'netokay_control' | 'local_runner';
    environment: string;
    actualScheme: string;
    route?: NetworkRoute;
  };
  const configuredPolicyEvaluator =
    mode === 'public'
      ? dependencies.publicControlPolicyEvaluator
      : dependencies.previewPolicyEvaluator;
  const previewPolicy = remotePreview
    ? await (
        configuredPolicyEvaluator ??
        (mode === 'public' ? evaluatePublicControlPolicy : evaluatePreviewControlPolicy)
      )(baseUrl, {
        signal: controller.signal,
        deadlineAt,
        ...(configuredPolicyEvaluator ? {} : { routeResolver }),
      })
    : null;
  const controlRoute =
    previewPolicy?.kind === 'allowed'
      ? (previewPolicy.route ?? {
          route_kind: 'direct',
          route_source: 'direct',
          resolution_source: 'local',
          destination_ip_observed: true,
        })
      : routeResolver.resolve(baseUrl);
  const unverifiedContext: ControlObservationContext = {
    source: 'local_runner',
    environment:
      mode === 'public'
        ? 'netokay_public_unverified'
        : mode === 'preview'
          ? 'netokay_test_unverified'
          : 'local_loopback_harness',
    actualScheme: baseUrl.protocol.replace(':', ''),
    route: controlRoute,
  };
  const verifiedContext: ControlObservationContext = remotePreview
    ? {
        source: 'netokay_control',
        environment: mode === 'public' ? 'netokay_public_service' : 'netokay_test_service',
        actualScheme: baseUrl.protocol.replace(':', ''),
        route: controlRoute,
      }
    : unverifiedContext;
  const approvedControlAddresses =
    previewPolicy?.kind === 'allowed' ? previewPolicy.approved_ips : undefined;
  const controlUsesSyntheticAddresses = controlRoute.route_source === 'transparent';
  const approvedControlSocket = (result: TransportResult): boolean =>
    (controlRoute.route_kind === 'proxy' && !controlUsesSyntheticAddresses) ||
    Boolean(
      result.remoteAddress &&
      approvedControlAddresses?.some(
        (address) => address.toLowerCase() === result.remoteAddress!.toLowerCase(),
      ),
    );
  const executionContext = detectExecutionContext();
  const targetPort = target
    ? createTargetPort({
        executor,
        routeResolver,
        proxyConfigured: false,
      })
    : undefined;
  const requestOptions = (runDeadlineAt: number, signal: AbortSignal = controller.signal) => ({
    deadlineAt: Math.min(deadlineAt, runDeadlineAt),
    signal,
    ...(approvedControlAddresses &&
    (controlRoute.route_kind !== 'proxy' || controlUsesSyntheticAddresses)
      ? {
          approvedAddresses: approvedControlAddresses,
          serverName: baseUrl.hostname,
        }
      : {}),
    route: controlRoute,
    headers: {
      accept: 'application/json',
      'x-netokay-run-id': runId,
      'x-netokay-challenge': challenge,
      'x-netokay-client-version': CLI_VERSION,
    },
  });
  let collection: ExecutionCollectionMetadata = {};
  const parse = (result: TransportResult): unknown | null => {
    if (result.statusCode !== null) {
      collection = { ...collection, control_response_headers_read: true };
    }
    if (result.phase === 'response_complete' && result.body !== null) {
      collection = { ...collection, control_response_body_parsed: true };
    }
    if (result.phase !== 'response_complete' || result.statusCode !== 200 || result.body === null) {
      return null;
    }
    try {
      return JSON.parse(result.body) as unknown;
    } catch {
      return null;
    }
  };
  const whenStarted = (startedAt: string): string => {
    const runMs = new Date(startedAt).getTime();
    return new Date(Math.max(Date.now(), runMs)).toISOString();
  };
  const durationFrom = (startedAt: string): number =>
    Math.max(0, Date.now() - new Date(startedAt).getTime());
  const failure = (
    checkId: 'control-self' | 'control-echo',
    result: TransportResult,
    startedAt: string,
    context: ControlObservationContext,
    durationMs = durationFrom(startedAt),
  ): Observation => {
    const reason = transportReason(result);
    return failedControlObservation(
      checkId,
      result.phase === 'cancelled' ? 'cancelled' : 'incomplete',
      reason,
      reason,
      startedAt,
      durationMs,
      context,
    );
  };
  const request: DiagnosticRequest = {
    transport: intentTransportForTarget(target),
    profile_id: target
      ? mode === 'public'
        ? 'netokay-control-s3-public'
        : 'netokay-control-s3-local'
      : mode === 'public'
        ? 'netokay-control-s2-public'
        : 'netokay-control-s2-local',
    target,
    execution_context: executionContext,
    policy_version: target
      ? mode === 'public'
        ? 's3-target-policy-public'
        : 's3-target-policy'
      : mode === 'public'
        ? 's2-control-only-public'
        : 's2-control-only',
  };
  const controlPort = {
    execute: async (
      _request: DiagnosticRequest,
      runContext: { startedAt: string; signal: AbortSignal; deadlineAt: number },
    ): Promise<ControlExecution> => {
      const observations: Observation[] = [];
      const startedAt = runContext.startedAt;
      if (previewPolicy?.kind === 'blocked') {
        const failureReason =
          mode === 'public' ? 'CONTROL_PUBLIC_UNVERIFIED' : 'CONTROL_PREVIEW_UNVERIFIED';
        observations.push(
          failedControlObservation(
            'control-self',
            'incomplete',
            failureReason,
            failureReason,
            startedAt,
            durationFrom(startedAt),
            unverifiedContext,
          ),
          failedControlObservation(
            'control-echo',
            'incomplete',
            failureReason,
            failureReason,
            whenStarted(startedAt),
            durationFrom(startedAt),
            unverifiedContext,
          ),
        );
        return { observations, collection, runStatus: 'completed' };
      }
      const selfResult = await executor.request(
        new URL('/v1/control/self', baseUrl),
        requestOptions(
          Math.min(runContext.deadlineAt, Date.now() + CONTROL_ATTEMPT_DEADLINE_MS),
          runContext.signal,
        ),
      );
      const selfDurationMs = durationFrom(startedAt);
      const selfBody = parse(selfResult);
      if (selfBody === null) {
        const failed = failure(
          'control-self',
          selfResult,
          startedAt,
          unverifiedContext,
          selfDurationMs,
        );
        observations.push(failed);
        return {
          observations,
          collection,
          runStatus: runContext.signal.aborted ? 'cancelled' : 'completed',
        };
      }
      const selfCompatibility = assessControlCompatibility(selfBody);
      if (!selfCompatibility.compatible) {
        observations.push(
          failedControlObservation(
            'control-self',
            'incomplete',
            'CONTROL_PROFILE_INCOMPATIBLE',
            'CONTROL_PROFILE_INCOMPATIBLE',
            startedAt,
            selfDurationMs,
            unverifiedContext,
          ),
        );
        return { observations, collection };
      }
      const selfRead = readControlSelfResponse(selfBody);
      if (!selfRead.ok) {
        observations.push(
          failedControlObservation(
            'control-self',
            'incomplete',
            selfRead.reasonCode,
            selfRead.reasonCode,
            startedAt,
            selfDurationMs,
            unverifiedContext,
          ),
        );
        return { observations, collection };
      }
      if (
        remotePreview &&
        (!approvedControlSocket(selfResult) ||
          selfResult.authorized !== true ||
          selfRead.value.colo === null ||
          selfRead.value.colo === '')
      ) {
        const failureReason =
          mode === 'public' ? 'CONTROL_PUBLIC_UNVERIFIED' : 'CONTROL_PREVIEW_UNVERIFIED';
        observations.push(
          failedControlObservation(
            'control-self',
            'incomplete',
            failureReason,
            failureReason,
            startedAt,
            selfDurationMs,
            unverifiedContext,
          ),
        );
        return { observations, collection, runStatus: 'completed' };
      }
      observations.push(
        selfObservation(
          selfRead.value,
          startedAt,
          selfDurationMs,
          mode === 'public' ? unverifiedContext : verifiedContext,
        ),
      );
      if (runContext.signal.aborted) {
        const cancelled = failure(
          'control-echo',
          {
            phase: 'cancelled',
            statusCode: null,
            headers: new Headers(),
            body: null,
            errorCode: 'ABORTED',
          },
          whenStarted(startedAt),
          unverifiedContext,
        );
        observations.push(cancelled);
        return { observations, collection, runStatus: 'cancelled' };
      }
      const echoStarted = whenStarted(startedAt);
      const echoResult = await executor.request(
        new URL('/v1/control/echo', baseUrl),
        requestOptions(
          Math.min(runContext.deadlineAt, Date.now() + CONTROL_ATTEMPT_DEADLINE_MS),
          runContext.signal,
        ),
      );
      const echoBody = parse(echoResult);
      if (echoBody === null) {
        const failed = failure('control-echo', echoResult, echoStarted, unverifiedContext);
        observations.push(failed);
        return {
          observations,
          collection,
          runStatus: runContext.signal.aborted ? 'cancelled' : 'completed',
        };
      }
      if (remotePreview && (!approvedControlSocket(echoResult) || echoResult.authorized !== true)) {
        const failureReason =
          mode === 'public' ? 'CONTROL_PUBLIC_UNVERIFIED' : 'CONTROL_PREVIEW_UNVERIFIED';
        observations.push(
          failedControlObservation(
            'control-echo',
            'incomplete',
            failureReason,
            failureReason,
            echoStarted,
            durationFrom(echoStarted),
            unverifiedContext,
          ),
        );
        return { observations, collection, runStatus: 'completed' };
      }
      const echoCompatibility = assessControlCompatibility(echoBody);
      if (!echoCompatibility.compatible) {
        observations.push(
          failedControlObservation(
            'control-echo',
            'incomplete',
            'CONTROL_PROFILE_INCOMPATIBLE',
            'CONTROL_PROFILE_INCOMPATIBLE',
            echoStarted,
            durationFrom(echoStarted),
            unverifiedContext,
          ),
        );
        return { observations, collection };
      }
      const rawEcho = echoBody as Record<string, unknown>;
      const mismatchedFields = [
        ['x_netokay_run_id', runId, rawEcho.x_netokay_run_id],
        ['x_netokay_challenge', challenge, rawEcho.x_netokay_challenge],
        ['x_netokay_client_version', CLI_VERSION, rawEcho.x_netokay_client_version],
      ]
        .filter(([, sent, received]) => sent !== received)
        .map(([field]) => field);
      if (mismatchedFields.length > 0) {
        observations.push(
          failedControlObservation(
            'control-echo',
            'failed',
            'REQUEST_MUTATION_OBSERVED',
            'REQUEST_MUTATION_OBSERVED',
            echoStarted,
            durationFrom(echoStarted),
            unverifiedContext,
            { mismatched_fields: mismatchedFields },
          ),
        );
        return {
          observations,
          collection,
          runStatus: runContext.signal.aborted ? 'cancelled' : 'completed',
        };
      }
      const echoRead = readControlEchoResponse(echoBody);
      if (!echoRead.ok) {
        observations.push(
          failedControlObservation(
            'control-echo',
            'incomplete',
            echoRead.reasonCode,
            echoRead.reasonCode,
            echoStarted,
            durationFrom(echoStarted),
            unverifiedContext,
          ),
        );
        return { observations, collection };
      }
      const echo = echoRead.value;
      if (mode === 'public') {
        observations[0] = selfObservation(
          selfRead.value,
          startedAt,
          selfDurationMs,
          verifiedContext,
        );
      }
      observations.push(
        echoObservation(echo, echoStarted, durationFrom(echoStarted), verifiedContext),
      );
      return {
        observations,
        collection,
        runStatus: runContext.signal.aborted ? 'cancelled' : 'completed',
      };
    },
  };
  try {
    const bundle = await runDiagnosticAsync(
      request,
      { ...ports(dependencies), control: controlPort, target: targetPort },
      {
        signal: controller.signal,
        deadlineAt,
      },
    );
    return emitBundle(request, bundle, outputPath, dependencies);
  } finally {
    clearTimeout(deadlineTimer);
    process.removeListener('SIGINT', onSigint);
  }
};

const runDiagnose = async (
  target: string | undefined,
  outputPath?: string,
  dependencies: CliRuntimeDependencies = {},
): Promise<number> => {
  const testControl = dependencies.testControl;
  return runControlDiagnose(
    testControl?.baseUrl ?? new URL(PUBLIC_CONTROL_BASE_URL),
    target,
    outputPath,
    dependencies,
    testControl?.mode ?? 'public',
  );
};

const requestForCliDiagnose = (
  target: string | undefined,
  mode: ControlMode = 'public',
): DiagnosticRequest => ({
  transport: intentTransportForTarget(target),
  profile_id: target
    ? mode === 'public'
      ? 'netokay-control-s3-public'
      : 'netokay-control-s3-local'
    : mode === 'public'
      ? 'netokay-control-s2-public'
      : 'netokay-control-s2-local',
  target,
  execution_context: detectExecutionContext(),
  policy_version: target
    ? mode === 'public'
      ? 's3-target-policy-public'
      : 's3-target-policy'
    : mode === 'public'
      ? 's2-control-only-public'
      : 's2-control-only',
});

const usage = (): string => 'Usage: netokay <version|schema|diagnose [target] [--out <path>]>\n';

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: CliRuntimeDependencies = {},
): Promise<number> {
  if (!isSupportedNodeRuntime()) {
    await writeStderr('NetOkay requires Node 24.\n');
    return 64;
  }
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    await writeStderr(usage());
    return command ? 0 : 64;
  }
  if (command === 'version' && rest.length === 0) {
    try {
      await writeStdout(JSON.stringify(printVersion()));
      return 0;
    } catch {
      await safeStderr();
      return 4;
    }
  }
  if (command === 'schema' && rest.length === 0) {
    try {
      await writeStdout(JSON.stringify(printSchema()));
      return 0;
    } catch {
      await safeStderr();
      return 4;
    }
  }
  if (command === 'diagnose') {
    let target: string | undefined;
    let outputPath: string | undefined;
    try {
      const parsed = parseArgs({
        args: rest,
        options: {
          out: { type: 'string' },
        },
        allowPositionals: true,
        strict: true,
      });
      if (parsed.positionals.length > 1) throw new Error('too many positionals');
      target = parsed.positionals[0];
      const outputValue = parsed.values.out;
      if (outputValue !== undefined && typeof outputValue !== 'string') {
        throw new Error('invalid output path');
      }
      if (outputValue !== undefined) outputPath = await preflightEvidencePath(outputValue);
    } catch (error) {
      await writeStderr(`${usage()}Invalid arguments.\n`);
      return 64;
    }
    try {
      return await runDiagnose(target, outputPath, dependencies);
    } catch {
      const request = requestForCliDiagnose(target, dependencies.testControl?.mode ?? 'public');
      const bundle = terminalErrorBundle(request, dependencies);
      return emitBundle(request, bundle, outputPath, dependencies);
    }
  }
  await writeStderr(`${usage()}Invalid arguments.\n`);
  return 64;
}

const isEntrypoint =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      void safeStderr().then(() => {
        process.exitCode = 4;
      });
    },
  );
}
