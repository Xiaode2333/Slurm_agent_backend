#!/usr/bin/env bash
# Select an already installed Node 22 without relying on a terminal's PATH.
resolve_codex_node() {
    local candidate
    for candidate in "$(command -v node || true)" \
        "$HOME/.local/share/prime-agent-node/current/bin/node"; do
        if [[ -x "$candidate" && "$("$candidate" --version)" == v22.* ]]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    echo 'Node 22 is unavailable in PATH and the managed user installation' >&2
    return 2
}

node_bin="$(resolve_codex_node)" || return 2
export PATH="$(dirname -- "$node_bin"):$PATH"
