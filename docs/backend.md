# Persistent Codex backend

The supported backend runs inside a seven-day CPU allocation independently of
the official Codex sidebar, terminal UI and automatically started VS Code Tunnel.
It uses the existing login, configuration and persistent rollout storage.
The compatibility target is Codex CLI 0.160.1 and official extension
26.930.61225. The CLI is always `$HOME/.npm-global/bin/codex`.

## Start the allocation

From the repository root:

```bash
bash scripts/codex_server_slurm.sh check
sbatch scripts/codex_server_slurm.sh
```

The example requests `priority`, two CPUs,
32 GiB, seven days and zero GPUs. Backend output appends to `codex_slurm.out`; Tunnel startup,
connection information, stdout and stderr append separately to `vscode_slurm.out`.
Both logs identify their allocation at startup. `check` is scheduler-neutral.
The Tunnel starts from a private allocation-local script snapshot before
backend component installation and Node/npm startup. Those operations can take
minutes on cold shared storage; they no longer delay the device-login prompt.
Replace the partition in the batch scripts with a CPU partition available at your site.
Supply account and QOS flags to `sbatch` if your cluster requires them.
The `check` command validates local dependencies; it does not validate site scheduling policy.

The Tunnel reuses saved credentials. If no readable credentials exist, watch
`vscode_slurm.out` for the GitHub device-login URL and code and complete the login
in your browser. The Tunnel then starts and writes its connection URL to that
log. Terminal input and interactive menus are disabled, and server license terms
are accepted on the command line, so startup requires no tmux interaction.
The `vscode` window checks `code tunnel user show`, runs device login only when
needed, verifies that the saved credentials can be read, then starts the Tunnel:

```bash
$HOME/.local/share/vscode-cli/1.140.0/code tunnel user login --provider github # only if needed
$HOME/.local/share/vscode-cli/1.140.0/code tunnel --accept-server-license-terms
```

Startup stages are written to the Tunnel log. The window keeps an unused
terminal descriptor open so tmux does not hang up the process when its input
and output streams are redirected; browser login still requires no terminal input.

Credentials use file storage under `${VSCODE_CLI_DATA_DIR:-$HOME/.vscode/cli}`.
The window sets `VSCODE_CLI_USE_FILE_KEYCHAIN=1`,
`VSCODE_CLI_DISABLE_KEYCHAIN_ENCRYPT=1` and `VSCODE_CLI_NONINTERACTIVE=1`.
VS Code's default token encryption uses the hostname, so an encrypted token
written on another node may require one browser login to replace it. New tokens
are stored without hostname encryption in a mode-600 file inside a mode-700
directory, allowing later allocations to reuse them across nodes. A revoked or
expired token can still require browser authentication.

For optional debugging, the startup output gives the node and allocation-specific
tmux server. Enter the allocation using `srun --jobid=<job-id> --overlap --pty bash`,
then attach using `tmux -L codex-<job-id> attach -t codex`. Windows are `server`,
`vscode` and `admin`.

There is no automatic Tunnel restart. The backend exit ends
the batch job; keeping an empty tmux shell alive does not retain the allocation.
`VSCODE_STOP` in the Tunnel log records the allocation's exit status, including
backend startup failures that interrupt an outstanding device login. Backend
startup stages appear in `codex_slurm.out`; the CLI version probe allows up to
120 seconds for a cold launch and still requires the exact supported version.
For a standalone Tunnel, use [the Tunnel launcher](../scripts/vscode_slurm.sh).

## Connect the official sidebar

Open this project through the Tunnel, then run in its integrated terminal:

```bash
bash ./scripts/connect_codex_backend.sh
```

The command discovers the backend for the current allocation and canonical
project path, validates its process identity and socket, installs private
connection components and a small workspace helper extension, and applies the
official `chatgpt.cliExecutable` setting. The helper uses VS Code's configuration and command APIs. Because the official override is application-scoped, one dispatcher resolves private bindings by hostname and extension-host process identity; each project/window retains its own backend. First connection may
reload the window once. Repeated connections to the same backend do not reload.
The command **Codex Backend: Show Connection Status** reports live relay evidence.
The helper restores its per-host binding during eager activation before the
official extension's startup event; otherwise the shared dispatcher would start
an unbound local CLI during reload.
Restored chat views can activate even earlier; the dispatcher allows a bounded
five-second wait for the helper's explicit per-host decision. A registered
unbound window chooses the normal CLI immediately.
**Codex Backend: Use Local Codex in This Window** unbinds only the current window;
the shared dispatcher stays configured for other windows. Unbound windows use the normal CLI.
When upgrading an already active single-project helper in another project,
run **Developer: Reload Window** once after installation and repeat the
connection command. The old helper cannot apply a shared-project binding;
the connector identifies this migration case explicitly.

