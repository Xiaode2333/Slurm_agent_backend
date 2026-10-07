#!/usr/bin/env bash
# Connect the current Tunnel window; never submit or start an app-server.
set -euo pipefail
source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
project="$(pwd -P)"
if [[ "${1:-}" == --project ]]; then
    [[ $# -ge 2 ]] || { echo '--project requires a directory' >&2; exit 2; }
    project="$(cd -- "$2" && pwd -P)"
    shift 2
fi
if [[ "${1:-}" == check ]]; then
    exec bash "$source_root/scripts/codex_server_slurm.sh" check
fi
if [[ "${1:-connect}" == connect ]]; then
    [[ -n "${VSCODE_IPC_HOOK_CLI:-}" ]] || { echo 'Run this command in the VS Code Tunnel integrated terminal' >&2; exit 2; }
fi
component_dir="$(bash "$source_root/scripts/codex_backend/setup.sh")"
node_bin="$(cat "$component_dir/node-path")"
exec "$node_bin" "$component_dir/connect.cjs" "$project" "${1:-connect}"
