# Codex History Sync

一个可配置的 Git-backed Codex 会话同步工具。它可以把任意数量的 Codex Home
（例如 `~/.codex`、`~/.customcodex` 或其他自定义 Codex Home）连接到用户自己的私有 Git 仓库。

本仓库**只包含同步框架代码**：CLI、Codex 生命周期 Hook、Git Hook、冲突检测和
Provider 刷新。聊天记录保存在用户指定的独立私有数据仓库中。

> 会话正文可能包含源代码、路径、提示词和公司信息。数据仓库必须保持私有。

## 功能

- 配置任意数量的 Codex Home。
- 双向合并 `sessions`、`archived_sessions` 和 `session_index.jsonl`。
- 使用 Git LFS 保存大型 rollout JSONL。
- `SessionStart` 自动 pull、导入和刷新 Provider。
- `SessionEnd` 在后台防抖后 commit/push。
- 可选在自定义客户端完全退出后再次落盘 UI 项目元数据，避免桌面宿主退出时用旧缓存覆盖同步结果。
- 根据每个 Home 自己的 `config.toml` 保留不同 `model_provider`。
- 活跃或最近仍在写入的会话延迟处理。
- 真正分叉的同一 session 保存到 `conflicts/<session-id>/`，不静默覆盖。
- 不同步认证、配置、SQLite、WAL、日志、缓存和运行锁。

## 典型用途：Codex 多端消息记录同步

本工具可以作为 Codex 在多台工作站之间的消息记录同步层。例如在台式机、笔记本和
远程开发机上分别安装 Codex，再让每台设备连接同一个私有数据仓库：

```text
工作站 A ~/.codex ─┐
工作站 B ~/.codex ─┼─ 私有 Git/LFS 数据仓库
工作站 C ~/.codex ─┘
```

每台设备在 `SessionStart` 时拉取其他设备已经提交的会话，在 `SessionEnd` 时将本机新增
或延长的会话提交回私有仓库。会话按 session ID 合并；一端内容是另一端前缀时保留较长
版本，发生真正分叉时保存双方副本并要求人工选择，因此不会用“最后写入时间”静默覆盖
另一台设备的消息记录。

同一台设备也可以同时配置多个 Codex Home，例如官方客户端与自定义客户端；多设备和
多 Home 可以组合使用。所有设备应使用同一个私有仓库，并安装 Git LFS。

## 快速开始

### 1. 获取同步框架

```powershell
git clone <FRAMEWORK_REPOSITORY_URL> codex-history-sync
cd codex-history-sync
```

### 2. 创建或克隆私有数据仓库

数据仓库与框架仓库分开，例如：

```powershell
git clone git@github.com:OWNER/PRIVATE-CODEX-HISTORY.git D:\Private\codex-history-data
```

数据仓库必须是私有仓库。空仓库也可以，初始化命令会补充 Git/LFS 配置。

### 3. 配置参与同步的 Codex Home

```powershell
node .\bin\cli.mjs init `
  --home official=~/.codex `
  --home custom=~/.customcodex `
  --data-repo D:\Private\codex-history-data `
  --remote git@github.com:OWNER/PRIVATE-CODEX-HISTORY.git
```

也可以直接编辑 `sync.config.json`：

```json
{
  "schemaVersion": 1,
  "homes": [
    { "name": "official", "path": "~/.codex", "installHooks": true },
    { "name": "work", "path": "D:/AI/work-codex-home", "installHooks": true }
  ]
}
```

完整示例见 `sync.config.example.json`。

### 4. 安装 Git Hook 与 Codex Hook

```powershell
node .\bin\cli.mjs install-hooks --logon-task
```

随后在每一个 Codex 客户端中运行 `/hooks`，检查并信任：

```text
Git-backed Codex conversation history synchronization
```

### 5. 首次同步

```powershell
node .\bin\cli.mjs sync
```

## CLI

