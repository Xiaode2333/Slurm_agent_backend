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
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
backend_root="${AGENT_BACKEND_SOURCE_ROOT:-${CODEX_BACKEND_ROOT:-}}"
if [[ -z "$backend_root" ]]; then
    if [[ "${1:-}" == check || -r "$script_root/scripts/codex_backend/tunnel-window.sh" ]]; then
        backend_root="$script_root"
    elif [[ -n "${SLURM_JOB_ID:-}" ]]; then
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
[[ -r "$backend_root/scripts/codex_backend/tunnel-window.sh" ]] || { echo "Invalid backend checkout: $backend_root" >&2; exit 2; }
project_default="$backend_root"
[[ "${1:-}" == check ]] || project_default="${SLURM_SUBMIT_DIR:-$backend_root}"
project="$(cd -- "${AGENT_BACKEND_PROJECT:-$project_default}" && pwd -P)"
export PATH="$HOME/.local/share/pi-node/current/bin:$HOME/.local/bin:$PATH"
export CODEX_BACKEND_CLUSTER=grace
vscode_bin="${VSCODE_BIN:-/vast/palmer/apps/avx2/software/VSCode/1.96.4/bin/code}"
[[ -x "$vscode_bin" ]] || { echo "missing $vscode_bin" >&2; exit 2; }
if [[ "${1:-}" == check ]]; then
    echo "Grace Tunnel prerequisites OK; project=$project"
    exit 0
fi
[[ -n "${SLURM_JOB_ID:-}" ]] || { echo 'Submit with sbatch; use check for local validation' >&2; exit 2; }
printf 'VSCODE_ALLOCATION job=%s node=%s\n' "$SLURM_JOB_ID" "$(hostname)"
exec bash "$backend_root/scripts/codex_backend/tunnel-window.sh" "$vscode_bin" "$project/vscode_slurm.out"
