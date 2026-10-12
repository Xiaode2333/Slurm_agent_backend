#!/usr/bin/env bash
# ALLOW_SBATCH: explicitly invoked Codex + Claude service in one CPU allocation.
# Both backend processes share one CPU; use one harness at a time.
#SBATCH --partition=agent
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=1
#SBATCH --mem=8G
#SBATCH --time=7-00:00:00
#SBATCH --output=agent_tmux_server_both_%j.out
#SBATCH --open-mode=append
#SBATCH --job-name=agent-both
set -euo pipefail
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ "${1:-}" == check ]]; then
    backend_root="${AGENT_BACKEND_SOURCE_ROOT:-$script_root}"
else
    backend_root="${AGENT_BACKEND_SOURCE_ROOT:-${SLURM_SUBMIT_DIR:-$script_root}}"
fi
backend_root="$(cd -- "$backend_root" && pwd -P)"
project="$(cd -- "${AGENT_BACKEND_PROJECT:-$backend_root}" && pwd -P)"
exec bash "$backend_root/scripts/claude_backend/allocation.sh" both "$backend_root" "$project" "${1:-}"
