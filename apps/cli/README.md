# netokay

Installable NetOkay CLI. Run `netokay diagnose [target] [--out <path>]` to
perform one bounded, read-only check. The CLI always uses the fixed
`https://netokay.net/` public service; the target itself is executed only by
the local runner. Evidence is schema-valid, redacted, and fail-closed.

The public command surface is deliberately small:

```text
netokay version
netokay schema
netokay diagnose [target] [--out <path>]
```

`--out` atomically publishes a new `0600` file without clobbering an existing
path. This npm package is an executable-only distribution; invoke the `netokay`
binary (or its `dist/netokay.js` ESM entry) rather than relying on an import
library API.

The package does not accept service, preview, proxy, certificate, or DNS
overrides. At runtime it automatically follows the invoking process's
`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` and `NO_PROXY` rules; on macOS it may
also use static system HTTP(S) proxy settings and their exception list. A
proxy route can leave the final target IP not observed, which is recorded by
safe route facts without emitting proxy URLs, hosts, ports, or credentials.
Control self/echo requests explicitly negotiate JSON; target HEAD requests use
the neutral `Accept: */*` so content negotiation does not imply a JSON API.
When a proxy hides the destination, target Evidence omits unobservable address
counts and IP-family fields. Transport phase facts use `duration_observed` and
only expose `attempt_count` with `attempt_count_observed: true` when the target
attempt is observable; otherwise the count is omitted and the flag is false.
An explicitly configured proxy that this runtime cannot execute fails before
any socket is opened; it is never silently downgraded to a direct request.
Local harnesses retain their own test-only dependency injection seams outside
the public command surface.
