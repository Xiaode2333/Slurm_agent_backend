"""Public launcher contracts and the real Unix WebSocket connection tests."""
from pathlib import Path
import json
import os
import shlex
import shutil
import subprocess
import time

import pytest

ROOT = Path(__file__).resolve().parents[2]


def test_codex_backend_resource_and_lifecycle_contract():
    source = (ROOT / "scripts/codex_server_slurm.sh").read_text()
    for directive in (
        "--partition=priority",
        "--cpus-per-task=2", "--mem=32G", "--time=7-00:00:00",
        "--output=codex_slurm.out", "--open-mode=append",
    ):
        assert f"#SBATCH {directive}" in source.splitlines()
    assert "#SBATCH --gres" not in source
    assert 'CODEX_BIN="$HOME/.npm-global/bin/codex"' in source
    assert "wait-for backend-exited" in source
    assert "has-session" not in source
    for entry in ("scripts/codex_server_slurm.sh", "scripts/connect_codex_backend.sh"):
        subprocess.run(["bash", "-n", str(ROOT / entry)], check=True)


@pytest.mark.parametrize('script', ['agent_tmux_tunnel.sh', 'agent_tmux_server.sh'])
def test_agent_partition_resource_contract(script):
    source = (ROOT / 'scripts' / script).read_text()
    for directive in ('--partition=agent', '--ntasks=1', '--cpus-per-task=1',
                      '--mem=8G', '--time=7-00:00:00', '--open-mode=append'):
        assert f'#SBATCH {directive}' in source.splitlines()
    assert '#SBATCH --gres' not in source
    assert 'tmux_name="agent-${SLURM_JOB_ID}"' in source
    assert 'trap cleanup EXIT' in source
    check = (ROOT / 'scripts/agent_tmux.sh').read_text()
    assert 'sbatch scripts/agent_tmux_tunnel.sh scripts/agent_tmux_server.sh' not in check


@pytest.mark.parametrize('script,pane,expected', [
    ('agent_tmux_tunnel.sh', '1:0:', 0),
    ('agent_tmux_tunnel.sh', '1:7:', 7),
    ('agent_tmux_tunnel.sh', '1::15', 143),
    ('agent_tmux_server.sh', '', 7),
])
def test_agent_launcher_propagates_service_exit(tmp_path, script, pane, expected):
    scripts = tmp_path / 'scripts'
    component = scripts / 'codex_backend'
    component.mkdir(parents=True)
    fake_bin = tmp_path / 'bin'
    fake_bin.mkdir()
    (component / 'tunnel-window.sh').write_text('exit 0\n')
    (component / 'setup.sh').write_text('printf "%s\\n" "$SLURM_SUBMIT_DIR/scripts/codex_backend"\n')
    (component / 'node-path').write_text(str(fake_bin / 'node') + '\n')
    (component / 'server-window.sh').write_text('printf "7\\n" > "$6"\n')
    (fake_bin / 'node').write_text('#!/bin/bash\nprintf "%s\\n" "$SLURM_SUBMIT_DIR/sqlite"\n')
    (fake_bin / 'node').chmod(0o755)
    tmux = fake_bin / 'tmux'
    tmux.write_text(
        '#!/bin/bash\nset -eu\nshift 2\n'
        'if [[ "$1" == display-message ]]; then printf "%s\\n" "$TEST_PANE"; fi\n'
        'if [[ "$1" == new-window && "$*" == *backend* ]]; then bash -c "${@: -1}"; fi\n'
        'if [[ "$1" == kill-server ]]; then touch "$SLURM_SUBMIT_DIR/cleaned"; fi\n'
    )
    tmux.chmod(0o755)
    launcher = scripts / script
    launcher.write_text((ROOT / 'scripts' / script).read_text())
    # A historical tunnel URL must not override this pane's exit status.
    (tmp_path / 'vscode_slurm.out').write_text('Tunnel: oldtunnel\n')
    result = subprocess.run(['bash', str(launcher)], capture_output=True, text=True, timeout=10,
        env={**os.environ, 'SLURM_SUBMIT_DIR': str(tmp_path), 'SLURM_TMPDIR': str(tmp_path),
             'SLURM_JOB_ID': 'fixture', 'TEST_PANE': pane,
             'PATH': str(fake_bin) + ':' + os.environ['PATH']})
    assert result.returncode == expected, result.stdout + result.stderr
    assert (tmp_path / 'cleaned').exists()
    log = 'vscode_slurm.out' if 'tunnel' in script else 'agent_tmux_server.out'
    assert f'allocation_exit={expected}' in (tmp_path / log).read_text()


