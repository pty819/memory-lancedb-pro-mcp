# Memory-LanceDB-Pro MCP 迁移计划

> **文档状态**：已完工 ✅  
> **最后更新**：2026-04-09

---

## 一、背景与目标

### 1.1 现状

`memory-lancedb-pro` 原来是 OpenClaw 生态的长期记忆插件（2204行 `tools.ts` 依赖 `openclaw/plugin-sdk`），以 OpenClaw Plugin 形式运行。

现在已改造为 **MCP Server**，通过 stdio 与 Hermes Gateway 通信，作为 Hermes 的 MCP subprocess 运行。

### 1.2 迁移目标

将 `memory-lancedb-pro` 从 OpenClaw Plugin 改造为 MCP Server，使其：
1. 通过 stdio 与 Hermes Gateway 通信
2. 保留所有现有业务逻辑（store、retriever、embedder、smart-extractor 等）
3. 通过 Hermes 内置 MCP 客户端（`config.yaml` 配置）调用，而非外部 hook 文件
4. **不再依赖 OpenClaw 插件体系**

### 1.3 约束

- **无状态调用**：每次 tool 调用 spawn 一个 node 进程 → 调 tool → 解析 stdout → 进程退出（~100-300ms 开销可接受）
- **embedding**：使用本地 llama-server（OpenAI-compatible API），地址由 config.yaml 指定
- **LLM（smart-extraction）**：使用独立 LLM 配置（`config.yaml` 的 `llm:` 段），不复用 embedding API
- **scope**：默认 `global`，支持 `agent:` 前缀
- **进程管理**：由 Hermes Gateway 的 MCP 客户端生命周期管理，不自己做 daemon

---

## 二、实际架构（改造后）

### 2.1 系统架构

```
Hermes Gateway
│
├── 内置 MCP 客户端（config.yaml mcp_servers.memory-lancedb 配置）
│     │
│     └── stdio spawn: node dist/mcp-server.js
│           │
│           ├── 读取 config.yaml（llm / embedding / retrieval / decay / scopes）
│           ├── 初始化：MemoryStore + Embedder + Retriever + DecayEngine + TierManager
│           ├── 初始化：LLMClient + SmartExtractor（用于 ingest 时 LLM 抽象）
│           │
│           └── 14 个 MCP tools 注册并响应：
│                 memory_recall / memory_ingest / memory_forget / memory_update
│                 memory_stats / memory_list / memory_debug
│                 memory_promote / memory_archive / memory_compact / memory_explain_rank
│                 self_improvement_log / self_improvement_extract_skill / self_improvement_review
│
├── SOUL.md（内置 prompt，不是外部 hook 文件）
│     定义了 memory_recall / memory_ingest / memory_forget / memory_update 等工具的
│     使用时机和调用方式，作为 agent 的行为指导
│
└── agent 自主调用工具
      agent:start  →  agent 自主判断是否调用 memory_recall（由 SOUL.md 指导）
      对话过程中  →  agent 自主判断是否调用 memory_ingest（由 SOUL.md 指导）
      agent:end     →  agent 自主判断是否调用 memory_ingest 总结
```

**关键变化**：不再用 `~/.hermes/hooks/memory/HOOK.yaml` + `handler.py` 的外部 hook 体系。Agent 通过 SOUL.md 的内置指导自主决定何时调用记忆工具。

### 2.2 文件结构（改造后）

