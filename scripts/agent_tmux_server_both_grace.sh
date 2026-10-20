#!/usr/bin/env bash
# Grace: Codex + Claude in one shared CPU allocation; no GPU/group partition.
# Both backend processes share one CPU; use one harness at a time.
#SBATCH --partition=week
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=1
#SBATCH --mem=8G
#SBATCH --time=7-00:00:00
#SBATCH --output=agent_tmux_server_both_grace_%j.out
#SBATCH --open-mode=append
#SBATCH --job-name=agent-both
set -euo pipefail
export PATH="$HOME/.local/share/pi-node/current/bin:$HOME/.local/bin:$PATH"
export CODEX_BACKEND_CLUSTER=grace
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
backend_root="${AGENT_BACKEND_SOURCE_ROOT:-${CODEX_BACKEND_ROOT:-}}"
if [[ -z "$backend_root" ]]; then
    if [[ "${1:-}" == check || -r "$script_root/scripts/claude_backend/allocation.sh" ]]; then
        backend_root="$script_root"
    elif [[ -n "${SLURM_JOB_ID:-}" ]]; then
        # sbatch runs a spool copy: BASH_SOURCE is not the submitted script.
        # Command retains the original script path (possibly relative to submit cwd).
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
[[ -r "$backend_root/scripts/claude_backend/allocation.sh" ]] || { echo "Invalid backend checkout: $backend_root" >&2; exit 2; }
project_default="$backend_root"
[[ "${1:-}" == check ]] || project_default="${SLURM_SUBMIT_DIR:-$backend_root}"
project="$(cd -- "${AGENT_BACKEND_PROJECT:-$project_default}" && pwd -P)"
exec bash "$backend_root/scripts/claude_backend/allocation.sh" both "$backend_root" "$project" "${1:-}"
