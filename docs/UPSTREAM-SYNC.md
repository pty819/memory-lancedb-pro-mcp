# memory-lancedb-pro 上游同步完整策略

> **目标**：保持本地 MCP 改造与上游 `win4r/memory-lancedb-pro`（origin/master）同步，同时保护本地 MCP 适配层不被上游覆盖。
> **基准**：2026-04-09 完整文件清单分析

---

## 一、本地所有改动的完整清单

### 1.1 Layer C — 本地自行维护（完全不依赖上游）

#### 纯新增文件（untracked，不受上游影响）

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/mcp-server.ts` | ~119 | MCP stdio 入口，插件总装配器 |
| `src/mcp-tools.ts` | ~1949 | 14 个 MCP 工具注册（Zod schema + handler） |
| `src/mcp-config.ts` | ~181 | config.yaml 读取，类型化配置对象 |
| `scripts/memory-sync-check.sh` | ~180 | 同步状态诊断脚本 |
| `scripts/memory-upstream-pull.sh` | ~220 | 半自动 pull + 影响分析脚本 |
| `docs/MIGRATION-PLAN.md` | — | MCP 改造完整记录 |
| `docs/INGEST-REFORM-PLAN.md` | — | SmartExtractor 接入记录 |
| `docs/UPSTREAM-SYNC.md` | — | 本文档 |

#### 对已跟踪文件的本地修改（modified tracked）

| 文件 | 改动内容 | 上游影响 |
|------|---------|---------|
| `package.json` | 新增 `build: tsc`、`start: node dist/mcp-server.js`、`"build": "tsc"`、`"start"` 脚本 | ⚠️ 上游 scripts 可能不同，pull 时需手动合并 |
| `package-lock.json` | npm install 后自动更新 | ⚠️ 上游 dependencies 更新时会冲突 |
| `tsconfig.json` | MCP 编译配置 | ⚠️ 上游若有 tsconfig 可能冲突 |

#### 对已跟踪文档的本地修改

| 文件 | 改动内容 | 上游影响 |
|------|---------|---------|
| `docs/long-context-chunking.md` | 配置示例从 OpenClaw JSON 改为 config.yaml | 低，上游若有改动需手动合并 |
| `docs/memory_architecture_analysis.md` | MCP 入口层说明 + 架构图更新 | 低 |
| `docs/openclaw-integration-playbook.md` | 标记 DEPRECATED | 低 |
| `docs/openclaw-integration-playbook.zh-CN.md` | 标记 DEPRECATED | 低 |

#### 运行时文件（已在 .gitignore）

```
config.yaml          ← 运行时配置（API keys，各环境独立）
recall_cache/        ← 检索缓存
dist/                ← 编译产物
```

---

### 1.2 Layer B — 本地修复应推回上游

| 文件 | 改动内容 | PR 状态 |
|------|---------|---------|
| `src/embedder.ts` | `console.debug` → `console.error`（stdout 污染修复） | 待推 |
| `src/store.ts` | `require()` → `import()`（ESM 兼容性） | 待推 |

---

### 1.3 Layer A — 上游活跃区（零本地改动）

| 文件 | 说明 |
|------|------|
| `src/retriever.ts` | 混合检索、rerank、decay boost |
| `src/smart-extractor.ts` | LLM 提取 + 两阶段去重 |
| `src/smart-metadata.ts` | metadata 归一化 |
| `src/decay-engine.ts` | Weibull 衰减模型 |
| `src/tier-manager.ts` | 三层晋升/降级 |
| `src/chunker.ts` | 语义分块（CJK 适配） |
| `src/scopes.ts` | 多 scope 隔离 |
| `src/noise-prototypes.ts` | 嵌入噪声原型库 |
| `src/noise-filter.ts` | regex 噪声过滤 |
| `src/adaptive-retrieval.ts` | auto-recall 守卫 |
| `src/llm-client.ts` | LLM 调用封装（稳定） |
| `src/llm-oauth.ts` | OAuth 刷新（稳定） |
| `src/index.ts` | OpenClaw 插件入口（废弃，保留） |
| `src/tools.ts` | OpenClaw Agent Tools（废弃，保留） |
| `cli.ts` | 运维 CLI（未迁移到 MCP） |

---

## 二、工程配置文件的维护协议

### 2.1 package.json

**上游 key 的字段**（pull 时看 diff，手动合并）：

| 字段 | 说明 |
|------|------|
| `scripts.test` | 上游 test 命令 |
| `scripts.bench*` | benchmark 脚本 |
| `scripts.test:*` | 各种测试组 |
| `dependencies` | 上游依赖更新 |
| `devDependencies` | 上游开发依赖更新 |

**本地 key 的字段**（保留，不覆盖）：

```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/mcp-server.js"
  }
}
```

**合并策略**：`git pull` 后用 `npm run build` 验证，冲突时保留上游的 `scripts.test` 系列 + 本地的 `build`/`start`。

### 2.2 package-lock.json

自动合并。上游 dependencies 更新后运行 `npm install`，会自动合并。

### 2.3 tsconfig.json

当前是本地新增。如果上游后续新增 tsconfig，会冲突。冲突时优先保留上游的基础配置，本地 MCP 需要的关键 compilerOptions：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src"
  }
}
```