```
~/.hermes/plugins/memory-lancedb-pro/
├── package.json              # 已改造：保留 build/start scripts
├── tsconfig.json             # 新增：TypeScript 编译配置（ES2022）
├── config.yaml               # 新增：运行时配置（llm / embedding / retrieval / decay / scopes）
├── dist/                     # 编译产物
│   └── mcp-server.js         # 入口点
├── src/
│   ├── mcp-server.ts         # ✅ 新增：MCP Server 入口（StdioServerTransport）
│   ├── mcp-tools.ts           # ✅ 新增：14 个 MCP 工具（Zod schema + 逻辑封装，1949行）
│   ├── mcp-config.ts         # ✅ 新增：config.yaml 读取器，类型化配置对象
│   └── [原有业务逻辑文件全部保留]
│       ├── store.ts           # LanceDB 存储
│       ├── retriever.ts       # 混合检索
│       ├── embedder.ts        # 向量化（修复了 console.debug → console.error）
│       ├── smart-extractor.ts # LLM 驱动的智能提取（两阶段去重 + L0/L1/L2 分层）
│       ├── llm-client.ts     # LLM 调用封装（completeJson）
│       ├── scopes.ts          # 多 Scope 隔离
│       ├── tools.ts           # ⚠️ 保留但未使用（OpenClaw 工具定义，依赖不存在的 SDK）
│       └── ...

~/.hermes/config.yaml         # Hermes Gateway 配置
  mcp_servers:
    memory-lancedb:
      command: node
      args:
        - /home/liyifan/.hermes/plugins/memory-lancedb-pro/dist/mcp-server.js
      env:
        NODE_PATH: /home/liyifan/.hermes/plugins/memory-lancedb-pro/node_modules
      timeout: 120
      connect_timeout: 60
```

### 2.3 工具列表（共 14 个）

| 工具名 | 用途 | 对应原逻辑 |
|--------|------|-----------|
| `memory_recall` | 混合检索记忆 | `registerMemoryRecallTool` |
| `memory_ingest` | 存入记忆（走 SmartExtractor） | `registerMemoryStoreTool` + SmartExtractor |
| `memory_forget` | 删除记忆 | `registerMemoryForgetTool` |
| `memory_update` | 更新记忆 | `registerMemoryUpdateTool` |
| `memory_stats` | 统计信息 | `registerMemoryStatsTool` |
| `memory_list` | 列出记忆 | `registerMemoryListTool` |
| `memory_debug` | 检索 pipeline debug | 新增 |
| `memory_promote` | 提升记忆层级 | `registerMemoryPromoteTool` |
| `memory_archive` | 归档记忆 | `registerMemoryArchiveTool` |
| `memory_compact` | 整理重复记忆 | `registerMemoryCompactTool` |
| `memory_explain_rank` | 解释排名原因 | `registerMemoryExplainRankTool` |
| `self_improvement_log` | 记录学习/错误 | `registerSelfImprovementLogTool` |
| `self_improvement_extract_skill` | 提取为 skill | `registerSelfImprovementExtractSkillTool` |
| `self_improvement_review` | 回顾学习记录 | `registerSelfImprovementReviewTool` |

---

## 三、Phase 实际执行情况

### Phase 0：现状梳理与依赖安装

| 任务 | 状态 | 备注 |
|------|------|------|
| 分析 package.json | ✅ 完成 | 已有 `@modelcontextprotocol/sdk: ^1.29.0` |
| 分析 tsconfig.json | ✅ 完成 | ES2022, ESNext module, 输出 dist/ |
| 分析 src/tools.ts | ✅ 完成 | 2204行，OpenClaw 工具定义（依赖不存在的 `openclaw/plugin-sdk`） |

### Phase 1：MCP Server 入口 + 工具注册

**新增文件：**

#### `src/mcp-config.ts`（181行）
- 读取 `config.yaml`
- 提供类型化接口：`McpConfig` 包含 `memory` / `embedding` / `llm` / `retrieval` / `decay` / `scopes` / `autoCapture` / `autoRecall`
- 关键：`llm:` 段是独立配置的，不复用 embedding 的 apiKey/baseURL

#### `src/mcp-server.ts`（119行）
- Bootstrap 顺序：loadConfig → MemoryStore → createEmbedder → createDecayEngine → createTierManager → createRetriever → createScopeManager → createLlmClient → SmartExtractor
- 注册工具后连接 StdioServerTransport
- **修复**：`embedder.ts` 中 `console.debug` 会污染 stdout（因为 node 默认 stdout/debug 同输出流），已修复为 `console.error`

