#!/usr/bin/env bash
# Native harness services, with no GPU request.
#SBATCH --partition=priority
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=2
#SBATCH --mem=8G
#SBATCH --time=7-00:00:00
#SBATCH --output=agent_slurm.out
#SBATCH --open-mode=append
#SBATCH --job-name=agent-backend
set -euo pipefail
source_root="${AGENT_BACKEND_SOURCE_ROOT:-${SLURM_SUBMIT_DIR:-$(dirname -- "${BASH_SOURCE[0]}")/..}}"
source_root="$(cd -- "$source_root" && pwd -P)"
[[ -f "$source_root/scripts/codex_backend/setup.sh" ]] || { echo 'Set AGENT_BACKEND_SOURCE_ROOT to this checkout before sbatch' >&2; exit 2; }
[[ -n "${SLURM_JOB_ID:-}" ]] || { echo 'Submit with sbatch' >&2; exit 2; }
[[ $# -ge 2 ]] || { echo 'Usage: agent_service_slurm.sh HARNESS PROJECT [native|rpc] [CLI arguments...]' >&2; exit 2; }
component="$(bash "$source_root/scripts/codex_backend/setup.sh")"
node_bin="$(cat "$component/node-path")"
exec "$node_bin" "$component/harness.cjs" serve "$@"
