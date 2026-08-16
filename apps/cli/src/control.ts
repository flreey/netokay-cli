import { type ControlEchoResponse, type ControlSelfResponse } from '@netokay/contracts';
import type { Observation } from '@netokay/contracts';

export const CONTROL_API_MAJOR = 1 as const;
export const CONTROL_PROFILE_MAJOR = 1 as const;
export const CONTROL_SCHEMA_MAJOR = 1 as const;
export const REQUIRED_CONTROL_CAPABILITIES = ['control.self', 'control.echo'] as const;

type RecordValue = Record<string, unknown>;

export interface ControlCompatibility {
  readonly compatible: boolean;
  readonly reasonCode?: 'CONTROL_PROFILE_INCOMPATIBLE';
  readonly message?: string;
}

export interface ControlReadSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export interface ControlReadFailure {
  readonly ok: false;
  readonly reasonCode: 'CONTROL_PROFILE_INCOMPATIBLE' | 'CONTROL_RESPONSE_MALFORMED';
  readonly message: string;
}

export type ControlReadResult<T> = ControlReadSuccess<T> | ControlReadFailure;

const incompatible = (message: string): ControlCompatibility => ({
  compatible: false,
  reasonCode: 'CONTROL_PROFILE_INCOMPATIBLE',
  message,
});

const major = (value: unknown, pattern: RegExp): number | null => {
  if (typeof value !== 'string') return null;
  const match = pattern.exec(value);
  return match ? Number(match[1]) : null;
};

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const has = (value: RecordValue, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const SELF_MISSING_FIELDS = [
  'ip_family',
  'country',
  'asn',
  'colo',
  'http_protocol',
  'tls_version',
  'client_tcp_rtt_ms',
] as const;

const boundedVersion = (value: unknown, pattern: RegExp, maxLength: number): value is string =>
  typeof value === 'string' &&
  value.length >= 3 &&
  value.length <= maxLength &&
  pattern.test(value);

const capabilityName = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 64 &&
  /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/.test(value);

const nullableString = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === 'string' && new TextEncoder().encode(value).byteLength <= 128);

const nonNegativeInteger = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

const observedAt = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);

const requestId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 128 &&
  /^[A-Za-z0-9._:-]+$/.test(value);

const nullableEnum = <T extends string>(values: readonly T[], value: unknown): value is T | null =>
  value === null || (typeof value === 'string' && values.includes(value as T));

const nullableSafeShortString = (
  pattern: RegExp,
  maxLength: number,
  value: unknown,
): value is string | null =>
  value === null ||
  (typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    pattern.test(value));

const handshakeShape = (value: unknown): value is RecordValue => {
  if (!isRecord(value)) return false;
  if (
    !has(value, 'api_version') ||
    !has(value, 'control_profile_version') ||
    !has(value, 'schema_version') ||
    !has(value, 'capabilities')
  )
    return false;
  return (
    boundedVersion(value.api_version, /^\d+\.[0-9]+$/, 16) &&
    boundedVersion(value.control_profile_version, /^\d+\.[0-9]+(?:\.[0-9]+)?$/, 24) &&
    boundedVersion(value.schema_version, /^\d+\.[0-9]+$/, 16) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length > 0 &&
    value.capabilities.length <= 16 &&
    Array.from(value.capabilities).every(capabilityName) &&
    value.capabilities.join('').length <= 512
  );
};

const commonShape = (value: unknown): value is RecordValue =>
  handshakeShape(value) &&
  has(value, 'observed_at') &&
  has(value, 'request_id') &&
  observedAt(value.observed_at) &&
  requestId(value.request_id);

export const assessControlCompatibility = (value: unknown): ControlCompatibility => {
  if (!handshakeShape(value)) {
    return incompatible('Control response is missing required handshake fields.');
  }
  const body = value;
  if (major(body.api_version, /^(\d+)\.[0-9]+$/) !== CONTROL_API_MAJOR) {
    return incompatible('Control API major version is not supported.');
  }
  if (
    major(body.control_profile_version, /^(\d+)\.[0-9]+(?:\.[0-9]+)?$/) !== CONTROL_PROFILE_MAJOR
  ) {
    return incompatible('Control Profile major version is not supported.');
  }
  if (major(body.schema_version, /^(\d+)\.[0-9]+$/) !== CONTROL_SCHEMA_MAJOR) {
    return incompatible('Control schema major version is not supported.');
  }
  const capabilities = body.capabilities as unknown[];
  if (!REQUIRED_CONTROL_CAPABILITIES.every((capability) => capabilities.includes(capability))) {
    return incompatible('Required Control capabilities are missing.');
  }
  return { compatible: true };
};

