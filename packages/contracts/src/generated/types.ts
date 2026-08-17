/* eslint-disable */
/** GENERATED FILE. Edit packages/contracts/schemas instead. */

export type Observation = ({
[k: string]: unknown
} & {
check_id: string
scope: ("control" | "target")
transport: ("http" | "https")
stage: ("control" | "policy" | "dns" | "tcp" | "tls" | "headers")
status: ("passed" | "failed" | "incomplete" | "skipped" | "not_observed" | "cancelled")
started_at: string
duration_ms: number
result_code: string
reason_code?: string
facts: {
[k: string]: unknown
}
limitations: string[]
source: ("local_runner" | "netokay_control")
colo?: string
})

/**
 * Versioned, redacted evidence emitted by a NetOkay diagnostic run.
 */
export interface NetOkayEvidenceBundle {
schema_version: string
bundle_id: string
run_status: ("completed" | "rejected" | "cancelled" | "errored")
outcome: ("ready" | "attention" | "incomplete" | "rejected" | "error")
started_at: string
completed_at: string
duration_ms: number
runner: Runner
execution_context: ExecutionContext
intent: Intent
policy: Policy
observations: Observation[]
differentials: Differential[]
diagnoses: Diagnosis[]
redaction: Redaction
completeness: Completeness
}
export interface Runner {
cli_version: string
core_version: string
control_profile_version: string
}
export interface ExecutionContext {
kind: ("local_shell" | "agent_spawned_process" | "container" | "ci" | "unknown")
agent_host?: ("codex" | "claude_code" | "cline" | "unknown")
os_family?: ("darwin" | "linux" | "unknown")
architecture?: ("arm64" | "x64" | "unknown")
container?: ("true" | "false" | "unknown")
proxy_env_present?: ("true" | "false" | "unknown")
no_proxy_present?: ("true" | "false" | "unknown")
extra_ca_present?: ("true" | "false" | "unknown")
agent_internal_runtime: ("observed" | "not_observed" | "unknown")
}
export interface Intent {
transport: ("http" | "https")
profile_id: string
has_target: boolean
}
export interface Policy {
version: string
run_decision: ("allowed" | "rejected")
target_decision: ("not_applicable" | "not_requested" | "skipped" | "allowed" | "rejected")
reasons: string[]
}
export interface Differential {
differential_id: string
kind: string
left_ref: string
right_ref: string
limitations: string[]
}
export interface Diagnosis {
code: string
summary: string
evidence_refs: string[]
possible_layers: string[]
limitations: string[]
suggested_next_steps: string[]
}
export interface Redaction {
not_collected: string[]
removed: string[]
truncated: string[]
}
export interface Completeness {
control: ("passed" | "failed" | "incomplete" | "not_observed" | "cancelled")
target: ("passed" | "failed" | "incomplete" | "skipped" | "cancelled" | "not_applicable")
missing: string[]
}