def test_codex_connector_dependency_contract():
    package = json.loads((ROOT / "scripts/codex_backend/package.json").read_text())
    lock = json.loads((ROOT / "scripts/codex_backend/package-lock.json").read_text())
    assert package["dependencies"]["ws"] == "8.22.0"
    assert lock["packages"]["node_modules/ws"]["version"] == "8.22.0"
    helper = json.loads((ROOT / "scripts/codex_backend/helper/package.json").read_text())
    assert helper["extensionKind"] == ["workspace"]
    # The helper must publish the host decision before the official CLI starts.
    assert "*" in helper["activationEvents"]
    assert "openai.chatgpt" not in helper.get("extensionDependencies", [])


def test_tunnel_starts_before_backend_installation(tmp_path):
    scripts = tmp_path / "scripts"
    component = scripts / "codex_backend"
    component.mkdir(parents=True)
    marker = tmp_path / "tunnel-started"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    (component / "runtime.sh").write_text("node_bin=/bin/true\n")
    (component / "tunnel-window.sh").write_text("exit 0\n")
    setup = component / "setup.sh"
    setup.write_text(
        '#!/bin/bash\nset -eu\n[[ -f "$TUNNEL_TEST_MARKER" ]] || { echo "backend installation blocked tunnel" >&2; exit 8; }\n'
        'printf "%s\\n" "$SLURM_SUBMIT_DIR/scripts/codex_backend"\n'
    )
    (component / "node-path").write_text(str(fake_bin / "node") + "\n")
    (component / "server-window.sh").write_text('printf "0\\n" > "$6"\n')
    node = fake_bin / "node"
    node.write_text('#!/bin/bash\nprintf "%s\\n" "$SLURM_SUBMIT_DIR/sqlite"\n')
    node.chmod(0o755)
    tmux = fake_bin / "tmux"
    tmux.write_text(
        '#!/bin/bash\nset -eu\nshift 2\n'
        'if [[ "$1" == new-window || "$1" == new-session ]]; then\n'
        '  name=""\n'
        '  for ((i=1; i<=$#; i++)); do if [[ "${!i}" == -n ]]; then j=$((i+1)); name="${!j}"; fi; done\n'
        '  if [[ "$name" == vscode ]]; then touch "$TUNNEL_TEST_MARKER"; fi\n'
        '  if [[ "$name" == server ]]; then bash -c "${@: -1}"; fi\n'
        'fi\n'
    )
    tmux.chmod(0o755)
    launcher = scripts / "codex_server_slurm.sh"
    launcher.write_text((ROOT / "scripts/codex_server_slurm.sh").read_text())
    result = subprocess.run(
        ["bash", str(launcher)], capture_output=True, text=True, timeout=10,
        env={**os.environ, "SLURM_SUBMIT_DIR": str(tmp_path), "SLURM_TMPDIR": str(tmp_path),
             "SLURM_JOB_ID": "fixture", "TUNNEL_TEST_MARKER": str(marker),
             "PATH": str(fake_bin) + ":" + os.environ["PATH"]},
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert marker.exists()
    assert "VSCODE_STOP" in (tmp_path / "vscode_slurm.out").read_text()


@pytest.mark.parametrize("cached,login_status,persisted", [
    (False, 0, True), (False, 1, True), (False, 0, False), (True, 0, True),
])
def test_tunnel_device_login_without_terminal_input(tmp_path, cached, login_status, persisted):
    cli = tmp_path / "mock code"
    persist_command = '  echo saved > "$VSCODE_CLI_DATA_DIR/token.json"\n' if persisted else ""
    cli.write_text(
        "#!/usr/bin/env bash\n"
        "set -eu\n"
        "if read -r input; then echo 'unexpected terminal input' >&2; exit 9; fi\n"
        '[[ "${VSCODE_CLI_NONINTERACTIVE:-}" == 1 ]] || exit 7\n'
        '[[ "${VSCODE_CLI_USE_FILE_KEYCHAIN:-}" == 1 ]] || exit 7\n'
        '[[ "${VSCODE_CLI_DISABLE_KEYCHAIN_ENCRYPT:-}" == 1 ]] || exit 7\n'
        '[[ "$(stat -c %a "$VSCODE_CLI_DATA_DIR")" == 700 ]] || exit 7\n'
        'if [[ "$*" == "tunnel user show" ]]; then\n'
        '  [[ -f "$VSCODE_CLI_DATA_DIR/token.json" ]] || exit 1\n'
        "  echo 'logged in with provider GitHub Account'\n"
        "  exit 0\n"
        "fi\n"
        'if [[ "$*" == "tunnel user login --provider github" ]]; then\n'
        "  echo 'Device login: https://github.com/login/device code TEST-CODE'\n"
        + persist_command
        + f"  exit {login_status}\n"
        "fi\n"
        '[[ "$*" == "tunnel --accept-server-license-terms" ]] || exit 8\n'
        "echo 'Connected: https://vscode.dev/tunnel/test'\n"
    )
    cli.chmod(0o755)
    log = tmp_path / "tunnel output.log"
    log.write_text("existing log\n")
    data_dir = tmp_path / "private cli data"
    data_dir.mkdir(mode=0o755)
    if cached:
        (data_dir / "token.json").write_text("saved\n")
    source = (ROOT / "scripts/codex_server_slurm.sh").read_text()
    command = next(line for line in source.splitlines() if line.startswith("printf -v tunnel_command "))
    result = subprocess.run(
        ["bash", "-c", 'VSCODE_BIN="$1"; tunnel_log_file="$2"; component_dir="$3"; runtime="$3"; export VSCODE_CLI_DATA_DIR="$4"\n'
         + command + '\nbash -c "$tunnel_command"',
         "test", str(cli), str(log), str(ROOT / "scripts/codex_backend"), str(data_dir)],
        input="terminal input must be ignored\n", capture_output=True, text=True, timeout=10,
    )
    expected_status = login_status if not cached else 0
    if not persisted:
        expected_status = 1
    assert result.returncode == expected_status
    assert not result.stdout and not result.stderr
    output = log.read_text()
    assert output.startswith("existing log\n")
    assert ("https://github.com/login/device code TEST-CODE" in output) == (not cached)
    assert ("Connected: https://vscode.dev/tunnel/test" in output) == (expected_status == 0)
    assert ("VSCODE_AUTH_ERROR" in output) == (not persisted)
    if persisted and not cached:
        assert (data_dir / "token.json").stat().st_mode & 0o777 == 0o600


def test_codex_real_unix_websocket_regressions():
    node = shutil.which("node")
    if not node or not (ROOT / "scripts/codex_backend/node_modules/ws").is_dir():
        pytest.skip("Run npm ci --prefix scripts/codex_backend to enable Node regressions")
    result = subprocess.run(
        [node, "--test", "test/backend.test.cjs", "test/helper.test.cjs"], cwd=ROOT / "scripts/codex_backend",
        capture_output=True, text=True, timeout=40,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_tunnel_window_survives_tmux_log_redirection(tmp_path):
    tmux = shutil.which("tmux")
    if not tmux:
        pytest.skip("tmux is required for the tunnel pane lifecycle regression")
    cli = tmp_path / "mock code"
    cli.write_text(
        "#!/usr/bin/env bash\n"
        "set -eu\n"
        "sleep 0.5\n"
        'if [[ "$*" == "tunnel user show" ]]; then exit 0; fi\n'
        '[[ "$*" == "tunnel --accept-server-license-terms" ]] || exit 8\n'
        "echo 'Connected: https://vscode.dev/tunnel/test'\n"
    )
    cli.chmod(0o755)
    log = tmp_path / "tunnel output.log"
    data_dir = tmp_path / "private cli data"
    socket = tmp_path / "tmux.sock"
    base = [tmux, "-f", "/dev/null", "-S", str(socket)]
    command = shlex.join([
        "env", f"VSCODE_CLI_DATA_DIR={data_dir}", "bash",
        str(ROOT / "scripts/codex_backend/tunnel-window.sh"), str(cli), str(log),
    ])
    try:
        subprocess.run(base + ["new-session", "-d", "-s", "fixture", "sleep 30"], check=True)
        subprocess.run(base + ["set-option", "-g", "remain-on-exit", "on"], check=True)
        subprocess.run(base + ["new-window", "-t", "fixture", "-n", "tunnel", command], check=True)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            pane = subprocess.check_output(
                base + ["display-message", "-p", "-t", "fixture:tunnel",
                        "#{pane_dead}:#{pane_dead_status}:#{pane_dead_signal}"], text=True,
            ).strip()
            if pane.startswith("1:"):
                break
            time.sleep(0.1)
        assert pane == "1:0:", f"Tunnel pane exited unexpectedly: {pane}"
        assert "Connected: https://vscode.dev/tunnel/test" in log.read_text()
    finally:
        subprocess.run(base + ["kill-server"], check=False, capture_output=True)