const malformed = (message: string): ControlReadFailure => ({
  ok: false,
  reasonCode: 'CONTROL_RESPONSE_MALFORMED',
  message,
});

/** Endpoint-aware reader: required current fields are checked, future optional fields are ignored. */
export const readControlSelfResponse = (value: unknown): ControlReadResult<ControlSelfResponse> => {
  if (!commonShape(value))
    return malformed('Control self response is missing required common fields.');
  const body = value;
  if (
    !has(body, 'ip_family') ||
    !has(body, 'country') ||
    !has(body, 'asn') ||
    !has(body, 'colo') ||
    !has(body, 'http_protocol') ||
    !has(body, 'tls_version') ||
    !has(body, 'client_tcp_rtt_ms') ||
    !has(body, 'missing_fields') ||
    !nullableEnum(['ipv4', 'ipv6'] as const, body.ip_family) ||
    !nullableSafeShortString(/^[A-Za-z]{2}$/, 2, body.country) ||
    !nonNegativeInteger(body.asn) ||
    !nullableSafeShortString(/^[A-Za-z0-9_-]+$/, 32, body.colo) ||
    !nullableEnum(['HTTP/1.0', 'HTTP/1.1', 'HTTP/2', 'HTTP/3'] as const, body.http_protocol) ||
    !nullableEnum(['TLSv1.2', 'TLSv1.3'] as const, body.tls_version) ||
    !nonNegativeInteger(body.client_tcp_rtt_ms) ||
    !Array.isArray(body.missing_fields) ||
    body.missing_fields.length > SELF_MISSING_FIELDS.length ||
    new Set(body.missing_fields).size !== body.missing_fields.length ||
    !Array.from(body.missing_fields).every((field) =>
      (SELF_MISSING_FIELDS as readonly string[]).includes(field as string),
    )
  ) {
    return malformed('Control self response is missing or has malformed endpoint fields.');
  }
  return { ok: true, value: body as ControlSelfResponse };
};

export const readControlEchoResponse = (value: unknown): ControlReadResult<ControlEchoResponse> => {
  if (!commonShape(value))
    return malformed('Control echo response is missing required common fields.');
  const body = value;
  if (
    body.method !== 'GET' ||
    !has(body, 'x_netokay_run_id') ||
    !has(body, 'x_netokay_challenge') ||
    !has(body, 'x_netokay_client_version') ||
    !has(body, 'user_agent_class') ||
    !nullableString(body.x_netokay_run_id) ||
    !nullableString(body.x_netokay_challenge) ||
    !nullableString(body.x_netokay_client_version) ||
    !['none', 'browser', 'node', 'curl', 'agent', 'other'].includes(body.user_agent_class as string)
  ) {
    return malformed('Control echo response is missing or has malformed endpoint fields.');
  }
  return { ok: true, value: body as ControlEchoResponse };
};

const safeFact = (value: unknown): string | number | null =>
  typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))
    ? value
    : null;

export interface ControlObservationContext {
  readonly source?: Observation['source'];
  readonly environment?: string;
  readonly actualScheme?: string;
}

const contextDefaults = (context: ControlObservationContext = {}) => ({
  source: context.source ?? 'local_runner',
  environment: context.environment ?? 'local_loopback_harness',
  actualScheme: context.actualScheme ?? 'http',
});

const transportFor = (actualScheme: string): Observation['transport'] =>
  actualScheme === 'https' ? 'https' : 'http';

const limitationsFor = (actualScheme: string, environment: string): string[] =>
  actualScheme === 'https'
    ? environment === 'cloudflare_public_unverified'
      ? [
          'Agent internal runtime remains not observed.',
          'Public Control trust, TLS authorization or Edge self evidence was not proven.',
          'Cloudflare Edge was not observed for public Control.',
        ]
      : environment === 'cloudflare_public_edge'
        ? [
            'Agent internal runtime remains not observed.',
            'TLS was observed and certificate verification was performed for public Control.',
            'Cloudflare Edge was observed for public Control.',
          ]
        : environment === 'cloudflare_preview_unverified'
          ? [
              'Agent internal runtime remains not observed.',
              'Preview Control trust, TLS authorization or Edge self evidence was not proven.',
              'Cloudflare Edge was not observed for the Preview smoke.',
            ]
          : environment === 'cloudflare_edge'
            ? [
                'Agent internal runtime remains not observed.',
                'TLS was observed and certificate verification was performed for the Preview Edge.',
                'Cloudflare Edge was observed for the Preview smoke.',
              ]
            : [
                'Agent internal runtime remains not observed.',
                'TLS was observed and certificate verification was performed for the local loopback harness.',
                'Cloudflare Edge was not observed for the local loopback harness.',
              ]
    : [
        'Agent internal runtime remains not observed.',
        `Actual Control scheme observed by this runner: ${actualScheme}.`,
        'TLS and Cloudflare Edge were not observed for the local loopback harness.',
      ];

