import {
  evidenceBundleValidationErrors,
  validateEvidenceBundle,
  type EvidenceBundle,
  type Diagnosis,
  type ExecutionContext,
  type Observation,
  type Policy,
} from '@netokay/contracts';

export const CORE_VERSION = '0.2.0' as const;

export type ExecutionContextInput = Pick<ExecutionContext, 'kind' | 'agent_internal_runtime'> &
  Partial<Omit<ExecutionContext, 'kind' | 'agent_internal_runtime'>>;

export interface DiagnosticRequest {
  readonly transport: 'http' | 'https';
  readonly profile_id: string;
  readonly target?: string;
  readonly policy_version?: string;
  readonly execution_context: ExecutionContextInput;
}

export interface ClockPort {
  readonly now: () => string;
  readonly monotonic_ms: () => number;
}

export interface IdPort {
  readonly next: () => string;
}

export interface VersionSet {
  readonly cli: string;
  readonly core: string;
  readonly schema: string;
  readonly control_profile: string;
}

export type TerminalRunStatus = Extract<
  EvidenceBundle['run_status'],
  'completed' | 'rejected' | 'cancelled' | 'errored'
>;

export type RunPhase =
  | 'created'
  | 'run_policy_checked'
  | 'running_checks'
  | 'evaluating'
  | 'finalizing'
  | TerminalRunStatus;

export interface RunSnapshot {
  readonly phase: RunPhase;
  readonly terminal_status?: TerminalRunStatus;
}

export type RunReducerEvent =
  | 'run_policy_allowed'
  | 'run_policy_rejected'
  | 'checks_started'
  | 'checks_terminal'
  | 'cancelled'
  | 'fault'
  | 'finalize_completed'
  | 'finalize_rejected'
  | 'finalize_cancelled'
  | 'finalize_errored';

export interface RunReducer {
  readonly snapshot: () => RunSnapshot;
  readonly dispatch: (event: RunReducerEvent) => RunSnapshot;
}

export interface RunPolicyResult {
  readonly decision: 'allow' | 'reject';
  readonly reason_code?: string;
}

export interface RunPolicyPort {
  readonly evaluate: (request: DiagnosticRequest) => RunPolicyResult | Promise<RunPolicyResult>;
}

/** Explicit test-only seam for exercising terminalization fault paths. */
export interface TerminalizationFaultPort {
  readonly evaluation?: () => void;
  readonly builder?: () => void;
}

export interface ObservationFixturePort {
  readonly control: (request: DiagnosticRequest, startedAt: string) => readonly Observation[];
  readonly diagnoses?: (
    request: DiagnosticRequest,
    observations: readonly Observation[],
  ) => readonly Diagnosis[];
}

export interface ControlRunContext {
  readonly startedAt: string;
  readonly startedMono: number;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

/** Internal safe metadata tying redaction claims to actually executed stages. */
export interface ExecutionCollectionMetadata {
  readonly target_policy_input_evaluated?: boolean;
  readonly control_response_body_parsed?: boolean;
  readonly control_response_headers_read?: boolean;
  readonly target_response_headers_read?: boolean;
  readonly target_socket_address_verified?: boolean;
}

export interface ControlExecution {
  readonly observations: readonly Observation[];
  readonly collection?: ExecutionCollectionMetadata;
  readonly runStatus?: Extract<EvidenceBundle['run_status'], 'completed' | 'cancelled'>;
}

/** Production S2 seam: the port owns network I/O, while Core owns run lifecycle and bundle assembly. */
export interface ControlPort {
  readonly execute: (
    request: DiagnosticRequest,
    context: ControlRunContext,
  ) => Promise<ControlExecution>;
}

export interface TargetExecution {
  readonly observations: readonly Observation[];
  readonly policy: Pick<Policy, 'target_decision' | 'reasons'>;
  readonly collection?: ExecutionCollectionMetadata;
  readonly runStatus?: Extract<EvidenceBundle['run_status'], 'completed' | 'cancelled'>;
}

export interface TargetPort {
  readonly execute: (
    request: DiagnosticRequest,
    context: ControlRunContext,
  ) => Promise<TargetExecution>;
}

export interface DiagnosticPorts {
  readonly clock: ClockPort;
  readonly ids: IdPort;
  readonly versions: VersionSet;
  /** Optional whole-run policy. Rejection prevents all diagnostic lanes from starting. */
  readonly runPolicy?: RunPolicyPort;
  /** Test-only fault injection; never supplied by the CLI runtime. */
  readonly faults?: TerminalizationFaultPort;
  /** Synchronous fixture seam retained for S1/core unit tests only. */
  readonly fixture?: ObservationFixturePort;
  /** Asynchronous production Control seam used by S2. */
  readonly control?: ControlPort;
  /** Asynchronous production Target seam used by S3. */
  readonly target?: TargetPort;
}

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
};

