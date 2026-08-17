# Troubleshooting

Start with `netokay version`. If it succeeds, continue with the single target
command and preserve its exit code. If it is missing, stop and report that no
published artifact matches the v0.2 contract. Do not download or substitute
the retained v0.1 compatibility build; it is historical and does not implement
this contract. Do not silently fall back to a registry package or global install.

An exit code of 64 means the invocation is invalid: check that there is one
target, that its scheme/port is `http:80` or `https:443`, and that no arbitrary
Control flag was supplied. Code 3 means policy rejected the run. Code 2 means
the check was honest but incomplete: inspect `policy`, `observations`, and
`limitations` for DNS, TLS, socket, permissions, or public-Control proof gaps.
Code 1 calls for attention to a failed observation; code 0 does not prove
anything about an unobserved agent-internal runtime. Codes 4 and malformed
JSON should be reported as a tool failure without echoing command details.

If the public Control root cannot be resolved or its certificate/socket proof
does not match the complete policy, do not substitute a Preview or local URL.
Report public Control as unverified. If the target is sensitive, private,
authenticated, or outside the user's authority, stop without retrying. A
proxy-routed Target can remain `allowed` with `destination_ip_observed=false`;
check the route facts and the TCP/TLS/Headers observations before treating it
as incomplete. Do not print or request proxy values while debugging.
