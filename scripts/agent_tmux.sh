#!/usr/bin/env bash
# Agent-partition launcher for the two codex backend services.
# The agent partition allows at most 2 concurrent jobs per user, so the
# services live in two separate batch jobs (one each), submitted together:
#   sbatch scripts/agent_tmux_tunnel.sh
#   sbatch scripts/agent_tmux_server.sh
# Both use partition agent, 1 CPU, 8 GiB, 7 days, zero GPU.
# check is scheduler-neutral: ./scripts/agent_tmux.sh check
set -euo pipefail
project="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
CODEX_BIN="$HOME/.npm-global/bin/codex"
if [[ "${1:-}" != check ]]; then
    echo "usage: agent_tmux.sh check" >&2
    echo 'To submit the two services:' >&2
    echo '  sbatch scripts/agent_tmux_tunnel.sh' >&2
    echo '  sbatch scripts/agent_tmux_server.sh' >&2
    exit 2
fi
source "$project/scripts/codex_backend/runtime.sh"
[[ -x "$CODEX_BIN" ]] || { echo "missing $CODEX_BIN" >&2; exit 2; }
[[ "$("$CODEX_BIN" --version)" == 'codex-cli 0.160.1' ]] || { echo 'CLI version mismatch' >&2; exit 2; }
for dependency in tmux node npm flock zip; do
    command -v "$dependency" >/dev/null || { echo "missing $dependency" >&2; exit 2; }
done
[[ "$(node --version)" == v22.* ]] || { echo 'Node 22 required' >&2; exit 2; }
echo 'PASS agent tmux: partition agent, 2 jobs (agent_tmux_tunnel.sh + agent_tmux_server.sh), 1 CPU, 8 GiB, seven days, zero GPU'
exit 0
