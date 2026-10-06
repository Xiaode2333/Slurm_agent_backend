# Slurm Agent Backend

在 Slurm CPU allocation 中运行持久 Codex 后端，同时启动 VS Code Tunnel。
官方 Codex 侧边栏和远程终端通过本机 Unix socket 连接同一个后端；关闭客户端后，可以重新连接并恢复原来的会话。

```text
Slurm CPU allocation
  ├── Codex app-server ── private Unix socket
  │                           ├── Codex remote TUI
  │                           └── relay ── official Codex sidebar
  └── VS Code Tunnel ── remote workspace + connector helper
```

## 已验证的版本

| 组件 | 版本 / 路径 |
| --- | --- |
| Codex CLI | `0.160.1`，`$HOME/.npm-global/bin/codex` |
| 官方 Codex 扩展 | `openai.chatgpt`，`26.930.61225` |
| Node.js | Node 22，原环境使用 `22.23.2` |
| VS Code CLI | `1.140.0`，`$HOME/.local/share/vscode-cli/1.140.0/code` |
| WebSocket 依赖 | `ws 8.22.0`，由 lock file 固定 |

这些是此实现的兼容性目标，并非“最新版本”。后端和连接器会检查 Codex 版本。
连接器使用官方扩展的开发用途 CLI override；升级 CLI 或扩展后需要重新验证兼容性。

## 安装准备

需要 Linux、Slurm、共享 home/project 目录，以及 `bash`、`tmux`、`flock`、`zip`、Node 22 和 npm。
计算节点需要能访问 Codex、GitHub/VS Code Tunnel 服务；首次组件安装还需要访问 npm registry。
先在登录节点完成 Codex 登录，后端会复用现有配置和认证。

```bash
git clone git@github.com:Xiaode2333/Slurm_agent_backend.git
cd Slurm_agent_backend
mkdir -p "$HOME/.npm-global"
npm install --global --prefix "$HOME/.npm-global" @openai/codex@0.160.1
"$HOME/.npm-global/bin/codex" login
```

安装对应版本的 VS Code CLI 到表中的路径，在远程 VS Code 环境安装对应版本的官方 Codex 扩展。
Node 22 需要在 PATH 中；代码也兼容原环境的 `$HOME/.local/share/prime-agent-node/current/bin/node`。
脚本中 Codex/VS Code CLI 路径是固定的；采用其他安装路径时须同步修改 launcher 和 `common.cjs` 的 CLI 定义。

## 启动后端与 Tunnel

从包含 `scripts/` 的工作目录提交。示例使用 `priority` CPU 分区、2 CPU、32 GiB、7 天和零 GPU。
根据集群修改 `scripts/codex_server_slurm.sh` 的分区/时限，并通过 `sbatch` 提供所需 account/QOS。

```bash
bash scripts/codex_server_slurm.sh check
sbatch --partition=YOUR_CPU_PARTITION --account=YOUR_ACCOUNT --qos=YOUR_QOS scripts/codex_server_slurm.sh
tail -f codex_slurm.out vscode_slurm.out
```

无需 account/QOS 的集群可省略对应参数。`check` 只检查本地依赖，不检查集群调度配置。
Tunnel 会优先复用已保存凭据；首次登录时，在浏览器完成 `vscode_slurm.out` 中的 GitHub device login。
打开日志中的 Tunnel URL，在 VS Code 集成终端执行：

```bash
bash ./scripts/connect_codex_backend.sh
```

首次连接可能自动 reload 一次；重复连接同一个后端不会再次 reload。
成功时显示 `CONNECTED`、allocation、后端 PID 和会话计数，随后使用官方 Codex 侧边栏查看和恢复会话。
命令面板中的 **Codex Backend: Restore Previous CLI Setting** 可恢复原 CLI 配置。

后端按工作目录隔离和发现。若要在自己的项目中使用，将本仓库的 `scripts/` 安装到该项目，
从该项目根目录提交作业并执行连接命令。已有 Tunnel 只有在同一节点、同一项目且后端唯一时才能连接。

## 终端连接与停止

使用启动日志输出的 socket URL：

```bash
"$HOME/.npm-global/bin/codex" --remote unix://SOCKET_PATH
"$HOME/.npm-global/bin/codex" resume THREAD_ID --remote unix://SOCKET_PATH
scancel JOB_ID
```

关闭客户端只会断开该客户端。allocation 被取消、超时或后端退出时，服务和其 Tunnel 结束。
没有自动续期或跨节点迁移；历史可在新的 allocation 中恢复，正在运行的进程不保证连续恢复。

只需要独立 VS Code Tunnel 时，可单独提交 `scripts/vscode_slurm.sh`，使用相同的站点参数。
该入口不启动 Codex 后端。

## 验证与文档

```bash
npm ci --ignore-scripts --prefix scripts/codex_backend
npm test --prefix scripts/codex_backend
python -m pip install -r requirements-dev.txt
python -m pytest -q tests/python/test_codex_backend.py
find scripts -name '*.sh' -exec bash -n {} \;
```

测试使用临时 socket、模拟 CLI 和独立 tmux server，不提交 Slurm 作业，也不需要真实 Codex 登录。
Python 测试依赖 `tmux`；安装 npm 依赖后才能执行完整 Node 回归。

- [后端、连接器、存储与生命周期](docs/backend.md)
- [原环境验收与覆盖边界](docs/ACCEPTANCE.md)

认证、会话、SQLite、socket、扩展安装包及运行日志都保存在用户私有目录或忽略路径中。
Tunnel 凭据以不绑定 hostname 的文件方式保存，目录权限 700、凭据权限 600，以便在不同节点复用。
本仓库不包含认证文件、真实会话记录或研究数据。
