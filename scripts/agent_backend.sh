#!/usr/bin/env bash
set -euo pipefail
source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
component="$(bash "$source_root/scripts/codex_backend/setup.sh")"
node_bin="$(cat "$component/node-path")"
exec "$node_bin" "$component/harness.cjs" "$@"
