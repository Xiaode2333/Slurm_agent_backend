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
export VSCODE_CLI_DATA_DIR="${VSCODE_CLI_DATA_DIR:-$HOME/.vscode/cli}"
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
echo 'VSCODE_STARTUP starting tunnel'
exec "$vscode_bin" tunnel --accept-server-license-terms
