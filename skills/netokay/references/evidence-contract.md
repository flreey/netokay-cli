# Evidence contract

NetOkay writes one JSON EvidenceBundle to stdout. The bundle is a bounded
record of what the invoking process observed; it is not a packet capture,
remote scan, or causal proof.

Use the process code with the bundle:

- `0`: ready — all requested lanes passed.
- `1`: attention — a checked lane found a failed condition.
- `2`: incomplete — a lane could not be proven, including an unverified public
  Control or target policy skip.
- `3`: rejected — the run or target policy rejected the request.
- `4`: error — terminalization or output failed while preserving safe semantics.
- `64`: invocation error — arguments or the Node runtime contract are invalid.

Read `intent` to see the fixed profile and whether a target was requested.
Read `policy` for run and target decisions. `observations` contain allowlisted
facts for Control, target policy, DNS, TCP, TLS, and headers. `diagnoses` are
ranked explanations with evidence references and possible layers, not a claim
that one layer is the sole cause. `completeness` and each observation's
`limitations` tell you what was not observed. `redaction` records categories
that were deliberately omitted.

For public Control, `netokay-control-s2-public` is the control-only profile and
`netokay-control-s3-public` is the profile with one target. A successful,
approved-address, certificate-authorized self and echo handshake may be marked
`cloudflare_public_edge`; anything short of that remains local and explicitly
unverified. Never rewrite an incomplete result as a successful Edge probe.
