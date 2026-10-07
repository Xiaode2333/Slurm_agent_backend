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
Tests and JavaScript/Python compilation checks run locally with
`scripts/check_backend.sh`; the automatic GitHub Actions workflow was removed
at the user's request.

## Multi-project and native harness implementation, 2026-10-06

The updated Node suite passes 24 cases and the Python launcher suite passes nine.
Coverage includes shared-project selection, independent host bindings, a chat
view activating before its helper, indexed lists versus explicit repair,
WAL-consistent backups/restoration, controller/observer isolation, event replay,
UTF-8 JSONL framing and buffered attach input.

A formal priority CPU task verified two project directories against one real
Codex server, including a relayed new thread with omitted cwd. The local SQLite
benchmark completed 32 direct and 32 relayed queries without errors. Installed
OpenCode health/project attachment selection, Pi RPC reconnection, Claude
stream-json process persistence and native Pi/Claude tmux exit passed. No model
prompt or fabricated tool approval was sent.

Two actual official-extension windows completed initialize and sidebar-list
verification through their relay. After connecting the second project, both
current extension hosts still verified the same backend and their own project
directory; their application setting used the same dispatcher. The test uses synthetic projects, a private
loopback VS Code web server and an existing pinned official extension, rather
than a newly authenticated Tunnel. Existing live user allocations remain intact.

There is no measured browser rendering or model-generation speedup claim;
[performance evidence](performance.md) separates the loaded old backend from
fresh synthetic state.

## Split agent services and extension packaging, 2026-10-07

Published separate agent-partition Tunnel/server launchers and their local check
entrypoint. Both request one CPU, 8 GiB, seven days and no GPUs. Regression tests
cover independent tmux identities, service exit status/signal propagation,
cleanup and rejection of historical log entries as live ownership evidence.
An idle admin window no longer retains a dead Tunnel allocation.

Connector installation repairs mismatched official extension installations,
reports the actual in-memory extension version, and can repackage/retry a VSIX
when installation explicitly reports VS Code incompatibility. Packaging tests
verify both engine manifests against a simulated VS Code 1.100.2, retain the
minimum version declaration, remove obsolete archive entries and preserve the
standard VSIX XML namespace. Permission failures are not retried.

The complete local check passed 27 Node tests, 15 Python tests and all shell,
JavaScript and Python syntax/compilation checks. Both launcher `check` commands
passed; the Codex CLI emitted a nonfatal stale temporary-directory cleanup
warning. No new Slurm jobs or GitHub Actions were used for this publication.
Live sidebar connection after a window reload remains unverified for these
changes; installed CLI extension versions alone do not prove the loaded
window's version or connection.

## Remaining limits

Native UI pagination beyond the original environment's small history list and
a historical CLI-origin conversation using a project-path alias were not
observed directly. Their protocol contracts have regression coverage.
Unit tests alone do not establish live sidebar or Tunnel acceptance on a new
cluster. Scheduling partitions, accounts, QOS, node networking and installed
versions remain site-specific.

Original usernames, hostnames, allocations, thread IDs, screenshots, credentials
and detailed private receipts are omitted from this public extraction.
