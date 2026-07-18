# WeChat Claude Code Bridge 微信桥接

<p align="center">
  <strong>在微信里和 Claude Code 聊天 — 文字、图片、语音、文件</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License: MIT"></a>
  <a href="README_en.md"><img src="https://img.shields.io/badge/English-blue?style=flat-square" alt="English"></a>
</p>

扫码绑定微信后，你的联系人里会多出一个好友。发消息给它，内容自动转发到你电脑上运行的 Claude Code，回复实时推送回微信。

TypeScript 编写，Node.js 后台守护进程，macOS 用 launchd 管理，Linux 用 systemd。

<p align="center">
  <strong>在微信里和 Claude Code 聊天 — 文字、图片、语音、文件</strong>
</p>

扫码绑定微信后，你的联系人里会多出一个好友。发消息给它，内容自动转发到你电脑上运行的 Claude Code，回复实时推送回微信。

TypeScript 编写，Node.js 后台守护进程，macOS 用 launchd 管理，Linux 用 systemd。

---

## 功能

- **双向消息** — 文字、图片、语音转文字、文件（最大 25MB）
- **流式回复** — 文本增量推送，微信显示"对方正在输入…"。超过 5 分钟无响应时，从 10 条安抚话术中随机选一条自动发送
- **多图聚合** — 连续发送图片/文件时 2 秒防抖收集，用户发文字后（5 分钟内）合并为一次 Claude 查询。超过 5 分钟的积压附件自动丢弃
- **会话续接** — 跨消息保持上下文，使用 `--resume <sessionId>`。含图片时不续接（避免缓存旧图）、session 超 30 分钟不续接、上一条是 API 错误不续接。续接失败时（422/session 损坏/思维链断裂）自动降级重试，注入最近 6 条聊天历史
- **自动文件推送** — Claude 回复中提到的文件路径（21 种扩展名）自动发到微信。限频时重试 3 次（15s/30s/45s 指数退避）
- **中途截流** — Claude 还在处理时发新消息，自动终止当前查询、清空队列、合并原指令+新内容重新发送
- **15+ 斜杠命令** — `/model`, `/effort`, `/clear`, `/stop`, `/status`, `/undo`, `/reset`, `/compact`, `/send`, `/skills`, `/<skill>` 等
- **工具循环保护** — 同一工具连续调用 ≥15 次且无 ≥10 字符文本输出时自动终止。thinking tokens 事件重置计数器，避免 MiMo/DeepSeek 等模型思维链推理时误杀
- **MCP 兼容** — Claude 子进程可调用所有已配置的 MCP 工具

---

## 前置条件

- Node.js >= 18
- macOS (launchd) 或 Linux (systemd)
- 个人微信账号
- 已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 并完成认证

支持第三方 API 提供商，设置 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_API_KEY` 即可。模型名映射变量（`ANTHROPIC_DEFAULT_FABLE_MODEL_NAME` 等）通过 plist/systemd 自动传递给子进程。

---

## 快速开始

### 1. 安装

```bash
git clone https://github.com/YOUR_USERNAME/wechat-claude-code.git ~/.agents/skills/wechat-claude-code
cd ~/.agents/skills/wechat-claude-code && npm install
```

### 2. 扫码绑定

```bash
npm run setup
```

弹出二维码图片，用微信扫描。无图形界面的 Linux 下二维码直接显示在终端。二维码过期自动刷新。绑定后输入工作目录（默认 `~/Documents/ClaudeCode`）。

### 3. 启动服务

```bash
npm run daemon -- start
```

macOS 注册 launchd agent，开机自启、崩溃自动重启。Linux 创建 systemd user service，无 systemd 时使用 nohup + PID 文件降级。

### 4. 开始聊天

打开微信，给新联系人发消息。

### 管理服务

```bash
npm run daemon -- status    # 查看状态
npm run daemon -- stop      # 停止
npm run daemon -- restart   # 重启（更新代码后）
npm run daemon -- logs      # 查看日志
```

---

## 微信端命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/clear` | 清除会话，重新开始 |
| `/stop` | 停止当前任务并清空队列 |
| `/model <名称>` | 切换模型（haiku/sonnet/opus/fable） |
| `/effort <级别>` | 设置思考强度（none/low/medium/high/max） |
| `/prompt <内容>` | 设置全局提示词（`/prompt clear` 清除） |
| `/cwd <路径>` | 查看或切换工作目录 |
| `/status` | 查看会话状态、模型、工作目录等 |
| `/history [数量]` | 最近对话记录（默认 20，最多 100） |
| `/reset` | 完全重置（含工作目录和所有设置） |
| `/compact` | 压缩上下文：开始新 SDK 会话，保留聊天历史 |
| `/undo [数量]` | 撤销最近 N 条对话（默认 1） |
| `/send <路径>` | 发送本地文件（相对工作目录） |
| `/skills [full]` | 列出已安装 Skill（full 显示描述） |
| `/<skill>` | 触发 Skill |
| `/version` | 版本信息 |

---

## 架构

