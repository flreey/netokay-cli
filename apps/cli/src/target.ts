import type { Observation } from '@netokay/contracts';
import type {
  ControlRunContext,
  DiagnosticRequest,
  TargetExecution,
  TargetPort,
} from '@netokay/core';
import {
  evaluateTargetPolicy,
  rawTargetScheme,
  type TargetPolicyOptions,
  type TargetPolicyDecision,
  type TargetResolver,
} from './target-policy.js';
import type { TransportExecutor, TransportResult } from './transport.js';

export interface TargetPortOptions {
  readonly executor: TransportExecutor;
  readonly resolver?: TargetResolver;
  readonly proxyConfigured: boolean;
}

const nowIso = (): string => new Date().toISOString();

const durationSince = (startedAt: string): number =>
  Math.max(0, Date.now() - new Date(startedAt).getTime());

const phaseDuration = (
  result: TransportResult,
  stage: 'dns' | 'tcp' | 'tls' | 'headers',
  fallback: number,
): number => Math.max(0, Math.round(result.phaseTimings?.[stage] ?? fallback));

const transportFor = (scheme: 'http' | 'https'): Observation['transport'] => scheme;

const limitation =
  'Full target URL, IP addresses, certificate chain and raw headers/body are not retained.';

const policyObservation = (
  decision: TargetPolicyDecision,
  startedAt: string,
  rawScheme: 'http' | 'https',
): Observation => {
  const scheme =
    decision.kind === 'allowed'
      ? decision.normalized.scheme
      : (decision.normalized?.scheme ?? rawScheme);
  if (decision.kind === 'blocked') {
    return {
      check_id: 'target-policy',
      scope: 'target',
      transport: transportFor(scheme),
      stage: 'policy',
      status: 'skipped',
      started_at: startedAt,
      duration_ms: durationSince(startedAt),
      result_code: 'TARGET_POLICY_BLOCKED',
      reason_code: 'TARGET_POLICY_BLOCKED',
      facts: { policy_reason: decision.safe_reason },
      limitations: [limitation],
      source: 'local_runner',
    };
  }
  return {
    check_id: 'target-policy',
    scope: 'target',
    transport: transportFor(decision.normalized.scheme),
    stage: 'policy',
    status: 'passed',
    started_at: startedAt,
    duration_ms: durationSince(startedAt),
    result_code: 'TARGET_POLICY_ALLOWED',
    facts: {
      address_count: decision.approved_ips.length,
      ip_families: [...decision.ip_families],
    },
    limitations: [limitation],
    source: 'local_runner',
  };
};

const dnsObservation = (
  decision: Extract<TargetPolicyDecision, { kind: 'allowed' }>,
  startedAt: string,
): Observation => ({
  check_id: 'target-dns',
  scope: 'target',
  transport: transportFor(decision.normalized.scheme),
  stage: 'dns',
  status: 'passed',
  started_at: startedAt,
  duration_ms: decision.dns_duration_ms,
  result_code: 'TARGET_DNS_PASSED',
  facts: {
    address_count: decision.approved_ips.length,
    ip_families: [...decision.ip_families],
  },
  limitations: [limitation],
  source: 'local_runner',
});

const blockedDnsObservation = (
  decision: Extract<TargetPolicyDecision, { kind: 'blocked' }>,
  startedAt: string,
  signal: AbortSignal,
  rawScheme: 'http' | 'https',
): Observation | null => {
  if (
    !decision.safe_reason.startsWith('target_dns_') &&
    decision.safe_reason !== 'target_cancelled'
  ) {
    return null;
  }
  const cancelled = signal.aborted;
  const resultCode =
    decision.safe_reason === 'target_cancelled'
      ? 'TARGET_CANCELLED'
      : decision.safe_reason === 'target_dns_too_many_addresses'
        ? 'TARGET_DNS_TOO_MANY_ADDRESSES'
        : decision.safe_reason === 'target_dns_forbidden_address'
          ? 'TARGET_DNS_FORBIDDEN_ADDRESS'
          : decision.safe_reason === 'target_dns_timeout'
            ? 'TARGET_DNS_TIMEOUT'
            : 'TARGET_DNS_FAILED';
  return {
    check_id: 'target-dns',
    scope: 'target',
    transport: decision.normalized?.scheme ?? rawScheme,
    stage: 'dns',
    status: cancelled ? 'cancelled' : 'failed',
    started_at: startedAt,
    duration_ms: decision.dns_duration_ms ?? durationSince(startedAt),
    result_code: cancelled ? 'TARGET_CANCELLED' : resultCode,
    reason_code: cancelled ? 'TARGET_CANCELLED' : resultCode,
    facts: {},
    limitations: [limitation],
    source: 'local_runner',
  };
};

