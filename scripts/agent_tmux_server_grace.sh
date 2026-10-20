#!/usr/bin/env bash
# Grace Codex backend on the shared CPU partition; no GPU/group partition.
# Submit vscode_slurm_grace.sh separately for a Tunnel (SSH across nodes).
#SBATCH --partition=week
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=1
#SBATCH --mem=8G
#SBATCH --time=7-00:00:00
#SBATCH --output=agent_tmux_server_%j.out
#SBATCH --open-mode=append
#SBATCH --job-name=agent-server
set -euo pipefail
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
backend_root="${AGENT_BACKEND_SOURCE_ROOT:-${CODEX_BACKEND_ROOT:-}}"
if [[ -z "$backend_root" ]]; then
    if [[ "${1:-}" == check || -r "$script_root/scripts/codex_backend/setup.sh" ]]; then
        backend_root="$script_root"
    elif [[ -n "${SLURM_JOB_ID:-}" ]]; then
        # Recover the original script path, not Slurm's spool copy or project cwd.
        job_details="$(scontrol show job "$SLURM_JOB_ID")" || {
            echo 'Cannot resolve submitted script; set AGENT_BACKEND_SOURCE_ROOT' >&2; exit 2;
        }
        submitted_script="$(printf '%s\n' "$job_details" | awk '/^[[:space:]]*Command=/ {sub(/^[[:space:]]*Command=/, ""); print; exit}')"
        [[ -n "$submitted_script" && "$submitted_script" != '(null)' ]] || { echo 'Missing Slurm Command; set AGENT_BACKEND_SOURCE_ROOT' >&2; exit 2; }
        [[ "$submitted_script" == /* ]] || submitted_script="${SLURM_SUBMIT_DIR:?}/$submitted_script"
        backend_root="$(cd -- "$(dirname -- "$submitted_script")/.." && pwd -P)"
    else
        echo 'Cannot locate backend checkout; set AGENT_BACKEND_SOURCE_ROOT' >&2; exit 2
    fi
fi
backend_root="$(cd -- "$backend_root" && pwd -P)"
project_default="$backend_root"
[[ "${1:-}" == check ]] || project_default="${SLURM_SUBMIT_DIR:-$backend_root}"
project="$(cd -- "${AGENT_BACKEND_PROJECT:-$project_default}" && pwd -P)"
export PATH="$HOME/.local/share/pi-node/current/bin:$HOME/.local/bin:$PATH"
export CODEX_BACKEND_CLUSTER=grace
CODEX_BIN="${CODEX_BACKEND_CLI:-$HOME/.local/bin/codex}"
source "$backend_root/scripts/codex_backend/runtime.sh"
for tool in npm tmux flock zip; do
    command -v "$tool" >/dev/null || { echo "Missing required command: $tool" >&2; exit 2; }
done
[[ -f "$backend_root/scripts/codex_backend/setup.sh" ]] || { echo "Backend scripts not found: $backend_root" >&2; exit 2; }
[[ -x "$CODEX_BIN" ]] || { echo "Missing Codex CLI: $CODEX_BIN" >&2; exit 2; }
"$node_bin" -e 'console.log("Codex CLI " + require(process.argv[1]).checkCli())' "$backend_root/scripts/codex_backend/common.cjs"
if [[ "${1:-}" == check ]]; then
    echo "Grace backend prerequisites OK; project=$project"
    exit 0
fi
[[ -n "${SLURM_JOB_ID:-}" ]] || { echo "Submit with sbatch; use bash $backend_root/scripts/agent_tmux_server_grace.sh check for local validation" >&2; exit 2; }
runtime="$(mktemp -d "${SLURM_TMPDIR:-/tmp}/agent-${SLURM_JOB_ID}.XXXXXXXX")"
chmod 700 "$runtime"
socket="$runtime/app.sock"
descriptor="$HOME/.local/state/codex-backend/backends/$(hostname)-${SLURM_JOB_ID}.json"
tmux_name="agent-${SLURM_JOB_ID}"
log_file="$project/agent_tmux_server.out"
cleanup() {
    local status=$?
    printf 'AGENT_STOP job=%s mode=server allocation_exit=%s\n' "$SLURM_JOB_ID" "$status" >> "$log_file"
    tmux -L "$tmux_name" kill-server 2>/dev/null || true
}
trap cleanup EXIT
printf 'AGENT_ALLOCATION job=%s mode=server node=%s tmux=%s\n' "$SLURM_JOB_ID" "$(hostname)" "$tmux_name"
tmux -L "$tmux_name" new-session -d -s agent -n server -c "$project" 'exec bash --noprofile --norc'
tmux -L "$tmux_name" set-option -g remain-on-exit on
tmux -L "$tmux_name" new-window -t agent -n admin -c "$project" 'exec bash --noprofile --norc'
echo "Attach: tmux -L $tmux_name attach -t agent"
echo 'BACKEND_STARTUP installing connection components'
component_dir="$(bash "$backend_root/scripts/codex_backend/setup.sh")"
node_bin="$(cat "$component_dir/node-path")"
sqlite_home="$("$node_bin" -e 'const C=require(process.argv[1]); console.log(C.privateDirectory(require("node:path").join(C.stateRoot(), "sqlite", C.hash(process.argv[2]) + "-agent")))' "$component_dir/common.cjs" "$project")"
printf -v server_command '%q ' bash "$component_dir/server-window.sh" "$component_dir" "$project" "$socket" "$descriptor" "$tmux_name" "$runtime/exit-code" "$log_file" "$sqlite_home" "$project/agent_tmux_server_${SLURM_JOB_ID}.out"
tmux -L "$tmux_name" new-window -t agent -n backend -c "$project" "$server_command"
tmux -L "$tmux_name" wait-for backend-exited
[[ -f "$runtime/exit-code" ]] || { echo 'Backend exited without an exit receipt' >&2; exit 1; }
exit "$(cat "$runtime/exit-code")"
