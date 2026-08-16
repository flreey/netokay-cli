# Privacy and safety

The diagnostic is read-only and intentionally narrow. It accepts one user-given
public `http:80` or `https:443` target and uses a fixed public Control root.
Target policy resolves every A and AAAA answer, rejects special/private or
mixed answers, and pins transport to the approved public addresses. A proxy
that hides the final address is a fail-closed condition.

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
