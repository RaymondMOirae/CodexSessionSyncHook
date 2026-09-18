# Codex Session Sync Hook

一个可配置的 Git-backed Codex 会话同步框架，用于在多台设备和多个 Codex Home 之间
同步消息记录。默认面向官方 OpenAI Codex（`~/.codex`、`model_provider = "openai"`），
同时允许用户配置其他 Codex-compatible Home 和不同 Provider。

本仓库只包含同步框架代码：CLI、Codex 生命周期 Hook、Git Hook、冲突检测、Provider
元数据转换，以及会话名称和 Project 归属同步。聊天正文保存在用户指定的独立私有仓库中。

> 会话正文可能包含源代码、路径、提示词和公司信息。数据仓库必须保持私有。

## 功能

- 配置一个或多个 Codex Home。
- 在多台设备之间双向合并 `sessions`、`archived_sessions` 和 `session_index.jsonl`。
- 使用 Git LFS 保存大型 rollout JSONL。
- `SessionStart` 自动 fetch/rebase、导入会话、刷新 Provider 和线程索引。
- `SessionEnd` 在后台防抖后 commit/push。
- 将 archive/unarchive 作为独立状态事件同步，避免旧的 active 副本让归档对话重新出现。
- 可选传播 task 与 Project 删除；删除使用 Git tombstone，避免另一设备或 Home 的旧副本复活已删除内容。
- 同步收敛 SQLite、Project/thread 归属、全局 UI 状态、顺序和映射，让侧边栏与底层 archive/delete 状态一致。
- 未显式配置 `model_provider` 的 Home 默认按 OpenAI Provider 处理。
- 不同 Home 可以配置不同 Provider；同步时保留各目标 Home 的 Provider 元数据。
- 同步会话名称、Project 定义及线程的 Project 归属。
- 活跃会话以“截止扫描时最后一个完整 JSONL 记录”的只读快照同步到 Git 和未持锁 Home；绝不覆盖持有 writer-lock 的源文件。
- archived task 的 Project 归属保留在 SQLite 便于 unarchive 恢复，但不会写入活动侧边栏 assignment。
- 保留分页会话同一 thread 下的全部物理 rollout，避免续段覆盖其 `history_base` 前置段。
- 当分页续段仍冻结在旧 `history_base`、而源 rollout 已继续增长时，自动将续段重基到最新源历史，并保留续段独有的完整回合；后续源段再次增长时继续增量合并。
- 重基后同步更新目标 Home 的 `threads.rollout_path` 并重建历史投影；活动 task 的当前 rollout 不热覆盖，但同一 task 的非活动 rollout 可以安全预置。
- 一端历史是另一端前缀时保留较长版本。
- 真正分叉的同一 rollout 保存到 `conflicts/<rollout-id>/`，不静默覆盖。
- 不同步认证、配置、SQLite、WAL、日志、缓存和运行锁。

公开版本不修改桌面客户端快捷方式，也不要求通过前置 PowerShell 启动。针对某个定制客户端
的启动缓存、退出回写或专用启动器应在该客户端自己的集成层中处理。

## 典型用途

### 多设备同步官方 Codex

```text
工作站 A ~/.codex ─┐
工作站 B ~/.codex ─┼─ 私有 Git/LFS 数据仓库
工作站 C ~/.codex ─┘
```

### 多 Home / 多 Provider

```text
~/.codex       provider: openai ─┐
~/.customcodex provider: custom ─┼─ 私有 Git/LFS 数据仓库
D:/AI/.codex   provider: openai ─┘
```

每台设备在 `SessionStart` 时拉取其他设备已经提交的记录，在 `SessionEnd` 时提交本机新增
或延长的记录。框架按物理 rollout ID 合并文件，同时按 thread ID 同步归档和 UI 元数据；
分页会话的前置段与续段会一起保留，发生真正分叉时保留双方副本并要求人工处理。

Project 同步只保存 Project 名称、根目录路径和会话归属，不复制工作目录中的源代码或其他
文件。项目内容应继续通过 Git、云盘或其他文件同步方案分发；目标设备上对应目录需要存在。

## 快速开始

### 1. 获取框架

```powershell
git clone https://github.com/RaymondMOirae/CodexSessionSyncHook.git
cd CodexSessionSyncHook
```

### 2. 创建或克隆私有数据仓库

```powershell
git clone git@github.com:OWNER/PRIVATE-CODEX-HISTORY.git D:\Private\codex-history-data
```

数据仓库必须是私有仓库。空仓库也可以，初始化命令会补充 Git/LFS 配置。

### 3. 初始化

仅同步默认官方 Codex Home：

```powershell
node .\bin\cli.mjs init `
  --data-repo D:\Private\codex-history-data `
  --remote git@github.com:OWNER/PRIVATE-CODEX-HISTORY.git
```

配置多个 Home：

```powershell
node .\bin\cli.mjs init `
  --home official=~/.codex `
  --home custom=~/.customcodex `
  --data-repo D:\Private\codex-history-data `
  --remote git@github.com:OWNER/PRIVATE-CODEX-HISTORY.git
```

也可以直接编辑 `sync.config.json`。完整示例见 `sync.config.example.json`。

### 4. 安装 Hooks

```powershell
node .\bin\cli.mjs install-hooks --logon-task
```

随后在每个配置的 Codex 客户端中运行 `/hooks`，检查并信任：

```text
Git-backed Codex conversation history synchronization
```

### 5. 首次同步

```powershell
node .\bin\cli.mjs sync
```

## CLI