const familyOf = (address: string | null | undefined): 'ipv4' | 'ipv6' | null => {
  if (!address) return null;
  if (address.includes(':')) return 'ipv6';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) return 'ipv4';
  return null;
};

const safeContentType = (headers: Headers): string | null => {
  const value = headers.get('content-type');
  if (!value) return null;
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9!#$&^_.+*-]+\/[a-z0-9!#$&^_.+*-]+$/.test(mediaType)
    ? mediaType.slice(0, 96)
    : null;
};

const phaseFailure = (
  decision: Extract<TargetPolicyDecision, { kind: 'allowed' }>,
  result: TransportResult,
  startedAt: string,
  signal: AbortSignal,
): Observation => {
  const stage: Observation['stage'] =
    result.failedStage === 'headers'
      ? 'headers'
      : result.failedStage === 'tls'
        ? 'tls'
        : result.failedStage === 'dns'
          ? 'dns'
          : 'tcp';
  const cancelled = result.phase === 'cancelled' || signal.aborted;
  const reasonCode = cancelled
    ? 'TARGET_CANCELLED'
    : result.errorCode === 'TARGET_UNEXPECTED_BODY'
      ? 'TARGET_UNEXPECTED_BODY'
      : result.phase === 'timeout'
        ? 'TARGET_TIMEOUT'
        : stage === 'headers'
          ? 'TARGET_HEADERS_FAILED'
          : stage === 'tls'
            ? 'TARGET_TLS_FAILED'
            : stage === 'dns'
              ? 'TARGET_DNS_FAILED'
              : 'TARGET_TCP_FAILED';
  return {
    check_id: `target-${stage}`,
    scope: 'target',
    transport: transportFor(decision.normalized.scheme),
    stage,
    status: cancelled ? 'cancelled' : result.phase === 'timeout' ? 'incomplete' : 'failed',
    started_at: startedAt,
    duration_ms: phaseDuration(result, stage, durationSince(startedAt)),
    result_code: reasonCode,
    reason_code: reasonCode,
    facts: {
      attempt_count: result.attemptCount ?? 0,
      phase_timings_ms: result.phaseTimings ?? {},
      ...(result.errorCode === 'TARGET_UNEXPECTED_BODY' ? { body_observed: true } : {}),
    },
    limitations: [limitation],
    source: 'local_runner',
  };
};

const successObservations = (
  decision: Extract<TargetPolicyDecision, { kind: 'allowed' }>,
  result: TransportResult,
  startedAt: string,
): Observation[] => {
  const observations: Observation[] = [
    {
      check_id: 'target-tcp',
      scope: 'target',
      transport: transportFor(decision.normalized.scheme),
      stage: 'tcp',
      status: 'passed',
      started_at: startedAt,
      duration_ms: phaseDuration(result, 'tcp', durationSince(startedAt)),
      result_code: 'TARGET_TCP_PASSED',
      facts: {
        attempt_count: result.attemptCount ?? 0,
        address_count: decision.approved_ips.length,
        ip_family: familyOf(result.remoteAddress),
        phase_timings_ms: result.phaseTimings ?? {},
      },
      limitations: [limitation],
      source: 'local_runner',
    },
  ];
  if (decision.normalized.scheme === 'https') {
    observations.push({
      check_id: 'target-tls',
      scope: 'target',
      transport: 'https',
      stage: 'tls',
      status: result.authorized === false ? 'failed' : 'passed',
      started_at: startedAt,
      duration_ms: phaseDuration(result, 'tls', durationSince(startedAt)),
      result_code: result.authorized === false ? 'TARGET_TLS_FAILED' : 'TARGET_TLS_PASSED',
      ...(result.authorized === false ? { reason_code: 'TARGET_TLS_FAILED' } : {}),
      facts: {
        attempt_count: result.attemptCount ?? 0,
        phase_timings_ms: result.phaseTimings ?? {},
        tls_protocol: result.tlsProtocol ?? null,
        alpn_protocol: result.alpnProtocol ?? null,
        authorized: result.authorized ?? false,
      },
      limitations: [limitation],
      source: 'local_runner',
    });
  }
  observations.push({
    check_id: 'target-headers',
    scope: 'target',
    transport: transportFor(decision.normalized.scheme),
    stage: 'headers',
    status: 'passed',
    started_at: startedAt,
    duration_ms: phaseDuration(result, 'headers', durationSince(startedAt)),
    result_code: 'TARGET_HEADERS_PASSED',
    facts: {
      attempt_count: result.attemptCount ?? 0,
      phase_timings_ms: result.phaseTimings ?? {},
      status: result.statusCode,
      status_class: result.statusCode === null ? null : Math.floor(result.statusCode / 100),
      content_type: safeContentType(result.headers),
      location_present: result.headers.has('location'),
      redirect_present:
        result.statusCode !== null && result.statusCode >= 300 && result.statusCode < 400,
      body_observed: result.bodyObserved ?? false,
    },
    limitations: [limitation],
    source: 'local_runner',
  });
  return observations;
};

