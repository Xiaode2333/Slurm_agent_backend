"""Resource and exit handling for the extension-backed allocations."""
import os
from pathlib import Path
import subprocess
import pytest

ROOT = Path(__file__).resolve().parents[2]

@pytest.mark.parametrize('script', ['agent_tmux_server_claude.sh', 'agent_tmux_server_both.sh',
                                    'agent_tmux_server_claude_grace.sh', 'agent_tmux_server_both_grace.sh',
                                    'agent_tmux_server_both_pico54.sh'])
def test_one_cpu_no_gpu_and_local_check_root(script):
    source = (ROOT / 'scripts' / script).read_text()
    if '_pico54.sh' in script:
        partition, memory = 'priority,week', '20G'
    else:
        partition = 'week' if '_grace.sh' in script else 'agent'
        memory = '8G'
    for directive in (f'--partition={partition}', '--ntasks=1', '--cpus-per-task=1', f'--mem={memory}', '--time=7-00:00:00'):
        assert directive in source
    assert '--gres' not in source and 'pi_co54' not in source
    assert '"${1:-}" == check' in source
    subprocess.run(['bash', '-n', str(ROOT / 'scripts' / script)], check=True)

@pytest.mark.parametrize('script', ['agent_tmux_server_claude.sh', 'agent_tmux_server_both.sh',
                                    'agent_tmux_server_claude_grace.sh', 'agent_tmux_server_both_grace.sh',
                                    'agent_tmux_server_both_pico54.sh'])
@pytest.mark.parametrize('launch', ['local-check', 'spooled', 'spooled-relative', 'explicit-root'])
def test_launcher_separates_source_checkout_from_submission_project(tmp_path, script, launch):
    import shutil
    checkout = tmp_path / 'backend source'
    scripts = checkout / 'scripts'
    allocation = scripts / 'claude_backend' / 'allocation.sh'
    allocation.parent.mkdir(parents=True)
    allocation.write_text('#!/bin/bash\nprintf "%s\\n" "$@"\n')
    original = scripts / script
    shutil.copyfile(ROOT / 'scripts' / script, original)
    project = tmp_path / 'different project'
    project.mkdir()
    spool = tmp_path / 'slurm spool'
    spool.mkdir()
    copied = spool / 'slurm_script'
    shutil.copyfile(original, copied)
    tools = tmp_path / 'bin'
    tools.mkdir()
    scontrol = tools / 'scontrol'
    command = Path(os.path.relpath(original, project)) if launch == 'spooled-relative' else original
    scontrol.write_text(
        '#!/bin/bash\n'
        '[[ "$*" == "show job 99119" ]] || exit 3\n'
        f'printf "   Command=%s\\n   WorkDir=%s\\n" "{command}" "{project}"\n'
        f'touch "{tmp_path / "queried"}"\n'
    )
    scontrol.chmod(0o700)
    env = {key: value for key, value in os.environ.items()
           if key not in ('AGENT_BACKEND_SOURCE_ROOT', 'AGENT_BACKEND_PROJECT',
                          'CLAUDE_BACKEND_PROJECT', 'CODEX_BACKEND_ROOT', 'SLURM_JOB_ID', 'SLURM_SUBMIT_DIR')}
    env.update(PATH=f'{tools}:{os.environ["PATH"]}', SLURM_SUBMIT_DIR=str(project))
    args = ['bash', str(copied)]
    if launch == 'local-check':
        args = ['bash', str(original), 'check']
    else:
        env['SLURM_JOB_ID'] = '99119'
    if launch == 'explicit-root':
        env['AGENT_BACKEND_SOURCE_ROOT'] = str(checkout)
    result = subprocess.run(args, cwd=project, env=env, capture_output=True, text=True, timeout=5)
    assert result.returncode == 0, result.stderr
    expected_project = checkout if launch == 'local-check' else project
    assert result.stdout.splitlines() == [
        'both' if 'both' in script else 'claude', str(checkout), str(expected_project),
        'check' if launch == 'local-check' else '',
    ]
    assert (tmp_path / 'queried').exists() == launch.startswith('spooled')


