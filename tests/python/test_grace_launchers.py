"""Grace launchers must work from other projects and Slurm spool copies.

All services are mocked: these tests never submit jobs or contact a backend.
"""
import os
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize('script', ['agent_tmux_server_grace.sh', 'vscode_slurm_grace.sh'])
@pytest.mark.parametrize('launch', ['local-check', 'spooled', 'spooled-relative', 'explicit-root'])
def test_grace_source_and_project_are_separate(tmp_path, script, launch):
    checkout = tmp_path / 'backend source'
    component = checkout / 'scripts/codex_backend'
    component.mkdir(parents=True)
    tools = tmp_path / 'bin'
    tools.mkdir()
    # Report the resolved source and project without starting any service.
    (component / 'setup.sh').write_text(f'echo "{component}"\n')
    (component / 'runtime.sh').write_text(f'node_bin="{tools / "node"}"\n')
    (component / 'node-path').write_text(str(tools / 'node'))
    (component / 'tunnel-window.sh').write_text('printf "TUNNEL %s %s\\n" "$0" "$2"\n')
    (tools / 'node').write_text('#!/bin/bash\necho mock-cli\n')
    (tools / 'tmux').write_text('''#!/bin/bash
if [[ "$*" == *"wait-for backend-exited"* ]]; then
    for dir in "$SLURM_TMPDIR"/agent-*; do echo 0 > "$dir/exit-code"; done
fi
''')
    original = checkout / 'scripts' / script
    shutil.copyfile(ROOT / 'scripts' / script, original)
    project = tmp_path / 'different project'
    project.mkdir()
    spool = tmp_path / 'spool'
    spool.mkdir()
    copied = spool / 'slurm_script'
    shutil.copyfile(original, copied)
    command = os.path.relpath(original, project) if launch == 'spooled-relative' else original
    (tools / 'scontrol').write_text(f'#!/bin/bash\nprintf "   Command=%s\\n" "{command}"\n')
    for tool in tools.iterdir():
        tool.chmod(0o700)
    env = {k: v for k, v in os.environ.items()
           if k not in ('AGENT_BACKEND_SOURCE_ROOT', 'CODEX_BACKEND_ROOT',
                        'AGENT_BACKEND_PROJECT', 'SLURM_JOB_ID', 'SLURM_SUBMIT_DIR')}
    # Grace prepends its user paths, so use an isolated home as well as PATH.
    env.update(HOME=str(tmp_path), PATH=f'{tools}:{os.environ["PATH"]}',
               CODEX_BACKEND_CLI=str(tools / 'node'), VSCODE_BIN=str(tools / 'node'),
               SLURM_SUBMIT_DIR=str(project), SLURM_TMPDIR=str(tmp_path))
    args = ['bash', str(copied)]
    if launch == 'local-check':
        args = ['bash', str(original), 'check']
    else:
        env['SLURM_JOB_ID'] = '99119'
    if launch == 'explicit-root':
        env['CODEX_BACKEND_ROOT'] = str(checkout)
    result = subprocess.run(args, cwd=project, env=env, capture_output=True, text=True, timeout=5)
    assert result.returncode == 0, result.stderr
    if launch == 'local-check':
        assert f'project={checkout}' in result.stdout
    elif script.startswith('vscode'):
        assert f'TUNNEL {component}/tunnel-window.sh {project}/vscode_slurm.out' in result.stdout
    else:
        assert 'AGENT_ALLOCATION job=99119 mode=server' in result.stdout
        assert (project / 'agent_tmux_server.out').is_file()


@pytest.mark.parametrize('script', ['agent_tmux_server_grace.sh', 'vscode_slurm_grace.sh',
                                    'agent_tmux_server_both_grace.sh', 'agent_tmux_server_claude_grace.sh'])
def test_grace_shared_cpu_defaults(script):
    source = (ROOT / 'scripts' / script).read_text()
    assert '#SBATCH --partition=week' in source
    assert '#SBATCH --cpus-per-task=1' in source
    assert '#SBATCH --time=7-00:00:00' in source
    assert '--gres' not in source and '--gpus' not in source
    assert 'export CODEX_BACKEND_CLUSTER=grace' in source
