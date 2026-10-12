#!/usr/bin/env bash
set -euo pipefail
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$source_dir/../codex_backend/runtime.sh"
component_hash="$(cd "$source_dir" && sha256sum *.cjs *.sh helper/* ../codex_backend/*.cjs ../codex_backend/*.sh ../codex_backend/package*.json ../codex_backend/helper/* | sha256sum | cut -d ' ' -f 1)"
install_root="$HOME/.local/share/claude-backend"
mkdir -p "$install_root"
chmod 700 "$install_root"
exec 9>"$install_root/setup.lock"
flock 9
component_dir="$install_root/$component_hash"
if [[ ! -f "$component_dir/installed" ]]; then
    mkdir -p "$component_dir/helper"
    chmod 700 "$component_dir"
    cp "$source_dir/"*.cjs "$source_dir/"*.sh "$component_dir/"
    cp "$source_dir/helper/"* "$component_dir/helper/"
    printf '%s\n' "$node_bin" > "$component_dir/node-path"
    # Reuse tested terminal ownership discovery and adaptive VSIX packaging.
    cp "$source_dir/../codex_backend/runtime.sh" "$component_dir/runtime.sh"
    codex_component="$(bash "$source_dir/../codex_backend/setup.sh")"
    ln -s "$codex_component" "$component_dir/codex"
    "$node_bin" "$component_dir/package-helper.cjs" "$component_dir" >&2
    touch "$component_dir/installed"
fi
printf '%s\n' "$component_dir"
