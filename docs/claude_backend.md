# Claude Code extension backend

The Claude backend uses the official extension's documented
[`claudeCode.claudeProcessWrapper`](https://code.claude.com/docs/en/vs-code#extension-settings)
setting. The wrapper carries the extension's native arguments, stdin, stdout,
stderr, EOF, signals and exit code to a supervisor inside a Slurm allocation.
Claude permissions, authentication, settings and session history remain native.
The supervisor is idle until the extension asks it to launch a process.

`claude --remote` is a deprecated alias for cloud sessions. Official
[`claude remote-control`](https://code.claude.com/docs/en/remote-control) connects
web/mobile clients to local execution; it is not an app-server endpoint for
attaching the VS Code panel. These scripts use the process-wrapper interface.
The existing generic `agent_backend.sh claude-code` TUI/JSONL interfaces remain
available, but they do not configure the official extension.

## Start and connect

Install/authenticate Claude Code and install `anthropic.claude-code` in your
remote VS Code window. Node 22, npm, tmux, flock and zip are required. Shared
home/project storage is required for descriptors, binaries and Claude history.
From this checkout:

```bash
./scripts/agent_tmux_server_claude.sh check
sbatch scripts/agent_tmux_server_claude.sh
# In the target project's VS Code integrated terminal:
CLAUDE_BACKEND_JOB=JOB_ID /absolute/Slurm_agent_backend/scripts/connect_claude_backend.sh
```

The launcher defaults to `agent`, one CPU, 8 GiB, seven days and no GPU. Override
partition/account/QOS/time with `sbatch` for your cluster. For example,
`--partition=priority --account=prio_co54 --qos=prio_co54` selects Bouchet's
preferred CPU lane. Neither script requests a GPU or uses the `pi_co54` partition.
The `agent` partition permits only two concurrent jobs per user; a combined
backend takes one slot, and a separate Tunnel can take the other.

On **Grace**, use `agent_tmux_server_claude_grace.sh` or
`agent_tmux_server_both_grace.sh` and `connect_claude_backend_grace.sh` instead.
These default to the shared `week` CPU partition (one CPU, 8 GiB, seven days),
select Grace's standalone Codex CLI for combined mode, and include the user
`pi-node`/local CLI paths. Use `vscode_slurm_grace.sh` for a separate Tunnel.
See [Grace entry points](../README.md#bouchet--grace-兼容入口) for commands and overrides.
Local `check` validates installed prerequisites only, not scheduling or SSH.

Both launchers also accept a relative or absolute script path from another
project directory, without setting a source-root override:

```bash
cd /absolute/project
sbatch ../Slurm_agent_backend/scripts/agent_tmux_server_both.sh
```

The source checkout is resolved from the submitted script's path (Slurm's
`Command` when running its spool copy, resolving relative paths against the
submission directory), not by treating the submission directory as source. The
project defaults to the submission directory; scheduler-neutral `check` defaults
to the checkout and does not query Slurm. Paths containing spaces are supported.
Keep the checkout available on the compute node. An unavailable Slurm command
record fails with an explicit source-root override hint.

To override source discovery or serve a different project:

```bash
export AGENT_BACKEND_SOURCE_ROOT=/absolute/Slurm_agent_backend
export AGENT_BACKEND_PROJECT=/absolute/project
sbatch "$AGENT_BACKEND_SOURCE_ROOT/scripts/agent_tmux_server_claude.sh"
```

`CLAUDE_BACKEND_PROJECT` may override the Claude-only launcher's project.
The connector uses the current directory, or `--project DIR`, to find the
backend and validate the target VS Code workspace. It never submits a job.
If exactly one live backend exists, other projects may use that allocation;
multiple live candidates require `CLAUDE_BACKEND_JOB` or `CLAUDE_BACKEND_HOST`.
Discovery quietly skips unreachable or expired registrations (including missing
`/proc/PID/stat` on a retired worker) without deleting them. Explicit probe
failures retain SSH diagnostics; session transport still forwards SSH stderr.

The connector installs its independent helper if necessary. A newly installed
helper may require **Developer: Reload Window** once; the command explains when.
It does not reload existing Codex tabs automatically. After `CLAUDE_BACKEND_CONFIGURED`,
open a new Claude tab, or close/resume an idle Claude conversation. Existing
Claude processes retain their original location until closed. This setting uses
an application-wide dispatcher with process ancestry bindings: connected
windows launch in their selected allocation, while unbound windows run locally.

```bash
./scripts/connect_claude_backend.sh status
./scripts/connect_claude_backend.sh doctor
./scripts/connect_claude_backend.sh local
```

`backendAvailable` proves a live supervisor. `window.verified` additionally
requires a live wrapper receipt from this window's actual Claude extension
process. This receipt confirms launch/transport, not completion of a model turn.
Command Palette entries **Claude Backend: Show Connection Status** and
**Claude Backend: Use Local Claude** expose the same controls. Restoring local
mode affects future launches and preserves existing backend sessions.

## Codex and Claude together

```bash
./scripts/agent_tmux_server_both.sh check
sbatch scripts/agent_tmux_server_both.sh
# Both use the same job ID, but independent descriptors and protocols:
CODEX_BACKEND_JOB=JOB_ID ./scripts/connect_codex_backend.sh
CLAUDE_BACKEND_JOB=JOB_ID ./scripts/connect_claude_backend.sh
```

The two supervisors share one CPU. Use one harness at a time; the scripts do not
serialize model requests automatically. Codex uses its existing immutable
components, history/SQLite lease, version handshake and connector. A running
Codex allocation is never replaced or canceled. Starting another Codex backend
for a project already holding its SQLite lease fails cleanly: use a separate
project, or start the combined allocation after the old one ends. Claude-only
allocations can coexist with an existing Codex backend.

Each allocation has its own private tmux server and node-local sockets. The
`admin`, `claude-backend` and (combined mode) `codex-backend` windows can be
inspected using the attach command in the job log. An exit from either service
ends the combined allocation with its failure code (unexpected clean exits are
reported as failure). An idle admin pane never hides a dead backend. Shutdown
only touches that allocation's tmux server.

## Versions, node hops and session lifetime

No release number is pinned by default. Startup detects the installed CLI;
each extension launch prefers the bundled executable supplied by that extension,
so an extension update selects its corresponding CLI for new conversations.
Running children keep their original executable and recorded version.

Before the supervisor's version probe or a new native launch, the selected ELF
executable is copied into a private directory beside the allocation's node-local
socket. This is a byte copy, not a hard link or symlink to the extension. Its
SHA-256 and source-file identity are recorded; unchanged sources reuse the same
copy. A source replacement gets a new path/inode without overwriting or deleting
older copies. The executable is mode `0500`, its directory is mode `0700`, and
copies stay available for the allocation's lifetime. Budget roughly one native
binary's size per distinct source revision in that runtime (typically hundreds
of MiB). Snapshot/read errors fail the launch rather than falling back to the
shared binary. No native version is silently substituted.

This prevents VS Code's old-extension cleanup on a shared filesystem from
invalidating a running Claude executable mapping (`SIGBUS`/stale file handle).
It does not repair arbitrary Bun crashes, provider errors or allocation expiry.
Non-ELF npm/JavaScript/shell launchers keep their original path because relocating
them can break adjacent-package resolution; the native snapshot protection does
not extend to their scripts or dependencies. Select a standalone native Claude
executable when that protection is required.

Backend descriptors and session receipts expose `cli` (the actual executable),
`sourceCli` (its original resolved path), and `cliSha256` for native snapshots.
On reattachment the existing PID, executable and version remain unchanged.
Source updates alone never migrate an already running session.

This protection takes effect only in a newly started allocation using this
checkout. Updating source files does not upgrade a live supervisor's immutable
component. To activate later, submit the desired launcher from this checkout
using the commands above, then explicitly connect your window to the new job.
There is no automatic restart, cancellation, reconnection or migration of
existing backends; finish or stop the old allocation yourself when appropriate.

`CLAUDE_BACKEND_CLI=/absolute/claude` selects an explicit CLI; if an extension
supplies a different version, the launch fails with an actionable mismatch.
`CLAUDE_BACKEND_VERSION` optionally enforces a version pin. This detects versions
but cannot promise compatibility with future changes to the wrapper protocol.

Descriptors and immutable, content-addressed components live under private
`~/.local/state/claude-backend` and `~/.local/share/claude-backend` directories.
Cross-node clients use authenticated batch-mode SSH with strict host-key checks,
validate the descriptor and process start identity on the worker, and carry
framed native bytes over SSH. There is no public listener and no SSH key or
credential changes. Provider and Claude environment variables are forwarded;
allocation resource variables, HOME and PATH come from the backend. Put other
environment customization in Claude settings or the batch environment.

The panel's native control requests pass unchanged, including permissions and
SDK MCP messages. The terminal CLI's separate localhost IDE discovery port
cannot be reused on a different node; cross-node launches remove those port
variables. A localhost service configured in project MCP settings likewise
needs a reachable endpoint or a separately configured SSH forward.

Window reload, window close, Tunnel loss or a powered-off client never stops
native work: an interactive session lives until the Slurm allocation ends.
VS Code terminates the wrapper with SIGTERM/SIGHUP, and a vanished client
closes the wrapper's stdin before its connection drops. For interactive
(`--input-format stream-json`) sessions the wrapper and supervisor treat both,
like any connection loss, as a detach: native stdin stays open, so the CLI
never enters its print-mode wind-down (which kills background shells after a
fixed cap). A submitted turn and its background tasks continue, and output is
journaled. Reopening the same conversation reattaches the new window to that
process (its repeated SDK `initialize` is answered natively), so later turns
run in the same process; the new window's launch arguments are not reapplied.
Turn interruption uses the native control request and still works; client
signals (INT/TERM/HUP) only detach. One-shot (non-streaming) launches still receive EOF.
Detached sessions are not closed while the allocation runs. Each keeps its
memory, so close unneeded ones from a reattached window, or opt in to closing
idle ones (no submitted turn, no running background task) with
`CLAUDE_BACKEND_DETACH_GRACE_SECONDS` in the backend environment. If a resume
arrives while a process is finishing, it waits for its exit. A second window
cannot attach to a session that is still attached elsewhere. A lost connection
waiting for a permission/tool response remains pending until a window
reattaches and answers it; no approvals are invented.
Allocation expiry still ends its processes; saved native history remains.
Private append-only stdout/stderr journals and version/exit receipts are retained
under `~/.local/state/claude-backend/sessions/` for diagnosis.
