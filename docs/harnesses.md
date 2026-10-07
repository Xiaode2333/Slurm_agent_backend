# Native harness services

All services run in CPU Slurm allocations and reuse the harness's own installed
CLI, authentication, project configuration and session formats. The official
Codex sidebar continues to speak the Codex protocol; it is not a UI for Pi,
OpenCode or Claude Code.

| Harness | Default interface | Optional automation |
| --- | --- | --- |
| OpenCode | Authenticated loopback HTTP server and native `opencode attach` | Native REST/SSE APIs |
| Pi | Its TUI inside an allocation-specific tmux server | Persistent `--mode rpc` JSONL broker |
| Claude Code | Its TUI inside an allocation-specific tmux server | Persistent stream-json broker |

## Submit and attach

Install and authenticate the desired CLI first. Node 22, npm, tmux and the
normal Slurm tools must be available. From this checkout:

```bash
export AGENT_BACKEND_SOURCE_ROOT="$PWD"
bash scripts/agent_backend.sh check opencode
sbatch --partition=YOUR_CPU_PARTITION --account=YOUR_ACCOUNT --qos=YOUR_QOS scripts/agent_service_slurm.sh opencode /absolute/project native
```

The examples request two CPUs, 8 GiB, seven days and no GPU; adjust partition,
account/QOS and time for your site. `AGENT_BACKEND_SOURCE_ROOT` is important when
submitting from another directory because Slurm copies the batch script.

From a terminal on the service's node:

```bash
bash /absolute/Slurm_agent_backend/scripts/agent_backend.sh status opencode /absolute/project
bash /absolute/Slurm_agent_backend/scripts/agent_backend.sh attach opencode /absolute/project
```

Use `pi` or `claude-code` in the same commands for native TUI services.
Detach a native tmux client with **Ctrl-B D**; closing the client leaves its
process running. OpenCode clients attach to the same server and can run
different conversations. Native Pi/Claude tmux clients see the same terminal;
submit another allocation for an independent simultaneous session.

OpenCode uses one user-wide service lease because its native SQLite state is
shared across projects. Attach another project with its own directory to the
same server; a second OpenCode service fails rather than opening the same WAL
on another node.

If multiple services match, set `AGENT_BACKEND_JOB=JOB_ID`. Descriptors are
private, validated by hostname and process start identity, and never route to
another user's process. These tools intentionally require the same node; enter
an existing allocation using your cluster's `srun --jobid=... --overlap --pty`
workflow. Cancel only the service's own allocation to stop it.

## Pi and Claude Code JSONL clients

Select `rpc` mode at submission. CLI arguments after the mode are forwarded
as an argument array, including native session-resume/model options:

```bash
sbatch --partition=YOUR_CPU_PARTITION scripts/agent_service_slurm.sh pi /absolute/project rpc
sbatch --partition=YOUR_CPU_PARTITION scripts/agent_service_slurm.sh claude-code /absolute/project rpc --resume NATIVE_SESSION_ID
bash scripts/agent_backend.sh attach pi /absolute/project --from 0
```

The attach client's stdin takes the harness's **native** JSONL records. Its
stdout contains an attachment acknowledgement and `{seq, record}` envelopes;
`record` is the unchanged native event/response. For Pi, a read-only probe is:

```json
{"id":"state","type":"get_state"}
```

One client owns input at a time, preventing competing prompts or approval
responses. Other clients may attach with `--read-only`. Disconnecting the input
owner leaves harness stdin open and permits another owner to reconnect. A new
owner must explicitly choose what to send; the broker never replays commands or
creates approvals. A read-only observer cannot send native input.

The broker keeps a bounded replay buffer and an append-only private event
journal. `--from N` requests events after sequence N. An acknowledgement with
`replayGap: true` means older events require the journal identified there; the
client must not treat the in-memory tail as complete history. A slow observer
is disconnected before it stalls every other client. The journal's own
backpressure is respected to avoid dropping evidence.

Pi and Claude keep their native session persistence enabled. Broker sequence
numbers are scoped to one service lifetime; use native session resume after a
new allocation. Normal harness permissions remain in effect. CLI stream mode
can have different permission/prompt behavior from the TUI, so use native mode
when you need the harness's full interactive interface.

## Protocol references

- [OpenCode server](https://opencode.ai/docs/server/) and [native attach](https://opencode.ai/docs/cli/#attach)
- [Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [Claude Code CLI](https://code.claude.com/docs/en/cli-reference) and [programmatic operation](https://code.claude.com/docs/en/headless)

The installed CLI's `--help` is the version-specific contract. The local
environment checked OpenCode 1.18.35, Pi 1.0.3 and Claude Code 2.1.291.
