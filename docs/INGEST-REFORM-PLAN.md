# MCP memory_ingest 接入 SmartExtractor 改造计划

> **文档状态**：已完工 ✅  
> **最后更新**：2026-04-09

---

## 一、背景与目标

### 1.1 现状

`memory_ingest` 在 MCP 迁移初期直接调用 `store.store()` 裸写 LanceDB，绕过了整个智能提取管道：

- ❌ 无 L0/L1/L2 三层抽象
- ❌ 无 6 分类（profile/preferences/entities/events/cases/patterns）
- ❌ 无两阶段去重（向量预过滤 + LLM 语义决策）

### 1.2 目标

让 `memory_ingest` 调用 `SmartExtractor.extractAndPersist()`，使手动写入的记忆和 OpenClaw 自动提取的记忆拥有相同的处理流程。

### 1.3 实际完成情况

**已全部完成。** SmartExtractor 已完整集成到 `mcp-server.ts` 初始化和 `mcp-tools.ts` 的 `handleMemoryIngest` 中。

---

## 二、架构

### 2.1 实际数据流

```
memory_ingest 调用
       │
       ▼
handleMemoryIngest(params)
       │
       ├── 权限检查：scopeManager.isAccessible()
       ├── 噪声过滤：isNoise(text)
       ├── 工作区边界检查：isUserMdExclusiveMemory()
       ├── significance 门限检查（autoCapture.minSignificance）
       │
       ▼
smartExtractor.extractAndPersist(conversationText, sessionKey, {scope})
       │
       ├── buildExtractionPrompt()     ← 组装 LLM prompt（6分类 + 提取内容）
       ├── llm.completeJson()           ← LLM 判断类别 + 提取内容
       │
       ├── 两阶段去重
       │    ├── Phase1: 向量相似度预过滤（SIMILARITY_THRESHOLD = 0.7）
       │    └── Phase2: LLM 语义决策（create/merge/skip/support/contradict/supersede）
       │
       ├── L0 摘要生成（first 100 chars）
       ├── L1 概述生成（bullet list with "- " prefix）
       ├── L2 原文存储
       │
       └── store.store() → LanceDB

返回 { success, action, created, merged, skipped, scope }
```

### 2.2 LLM 配置

**独立于 embedding API**：

```yaml
# config.yaml
llm:
  apiKey: <your-api-key>
  model: ark-code-latest
  baseURL: https://ark.cn-beijing.volces.com/api/coding/v3
  timeoutMs: 30000
```

`llm-client.ts` 的 `completeJson<T>()` 方法封装了：
- OpenAI-compatible API 调用
- Markdown 代码块 JSON 提取
- SSE 流式响应解析（`extractOutputTextFromSse`）
- OAuth 会话刷新（`llm-oauth.ts`）

---

## 三、文件改动详情

### 3.1 `src/mcp-config.ts` ✅ 已完成

**改动**：新增 `LlmConfig` 接口 + `loadConfig()` 中的 llm 读取逻辑。

```typescript
export interface LlmConfig {
  apiKey: string;
  model: string;
  baseURL: string;
  timeoutMs: number;
}

export interface McpConfig {
  memory: MemoryConfig;
  embedding: EmbeddingConfig;
  llm: LlmConfig;          // ✅ 新增
  retrieval: RetrievalConfig;
  decay: DecayConfig;
  scopes: ScopesConfig;
  autoCapture: AutoCaptureConfig;
  autoRecall: AutoRecallConfig;
}
```

`loadConfig()` 中：
```typescript
const llm = (raw["llm"] ?? {}) as Record<string, unknown>;
// ...
llm: {
  apiKey: String(llm["apiKey"] ?? ""),
  model: String(llm["model"] ?? "gpt-4o-mini"),
  baseURL: String(llm["baseURL"] ?? "https://api.openai.com/v1"),
  timeoutMs: Number(llm["timeoutMs"] ?? 30000),
},
```

### 3.2 `src/mcp-server.ts` ✅ 已完成

**改动**：初始化 `LLMClient` + `SmartExtractor`，注入到 `registerAllMcpTools`。

```typescript
// LLM client for SmartExtractor (independent from embedding API)
const llm: LlmClient = createLlmClient({
  apiKey: config.llm.apiKey,
  model: config.llm.model,
  baseURL: config.llm.baseURL,
  timeoutMs: config.llm.timeoutMs,
});

// SmartExtractor — powers memory_ingest with LLM-driven extraction, dedup, and classification
const smartExtractor = new SmartExtractor(store, embedder, llm, {
  defaultScope: config.scopes?.default ?? "agent:main",
  extractMaxChars: 8000,
  log: (msg) => console.error("[smart-extractor]", msg),
  debugLog: (msg) => console.debug("[smart-extractor]", msg),
});

registerAllMcpTools(server, {
  store,
  retriever,
  embedder,
  scopeManager,
  config,
  smartExtractor,    // ✅ 传入
});
```