export const createRunReducer = (): RunReducer => {
  let state: RunSnapshot = { phase: 'created' };
  const terminal = (status: TerminalRunStatus): RunSnapshot => ({
    phase: status,
    terminal_status: status,
  });
  const snapshot = (): RunSnapshot => deepFreeze({ ...state });
  const dispatch = (event: RunReducerEvent): RunSnapshot => {
    if (state.terminal_status) return snapshot();
    switch (event) {
      case 'run_policy_allowed':
        if (state.phase !== 'created') throw new Error('RUN_REDUCER_INVALID_TRANSITION');
        state = { phase: 'run_policy_checked' };
        break;
      case 'run_policy_rejected':
        if (state.phase !== 'created') throw new Error('RUN_REDUCER_INVALID_TRANSITION');
        state = terminal('rejected');
        break;
      case 'checks_started':
        if (state.phase !== 'run_policy_checked') throw new Error('RUN_REDUCER_INVALID_TRANSITION');
        state = { phase: 'running_checks' };
        break;
      case 'checks_terminal':
        if (state.phase !== 'running_checks') throw new Error('RUN_REDUCER_INVALID_TRANSITION');
        state = { phase: 'evaluating' };
        break;
      case 'cancelled':
        if (
          state.phase === 'created' ||
          state.phase === 'run_policy_checked' ||
          state.phase === 'running_checks' ||
          state.phase === 'evaluating'
        )
          state = terminal('cancelled');
        else throw new Error('RUN_REDUCER_INVALID_TRANSITION');
        break;
      case 'fault':
        if (
          state.phase === 'created' ||
          state.phase === 'run_policy_checked' ||
          state.phase === 'running_checks' ||
          state.phase === 'evaluating'
        )
          state = { phase: 'finalizing' };
        else throw new Error('RUN_REDUCER_INVALID_TRANSITION');
        break;
      case 'finalize_completed':
        if (state.phase !== 'evaluating' && state.phase !== 'finalizing')
          throw new Error('RUN_REDUCER_INVALID_TRANSITION');
        state = terminal('completed');
        break;
      case 'finalize_rejected':
        if (state.phase !== 'created' && state.phase !== 'finalizing')
          throw new Error('RUN_REDUCER_INVALID_TRANSITION');
        state = terminal('rejected');
        break;
      case 'finalize_cancelled':
        if (
          state.phase !== 'run_policy_checked' &&
          state.phase !== 'running_checks' &&
          state.phase !== 'evaluating' &&
          state.phase !== 'finalizing'
        )
          throw new Error('RUN_REDUCER_INVALID_TRANSITION');
        state = terminal('cancelled');
        break;
      case 'finalize_errored':
        state = terminal('errored');
        break;
      default: {
        const exhaustive: never = event;
        throw new Error(`RUN_REDUCER_UNKNOWN_EVENT_${String(exhaustive)}`);
      }
    }
    return snapshot();
  };
  return {
    snapshot,
    dispatch,
  };
};

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback;

const contextForEvidence = (input: ExecutionContextInput): ExecutionContext => ({
  kind: oneOf(
    input.kind,
    ['local_shell', 'agent_spawned_process', 'container', 'ci', 'unknown'] as const,
    'unknown',
  ),
  agent_host: oneOf(
    input.agent_host,
    ['codex', 'claude_code', 'cline', 'unknown'] as const,
    'unknown',
  ),
  os_family: oneOf(input.os_family, ['darwin', 'linux', 'unknown'] as const, 'unknown'),
  architecture: oneOf(input.architecture, ['arm64', 'x64', 'unknown'] as const, 'unknown'),
  container: oneOf(input.container, ['true', 'false', 'unknown'] as const, 'unknown'),
  proxy_env_present: oneOf(
    input.proxy_env_present,
    ['true', 'false', 'unknown'] as const,
    'unknown',
  ),
  no_proxy_present: oneOf(input.no_proxy_present, ['true', 'false', 'unknown'] as const, 'unknown'),
  extra_ca_present: oneOf(input.extra_ca_present, ['true', 'false', 'unknown'] as const, 'unknown'),
  agent_internal_runtime: oneOf(
    input.agent_internal_runtime,
    ['observed', 'not_observed', 'unknown'] as const,
    'unknown',
  ),
});

const observationForS1 = (startedAt: string): Observation => ({
  check_id: 'control-self',
  scope: 'control',
  transport: 'https',
  stage: 'control',
  status: 'not_observed',
  started_at: startedAt,
  duration_ms: 0,
  result_code: 'CONTROL_NOT_OBSERVED_S1',
  reason_code: 'CONTROL_NOT_OBSERVED_S1',
  facts: {},
  limitations: ['S1 does not perform network requests.'],
  source: 'local_runner',
});

const controlCompleteness = (
  observations: readonly Observation[],
): 'passed' | 'failed' | 'incomplete' | 'not_observed' | 'cancelled' => {
  if (observations.some((observation) => observation.status === 'failed')) return 'failed';
  if (observations.some((observation) => observation.status === 'cancelled')) return 'cancelled';
  if (observations.some((observation) => observation.status === 'incomplete')) return 'incomplete';
  if (observations.some((observation) => observation.status === 'passed')) return 'passed';
  return 'not_observed';
};

const targetCompleteness = (
  observations: readonly Observation[],
  targetDecision: Policy['target_decision'],
  runStatus: TerminalRunStatus,
): 'passed' | 'failed' | 'incomplete' | 'skipped' | 'cancelled' | 'not_applicable' => {
  if (targetDecision === 'not_applicable') return 'not_applicable';
  if (
    runStatus === 'cancelled' ||
    observations.some((observation) => observation.status === 'cancelled')
  ) {
    return 'cancelled';
  }
  if (targetDecision === 'skipped') return 'skipped';
  if (observations.some((observation) => observation.status === 'failed')) return 'failed';
  if (observations.some((observation) => observation.status === 'incomplete')) return 'incomplete';
  if (
    observations.length > 0 &&
    observations.every((observation) => observation.status === 'passed')
  ) {
    return 'passed';
  }
  return 'incomplete';
};

