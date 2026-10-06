#!/usr/bin/env bash
# ALLOW_SBATCH: this explicitly invoked, zero-GPU service is authorized by the user.
# Use sbatch scripts/codex_server_slurm.sh; check is scheduler-neutral.
#SBATCH --partition=priority
# Set your site account/QOS with sbatch --account=... --qos=... if required.
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=2
#SBATCH --mem=32G
#SBATCH --time=7-00:00:00
#SBATCH --output=codex_slurm.out
#SBATCH --open-mode=append
#SBATCH --job-name=codex-backend
set -euo pipefail
project="$(cd -- "${SLURM_SUBMIT_DIR:-$(dirname -- "${BASH_SOURCE[0]}")/..}" && pwd -P)"
CODEX_BIN="$HOME/.npm-global/bin/codex"
VSCODE_BIN="$HOME/.local/share/vscode-cli/1.140.0/code"
if [[ "${1:-}" == check ]]; then
    source "$project/scripts/codex_backend/runtime.sh"
    [[ -x "$CODEX_BIN" ]] || { echo "missing $CODEX_BIN" >&2; exit 2; }
    [[ "$("$CODEX_BIN" --version)" == 'codex-cli 0.160.1' ]] || { echo 'CLI version mismatch' >&2; exit 2; }
    command -v tmux node npm flock zip >/dev/null
    [[ "$(node --version)" == v22.* ]] || { echo 'Node 22 required' >&2; exit 2; }
    echo 'PASS codex backend: site-configured partition/account/QOS, 2 CPU, 32 GiB, seven days, zero GPU'
    exit 0
fi
[[ -n "${SLURM_JOB_ID:-}" ]] || { echo 'Submit with sbatch; use check for local validation' >&2; exit 2; }
runtime="$(mktemp -d "${SLURM_TMPDIR:-/tmp}/codex-${SLURM_JOB_ID}.XXXXXXXX")"
chmod 700 "$runtime"
socket="$runtime/app.sock"
descriptor="$HOME/.local/state/codex-backend/backends/$(hostname)-${SLURM_JOB_ID}.json"
tmux_name="codex-${SLURM_JOB_ID}"
log_file="$project/codex_slurm.out"
tunnel_log_file="$project/vscode_slurm.out"
cleanup() {
    local status=$?
    printf 'VSCODE_STOP job=%s allocation_exit=%s; stopping tunnel with allocation\n' "$SLURM_JOB_ID" "$status" >> "$tunnel_log_file"
    tmux -L "$tmux_name" kill-server 2>/dev/null || true
}
trap cleanup EXIT
printf 'CODEX_ALLOCATION job=%s node=%s cli=%s tmux=%s\n' "$SLURM_JOB_ID" "$(hostname)" "$CODEX_BIN" "$tmux_name"
tmux -L "$tmux_name" new-session -d -s codex -n admin -c "$project" 'exec bash --noprofile --norc'
tmux -L "$tmux_name" set-option -g remain-on-exit on
printf 'VSCODE_ALLOCATION job=%s node=%s cli=%s tmux=%s\n' "$SLURM_JOB_ID" "$(hostname)" "$VSCODE_BIN" "$tmux_name" >> "$tunnel_log_file"
# Start a private snapshot immediately, before Node/npm/backend installation.
cp "$project/scripts/codex_backend/tunnel-window.sh" "$runtime/tunnel-window.sh"
printf -v tunnel_command '%q ' bash "$runtime/tunnel-window.sh" "$VSCODE_BIN" "$tunnel_log_file"
tmux -L "$tmux_name" new-window -t codex -n vscode -c "$project" "$tunnel_command"
echo "Attach: tmux -L $tmux_name attach -t codex"
echo 'BACKEND_STARTUP installing connection components; tunnel starts independently'
component_dir="$(bash "$project/scripts/codex_backend/setup.sh")"
node_bin="$(cat "$component_dir/node-path")"
sqlite_home="$("$node_bin" -e 'const C=require(process.argv[1]); console.log(C.privateDirectory(require("node:path").join(C.stateRoot(), "sqlite", C.hash(process.argv[2]))))' "$component_dir/common.cjs" "$project")"
printf -v server_command '%q ' bash "$component_dir/server-window.sh" "$component_dir" "$project" "$socket" "$descriptor" "$tmux_name" "$runtime/exit-code" "$log_file" "$sqlite_home"
tmux -L "$tmux_name" new-window -t codex -n server -c "$project" "$server_command"
tmux -L "$tmux_name" wait-for backend-exited
[[ -f "$runtime/exit-code" ]] || { echo 'Backend exited without an exit receipt' >&2; exit 1; }
exit "$(cat "$runtime/exit-code")"