const makeTargetUrl = (decision: Extract<TargetPolicyDecision, { kind: 'allowed' }>): URL => {
  const host = decision.normalized.hostname.includes(':')
    ? `[${decision.normalized.hostname}]`
    : decision.normalized.hostname;
  return new URL(`${decision.normalized.protocol}//${host}${decision.normalized.path}`);
};

export const createTargetPort = (options: TargetPortOptions): TargetPort => ({
  execute: async (
    request: DiagnosticRequest,
    context: ControlRunContext,
  ): Promise<TargetExecution> => {
    const startedAt = context.startedAt || nowIso();
    const policyOptions: TargetPolicyOptions = {
      resolver: options.resolver,
      proxy_configured: options.proxyConfigured,
      signal: context.signal,
      deadlineAt: Math.min(context.deadlineAt, Date.now() + 3_000),
    };
    const decision = await evaluateTargetPolicy(request.target ?? '', policyOptions);
    const rawScheme = rawTargetScheme(request.target ?? '');
    const policyCollection = { target_policy_input_evaluated: true as const };
    const observations = [policyObservation(decision, startedAt, rawScheme)];
    if (
      context.signal.aborted &&
      decision.kind === 'blocked' &&
      (decision.safe_reason.startsWith('target_dns_') ||
        decision.safe_reason === 'target_cancelled')
    ) {
      observations[0] = {
        ...observations[0],
        status: 'cancelled',
        result_code: 'TARGET_CANCELLED',
        reason_code: 'TARGET_CANCELLED',
      };
      const dnsFailure = blockedDnsObservation(decision, startedAt, context.signal, rawScheme);
      if (dnsFailure) observations.push(dnsFailure);
      return {
        observations,
        policy: { target_decision: 'skipped', reasons: ['TARGET_CANCELLED'] },
        collection: policyCollection,
        runStatus: 'cancelled',
      };
    }
    if (context.signal.aborted) {
      observations[0] = {
        ...observations[0],
        status: 'cancelled',
        result_code: 'TARGET_CANCELLED',
        reason_code: 'TARGET_CANCELLED',
      };
      return {
        observations,
        policy: { target_decision: 'skipped', reasons: ['TARGET_CANCELLED'] },
        collection: policyCollection,
        runStatus: 'cancelled',
      };
    }
    if (decision.kind === 'blocked') {
      const dnsFailure = blockedDnsObservation(decision, startedAt, context.signal, rawScheme);
      if (dnsFailure) observations.push(dnsFailure);
      return {
        observations,
        policy: {
          target_decision: 'skipped',
          reasons: ['TARGET_POLICY_BLOCKED', decision.safe_reason],
        },
        collection: policyCollection,
      };
    }
    observations.push(dnsObservation(decision, startedAt));
    const result = await options.executor.request(makeTargetUrl(decision), {
      method: 'HEAD',
      approvedAddresses: decision.approved_ips,
      serverName: decision.normalized.hostname,
      readBody: false,
      deadlineAt: Math.min(context.deadlineAt, Date.now() + 10_000),
      signal: context.signal,
    });
    if (result.phase === 'response_complete') {
      observations.push(...successObservations(decision, result, startedAt));
    } else {
      observations.push(phaseFailure(decision, result, startedAt, context.signal));
    }
    return {
      observations,
      policy: { target_decision: 'allowed', reasons: [] },
      collection: {
        ...policyCollection,
        ...(result.statusCode !== null ? { target_response_headers_read: true } : {}),
        ...(result.remoteAddress !== null ? { target_socket_address_verified: true } : {}),
      },
      runStatus: context.signal.aborted || result.phase === 'cancelled' ? 'cancelled' : 'completed',
    };
  },
});
