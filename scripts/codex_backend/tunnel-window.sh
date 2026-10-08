#!/usr/bin/env bash
# Browser-only authentication with credentials reusable across Slurm nodes.
set -euo pipefail
vscode_bin="$1"
log_file="$2"
# Keep the pane's PTY open: closing its last slave descriptor makes tmux send
# SIGHUP, even though the process is still running with redirected streams.
exec 3>&1
exec </dev/null >>"$log_file" 2>&1
echo 'VSCODE_STARTUP checking saved credentials'
umask 077
auth_dir="${VSCODE_CLI_DATA_DIR:-$HOME/.vscode/cli}"
umask 077
mkdir -p "$auth_dir"
chmod 700 "$auth_dir"
tunnel_args=(--accept-server-license-terms)
if [[ -n "${SLURM_JOB_ID:-}" ]]; then
    # NFS-shared PID/lock/socket files describe a different machine after a
    # node change. Share credentials and installed binaries, never live state.
    export VSCODE_CLI_DATA_DIR
    VSCODE_CLI_DATA_DIR="$(mktemp -d "${SLURM_TMPDIR:-${TMPDIR:-/tmp}}/vscode-cli-${SLURM_JOB_ID}.XXXXXXXX")"
    [[ ! -f "$auth_dir/token.json" ]] || cp "$auth_dir/token.json" "$VSCODE_CLI_DATA_DIR/token.json"
    mkdir -p "$VSCODE_CLI_DATA_DIR/servers"
    for cached in "$auth_dir"/servers/Stable-* "$auth_dir"/servers/Insiders-*; do
        [[ -x "$cached/server/bin/code-server" ]] || continue
        destination="$VSCODE_CLI_DATA_DIR/servers/${cached##*/}"
        mkdir -p "$destination"
        ln -s "$cached/server" "$destination/server"
    done
    # The VS Code agent-host supervisor also has node-local sockets/PIDs.
    # Retain machine settings, but do not copy endpoint registries or locks.
    server_data="$VSCODE_CLI_DATA_DIR/server-data"
    mkdir -p "$server_data/Machine"
    if [[ -f "$HOME/.vscode-server/data/Machine/settings.json" ]]; then
        cp "$HOME/.vscode-server/data/Machine/settings.json" "$server_data/Machine/settings.json"
    fi
    tunnel_name="${VSCODE_TUNNEL_NAME:-$(hostname -s)-${SLURM_JOB_ID}}"
    tunnel_args+=(--name "$tunnel_name" --server-data-dir "$server_data"
        --extensions-dir "$HOME/.vscode-server/extensions" --log "${VSCODE_TUNNEL_LOG_LEVEL:-info}")
    printf 'VSCODE_RUNTIME job=%s node=%s cli_data=%s server_data=%s name=%s\n' \
        "$SLURM_JOB_ID" "$(hostname)" "$VSCODE_CLI_DATA_DIR" "$server_data" "$tunnel_name"
else
    export VSCODE_CLI_DATA_DIR="$auth_dir"
fi
export VSCODE_CLI_USE_FILE_KEYCHAIN=1
# The default token encryption uses the hostname, which changes across nodes.
# The CLI writes token.json with mode 600; keep its directory private as well.
export VSCODE_CLI_DISABLE_KEYCHAIN_ENCRYPT=1
export VSCODE_CLI_NONINTERACTIVE=1
mkdir -p "$VSCODE_CLI_DATA_DIR"
chmod 700 "$VSCODE_CLI_DATA_DIR"
if ! "$vscode_bin" tunnel user show; then
    echo 'VSCODE_STARTUP requesting GitHub device login'
    "$vscode_bin" tunnel user login --provider github
fi
# Login can return success even when credential persistence fails.
if ! "$vscode_bin" tunnel user show; then
    echo 'VSCODE_AUTH_ERROR: login credentials were not saved; tunnel startup stopped.' >&2
    exit 1
fi
if [[ "$VSCODE_CLI_DATA_DIR" != "$auth_dir" && -f "$VSCODE_CLI_DATA_DIR/token.json" ]]; then
    # Persist refreshed/device-login credentials atomically, without sharing
    # the tunnel id (two hosts must not compete for one named tunnel).
    saved_token="$(mktemp "$auth_dir/.token.XXXXXXXX")"
    cp "$VSCODE_CLI_DATA_DIR/token.json" "$saved_token"
    chmod 600 "$saved_token"
    mv -f "$saved_token" "$auth_dir/token.json"
fi
printf 'VSCODE_VERSION %s\n' "$("$vscode_bin" --version)"
echo 'VSCODE_STARTUP starting tunnel (use an up-to-date desktop client or vscode.dev)'
exec "$vscode_bin" tunnel "${tunnel_args[@]}"