```text
codex-history-sync init --home NAME=PATH [--home NAME=PATH ...] [--remote URL]
codex-history-sync install-hooks [--logon-task]
codex-history-sync sync [--no-pull] [--no-push] [--no-commit]
codex-history-sync finalize-ui [HOME_NAME]
codex-history-sync watch-exit HOME_NAME
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
| `installHooks` | 是否向该 Home 安装 `hooks.json`，默认 `true`；关闭后该 Home 仍参与读写同步 |
| `finalizeUiOnExit` | 可选；为 `true` 时，`SessionEnd` 会启动退出监听器，在该客户端进程完全结束后重写 UI 项目状态 |
| `uiStateExitProcessPaths` | 可选；需要等待退出的客户端/后端可执行文件路径列表；全部退出后才执行最终化 |

不限制 Home 数量。

### `git`

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `dataRepository` | `.` | 保存 `data/` 的私有 Git 工作区；可与工具源码目录分离 |
| `remote` | `origin` | 私有数据仓库远端名称 |
| `branch` | `main` | 同步分支 |
| `autoPull` | `true` | 开始同步前 fetch/rebase |
| `autoPush` | `true` | 提交后 push |
| `commitDebounceSeconds` | `20` | SessionEnd 后的合并等待时间 |

### `providerSync`

工具内置 `codex-provider-sync v1.0.3`。导入后分别读取每个 Home 根级
`model_provider`，再更新其 rollout 和已有 SQLite thread 行。

### `sync`

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `includeArchived` | `true` | 同步归档会话 |
| `includeSessionIndex` | `true` | 合并会话名称索引 |
| `propagateDeletes` | `false` | 删除默认不传播 |
| `refreshThreadIndex` | `true` | 导入后调用各 Home 的 Codex `thread/list`，补建客户端 UI 使用的 SQLite 线程索引 |
| `indexRefreshTimeoutSeconds` | `120` | 每个 Home 的索引刷新超时 |
| `includeUiMetadata` | `true` | 同步会话名称、项目定义和线程的项目归属，避免导入记录全部落入 Quick Chat |
| `settleMilliseconds` | `1500` | 扫描前等待文件写入稳定 |
| `lockStaleMinutes` | `30` | 同步锁过期时间 |

## 生命周期

```text
SessionStart(startup/resume)
  → fetch/rebase
  → 合并 Git 数据和所有 Codex Home
  → 按各 Home Provider 回写
  → 扫描 rollout 并刷新 UI 线程索引
  → Provider metadata sync
  → commit/push

SessionEnd
  → 3 秒内启动后台任务
  → 防抖
  → 执行同样的同步流程
  → 对启用 finalizeUiOnExit 的 Home 等待客户端完全退出
  → 写入 .codex-global-state.json 及其 .bak，使下次启动载入完整项目列表
```

Codex 用户级 Hook 在变更后需要通过 `/hooks` 重新信任。官方说明见
[Codex Hooks](https://developers.openai.com/codex/hooks/)。

## 数据边界

会提交：

```text
data/sessions/**/*.jsonl
data/archived_sessions/**/*.jsonl
data/session_index.jsonl
```

永远不应提交 `auth.json`、`config.toml`、SQLite/WAL/SHM、全局状态、日志、缓存和锁。
`.githooks/pre-commit` 会阻止这些文件被提交。

## 代码与数据的组织方式

当前支持：

1. **推荐的分离模式**：工具代码保留在本仓库，将 `git.dataRepository` 指向独立私有 Git 工作区。
2. **兼容单仓库模式**：将 `git.dataRepository` 设置成 `.`，但这会把代码与聊天数据放在同一私有仓库，不建议用于公开框架仓库。

分离模式的数据仓库至少应包含：

```gitattributes
data/sessions/**/*.jsonl filter=lfs diff=lfs merge=lfs -text
data/archived_sessions/**/*.jsonl filter=lfs diff=lfs merge=lfs -text
data/session_index.jsonl text eol=lf
```

代码已经不依赖固定用户名或固定 `.codex/.customcodex` 数量。未来可以进一步发布成 npm
工具，让代码全局安装，而数据仓库仅保存 `data/` 与用户配置。

## 日志与冲突

```text
.sync/sync.log
conflicts/<session-id>/
```

## 上游组件

`vendor/codex-provider-sync` 固定自上游 `v1.0.3`，仅负责 Provider 元数据同步。