const allPassedHttps = (observations: readonly Observation[]): boolean =>
  observations.length > 0 &&
  observations.every(
    (observation) => observation.status === 'passed' && observation.transport === 'https',
  );

const allPassed = (observations: readonly Observation[]): boolean =>
  observations.length > 0 && observations.every((observation) => observation.status === 'passed');

const comparableTransports = (
  controlObservations: readonly Observation[],
  targetObservations: readonly Observation[],
): boolean => {
  if (!allPassed(controlObservations) || targetObservations.length === 0) return false;
  const controlTransports = new Set(
    controlObservations.map((observation) => observation.transport),
  );
  const targetTransports = new Set(targetObservations.map((observation) => observation.transport));
  if (controlTransports.size !== 1 || targetTransports.size !== 1) return false;
  return [...controlTransports][0] === [...targetTransports][0];
};

type NonErroredTerminalStatus = Exclude<TerminalRunStatus, 'errored'>;

const outcomeFor = (
  request: DiagnosticRequest,
  controlObservations: readonly Observation[],
  targetObservations: readonly Observation[],
  targetDecision: Policy['target_decision'],
  runStatus: NonErroredTerminalStatus,
): EvidenceBundle['outcome'] => {
  if (runStatus === 'rejected') return 'rejected';
  if (runStatus === 'cancelled') return 'incomplete';
  if (targetDecision === 'not_applicable') {
    if (controlObservations.some((observation) => observation.status === 'failed'))
      return 'attention';
    if (
      controlObservations.length === 0 ||
      controlObservations.some((observation) => observation.status !== 'passed')
    ) {
      return 'incomplete';
    }
    return 'ready';
  }
  if (targetDecision === 'skipped') return 'incomplete';
  if (!allPassed(controlObservations)) {
    return 'incomplete';
  }
  if (
    targetObservations.some(
      (observation) => observation.status === 'failed' || observation.status === 'incomplete',
    )
  ) {
    return comparableTransports(controlObservations, targetObservations) &&
      allPassedHttps(controlObservations) &&
      targetObservations.some((observation) => observation.transport === 'https')
      ? 'attention'
      : 'incomplete';
  }
  if (
    request.target &&
    (targetObservations.length === 0 ||
      targetObservations.some((observation) => observation.status !== 'passed'))
  ) {
    return 'incomplete';
  }
  if (!comparableTransports(controlObservations, targetObservations)) return 'incomplete';
  return 'ready';
};

const missingFromObservations = (observations: readonly Observation[]): string[] => {
  if (observations.length === 0) return [];
  return observations
    .filter((observation) => observation.status !== 'passed')
    .map((observation) => {
      if (observation.status === 'not_observed') return `${observation.scope} network observation`;
      return `${observation.scope} ${observation.check_id} ${observation.status} observation`;
    });
};

const executionFailureObservation = (
  checkId: string,
  transport: Observation['transport'],
  stage: Observation['stage'],
  startedAt: string,
  reasonCode: string,
): Observation => ({
  check_id: checkId,
  scope: checkId.startsWith('target-') ? 'target' : 'control',
  transport,
  stage,
  status: 'incomplete',
  started_at: startedAt,
  duration_ms: 0,
  result_code: reasonCode,
  reason_code: reasonCode,
  facts: {},
  limitations: ['The diagnostic lane failed before producing a complete observation.'],
  source: 'local_runner',
});