export const selfObservation = (
  body: ControlSelfResponse,
  startedAt: string,
  durationMs: number,
  context: ControlObservationContext = {},
): Observation => {
  const { source, environment, actualScheme } = contextDefaults(context);
  return {
    check_id: 'control-self',
    scope: 'control',
    transport: transportFor(actualScheme),
    stage: 'control',
    status: 'passed',
    started_at: startedAt,
    duration_ms: durationMs,
    result_code: 'CONTROL_SELF_PASSED',
    facts: {
      api_version: body.api_version,
      control_profile_version: body.control_profile_version,
      schema_version: body.schema_version,
      capabilities: [...body.capabilities],
      control_environment: environment,
      actual_scheme: actualScheme,
      ip_family: safeFact(body.ip_family),
      country: safeFact(body.country),
      asn: safeFact(body.asn),
      colo: safeFact(body.colo),
      http_protocol: safeFact(body.http_protocol),
      tls_version: safeFact(body.tls_version),
      client_tcp_rtt_ms: safeFact(body.client_tcp_rtt_ms),
      missing_fields: [...body.missing_fields],
    },
    limitations: limitationsFor(actualScheme, environment),
    source,
    ...(body.colo ? { colo: body.colo } : {}),
  };
};

export const echoObservation = (
  body: ControlEchoResponse,
  startedAt: string,
  durationMs: number,
  context: ControlObservationContext = {},
): Observation => {
  const { source, environment, actualScheme } = contextDefaults(context);
  return {
    check_id: 'control-echo',
    scope: 'control',
    transport: transportFor(actualScheme),
    stage: 'headers',
    status: 'passed',
    started_at: startedAt,
    duration_ms: durationMs,
    result_code: 'CONTROL_ECHO_PASSED',
    facts: {
      method: body.method,
      x_netokay_run_id: safeFact(body.x_netokay_run_id),
      x_netokay_challenge: safeFact(body.x_netokay_challenge),
      x_netokay_client_version: safeFact(body.x_netokay_client_version),
      user_agent_class: body.user_agent_class,
      control_environment: environment,
      actual_scheme: actualScheme,
    },
    limitations: limitationsFor(actualScheme, environment),
    source,
  };
};

export const failedControlObservation = (
  checkId: 'control-self' | 'control-echo',
  status: 'failed' | 'incomplete' | 'cancelled',
  resultCode: string,
  reasonCode: string,
  startedAt: string,
  durationMs: number,
  context: ControlObservationContext = {},
  facts: Record<string, unknown> = {},
): Observation => {
  const { source, environment, actualScheme } = contextDefaults(context);
  return {
    check_id: checkId,
    scope: 'control',
    transport: transportFor(actualScheme),
    stage: checkId === 'control-echo' ? 'headers' : 'control',
    status,
    started_at: startedAt,
    duration_ms: durationMs,
    result_code: resultCode,
    reason_code: reasonCode,
    facts: { ...facts, control_environment: environment, actual_scheme: actualScheme },
    limitations:
      actualScheme === 'https'
        ? environment === 'cloudflare_public_unverified'
          ? [
              'A trusted Control response was not available for this check.',
              'Public Control trust, TLS authorization or Edge self evidence was not proven.',
              'Cloudflare Edge was not observed for public Control.',
            ]
          : environment === 'cloudflare_public_edge'
            ? [
                'A trusted Control response was not available for this check.',
                'TLS was attempted with default certificate verification for public Control.',
                'Cloudflare Edge was observed for public Control.',
              ]
            : environment === 'cloudflare_preview_unverified'
              ? [
                  'A trusted Control response was not available for this check.',
                  'Preview Control trust, TLS authorization or Edge self evidence was not proven.',
                  'Cloudflare Edge was not observed for the Preview smoke.',
                ]
              : environment === 'cloudflare_edge'
                ? [
                    'A trusted Control response was not available for this check.',
                    'TLS was attempted with default certificate verification for the Preview Edge.',
                    'Cloudflare Edge was observed for the Preview smoke.',
                  ]
                : [
                    'A trusted Control response was not available for this check.',
                    'TLS was attempted with default certificate verification for the local loopback harness.',
                    'Cloudflare Edge was not observed for the local loopback harness.',
                  ]
        : [
            'A trusted Control response was not available for this check.',
            `Actual Control scheme attempted by this runner: ${actualScheme}.`,
            'TLS and Cloudflare Edge were not observed for the local loopback harness.',
          ],
    source,
  };
};