---

## 三、完整同步工作流

### 阶段 0：日常监控（每月一次）

```bash
# 看有没有上游更新
bash scripts/memory-sync-check.sh
```

输出示例（无更新）：
```
✅ 本地与 origin/master 完全同步
✅ Layer A 核心文件无意外改动
✅ dist/mcp-server.js 已编译且最新
```

输出示例（有更新）：
```
📦 本地落后 origin/master 5 个提交
📝 upstream 有新的 retriever.ts / smart-extractor.ts 提交
⚠️  建议执行: bash scripts/memory-upstream-pull.sh --dry-run
```

---

### 阶段 1：dry-run 评估影响

```bash
bash scripts/memory-upstream-pull.sh --dry-run
```

脚本会报告：
- 上游改了多少文件
- 哪些 Layer A 文件有改动
- 是否疑似接口变更（mcp-tools.ts 是否需要修）

---

### 阶段 2：执行 pull

```bash
bash scripts/memory-upstream-pull.sh
```

如果报告"无冲突"：直接进入阶段 3。
如果报告"有冲突"：先解决冲突再继续（通常在 package.json 或 package-lock.json）。

---

### 阶段 3：工程配置合并

```bash
# 检查 package.json 冲突
git diff --stat
```

**package.json 有冲突时**：
```bash
# 看冲突在哪
git diff package.json

# 手动解决：保留上游的 dependencies/devDependencies/其他 scripts
# 保留本地的 build 和 start
vim package.json
git add package.json
```

**package-lock.json 更新**：
```bash
npm install
git add package-lock.json
```

---

### 阶段 4：编译验证

```bash
npm run build
```

常见编译错误：
- 上游改了接口签名 → mcp-tools.ts 报错 → 阶段 5
- 新增依赖没有 @types → 阶段 5

---

### 阶段 5：MCP 适配层接口检查

这是最可能需要手动修的地方。

**接口兼容性检查**（脚本已做初步判断，列出疑似要修的文件）：

| 上游改动文件 | 影响的本地文件 | 可能需要的改动 |
|------------|-------------|-------------|
| `src/embedder.ts` | `src/mcp-config.ts` | EmbeddingConfig 新字段 |
| `src/retriever.ts` | `src/mcp-tools.ts` | retrieve() 参数/返回值变化 |
| `src/smart-extractor.ts` | `src/mcp-tools.ts` | extractAndPersist() 参数/返回值变化 |
| `src/store.ts` | `src/mcp-tools.ts` | MemoryStore 方法签名变化 |
| `src/llm-client.ts` | `src/mcp-config.ts` | LlmConfig 接口变化 |

**mcp-tools.ts 常见修法**：

