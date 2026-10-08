#!/usr/bin/env bash
# Grace standalone VS Code Tunnel; connect separately to a local/SSH backend.
# Shared CPU partition by default; site account/QOS may be supplied to sbatch.
#SBATCH --partition=week
# Set your site account/QOS with sbatch --account=... --qos=... if required.
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=1
#SBATCH --time=7-00:00:00
#SBATCH --mem=32G
#SBATCH --output=vscode_slurm.out
#SBATCH --open-mode=append
#SBATCH --job-name=vscode
set -euo pipefail
project="$(cd -- "${SLURM_SUBMIT_DIR:-$(dirname -- "${BASH_SOURCE[0]}")/..}" && pwd -P)"
export PATH="$HOME/.local/share/pi-node/current/bin:$HOME/.local/bin:$PATH"
export CODEX_BACKEND_CLUSTER=grace
vscode_bin="${VSCODE_BIN:-/vast/palmer/apps/avx2/software/VSCode/1.96.4/bin/code}"
[[ -x "$vscode_bin" ]] || { echo "missing $vscode_bin" >&2; exit 2; }
[[ -n "${SLURM_JOB_ID:-}" ]] || { echo 'Submit with sbatch' >&2; exit 2; }
printf 'VSCODE_ALLOCATION job=%s node=%s\n' "$SLURM_JOB_ID" "$(hostname)"
exec bash "$project/scripts/codex_backend/tunnel-window.sh" "$vscode_bin" "$project/vscode_slurm.out"