#### `src/mcp-tools.ts`（1949行）
- 使用 Zod v4 做输入验证
- `registerAllMcpTools(server, deps: ToolDeps)` 单函数注册全部 14 个工具
- `ToolDeps` 接口包含：`store` / `retriever` / `embedder` / `scopeManager` / `config` / `smartExtractor`
- 每个工具都有独立的 `handle*` 函数（如 `handleMemoryRecall`、`handleMemoryIngest`）

### Phase 2：配置文件

#### `config.yaml`（68行）
配置段：
- `memory.dbPath`：LanceDB 数据目录
- `embedding`：llama-server（OpenAI-compatible），包含 `taskQuery`/`taskPassage`/`textPrefixQuery`/`textPrefixPassage`（本地 llama-server 不支持 task/input_type JSON 字段）
- `llm`：独立 LLM 配置（apiKey / model / baseURL / timeoutMs）
- `retrieval`：hybrid 模式，vectorWeight=0.7 / bm25Weight=0.3
- `decay`：Weibull 衰减配置
- `scopes`：default = global
- `autoCapture` / `autoRecall`： significance 门限过滤

#### `~/.hermes/config.yaml`（mcp_servers.memory-lancedb）
- server name 是 `memory-lancedb`（避免与 Hermes 内置 `memory` 工具冲突）
- `NODE_PATH` 设置解决模块解析问题

### Phase 3：Hermes Hook 体系（重大变更）

**原计划**（不采用）：
```
~/.hermes/hooks/memory/
├── HOOK.yaml  # Hermes hook 声明
└── handler.py  # Python 桥接层
```

**实际实现**：
```
SOUL.md（Hermes 内置 prompt）
└── memory-lancedb-pro 工具使用指导（内嵌在 SOUL.md 的 "Memory Tools — Mandatory Usage Rules" 区）
```

- Agent 通过 SOUL.md 获得工具调用指导，不再依赖外部 hook 文件
- `agent:start` / `agent:end` 的记忆调用由 agent 自主决定（SOUL.md 指导触发时机）
- 无需创建 `~/.hermes/hooks/` 目录

### Phase 4：编译 + 自测试

| 验证项 | 状态 |
|--------|------|
| `npm run build` 编译通过 | ✅ |
| MCP Server 启动（stdio） | ✅ |
| `memory_recall` 工具调用 | ✅ |
| `memory_ingest` 工具调用 | ✅ |
| `memory_forget` 工具调用 | ✅ |
| 14 工具全部注册 | ✅ |

---

## 四、已解决的技术问题

### 4.1 stdout 污染问题（console.debug）

**问题**：Node.js 默认情况下 `console.debug` 输出到 stdout，而 MCP stdio 协议要求 stdout 纯 JSON-RPC。导致 Hermes 解析 MCP 响应时混入 debug 日志。

**根因**：`embedder.ts` 大量使用 `console.debug` 记录 embedding 日志，且存在一段重定向 `process.stdout.write` 的代码。

**修复**：
1. `embedder.ts` 中所有 `console.debug` → `console.error`
2. 移除 `process.stdout.write` 重定向代码
3. `mcp-server.ts` 中 `SmartExtractor` 的 `log`/`debugLog` 回调也用 `console.error`

### 4.2 config.yaml server name 冲突

**问题**：`config.yaml` 中 server name 为 `memory`，与 Hermes 内置 `memory` 工具冲突，导致整个 MCP toolset 被跳过注册。

**修复**：重命名为 `memory-lancedb`。

### 4.3 LLM 独立配置

**问题**：原本计划复用 Hermes 主 session 的 LLM，但 MCP Server 是独立进程，无法共享。

**解决**：在 `config.yaml` 中新增独立 `llm:` 配置段，配置自己的 apiKey / model / baseURL / timeoutMs。`mcp-server.ts` 初始化 `LLMClient` 指向该配置，`SmartExtractor` 使用该 client 做 L0/L1/L2 抽象。

---

## 五、配置文件格式

