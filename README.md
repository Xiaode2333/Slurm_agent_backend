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
命令面板中的 **Codex Backend: Show Connection Status** 可核验当前窗口的 allocation、后端 PID 和活跃 relay。
**Codex Backend: Use Local Codex in This Window** 会解除当前窗口绑定；共享入口继续服务其他窗口。

后端按工作目录隔离和发现。可在自己的项目目录中直接调用本仓库的绝对路径连接脚本，不必复制脚本：

```bash
cd /absolute/your-project
bash /absolute/Slurm_agent_backend/scripts/connect_codex_backend.sh
bash /absolute/Slurm_agent_backend/scripts/connect_codex_backend.sh status
```

同一节点上的多个项目窗口可以共享一个后端。官方 CLI override 是应用级设置，
共享 dispatcher 会按实际扩展宿主分别绑定窗口；未绑定的窗口使用正常 CLI。
后端不明确时，使用 `CODEX_BACKEND_JOB=JOB_ID` 指定。`status` 的 `window.verified=true`
表示当前窗口有活跃 relay 证据，`backendAvailable=true` 单独不能证明侧边栏已经连接。

## agent 分区：Tunnel 与后端分开运行

新增的三个 `agent_tmux*` 脚本适用于提供 `agent` CPU 分区的站点。
每个作业请求 1 CPU、8 GiB、7 天、零 GPU；两个作业须分别提交，
不能把第二个脚本作为第一个 `sbatch` 命令的参数：

```bash
bash scripts/agent_tmux.sh check
sbatch scripts/agent_tmux_tunnel.sh
sbatch scripts/agent_tmux_server.sh
```

站点 account/QOS 要求仍通过 `sbatch` 参数提供。两作业必须运行在同一节点，
否则 Tunnel 无法访问后端的 Unix socket；必要时在第二次提交中指定
`--nodelist=FIRST_JOB_NODE`，以实际获配节点为准，不保证第二个作业立即启动。
从仓库根目录提交，分别查看 `agent_tmux_tunnel_JOB_ID.out` 和
`agent_tmux_server_JOB_ID.out`。Tunnel 详细输出追加到 `vscode_slurm.out`，
后端详细输出追加到 `agent_tmux_server.out`。

进入对应计算节点后，用作业 ID 选择独立 tmux server：

```bash
tmux -L agent-TUNNEL_JOB_ID list-windows -t agent
tmux -L agent-SERVER_JOB_ID list-windows -t agent
tmux -L agent-SERVER_JOB_ID list-windows -t agent \
  -F '#{window_index} #{window_name} -> tmux -L agent-SERVER_JOB_ID attach -t agent:#{window_index}'
tmux -L agent-TUNNEL_JOB_ID attach -t agent:vscode
tmux -L agent-SERVER_JOB_ID attach -t agent:backend
```

Tunnel 有 `vscode` / `admin` 窗口，后端有 `server` / `admin` / `backend` 窗口。
后端退出会结束其 allocation；取消一个作业不等于取消另一个。

### 扩展版本匹配

连接器安装所支持的 `openai.chatgpt@26.930.61225`，版本不符时重新安装，
不会任意升级后端协议。Connector VSIX 打包读取当前终端的 `code --version`，
同步两个 manifest 的 engine 范围；最低声明为 VS Code 1.95，
官方扩展另有最低要求（该版本为 1.96.2）。无法探测版本时打印警告。
安装明确报 VS Code 不兼容时重打包并重试一次；其他错误直接报告。
这不会升级 VS Code，也不保证任意未来版本或旧版本兼容。

CLI 显示的已安装版本不一定等于当前窗口内存里已加载的版本。
`Official extension version mismatch` 会报告窗口实际版本及要求版本；
执行 **Developer: Reload Window** 后再次运行连接命令。后端无须重启。

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

编译/语法检查和测试在本地运行，不使用 GitHub Actions。先在当前 Python
环境安装 `requirements-dev.txt`，然后执行：

```bash
bash scripts/check_backend.sh
```

在 Slurm 集群上使用 CPU allocation 和站点要求的 Python 环境；检查脚本不提交作业。
也可分步执行：

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
- [OpenCode、Pi 和 Claude Code](docs/harnesses.md)
- [性能变化、测量与生效边界](docs/performance.md)

认证、会话、SQLite、socket、扩展安装包及运行日志都保存在用户私有目录或忽略路径中。
Tunnel 凭据以不绑定 hostname 的文件方式保存，目录权限 700、凭据权限 600，以便在不同节点复用。
本仓库不包含认证文件、真实会话记录或研究数据。
