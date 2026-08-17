# Evidence contract

NetOkay writes one JSON EvidenceBundle to stdout. The bundle is a bounded
record of what the invoking process observed; it is not a packet capture,
remote scan, or causal proof.

Use the process code with the bundle:

- `0`: ready — all requested lanes passed.
- `1`: attention — a checked lane found a failed condition.
- `2`: incomplete — a lane could not be proven, including an unverified public
  service or target policy skip.
- `3`: rejected — the run or target policy rejected the request.
- `4`: error — terminalization or output failed while preserving safe semantics.
- `64`: invocation error — arguments or the Node runtime contract are invalid.

Read `intent` for the fixed profile and whether a target was requested. Read
`policy` for run and target decisions. `observations` contain allowlisted facts
for service, target policy, DNS, TCP, TLS, and headers. `diagnoses` are ranked
explanations with evidence references and possible layers, not a claim that one
layer is the sole cause. `completeness` and each observation's `limitations`
tell you what was not observed. `redaction` records omitted categories.

For the public service, `netokay-control-s2-public` is the control-only profile
and `netokay-control-s3-public` is the profile with one target. A successful,
approved-address, certificate-authorized handshake may be marked
`netokay_public_service`; anything short of that remains local and explicitly
unverified. Never rewrite an incomplete result as a successful service probe.

When present, `facts.route_kind` is `direct` or `proxy`, `route_source` is
`direct`, `environment`, `system`, or `transparent`, and `resolution_source`
is `local` or `proxy`. `destination_ip_observed=false` means an environment,
system, or transparent proxy selected the route and the final destination was
not observable; it is a limitation rather than an automatic Target skip.
Never infer the target IP from a proxy `remoteAddress`, and never expect
proxy URLs or credentials in Evidence.

Control self/echo requests use `Accept: application/json`; the target HEAD
request uses neutral `Accept: */*`. Target TCP/TLS/headers observations set
`duration_observed` only when the shared Transport returned that phase timing;
otherwise `duration_ms` is `0` and the flag is `false`. For direct and
transparent routes, an observable target attempt includes `attempt_count` and
`attempt_count_observed: true`. When an environment or system proxy cannot
expose the target attempt, Evidence omits the count and sets
`attempt_count_observed: false`. If `destination_ip_observed=false`, target
policy/DNS/TCP facts omit `address_count`, `ip_families`, and `ip_family`.
