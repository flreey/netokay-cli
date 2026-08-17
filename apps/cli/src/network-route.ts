import { execFileSync } from 'node:child_process';
import { isIP } from 'node:net';

export type RouteKind = 'direct' | 'proxy';
export type RouteSource = 'direct' | 'environment' | 'system' | 'transparent';
export type ResolutionSource = 'local' | 'proxy';

/**
 * Route metadata is deliberately limited to safe categories. The proxyEnv
 * member is an execution-only value and is never copied into Evidence facts.
 */
export interface NetworkRoute {
  readonly route_kind: RouteKind;
  readonly route_source: RouteSource;
  readonly resolution_source: ResolutionSource;
  readonly destination_ip_observed: boolean;
  readonly proxyEnv?: NodeJS.ProcessEnv;
}

export interface StaticSystemProxy {
  readonly host: string;
  readonly port: number;
}

export interface SystemProxySnapshot {
  readonly http?: StaticSystemProxy;
  readonly https?: StaticSystemProxy;
  readonly exceptions?: readonly string[];
  /** PAC/SOCKS settings are detected but cannot be executed by this client. */
  readonly unsupported?: boolean;
}

export interface NetworkRouteResolver {
  readonly resolve: (url: URL) => NetworkRoute;
}

export interface NetworkRouteResolverOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** Test seam; production reads static macOS settings with scutil. */
  readonly systemProxy?: SystemProxySnapshot | (() => SystemProxySnapshot | null) | null;
}

const directRoute = (): NetworkRoute => ({
  route_kind: 'direct',
  route_source: 'direct',
  resolution_source: 'local',
  destination_ip_observed: true,
});

const proxyUrl = (host: string, port: number): string => {
  const normalizedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${normalizedHost}:${port}`;
};

const proxyRoute = (
  source: Extract<RouteSource, 'environment' | 'system'>,
  value: string,
  targetProtocol: 'http:' | 'https:',
): NetworkRoute => ({
  route_kind: 'proxy',
  route_source: source,
  resolution_source: 'proxy',
  destination_ip_observed: false,
  // Node's native proxy support only reads these well-known keys. Passing a
  // fresh object also prevents unrelated process environment values from
  // affecting a route that has already been selected.
  proxyEnv: {
    [targetProtocol === 'https:' ? 'HTTPS_PROXY' : 'HTTP_PROXY']: value,
    ...(source === 'system'
      ? {
          HTTPS_PROXY: value,
        }
      : {}),
    NO_PROXY: '',
  },
});

const valueFor = (env: NodeJS.ProcessEnv, lower: string, upper: string): string | undefined =>
  env[lower] || env[upper] || undefined;

const noProxyValue = (env: NodeJS.ProcessEnv): string | undefined =>
  valueFor(env, 'no_proxy', 'NO_PROXY');

const validProxyUrl = (value: string | undefined): string | null => {
  if (!value || value.includes('\r') || value.includes('\n')) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname || url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
    if (
      url.port !== '' &&
      (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535)
    )
      return null;
    return url.href.slice(-1) === '/' ? url.href.slice(0, -1) : url.href;
  } catch {
    return null;
  }
};

const ipv4Number = (value: string): number | null => {
  if (isIP(value) !== 4) return null;
  const octets = value.split('.').map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return null;
  return (((octets[0]! * 256 + octets[1]!) * 256 + octets[2]!) * 256 + octets[3]!) >>> 0;
};

/** Mirrors Node 24's built-in NO_PROXY matching rules. */
export const matchesNoProxy = (url: URL, value: string | undefined): boolean => {
  if (!value) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const hostWithPort = `${host.includes(':') ? `[${host}]` : host}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  for (const rawEntry of value.split(',')) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*' || entry === host || entry === hostWithPort) return true;
    if (entry === '<local>' && !host.includes('.')) return true;
    if (entry.startsWith('.')) {
      const suffix = entry.slice(1);
      if (
        host === suffix ||
        (host.endsWith(suffix) && host[host.length - suffix.length - 1] === '.')
      )
        return true;
    }
    if (entry.startsWith('*.') && host.endsWith(entry.slice(1))) return true;
    if (entry.includes('-') && isIP(host) === 4) {
      const [start, end] = entry.split('-');
      const hostNumber = ipv4Number(host);
      const startNumber = ipv4Number(start?.trim() ?? '');
      const endNumber = ipv4Number(end?.trim() ?? '');
      if (
        hostNumber !== null &&
        startNumber !== null &&
        endNumber !== null &&
        hostNumber >= startNumber &&
        hostNumber <= endNumber
      )
        return true;
    }
  }
  return false;
};

