#!/usr/bin/env bash
# Install immutable connection components in private user storage.
set -euo pipefail
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$source_dir/runtime.sh"
component_hash="$(cd "$source_dir" && sha256sum *.cjs *.sh package*.json helper/* | sha256sum | cut -d ' ' -f 1)"
install_root="$HOME/.local/share/codex-backend"
mkdir -p "$install_root"
chmod 700 "$install_root"
exec 9>"$install_root/setup.lock"
flock 9
component_dir="$install_root/$component_hash"
if [[ ! -f "$component_dir/installed" ]]; then
    mkdir -p "$component_dir/helper"
    chmod 700 "$component_dir"
    cp "$source_dir/"*.cjs "$source_dir/"*.sh "$source_dir/"package*.json "$component_dir/"
    cp "$source_dir/helper/"* "$component_dir/helper/"
    printf '%s\n' "$node_bin" > "$component_dir/node-path"
    npm ci --ignore-scripts --no-audit --no-fund --prefix "$component_dir" >&2
    "$node_bin" "$component_dir/package-helper.cjs" "$component_dir" >&2
    chmod +x "$component_dir/launcher.sh"
    touch "$component_dir/installed"
fi
printf '%s\n' "$component_dir"
