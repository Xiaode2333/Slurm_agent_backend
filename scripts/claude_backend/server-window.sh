#!/usr/bin/env bash
set -uo pipefail
component="$1"; project="$2"; socket="$3"; descriptor="$4"
tmux_name="$5"; result="$6"; log="$7"
finish() {
    status=$?
    printf '%s\n' "$status" > "$result"
    tmux -L "$tmux_name" wait-for -S claude-exited || true
}
trap finish EXIT
node_bin="$(cat "$component/node-path")"
"$node_bin" "$component/server.cjs" "$project" "$socket" "$descriptor" > >(tee -a "$log") 2>&1 &
worker=$!
trap 'kill -TERM "$worker" 2>/dev/null || true' TERM INT HUP
wait "$worker"
status=$?
# A trapped signal can interrupt wait before the worker finishes shutdown.
if kill -0 "$worker" 2>/dev/null; then wait "$worker"; fi
exit "$status"
