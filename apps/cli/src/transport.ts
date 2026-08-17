import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { isIP } from 'node:net';
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import type { TLSSocket } from 'node:tls';
import ipaddr from 'ipaddr.js';
import type { NetworkRoute } from './network-route.js';

export type TransportPhase =
  | 'response_complete'
  | 'timeout'
  | 'cancelled'
  | 'response_too_large'
  | 'protocol_anomaly'
  | 'connect_error';

export type TransportStage = 'dns' | 'tcp' | 'tls' | 'headers';

export type TransportPhaseTimings = Readonly<Partial<Record<TransportStage, number>>>;

export const DEFAULT_PHASE_BUDGETS: Readonly<Record<TransportStage, number>> = Object.freeze({
  dns: 3_000,
  tcp: 4_000,
  tls: 4_000,
  headers: 6_000,
});

export interface TransportRequestOptions {
  readonly deadlineAt: number;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method?: 'GET' | 'HEAD' | 'POST';
  readonly body?: string;
  readonly approvedAddresses?: readonly string[];
  readonly serverName?: string;
  readonly readBody?: boolean;
  /** Route selected by the shared policy seam; proxy credentials stay in memory. */
  readonly route?: NetworkRoute;
}

export interface TransportResult {
  readonly phase: TransportPhase;
  readonly statusCode: number | null;
  readonly headers: Headers;
  readonly body: string | null;
  readonly errorCode: string | null;
  readonly remoteAddress?: string | null;
  readonly tlsProtocol?: string | null;
  readonly alpnProtocol?: string | null;
  readonly authorized?: boolean | null;
  readonly bodyObserved?: boolean;
  readonly failedStage?: TransportStage | null;
  readonly phaseTimings?: TransportPhaseTimings;
  readonly attemptCount?: number;
}

export interface TransportExecutor {
  readonly request: (url: URL, options: TransportRequestOptions) => Promise<TransportResult>;
}

export interface NodeTransportOptions {
  readonly maxResponseBytes?: number;
  /** Test-only trust anchor injection; the CLI never exposes this option. */
  readonly ca?: string | Buffer;
  /** Test-only phase budgets and lookup seam; the CLI uses the defaults. */
  readonly phaseBudgets?: Partial<Record<TransportStage, number>>;
  readonly lookup?: LookupFunction;
  /** Test-only pre-request gate for deterministic phase cancellation/timeout proofs. */
  readonly beforeRequest?: (stage: TransportStage, signal: AbortSignal) => Promise<void>;
}

const addressKey = (address: string): string => {
  try {
    const parsed = ipaddr.parse(address);
    return `${parsed.kind()}:${parsed.toNormalizedString()}`;
  } catch {
    return address.toLowerCase();
  }
};

const toHeaders = (source: IncomingHttpHeaders): Headers => {
  const result = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    result.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return result;
};

const result = (
  phase: TransportPhase,
  statusCode: number | null = null,
  headers: Headers = new Headers(),
  body: string | null = null,
  errorCode: string | null = null,
  metadata: Pick<
    TransportResult,
    | 'remoteAddress'
    | 'tlsProtocol'
    | 'alpnProtocol'
    | 'authorized'
    | 'bodyObserved'
    | 'failedStage'
    | 'phaseTimings'
    | 'attemptCount'
  > = {},
): TransportResult => ({
  phase,
  statusCode,
  headers,
  body,
  errorCode,
  remoteAddress: null,
  tlsProtocol: null,
  alpnProtocol: null,
  authorized: null,
  bodyObserved: false,
  failedStage: null,
  phaseTimings: {},
  attemptCount: 0,
  ...metadata,
});

interface ConsumedResponse {
  readonly body: string | null;
  readonly tooLarge: boolean;
  readonly bodyObserved: boolean;
  readonly unexpectedBody: boolean;
}