const makeDiagnoses = (
  request: DiagnosticRequest,
  controlObservations: readonly Observation[],
  targetObservations: readonly Observation[],
  context: ExecutionContext,
  extraDiagnoses: readonly Diagnosis[] = [],
  targetPolicy: Pick<Policy, 'target_decision' | 'reasons'> = {
    target_decision: 'not_applicable',
    reasons: [],
  },
  differentials: readonly EvidenceBundle['differentials'][number][] = [],
): EvidenceBundle['diagnoses'] => {
  const diagnoses: EvidenceBundle['diagnoses'] = [...extraDiagnoses];
  if (context.agent_internal_runtime === 'not_observed') {
    diagnoses.push({
      code: 'AGENT_INTERNAL_RUNTIME_NOT_OBSERVED',
      summary: 'The CLI cannot observe an Agent internal network runtime.',
      evidence_refs: [],
      possible_layers: ['execution_context'],
      limitations: ['Only the invoking runtime is observed.'],
      suggested_next_steps: [],
    });
  }
  if (
    controlObservations.length > 0 &&
    controlObservations.every((observation) => observation.status === 'not_observed')
  ) {
    diagnoses.push({
      code: 'CONTROL_HTTPS_NOT_PROVEN',
      summary: 'Control HTTPS was not observed by the S1 no-network runner.',
      evidence_refs: controlObservations.map(
        (observation) => `observations.${observation.check_id}`,
      ),
      possible_layers: ['control_transport'],
      limitations: ['S1 does not make network requests, so connectivity is unproven.'],
      suggested_next_steps: [],
    });
  }
  const knownCodes = new Set([...diagnoses.map((diagnosis) => diagnosis.code)]);
  for (const observation of controlObservations) {
    const factCode =
      typeof observation.facts.diagnosis_code === 'string'
        ? observation.facts.diagnosis_code
        : undefined;
    const stableCode = [factCode, observation.result_code, observation.reason_code].find((code) =>
      ['CONTROL_PROFILE_INCOMPATIBLE', 'REQUEST_MUTATION_OBSERVED', 'CONTROL_CANCELLED'].includes(
        code ?? '',
      ),
    );
    const code =
      stableCode === 'CONTROL_PROFILE_INCOMPATIBLE'
        ? 'CONTROL_PROFILE_INCOMPATIBLE'
        : stableCode === 'REQUEST_MUTATION_OBSERVED'
          ? 'REQUEST_MUTATION_OBSERVED'
          : stableCode === 'CONTROL_CANCELLED' || observation.status === 'cancelled'
            ? 'CONTROL_CANCELLED'
            : observation.status !== 'passed' &&
                observation.result_code !== 'CONTROL_NOT_OBSERVED_S1'
              ? 'CONTROL_HTTPS_NOT_PROVEN'
              : undefined;
    if (!code || knownCodes.has(code)) continue;
    knownCodes.add(code);
    diagnoses.push({
      code,
      summary:
        code === 'CONTROL_PROFILE_INCOMPATIBLE'
          ? 'Control API or Profile compatibility was not proven.'
          : code === 'REQUEST_MUTATION_OBSERVED'
            ? 'An allowlisted diagnostic request value changed before the echo response.'
            : code === 'CONTROL_CANCELLED'
              ? 'The Control run was cancelled before completion.'
              : 'Control HTTPS was not observed by the bounded transport.',
      evidence_refs: [`observations.${observation.check_id}`],
      possible_layers: ['control_transport'],
      limitations:
        typeof observation.facts.actual_scheme === 'string'
          ? [`Actual Control scheme observed by this runner: ${observation.facts.actual_scheme}.`]
          : ['The Control response or transport was not available for this check.'],
      suggested_next_steps: [],
    });
  }
  if (
    targetPolicy.target_decision === 'skipped' &&
    !targetPolicy.reasons.includes('S1_NETWORK_NOT_IMPLEMENTED')
  ) {
    diagnoses.push({
      code: 'TARGET_POLICY_BLOCKED',
      summary: 'TargetPolicy blocked the target before a target network check could complete.',
      evidence_refs: targetObservations.map(
        (observation) => `observations.${observation.check_id}`,
      ),
      possible_layers: ['target_policy'],
      limitations: targetPolicy.reasons,
      suggested_next_steps: [],
    });
  }
  if (differentials.length > 0) {
    const differential = differentials[0];
    diagnoses.push({
      code: 'TARGET_DIFFERS_FROM_CONTROL',
      summary: 'The approved HTTPS target did not produce the same transport evidence as Control.',
      evidence_refs: [differential.left_ref, differential.right_ref],
      possible_layers: ['target_transport'],
      limitations: differential.limitations,
      suggested_next_steps: [],
    });
  }
  if (request.target && targetPolicy.reasons.includes('S1_NETWORK_NOT_IMPLEMENTED')) {
    diagnoses.push({
      code: 'TARGET_NETWORK_NOT_IMPLEMENTED_S1',
      summary: 'A target was provided, but S1 intentionally performs no target network request.',
      evidence_refs: [],
      possible_layers: ['target_policy'],
      limitations: ['Target checks are deferred to a later issue.'],
      suggested_next_steps: [],
    });
  }
  return diagnoses;
};

const makeDifferentials = (
  controlObservations: readonly Observation[],
  targetObservations: readonly Observation[],
  targetDecision: Policy['target_decision'],
): EvidenceBundle['differentials'] => {
  if (targetDecision !== 'allowed') return [];
  if (!allPassedHttps(controlObservations)) return [];
  const failedTarget = targetObservations.find(
    (observation) => observation.status === 'failed' || observation.status === 'incomplete',
  );
  if (!failedTarget || failedTarget.transport !== 'https') return [];
  const control = controlObservations[0]!;
  return [
    {
      differential_id: 'control-target-transport-001',
      kind: 'control_passed_target_failed',
      left_ref: `observations.${control.check_id}`,
      right_ref: `observations.${failedTarget.check_id}`,
      limitations: ['Differential compares bounded HTTPS observations only.'],
    },
  ];
};

const assertTerminalObservations = (observations: readonly Observation[]): void => {
  for (const observation of observations) {
    const status = (observation as unknown as { readonly status: string }).status;
    if (status === 'pending' || status === 'running') {
      throw new Error('RUN_TERMINALIZATION_INVARIANT');
    }
  }
};

export interface FinalizeRunInput {
  readonly request: DiagnosticRequest;
  readonly ports: DiagnosticPorts;
  readonly startedAt?: string;
  readonly startedMono?: number;
  readonly status: TerminalRunStatus;
  readonly controlObservations: readonly Observation[];
  readonly targetObservations: readonly Observation[];
  readonly targetPolicy: Pick<Policy, 'target_decision' | 'reasons'>;
  readonly extraDiagnoses?: readonly Diagnosis[];
  readonly collection?: ExecutionCollectionMetadata;
  readonly runDecision?: Policy['run_decision'];
  readonly runReasons?: readonly string[];
  /** The entrance-owned reducer; omitted only for direct terminalizer tests. */
  readonly reducer?: RunReducer;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const isIsoTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && ISO_TIMESTAMP.test(value);

const normalizeIsoTimestamp = (value: unknown, fallback: string): string =>
  isIsoTimestamp(value) ? value : fallback;

const safeErrorString = (value: unknown, fallback: string, maxLength: 64 | 128): string => {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, maxLength);
};

