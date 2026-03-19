# claude-pulse

> Claude Code 状态栏插件，实时显示会话信息、上下文用量、费用、配额与工具活动。

```
git:(main*) | ████░░░░░░ 42% | Sonnet 4.6 | 2 CLAUDE.md | 4 MCPs | ⏱ 5m | $0.80 (订阅) 5h:9%@17:00 | 7d:12%@5.9d | 日:$0.80 | 周:$14
✓ Edit ×6 | ✓ Read ×4 | ✓ Bash ×11 | ◐ Write: src/index.ts
✓ Explore [haiku]: Finding relevant files (5s)
▸ Fix auth bug (2/5)
```

---

## 显示内容详解

### 第一行（始终显示）

| 字段 | 示例 | 说明 |
|------|------|------|
| Git 分支 | `git:(main*)` | 当前 Git 分支名，`*` 表示有未提交的改动 |
| 上下文进度条 | `████░░░░░░ 42%` | 当前会话的上下文窗口用量。颜色从绿色渐变至红色，越红说明剩余空间越少 |
| 模型名称 | `Sonnet 4.6` | 当前实际使用的模型（从 transcript 文件读取，比 stdin 更准确） |
| CLAUDE.md 数量 | `2 CLAUDE.md` | 当前生效的 CLAUDE.md 文件数量（用户级 + 项目级） |
| MCP 数量 | `4 MCPs` | 当前加载的 MCP 服务数量 |
| Hooks 数量 | `3 hooks` | 当前配置的 hooks 数量（有则显示，无则隐藏） |
| Rules 数量 | `8 rules` | `.claude/rules/` 目录下的规则文件数（有则显示） |
| 会话时长 | `⏱ 30m` | 当前会话已运行时间，从 transcript 第一条记录开始计算 |
| 今日费用 | `$0.80 (订阅)` | 通过 ccusage 统计的今日总花费；`(订阅)` 表示 Claude Max/Pro 订阅模式，API 模式则显示 API base URL |
| 5h 配额 | `5h:9%@17:00` | 近 5 小时滚动用量占比，`@17:00` 表示配额下次重置时间 |
| 7d 配额 | `7d:12%@5.9d` | 近 7 天滚动用量占比，`@5.9d` 表示距下次重置还有多少天 |
| 日费用 | `日:$0.80` | 今日花费（与上方 `$0.80` 相同，放在末尾便于和周费用对比） |
| 周费用 | `周:$14` | 本周累计花费（通过 ccusage weekly 获取） |

> **配额说明**：`5h` 和 `7d` 是 Claude 订阅计划（Max/Pro/Team）的滚动速率限制，与账单周期无关。用量越高，触发限流的可能性越大。

---

### 第二行起（有活动时才显示）

#### 工具活动行

```
◐ Write: src/index.ts | ✓ Edit ×6 | ✓ Read ×4 | ✓ Bash ×11
```

| 符号 | 含义 |
|------|------|
| `◐ 工具名: 目标` | 正在执行中的工具（最多显示 2 个），附带操作目标文件或命令片段 |
| `✓ 工具名 ×N` | 已完成的工具及调用次数，按频次降序排列（最多 4 种） |

#### Agent 行

```
✓ Explore [haiku]: Finding relevant files (5s)
◐ general-purpose [sonnet]: Searching codebase... (12s)
```

每个 Agent 单独一行，格式为：`状态 类型 [模型]: 描述 (耗时)`

| 符号 | 含义 |
|------|------|
| `◐` | Agent 正在运行中 |
| `✓` | Agent 已完成 |

#### Todo 行

```
▸ Fix auth bug (2/5)
```

显示当前正在进行的 todo 项及整体进度 `(已完成/总数)`。全部完成时显示 `✓ All todos complete (5/5)`。

---

## 依赖要求

| 依赖 | 版本 | 用途 | 安装 |
|------|------|------|------|
| [bun](https://bun.sh) | ≥ 1.0 | 运行 TypeScript 脚本（必须） | `curl -fsSL https://bun.sh/install \| bash` |
| [ccusage](https://github.com/ryoppippi/ccusage) | 最新 | 统计日/周费用 | `npm install -g ccusage` |
| Claude 订阅账号 | Max / Pro / Team | 显示 5h/7d 配额数据 | — |

> **注意**：若未安装 ccusage，费用字段不显示但其他功能正常。API 模式（设置了 `ANTHROPIC_BASE_URL`）下配额字段自动隐藏。

---

## 安装

在 Claude Code 中依次执行：

```
/plugin marketplace add cf-jx/claude-pulse
/plugin install claude-pulse
/claude-pulse:setup
```

setup 命令会自动检测 bun 路径、找到插件安装位置并写入 `~/.claude/settings.json`。

---

## 工作原理

- **stdin**：Claude Code 在每次提示前将会话元数据（模型、context 用量、cwd 等）以 JSON 格式写入 stdin
- **transcript**：从当前会话的 transcript 文件中实时解析工具调用、Agent 状态、Todo 列表
- **ccusage**：调用本地 ccusage CLI 获取费用数据，结果缓存 60s（日）/ 300s（周）避免频繁调用
- **OAuth API**：通过本地凭据文件获取 token，请求 Anthropic 配额 API，结果缓存 180s
- **配置计数**：扫描 `~/.claude/`、`~/.claude.json`、项目目录下的配置文件统计 CLAUDE.md / MCPs / hooks / rules 数量