@pytest.mark.parametrize('mode,failed,code', [('claude', 'claude', 7), ('both', 'claude', 6), ('both', 'codex', 9), ('both', 'claude', 0)])
def test_backend_exit_wakes_allocation_and_cleans_only_own_tmux(tmp_path, mode, failed, code):
    root = tmp_path / 'source'
    for name in ('codex_backend', 'claude_backend'):
        component = root / 'scripts' / name
        component.mkdir(parents=True)
        (component / 'node-path').write_text(str(tmp_path / 'bin' / 'node'))
        (component / 'setup.sh').write_text(f'#!/bin/bash\necho "{component}"\n')
    (root / 'scripts/codex_backend/runtime.sh').write_text(f'node_bin="{tmp_path / "bin/node"}"\n')
    tools = tmp_path / 'bin'
    tools.mkdir()
    (tools / 'node').write_text(f'#!/bin/bash\necho "{tmp_path / "sqlite"}"\n')
    (tools / 'tmux').write_text('''#!/bin/bash
printf '%s\\n' "$*" >> "$MOCK_LOG"
case "$3" in
new-window)
    if [[ "$*" == *"$FAIL_SERVICE-backend"* ]]; then
        for runtime in "$TMPDIR"/agent-*; do printf '%s\\n' "$FAIL_CODE" > "$runtime/$FAIL_SERVICE-exit"; done
    fi ;;
wait-for)
    if [[ "$4" != -S && "$4" != service-exited ]]; then sleep 0.05; fi ;;
esac
''')
    for tool in tools.iterdir():
        tool.chmod(0o700)
    log = tmp_path / 'tmux.log'
    env = {**os.environ, 'PATH': f'{tools}:{os.environ["PATH"]}', 'SLURM_JOB_ID': '99119',
           'SLURM_TMPDIR': str(tmp_path), 'TMPDIR': str(tmp_path), 'MOCK_LOG': str(log), 'FAIL_SERVICE': failed, 'FAIL_CODE': str(code)}
    result = subprocess.run(['bash', str(ROOT / 'scripts/claude_backend/allocation.sh'), mode, str(root), str(root)], env=env, capture_output=True, text=True, timeout=10)
    assert result.returncode == (code or 1), result.stderr
    calls = log.read_text()
    assert f'-L agent-99119-{mode} kill-server' in calls
    assert all(line.split()[:2] == ['-L', f'agent-99119-{mode}'] for line in calls.splitlines())
    assert '-L agent-99119-' in calls and ' wait-for service-exited' in calls

def test_term_interrupts_real_tmux_wait_and_cleans_allocation(tmp_path):
    import shutil
    import time
    root = tmp_path / 'source'
    tools = tmp_path / 'bin'
    tools.mkdir()
    for name in ('codex_backend', 'claude_backend'):
        component = root / 'scripts' / name
        component.mkdir(parents=True)
        (component / 'node-path').write_text(str(tools / 'node'))
        (component / 'setup.sh').write_text(f'#!/bin/bash\necho "{component}"\n')
    (root / 'scripts/codex_backend/runtime.sh').write_text(f'node_bin="{tools / "node"}"\n')
    (tools / 'node').write_text('#!/bin/bash\nexit 0\n')
    (tools / 'node').chmod(0o700)
    (root / 'scripts/claude_backend/server-window.sh').write_text('#!/bin/bash\nexec sleep 120\n')
    job = str(os.getpid())
    socket = f'agent-{job}-claude'
    env = {**os.environ, 'PATH': f'{tools}:{os.environ["PATH"]}', 'SLURM_JOB_ID': job, 'SLURM_TMPDIR': str(tmp_path)}
    proc = subprocess.Popen(['bash', str(ROOT / 'scripts/claude_backend/allocation.sh'), 'claude', str(root), str(root)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    tmux = shutil.which('tmux')
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            ready = subprocess.run([tmux, '-L', socket, 'list-windows', '-t', 'agent'], capture_output=True, text=True)
            if ready.returncode == 0 and 'claude-backend' in ready.stdout:
                break
            time.sleep(0.02)
        else:
            pytest.fail('Allocation did not create its real tmux worker')
        proc.terminate()
        stdout, stderr = proc.communicate(timeout=5)
        assert proc.returncode == 143, (stdout, stderr)
        assert subprocess.run([tmux, '-L', socket, 'list-sessions'], capture_output=True).returncode != 0
    finally:
        subprocess.run([tmux, '-L', socket, 'kill-server'], capture_output=True)
        if proc.poll() is None:
            proc.kill()
            proc.communicate(timeout=5)
