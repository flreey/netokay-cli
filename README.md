# NetOkay CLI

This repository is a deterministic public source mirror for the NetOkay CLI,
its contracts, and its pure diagnostic core. The package is an executable-only
ESM distribution.

Build and test from source with Node 24 and pnpm 10:

```text
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test
corepack pnpm pack
corepack pnpm run pack:smoke
```

The public command surface is:

```text
netokay version
netokay schema
netokay diagnose [target] [--out <path>]
```

`diagnose` uses the fixed `https://netokay.net/` public service. Target checks
run only in the local process; no arbitrary service URL, preview profile,
proxy, certificate, or DNS override is accepted. The local runner honors
inherited environment proxy and `NO_PROXY` rules, then static macOS HTTP(S)
proxy exceptions when available; proxy values are never emitted. Proxy routes
may report `destination_ip_observed=false` while still completing a bounded
Target check when all other policy and transport checks pass. Unsupported or
malformed configured proxy routes fail before opening a socket and never fall
back silently to a direct request.
Control self/echo use `Accept: application/json`; target HEAD uses neutral
`Accept: */*`. When a proxy hides the destination, target policy/DNS/TCP facts
omit unobservable address counts and IP-family fields. Target phase facts use
`duration_observed`; missing Transport phase timing is represented as
`duration_ms: 0`. Attempt counts are emitted only when the target attempt is
observable, with `attempt_count_observed` recording that boundary.

## Agent use

The canonical agent Skill is `skills/netokay/`. These instruction-only files
describe the same bounded command and privacy boundary. No published artifact
currently matches the v0.2.0 contract. The retained v0.1.0 GitHub artifact is a
read-only historical compatibility build, not a replacement; do not substitute
it for the v0.2.0 CLI. Review version, release, and deployment state independently
before using any external artifact.

`release-manifest.json` is a prepare-phase asset. A final manifest is created
only after the source commit, service version, exact package version, schema
hashes, and tarball hash are known. It is a release artifact, not a
self-referential source edit.
