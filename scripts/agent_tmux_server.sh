#!/usr/bin/env bash
# ALLOW_SBATCH: this explicitly invoked, zero-GPU service is authorized by the user.
# The agent partition allows at most 2 concurrent jobs per user:
#   sbatch scripts/agent_tmux_tunnel.sh   # job 1: VS Code tunnel only
#   sbatch scripts/agent_tmux_server.sh   # job 2: codex backend only
# Both share the node when possible so the tunnel can reach the backend socket.
#SBATCH --partition=agent
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=1
#SBATCH --mem=8G
#SBATCH --time=7-00:00:00
#SBATCH --output=agent_tmux_server_%j.out
#SBATCH --open-mode=append
#SBATCH --job-name=agent-server
set -euo pipefail
project="$(cd -- "${SLURM_SUBMIT_DIR:-$(dirname -- "${BASH_SOURCE[0]}")/..}" && pwd -P)"
CODEX_BIN="$HOME/.npm-global/bin/codex"
[[ -n "${SLURM_JOB_ID:-}" ]] || { echo 'Submit with sbatch; run scripts/agent_tmux.sh check for local validation' >&2; exit 2; }
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
component_dir="$(bash "$project/scripts/codex_backend/setup.sh")"
node_bin="$(cat "$component_dir/node-path")"
sqlite_home="$("$node_bin" -e 'const C=require(process.argv[1]); console.log(C.privateDirectory(require("node:path").join(C.stateRoot(), "sqlite", C.hash(process.argv[2]) + "-agent")))' "$component_dir/common.cjs" "$project")"
printf -v server_command '%q ' bash "$component_dir/server-window.sh" "$component_dir" "$project" "$socket" "$descriptor" "$tmux_name" "$runtime/exit-code" "$log_file" "$sqlite_home"
tmux -L "$tmux_name" new-window -t agent -n backend -c "$project" "$server_command"
tmux -L "$tmux_name" wait-for backend-exited
[[ -f "$runtime/exit-code" ]] || { echo 'Backend exited without an exit receipt' >&2; exit 1; }
exit "$(cat "$runtime/exit-code")"
