/**
 * MCP Server Entry Point
 * Loads config, initializes business logic, registers tools, starts stdio transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./mcp-config.js";
import { registerAllMcpTools } from "./mcp-tools.js";
import { MemoryStore } from "./store.js";
import { createEmbedder } from "./embedder.js";
import { createRetriever } from "./retriever.js";
import { createScopeManager } from "./scopes.js";
import { createDecayEngine, DEFAULT_DECAY_CONFIG } from "./decay-engine.js";
import { createTierManager, DEFAULT_TIER_CONFIG } from "./tier-manager.js";
import { SmartExtractor } from "./smart-extractor.js";
import { createLlmClient, LlmClient } from "./llm-client.js";

// ============================================================================
// Bootstrap
// ============================================================================

const config = loadConfig();

const store = new MemoryStore({
  dbPath: config.memory.dbPath,
  vectorDim: config.embedding.dimensions,
});

const embedder = createEmbedder({
  provider: config.embedding.provider,
  apiKey: config.embedding.apiKey,
  model: config.embedding.model,
  baseURL: config.embedding.baseURL,
  dimensions: config.embedding.dimensions,
  normalized: config.embedding.normalized,
  chunking: config.embedding.chunking,
  taskQuery: config.embedding.taskQuery,
  taskPassage: config.embedding.taskPassage,
  textPrefixQuery: config.embedding.textPrefixQuery,
  textPrefixPassage: config.embedding.textPrefixPassage,
});

const decayEngine = createDecayEngine({
  ...DEFAULT_DECAY_CONFIG,
  recencyHalfLifeDays: config.decay.recencyHalfLifeDays,
  frequencyWeight: config.decay.frequencyWeight,
  importanceModulation: config.decay.importanceModulation,
});

const tierManager = createTierManager(DEFAULT_TIER_CONFIG);

const retriever = createRetriever(store, embedder, {
  mode: config.retrieval.mode,
  vectorWeight: config.retrieval.vectorWeight,
  bm25Weight: config.retrieval.bm25Weight,
  minScore: config.retrieval.minScore,
  rerank: config.retrieval.rerank,
  rerankModel: config.retrieval.rerankModel || undefined,
  rerankEndpoint: config.retrieval.rerankEndpoint || undefined,
}, {
  decayEngine,
});

const scopeManager = createScopeManager({
  default: config.scopes.default,
  definitions: {
    global: { description: "Shared knowledge across all agents" },
  },
  agentAccess: {},
});

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

// ============================================================================
// Server Setup
// ============================================================================

const server = new McpServer(
  {
    name: "memory-lancedb-pro",
    version: "1.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

registerAllMcpTools(server, {
  store,
  retriever,
  embedder,
  scopeManager,
  config,
  smartExtractor,
});

// ============================================================================
// Start
// ============================================================================

const transport = new StdioServerTransport();
await server.connect(transport);
