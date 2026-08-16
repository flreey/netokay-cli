---
name: netokay
description: Diagnose one explicitly supplied public HTTP target with the NetOkay CLI, producing bounded, redacted EvidenceBundle facts and honest limitations without changing the host or claiming a unique root cause.
---

# NetOkay

Use this skill when an agent needs a read-only network preflight for one public
target. The target must be an explicit `http:80` or `https:443` URL. Do not use
this skill for private hosts, authenticated endpoints, bulk scans, redirects,
or requests to upload evidence.

## Run the bounded check

1. Confirm the user supplied exactly one public target. Reject query strings,
   fragments, userinfo, non-standard ports, private/special-use names, and
   targets whose DNS cannot be proven public. Never infer a target from context.
2. Run `netokay version` first. Treat its JSON and exit status as the local
   installation check.
3. If the command is unavailable, show the fixed source and version before
   downloading anything:

   `https://github.com/flreey/netokay-cli/releases/download/v0.1.0/netokay-0.1.0.tgz`

   Explain that this is the v0.1.0 GitHub Release tarball and that the public
   mirror/release/npm/Production status must not be assumed. Get explicit human
   confirmation. Only after confirmation, run the one-shot command with that
   exact URL: `npm exec --yes --package=<url> -- netokay ...`.

4. Run exactly:

   `netokay diagnose <target> --control netokay-public`

   The selector is fixed. Never pass an arbitrary Control URL, Preview URL,
   profile, proxy, certificate, or DNS override. Do not install Node, a global
   CLI, certificates, or a proxy.

5. Parse stdout as one schema-valid JSON document. Preserve the process exit
   code: 0 ready, 1 attention, 2 incomplete, 3 rejected, 4 error, and 64
   invalid invocation. Explain `facts`, `not observed` fields, and suggested
   actions separately. State when the run is incomplete or unverified; do not
   turn correlation into a unique cause.

Read [evidence-contract.md](references/evidence-contract.md) when interpreting
the JSON, [privacy-and-safety.md](references/privacy-and-safety.md) before
handling target or output data, and
[troubleshooting.md](references/troubleshooting.md) when the command is absent,
offline, rejected, or returns an incomplete result.

## Safety boundary

Only issue the bounded GET Control handshake and the CLI's single public-target
HEAD. Do not collect or repeat authorization, cookie, request-body, full
user-agent, proxy credential, certificate-chain, or secret values. Do not send
Evidence to a service or write it to a shared location. If network permission,
target publicness, or human confirmation is missing, stop and report the
boundary rather than guessing.