```
src/
├── main.ts                 # 入口：守护进程、消息处理循环、消息聚合、
│                           #   session 管理、自动文件推送
│
├── config.ts               # JSON 配置读写 → ~/.wechat-claude-code/config.json
│
├── session.ts              # 每个账号的会话状态：sdkSessionId、工作目录、
│                           #   模型、effort、state (idle/processing)、
│                           #   chatHistory[]（最多 100 条）、activeImages[]
│
├── logger.ts               # 每日轮转日志（北京时间，保留 30 天）
│                           敏感信息脱敏：Bearer token、bot token、
│                           context token、api key、aes key、密码
│
├── store.ts                # JSON 持久化工具（0o600 权限）
│
├── constants.ts            # 路径常量、CDN 地址
│
├── tools/
│   └── visualize-logs.ts   # 日志可视化工具（npm run visualize）
│                           生成 HTML 对比 Claude 原始输出 vs 微信实际展示内容
│                           参数：--date YYYY-MM-DD, --output 路径, --open 自动打开浏览器
│
├── claude/
│   ├── provider.ts         # Claude CLI 子进程管理
│   │   启动参数：claude -p- --output-format stream-json --verbose
│   │           --include-partial-messages --dangerously-skip-permissions
│   │           [--resume <id>] [--model <name>] [--input-format stream-json]
│   │   输入：纯文本或 stream-json NDJSON（含图片 base64）
│   │   输出：逐行解析 NDJSON 事件
│   │   Abort: SIGTERM → 5s → SIGKILL
│   │   超时：60 分钟
│   │   环境变量：CLAUDE_CODE_MAX_OUTPUT_TOKENS=320000
│   │
│   └── skill-scanner.ts    # 扫描 3 个路径下的 SKILL.md，60 秒缓存
│
├── commands/
│   ├── router.ts           # 命令路由 → handler / Skill 兜底
│   └── handlers.ts         # 全部命令实现
│
└── wechat/
    ├── api.ts              # iLink Bot REST API 客户端
    │                       限频器：每用户 2.5s 最小间隔
    │                       重试：3 次，退避 5s→10s→20s（ret:-2）
    │
    ├── monitor.ts          # 长轮询（35s 超时）、消息去重（Set 最多 1000）、
    │                       退避 3s/30s、session 过期暂停 1 小时
    │
    ├── send.ts             # 发送消息：typing 指示器（5s 保活，停止时发 CANCEL）、
    │                       sendText / sendFile
    │
    ├── types.ts            # 微信协议全部类型定义
    │
    ├── accounts.ts         # 账号凭证读写（按 mtime 加载最近账号）
    │
    ├── login.ts            # 二维码登录两阶段流程，每 3 秒轮询，过期自动重刷
    │
    ├── media.ts            # CDN 下载 + AES-ECB 解密，支持新旧两种字段格式，
    │                       MIME 从文件头识别
    │
    ├── upload.ts           # 文件上传：MD5 → AES-ECB 加密 → 获取上传 URL → POST CDN
    │                       25MB 限制，3 次重试，60s 超时
    │
    ├── cdn.ts              # CDN URL 拼接（输入正则校验）、双格式 AES key 兼容
    │
    ├── crypto.ts           # AES-128-ECB 加解密
    │
    └── sync-buf.ts         # 轮询游标持久化

### 脚本

| 脚本 | 路径 | 说明 |
|------|------|------|
| 守护进程管理 | `scripts/daemon.sh` | 跨平台 daemon 管理：start/stop/restart/status/logs。macOS 用 launchd，Linux 用 systemd/nohup |
| 日志可视化 | `src/tools/visualize-logs.ts` | `npm run visualize` — 生成 HTML 对比 Claude 原始输出 vs 微信实际展示内容。参数：`--date YYYY-MM-DD`, `--output 路径`, `--open` |
| 响应时间监控 | `~/.wechat-claude-code/scripts/timing.sh` | 从日志自动提取用户消息→Claude 响应数据（含 thinking time 占比），输出到 `logs/chat-YYYY-MM-DD.txt`。中位 26s，thinking 占比 90%+ |
```

---

## 消息流程（详细）

```
用户在微信发送文字/图片/文件
│
├── monitor.ts 长轮询接收消息
│   ├── 通过 messageId Set 去重（最多 1000）
│   └── 异步处理 onMessage()，不阻塞轮询
│
├── main.ts onMessage()
│   ├── handlePriorityCommand()：/stop 和 /clear 跳过队列，
│   │   立即 abort 活跃 AbortController，清空积压附件
│   │
│   ├── 处理中收到新消息？→ 中途截流：
│   │   终止当前查询，清空队列，合并原来内容+新指令重新发送
│   │
│   ├── 只有附件没有文字？
│   │   → aggregateAttachments()：2 秒防抖，合并到 pending
│   │
│   ├── 有文字+有积压附件？
│   │   → 检查 TTL（>5 分钟丢弃）
│   │   → 合并文字+附件 → sendToClaude()
│   │
│   ├── 纯文字？→ 入队列
│   │
│   └── 命令（/）？→ routeCommand() → handler
│
├── sendToClaude()
│   ├── 并行下载图片（Promise.all）
│   │   → CDN AES-ECB 解密 → base64 data URI
│   ├── 下载文件 → 存 /tmp/wechat-claude-code/
│   ├── 构建 system prompt（角色 + 风格 + 规则 + 聊天历史）
│   ├── 启动 typing 指示器（5s 保活）
│   ├── 启动 claude CLI 子进程
│   ├── stdin 传入消息
│   ├── 逐行解析 NDJSON stdout：
│   │   ├── text_delta → textBuffer → 段落边界或 3800 字符时推送
│   │   └── 工具调用计数 + thinking tokens 重置
│   ├── Claude 完成后：
│   │   ├── 推送剩余文本
│   │   ├── 保存 session ID + 聊天历史
│   │   ├── 自动推送检测到的文件路径
│   │   └── 停止 typing 指示器
│   └── 中断时：SIGTERM → 5s → SIGKILL，返回已收到的文本
│
└── sender.sendText() → splitMessage()
    → 优先在段落边界 (\n\n) 分割，保持 markdown 完整
    → 降级：句尾标点 → 空格 → 硬切
    → 每用户 2.5s 限频 → iLink Bot API → 微信
```

