# WeChat Claude Code Bridge

<p align="center">
  <strong>Chat with Claude Code from WeChat — text, images, voice, files</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License: MIT"></a>
</p>

Scan a QR code to bind your WeChat, and a new contact appears in your list. Send a message — it gets forwarded to Claude Code on your machine, and the reply streams back to WeChat in real time.

Written in TypeScript. Runs as a headless Node.js daemon managed by launchd (macOS) or systemd (Linux).

---

## Overview

```
WeChat (mobile) ──iLink Bot API──▶ Node.js daemon ──spawn──▶ Claude Code CLI (local)
                                        │
                                        └── MCP tools (browser, search, vision)
```

The daemon long-polls WeChat via iLink Bot API for new messages, spawns a `claude` CLI subprocess per conversation turn, and streams response text back to WeChat incrementally. Images and files downloaded from WeChat CDN (AES-ECB decrypted) are forwarded to Claude as base64 or local file paths. Files Claude generates are automatically pushed back to WeChat.

---

## Features

- **Two-way messaging** — text, images, voice transcription, files (25MB max)
- **Streaming replies** — text is delivered to WeChat incrementally while Claude is still generating. A typing indicator keeps the WeChat chat showing "typing..." throughout. If no text has been sent for 5 minutes, a randomly selected keepalive message (from a pool of 10 variants) is sent automatically.
- **Multi-image aggregation** — consecutive images/files without text are collected with a 2-second debounce timer. When the user follows up with text (within 5 minutes), everything is merged into a single Claude query. Stale attachments (>5 min TTL) are silently discarded.
- **Session resume** — maintains conversation across messages using Claude SDK `--resume <sessionId>`. Resume is skipped for image messages (avoids stale cached images), sessions older than 30 minutes, or sessions ending with an API error. On resume failure (422 / corrupted session / thinking chain break), the query automatically retries without `--resume` and injects the last 6 chat-history messages as fallback context.
- **Auto file push** — files mentioned in Claude's response with pushable extensions (`.png .jpg .pdf .doc .docx .xlsx .txt .md .csv .mp3 .mp4` etc.) are automatically sent to WeChat. Rate-limited sends retry up to 3 times with 15s/30s/45s exponential backoff.
- **Mid-stream redirect** — sending a new text message while Claude is still processing aborts the current query, clears the queue, and re-routes the combined original context + new instructions to a fresh Claude call.
- **Slash commands** — 15+ commands including `/model`, `/effort`, `/clear`, `/stop`, `/status`, `/undo`, `/reset`, `/compact`, `/send`, `/skills`, `/<skill-name>`
- **Tool loop protection** — consecutive calls to the same tool are tracked. If the same tool is called ≥15 times without producing ≥10 characters of text output, the query is aborted with a warning message. Thinking tokens (`thinking_tokens` events) reset this counter to prevent false positives on models that reason between tool calls without emitting text deltas.
- **MCP compatibility** — Claude subprocess inherits all configured MCP tools (browser automation, web search, image recognition, etc.)

---

## Prerequisites

- Node.js >= 18
- macOS (launchd) or Linux (systemd)
- A personal WeChat account
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and authenticated

Supports third-party API providers via `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`. The launchd plist / systemd service file forwards these environment variables to the Claude subprocess automatically — including model-name mapping vars (`ANTHROPIC_DEFAULT_FABLE_MODEL_NAME` etc.).

---

## Quick Start

### 1. Install & build

```bash
git clone https://github.com/YOUR_USERNAME/wechat-claude-code.git ~/.agents/skills/wechat-claude-code
cd ~/.agents/skills/wechat-claude-code && npm install
```

### 2. Bind WeChat

```bash
npm run setup
```

A QR code image opens — scan it with WeChat's built-in scanner. On headless Linux, the QR code is rendered in the terminal via `qrcode-terminal`. The bot account credentials are saved to `~/.wechat-claude-code/accounts/`. If the QR code expires before scanning, the tool automatically loops back to generate a new one.

You'll be prompted for a working directory (default: `~/Documents/ClaudeCode`).

### 3. Start the daemon

```bash
npm run daemon -- start
```

