#!/usr/bin/env bash
set -euo pipefail
component_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
node_bin="$(cat "$component_dir/node-path")"
codex_bin="$("$node_bin" -e 'process.stdout.write(require(process.argv[1]).CLI)' "$component_dir/common.cjs")"
args=("$@")
index=0
while ((index < ${#args[@]})); do
    case "${args[index]}" in
        -c|--config|--enable|--disable) index=$((index + 2)) ;;
        --strict-config) index=$((index + 1)) ;;
        app-server)
            [[ "${args[*]:index}" != *daemon* ]] || { echo 'daemon lifecycle is not available through the extension launcher' >&2; exit 2; }
            for arg in "${args[@]:index+1}"; do
                [[ "$arg" == --analytics-default-enabled ]] || { echo "unsupported extension startup argument: $arg" >&2; exit 2; }
            done
            for ((j=0; j<index; j++)); do
                if [[ "${args[j]}" == -c || "${args[j]}" == --config ]]; then
                    [[ "${args[j+1]}" == features.code_mode_host=true ]] || { echo "unsupported backend startup config: ${args[j+1]}" >&2; exit 2; }
                    j=$((j+1))
                else
                    echo "unsupported backend startup option: ${args[j]}" >&2; exit 2
                fi
            done
            exec "$node_bin" "$component_dir/relay.cjs"
            ;;
        *) break ;;
    esac
done
exec "$codex_bin" "$@"
