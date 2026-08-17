import { Resolver } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import {
  isTransparentProxyAddress,
  type NetworkRoute,
  type NetworkRouteResolver,
} from './network-route.js';

export interface TargetResolver {
  readonly resolve: (
    hostname: string,
    options?: { readonly signal?: AbortSignal; readonly deadlineAt?: number },
  ) => Promise<readonly string[]>;
}

export interface NormalizedTarget {
  readonly scheme: 'http' | 'https';
  readonly protocol: 'http:' | 'https:';
  readonly hostname: string;
  readonly origin: string;
  readonly path: string;
  readonly port: 80 | 443;
}

export type TargetPolicySafeReason =
  | 'invalid_target'
  | 'target_host_forbidden'
  | 'destination_ip_not_observed'
  | 'target_dns_failed'
  | 'target_dns_timeout'
  | 'target_cancelled'
  | 'target_dns_forbidden_address'
  | 'target_dns_too_many_addresses';

export interface TargetPolicyBlocked {
  readonly kind: 'blocked';
  readonly reason_code: 'TARGET_POLICY_BLOCKED';
  readonly safe_reason: TargetPolicySafeReason;
  readonly normalized?: NormalizedTarget;
  readonly dns_duration_ms?: number;
}

export interface TargetPolicyAllowed {
  readonly kind: 'allowed';
  readonly normalized: NormalizedTarget;
  readonly approved_ips: readonly string[];
  readonly ip_families: readonly ('ipv4' | 'ipv6')[];
  readonly dns_duration_ms: number;
  readonly route?: NetworkRoute;
}

export type TargetPolicyDecision = TargetPolicyAllowed | TargetPolicyBlocked;

export interface TargetPolicyOptions {
  readonly resolver?: TargetResolver;
  readonly routeResolver?: NetworkRouteResolver;
  readonly route?: NetworkRoute;
  /** @deprecated retained as a test seam; proxy routes are no longer blocked. */
  readonly proxy_configured?: boolean;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}

export type NormalizedTargetResult =
  | { readonly ok: true; readonly value: NormalizedTarget }
  | { readonly ok: false; readonly reason: TargetPolicySafeReason };

const MAX_DNS_ANSWER_ADDRESSES = 64;
const MAX_APPROVED_ADDRESSES = 8;

/** Safely preserves a canonical raw HTTP intent without trusting WHATWG rewrites. */
export const rawTargetScheme = (value: string): 'http' | 'https' =>
  /^(http|https):\/\//i.test(value) && value.slice(0, 5).toLowerCase() === 'http:'
    ? 'http'
    : 'https';

const DEFAULT_RESOLVER: TargetResolver = {
  resolve: async (hostname, options = {}) => {
    const resolver = new Resolver();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failureCode: 'TARGET_DNS_TIMEOUT' | 'TARGET_CANCELLED' | undefined;
    const cancel = (code: 'TARGET_DNS_TIMEOUT' | 'TARGET_CANCELLED'): void => {
      failureCode ??= code;
      resolver.cancel();
    };
    const onAbort = (): void => cancel('TARGET_CANCELLED');
    if (options.signal?.aborted) throw new Error('TARGET_CANCELLED');
    if (options.deadlineAt !== undefined) {
      const remaining = options.deadlineAt - Date.now();
      if (remaining <= 0) throw new Error('TARGET_DNS_TIMEOUT');
      timer = setTimeout(() => cancel('TARGET_DNS_TIMEOUT'), remaining);
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const results = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    const addresses: string[] = [];
    let failure: unknown;
    for (const result of results) {
      if (result.status === 'fulfilled') addresses.push(...result.value);
      else if (!isNoRecordsError(result.reason)) failure ??= result.reason;
    }
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    if (failureCode) throw new Error(failureCode);
    if (failure !== undefined) throw failure;
    return addresses;
  },
};

const isNoRecordsError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === 'ENODATA' || code === 'ENOTFOUND';
};

const resolveWithBudget = async (
  resolver: TargetResolver,
  hostname: string,
  options: Pick<TargetPolicyOptions, 'signal' | 'deadlineAt'>,
): Promise<readonly string[]> => {
  const remaining = options.deadlineAt === undefined ? undefined : options.deadlineAt - Date.now();
  if (remaining !== undefined && remaining <= 0) throw new Error('TARGET_DNS_TIMEOUT');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const resolution = resolver.resolve(hostname, options);
    const timeout =
      remaining === undefined
        ? undefined
        : new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('TARGET_DNS_TIMEOUT')), remaining);
          });
    const cancellation = options.signal
      ? new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(new Error('TARGET_CANCELLED'));
          if (options.signal?.aborted) abortListener();
          else options.signal?.addEventListener('abort', abortListener, { once: true });
        })
      : undefined;
    return await Promise.race(
      [resolution, timeout, cancellation].filter(Boolean) as Promise<readonly string[]>[],
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener) options.signal?.removeEventListener('abort', abortListener);
  }
};