const safeClockNow = (ports: DiagnosticPorts, fallback: string): string => {
  try {
    return normalizeIsoTimestamp(ports.clock.now(), fallback);
  } catch {
    return fallback;
  }
};

const safeClockMono = (ports: DiagnosticPorts, fallback: number): number => {
  try {
    const value = ports.clock.monotonic_ms();
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  } catch {
    return fallback;
  }
};

const buildErroredBundle = (input: FinalizeRunInput): EvidenceBundle => {
  const { request, ports } = input;
  const epoch = '1970-01-01T00:00:00.000Z';
  const startedAt = isIsoTimestamp(input.startedAt) ? input.startedAt : safeClockNow(ports, epoch);
  const completedAt = safeClockNow(ports, epoch);
  const schemaVersion = /^2\.[0-9]+$/.test(ports.versions.schema) ? ports.versions.schema : '2.0';
  const evidenceContext = contextForEvidence(request.execution_context);
  const errorDiagnoses: Diagnosis[] = [
    {
      code: 'RUN_INTERNAL_ERROR',
      summary: 'The diagnostic runner could not assemble a safe terminal result.',
      evidence_refs: [],
      possible_layers: ['runner'],
      limitations: ['Internal details are intentionally omitted.'],
      suggested_next_steps: [],
    },
  ];
  if (evidenceContext.agent_internal_runtime === 'not_observed') {
    errorDiagnoses.push({
      code: 'AGENT_INTERNAL_RUNTIME_NOT_OBSERVED',
      summary: 'The CLI cannot observe an Agent internal network runtime.',
      evidence_refs: [],
      possible_layers: ['execution_context'],
      limitations: ['Only the invoking runtime is observed.'],
      suggested_next_steps: [],
    });
  }
  let bundleId = 'netokay_error';
  try {
    const candidate = ports.ids.next();
    if (/^[A-Za-z0-9._-]{1,128}$/.test(candidate)) bundleId = candidate;
  } catch {
    // The independent error builder intentionally has no dependency on the normal ID path.
  }
  const collection = input.collection ?? {};
  const removed = [
    ...(collection.control_response_body_parsed
      ? ['raw Control response body after allowlisted parsing']
      : []),
    ...(collection.control_response_headers_read || collection.target_response_headers_read
      ? ['raw response headers outside the allowlist']
      : []),
    ...(collection.target_policy_input_evaluated
      ? ['target URL, hostname and query values after policy evaluation']
      : []),
    ...(collection.target_socket_address_verified
      ? ['transient approved-address verification data after socket validation']
      : []),
    ...(request.target && !collection.target_policy_input_evaluated
      ? ['target request input omitted from terminal Evidence']
      : []),
  ];
  const notCollected = [
    'non-allowlisted request header values',
    'authorization, cookie and proxy credentials',
    'request body',
    'full user-agent value',
  ];
  const bundle: EvidenceBundle = {
    schema_version: schemaVersion,
    bundle_id: bundleId,
    run_status: 'errored',
    outcome: 'error',
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: 0,
    runner: {
      cli_version: safeErrorString(ports.versions.cli, '0.0.0', 64),
      core_version: safeErrorString(ports.versions.core, '0.0.0', 64),
      control_profile_version: safeErrorString(ports.versions.control_profile, '0.0.0', 64),
    },
    execution_context: evidenceContext,
    intent: {
      transport: request.transport === 'http' ? 'http' : 'https',
      profile_id: safeErrorString(request.profile_id, 'unknown', 128),
      has_target: Boolean(request.target),
    },
    policy: {
      version: 's4-terminalization',
      run_decision: 'allowed',
      target_decision: request.target ? 'skipped' : 'not_applicable',
      reasons: ['RUN_INTERNAL_ERROR'],
    },
    observations: [],
    differentials: [],
    diagnoses: errorDiagnoses,
    redaction: {
      not_collected: [...notCollected, 'exception details and stack traces'],
      removed,
      truncated: [],
    },
    completeness: {
      control: 'not_observed',
      target: request.target ? 'skipped' : 'not_applicable',
      missing: ['runner internal terminalization'],
    },
  };
  if (!validateEvidenceBundle(bundle)) throw new Error('RUN_ERROR_BUILDER_FAILED');
  return deepFreeze(bundle);
};

