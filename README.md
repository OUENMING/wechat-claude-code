# WeChat Claude Code 微信桥接

> 扫码绑定微信，在聊天框里和 Claude Code 对话——文字、图片、语音、文件，回复实时推送回微信。

[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-blue?style=flat-square)](https://github.com/OUENMING/wechat-claude-code)
[![English](https://img.shields.io/badge/English-blue?style=flat-square)](README_en.md)

TypeScript 编写，Node.js 后台守护进程。macOS 用 launchd 管理，Linux 用 systemd，Windows 用 daemon.cmd。

## 功能

- **双向消息** — 文字、图片、语音转文字、文件（最大 25MB）
- **流式回复** — 文本增量推送，微信显示"对方正在输入…"。超 5 分钟无响应自动发送安抚话术
- **多图聚合** — 连续发图时 2 秒防抖收集，发文字后合并为一次查询
- **会话续接** — 跨消息保持上下文，支持 `--resume`。30 分钟过期自动降级
- **自动文件推送** — Claude 回复中提到的文件自动发到微信
- **中途截流** — Claude 还在处理时发新消息，自动终止当前查询重新发送
- **15+ 斜杠命令** — `/model`, `/effort`, `/clear`, `/stop`, `/status`, `/undo`, `/reset`, `/compact`, `/send`, `/skills`, `/<skill>` 等
- **工具循环保护** — 同一工具连续调用 ≥15 次且无文本输出时自动终止
- **MCP 兼容** — Claude 子进程可调用所有已配置的 MCP 工具

## 快速开始

### 前置条件
- Node.js >= 18
- macOS (launchd) / Linux (systemd) / Windows
- 个人微信账号
- 已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 并完成认证

### 1. 安装

```bash
git clone https://github.com/YOUR_USERNAME/wechat-claude-code.git
cd wechat-claude-code && npm install
```

### 2. 扫码绑定

```bash
npm run setup
```

弹出二维码，用微信扫描。绑定后输入工作目录（默认 `~/Documents/ClaudeCode`）。

### 3. 启动服务

```bash
npm run daemon -- start
```

macOS 注册 launchd agent 开机自启；Linux 创建 systemd user service（无 systemd 时 nohup 降级）；Windows 使用 `scripts/daemon.cmd`。

### 4. 开始使用

打开微信，给新联系人发消息。

### 管理

```bash
npm run daemon -- status    # 查看状态
npm run daemon -- stop      # 停止
npm run daemon -- restart   # 重启（更新代码后）
npm run daemon -- logs      # 查看日志
```

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
| `/status` | 查看会话状态、模型、工作目录 |
| `/history [数量]` | 最近对话记录（默认 20，最多 100） |
| `/reset` | 完全重置（含工作目录和所有设置） |
| `/compact` | 压缩上下文：新 SDK 会话，保留聊天历史 |
| `/undo [数量]` | 撤销最近 N 条对话（默认 1） |
| `/send <路径>` | 发送本地文件（相对工作目录） |
| `/skills [full]` | 列出已安装 Skill |
| `/<skill>` | 触发 Skill |
| `/version` | 版本信息 |

## 架构

```
src/
├── main.ts               # 入口：守护进程、消息处理、session 管理、自动文件推送
├── config.ts             # JSON 配置 → ~/.wechat-claude-code/config.json
├── session.ts            # 会话状态：sdkSessionId、工作目录、模型、chatHistory
├── logger.ts             # 每日轮转日志（北京时间，保留 30 天），敏感信息脱敏
├── store.ts              # JSON 持久化（0o600 权限）
├── constants.ts          # 路径常量、CDN 地址
├── tools/
│   └── visualize-logs.ts # 日志可视化工具（npm run visualize）
├── claude/
│   ├── provider.ts       # Claude CLI 子进程管理
│   └── skill-scanner.ts  # SKILL.md 扫描（60 秒缓存）
├── commands/
│   ├── router.ts         # 命令路由
│   └── handlers.ts       # 全部命令实现
└── wechat/
    ├── api.ts            # iLink Bot REST API + 限频器
    ├── monitor.ts        # 长轮询（35s 超时）、消息去重
    ├── send.ts           # 消息发送（typing 指示器 + 文本/文件）
    ├── types.ts          # 协议类型定义
    ├── accounts.ts       # 账号凭证读写
    ├── login.ts          # 二维码登录
    ├── media.ts          # CDN 下载 + AES-ECB 解密
    ├── upload.ts         # 文件上传（25MB 限制）
    ├── cdn.ts            # CDN URL 拼接
    ├── crypto.ts         # AES-128-ECB 加解密
    └── sync-buf.ts       # 轮询游标持久化
```

### 脚本

| 脚本 | 路径 | 说明 |
|------|------|------|
| 守护进程管理 | `scripts/daemon.sh` | 跨平台 daemon 管理 |
| 日志可视化 | `src/tools/visualize-logs.ts` | `npm run visualize` |
| 响应时间监控 | `~/.wechat-claude-code/scripts/timing.sh` | 从日志提取响应数据 |

## 消息流程

```
用户在微信发送文字/图片/文件
│
├── monitor.ts 长轮询接收 → 去重 → 异步处理
│
├── main.ts onMessage()
│   ├── /stop 和 /clear 优先处理，跳过队列立即执行
│   ├── 处理中收到新消息 → 中途截流：终止当前查询，合并重发
│   ├── 只有附件无文字 → 2 秒防抖聚合
│   ├── 有文字+积压附件 → 检查 TTL（>5 分钟丢弃）→ 合并发送
│   ├── 纯文字 → 入队列
│   └── 命令（/）→ 路由到 handler
│
├── sendToClaude()
│   ├── 并行下载图片（CDN AES-ECB 解密）
│   ├── 构建 system prompt（角色+风格+规则+聊天历史）
│   ├── 启动 typing 指示器（5s 保活）
│   ├── 启动 claude CLI 子进程 → 逐行解析 NDJSON
│   └── 完成后推送剩余文本 + 保存 session + 自动推送文件
│
└── sendText() → splitMessage()
    → \n\n 段落边界优先 → 句尾标点 → 空格 → 硬切
    → 每用户 2.5s 限频 → iLink Bot API → 微信
```

## System Prompt 构成

每个查询动态构建：

1. **角色 + 日期** — "你叫小 Mo，用户身边靠谱的私人助手。今天是..."
2. **语气规则** — 口语短句，禁用"首先/其次/综上所述/值得注意的是"等
3. **诚实约束** — 不确定说"我印象中是…你确认一下"
4. **微信风格** — 短句为主，正常聊天不用 markdown
5. **文件推送** — 使用 `![描述](/完整路径.png)` 语法
6. **上下文隔离** — "聊天记录只是背景参考"
7. **图片标注** — 有图时注入图片提示

## 数据目录

```
~/.wechat-claude-code/
├── accounts/           # 微信账号凭证
├── config.json         # 全局配置（0o600 权限）
├── sessions/           # 各账号会话状态
├── get_updates_buf     # 消息轮询游标
└── logs/               # 每日轮转日志（保留 30 天）
```

## 与上游项目的差异

基于 [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) (MIT)，本分支独立演进的主要改动：

**核心引擎**
- MiMo v2.5 / DeepSeek 兼容 — thinking tokens 隔离，不混入回复文本
- 工具循环检测：阈值提高至 15，thinking 事件重置计数器
- SIGKILL 5s 兜底

**Session 管理**
- Session resume 损坏恢复（422/"No choices" 检测 → 降级重试 + 聊天历史注入）
- 30 分钟 session 过期限制
- API 错误状态检测

**新命令（5 个）**
- `/effort`、`/undo`、`/reset`、`/compact`、`/send`

**消息处理**
- 消息聚合器：2 秒防抖 + 5 分钟 TTL
- 中途截流：处理中发新消息自动终止并重新路由
- 段落感知分割（`\n\n` 边界优先，3 层降级）
- 超时安抚：10 条话术轮换

**自动文件推送**
- 扫描 Claude 回复中的文件路径，21 种扩展名支持
- 限频重试 3 次（15s → 30s → 45s）

**稳定性**
- 启动时重置残留 processing 状态（崩溃恢复）
- 消息异步处理，轮询不阻塞
- 消息去重 Set（最多 1000）

**安全**
- 日志脱敏：Bearer token、bot token、api key、密码、aes key
- 配置文件 0o600 权限
- CDN URL 正则白名单校验

## 开发

```bash
npm run build        # 编译 TypeScript
npm run dev          # 监听模式
npm run test         # 运行测试
```

## License

[MIT](LICENSE)

基于 [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code)