---

## 消息分割机制

`splitMessage()` 将长回复拆分为 ≤4000 字符的段落：

1. **段落边界优先** — 在 `\n\n`（双换行）处分割，保持 markdown 卡片、表格、列表的完整性
2. **超长单块降级** — `splitByNewline()` 按优先级找切割点：
   - 最后换行符（保持列表项完整）
   - 句尾标点（。！？.!?）
   - 空格（避免断词）
   - 硬切

---

## 数据目录

`~/.wechat-claude-code/`：

```
~/.wechat-claude-code/
├── accounts/           # 微信账号凭证（每账号一个 JSON）
├── config.json         # 全局配置（0o600 权限）
├── sessions/           # 各账号会话状态
├── get_updates_buf     # 消息轮询游标
└── logs/               # 每日轮转日志（保留 30 天）
```

---

## System Prompt 构成

每个查询动态构建 system prompt，最多 7 段：

1. **角色 + 日期锚点** — "你叫小 Mo，用户身边靠谱的私人助手。今天是..."
2. **语气规则** — 口语短句，禁用：首先/其次/综上所述/总而言之/值得注意的是/很高兴为您服务等
3. **诚实约束** — 不确定说"我印象中是…你确认一下"，做不到直接说"这个我搞不定"
4. **微信风格** — 短句为主，正常聊天不用 markdown，数据对比可用表格，情绪感知
5. **文件推送** — 使用 `![描述](/完整路径.png)` 语法推送文件
6. **上下文隔离** — "系统上下文中的聊天记录只是背景参考"
7. **图片标注** — 有图时注入"本条消息已附带用户发送的图片"

末尾追加全局 systemPrompt（通过 `/prompt` 设置）。

---

## 与上游项目的差异

基于 [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) (MIT)，本分支独立演进，主要改动：

**核心引擎：**
- MiMo v2.5 / DeepSeek 兼容 — thinking tokens 隔离，不混入用户可见的回复文本
- 工具循环检测：阈值提高至 15，`thinkingSinceLastTool` 标志在 thinking 事件时重置计数器
- 计数顺序修复：先重置后累加，避免 thinking 感知重启后仍被误杀
- SIGKILL 5s 兜底

**Session 管理：**
- Session resume 损坏恢复（422/"No choices" 检测 → 降级重试 + 聊天历史注入）
- 30 分钟 session 过期限制
- API 错误状态检测（最后一条 assistant 以 "API Error:" 开头则不续接）
- `activeImages[]` 存储在 session 中作为图片查询的 resume fallback

**新命令（5 个）：**
- `/effort` — 思考强度覆盖
- `/undo` — 撤销对话记录
- `/reset` — 完全重置
- `/compact` — 新 SDK 会话保留历史
- `/send` — 推送本地文件

**消息处理：**
- 消息聚合器：2 秒防抖 + 5 分钟 TTL
- 中途截流：处理中发新消息自动终止并重新路由
- 段落感知分割（`\n\n` 边界优先，3 层降级）
- 超时安抚：10 条话术轮换，5 分钟无响应时触发

**自动文件推送：**
- 扫描 Claude 回复中的文件路径（绝对路径/波浪线路径）
- 21 种扩展名支持自动推送
- 限频重试 3 次（15s → 30s → 45s）

**微信集成：**
- 每用户 2.5s 限频器
- sendMessage 重试退避（5s → 10s → 30s）
- 24 小时 typing_ticket 缓存
- typing 停止时发送 CANCEL
- 二维码显示支持 macOS/Linux/Windows
- baseUrl 白名单校验

**稳定性：**
- 启动时重置残留 processing 状态（崩溃恢复）
- 消息异步处理，轮询不阻塞
- 消息去重 Set（最多 1000，淘汰最早半）

**安全：**
- 日志脱敏：Bearer token、bot token、context token、api key、密码、aes key
- 配置文件 0o600 权限
- CDN URL 输入校验（正则白名单）
- 账号/会话文件 0o600

---

## 协议

[MIT](LICENSE) — 基于 [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code)