On macOS: registers a launchd agent at `~/Library/LaunchAgents/com.wechat-claude-code.bridge.plist` with `RunAtLoad` + `KeepAlive` — auto-start on boot, auto-restart on crash. On Linux: creates a systemd user service or falls back to nohup + PID file.

### 4. Start chatting

Open WeChat, find the new contact, and say hello.

### Manage the service

```bash
npm run daemon -- status    # check if running
npm run daemon -- stop      # stop service
npm run daemon -- restart   # restart after code updates
npm run daemon -- logs      # tail recent logs
```

---

## WeChat Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/clear` | Clear session, start fresh |
| `/stop` | Stop current task, clear message queue |
| `/model <name>` | Switch model (`haiku`, `sonnet`, `opus`, `fable`) |
| `/effort <level>` | Set reasoning effort (`none`/`low`/`medium`/`high`/`max`) |
| `/prompt <text>` | Set global system prompt (`/prompt clear` to remove) |
| `/cwd <path>` | View or switch working directory |
| `/status` | Show session state, model, working dir, session ID |
| `/history [n]` | Recent chat history (default 20, max 100) |
| `/reset` | Full reset — clears session, working directory, model, everything |
| `/compact` | Compact context: start new SDK session, keep chat history |
| `/undo [n]` | Remove last N messages from history (default 1) |
| `/send <path>` | Send a local file (relative to working directory) |
| `/skills [full]` | List installed Skills (`full` shows descriptions) |
| `/<skill>` | Invoke a Skill by name |
| `/version` | Version info |

---

## Architecture

