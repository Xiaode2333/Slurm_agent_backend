#!/usr/bin/env bash
# Connect the official Claude Code extension; never submit or start a supervisor.
set -euo pipefail
source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
project="$(pwd -P)"
if [[ "${1:-}" == --project ]]; then
    [[ $# -ge 2 ]] || { echo '--project requires a directory' >&2; exit 2; }
    project="$(cd -- "$2" && pwd -P)"; shift 2
fi
if [[ "${1:-}" == check ]]; then
    exec bash "$source_root/scripts/agent_tmux_server_claude.sh" check
fi
component="$(bash "$source_root/scripts/claude_backend/setup.sh")"
node_bin="$(cat "$component/node-path")"
exec "$node_bin" "$component/connect.cjs" "$project" "${1:-connect}"
