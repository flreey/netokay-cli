# @netokay/core

Pure diagnostic orchestration seam. It has no Node, network, filesystem, process, Cloudflare, or telemetry dependency. Control observations arrive through injected Ports; the CLI owns the Node TransportExecutor and keeps S1 no-network behavior when no Control URL is supplied.