```
src/
├── main.ts                 # Entry point: daemon setup, message processing loop,
│                           #   message aggregation, session management, auto-push
│
├── config.ts               # JSON config read/write (workingDirectory, model,
│                           #   systemPrompt) to ~/.wechat-claude-code/config.json
│
├── session.ts              # Session state per account: sdkSessionId,
│                           #   workingDirectory, model, effort, state (idle/processing),
│                           #   chatHistory[] (max 100), activeImages[] (resume fallback)
│
├── logger.ts               # Daily rotating file logger (CST timezone, 30-day retention)
│                           #   Sensitive data redaction: Bearer tokens, bot tokens,
│                           #   api keys, passwords, aes keys, context tokens
│
├── store.ts                # Generic JSON persist with 0o600 permission
│
├── constants.ts            # DATA_DIR, DEFAULT_WORKING_DIR, CDN_BASE_URL
│
├── claude/
│   ├── provider.ts         # Claude CLI subprocess manager
│   │   Spawn:    claude -p- --output-format stream-json --verbose
│   │            --include-partial-messages --dangerously-skip-permissions
│   │            [--resume <id>] [--model <name>]
│   │            [--append-system-prompt <text>] [--input-format stream-json]
│   │   Input:   Plain text (no images) or stream-json NDJSON (with images)
│   │   Output:  NDJSON line-by-line parser handling:
│   │             - text_delta → onText callback (incremental WeChat push)
│   │             - content_block_start (tool_use) → tool name tracking
│   │             - content_block_delta (input_json_delta) → Skill detection
│   │             - message_delta (stop_reason) → onTurnEnd callback
│   │             - thinking_tokens → resets tool loop counter
│   │             - system.init → captures session_id for --resume
│   │   Abort:   SIGTERM → 5s → SIGKILL fallback
│   │   Timeout: 60 minutes
│   │   Env:     CLAUDE_CODE_MAX_OUTPUT_TOKENS=320000
│   │            CLAUDE_CODE_EFFORT_LEVEL=per-query
│   │
│   └── skill-scanner.ts    # Scan ~/.claude/skills/, plugins/cache/*/skills/,
│                           #   plugins/cache/*/superpowers/skills/ for SKILL.md
│                           #   60-second cache TTL to avoid repeated filesystem scans
│
├── commands/
│   ├── router.ts           # /command dispatch → handler lookup → Skill fallback
│   └── handlers.ts         # All command implementations:
│                           #   /model: normalized short names only (haiku/sonnet/opus/fable)
│                           #   /effort: none/low/medium/high/max
│                           #   /send: resolves relative to working dir, 25MB limit
│                           #   /reset: full clear including workingDirectory
│                           #   /compact: preserves chatHistory, clears sdkSessionId
│                           #   /undo: slices chatHistory
│
└── wechat/
    ├── api.ts              # iLink Bot REST API HTTP client
    │   Endpoints: getUpdates, sendMessage, getConfig, sendTyping, getUploadUrl
    │   Rate limiter: per-user 2.5s minimum interval via nextSendTime Map
    │   Retry: MAX_RETRIES=3, backoff 5s→10s→20s on ret:-2
    │   Timeout: 35s for getUpdates, 15s default, 10s for getConfig/sendTyping
    │
    ├── monitor.ts          # Long-poll loop
    │   Polling: getUpdates (35s timeout long-poll), cursor persists in get_updates_buf
    │   Dedup: Set<messageId>, max 1000, evicts oldest half when full
    │   Backoff: 3s short / 30s long after 3 consecutive failures
    │   Session expired: 1-hour pause on errcode -14
    │   Processing: fire-and-forget onMessage — polling loop never blocks
    │
    ├── send.ts             # Message sender
    │   Typing indicator: fetches typing_ticket via getConfig (24h cache TTL),
    │                     sends TYPING every 5s, sends CANCEL on stop
    │   sendText: generates clientId per message
    │   sendFile: uploads to CDN → sends encrypted media message
    │
    ├── types.ts            # Full WeChat protocol type definitions:
    │                       MessageType (USER=1/BOT=2), MessageItemType
    │                       (TEXT/IMAGE/VOICE/FILE/VIDEO), CDNMedia, OutboundMessage,
    │                       GetUpdatesResp, SendMessageReq, SendTypingReq,
    │                       GetUploadUrlReq/Resp, TypingStatus, UploadMediaType
    │
    ├── accounts.ts         # Account credential persist to ~/.wechat-claude-code/accounts/
    │                       loadLatestAccount reads by mtime (supports multiple accounts)
    │
    ├── login.ts            # QR login flow
    │   Phase 1: GET /ilink/bot/get_bot_qrcode → qrcode URL + ID
    │   Phase 2: Poll GET /ilink/bot/get_qrcode_status every 3s
    │   States: wait→scaned→confirmed→expired (auto-retry on expiry)
    │   Error surface: not_support, version, forbid, reject, cancel
    │
    ├── media.ts            # CDN download + AES-ECB decryption
    │   Image CDN formats supported:
    │     - Old: cdn_media.aes_key (base64-of-raw-bytes) + cdn_media.encrypt_query_param
    │     - New: aeskey (raw hex string) + media.encrypt_query_param
    │   MIME detection from magic bytes: PNG/JPEG/GIF/WebP/BMP
    │   File download: decrypts to /tmp/wechat-claude-code/
    │
    ├── upload.ts           # File upload pipeline
    │   Reads file → MD5 hash → AES-ECB encrypt → GetUploadUrl → CDN POST
    │   25MB limit, 3 retries with 60s timeout per attempt
    │   Handles both image and file media types
    │
    ├── cdn.ts              # CDN URL builder with input validation (regex sanitization)
    │                        Handles 2 AES key formats: 16-byte raw base64 or hex-string base64
    │
    ├── crypto.ts           # AES-128-ECB encrypt/decrypt (Node.js crypto.createCipheriv)
    │
    └── sync-buf.ts         # get_updates cursor persistence via JSON store
```

---

## Message Flow (Detailed)

