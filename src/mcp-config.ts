/**
 * MCP Server Configuration
 * Loads config.yaml from the plugin directory and provides typed config.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// js-yaml v4 ships its own types
import yaml from "js-yaml";

// ============================================================================
// Types
// ============================================================================

export interface MemoryConfig {
  dbPath: string;
}

export interface EmbeddingConfig {
  provider: "openai-compatible";
  apiKey: string;
  model: string;
  baseURL: string;
  dimensions: number;
  normalized: boolean;
  chunking: boolean;
  taskQuery?: string;
  taskPassage?: string;
  textPrefixQuery?: string;
  textPrefixPassage?: string;
}

export interface RetrievalConfig {
  mode: "hybrid" | "vector";
  vectorWeight: number;
  bm25Weight: number;
  minScore: number;
  rerank: "cross-encoder" | "lightweight" | "none";
  rerankModel: string;
  rerankEndpoint: string;
}

export interface DecayConfig {
  recencyHalfLifeDays: number;
  frequencyWeight: number;
  importanceModulation: number;
}

export interface AutoCaptureConfig {
  enabled: boolean;
  captureAssistant: boolean;
  minSignificance: number;
}

export interface AutoRecallConfig {
  enabled: boolean;
  minQueryLength: number;
  defaultScope: string;
  maxItems: number;
}

export interface ScopesConfig {
  default: string;
}

export interface LlmConfig {
  apiKey: string;
  model: string;
  baseURL: string;
  timeoutMs: number;
}

export interface McpConfig {
  memory: MemoryConfig;
  embedding: EmbeddingConfig;
  retrieval: RetrievalConfig;
  decay: DecayConfig;
  scopes: ScopesConfig;
  autoCapture: AutoCaptureConfig;
  autoRecall: AutoRecallConfig;
  llm: LlmConfig;
}

// ============================================================================
// Config Loader
// ============================================================================

function findConfigPath(): string {
  // Try plugin directory first
  const pluginDir = dirname(fileURLToPath(import.meta.url));
  const pluginConfig = join(pluginDir, "..", "config.yaml");
  try {
    readFileSync(pluginConfig, "utf-8");
    return pluginConfig;
  } catch {
    return join(pluginDir, "..", "config.yaml");
  }
}

export function loadConfig(): McpConfig {
  const configPath = findConfigPath();
  let raw: Record<string, unknown>;
  try {
    raw = yaml.load(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `memory-lancedb-pro: failed to load config.yaml at ${configPath}: ${String(err)}`
    );
  }

  const mem = (raw["memory"] ?? {}) as Record<string, unknown>;
  const emb = (raw["embedding"] ?? {}) as Record<string, unknown>;
  const ret = (raw["retrieval"] ?? {}) as Record<string, unknown>;
  const dcy = (raw["decay"] ?? {}) as Record<string, unknown>;
  const scp = (raw["scopes"] ?? {}) as Record<string, unknown>;
  const acp = (raw["autoCapture"] ?? {}) as Record<string, unknown>;
  const acr = (raw["autoRecall"] ?? {}) as Record<string, unknown>;
  const llm = (raw["llm"] ?? {}) as Record<string, unknown>;

  return {
    memory: {
      dbPath: resolvePath(String(mem["dbPath"] ?? "~/.memory-lancedb-pro/lancedb")),
    },
    embedding: {
      provider: (emb["provider"] as "openai-compatible") ?? "openai-compatible",
      apiKey: String(emb["apiKey"] ?? "dummy-key-for-local-llama"),
      model: String(emb["model"] ?? "your-embedding-model"),
      baseURL: String(emb["baseURL"] ?? "http://127.0.0.1:8080"),
      dimensions: Number(emb["dimensions"] ?? 1024),
      normalized: Boolean(emb["normalized"] ?? false),
      chunking: Boolean(emb["chunking"] ?? true),
      taskQuery: emb["taskQuery"] ? String(emb["taskQuery"]) : undefined,
      taskPassage: emb["taskPassage"] ? String(emb["taskPassage"]) : undefined,
      textPrefixQuery: emb["textPrefixQuery"] ? String(emb["textPrefixQuery"]) : undefined,
      textPrefixPassage: emb["textPrefixPassage"] ? String(emb["textPrefixPassage"]) : undefined,
    },
    retrieval: {
      mode: ((ret["mode"] as string) ?? "hybrid") as "hybrid" | "vector",
      vectorWeight: Number(ret["vectorWeight"] ?? 0.7),
      bm25Weight: Number(ret["bm25Weight"] ?? 0.3),
      minScore: Number(ret["minScore"] ?? 0.3),
      rerank: ((ret["rerank"] as string) ?? "cross-encoder") as "cross-encoder" | "lightweight" | "none",
      rerankModel: String(ret["rerankModel"] ?? ""),
      rerankEndpoint: String(ret["rerankEndpoint"] ?? "http://127.0.0.1:8080"),
    },
    decay: {
      recencyHalfLifeDays: Number(dcy["recencyHalfLifeDays"] ?? 14),
      frequencyWeight: Number(dcy["frequencyWeight"] ?? 0.3),
      importanceModulation: Number(dcy["importanceModulation"] ?? 0.2),
    },
    scopes: {
      default: String(scp["default"] ?? "global"),
    },
    autoCapture: {
      enabled: Boolean(acp["enabled"] ?? true),
      captureAssistant: Boolean(acp["captureAssistant"] ?? false),
      minSignificance: Number(acp["minSignificance"] ?? 0.4),
    },
    autoRecall: {
      enabled: Boolean(acr["enabled"] ?? true),
      minQueryLength: Number(acr["minQueryLength"] ?? 15),
      defaultScope: String(acr["defaultScope"] ?? "global"),
      maxItems: Number(acr["maxItems"] ?? 5),
    },
    llm: {
      apiKey: String(llm["apiKey"] ?? ""),
      model: String(llm["model"] ?? "gpt-4o-mini"),
      baseURL: String(llm["baseURL"] ?? "https://api.openai.com/v1"),
      timeoutMs: Number(llm["timeoutMs"] ?? 30000),
    },
  };
}

function resolvePath(p: string): string {
  if (p.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return join(home, p.slice(2));
  }
  return p;
}