const consume = (
  response: IncomingMessage,
  maxResponseBytes: number,
  abort: () => void,
  readBody: boolean,
  onUnexpectedBody?: () => void,
): Promise<ConsumedResponse> =>
  new Promise((resolve) => {
    if (!readBody) {
      let bodyObserved = false;
      let settled = false;
      response.on('data', () => {
        bodyObserved = true;
        if (settled) return;
        settled = true;
        onUnexpectedBody?.();
        response.destroy();
        resolve({ body: null, tooLarge: false, bodyObserved, unexpectedBody: true });
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ body: null, tooLarge: false, bodyObserved, unexpectedBody: false });
      });
      response.on('error', () => {
        if (settled) return;
        settled = true;
        resolve({ body: null, tooLarge: false, bodyObserved, unexpectedBody: false });
      });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let bodyObserved = false;
    response.on('data', (chunk: Buffer | string) => {
      bodyObserved = true;
      if (tooLarge) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maxResponseBytes) {
        tooLarge = true;
        abort();
        return;
      }
      chunks.push(buffer);
    });
    response.on('end', () =>
      resolve({
        body: tooLarge ? null : Buffer.concat(chunks).toString('utf8'),
        tooLarge,
        bodyObserved,
        unexpectedBody: false,
      }),
    );
    response.on('error', () =>
      resolve({ body: null, tooLarge, bodyObserved, unexpectedBody: false }),
    );
  });