const buildBundle = (
  request: DiagnosticRequest,
  ports: DiagnosticPorts,
  startedAt: string,
  startedMono: number,
  controlObservations: readonly Observation[],
  targetObservations: readonly Observation[],
  targetPolicy: Pick<Policy, 'target_decision' | 'reasons'>,
  extraDiagnoses: readonly Diagnosis[],
  collection: ExecutionCollectionMetadata,
  runStatus: NonErroredTerminalStatus,
  runDecision: Policy['run_decision'],
  runReasons: readonly string[],
  skipFaultInjection = false,
): EvidenceBundle => {
  if (!skipFaultInjection) ports.faults?.builder?.();
  assertTerminalObservations(controlObservations);
  assertTerminalObservations(targetObservations);
  const context = contextForEvidence(request.execution_context);
  const targetRequested = Boolean(request.target);
  const controlStatus =
    runStatus === 'cancelled' ? 'cancelled' : controlCompleteness(controlObservations);
  const targetStatus = targetCompleteness(
    targetObservations,
    targetPolicy.target_decision,
    runStatus,
  );
  const observations = [...controlObservations, ...targetObservations];
  const differentials = makeDifferentials(
    controlObservations,
    targetObservations,
    targetPolicy.target_decision,
  );
  const removedRedaction = [
    ...(collection.control_response_body_parsed
      ? ['raw Control response body after allowlisted parsing']
      : []),
    ...(collection.control_response_headers_read || collection.target_response_headers_read
      ? ['raw response headers outside the allowlist']
      : []),
    ...(collection.target_policy_input_evaluated
      ? ['target URL, hostname and query values after policy evaluation']
      : []),
    ...(collection.target_socket_address_verified
      ? ['transient approved-address verification data after socket validation']
      : []),
  ];
  const completedAt = ports.clock.now();
  const duration = Math.max(0, Math.round(ports.clock.monotonic_ms() - startedMono));
  const diagnoses = makeDiagnoses(
    request,
    controlObservations,
    targetObservations,
    context,
    extraDiagnoses,
    targetPolicy,
    differentials,
  );
  if (runStatus === 'cancelled' && !diagnoses.some(({ code }) => code === 'CONTROL_CANCELLED')) {
    diagnoses.push({
      code: 'CONTROL_CANCELLED',
      summary: 'The diagnostic run was cancelled before all checks completed.',
      evidence_refs: [],
      possible_layers: ['control_transport'],
      limitations: ['Cancellation may have occurred before a lane emitted an observation.'],
      suggested_next_steps: [],
    });
  }
  const bundle: EvidenceBundle = {
    schema_version: ports.versions.schema,
    bundle_id: ports.ids.next(),
    run_status: runStatus,
    outcome: outcomeFor(
      request,
      controlObservations,
      targetObservations,
      targetPolicy.target_decision,
      runStatus,
    ),
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: duration,
    runner: {
      cli_version: ports.versions.cli,
      core_version: ports.versions.core,
      control_profile_version: ports.versions.control_profile,
    },
    execution_context: context,
    intent: {
      transport: request.transport,
      profile_id: request.profile_id,
      has_target: targetRequested,
    },
    policy: {
      version: request.policy_version ?? (targetRequested ? 's3-target-policy' : 's1-no-network'),
      run_decision: runDecision,
      target_decision: targetRequested ? targetPolicy.target_decision : 'not_applicable',
      reasons: [...new Set([...runReasons, ...(targetRequested ? targetPolicy.reasons : [])])],
    },
    observations,
    differentials,
    diagnoses,
    redaction: {
      not_collected: [
        'non-allowlisted request header values',
        'authorization, cookie and proxy credentials',
        'request body',
        'full user-agent value',
      ],
      removed: removedRedaction,
      truncated: [],
    },
    completeness: {
      control: controlStatus,
      target: targetStatus,
      missing: [
        ...missingFromObservations(controlObservations),
        ...missingFromObservations(targetObservations),
      ],
    },
  };
  if (!validateEvidenceBundle(bundle)) {
    throw new Error(
      `Core produced an EvidenceBundle that fails the canonical schema: ${JSON.stringify(evidenceBundleValidationErrors())}`,
    );
  }
  return deepFreeze(bundle);
};

const policyResult = (ports: DiagnosticPorts, request: DiagnosticRequest): RunPolicyResult => {
  if (!ports.runPolicy) return { decision: 'allow' };
  const result = ports.runPolicy.evaluate(request);
  if (result instanceof Promise) throw new Error('RUN_POLICY_ASYNC_IN_SYNC');
  return result;
};

const stableRunPolicyReasons = new Set([
  'RUN_POLICY_REJECTED',
  'RUN_POLICY_INCOMPATIBLE',
  'RUN_POLICY_UNAVAILABLE',
]);

const safeRunPolicyReason = (value: unknown): string =>
  typeof value === 'string' && stableRunPolicyReasons.has(value) ? value : 'RUN_POLICY_REJECTED';

const rejectionPolicy = (request: DiagnosticRequest, reason: string) => ({
  target_decision: request.target ? ('skipped' as const) : ('not_applicable' as const),
  reasons: [reason],
});

const transitionSafely = (reducer: RunReducer, event: RunReducerEvent): void => {
  try {
    reducer.dispatch(event);
  } catch {
    // Terminalization still has an independent safe builder if a reducer fault
    // occurs while handling an already-failed path.
  }
};

const prepareReducerForFinalization = (reducer: RunReducer, status: TerminalRunStatus): void => {
  const phase = reducer.snapshot().phase;
  if (status === 'rejected') {
    return;
  }
  if (status === 'completed') {
    if (phase === 'created') transitionSafely(reducer, 'run_policy_allowed');
    if (reducer.snapshot().phase === 'run_policy_checked')
      transitionSafely(reducer, 'checks_started');
    if (reducer.snapshot().phase === 'running_checks') transitionSafely(reducer, 'checks_terminal');
    return;
  }
  if (status === 'cancelled') {
    if (phase === 'created') transitionSafely(reducer, 'run_policy_allowed');
    return;
  }
  if (phase !== 'errored' && phase !== 'cancelled' && phase !== 'rejected') {
    transitionSafely(reducer, 'fault');
    if (reducer.snapshot().phase === 'finalizing') transitionSafely(reducer, 'finalize_errored');
  }
};

const completeReducer = (reducer: RunReducer, status: TerminalRunStatus): void => {
  if (status === 'rejected') transitionSafely(reducer, 'run_policy_rejected');
  else if (status === 'completed') transitionSafely(reducer, 'finalize_completed');
  else if (status === 'cancelled') transitionSafely(reducer, 'finalize_cancelled');
};