const environmentProxy = (
  url: URL,
  env: NodeJS.ProcessEnv,
): {
  readonly configured: boolean;
  readonly value: string | null;
  readonly bypassed: boolean;
  readonly unusable: boolean;
} => {
  const specific =
    url.protocol === 'https:'
      ? valueFor(env, 'https_proxy', 'HTTPS_PROXY')
      : valueFor(env, 'http_proxy', 'HTTP_PROXY');
  const fallback = valueFor(env, 'all_proxy', 'ALL_PROXY');
  const candidate = specific ?? fallback;
  if (candidate === undefined) {
    return { configured: false, value: null, bypassed: false, unusable: false };
  }
  if (matchesNoProxy(url, noProxyValue(env))) {
    return { configured: true, value: null, bypassed: true, unusable: false };
  }
  const value = validProxyUrl(candidate);
  return { configured: true, value, bypassed: false, unusable: value === null };
};

const parseEnabledProxy = (
  enabled: string | undefined,
  host: string | undefined,
  port: string | undefined,
): StaticSystemProxy | undefined => {
  if (enabled !== '1' || !host || /[\s\u0000-\u001f\u007f]/.test(host)) return undefined;
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) return undefined;
  return { host, port: parsedPort };
};

/** Parses static HTTP(S) settings and detects PAC/SOCKS settings as unusable. */
export const parseScutilProxyOutput = (output: string): SystemProxySnapshot | null => {
  const unquote = (value: string): string =>
    value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (match) values.set(match[1]!, unquote(match[2]!));
  }
  const exceptions = [...output.matchAll(/^\s*\d+\s*:\s*(?:"([^"]*)"|(\S+))\s*$/gm)].map(
    (match) => match[1] ?? match[2]!,
  );
  const http = parseEnabledProxy(
    values.get('HTTPEnable'),
    values.get('HTTPProxy'),
    values.get('HTTPPort'),
  );
  const https = parseEnabledProxy(
    values.get('HTTPSEnable'),
    values.get('HTTPSProxy'),
    values.get('HTTPSPort'),
  );
  const unsupportedEnabled =
    values.get('ProxyAutoConfigEnable') === '1' || values.get('SOCKSEnable') === '1';
  if (!http && !https && exceptions.length === 0 && !unsupportedEnabled) return null;
  return {
    ...(http ? { http } : {}),
    ...(https ? { https } : {}),
    ...(exceptions.length > 0 ? { exceptions } : {}),
    ...(unsupportedEnabled && (!http || !https) ? { unsupported: true } : {}),
  };
};

const readSystemProxy = (): SystemProxySnapshot | null => {
  try {
    const output = execFileSync('scutil', ['--proxy'], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseScutilProxyOutput(output);
  } catch {
    return null;
  }
};

const unusableProxyRoute = (
  source: Extract<RouteSource, 'environment' | 'system'>,
): NetworkRoute => ({
  route_kind: 'proxy',
  route_source: source,
  resolution_source: 'proxy',
  destination_ip_observed: false,
});

export const isTransparentProxyAddress = (value: string): boolean => {
  if (isIP(value) !== 4) return false;
  const [first, second] = value.split('.').map(Number);
  return first === 198 && (second === 18 || second === 19);
};

export const createNetworkRouteResolver = (
  options: NetworkRouteResolverOptions = {},
): NetworkRouteResolver => {
  const env = options.env ?? process.env;
  let systemSnapshot: SystemProxySnapshot | null | undefined;
  const getSystemSnapshot = (): SystemProxySnapshot | null => {
    if (systemSnapshot !== undefined) return systemSnapshot;
    if (options.systemProxy !== undefined) {
      systemSnapshot =
        typeof options.systemProxy === 'function' ? options.systemProxy() : options.systemProxy;
      return systemSnapshot;
    }
    if ((options.platform ?? process.platform) !== 'darwin') {
      systemSnapshot = null;
      return systemSnapshot;
    }
    systemSnapshot = readSystemProxy();
    return systemSnapshot;
  };

  return {
    resolve: (url) => {
      const envResult = environmentProxy(url, env);
      if (envResult.value !== null)
        return proxyRoute(
          'environment',
          envResult.value,
          url.protocol === 'https:' ? 'https:' : 'http:',
        );
      if (envResult.unusable) return unusableProxyRoute('environment');
      if (envResult.bypassed) return directRoute();
      if (!envResult.configured) {
        const system = getSystemSnapshot();
        const systemProxy = url.protocol === 'https:' ? system?.https : system?.http;
        if (matchesNoProxy(url, system?.exceptions?.join(', '))) return directRoute();
        if (systemProxy) {
          return proxyRoute(
            'system',
            proxyUrl(systemProxy.host, systemProxy.port),
            url.protocol === 'https:' ? 'https:' : 'http:',
          );
        }
        if (system?.unsupported) return unusableProxyRoute('system');
      }
      return directRoute();
    },
  };
};

export const DEFAULT_NETWORK_ROUTE_RESOLVER = createNetworkRouteResolver();

export const routeFacts = (
  route: NetworkRoute | undefined,
): {
  readonly route_kind: RouteKind;
  readonly route_source: RouteSource;
  readonly resolution_source: ResolutionSource;
  readonly destination_ip_observed: boolean;
} => ({
  route_kind: route?.route_kind ?? 'direct',
  route_source: route?.route_source ?? 'direct',
  resolution_source: route?.resolution_source ?? 'local',
  destination_ip_observed: route?.destination_ip_observed ?? true,
});
