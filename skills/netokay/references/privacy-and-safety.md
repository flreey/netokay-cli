# Privacy and safety

The diagnostic is read-only and intentionally narrow. It accepts one user-given
public `http:80` or `https:443` target and uses a fixed public Control root.
On a direct route, Target policy resolves every A and AAAA answer, rejects
special/private or mixed answers, and pins transport to the approved public
addresses. When an inherited environment/system proxy or a transparent
Fake-IP route is actually selected, the proxy may resolve the destination and
the final address may be not observed; this is recorded as a limitation, not
an automatic skip. Explicit private/special targets remain rejected, and the
proxy remote address is never reported as the target IP. If an explicitly
configured proxy is malformed or unsupported by the runtime, the request fails
before opening a socket instead of silently falling back to a direct route.

Never request or expose authorization values, cookies, request bodies, full
user-agent strings, proxy credentials, certificate chains, raw headers, or
secrets. Do not put sensitive values in prompts, shell history, issue comments,
logs, filenames, or pasted output. Do not upload Evidence automatically; if a
user asks to share it, stop at a local redacted review and ask for a separate,
explicit approval and destination.

Do not install software globally, alter Node, certificates, proxies, DNS, or
host configuration. The fallback tarball is downloaded only after the user
confirms the exact fixed URL. Offline environments, blocked network access,
non-public targets, ambiguous URLs, and missing confirmation all fail closed.
It is safer to report `not observed` than to infer a network cause.
