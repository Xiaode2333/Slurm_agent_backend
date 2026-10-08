#!/usr/bin/env bash
# Run locally, in the caller's Python environment; never submit or use CI.
set -euo pipefail
source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$source_root/scripts/codex_backend/runtime.sh"
python_executable="${AGENT_TEST_PYTHON:-python}"
cd "$source_root"
command -v npm tmux "$python_executable" >/dev/null
npm ci --ignore-scripts --prefer-offline --no-audit --no-fund --prefix scripts/codex_backend
for file in scripts/codex_backend/*.cjs scripts/codex_backend/helper/*.cjs scripts/codex_backend/test/*.cjs; do
    "$node_bin" --check "$file"
done
while IFS= read -r -d '' file; do bash -n "$file"; done < <(find scripts -name '*.sh' -print0)
"$python_executable" -m compileall -q tests/python
npm test --prefix scripts/codex_backend
"$python_executable" -m pytest -q tests/python
echo 'PASS local backend syntax/compilation and regression checks'