```
User sends text/image/file on WeChat
│
├── monitor.ts long-poll receives message
│   ├── Dedup via recentMsgIds Set (max 1000)
│   └── Fire-and-forget onMessage() callback
│
├── main.ts onMessage()
│   ├── handlePriorityCommand(): /stop and /clear bypass queue,
│   │   abort active AbortController, clear pending attachments
│   │
│   ├── session.state === 'processing'? → Mid-stream redirect:
│   │   abort current controller, clear message queue, combine
│   │   lastQueryCtx + new text → fresh sendToClaude()
│   │
│   ├── Attachments only (images/files, no text)?
│   │   → aggregateAttachments(): 2s debounce, merge into
│   │     pendingAttachments with lastAttachmentTime
│   │
│   ├── Text with pendingAttachments?
│   │   → Check TTL (>5 min? discard stale)
│   │   → Flush merged: text + pendingAttachments → sendToClaude()
│   │
│   ├── Plain text? → Push to messageQueue
│   │
│   └── Commands (/)? → routeCommand() → handler
│
├── sendToClaude()
│   ├── Download images (parallel Promise.all)
│   │   → CDN AES-ECB decrypt → base64 data URI
│   ├── Download files → save to /tmp/wechat-claude-code/
│   ├── Build system prompt (persona + tone + rules + chat history)
│   ├── Start typing indicator (5s keepalive loop)
│   ├── Spawn claude CLI subprocess
│   ├── Stream stdin (plain text or stream-json with images)
│   ├── Parse NDJSON stdout:
│   │   ├── text_delta → push to textBuffer → flush at paragraph
│   │   │   boundaries or SOFT_FLUSH_LIMIT (3800 chars)
│   │   └── tool tracking → consecutive tool count + thinking reset
│   ├── On Claude done:
│   │   ├── Flush remaining textBuffer
│   │   ├── Save session ID + chat history
│   │   ├── Auto-push detected file paths
│   │   └── Stop typing indicator
│   └── On abort: SIGTERM → 5s → SIGKILL, return partial text
│
└── sender.sendText() → splitMessage()
    → Split at double-newline boundaries (preserve markdown cards)
    → Fallback: sentence boundary → space → hard cut
    → Per-user 2.5s rate limiter → iLink Bot API → WeChat
```

---

## Message Splitting

`splitMessage()` splits long responses to stay within WeChat's ~4000-char limit:

1. **Paragraph boundary** — splits at `\n\n` (double newlines), preserving markdown cards, tables, and list blocks. Blocks are accumulated into chunks up to 4000 chars.
2. **Oversized single block** falls back to `splitByNewline()`:
   - First tries last newline in the first 4000 chars
   - Then tries sentence-ending punctuation (。！？.!?)
   - Then tries space (avoids mid-word splits)
   - Last resort: hard cut at 4000 chars

---

## Data Directory

All data stored in `~/.wechat-claude-code/`:

```
~/.wechat-claude-code/
├── accounts/           # WeChat bot credentials (one JSON per account)
├── config.json         # Global config with 0o600 permissions:
│                       #   workingDirectory, model, systemPrompt
├── sessions/           # Per-account session state:
│                       #   sdkSessionId, chatHistory[], workingDirectory,
│                       #   model, effort, activeImages[], state
├── get_updates_buf     # Long-poll cursor (persisted between restarts)
└── logs/               # Daily rotating logs (30-day retention)
    ├── bridge-YYYY-MM-DD.log
    ├── stdout.log
    └── stderr.log
```

---

## System Prompt

Each query gets a dynamically constructed system prompt with up to 7 sections:

1. **Persona + temporal anchor** — "You are XiaoMo, a reliable personal assistant. Today is YYYY-MM-DD."
2. **Tone rules** — "Speak colloquially, short sentences. Banned phrases: 首先、其次、最后、综上所述、总而言之、值得注意的是、根据您的需求、很高兴为您服务. Use conversational fillers (嗯/啊/对了/说白了). One question max per reply."
3. **Honesty constraint** — "If unsure, say 'I think it's... you check'. If you can't do something, say 'I can't handle this'. Don't make up excuses. If user corrects you, think before responding — don't default to apology or argument."
4. **WeChat style** — "Short paragraphs, plain text (no markdown in normal chat). Markdown tables OK for data comparisons. Emotional awareness when user expresses frustration. Say 'glad it's done' instead of 'happy to help'. Use tools once; if they fail, tell the user — don't retry silently."
5. **Image/file push** — "Always use `![description](/absolute/path)` syntax to push files. If user says they didn't receive it, just re-output the syntax."
6. **Context isolation** — "Previous chat history above is background context only. Respond only to the current message."
7. **Image notification** — Optional: "This message includes user-attached images." (only injected when images are present)

Plus globally configured `systemPrompt` from config.json (via `/prompt`) appended at the end.

---

## Claude CLI Environment Variables

Forced in the launchd plist / systemd service file (always applied — not inherited from shell):

| Variable | Value | Purpose |
|----------|-------|---------|
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | `1` | Strip Anthropic beta headers from API calls |
| `CLAUDE_CODE_ATTRIBUTION_HEADER` | `0` | Disable attribution info injected into prompt |
| `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS` | `1` | Remove git context from system prompt |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | `320000` | High output budget for tool-heavy multi-turn queries |
| `CLAUDE_CODE_EFFORT_LEVEL` | per-query | Override via `/effort` command or env |

