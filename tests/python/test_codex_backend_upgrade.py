"""Upgrade recovery diagnostics from the actual backend window wrapper."""
from pathlib import Path
import os
import shutil
import subprocess
import time

import pytest

ROOT = Path(__file__).resolve().parents[2]


def test_backend_window_mirrors_failure_and_preserves_exit_receipt(tmp_path):
    node = shutil.which("node")
    if not node:
        pytest.skip("Node required")
    component = tmp_path / "component"
    component.mkdir()
    (component / "node-path").write_text(node + "\n")
    (component / "sqlite-store.cjs").write_text(
        "console.error('SQLITE_STORE_FAILED fixture'); process.exitCode = 7;\n"
    )
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    tmux = fake_bin / "tmux"
    tmux.write_text("#!/bin/bash\nexit 0\n")
    tmux.chmod(0o700)
    sqlite = tmp_path / "sqlite"
    sqlite.mkdir()
    shared = tmp_path / "shared.out"
    allocation = tmp_path / "allocation.out"
    receipt = tmp_path / "exit-code"
    result = subprocess.run(
        ["bash", str(ROOT / "scripts/codex_backend/server-window.sh"),
         str(component), str(tmp_path), "socket", "descriptor", "fixture",
         str(receipt), str(shared), str(sqlite), str(allocation)],
        env={**os.environ, "PATH": str(fake_bin) + ":" + os.environ["PATH"]},
        capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 7
    assert receipt.read_text().strip() == "7"
    # tee is a process substitution; its final flush can follow wrapper exit.
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if allocation.exists() and "fixture" in allocation.read_text():
            break
        time.sleep(0.01)
    assert "SQLITE_STORE_FAILED fixture" in allocation.read_text()
    assert "SQLITE_STORE_FAILED fixture" in shared.read_text()
