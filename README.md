# memory-lancedb-pro · MCP Server

**Hermes Gateway MCP stdio 适配版** — 基于 [CortexReach/memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro) 上游改造。

将原生 OpenClaw plugin 接口的 memory-lancedb-pro 改造为 MCP Server（stdio 传输），作为 Hermes Gateway 的 subprocess 调用。

---

## 与上游的差异

| | 上游 (OpenClaw Plugin) | 本版 (MCP Server) |
|---|---|---|
| 入口 | `index.ts` / OpenClaw hooks | `mcp-server.ts` / stdio JSON-RPC |
| 工具注册 | `src/tools.ts` (Agent Tools) | `src/mcp-tools.ts` (MCP 工具，14 个) |
| 配置 | `openclaw.plugin.json` + `~/.openclaw/config.json` | `config.yaml` (独立配置) |
| Embedding | OpenClaw 环境变量 / plugin config | `config.yaml` 内的 `embedding:` 段 |
| LLM (SmartExtractor) | 复用 `embedding.apiKey` | 独立 `llm:` 配置段 |
| 日志 | `console.debug` → stdout | `console.debug` → stderr |

---

## 架构

```
MCP Client (Hermes Gateway)
    ↓ stdio JSON-RPC
mcp-server.ts
    ├── mcp-config.ts      ← 读取 config.yaml
    ├── mcp-tools.ts       ← 14 个 MCP 工具 (Zod schema)
    └── MemoryStore / MemoryRetriever / SmartExtractor (Layer A 核心逻辑)
            ↓                    ↓
        LanceDB              LLM Client
```

详见 [docs/memory_architecture_analysis.md](docs/memory_architecture_analysis.md)

---

## 快速开始

### 1. 克隆

```bash
git clone https://github.com/pty819/memory-lancedb-pro-mcp.git
cd memory-lancedb-pro-mcp
npm install
npm run build
```

### 2. 配置

复制模板并填写自己的 key：

```bash
cp config.yaml.example config.yaml
# 编辑 config.yaml
```

关键配置项：

```yaml
# config.yaml
memory:
  dbPath: ~/.memory-lancedb-pro/lancedb

# Embedding（本地 llama-server）
embedding:
  provider: openai-compatible
  apiKey: dummy-key-for-local-llama   # 本地 llama-server 不验证 key
  model: v5-small-retrieval
  baseURL: http://127.0.0.1:8080/v1
  dimensions: 1024

# LLM（SmartExtractor — 独立于 embedding）
llm:
  apiKey: your-api-key
  model: ark-code-latest
  baseURL: https://ark.cn-beijing.volces.com/api/coding/v3

# Retrieval
retrieval:
  mode: hybrid
  vectorWeight: 0.7
  bm25Weight: 0.3
```

`config.yaml` 不在 Git 跟踪范围内（`.gitignore` 已配置）。

### 3. 启动

```bash
# 直接运行（stdio 模式）
node dist/mcp-server.js

# 或编译后再运行
npm run build && node dist/mcp-server.js
```

### 4. 集成 Hermes Gateway

在 `~/.hermes/config.yaml` 中注册 MCP server：

```yaml
mcpServers:
  memory-lancedb:
    command: node
    args:
      - /path/to/memory-lancedb-pro/dist/mcp-server.js
    env:
      NODE_PATH: /path/to/memory-lancedb-pro/node_modules
```

重启 gateway 即可使用 14 个 memory 工具。

---

## 14 个 MCP 工具

| 工具 | 说明 |
|------|------|
| `memory_recall` | 混合检索（vector + BM25 + rerank）|
| `memory_ingest` | 存储单条记忆（带 SmartExtractor L0/L1/L2 抽象）|
| `memory_forget` | 删除记忆（按 ID 或搜索）|
| `memory_update` | 更新记忆文本/重要性/分类 |
| `memory_stats` | 统计：总数、scope 分布、分类分布 |
| `memory_list` | 分页列出记忆 |
| `memory_promote` | 提升记忆层级（confirmed/durable）|
| `memory_archive` | 归档记忆 |
| `memory_compact` | 去重合并（dry-run 支持）|
| `memory_debug` | 检索全链路调试（每阶段分数 + 时序）|
| `memory_explain_rank` | 解释排序原因 |
| `memory_recall_session` | 跨 session 检索 |
| `memory_self_improvement_log` | 记录学习/错误 |
| `memory_self_improvement_review` | 回顾学习记录 |

详见 [docs/MIGRATION-PLAN.md](docs/MIGRATION-PLAN.md)

---

## 上游同步

上游为 [CortexReach/memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro)（`upstream` remote）。

本仓库包含三层改动：

- **Layer A** — 上游核心业务逻辑（`src/store.ts` 等），`git pull upstream master` 自动合入
- **Layer B** — 修复应推回上游（`embedder.ts` console.error、`store.ts` ESM）
- **Layer C** — 本地 MCP 适配（`src/mcp-server.ts` 等），完全不依赖上游

同步脚本：

```bash
# 诊断
bash scripts/memory-sync-check.sh

# dry-run 看影响
bash scripts/memory-upstream-pull.sh --dry-run

# 执行 pull
bash scripts/memory-upstream-pull.sh
```

详见 [docs/UPSTREAM-SYNC.md](docs/UPSTREAM-SYNC.md)

---

## 项目文件

```
memory-lancedb-pro/
├── src/
│   ├── mcp-server.ts          MCP stdio 入口
│   ├── mcp-tools.ts           14 个 MCP 工具注册
│   ├── mcp-config.ts          config.yaml 读取
│   ├── store.ts               LanceDB 存储层（上游 Layer A）
│   ├── retriever.ts           混合检索引擎（上游 Layer A）
│   ├── embedder.ts            Embedding 抽象（上游 Layer A）
│   ├── smart-extractor.ts     LLM 智能提取（上游 Layer A）
│   └── ...
├── scripts/
│   ├── memory-sync-check.sh    同步状态诊断
│   └── memory-upstream-pull.sh  pull + 影响分析
├── docs/
│   ├── MIGRATION-PLAN.md       MCP 改造记录
│   ├── INGEST-REFORM-PLAN.md   SmartExtractor 集成
│   ├── UPSTREAM-SYNC.md        上游同步策略
│   └── memory_architecture_analysis.md 架构分析
├── config.yaml                  运行时配置（gitignored）
└── config.yaml.example           配置模板（供参考）
```