export const createNodeTransportExecutor = (
  options: NodeTransportOptions = {},
): TransportExecutor => {
  const maxResponseBytes = options.maxResponseBytes ?? 32 * 1024;
  return {
    request: (url, requestOptions) =>
      new Promise<TransportResult>((resolve) => {
        const deadlineRemaining = Math.max(0, requestOptions.deadlineAt - Date.now());
        if (deadlineRemaining === 0) {
          resolve(result('timeout', null, new Headers(), null, 'DEADLINE_EXCEEDED'));
          return;
        }
        if (requestOptions.signal?.aborted) {
          resolve(result('cancelled', null, new Headers(), null, 'ABORTED'));
          return;
        }
        if (
          requestOptions.route?.route_kind === 'proxy' &&
          requestOptions.route.route_source !== 'transparent' &&
          !requestOptions.route.proxyEnv
        ) {
          resolve(
            result('connect_error', null, new Headers(), null, 'PROXY_ROUTE_UNAVAILABLE', {
              failedStage: 'tcp',
            }),
          );
          return;
        }
        const controller = new AbortController();
        let timedOut = false;
        let cancelled = false;
        let settled = false;
        let activeRequest: ClientRequest | undefined;
        let socketConnected = false;
        let secureConnected = false;
        let connectedRemoteAddress: string | null = null;
        let responseSeen = false;
        let unexpectedBodyObserved = false;
        let attemptCount = 0;
        let timeoutStage: TransportStage | undefined;
        let currentStage: TransportStage = 'dns';
        let attemptEventsObserved = false;
        let phaseTimer: ReturnType<typeof setTimeout> | undefined;
        const phaseStarted = new Map<TransportStage, number>();
        const phaseDurations = new Map<TransportStage, number>();
        const phaseBudgetMs: Record<TransportStage, number> = {
          ...DEFAULT_PHASE_BUDGETS,
          ...options.phaseBudgets,
        };
        const endPhase = (stage: TransportStage): void => {
          const started = phaseStarted.get(stage);
          if (started === undefined || phaseDurations.has(stage)) return;
          phaseDurations.set(stage, Math.max(0, Date.now() - started));
        };
        const phaseSnapshot = (): TransportPhaseTimings => {
          const snapshot = new Map(phaseDurations);
          const started = phaseStarted.get(currentStage);
          if (started !== undefined && !snapshot.has(currentStage)) {
            snapshot.set(currentStage, Math.max(0, Date.now() - started));
          }
          return Object.fromEntries(snapshot) as TransportPhaseTimings;
        };
        const metadata = (
          extra: Partial<
            Pick<
              TransportResult,
              | 'remoteAddress'
              | 'tlsProtocol'
              | 'alpnProtocol'
              | 'authorized'
              | 'bodyObserved'
              | 'failedStage'
              | 'phaseTimings'
              | 'attemptCount'
            >
          > = {},
        ): Pick<
          TransportResult,
          | 'remoteAddress'
          | 'tlsProtocol'
          | 'alpnProtocol'
          | 'authorized'
          | 'bodyObserved'
          | 'failedStage'
          | 'phaseTimings'
          | 'attemptCount'
        > => ({
          remoteAddress: connectedRemoteAddress,
          tlsProtocol: null,
          alpnProtocol: null,
          authorized: null,
          bodyObserved: false,
          failedStage: timeoutStage ?? null,
          phaseTimings: phaseSnapshot(),
          attemptCount,
          ...extra,
        });
        const startPhase = (stage: TransportStage): void => {
          if (settled) return;
          endPhase(currentStage);
          currentStage = stage;
          phaseStarted.set(stage, Date.now());
          if (phaseTimer) clearTimeout(phaseTimer);
          const remaining = Math.max(0, requestOptions.deadlineAt - Date.now());
          const budget = Math.min(phaseBudgetMs[stage], remaining);
          phaseTimer = setTimeout(() => {
            timeoutStage = stage;
            timedOut = true;
            controller.abort();
            if (!activeRequest)
              finish(
                result(
                  'timeout',
                  null,
                  new Headers(),
                  null,
                  'DEADLINE_EXCEEDED',
                  metadata({ failedStage: stage }),
                ),
              );
          }, budget);
        };
        const agent =
          url.protocol === 'https:'
            ? new HttpsAgent({
                keepAlive: false,
                rejectUnauthorized: true,
                ...(options.ca ? { ca: options.ca } : {}),
                ...(requestOptions.route?.route_kind === 'proxy' && requestOptions.route.proxyEnv
                  ? { proxyEnv: requestOptions.route.proxyEnv }
                  : {}),
              })
            : new HttpAgent({
                keepAlive: false,
                ...(requestOptions.route?.route_kind === 'proxy' && requestOptions.route.proxyEnv
                  ? { proxyEnv: requestOptions.route.proxyEnv }
                  : {}),
              });
        let timer: ReturnType<typeof setTimeout>;
        const onAbort = (): void => {
          cancelled = true;
          controller.abort();
          if (!activeRequest)
            finish(result('cancelled', null, new Headers(), null, 'ABORTED', metadata()));
        };
        requestOptions.signal?.addEventListener('abort', onAbort, { once: true });
        const finish = (value: TransportResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (phaseTimer) clearTimeout(phaseTimer);
          requestOptions.signal?.removeEventListener('abort', onAbort);
          agent.destroy();
          resolve(value);
        };
        timer = setTimeout(() => {
          timeoutStage = currentStage;
          timedOut = true;
          controller.abort();
          if (!activeRequest)
            finish(
              result(
                'timeout',
                null,
                new Headers(),
                null,
                'DEADLINE_EXCEEDED',
                metadata({ failedStage: currentStage }),
              ),
            );
        }, deadlineRemaining);
        const open = async (): Promise<void> => {
          if (settled) return;
          if (requestOptions.signal?.aborted) {
            finish(result('cancelled', null, new Headers(), null, 'ABORTED'));
            return;
          }
          if (requestOptions.approvedAddresses && requestOptions.approvedAddresses.length === 0) {
            finish(result('connect_error', null, new Headers(), null, 'TARGET_APPROVED_IPS_EMPTY'));
            return;
          }
          const approvedLookup: LookupFunction | undefined = requestOptions.approvedAddresses
            ? (_hostname, lookupOptions, callback) => {
                endPhase('dns');
                const addresses = requestOptions.approvedAddresses!.map((address) => ({
                  address,
                  family: isIP(address) as 4 | 6,
                }));
                if (lookupOptions.all) {
                  startPhase('tcp');
                  callback(null, addresses);
                } else {
                  const first = addresses[0];
                  if (!first || (first.family !== 4 && first.family !== 6)) {
                    callback(new Error('approved address is invalid'), '');
                  } else {
                    startPhase('tcp');
                    callback(null, first.address, first.family);
                  }
                }
              }
            : undefined;
          const loopbackLookup: LookupFunction | undefined =
            url.hostname.toLowerCase() === 'localhost' && !requestOptions.approvedAddresses
              ? (_hostname, lookupOptions, callback) => {
                  endPhase('dns');
                  if (controller.signal.aborted) {
                    callback(new Error('ABORTED'), '');
                  } else if (lookupOptions.all) {
                    startPhase('tcp');
                    callback(null, [{ address: '127.0.0.1', family: 4 }]);
                  } else {
                    startPhase('tcp');
                    callback(null, '127.0.0.1', 4);
                  }
                }
              : undefined;
          const commonRequestOptions = {
            method: requestOptions.method ?? 'GET',
            headers: {
              connection: 'close',
              host: url.host,
              ...requestOptions.headers,
            },
            agent,
            signal: controller.signal,
            ...(approvedLookup
              ? {
                  lookup: approvedLookup,
                  autoSelectFamily: true,
                  autoSelectFamilyAttemptTimeout: 500,
                }
              : loopbackLookup
                ? { lookup: loopbackLookup }
                : options.lookup
                  ? { lookup: options.lookup }
                  : {}),
            ...(url.protocol === 'https:' &&
            !isIP(requestOptions.serverName ?? url.hostname.replace(/^\[|\]$/g, ''))
              ? {
                  servername: requestOptions.serverName ?? url.hostname.replace(/^\[|\]$/g, ''),
                }
              : {}),
          };
          const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
          if (!approvedLookup && !loopbackLookup && !options.lookup) {
            endPhase('dns');
            startPhase('tcp');
          }
          if (options.beforeRequest) {
            if (requestOptions.approvedAddresses) startPhase('tcp');
            const gateStage: TransportStage = requestOptions.approvedAddresses
              ? 'tcp'
              : currentStage;
            try {
              await options.beforeRequest(gateStage, controller.signal);
            } catch (error) {
              if (settled) return;
              if (timedOut) {
                finish(
                  result(
                    'timeout',
                    null,
                    new Headers(),
                    null,
                    'DEADLINE_EXCEEDED',
                    metadata({ failedStage: timeoutStage ?? gateStage }),
                  ),
                );
              } else if (cancelled || controller.signal.aborted) {
                finish(result('cancelled', null, new Headers(), null, 'ABORTED', metadata()));
              } else {
                finish(
                  result(
                    'connect_error',
                    null,
                    new Headers(),
                    null,
                    error instanceof Error ? error.message : 'CONNECT_ERROR',
                    metadata({ failedStage: gateStage }),
                  ),
                );
              }
              return;
            }
            if (settled || controller.signal.aborted) return;
          }
          activeRequest = requestFn(url, commonRequestOptions);
          activeRequest.once('socket', (socket) => {
            const attemptedSocket = socket as typeof socket & {
              readonly autoSelectFamilyAttemptedAddresses?: readonly string[];
            };
            const countConnectionAttempt = (): void => {
              attemptEventsObserved = true;
              attemptCount += 1;
            };
            socket.on('connectionAttempt', countConnectionAttempt);
            socket.once('connect', () => {
              if (!attemptEventsObserved) {
                attemptCount = Math.max(
                  1,
                  attemptedSocket.autoSelectFamilyAttemptedAddresses?.length ?? 0,
                );
              }
              connectedRemoteAddress = socket.remoteAddress ?? null;
              if (
                requestOptions.approvedAddresses &&
                (!connectedRemoteAddress ||
                  !requestOptions.approvedAddresses.some(
                    (approvedAddress) =>
                      addressKey(approvedAddress) === addressKey(connectedRemoteAddress!),
                  ))
              ) {
                socket.destroy();
                activeRequest?.destroy();
                finish(
                  result(
                    'connect_error',
                    null,
                    new Headers(),
                    null,
                    'TARGET_SOCKET_NOT_APPROVED',
                    metadata({ remoteAddress: connectedRemoteAddress, failedStage: 'tcp' }),
                  ),
                );
                return;
              }
              socketConnected = true;
              endPhase('tcp');
              startPhase(url.protocol === 'https:' ? 'tls' : 'headers');
            });
            if (url.protocol === 'https:') {
              (socket as TLSSocket).once('secureConnect', () => {
                secureConnected = true;
                endPhase('tls');
                startPhase('headers');
              });
            }
          });
          activeRequest.once('response', async (response) => {
            responseSeen = true;
            endPhase('tcp');
            if (url.protocol === 'https:') endPhase('tls');
            endPhase('headers');
            if (phaseTimer) clearTimeout(phaseTimer);
            const remoteAddress = response.socket.remoteAddress ?? connectedRemoteAddress;
            if (!attemptEventsObserved) {
              const attemptedAddresses = (
                response.socket as typeof response.socket & {
                  readonly autoSelectFamilyAttemptedAddresses?: readonly string[];
                }
              ).autoSelectFamilyAttemptedAddresses;
              if (attemptedAddresses && attemptedAddresses.length > 0) {
                attemptCount = attemptedAddresses.length;
              }
            }
            if (
              requestOptions.approvedAddresses &&
              (!remoteAddress ||
                !requestOptions.approvedAddresses.some(
                  (approvedAddress) => addressKey(approvedAddress) === addressKey(remoteAddress),
                ))
            ) {
              response.destroy();
              activeRequest?.destroy();
              finish(
                result(
                  'connect_error',
                  null,
                  new Headers(),
                  null,
                  'TARGET_SOCKET_NOT_APPROVED',
                  metadata({ remoteAddress, failedStage: 'tcp' }),
                ),
              );
              return;
            }
            const consumed = await consume(
              response,
              maxResponseBytes,
              () => activeRequest?.destroy(),
              requestOptions.readBody !== false,
              () => {
                unexpectedBodyObserved = true;
              },
            );
            const tlsSocket = response.socket as TLSSocket;
            const responseMetadata = {
              remoteAddress,
              tlsProtocol:
                url.protocol === 'https:' && typeof tlsSocket.getProtocol === 'function'
                  ? tlsSocket.getProtocol()
                  : null,
              alpnProtocol:
                url.protocol === 'https:' && typeof tlsSocket.alpnProtocol === 'string'
                  ? tlsSocket.alpnProtocol
                  : null,
              authorized: url.protocol === 'https:' ? tlsSocket.authorized : null,
              bodyObserved: consumed.bodyObserved,
              failedStage: null,
              phaseTimings: phaseSnapshot(),
              attemptCount,
            };
            if (consumed.unexpectedBody) {
              finish(
                result(
                  'protocol_anomaly',
                  response.statusCode ?? null,
                  new Headers(),
                  null,
                  'TARGET_UNEXPECTED_BODY',
                  responseMetadata,
                ),
              );
              return;
            }
            if (consumed.tooLarge) {
              finish(
                result(
                  'response_too_large',
                  response.statusCode ?? null,
                  toHeaders(response.headers),
                  null,
                  'RESPONSE_TOO_LARGE',
                  responseMetadata,
                ),
              );
              return;
            }
            finish(
              result(
                'response_complete',
                response.statusCode ?? null,
                toHeaders(response.headers),
                consumed.body,
                null,
                responseMetadata,
              ),
            );
          });
          activeRequest.once('error', (error: NodeJS.ErrnoException) => {
            const parserError =
              requestOptions.method === 'HEAD' &&
              typeof error.code === 'string' &&
              error.code.startsWith('HPE_');
            if (unexpectedBodyObserved || (responseSeen && parserError)) {
              finish(
                result(
                  'protocol_anomaly',
                  null,
                  new Headers(),
                  null,
                  'TARGET_UNEXPECTED_BODY',
                  metadata({ failedStage: 'headers' }),
                ),
              );
            } else if (parserError) {
              finish(
                result(
                  'connect_error',
                  null,
                  new Headers(),
                  null,
                  'TARGET_HEADERS_FAILED',
                  metadata({ failedStage: 'headers' }),
                ),
              );
            } else if (timedOut) {
              finish(
                result(
                  'timeout',
                  null,
                  new Headers(),
                  null,
                  'DEADLINE_EXCEEDED',
                  metadata({ failedStage: timeoutStage ?? currentStage }),
                ),
              );
            } else if (cancelled || error.name === 'AbortError' || error.code === 'ABORT_ERR') {
              finish(
                result(
                  'cancelled',
                  null,
                  new Headers(),
                  null,
                  'ABORTED',
                  metadata({ failedStage: timeoutStage ?? currentStage }),
                ),
              );
            } else {
              finish(
                result(
                  'connect_error',
                  null,
                  new Headers(),
                  null,
                  error.code ?? 'CONNECT_ERROR',
                  metadata({
                    failedStage:
                      responseSeen ||
                      (socketConnected && (url.protocol !== 'https:' || secureConnected))
                        ? 'headers'
                        : url.protocol === 'https:' && socketConnected
                          ? 'tls'
                          : 'tcp',
                  }),
                ),
              );
            }
          });
          activeRequest.end(requestOptions.body);
        };

        startPhase('dns');
        void open();
      }),
  };
};