```text
codex-history-sync init --home NAME=PATH [--home NAME=PATH ...] [--data-repo PATH] [--remote URL] [--branch main]
codex-history-sync install-hooks [--logon-task]
codex-history-sync sync [--no-pull] [--no-push] [--no-commit]
codex-history-sync enqueue
codex-history-sync doctor
```

从源码运行时，将 `codex-history-sync` 换成 `node .\bin\cli.mjs`。

## 配置

### `homes`

每一项代表一个参与同步的 Codex Home：

| 字段 | 说明 |
|---|---|
| `name` | 唯一名称，仅用于日志和诊断 |
| `path` | 绝对路径、相对仓库路径或 `~` 路径 |
| `installHooks` | 是否向该 Home 安装 `hooks.json`，默认 `true` |
| `runtimeProcessPaths` | 可选；用于识别该 Home 客户端是否仍在运行的进程路径前缀，避免把已退出客户端留下的 writer-lock 误判为活动锁 |
| `runtimeCommandLineContains` | 可选；与 `runtimeProcessPaths` 一起进一步匹配运行进程命令行 |

未指定 `--home` 时默认生成：

```json
{ "name": "codex", "path": "~/.codex", "installHooks": true }
```

### `git`

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `dataRepository` | `.` | 保存 `data/` 的私有 Git 工作区 |
| `remote` | `origin` | 私有数据仓库远端名称 |
| `branch` | `main` | 同步分支 |
| `autoPull` | `true` | 开始同步前 fetch/rebase |
| `autoPush` | `true` | 提交后 push |
| `commitDebounceSeconds` | `20` | SessionEnd 后的合并等待时间 |

### `providerSync`

框架内置 `codex-provider-sync`。每个 Home 从其 `config.toml` 根级读取 `model_provider`；
没有显式值时默认使用 `openai`。导入记录后，框架会把 rollout 和已有 SQLite thread 行更新为
目标 Home 的 Provider，从而允许不同 Home 使用不同 Provider。

```json
{
  "providerSync": {
    "enabled": true,
    "entry": "vendor/codex-provider-sync/src/cli.js",
    "onMissing": "warn"
  }
}
```

### `sync`

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `includeArchived` | `true` | 同步归档会话 |
| `includeSessionIndex` | `true` | 合并会话名称索引 |
| `propagateDeletes` | `false` | 为 `true` 时传播 task 与 Project 删除并写入 tombstone；这是破坏性操作，默认关闭 |
| `refreshThreadIndex` | `true` | 导入后调用每个 Home 的 Codex `thread/list` 补建线程索引 |
| `indexRefreshTimeoutSeconds` | `120` | 每个 Home 的索引刷新超时 |
| `includeUiMetadata` | `true` | 同步名称、Project 定义和线程的 Project 归属 |
| `stripEncryptedContent` | `true` | 从跨 Home/Provider 的可移植副本中移除账号或 Provider 绑定的 `encrypted_content`，保留可见消息、工具记录和推理摘要；避免切换账号或 Provider 后继续会话时报 `invalid_encrypted_content` |
| `settleMilliseconds` | `1500` | 扫描前等待文件写入稳定 |
| `lockStaleMinutes` | `30` | 同步锁过期时间 |

分页 lineage 重基会保持目标 task ID 和 rollout ID 不变，清除已经失效的旧 `history_base`，
记录可继续增量合并的 lineage 标记并重新生成连续 ordinal。目标 Home 未被客户端占用时，框架会先备份
`state_5.sqlite` 与 `thread_history_1.sqlite`，将 `threads.rollout_path` 切换到合并后的续段，再删除该 task
的可重建投影行，让 app-server 从新 rollout 重建索引；若目标正占用这个 rollout，则延后到下一次同步，
但可先写入同一 task 的非活动 rollout，避免热覆盖当前 writer。

## 生命周期

```text
Windows 登录
  → fetch/rebase
  → 在启动 app-server 前捕获 Project 删除，防止旧迁移状态把它重新创建
  → 合并数据仓库与所有 Codex Home
  → 按目标 Home 转换 Provider 元数据
  → 刷新线程索引及 UI 元数据

SessionStart(startup/resume)
  → 执行同样的同步流程

SessionEnd
  → 3 秒内启动后台任务
  → 防抖
  → 合并、commit、push
```

官方说明中，`SessionStart` 在会话启动或恢复时运行；`SessionEnd` 在主会话真正结束时运行，
切换离开对话不会立即结束 session。参考 [Codex Hooks](https://learn.chatgpt.com/docs/hooks)。

## 数据边界

数据仓库会保存：

```text
data/sessions/**/*.jsonl
data/archived_sessions/**/*.jsonl
data/session_index.jsonl
data/ui-metadata.json
data/archive-events/<session-id>/*.json
data/delete-events/<session-id>/*.json
data/project-events/<project-key>/*.json
```

同步器不会强制关闭正在工作的桌面客户端。已经打开的窗口若仍持有旧侧边栏缓存，可正常退出并重新启动；
持久化状态已在同步时写入，下一次启动会加载正确的 archive、删除和 Project 状态。

永远不应提交：

```text
auth.json
config.toml
*.sqlite
*.sqlite-wal
*.sqlite-shm
.codex-global-state.json
日志、缓存和锁
```

`.githooks/pre-commit` 会阻止敏感运行时文件进入数据仓库。

## 日志与冲突

```text
.sync/sync.log
conflicts/<rollout-id>/
```

## 上游组件

`vendor/codex-provider-sync` 来自开源项目
[Dailin521/codex-provider-sync](https://github.com/Dailin521/codex-provider-sync)，当前固定为
`v1.0.3`，依据 MIT License 使用，只负责 Provider 元数据转换和同步。

上游许可证原文保留在 `vendor/codex-provider-sync/LICENSE`，完整第三方归属说明见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