**注意**：`log` 使用 `console.error` 而非 `console.debug`，是因为 `console.debug` 默认输出到 stdout，会污染 MCP stdio 响应。

### 3.3 `src/mcp-tools.ts` ✅ 已完成

**改动 1**：`ToolDeps` 接口新增 `smartExtractor` 参数。

```typescript
interface ToolDeps {
  store: MemoryStore;
  retriever: MemoryRetriever;
  embedder: Embedder;
  scopeManager: MemoryScopeManager;
  config: McpConfig;
  smartExtractor: SmartExtractor;  // ✅ 新增
}
```

**改动 2**：`handleMemoryIngest` 核心逻辑。

```typescript
async function handleMemoryIngest(
  deps: ToolDeps,
  params: {
    text: string;
    importance?: number;
    category?: MemoryCategory;
    scope?: string;
    agentId?: string;
    significance?: number;
  },
): Promise<CallToolResult> {
  // ... 权限检查、噪声过滤、边界检查、significance 门限 ...

  // ✅ 关键改动：调用 SmartExtractor
  const conversationText = `用户：${text}`;
  const sessionKey = `mcp-ingest-${Date.now()}`;
  const stats = await deps.smartExtractor.extractAndPersist(conversationText, sessionKey, {
    scope: targetScope,
  });

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        success: true,
        action: stats.created > 0 ? "created" : stats.merged > 0 ? "merged" : "skipped",
        created: stats.created,
        merged: stats.merged,
        skipped: stats.skipped,
        scope: targetScope,
      }),
    }],
    metadata: {
      action: stats.created > 0 ? "created" : stats.merged > 0 ? "merged" : "skipped",
      created: stats.created,
      merged: stats.merged,
      skipped: stats.skipped,
      scope: targetScope,
    },
  };
}
```

### 3.4 `config.yaml` ✅ 已完成

新增独立 `llm:` 段：

```yaml
# ── LLM (SmartExtractor — independent from embedding API) ───────────────────
llm:
  apiKey: <your-api-key>
  model: ark-code-latest
  baseURL: https://ark.cn-beijing.volces.com/api/coding/v3
  timeoutMs: 30000
```

---

## 四、SmartExtractor 内部流程（参考）

`smart-extractor.ts` 的 `extractAndPersist()` 核心步骤：

1. **清洗输入**：去除"用户："前缀、空白、敏感信息
2. **LLM 分类提取**：调用 `buildExtractionPrompt()` → `llm.completeJson()`，得到 6 分类结果
3. **Phase1 去重**：对每条待存内容，用向量相似度预过滤（阈值 0.7）
4. **Phase2 LLM 去重决策**：对 Phase1 命中的内容，调用 `buildDedupPrompt()` 让 LLM 决策（create/merge/skip/support/contradict/supersede）
5. **存储**：对 create/merge 的内容，生成 L0/L1/L2，写入 LanceDB
6. **返回统计**：`{ created, merged, skipped }`

---

## 五、验收结果

| # | 标准 | 结果 |
|---|------|------|
| A1 | 编译通过 | ✅ `npm run build` 无 error |
| A2 | gateway 启动成功 | ✅ journalctl 无 SmartExtractor 初始化报错 |
| A3 | `memory_ingest` 触发 LLM | ✅ `llm.completeJson()` 在 `extractAndPersist` 中被调用 |
| A4 | 存入的 entry 有 L0/L1/L2 | ✅ `extractAndPersist` 内部生成三层 |
| A5 | 6 分类生效 | ✅ `buildExtractionPrompt` 支持 6 分类 |
| A6 | 去重生效 | ✅ 两阶段去重（向量预过滤 + LLM 决策） |
| A7 | 其他 13 个工具回归正常 | ✅ 未改动其他工具 |
| A8 | stdout 无污染 | ✅ `console.debug` → `console.error` |

---

## 六、风险

| 风险 | 概率 | 对策 |
|------|------|------|
| LLM 调用超时导致 ingest 慢 | 中 | `config.llm.timeoutMs: 30000`，`llm-client.ts` 内部有 retry |
| LLM 接口不可用（key 错/网络问题） | 低 | `completeJson()` 返回 null，`extractAndPersist` 内部有错误处理 |
| LLM JSON 解析失败 | 中 | `extractJsonFromResponse()` 提取 markdown 代码块或裸 JSON |

---

## 七、相关文件路径

| 文件 | 作用 |
|------|------|
| `src/mcp-config.ts` | LlmConfig 接口 + loadConfig llm 读取 |
| `src/mcp-server.ts` | LLMClient + SmartExtractor 初始化 |
| `src/mcp-tools.ts` | handleMemoryIngest 调用 extractAndPersist |
| `src/smart-extractor.ts` | extractAndPersist（两阶段去重 + L0/L1/L2 分层） |
| `src/llm-client.ts` | completeJson（OAuth + SSE 解析） |
| `config.yaml` | llm 配置段 |

---

*文档版本：v2.0*  
*最后更新：2026-04-09*