### 5.1 `config.yaml`（MCP Server 运行时读取）

```yaml
# ~/.hermes/plugins/memory-lancedb-pro/config.yaml

memory:
  dbPath: ~/.memory-lancedb-pro/lancedb

embedding:
  provider: openai-compatible
  apiKey: dummy-key-for-local-llama
  model: v5-small-retrieval
  baseURL: http://127.0.0.1:8080/v1
  dimensions: 1024
  normalized: false
  chunking: true
  taskQuery: query
  taskPassage: passage
  textPrefixQuery: "Query: "
  textPrefixPassage: "Document: "

llm:
  apiKey: <your-api-key>
  model: ark-code-latest
  baseURL: https://ark.cn-beijing.volces.com/api/coding/v3
  timeoutMs: 30000

retrieval:
  mode: hybrid
  vectorWeight: 0.7
  bm25Weight: 0.3
  minScore: 0.3
  rerank: none

decay:
  recencyHalfLifeDays: 14
  frequencyWeight: 0.3
  importanceModulation: 0.2

scopes:
  default: global

autoCapture:
  enabled: true
  captureAssistant: false
  minSignificance: 0.4

autoRecall:
  enabled: true
  minQueryLength: 15
  defaultScope: global
  maxItems: 5
```

### 5.2 Hermes Gateway 配置（`~/.hermes/config.yaml`）

```yaml
mcp_servers:
  memory-lancedb:
    command: node
    args:
      - /home/liyifan/.hermes/plugins/memory-lancedb-pro/dist/mcp-server.js
    env:
      NODE_PATH: /home/liyifan/.hermes/plugins/memory-lancedb-pro/node_modules
    timeout: 120
    connect_timeout: 60
```

---

## 六、已知限制与注意事项

### 6.1 进程启动开销

每次 tool 调用约 100-300ms（node 进程 spawn 开销），对 agent 主动调用 recall/ingest 可接受。

### 6.2 `tools.ts` 保留但未使用

原 `tools.ts`（2204行，OpenClaw 工具定义）保留在项目中但未使用。它依赖 `openclaw/plugin-sdk`（不存在），TS 编译会报错，但 `dist/mcp-server.js` 不受影响。

### 6.3 SmartExtractor 路由

`memory_ingest` 走的是 `SmartExtractor.extractAndPersist()`，完整 LLM 抽象 + 两阶段去重。`config.yaml` 中 `llm:` 段必须正确配置，否则 ingest 时 LLM 调用会失败。

### 6.4 CJK 文本分块

`chunker.ts` 对 CJK 字符（中日韩）有特殊处理：`getCjkRatio()` 检测 CJK 字符占比 > 30% 时，所有字符限制除以 2.5（因为 CJK 每个字≈2-3 tokens）。

### 6.5 SOUL.md 集成

Agent 通过 `SOUL.md` 获得记忆工具的使用指导。`SOUL.md` 中的 "Memory Tools — Mandatory Usage Rules" 区块定义了触发调用时机，Agent 自主决定而非 hook 强制触发。

---

## 七、进度追踪

| 阶段 | 状态 | 完成时间 |
|------|------|---------|
| Phase 0：现状梳理与依赖安装 | ✅ 完成 | 2026-04-08 |
| Phase 1：MCP Server 入口 + 工具注册 | ✅ 完成 | 2026-04-08 |
| Phase 2：配置文件 | ✅ 完成 | 2026-04-08 |
| Phase 3：Hermes Hook 体系（改用 SOUL.md） | ✅ 完成 | 2026-04-09 |
| Phase 4：编译 + 自测试 | ✅ 完成 | 2026-04-09 |
| SmartExtractor 集成（memory_ingest） | ✅ 完成 | 2026-04-09 |
| stdout 污染修复（console.debug） | ✅ 完成 | 2026-04-09 |
| config.yaml server name 冲突修复 | ✅ 完成 | 2026-04-09 |

---

*文档版本：v2.0*  
*最后更新：2026-04-09*