export function finalizeRun(input: FinalizeRunInput): EvidenceBundle {
  const reducer = input.reducer ?? createRunReducer();
  prepareReducerForFinalization(reducer, input.status);
  const epoch = '1970-01-01T00:00:00.000Z';
  const startedAt = input.startedAt ?? safeClockNow(input.ports, epoch);
  const startedMono = input.startedMono ?? safeClockMono(input.ports, 0);
  const runDecision = input.runDecision ?? 'allowed';
  const runReasons = input.runReasons ?? [];
  try {
    switch (input.status) {
      case 'completed':
      case 'rejected':
      case 'cancelled': {
        const bundle = buildBundle(
          input.request,
          input.ports,
          startedAt,
          startedMono,
          input.controlObservations,
          input.targetObservations,
          input.targetPolicy,
          input.extraDiagnoses ?? [],
          input.collection ?? {},
          input.status,
          runDecision,
          runReasons,
        );
        completeReducer(reducer, input.status);
        return bundle;
      }
      case 'errored': {
        const bundle = buildErroredBundle(input);
        completeReducer(reducer, 'errored');
        return bundle;
      }
      default: {
        const exhaustive: never = input.status;
        throw new Error(`RUN_UNKNOWN_TERMINAL_STATUS_${String(exhaustive)}`);
      }
    }
  } catch {
    if (input.status === 'cancelled') {
      prepareReducerForFinalization(reducer, 'cancelled');
      let bundle: EvidenceBundle;
      try {
        bundle = buildBundle(
          input.request,
          input.ports,
          startedAt,
          startedMono,
          input.controlObservations,
          input.targetObservations,
          input.targetPolicy,
          input.extraDiagnoses ?? [],
          input.collection ?? {},
          'cancelled',
          runDecision,
          runReasons,
          true,
        );
      } catch {
        // Cancellation remains the terminal truth even if an in-flight lane
        // handed us a non-terminal observation or a malformed builder value.
        bundle = buildBundle(
          input.request,
          input.ports,
          startedAt,
          startedMono,
          [],
          [],
          input.request.target
            ? { target_decision: 'skipped', reasons: ['CONTROL_CANCELLED'] }
            : { target_decision: 'not_applicable', reasons: ['CONTROL_CANCELLED'] },
          [],
          {},
          'cancelled',
          runDecision,
          ['CONTROL_CANCELLED'],
          true,
        );
      }
      completeReducer(reducer, 'cancelled');
      return bundle;
    }
    prepareReducerForFinalization(reducer, 'errored');
    const bundle = buildErroredBundle({ ...input, status: 'errored' });
    completeReducer(reducer, 'errored');
    return bundle;
  }
}

export function runDiagnostic(request: DiagnosticRequest, ports: DiagnosticPorts): EvidenceBundle {
  const reducer = createRunReducer();
  let startedAt = '1970-01-01T00:00:00.000Z';
  let startedMono = 0;
  try {
    startedAt = ports.clock.now();
    startedMono = ports.clock.monotonic_ms();
    const policy = policyResult(ports, request);
    if (policy.decision === 'reject') {
      const reason = safeRunPolicyReason(policy.reason_code);
      return finalizeRun({
        request,
        ports,
        startedAt,
        startedMono,
        status: 'rejected',
        controlObservations: [],
        targetObservations: [],
        targetPolicy: rejectionPolicy(request, reason),
        runDecision: 'rejected',
        runReasons: [reason],
        reducer,
      });
    }
    transitionSafely(reducer, 'run_policy_allowed');
    transitionSafely(reducer, 'checks_started');
    const controlObservations = ports.fixture
      ? [...ports.fixture.control(request, startedAt)]
      : [observationForS1(startedAt)];
    const targetPolicy: Pick<Policy, 'target_decision' | 'reasons'> = request.target
      ? { target_decision: 'skipped', reasons: ['S1_NETWORK_NOT_IMPLEMENTED'] }
      : { target_decision: 'not_applicable', reasons: [] };
    transitionSafely(reducer, 'checks_terminal');
    ports.faults?.evaluation?.();
    return finalizeRun({
      request,
      ports,
      startedAt,
      startedMono,
      status: 'completed',
      controlObservations,
      targetObservations: [],
      targetPolicy,
      extraDiagnoses: ports.fixture?.diagnoses?.(request, controlObservations) ?? [],
      reducer,
    });
  } catch {
    return finalizeRun({
      request,
      ports,
      startedAt: startedAt ?? '1970-01-01T00:00:00.000Z',
      startedMono: startedMono ?? 0,
      status: 'errored',
      controlObservations: [],
      targetObservations: [],
      targetPolicy: request.target
        ? { target_decision: 'skipped', reasons: ['RUN_INTERNAL_ERROR'] }
        : { target_decision: 'not_applicable', reasons: ['RUN_INTERNAL_ERROR'] },
      reducer,
    });
  }
}

