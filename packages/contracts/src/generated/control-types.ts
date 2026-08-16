/* eslint-disable */
/** GENERATED FILE. Edit packages/contracts/schemas instead. */

/**
 * The allowlisted self/echo Control API response contract.
 */
export type NetOkayControlAPIResponse = (ControlSelfResponse | ControlEchoResponse | ControlErrorResponse)
export type ControlSelfResponse = (CommonSuccess & {
ip_family: NullableIpFamily
country: NullableCountry
asn: NonNegativeSafeInteger
colo: NullableColo
http_protocol: NullableHttpProtocol
tls_version: NullableTlsVersion
client_tcp_rtt_ms: NonNegativeSafeInteger
/**
 * @maxItems 7
 */
missing_fields: []|[("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms")]|[("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms")]|[("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms")]|[("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms")]|[("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms")]|[("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms")]|[("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms"), ("ip_family" | "country" | "asn" | "colo" | "http_protocol" | "tls_version" | "client_tcp_rtt_ms")]
[k: string]: unknown
})
export type ApiVersion = string
export type Version = string
/**
 * @minItems 2
 * @maxItems 2
 */
export type Capabilities = [("control.self" | "control.echo"), ("control.self" | "control.echo")]
export type RequestId = string
export type NullableIpFamily = (("ipv4" | "ipv6") | null)
export type NullableCountry = (string | null)
export type NonNegativeSafeInteger = (number | null)
export type NullableColo = (string | null)
export type NullableHttpProtocol = (("HTTP/1.0" | "HTTP/1.1" | "HTTP/2" | "HTTP/3") | null)
export type NullableTlsVersion = (("TLSv1.2" | "TLSv1.3") | null)
export type ControlEchoResponse = (CommonSuccess & {
method: "GET"
x_netokay_run_id: NullableString
x_netokay_challenge: NullableString
x_netokay_client_version: NullableString
user_agent_class: ("none" | "browser" | "node" | "curl" | "agent" | "other")
[k: string]: unknown
})
export type NullableString = (string | null)

export interface CommonSuccess {
api_version: ApiVersion
control_profile_version: Version
capabilities: Capabilities
schema_version: string
observed_at: string
request_id: RequestId
[k: string]: unknown
}
export interface ControlErrorResponse {
code: ("METHOD_NOT_ALLOWED" | "QUERY_NOT_ALLOWED" | "HEADER_LIMIT_EXCEEDED" | "REQUEST_BODY_NOT_ALLOWED" | "ROUTE_NOT_FOUND" | "CONTROL_PROFILE_INCOMPATIBLE" | "INTERNAL_ERROR")
message: string
retryable: boolean
request_id: RequestId
}
