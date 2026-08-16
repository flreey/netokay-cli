# netokay

Installable NetOkay CLI. `diagnose <target>` accepts one policy-approved public `http:80` or `https:443` target and performs a bounded, cold-connection HEAD through the shared TransportExecutor. Without `--control-base-url`, Control remains the honest S1 `not_observed` lane; with it, only an explicit loopback HTTP Control URL is accepted for local development/testing. The opt-in `--preview-edge` flag permits only an explicit HTTPS root Control URL without credentials, query, or fragment and marks trusted Control observations as `cloudflare_control`; it never selects a URL implicitly. Target policy blocks proxy-hidden destinations and non-public addresses, while Evidence retains only safe stage facts and no target URL, full IP, headers or body. Local Control Evidence is marked `local_runner` with the actual `http` scheme and explicit TLS/Cloudflare Edge limitations; SIGINT produces a schema-valid cancelled Bundle.

`diagnose [target] --out <path>` additionally writes the same schema-validated JSON to a new `0600` file using an atomic no-clobber publication. Existing targets, symlinks, and unsafe parent directories are rejected before a diagnostic Run is created; successful Evidence is never deleted automatically.

This npm package is a CLI-only executable distribution. It does not promise an `import('netokay')` library API; invoke the `netokay` binary (or its `dist/netokay.js` ESM entry) instead.

For the public release contract, use the fixed production selector with one
explicit public target: `netokay diagnose <target> --control netokay-public`.
Arbitrary remote Control URLs are not accepted. The public repository, npm
package, and Production service remain pending until their separate release
gates are completed.
