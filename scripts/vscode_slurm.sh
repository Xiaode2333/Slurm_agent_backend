#!/usr/bin/env bash
# Standalone VS Code Tunnel; the Codex launcher already starts its own Tunnel.
#SBATCH --partition=priority
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
vscode_bin="$HOME/.local/share/vscode-cli/1.140.0/code"
[[ -x "$vscode_bin" ]] || { echo "missing $vscode_bin" >&2; exit 2; }
[[ -n "${SLURM_JOB_ID:-}" ]] || { echo 'Submit with sbatch' >&2; exit 2; }
printf 'VSCODE_ALLOCATION job=%s node=%s\n' "$SLURM_JOB_ID" "$(hostname)"
exec bash "$project/scripts/codex_backend/tunnel-window.sh" "$vscode_bin" "$project/vscode_slurm.out"
