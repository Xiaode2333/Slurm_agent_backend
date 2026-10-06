#!/usr/bin/env bash
set -uo pipefail
component_dir="$1"; project="$2"; socket="$3"; descriptor="$4"
tmux_name="$5"; result_file="$6"; log_file="$7"; sqlite_home="$8"
finish() {
    status=$?
    printf '%s\n' "$status" > "$result_file"
    tmux -L "$tmux_name" wait-for -S backend-exited || true
}
trap finish EXIT
node_bin="$(cat "$component_dir/node-path")"
# One allocation owns a project's persistent SQLite namespace at a time.
flock -n "$sqlite_home/service.lock" "$node_bin" "$component_dir/server.cjs" "$project" "$socket" "$descriptor" "$sqlite_home" > >(tee -a "$log_file") 2>&1
exit $?
