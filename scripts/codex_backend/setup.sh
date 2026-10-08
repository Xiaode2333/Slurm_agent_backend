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
    dependency_hash="$(sha256sum "$source_dir/package-lock.json" | cut -d ' ' -f 1)"
    dependency_dir="$install_root/dependencies/$dependency_hash"
    if [[ ! -f "$dependency_dir/installed" ]]; then
        mkdir -p "$dependency_dir"
        chmod 700 "$dependency_dir"
        cp "$source_dir/"package*.json "$dependency_dir/"
        npm ci --ignore-scripts --prefer-offline --no-audit --no-fund --prefix "$dependency_dir" >&2
        touch "$dependency_dir/installed"
    fi
    if [[ ! -e "$component_dir/node_modules" && ! -L "$component_dir/node_modules" ]]; then
        ln -s "$dependency_dir/node_modules" "$component_dir/node_modules"
    fi
    [[ "$(readlink -f "$component_dir/node_modules")" == "$(readlink -f "$dependency_dir/node_modules")" ]] || { echo 'Unexpected component dependency path' >&2; exit 2; }
    "$node_bin" "$component_dir/package-helper.cjs" "$component_dir" >&2
    chmod +x "$component_dir/launcher.sh"
    touch "$component_dir/installed"
fi
printf '%s\n' "$component_dir"
