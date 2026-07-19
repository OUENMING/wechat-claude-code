# WeChat Claude Code 微信桥接

> 在微信里和 Claude Code 聊天——文字、图片、语音、文件，扫码即用

[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-blue?style=flat-square)](https://github.com/OUENMING/wechat-claude-code)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-brightgreen?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square)](https://www.typescriptlang.org/)

## 项目介绍

WeChat Claude Code 是一个微信 ↔ Claude Code 的双向消息桥接工具。扫码绑定微信后，你的联系人里会多出一个好友，发消息给它，内容自动转发到电脑上运行的 Claude Code，回复实时推送回微信。

### 核心功能

- **双向消息** — 文字、图片、语音转文字、文件（最大 25MB）
- **流式回复** — 文本增量推送，微信显示"对方正在输入…"。超 5 分钟无响应时自动发送安抚话术（10 条轮换）
- **多图聚合** — 连续发送图片/文件时 2 秒防抖收集，发文字后合并为一次 Claude 查询。超过 5 分钟积压附件自动丢弃
- **会话续接** — 跨消息保持上下文，`--resume` 续接。30 分钟过期不续、含图片时不续、上一条 API 错误不续。续接失败时自动降级重试
- **自动文件推送** — Claude 回复中提到的文件路径（21 种扩展名）自动发到微信，限频时重试 3 次
- **中途截流** — Claude 还在处理时发新消息，自动终止当前查询、清空队列、合并原指令+新内容重新发送
- **15+ 斜杠命令** — `/model`, `/effort`, `/clear`, `/stop`, `/status`, `/undo`, `/reset`, `/compact`, `/send`, `/skills`, `/<skill>` 等
- **工具循环保护** — 同一工具连续调用 ≥15 次且无 ≥10 字符文本输出时自动终止。thinking tokens 重置计数器，避免思维链推理时误杀
- **MCP 兼容** — Claude 子进程可调用所有已配置的 MCP 工具

### 适用场景

- 不想打开终端，在手机上随时用 Claude Code 解决问题
- 快速转发截图、文档给 Claude 进行分析
- 在微信中管理 Claude Code 会话、切换模型、调整思考强度
- 团队协作场景：把 Claude Code 当作微信里的 AI 助手

## 功能清单

| 功能名称 | 功能说明 | 技术栈 | 更新时间 | 版本 |
|---------|---------|--------|----------|------|
| 消息收发 | 文字/图片/语音/文件双向互通 | TypeScript + iLink Bot API | 2026-07-19 | v1.0.0 |
| 流式回复 | 增量推送 + typing 指示器 | NDJSON + 限频器 | 2026-07-19 | v1.0.0 |
| 多图聚合 | 防抖合并附件 | 队列 + TTL | 2026-07-19 | v1.0.0 |
| 会话管理 | resume + 过期 + 降级 | SDK session | 2026-07-19 | v1.0.0 |
| 中途截流 | 处理中发新消息自动终止 | AbortController | 2026-07-19 | v1.0.0 |
| 文件推送 | 自动检测并推送文件 | 路径正则 + 指数退避 | 2026-07-19 | v1.0.0 |
| 命令系统 | 15+ 斜杠命令 | 路由 + handler | 2026-07-19 | v1.0.0 |
| 工具循环保护 | 防止工具无限循环 | 计数器 + thinking 感知 | 2026-07-19 | v1.0.0 |
| 日志系统 | 每日轮转 + 脱敏 | stdout | 2026-07-19 | v1.0.0 |
| 守护进程 | 开机自启 + 崩溃恢复 | launchd/systemd | 2026-07-19 | v1.0.0 |

## 技术栈

| 技术 | 版本 | 用途 | 官网 |
|------|------|------|------|
| TypeScript | 5.7 | 开发语言 | https://www.typescriptlang.org/ |
| Node.js | >=18 | 运行环境 | https://nodejs.org |
| iLink Bot API | — | 微信 Bot 协议接入 | — |
| qrcode-terminal | 0.12 | 终端二维码显示 | https://github.com/gtanner/qrcode-terminal |
| qrcode | 1.5 | 二维码图片生成 | https://github.com/soldair/node-qrcode |

### 技术架构

```
           微信 App
              │
      iLink Bot API (长轮询 + 消息发送)
              │
    ┌─────────────────────┐
    │    wechat-claude-code     │
    │                         │
    │  main.ts (守护进程)      │
    │  ├── monitor.ts (轮询)   │
    │  ├── send.ts (发送)      │
    │  ├── provider.ts (子进程)  │
    │  └── commands/ (路由)    │
    └────────┬────────────┘
              │ stdio (NDJSON)
              ↓
         Claude Code CLI
```

## 项目结构

```
wechat-claude-code/
├── src/
│   ├── main.ts                  # 入口：守护进程、消息处理循环、session 管理
│   ├── config.ts                # JSON 配置 → ~/.wechat-claude-code/config.json
│   ├── session.ts               # 每个账号的会话状态
│   ├── logger.ts                # 每日轮转日志（保留 30 天），敏感信息脱敏
│   ├── store.ts                 # JSON 持久化工具（0o600 权限）
│   ├── constants.ts             # 路径常量、CDN 地址
│   ├── claude/
│   │   ├── provider.ts          # Claude CLI 子进程管理
│   │   └── skill-scanner.ts     # SKILL.md 扫描（60 秒缓存）
│   ├── commands/
│   │   ├── router.ts            # 命令路由 → handler / Skill 兜底
│   │   └── handlers.ts          # 全部命令实现
│   ├── tools/
│   │   └── visualize-logs.ts    # 日志可视化工具
│   └── wechat/
│       ├── api.ts               # iLink Bot REST API + 限频器
│       ├── monitor.ts           # 长轮询、消息去重
│       ├── send.ts              # 发送消息（typing 指示器 + 文本/文件）
│       ├── types.ts             # 协议全部类型定义
│       ├── accounts.ts          # 账号凭证读写
│       ├── login.ts             # 二维码登录
│       ├── media.ts             # CDN 下载 + AES-ECB 解密
│       ├── upload.ts            # 文件上传
│       ├── cdn.ts               # CDN URL 拼接
│       ├── crypto.ts            # AES-128-ECB 加解密
│       └── sync-buf.ts          # 轮询游标持久化
├── scripts/
│   ├── daemon.sh                # 守护进程管理（macOS/Linux/Windows）
│   └── daemon.cmd               # Windows 守护进程
├── SKILL.md                     # Claude Code Skill 定义
├── package.json
├── tsconfig.json
└── LICENSE                      # MIT
```

## 安装说明

### 环境要求

- Node.js >= 18
- macOS（launchd）/ Linux（systemd）/ Windows（PowerShell）
- 个人微信账号
- 已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 并完成认证

### 安装步骤

```bash
# 方式一：直接安装
git clone https://github.com/YOUR_USERNAME/wechat-claude-code.git
cd wechat-claude-code && npm install

# 方式二：扫码绑定微信
npm run setup

# 方式三：启动服务
npm run daemon -- start
```

### 配置说明

配置文件位于 `~/.wechat-claude-code/config.json`（0o600 权限），包含工作目录、模型配置等。

支持第三方 API 提供商，设置 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_API_KEY` 即可。

## 使用说明

### 快速开始

```bash
# 1. 安装
git clone https://github.com/YOUR_USERNAME/wechat-claude-code.git
cd wechat-claude-code && npm install

# 2. 扫码
npm run setup

# 3. 启动
npm run daemon -- start

# 4. 查看状态
npm run daemon -- status
```

### 服务管理

```bash
npm run daemon -- start     # 启动
npm run daemon -- stop      # 停止
npm run daemon -- restart   # 重启
npm run daemon -- status    # 查看状态
npm run daemon -- logs      # 查看日志
```

Windows 用户使用 `scripts\daemon.cmd` 替代。

### 微信端命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/clear` | 清除会话 |
| `/stop` | 停止当前任务 |
| `/model <名称>` | 切换模型（haiku/sonnet/opus/fable） |
| `/effort <级别>` | 设置思考强度 |
| `/prompt <内容>` | 设置全局提示词 |
| `/cwd <路径>` | 切换工作目录 |
| `/status` | 查看会话状态 |
| `/history [数量]` | 最近对话记录 |
| `/reset` | 完全重置 |
| `/compact` | 压缩上下文 |
| `/undo [数量]` | 撤销对话 |
| `/send <路径>` | 发送本地文件 |
| `/skills [full]` | 列出 Skill |
| `/<skill>` | 触发 Skill |

## 开发指南

### 本地开发

```bash
npm run build        # 编译 TypeScript
npm run dev          # 监听模式
npm run test         # 运行测试
```

### 日志可视化

```bash
npm run visualize -- --date 2026-07-19 --open
```

生成 HTML 对比 Claude 原始输出 vs 微信实际展示内容。

### 贡献指南

欢迎提交 Issue 和 PR。请确保代码通过 `npm run build` 编译，新增功能附上测试。

## 常见问题

<details>
<summary>安装后二维码不显示？</summary>

确保终端支持图像显示。macOS 的 Terminal.app 和 iTerm2 均支持。如果二维码无法渲染，手机会弹出二维码图片文件，用微信扫描即可。Linux 无图形界面下二维码直接显示在终端中。

</details>

<details>
<summary>如何更换微信账号？</summary>

重新运行 `npm run setup`，会覆盖原有账号凭证。旧账号会自动失效。

</details>

<details>
<summary>Claude 回复太慢怎么办？</summary>

检查网络连接。可以在微信中使用 `/model fable` 切换到 Fable 模型获取更快的响应，或使用 `/effort low` 降低思考强度。

</details>

<details>
<summary>支持哪些文件格式？</summary>

图片（jpg/png/gif/webp/bmp）、语音自动转文字、一般文件最大 25MB。Claude 回复中检测到的文件路径会自动推送，支持 21 种扩展名。

</details>

## 数据目录

```
~/.wechat-claude-code/
├── accounts/           # 微信账号凭证（每账号一个 JSON）
├── config.json         # 全局配置（0o600 权限）
├── sessions/           # 各账号会话状态
├── get_updates_buf     # 消息轮询游标
└── logs/               # 每日轮转日志（保留 30 天）
```

## 与上游项目的差异

基于 [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) (MIT)，本分支主要改动：

**核心引擎**
- MiMo v2.5 / DeepSeek 兼容 — thinking tokens 隔离，不混入回复
- 工具循环保护：阈值 15，thinking 事件重置计数器
- SIGKILL 5s 兜底

**新增命令**
- `/effort`、`/undo`、`/reset`、`/compact`、`/send`

**消息处理**
- 消息聚合器（2 秒防抖 + 5 分钟 TTL）
- 中途截流（处理中发新消息自动终止）
- 段落感知分割（`\n\n` 优先，3 层降级）
- 超时安抚（10 条话术轮换）

**安全**
- 日志脱敏：Bearer token、bot token、api key、密码、aes key
- 配置文件 0o600 权限
- CDN URL 正则校验

## 路线图

### 计划功能

- [ ] 多账号同时在线
- [ ] Web 管理面板
- [ ] 群聊模式支持
- [ ] 定时任务 / 消息推送

### 优化计划

- [ ] 消息处理性能优化
- [ ] 更智能的上下文管理
- [ ] 插件系统

## License

MIT

基于 [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code)

## Star History

<a href="https://www.star-history.com/?type=date&repos=OUENMING%2Fwechat-claude-code">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=OUENMING/wechat-claude-code&type=date&theme=dark&legend=top-left&sealed_token=9fEO20uf6c1w5UfJNAbT38Gv4BD2ujfgqln8dt6mhx3O7yke6n2vbEmgA6uVhPFqgr9-55uV9GGzGos90iHB_asQHN_xglmvMyw7KW9gOenvfT1HtoQ6jQ" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=OUENMING/wechat-claude-code&type=date&legend=top-left&sealed_token=9fEO20uf6c1w5UfJNAbT38Gv4BD2ujfgqln8dt6mhx3O7yke6n2vbEmgA6uVhPFqgr9-55uV9GGzGos90iHB_asQHN_xglmvMyw7KW9gOenvfT1HtoQ6jQ" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=OUENMING/wechat-claude-code&type=date&legend=top-left&sealed_token=9fEO20uf6c1w5UfJNAbT38Gv4BD2ujfgqln8dt6mhx3O7yke6n2vbEmgA6uVhPFqgr9-55uV9GGzGos90iHB_asQHN_xglmvMyw7KW9gOenvfT1HtoQ6jQ" />
 </picture>
</a>
