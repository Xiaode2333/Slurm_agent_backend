"""Slurm tunnels share credentials, not node-local process identity/lifetime."""
from pathlib import Path
import os
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("cached", [False, True])
def test_slurm_tunnel_isolates_shared_pid_socket_and_host_state(tmp_path, cached):
    home = tmp_path / "home"
    auth = home / ".vscode/cli"
    server = auth / "servers/Stable-fixture/server/bin/code-server"
    server.parent.mkdir(parents=True)
    server.write_text("#!/bin/bash\nexit 0\n")
    server.chmod(0o755)
    (server.parents[2] / "pid.txt").write_text("999999\n")
    (server.parents[2] / "log.txt").write_text("Server bound to /tmp/on-other-node\n")
    for name in ("tunnel-stable.lock", "code_tunnel.json"):
        (auth / name).write_text("stale-other-node\n")
    if cached:
        (auth / "token.json").write_text("saved\n")
    settings = home / ".vscode-server/data/Machine/settings.json"
    settings.parent.mkdir(parents=True)
    settings.write_text('{"editor.fontSize": 14}\n')
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    cli = tmp_path / "code"
    cli.write_text(
        "#!/bin/bash\nset -eu\n"
        '[[ "$VSCODE_CLI_DATA_DIR" != "$HOME/.vscode/cli" ]] || exit 40\n'
        '[[ "$VSCODE_CLI_DATA_DIR" == "$SLURM_TMPDIR"/* ]] || exit 41\n'
        '[[ ! -e "$VSCODE_CLI_DATA_DIR/tunnel-stable.lock" ]] || exit 42\n'
        '[[ ! -e "$VSCODE_CLI_DATA_DIR/code_tunnel.json" ]] || exit 43\n'
        '[[ ! -e "$VSCODE_CLI_DATA_DIR/servers/Stable-fixture/pid.txt" ]] || exit 44\n'
        '[[ ! -e "$VSCODE_CLI_DATA_DIR/servers/Stable-fixture/log.txt" ]] || exit 45\n'
        '[[ -x "$VSCODE_CLI_DATA_DIR/servers/Stable-fixture/server/bin/code-server" ]] || exit 46\n'
        'if [[ "$*" == "--version" ]]; then echo "code fixture"; exit 0; fi\n'
        'if [[ "$*" == "tunnel user show" ]]; then [[ -f "$VSCODE_CLI_DATA_DIR/token.json" ]]; exit; fi\n'
        'if [[ "$*" == "tunnel user login --provider github" ]]; then\n'
        '  echo refreshed > "$VSCODE_CLI_DATA_DIR/token.json"; exit 0\nfi\n'
        '[[ "$*" == *"--name fixture-host"* ]] || exit 47\n'
        '[[ "$*" == *"--server-data-dir $VSCODE_CLI_DATA_DIR/server-data"* ]] || exit 48\n'
        'cmp "$VSCODE_CLI_DATA_DIR/server-data/Machine/settings.json" "$HOME/.vscode-server/data/Machine/settings.json"\n'
        'echo ISOLATED\n'
    )
    cli.chmod(0o755)
    log = tmp_path / "tunnel.log"
    result = subprocess.run(
        ["bash", str(ROOT / "scripts/codex_backend/tunnel-window.sh"), str(cli), str(log)],
        capture_output=True, text=True, timeout=10,
        env={**os.environ, "HOME": str(home), "SLURM_JOB_ID": "fixture",
             "SLURM_TMPDIR": str(runtime), "VSCODE_CLI_DATA_DIR": str(auth),
             "VSCODE_TUNNEL_NAME": "fixture-host"},
    )
    assert result.returncode == 0, log.read_text() + result.stderr
    assert "ISOLATED" in log.read_text()
    assert (auth / "token.json").read_text() == ("saved\n" if cached else "refreshed\n")
    assert (auth / "token.json").stat().st_mode & 0o777 == 0o600
    assert (auth / "tunnel-stable.lock").read_text() == "stale-other-node\n"


def test_dead_tunnel_exits_even_with_stale_url_and_live_admin_pane(tmp_path):
    scripts = tmp_path / "scripts/codex_backend"
    scripts.mkdir(parents=True)
    (scripts / "tunnel-window.sh").write_text("exit 7\n")
    # An old connection URL used to select fake JOINED mode and report success.
    (tmp_path / "vscode_slurm.out").write_text("Tunnel: oldhost\n")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    tmux = bin_dir / "tmux"
    tmux.write_text(
        "#!/bin/bash\nshift 2\n"
        'case "$1" in\n'
        ' display-message) echo "1:7" ;;\n'
        ' has-session) exit 0 ;;\n'
        ' *) exit 0 ;;\nesac\n'
    )
    tmux.chmod(0o755)
    result = subprocess.run(
        ["bash", str(ROOT / "scripts/agent_tmux_tunnel.sh")],
        capture_output=True, text=True, timeout=5,
        env={**os.environ, "SLURM_JOB_ID": "fixture", "SLURM_SUBMIT_DIR": str(tmp_path),
             "SLURM_TMPDIR": str(tmp_path), "PATH": str(bin_dir) + ":" + os.environ["PATH"]},
    )
    assert result.returncode == 7, result.stdout + result.stderr
    assert "TUNNEL_JOINED" not in result.stdout
    assert "TUNNEL_EXIT job=fixture status=7" in result.stdout