const hostWithoutBrackets = (hostname: string): string =>
  hostname.replace(/^\[|\]$/g, '').toLowerCase();

const specialUseHost = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname === 'localhost.localdomain' ||
  hostname === 'broadcasthost' ||
  hostname.endsWith('.localhost') ||
  hostname.endsWith('.local') ||
  hostname.endsWith('.test') ||
  hostname.endsWith('.invalid') ||
  hostname.endsWith('.example') ||
  hostname.endsWith('.onion') ||
  hostname.endsWith('.internal') ||
  hostname.endsWith('.intranet') ||
  hostname.endsWith('.lan') ||
  hostname.endsWith('.arpa') ||
  hostname.endsWith('.home.arpa') ||
  hostname === 'metadata.google.internal' ||
  hostname === 'metadata.google' ||
  hostname === 'instance-data.ec2.internal';

const validDnsName = (hostname: string): boolean => {
  if (hostname.length === 0 || hostname.length > 253 || specialUseHost(hostname)) return false;
  const labels = hostname.split('.');
  if (labels.length < 2) return false;
  return labels.every(
    (label) =>
      label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
};

interface RawAuthorityHost {
  readonly value: string;
  readonly bracketed: boolean;
}

const rawAuthorityHost = (value: string): RawAuthorityHost | null => {
  // Parse the authority before WHATWG URL normalization. Backslashes and
  // percent-encoded authority bytes can otherwise be rewritten into a
  // different host before policy sees them.
  if (value.includes('\\')) return null;
  const match = /^(?:http|https):\/\/([^/?#]*)(?:[/?#]|$)/i.exec(value);
  if (!match) return null;
  const authority = match[1]!;
  if (authority.length === 0 || authority.includes('%') || authority.includes('@')) return null;
  const hostPort = authority;
  if (hostPort.startsWith('[')) {
    const closing = hostPort.indexOf(']');
    if (closing < 0) return null;
    const remainder = hostPort.slice(closing + 1);
    if (remainder !== '' && !/^:\d+$/.test(remainder)) return null;
    return { value: hostPort.slice(1, closing), bracketed: true };
  }
  const colon = hostPort.lastIndexOf(':');
  if (colon >= 0 && hostPort.indexOf(':') === colon && /^\d+$/.test(hostPort.slice(colon + 1))) {
    return { value: hostPort.slice(0, colon), bracketed: false };
  }
  if (hostPort.includes(':') || hostPort.includes('[') || hostPort.includes(']')) return null;
  return { value: hostPort, bracketed: false };
};

const rawHostIsUnambiguous = (raw: RawAuthorityHost): boolean => {
  if (raw.bracketed) {
    if (!raw.value.includes(':') || !ipaddr.isValid(raw.value)) return false;
    const parsed = ipaddr.parse(raw.value);
    return !(parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress());
  }
  if (/^(?:0x[0-9a-f]+|0[0-9]+|[0-9]+)$/i.test(raw.value)) return false;
  if (raw.value.endsWith('.') && /^\d+(?:\.\d+){3}$/.test(raw.value.slice(0, -1))) return false;
  const labels = raw.value.split('.');
  if (labels.some((label) => /^0x/i.test(label))) return false;
  if (labels.every((label) => /^\d+$/.test(label))) {
    return (
      labels.length === 4 &&
      labels.every(
        (label) => /^(?:0|[1-9]\d*)$/.test(label) && Number(label) >= 0 && Number(label) <= 255,
      )
    );
  }
  return true;
};

const isPublicAddress = (
  value: string,
): { readonly address: string; readonly family: 'ipv4' | 'ipv6' } | null => {
  if (!ipaddr.isValid(value)) return null;
  const parsed = ipaddr.parse(value);
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) return null;
  if (parsed.range() !== 'unicast' || isIanaSpecialPurposeAddress(parsed)) return null;
  return {
    address: parsed.toString(),
    family: parsed.kind(),
  };
};

/**
 * Versioned, offline snapshot of the IANA Special-Purpose Address Registries
 * (Last Updated 2025-10-09).  The registry explicitly says these prefixes are
 * not guaranteed to be globally routable, so TargetPolicy fails closed even
 * where ipaddr.js does not yet classify a newer allocation.
 *
 * Sources:
 * https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml
 * https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml
 */
const IANA_SPECIAL_PURPOSE_PREFIXES = [
  // IPv4 registry entries.
  '0.0.0.0/8',
  '0.0.0.0/32',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.0.0/29',
  '192.0.0.8/32',
  '192.0.0.9/32',
  '192.0.0.10/32',
  '192.0.0.170/32',
  '192.0.0.171/32',
  '192.0.2.0/24',
  '192.31.196.0/24',
  '192.52.193.0/24',
  '192.88.99.0/24',
  '192.88.99.2/32',
  '192.168.0.0/16',
  '192.175.48.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '240.0.0.0/4',
  '255.255.255.255/32',
  // IPv6 registry entries.
  '::1/128',
  '::/128',
  '::ffff:0:0/96',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '100::/64',
  '100:0:0:1::/64',
  '2001::/23',
  '2001::/32',
  '2001:1::1/128',
  '2001:1::2/128',
  '2001:1::3/128',
  '2001:2::/48',
  '2001:3::/32',
  '2001:4:112::/48',
  '2001:10::/28',
  '2001:20::/28',
  '2001:30::/28',
  '2001:db8::/32',
  '2002::/16',
  '2620:4f:8000::/48',
  '3fff::/20',
  '5f00::/16',
  'fc00::/7',
  'fe80::/10',
] as const;

const IANA_SPECIAL_PURPOSE_RANGES = IANA_SPECIAL_PURPOSE_PREFIXES.map((prefix) =>
  ipaddr.parseCIDR(prefix),
);

const isIanaSpecialPurposeAddress = (address: ipaddr.IPv4 | ipaddr.IPv6): boolean =>
  IANA_SPECIAL_PURPOSE_RANGES.some(
    ([network, bits]) => address.kind() === network.kind() && address.match(network, bits),
  );

export const normalizeTargetUrl = (value: string): NormalizedTargetResult => {
  try {
    const rawHost = rawAuthorityHost(value);
    if (!rawHost || !rawHostIsUnambiguous(rawHost)) {
      return { ok: false, reason: 'invalid_target' };
    }
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return { ok: false, reason: 'invalid_target' };
    }
    const scheme = url.protocol === 'http:' ? 'http' : 'https';
    const expectedPort = scheme === 'http' ? 80 : 443;
    if (url.port !== '' && Number(url.port) !== expectedPort) {
      return { ok: false, reason: 'invalid_target' };
    }
    const hostname = hostWithoutBrackets(url.hostname);
    const literal = ipaddr.isValid(hostname);
    if (!literal && !validDnsName(hostname)) {
      return { ok: false, reason: 'target_host_forbidden' };
    }
    const originHost = hostname.includes(':') ? `[${hostname}]` : hostname;
    return {
      ok: true,
      value: {
        scheme,
        protocol: url.protocol,
        hostname,
        origin: `${url.protocol}//${originHost}`,
        path: `${url.pathname}${url.search}`,
        port: expectedPort,
      },
    };
  } catch {
    return { ok: false, reason: 'invalid_target' };
  }
};

const blocked = (
  safeReason: TargetPolicySafeReason,
  normalized?: NormalizedTarget,
  dnsDurationMs?: number,
): TargetPolicyBlocked => ({
  kind: 'blocked',
  reason_code: 'TARGET_POLICY_BLOCKED',
  safe_reason: safeReason,
  ...(normalized ? { normalized } : {}),
  ...(dnsDurationMs === undefined ? {} : { dns_duration_ms: dnsDurationMs }),
});

export const evaluateTargetPolicy = async (
  value: string,
  options: TargetPolicyOptions = {},
): Promise<TargetPolicyDecision> => {
  const normalizedResult = normalizeTargetUrl(value);
  if (!normalizedResult.ok) return blocked(normalizedResult.reason);
  const normalized = normalizedResult.value;
  if (options.signal?.aborted) return blocked('target_cancelled', normalized);
  if (options.deadlineAt !== undefined && options.deadlineAt <= Date.now()) {
    return blocked('target_dns_timeout', normalized);
  }

  // Route selection is performed before DNS so a proxy route never performs a
  // local lookup that could be mistaken for the destination address. The
  // deprecated boolean remains useful for old unit seams, but now models the
  // same successful proxy route rather than blocking the target.
  const route: NetworkRoute = options.proxy_configured
    ? {
        route_kind: 'proxy',
        route_source: 'environment',
        resolution_source: 'proxy',
        destination_ip_observed: false,
      }
    : (options.route ??
      (() => {
        try {
          return (
            options.routeResolver ?? {
              resolve: () => ({
                route_kind: 'direct' as const,
                route_source: 'direct' as const,
                resolution_source: 'local' as const,
                destination_ip_observed: true,
              }),
            }
          ).resolve(new URL(`${normalized.protocol}//${normalized.hostname}${normalized.path}`));
        } catch {
          return {
            route_kind: 'direct' as const,
            route_source: 'direct' as const,
            resolution_source: 'local' as const,
            destination_ip_observed: true,
          };
        }
      })());

  if (ipaddr.isValid(normalized.hostname)) {
    const publicAddress = isPublicAddress(normalized.hostname);
    if (!publicAddress) return blocked('target_host_forbidden', normalized);
    return {
      kind: 'allowed',
      normalized,
      approved_ips: route.route_kind === 'proxy' ? [] : [publicAddress.address],
      ip_families: [publicAddress.family],
      dns_duration_ms: 0,
      route,
    };
  }

  if (route.route_kind === 'proxy') {
    return {
      kind: 'allowed',
      normalized,
      approved_ips: [],
      ip_families: [],
      dns_duration_ms: 0,
      route,
    };
  }

  const dnsStartedAt = Date.now();
  let resolved: readonly string[];
  try {
    resolved = await resolveWithBudget(
      options.resolver ?? DEFAULT_RESOLVER,
      normalized.hostname,
      options,
    );
  } catch (error) {
    const dnsDurationMs = Math.max(0, Date.now() - dnsStartedAt);
    const code = error instanceof Error ? error.message : '';
    if (code === 'TARGET_CANCELLED') return blocked('target_cancelled', normalized, dnsDurationMs);
    if (code === 'TARGET_DNS_TIMEOUT')
      return blocked('target_dns_timeout', normalized, dnsDurationMs);
    return blocked('target_dns_failed', normalized, dnsDurationMs);
  }
  if (resolved.length > MAX_DNS_ANSWER_ADDRESSES) {
    return blocked(
      'target_dns_too_many_addresses',
      normalized,
      Math.max(0, Date.now() - dnsStartedAt),
    );
  }
  const seen = new Set<string>();
  const approved: Array<{ readonly address: string; readonly family: 'ipv4' | 'ipv6' }> = [];
  const allTransparent = resolved.length > 0 && resolved.every(isTransparentProxyAddress);
  for (const value of resolved) {
    const transparent = isTransparentProxyAddress(value);
    const publicAddress = isPublicAddress(value);
    if ((!publicAddress && !transparent) || (transparent && !allTransparent))
      return blocked(
        'target_dns_forbidden_address',
        normalized,
        Math.max(0, Date.now() - dnsStartedAt),
      );
    const candidate = publicAddress ?? {
      address: value,
      family: 'ipv4' as const,
    };
    const parsed = ipaddr.parse(candidate.address);
    const key = `${candidate.family}:${parsed.toNormalizedString()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    approved.push(candidate);
  }
  const dnsDurationMs = Math.max(0, Date.now() - dnsStartedAt);
  if (approved.length === 0) return blocked('target_dns_failed', normalized, dnsDurationMs);
  const byFamily = {
    ipv4: approved
      .filter(({ family }) => family === 'ipv4')
      .sort((left, right) => left.address.localeCompare(right.address)),
    ipv6: approved
      .filter(({ family }) => family === 'ipv6')
      .sort((left, right) => left.address.localeCompare(right.address)),
  };
  const selected: typeof approved = [];
  for (let index = 0; selected.length < MAX_APPROVED_ADDRESSES; index += 1) {
    const before = selected.length;
    if (byFamily.ipv4[index]) selected.push(byFamily.ipv4[index]);
    if (selected.length < MAX_APPROVED_ADDRESSES && byFamily.ipv6[index]) {
      selected.push(byFamily.ipv6[index]);
    }
    if (selected.length === before) break;
  }
  return {
    kind: 'allowed',
    normalized,
    approved_ips: selected.map(({ address }) => address),
    ip_families: [...new Set(selected.map(({ family }) => family))],
    dns_duration_ms: dnsDurationMs,
    route: allTransparent
      ? {
          ...route,
          route_kind: 'proxy',
          route_source: 'transparent',
          resolution_source: 'proxy',
          destination_ip_observed: false,
        }
      : route,
  };
};
