#!/usr/bin/env bash
# Shared supervisor for the Claude-only and combined allocations.
set -euo pipefail
mode="$1"; backend_root="$2"; project="$3"
source "$backend_root/scripts/codex_backend/runtime.sh"
for tool in tmux flock zip; do command -v "$tool" >/dev/null; done
"$node_bin" -e 'const C=require(process.argv[1]); console.log("Claude Code " + C.cliVersion(C.cliPath()))' "$backend_root/scripts/claude_backend/common.cjs"
if [[ "$mode" == both ]]; then
    "$node_bin" -e 'console.log("Codex CLI " + require(process.argv[1]).checkCli())' "$backend_root/scripts/codex_backend/common.cjs"
fi
if [[ "${4:-}" == check ]]; then
    echo "PASS $mode backend: one CPU, 8 GiB, seven days, zero GPU; project=$project"
    exit 0
fi
[[ -n "${SLURM_JOB_ID:-}" ]] || { echo 'Submit with sbatch, or use check for scheduler-neutral validation' >&2; exit 2; }
runtime="$(mktemp -d "${SLURM_TMPDIR:-/tmp}/agent-${SLURM_JOB_ID}-${mode}.XXXXXXXX")"
chmod 700 "$runtime"
tmux_name="agent-${SLURM_JOB_ID}-${mode}"
log="$project/agent_tmux_server_${mode}_${SLURM_JOB_ID}.out"
waiters=()
cleanup() {
    status=$?
    trap - EXIT
    printf 'AGENT_STOP job=%s mode=%s allocation_exit=%s\n' "$SLURM_JOB_ID" "$mode" "$status" >> "$log"
    for waiter in "${waiters[@]}"; do kill "$waiter" 2>/dev/null || true; done
    # Only this allocation's tmux server is touched.
    tmux -L "$tmux_name" kill-server 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP
printf 'AGENT_ALLOCATION job=%s mode=%s node=%s tmux=%s\n' "$SLURM_JOB_ID" "$mode" "$(hostname)" "$tmux_name" | tee -a "$log"
tmux -L "$tmux_name" new-session -d -s agent -n admin -c "$project" 'exec bash --noprofile --norc'
tmux -L "$tmux_name" set-option -g remain-on-exit on
echo "Attach: tmux -L $tmux_name attach -t agent"
claude_component="$(bash "$backend_root/scripts/claude_backend/setup.sh")"
claude_descriptor="$HOME/.local/state/claude-backend/backends/$(hostname)-${SLURM_JOB_ID}.json"
# Register waiters before starting workers; a fast failure cannot strand the allocation.
(tmux -L "$tmux_name" wait-for claude-exited; tmux -L "$tmux_name" wait-for -S service-exited) &
waiters+=("$!")
printf -v command '%q ' bash "$claude_component/server-window.sh" "$claude_component" "$project" "$runtime/claude.sock" "$claude_descriptor" "$tmux_name" "$runtime/claude-exit" "$log"
tmux -L "$tmux_name" new-window -t agent -n claude-backend -c "$project" "$command"
if [[ "$mode" == both ]]; then
    codex_component="$(bash "$backend_root/scripts/codex_backend/setup.sh")"
    sqlite_home="$("$node_bin" -e 'const C=require(process.argv[1]); console.log(C.privateDirectory(require("node:path").join(C.stateRoot(), "sqlite", C.hash(process.argv[2]) + "-agent")))' "$codex_component/common.cjs" "$project")"
    codex_descriptor="$HOME/.local/state/codex-backend/backends/$(hostname)-${SLURM_JOB_ID}.json"
    (tmux -L "$tmux_name" wait-for backend-exited; tmux -L "$tmux_name" wait-for -S service-exited) &
    waiters+=("$!")
    printf -v command '%q ' bash "$codex_component/server-window.sh" "$codex_component" "$project" "$runtime/codex.sock" "$codex_descriptor" "$tmux_name" "$runtime/codex-exit" "$log" "$sqlite_home"
    tmux -L "$tmux_name" new-window -t agent -n codex-backend -c "$project" "$command"
fi
tmux -L "$tmux_name" wait-for service-exited &
service_waiter=$!
waiters+=("$service_waiter")
# Bash builtin wait is signal-interruptible; a foreground tmux wait would defer TERM traps.
wait "$service_waiter"
for result in "$runtime/claude-exit" "$runtime/codex-exit"; do
    if [[ -f "$result" ]]; then
        status="$(cat "$result")"
        echo "Backend exited: $result code=$status" >&2
        # Both are persistent services: even an early clean exit is a failure.
        [[ "$status" != 0 ]] || status=1
        exit "$status"
    fi
done
echo 'Service exited without an exit receipt' >&2
exit 1
