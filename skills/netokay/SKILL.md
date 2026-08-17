---
name: netokay
description: Diagnose one explicitly supplied public HTTP target with the NetOkay CLI, producing bounded, redacted EvidenceBundle facts and honest limitations without changing the host or claiming a unique root cause.
---

# NetOkay

Use this skill for a read-only network preflight of one public target. The
target must be an explicit `http:80` or `https:443` URL. Do not use it for
private hosts, authenticated endpoints, bulk scans, redirects, or uploads.

## Run the bounded check

1. Confirm exactly one public target. Reject query strings, fragments,
   userinfo, non-standard ports, private/special-use names, and DNS answers
   that cannot be proven public on a direct route. An inherited environment or
   static system proxy, or an all-198.18/15 transparent Fake-IP route, is
   selected automatically and must not be treated as a policy block solely
   because the final destination IP is not observed.
2. Run `netokay version` and preserve its JSON and exit status.
3. If the command is unavailable, stop and report that no published artifact
   matches the v0.2.0 contract. Do not download or substitute the retained v0.1
   compatibility build; it is historical and does not implement this contract.
4. Run exactly `netokay diagnose <target>` from the installed v0.2.0 CLI. The
   CLI selects the fixed public NetOkay service and resolves the actual local
   route automatically. Never pass service, preview, profile, proxy,
   certificate, or DNS overrides.
5. Parse stdout as one schema-valid JSON document. Preserve exit code 0 ready,
   1 attention, 2 incomplete, 3 rejected, 4 error, or 64 invalid invocation.
   Explain evidence, limitations, and suggested actions without inferring a
   unique cause.

Read [evidence-contract.md](references/evidence-contract.md) when interpreting
the JSON and [privacy-and-safety.md](references/privacy-and-safety.md) before
handling target or output data. Read [troubleshooting.md](references/troubleshooting.md)
when the command is unavailable or incomplete.

## Safety boundary

Only issue the bounded service handshake and the CLI's single public-target
HEAD. Do not collect or repeat authorization, cookies, request bodies, full
user-agent values, proxy URLs/hosts/ports, proxy credentials, certificate
chains, or secrets. Interpret `route_kind`, `route_source`,
`resolution_source`, and `destination_ip_observed` as facts and limitations,
not as a target IP. If network permission, target publicness, or human
confirmation is missing, stop and report the boundary rather than guessing.