Model-name mapping vars (from the environment, not forced):

| Variable | Example Value | Purpose |
|----------|--------------|---------|
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | `claude-fable-5[1M]` | Model API name for `/model fable` |
| `ANTHROPIC_DEFAULT_FABLE_MODEL_NAME` | `mimo-v2.5` | Backend model routed for fable |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `claude-haiku-4-5` | Model API name for `/model haiku` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME` | `glm-5.2` | Backend model routed for haiku |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `claude-sonnet-4-6[1M]` | Model API name for `/model sonnet` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL_NAME` | `deepseek-v4-pro` | Backend model routed for sonnet |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `claude-opus-4-8[1M]` | Model API name for `/model opus` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL_NAME` | `deepseek-v4-flash` | Backend model routed for opus |

---

## Modifications from Upstream

Based on [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) (MIT). This fork has independently evolved with significant changes:

**Core engine:**
- MiMo v2.5 / DeepSeek model compatibility — thinking tokens isolated from text buffer (no `thinking_tokens`/`api_retry`/Skill/tool_use mixed into user-facing replies)
- Tool loop detection: threshold raised to 15, `thinkingSinceLastTool` flag resets counter on thinking tokens (fixes false kills on models with thought-based reasoning between tool calls)
- Counting order fixed: reset before increment (not after), so thinking-aware restarts never trip the threshold
- SIGKILL 5s fallback after SIGTERM on process abort/timeout

**Session management:**
- Session resume with corruption recovery — detects 422 / "No choices" errors, retries without `--resume`, injects last 6 chat messages as context
- Session age limit: 30 minutes max before forced fresh start
- Error-state detection: skips resume if last assistant message starts with "API Error:"
- `activeImages[]` stored in session as resume fallback for corrupted image sessions

**Expanded commands (5 new):**
- `/effort none|low|medium|high|max` — reasoning effort override
- `/undo [n]` — remove last N exchanges from chat history
- `/reset` — full reset (session + workingDirectory + all settings)
- `/compact` — new SDK session with preserved chat history
- `/send <path>` — push local files to WeChat

**Message handling:**
- Message aggregator: 2s debounce on consecutive attachments, 5-minute TTL to discard stale images bleeding into unrelated queries
- Mid-stream redirect: messages sent while Claude is processing abort the current query and re-route the combined context
- `splitMessage()` parses at paragraph boundaries (`\n\n`) to preserve markdown integrity, with 3 fallback strategies (newline → sentence punctuation → hard cut)
- Silence keepalive: pool of 10 rotating messages, checked every 2s after 5 min of no output

**Auto file push:**
- Scans Claude's response text for absolute/tilde file paths with known extensions
- Pushes matching files to WeChat automatically
- Rate-limit retry: 3 attempts, exponential backoff (15s / 30s / 45s) for server-side ret:-2
- 21 supported extensions: images, documents, spreadsheets, audio, video

**WeChat integration:**
- Per-user rate limiter (2.5s minimum interval)
- sendMessage exponential backoff retry on ret:-2 (5s → 10s → 30s max)
- 24-hour typing_ticket cache
- Typing indicator sends CANCEL on stop (not just TYPING)
- `openFile()` supports macOS/Linux/Windows for QR code display
- Config backfill: working directory restored from config.json if session still has default `process.cwd()`

**Stability:**
- Stale session state reset on startup (detects crash-left processing state)
- Fire-and-forget message processing — polling loop never blocks on message handlers
- Message dedup via `Set<messageId>` (max 1000, evicts oldest half)

**Security:**
- Sensitive data redaction in logs: Bearer tokens, bot tokens, context tokens, api keys, passwords, aes keys — matched by regex on JSON keys and inline patterns
- log file permissions: 0o600 for config, accounts, sessions
- CDN URL input sanitization (regex whitelist)
- baseUrl validation against allowed hosts (`*.weixin.qq.com`, `*.wechat.com`)

---

## License

[MIT](LICENSE) — Based on [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code)

---

# WeChat Claude Code Bridge 微信桥接

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