```typescript
// 示例：如果 retriever.retrieve() 增加了 options 参数
// 旧：
const results = await retriever.retrieve(query, scope, limit);

// 新：
const results = await retriever.retrieve(query, scope, limit, { decayBoost: true });
```

修完后：
```bash
npm run build
# 确认编译通过
```

---

### 阶段 6：dist/ 更新

```bash
# 确认 dist 是最新的
ls -la dist/mcp-server.js
```

如果 dist/mtime 比源文件旧，重新编译：
```bash
npm run build
```

---

### 阶段 7：Gateway 验证

```bash
# 重启 gateway
systemctl restart hermes-gateway

# 看启动日志
journalctl -u hermes-gateway -f --lines=50
```

验证点：
- `[memory-lancedb-pro]` 相关日志无报错
- MCP server 启动成功
- `memory_recall` / `memory_ingest` 工具调用正常

---

### 阶段 8：文档合并（如果有冲突）

docs/ 文件冲突时较少，因为上游 docs 主要是英文。但如果有：
```bash
git diff docs/
# 手动解决，保留本地的 config.yaml 格式改动 + MCP 相关说明
git add docs/
```

---

## 四、Layer B 修复推回上游流程

> 建议在本地 pull 之前完成 PR 推送，避免本地 Layer B 改动和上游新提交混在一起。

```bash
# 1. 切分支
git checkout -b fix/embedder-stdio-stderr origin/master

# 2. 确认改动
git diff HEAD -- src/embedder.ts

# 3. 提交（一个修复一个 commit）
git commit -m "fix(embedder): redirect console.debug to stderr to avoid stdout pollution"

# 4. 推送并创建 PR
git push origin fix/embedder-stdio-stderr
# 然后 GitHub 网页创建 PR

# 5. PR 合并后，清理本地
git pull origin master
# Layer B 改动自动消失
npm run build
```

---

## 五、完整文件状态表

| 文件 | 状态 | Layer | 上游更新时 |
|------|------|-------|---------|
| `src/mcp-server.ts` | untracked | C | 不受影响 |
| `src/mcp-tools.ts` | untracked | C | 可能要修接口调用 |
| `src/mcp-config.ts` | untracked | C | 可能要修配置字段 |
| `scripts/memory-sync-check.sh` | untracked | C | 不受影响 |
| `scripts/memory-upstream-pull.sh` | untracked | C | 不受影响 |
| `docs/MIGRATION-PLAN.md` | untracked | C | 不受影响 |
| `docs/INGEST-REFORM-PLAN.md` | untracked | C | 不受影响 |
| `docs/UPSTREAM-SYNC.md` | untracked | C | 不受影响 |
| `package.json` | modified | C | 可能要手动合并 scripts |
| `package-lock.json` | modified | C | npm install 自动合并 |
| `tsconfig.json` | untracked | C | 可能要手动合并 |
| `src/embedder.ts` | modified | B | 修后从本地删除改动 |
| `src/store.ts` | modified | B | 修后从本地删除改动 |
| `docs/long-context-chunking.md` | modified | C | 可能要手动合并 |
| `docs/memory_architecture_analysis.md` | modified | C | 可能要手动合并 |
| `docs/openclaw-integration-playbook*.md` | modified | C | DEPRECATED，基本不变 |
| `.gitignore` | modified | C | 基本不冲突 |
| `config.yaml` | untracked + gitignored | C | 不受上游影响 |
| `dist/` | untracked + gitignored | — | pull 后需重新 build |
| Layer A 核心文件（12 个） | tracked | A | git pull 自动覆盖 |

---

## 六、关键原则

1. **Layer C 的纯新增文件不受上游影响**（untracked，git pull 不动）
2. **Layer C 的 modified tracked 文件是冲突高发区**（package.json / package-lock.json / docs）
3. **Layer A 是上游领地** — 不本地修改，git pull 直接覆盖
4. **Layer B 先推 PR 再同步** — 避免 PR 和本地改动混在一起
5. **dist/ 每次 pull 后必须重新 build** — 编译产物不代表源码
6. **编译通过不等于接口兼容** — gateway 重启验证是最终标准