An already running Tunnel in another allocation can connect when it is on the backend's node and there is a unique valid backend there.
One backend may serve several projects. Run the connector from the intended
project directory, or pass `--project DIR`. A registered
backend in the terminal's own allocation takes precedence. Multiple node/project
candidates produce an error. A Tunnel on another node cannot reach the Unix socket.

Success requires a real official-extension initialize response and a successful
sidebar thread-list request through the relay. The command then prints the
allocation, backend PID and bounded history-page counts from the real sidebar receipt. `sessions=>=N`
indicates pagination, and `active_on_page` is not a total active-session count. A direct
socket probe alone does not qualify. A missing backend, stale descriptor,
incompatible version or ambiguous match produces an error and starts no backend.

The sidebar's normal history list includes CLI, VS Code and app-server-created
conversations. Open a running conversation there to resume its original thread
and receive subsequent notifications; history search/pagination remain native.
Default source filters are expanded to include app-server threads, while explicit
filters are preserved. Equivalent project symlink paths are normalized. The relay
does not create a turn when listing or resuming a thread.
New threads and one-shot commands that omit a working directory use the
connecting window's project; a resumed thread retains its own directory.

For terminal access, use the socket URL printed in the startup output:

```bash
$HOME/.npm-global/bin/codex --remote unix://<socket-path>
$HOME/.npm-global/bin/codex resume <thread-id> --remote unix://<socket-path>
```

## Lifecycle and private state

Unix sockets are node-local and user-private. Backend descriptors, helper
registrations and connection receipts live in the private user directory
`$HOME/.local/state/codex-backend`. Immutable component copies share an integrity-checked dependency cache and live
under `$HOME/.local/share/codex-backend`; npm uses the committed lock file and
does not run dependency scripts. Runtime state, packaged extensions and
dependencies are excluded from Git.
A Tunnel Welcome window can connect through a terminal whose current directory
is the project, even without an open workspace folder. Terminal ownership is
matched by process identity as well as its CLI hook, including hooks replaced
by shell integration. Other windows retain their own registrations.
Installation selects Node 22 from the terminal PATH or the existing managed
user installation, so a different terminal Node version needs no path override.

SQLite indexes and goals work in the allocation's private node-local directory.
An exclusive lock owns the durable namespace under
`~/.local/state/codex-backend/sqlite/`. Consistent SQLite backup snapshots are saved
every 60 seconds and again at graceful exit, then restored at next startup.
Original durable databases are preserved separately from the snapshots. Shared
rollouts remain persistent. Abrupt node loss/SIGKILL can lose up to one backup
interval of SQLite-only state; this is not a promise of lossless process migration.
Existing allocations keep their current storage until a new allocation is started.

Closing a client disconnects only that client. Explicit stop requests are
forwarded normally. Approval/input requests retain the backend's policy; the
connector never supplies invented approvals or answers. Standalone client-owned
commands and tools can have their own disconnect behavior, distinct from an
assistant turn running on the backend.

Cancel the allocation explicitly to stop the service. There is no renewal or
cross-node migration. Persistent history can be resumed after a new allocation;
an interrupted process is not promised to resume continuously. Do not update
the CLI during an allocation. An extension or CLI upgrade requires compatibility
verification before connection; the development-only CLI override is not an
official external-endpoint setting.

## Fast history and diagnosis

Default relay history requests use the state index and do not scan/repair rollout
files on each page. Explicit `useStateDbOnly:false` is preserved. To import
new history produced by a separate local CLI or refresh historical path aliases:

```bash
bash scripts/connect_codex_backend.sh refresh-history
bash scripts/connect_codex_backend.sh status
bash scripts/connect_codex_backend.sh doctor
```

Status separates backend availability from proof of this window's actual relay.
Doctor adds a bounded initialize probe without scanning thread history.

## Verification

```bash
npm ci --ignore-scripts --prefix scripts/codex_backend
npm test --prefix scripts/codex_backend
python -m pytest -q tests/python/test_codex_backend.py
find scripts -name "*.sh" -exec bash -n {} \;
```

Node regression tests exercise real Unix WebSocket sockets, pagination and live
status, split UTF-8, large frames, server requests, disconnect errors, descriptor
ambiguity, helper settings/reload/restore and repeat connections. Passing transport tests alone does not establish sidebar or Tunnel acceptance.
Observed behavior and remaining coverage are summarized in the
[acceptance note](ACCEPTANCE.md).
