#!/usr/bin/env bash
# Connect the current Tunnel window; never submit or start an app-server.
set -euo pipefail
project="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ "${1:-}" == check ]]; then
    exec bash "$project/scripts/codex_server_slurm.sh" check
fi
[[ -n "${VSCODE_IPC_HOOK_CLI:-}" ]] || { echo 'Run this command in the VS Code Tunnel integrated terminal' >&2; exit 2; }
component_dir="$(bash "$project/scripts/codex_backend/setup.sh")"
node_bin="$(cat "$component_dir/node-path")"
exec "$node_bin" "$component_dir/connect.cjs" "$project" "${1:-connect}"
