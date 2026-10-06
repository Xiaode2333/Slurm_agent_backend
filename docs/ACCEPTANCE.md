# Acceptance and coverage

This package was extracted on 2026-10-06 from a working Slurm deployment.
The original compatibility target was Codex CLI 0.160.1, official extension
26.930.61225, Node 22.23.2, VS Code 1.140.0 and ws 8.22.0.
These observations describe the original environment, not a fresh deployment of
this public repository on another cluster.

## Observed in the original environment

- One-command connection applied the official extension's CLI setting, reloaded
  once and returned a backend identity and session counts. Repeating the command
  did not reload or restart the backend.
- Existing conversations appeared in the native sidebar and could be opened.
  The relay includes CLI, VS Code and app-server origins in default history
  filters, while preserving explicit filters.
- An active conversation retained its original thread and turn after its relay
  was terminated. Reconnection restored history and ongoing progress without
  restarting the backend.
- A remote TUI resumed an app-server-created thread and received its completion.
- Waiting-for-input and failed-turn states were displayed in the official UI.
- A Welcome window with no workspace folder connected using its project terminal.
- An independently authenticated Tunnel window connected and opened existing
  history in the official sidebar.
- The repaired cold-start path reached backend readiness, completed browser
  device authentication, printed the Tunnel URL and started a VS Code server.

## Automated regression coverage

Node tests exercise private Unix WebSocket transport, backend process identity,
stale/version/ambiguity rejection, pagination and live status, project aliases,
UTF-8 fragments, large frames, bidirectional requests, disconnect handling,
ordered stdout backpressure, launcher quoting, Node selection, interrupted
SQLite indexing, helper discovery and settings/reload/restore.

Python tests cover launcher contracts, Tunnel startup before component
installation, cached and new browser authentication, failed credential
persistence, and the real tmux pane lifetime with redirected logs.
The public repository runs these focused tests; unrelated simulation tests and
their result artifacts are not included.

## Remaining limits

Native UI pagination beyond the original environment's small history list and
a historical CLI-origin conversation using a project-path alias were not
observed directly. Their protocol contracts have regression coverage.
Unit tests alone do not establish live sidebar or Tunnel acceptance on a new
cluster. Scheduling partitions, accounts, QOS, node networking and installed
versions remain site-specific.

Original usernames, hostnames, allocations, thread IDs, screenshots, credentials
and detailed private receipts are omitted from this public extraction.
