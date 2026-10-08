#!/usr/bin/env bash
# ALLOW_SBATCH: this explicitly invoked, zero-GPU service is authorized by the user.
# The agent partition allows at most 2 concurrent jobs per user:
#   sbatch scripts/agent_tmux_tunnel.sh   # job 1: VS Code tunnel only
#   sbatch scripts/agent_tmux_server.sh   # job 2: codex backend only
# Cross-node clients use authenticated SSH Unix-socket forwarding.
#SBATCH --partition=agent
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=1
#SBATCH --mem=8G
#SBATCH --time=7-00:00:00
#SBATCH --output=agent_tmux_tunnel_%j.out
#SBATCH --open-mode=append
#SBATCH --job-name=agent-tunnel
set -euo pipefail
project="$(cd -- "${SLURM_SUBMIT_DIR:-$(dirname -- "${BASH_SOURCE[0]}")/..}" && pwd -P)"
VSCODE_BIN="$HOME/.local/share/vscode-cli/1.140.0/code"
[[ -n "${SLURM_JOB_ID:-}" ]] || { echo 'Submit with sbatch; run scripts/agent_tmux.sh check for local validation' >&2; exit 2; }
runtime="$(mktemp -d "${SLURM_TMPDIR:-/tmp}/agent-${SLURM_JOB_ID}.XXXXXXXX")"
chmod 700 "$runtime"
tmux_name="agent-${SLURM_JOB_ID}"
log_file="$project/vscode_slurm.out"
cleanup() {
    local status=$?
    printf 'VSCODE_STOP job=%s allocation_exit=%s; stopping tunnel with allocation\n' "$SLURM_JOB_ID" "$status" >> "$log_file"
    tmux -L "$tmux_name" kill-server 2>/dev/null || true
}
trap cleanup EXIT
printf 'VSCODE_ALLOCATION job=%s node=%s cli=%s tmux=%s\n' "$SLURM_JOB_ID" "$(hostname)" "$VSCODE_BIN" "$tmux_name" >> "$log_file"
# Retain the pane's exit receipt; an idle admin window must not keep a dead
# service allocation alive. A historical log entry is not a live tunnel owner.
cp "$project/scripts/codex_backend/tunnel-window.sh" "$runtime/tunnel-window.sh"
printf -v tunnel_command '%q ' bash "$runtime/tunnel-window.sh" "$VSCODE_BIN" "$log_file"
tmux -L "$tmux_name" new-session -d -s agent -n vscode -c "$project" "$tunnel_command"
tmux -L "$tmux_name" set-option -g remain-on-exit on
tmux -L "$tmux_name" new-window -t agent -n admin -c "$project" 'exec bash --noprofile --norc'
echo "Attach: tmux -L $tmux_name attach -t agent"
while true; do
    pane="$(tmux -L "$tmux_name" display-message -p -t agent:vscode '#{pane_dead}:#{pane_dead_status}:#{pane_dead_signal}')" || {
        echo 'Tunnel pane disappeared without an exit receipt' >&2
        exit 1
    }
    if [[ "$pane" == 1:* ]]; then
        IFS=: read -r dead status signal <<< "$pane"
        if [[ -n "$signal" ]]; then status=$((128 + signal)); fi
        [[ "$status" =~ ^[0-9]+$ ]] || status=1
        printf 'TUNNEL_EXIT job=%s status=%s\n' "$SLURM_JOB_ID" "$status"
        printf '%s\n' "$status" > "$runtime/exit-code"
        exit "$status"
    fi
    sleep 30
done
