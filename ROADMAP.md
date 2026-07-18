# WeChat Claude Code — Roadmap

> 从效率工具 → 生活/学习助手 → 情感陪伴

---

## 已完成（Phase 0 - 工具层）

- [x] 消息聚合（多图片合并，去抖收集）
- [x] 多模态（图片+文件+文字的 ClaudeTask 统一调度）
- [x] 流式响应拆分包
- [x] 会话续接 + 图片缓存回退（activeImages）
- [x] launchd 守护、launchctl 管理
- [x] 基础命令系统（/stop, /clear）
- [x] cc-switch 代理兼容

## Phase 1 — 生活/学习助手

**目标：从"工具调用接口"变成"有记忆的助手"**

### 1.1 长期记忆层（需新增 `memory/` 模块）

- 持久化存储用户信息：日程、课程、偏好、进行中的项目
- 跨会话上下文：昨天聊过的论文、上周存的笔记
- 主动记忆写入 / 检索（LLM 提取关键事实 → 存本地）

### 1.2 主动推送（需新增 cron / timer 机制）

- 每日摘要（天气、日程、ddl）
- 提醒（"你下午有考试"）
- 基于时间的触发器（launchd 定期检查或长轮询）

### 1.3 知识库检索（需集成 RAG）

- 用户上传的 PDF / 笔记 → 向量化 → 检索增强回答
- 学习辅导：根据用户课程知识点做 quiz / 解释
- 参考实现：mcp‑vision + embed 工具

### 1.4 平台化命令系统

- 扩展命令系统（`/note`, `/remind`, `/search`……）
- /note 存笔记 → 进入长期记忆
- /search 检索历史 + 知识库
- /remind 设置提醒

### 1.5 系统提示分层

- 动态 system prompt：根据对话上下文切换"层级"
- 当前活跃：personal info（名字、学校）、session context
- 待实现：proactive mode（定时触发时插入）

---

## Phase 2 — 情感陪伴 / 聊天角色

**目标：在生活助手之上叠加伴侣层**

### 2.1 检测层

- 用户输入分类：工具型（"帮我查"）vs 情感型（"今天好累"）
- 规则简单：情绪关键词 + 无明确命令 + 短文本 → companion
- 可配置角色："学长""学姐""树洞"——从 session 或命令切换

### 2.2 回复风格切换

- 工具模式 → 目前不变（Markdown、结构化、可执行建议）
- 陪伴模式 → 短句、共情优先、不加 Markdown、不反问"是否执行"
- 同一段会话中可以切换（如：用户先问"帮我看看作业"→ 工具模式 → 说"好累" → 切陪伴模式）

### 2.3 风格配置

- `session.persona`：`assistant` / `companion` / `mentor`
- 命令切换：`/persona assistant`、`/persona companion`
- system prompt 里条件插入角色描述

### 2.4 长期记忆 + 情感上下文

- 记忆记录关键生活事件（考试、生病、旅行）
- 陪伴模式下引用这些记忆（"你上周说考试压力大，考得怎么样？"）
- 边界：不做心理诊断，提示"建议咨询专业人士"

---

## 架构原则

```
微信消息 
    │
    ▼
Message Aggregator 
    │
    ▼
ClaudeTask（统一任务）
    │
    ▼
意图分类（Phase 2 → 工具/陪伴）
    │
    ▼
Queue（FIFO 串行）
    │
    ▼
sendToClaude()
    │
    ├─ 附件下载 / 记忆检索
    ├─ systemPrompt 动态构建（角色 + 记忆 + 状态）
    └─ → Claude CLI
```

- ClaudeTask 保持统一，意图分类只在 queue 之前做
- 记忆存储和消息处理解耦（memory 模块不依赖 queue）
- 角色切换不需要改架构，只需要改 systemPrompt 和回复后处理

## 依赖

- **Phase 1**: 向量数据库（本地 SQLite + embeddings 够用）、定时器机制、文件存储
- **Phase 2**: 无额外依赖，纯 prompt 工程 + 简单文本分类

## 边界声明

- 所有 AI 输出都经过系统提示约束："你在不确定时不编造"
- 情感陪伴不是心理治疗，不诊断不处方
- 长期记忆不出现在不应出现的上下文中（隐私原则）
