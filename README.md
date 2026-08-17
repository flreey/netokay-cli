# NetOkay CLI

This repository is the public, deterministic release mirror for the NetOkay
CLI. It contains the CLI, the contracts it consumes, and the pure diagnostic
core. The private NetOkay repository remains the canonical development source;
the Worker, production configuration, operations, and future provider or
billing code are not part of this repository.

The package is an executable-only ESM distribution. Build and test from source
with Node 24 and pnpm 10:

```text
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test
corepack pnpm pack
corepack pnpm run pack:smoke
```

The public package is Apache-2.0 licensed. The public diagnostic path uses the
fixed public selector `--control netokay-public`. Loopback and Preview diagnostics
remain explicit local/Preview diagnostic overrides (`--control-base-url` with optional
`--preview-edge`); no arbitrary remote Control URL is accepted.

## Agent use

The canonical agent Skill is `skills/netokay/`. In Codex, use the
`skill-installer` helper with this complete, tag-pinned GitHub path after the
repository is public:

```text
https://github.com/flreey/netokay-cli/tree/v0.1.0/skills/netokay
```

In Claude, copy that directory to `.claude/skills/netokay`. Agents without
native Skills can copy
[prompts/netokay-agent-prompt.md](prompts/netokay-agent-prompt.md) into their
task instructions. These are instruction-only contracts: they use one
explicit public target and the fixed `--control netokay-public` selector.

After a GitHub Release exists, the one-shot CLI fallback is:

```text
npm exec --yes --package=https://github.com/flreey/netokay-cli/releases/download/v0.1.0/netokay-0.1.0.tgz -- netokay version
npm exec --yes --package=https://github.com/flreey/netokay-cli/releases/download/v0.1.0/netokay-0.1.0.tgz -- netokay diagnose https://github.com --control netokay-public
```

The v0.1.0 GitHub Release is the current test-build distribution. Its fixed
tarball URL and the Production Control selected by `netokay-public` are checked
as part of the protected Release workflow. npm publication remains pending;
review the emitted evidence before sharing it.

The current `main` source targets `https://netokay.net/` as the canonical
Production Control root. The immutable v0.1.0 test build continues to target
the retained `workers.dev` compatibility route until a separately authorized
future release is published.

`release-manifest.json` is a prepare-phase asset. The final manifest is created
in the protected release runtime after the public commit, Worker version,
Production HTTPS Control root, exact npm version, schema hashes, and tarball
hash are known. It is a release artifact, not a self-referential source edit.

The normal publish workflow is manually dispatched with an exact protected
`v<package.version>` tag/version and `PUBLISH_NPM` confirmation. It uses the npm
Trusted Publisher OIDC path and publishes the single hashed tarball produced
from this checkout. The separate `Bootstrap npm publish (one-time)` workflow is
an emergency first-package path: protect the
`npm-bootstrap` environment, provide the exact package version and
`BOOTSTRAP_ONCE` confirmation, then supply the minimum `NPM_BOOTSTRAP_TOKEN`
environment secret. After the package exists, configure Trusted Publisher,
revoke/delete that token, and disable the bootstrap workflow. Neither workflow
deploys the private Worker or consumes Cloudflare credentials.