/** Async orchestration seals lifecycle timestamps before awaiting the Control/Target ports. */
export async function runDiagnosticAsync(
  request: DiagnosticRequest,
  ports: DiagnosticPorts,
  options: { readonly signal?: AbortSignal; readonly deadlineAt?: number } = {},
): Promise<EvidenceBundle> {
  const reducer = createRunReducer();
  const epoch = '1970-01-01T00:00:00.000Z';
  const startedAt = safeClockNow(ports, epoch);
  const startedMono = safeClockMono(ports, 0);
  const deadlineAt = options.deadlineAt ?? Date.now() + 20_000;
  const controller = new AbortController();
  const relayAbort = (): void => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', relayAbort, { once: true });
  const timer = setTimeout(relayAbort, Math.max(0, deadlineAt - Date.now()));
  let settledCollection: ExecutionCollectionMetadata = {};
  try {
    let policy: RunPolicyResult = { decision: 'allow' };
    try {
      if (ports.runPolicy) policy = await ports.runPolicy.evaluate(request);
      if (policy.decision === 'reject') {
        const reason = safeRunPolicyReason(policy.reason_code);
        return finalizeRun({
          request,
          ports,
          startedAt,
          startedMono,
          status: controller.signal.aborted ? 'cancelled' : 'rejected',
          controlObservations: [],
          targetObservations: [],
          targetPolicy: rejectionPolicy(request, reason),
          runDecision: controller.signal.aborted ? 'allowed' : 'rejected',
          runReasons: [reason],
          reducer,
        });
      }
      transitionSafely(reducer, 'run_policy_allowed');
      transitionSafely(reducer, 'checks_started');
    } catch {
      return finalizeRun({
        request,
        ports,
        startedAt,
        startedMono,
        status: controller.signal.aborted ? 'cancelled' : 'errored',
        controlObservations: [],
        targetObservations: [],
        targetPolicy: request.target
          ? { target_decision: 'skipped', reasons: ['RUN_INTERNAL_ERROR'] }
          : { target_decision: 'not_applicable', reasons: ['RUN_INTERNAL_ERROR'] },
        reducer,
      });
    }
    const runContext = { startedAt, startedMono, deadlineAt, signal: controller.signal };
    const controlPromise = ports.control
      ? Promise.resolve().then(() => ports.control!.execute(request, runContext))
      : Promise.resolve({
          observations: [observationForS1(startedAt)],
          collection: {},
          runStatus: 'completed' as const,
        });
    const targetPromise = request.target
      ? ports.target
        ? Promise.resolve().then(() => ports.target!.execute(request, runContext))
        : Promise.resolve({
            observations: [],
            policy: {
              target_decision: 'skipped' as const,
              reasons: ['S1_NETWORK_NOT_IMPLEMENTED'],
            },
            collection: {},
            runStatus: 'completed' as const,
          })
      : Promise.resolve({
          observations: [],
          policy: { target_decision: 'not_applicable' as const, reasons: [] },
          collection: {},
          runStatus: 'completed' as const,
        });
    const [controlSettled, targetSettled] = await Promise.allSettled([
      controlPromise,
      targetPromise,
    ]);
    transitionSafely(reducer, 'checks_terminal');
    const controlExecution =
      controlSettled.status === 'fulfilled'
        ? controlSettled.value
        : {
            observations: [
              executionFailureObservation(
                'control-self',
                'https',
                'control',
                startedAt,
                'CONTROL_EXECUTION_FAILED',
              ),
            ],
            collection: {},
            runStatus: 'completed' as const,
          };
    const targetExecution =
      targetSettled.status === 'fulfilled'
        ? targetSettled.value
        : {
            observations: [
              executionFailureObservation(
                'target-policy',
                request.transport,
                'policy',
                startedAt,
                'TARGET_EXECUTION_FAILED',
              ),
            ],
            policy: { target_decision: 'skipped' as const, reasons: ['TARGET_EXECUTION_FAILED'] },
            collection: {},
            runStatus: 'completed' as const,
          };
    settledCollection = {
      ...(controlSettled.status === 'fulfilled' ? controlSettled.value.collection : {}),
      ...(targetSettled.status === 'fulfilled' ? targetSettled.value.collection : {}),
    };
    if (
      !controller.signal.aborted &&
      (controlSettled.status === 'rejected' || targetSettled.status === 'rejected')
    ) {
      return finalizeRun({
        request,
        ports,
        startedAt,
        startedMono,
        status: 'errored',
        controlObservations: [],
        targetObservations: [],
        targetPolicy: request.target
          ? { target_decision: 'skipped', reasons: ['RUN_INTERNAL_ERROR'] }
          : { target_decision: 'not_applicable', reasons: ['RUN_INTERNAL_ERROR'] },
        collection: settledCollection,
        reducer,
      });
    }
    ports.faults?.evaluation?.();
    const runStatus: TerminalRunStatus =
      controller.signal.aborted ||
      controlExecution.runStatus === 'cancelled' ||
      targetExecution.runStatus === 'cancelled'
        ? 'cancelled'
        : 'completed';
    return finalizeRun({
      request,
      ports,
      startedAt,
      startedMono,
      status: runStatus,
      controlObservations: controlExecution.observations,
      targetObservations: targetExecution.observations,
      targetPolicy: targetExecution.policy,
      collection: {
        ...controlExecution.collection,
        ...targetExecution.collection,
      },
      reducer,
    });
  } catch {
    return finalizeRun({
      request,
      ports,
      startedAt,
      startedMono,
      status: controller.signal.aborted ? 'cancelled' : 'errored',
      controlObservations: [],
      targetObservations: [],
      targetPolicy: request.target
        ? { target_decision: 'skipped', reasons: ['RUN_INTERNAL_ERROR'] }
        : { target_decision: 'not_applicable', reasons: ['RUN_INTERNAL_ERROR'] },
      collection: settledCollection,
      reducer,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', relayAbort);
  }
}

export const emptyFixturePort: ObservationFixturePort = {
  control: (_request, startedAt) => [observationForS1(startedAt)],
};
