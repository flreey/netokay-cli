# @netokay/core

Pure diagnostic orchestration seam. It has no Node, network, filesystem,
process, provider, or telemetry dependency. Control and target observations
arrive through injected ports; the CLI owns transport and keeps all safety and
fail-closed policies at the execution boundary. The CLI's transport resolves
the inherited environment/system/transparent route for each URL and records
only safe route facts; the core does not inspect proxy configuration.
