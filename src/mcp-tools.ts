/**
 * MCP Tool Registrations
 * Zod schemas + business logic wrappers for all 14 memory tools.
 * Reuses existing store/retriever/embedder/scope business logic from src/.
 */

import { z } from "zod/v4";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MemoryStore } from "./store.js";
import type { MemoryRetriever, RetrievalResult } from "./retriever.js";
import type { Embedder } from "./embedder.js";
import type { MemoryScopeManager } from "./scopes.js";
import type { SmartExtractor } from "./smart-extractor.js";
import { McpConfig } from "./mcp-config.js";
import { isNoise } from "./noise-filter.js";
import { isSystemBypassId, resolveScopeFilter } from "./scopes.js";
import {
  buildSmartMetadata,
  deriveFactKey,
  parseSmartMetadata,
  stringifySmartMetadata,
} from "./smart-metadata.js";
import { classifyTemporal, inferExpiry } from "./temporal-classifier.js";
import { isUserMdExclusiveMemory } from "./workspace-boundary.js";
import type { RetrievalTrace } from "./retrieval-trace.js";
import { appendSelfImprovementEntry, ensureSelfImprovementLearningFiles } from "./self-improvement-files.js";
import { getDisplayCategoryTag } from "./reflection-metadata.js";
import { TEMPORAL_VERSIONED_CATEGORIES } from "./memory-categories.js";

// ============================================================================
// Constants & Types
// ============================================================================

export const MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "entity",
  "reflection",
  "other",
] as const;

type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

interface ToolDeps {
  store: MemoryStore;
  retriever: MemoryRetriever;
  embedder: Embedder;
  scopeManager: MemoryScopeManager;
  config: McpConfig;
  smartExtractor: SmartExtractor;
}

// ============================================================================
// Utility Functions
// ============================================================================

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clamp01(value: number, fallback = 0.7): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function normalizeInlineText(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, Math.max(1, maxChars - 1)).trimEnd();
  return `${clipped}…`;
}

function deriveManualMemoryLayer(category: string): "durable" | "working" {
  if (category === "preference" || category === "decision" || category === "fact") {
    return "durable";
  }
  return "working";
}

function sanitizeMemoryForSerialization(results: RetrievalResult[]) {
  return results.map((r) => ({
    id: r.entry.id,
    text: r.entry.text,
    category: r.entry.category,
    rawCategory: r.entry.category,
    scope: r.entry.scope,
    importance: r.entry.importance,
    score: r.score,
    sources: r.sources,
  }));
}

async function retrieveWithRetry(
  retriever: MemoryRetriever,
  params: {
    query: string;
    limit: number;
    scopeFilter?: string[];
    category?: string;
    source?: "manual" | "auto-recall" | "cli";
  },
): Promise<RetrievalResult[]> {
  let results = await retriever.retrieve(params);
  if (results.length === 0) {
    await new Promise(resolve => setTimeout(resolve, 75));
    results = await retriever.retrieve(params);
  }
  return results;
}

async function resolveMemoryId(
  deps: ToolDeps,
  memoryRef: string,
  scopeFilter: string[],
): Promise<
  | { ok: true; id: string }
  | { ok: false; message: string; details?: Record<string, unknown> }
> {
  const trimmed = memoryRef.trim();
  if (!trimmed) {
    return {
      ok: false,
      message: "memoryId/query cannot be empty.",
      details: { error: "empty_memory_ref" },
    };
  }

  const uuidLike = /^[0-9a-f]{8}(-[0-9a-f]{4}){0,4}/i.test(trimmed);
  if (uuidLike) {
    return { ok: true, id: trimmed };
  }

  const results = await retrieveWithRetry(deps.retriever, {
    query: trimmed,
    limit: 5,
    scopeFilter,
  });
  if (results.length === 0) {
    return {
      ok: false,
      message: `No memory found matching "${trimmed}".`,
      details: { error: "not_found", query: trimmed },
    };
  }
  if (results.length === 1 || results[0].score > 0.85) {
    return { ok: true, id: results[0].entry.id };
  }

  const list = results
    .map(
      (r) =>
        `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}${r.entry.text.length > 60 ? "..." : ""}`,
    )
    .join("\n");
  return {
    ok: false,
    message: `Multiple matches. Specify memoryId:\n${list}`,
    details: {
      action: "candidates",
      candidates: sanitizeMemoryForSerialization(results),
    },
  };
}

function resolveWorkspaceDir(fallback?: string): string {
  const cwd = process.cwd();
  if (cwd && cwd !== homedir()) return cwd;
  if (fallback && fallback.trim()) return fallback;
  return join(homedir(), ".ccworkspace");
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================================
// Tool Implementations
// ============================================================================

async function handleMemoryRecall(
  deps: ToolDeps,
  params: {
    query: string;
    limit?: number;
    includeFullText?: boolean;
    maxCharsPerItem?: number;
    scope?: string;
    category?: MemoryCategory;
    agentId?: string;
  },
): Promise<CallToolResult> {
  const {
    query,
    limit = 3,
    includeFullText = false,
    maxCharsPerItem = 180,
    scope,
    category,
    agentId = "main",
  } = params;

  try {
    const safeLimit = includeFullText
      ? clampInt(limit, 1, 20)
      : clampInt(limit, 1, 6);
    const safeCharsPerItem = clampInt(maxCharsPerItem, 60, 1000);

    // Determine accessible scopes
    let scopeFilter = resolveScopeFilter(deps.scopeManager, agentId);
    if (scope) {
      if (deps.scopeManager.isAccessible(scope, agentId)) {
        scopeFilter = [scope];
      } else {
        return {
          content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
          isError: true,
        };
      }
    }

    const results = await retrieveWithRetry(deps.retriever, {
      query,
      limit: safeLimit,
      scopeFilter,
      category,
      source: "manual",
    });

    if (results.length === 0) {
      return {
        content: [{ type: "text", text: "No relevant memories found." }],
        metadata: { count: 0, query, scopes: scopeFilter },
      };
    }

    // Update access metadata
    const now = Date.now();
    await Promise.allSettled(
      results.map((result) => {
        const meta = parseSmartMetadata(result.entry.metadata, result.entry);
        return deps.store.patchMetadata(
          result.entry.id,
          {
            access_count: meta.access_count + 1,
            last_accessed_at: now,
            last_confirmed_use_at: now,
            bad_recall_count: 0,
            suppressed_until_turn: 0,
          },
          scopeFilter,
        );
      }),
    );

    const text = results
      .map((r, i) => {
        const metadata = parseSmartMetadata(r.entry.metadata, r.entry);
        const base = includeFullText
          ? (metadata.l2_content || metadata.l1_overview || r.entry.text)
          : (metadata.l0_abstract || r.entry.text);
        const inline = normalizeInlineText(base);
        const rendered = includeFullText
          ? inline
          : truncateText(inline, safeCharsPerItem);
        return `${i + 1}. [${r.entry.id}] [${r.entry.category}] ${rendered}`;
      })
      .join("\n");

    const serializedMemories = sanitizeMemoryForSerialization(results);
    if (includeFullText) {
      for (let i = 0; i < results.length; i++) {
        const metadata = parseSmartMetadata(results[i].entry.metadata, results[i].entry);
        (serializedMemories[i] as Record<string, unknown>).fullText =
          metadata.l2_content || metadata.l1_overview || results[i].entry.text;
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `<relevant-memories>\n<mode:${includeFullText ? "full" : "summary"}>\nFound ${results.length} memories:\n\n${text}\n</relevant-memories>`,
        },
      ],
      metadata: {
        count: results.length,
        memories: serializedMemories,
        query,
        scopes: scopeFilter,
        retrievalMode: deps.retriever.getConfig().mode,
        recallMode: includeFullText ? "full" : "summary",
      },
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Memory recall failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function handleMemoryIngest(
  deps: ToolDeps,
  params: {
    text: string;
    importance?: number;
    category?: MemoryCategory;
    scope?: string;
    agentId?: string;
    significance?: number; // For auto-capture significance scoring
  },
): Promise<CallToolResult> {
  const {
    text,
    importance,
    category,
    scope,
    agentId = "main",
    significance,
  } = params;

  try {
    // Determine target scope
    let targetScope = scope;
    if (!targetScope) {
      if (isSystemBypassId(agentId)) {
        return {
          content: [
            {
              type: "text",
              text: "Reserved bypass agent IDs must provide an explicit scope for memory_ingest writes.",
            },
          ],
          isError: true,
        };
      }
      targetScope = deps.scopeManager.getDefaultScope(agentId);
    }

    // Validate scope access
    if (!deps.scopeManager.isAccessible(targetScope, agentId)) {
      return {
        content: [
          {
            type: "text",
            text: `Access denied to scope: ${targetScope}`,
          },
        ],
        isError: true,
      };
    }

    // Noise filter
    if (isNoise(text)) {
      return {
        content: [
          {
            type: "text",
            text: `Skipped: text detected as noise (greeting, boilerplate, or meta-question)`,
          },
        ],
        metadata: { action: "noise_filtered" },
      };
    }

    // Workspace boundary check
    if (isUserMdExclusiveMemory({ text }, undefined)) {
      return {
        content: [
          {
            type: "text",
            text: "Skipped: this fact belongs in USER.md, not plugin memory.",
          },
        ],
        metadata: { action: "skipped_by_workspace_boundary" },
      };
    }

    // Auto-capture significance filter
    if (significance !== undefined && deps.config.autoCapture.enabled) {
      if (significance < deps.config.autoCapture.minSignificance) {
        return {
          content: [{ type: "text", text: `Skipped: significance ${significance.toFixed(2)} below threshold ${deps.config.autoCapture.minSignificance}` }],
          metadata: { action: "below_significance_threshold", significance },
        };
      }
    }

    // Delegate to SmartExtractor — LLM-driven extraction, deduplication, and classification
    // The user text is wrapped as a conversation turn to match extraction prompt format
    const conversationText = `用户：${text}`;
    const sessionKey = `mcp-ingest-${Date.now()}`;
    const stats = await deps.smartExtractor.extractAndPersist(conversationText, sessionKey, {
      scope: targetScope,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            action: stats.created > 0 ? "created" : stats.merged > 0 ? "merged" : "skipped",
            created: stats.created,
            merged: stats.merged,
            skipped: stats.skipped,
            scope: targetScope,
          }),
        },
      ],
      metadata: {
        action: stats.created > 0 ? "created" : stats.merged > 0 ? "merged" : "skipped",
        created: stats.created,
        merged: stats.merged,
        skipped: stats.skipped,
        scope: targetScope,
      },
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Memory storage failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function handleMemoryForget(
  deps: ToolDeps,
  params: {
    memoryId?: string;
    query?: string;
    scope?: string;
    agentId?: string;
  },
): Promise<CallToolResult> {
  const { memoryId, query, scope, agentId = "main" } = params;

  try {
    let targetScope = scope;
    if (!targetScope) {
      targetScope = deps.scopeManager.getDefaultScope(agentId);
    }
    const scopeFilter = [targetScope];

    if (!memoryId && !query) {
      return {
        content: [{ type: "text", text: "Either memoryId or query must be provided." }],
        isError: true,
      };
    }

    if (!deps.scopeManager.isAccessible(targetScope, agentId)) {
      return {
        content: [{ type: "text", text: `Access denied to scope: ${targetScope}` }],
        isError: true,
      };
    }

    let resolvedId: string;
    if (memoryId) {
      const resolved = await resolveMemoryId(deps, memoryId, scopeFilter);
      if (!resolved.ok) {
        return {
          content: [{ type: "text", text: resolved.message }],
          isError: true,
          metadata: resolved.details,
        };
      }
      resolvedId = resolved.id;
    } else {
      // Query-based: find best match
      const results = await retrieveWithRetry(deps.retriever, {
        query: query!,
        limit: 1,
        scopeFilter,
      });
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No memory found matching "${query}".` }],
          isError: true,
        };
      }
      resolvedId = results[0].entry.id;
    }

    await deps.store.delete(resolvedId, scopeFilter);

    return {
      content: [{ type: "text", text: `Deleted memory ${resolvedId.slice(0, 8)}...` }],
      metadata: { action: "deleted", id: resolvedId },
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Memory forget failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function handleMemoryUpdate(
  deps: ToolDeps,
  params: {
    memoryId?: string;
    query?: string;
    text?: string;
    importance?: number;
    category?: MemoryCategory;
    scope?: string;
    agentId?: string;
  },
): Promise<CallToolResult> {
  const { memoryId, query, text, importance, category, scope, agentId = "main" } = params;

  try {
    if (!memoryId && !query) {
      return {
        content: [{ type: "text", text: "Either memoryId or query must be provided." }],
        isError: true,
      };
    }

    if (!text && importance === undefined && category === undefined) {
      return {
        content: [{ type: "text", text: "At least one of text, importance, or category must be provided." }],
        isError: true,
      };
    }

    let targetScope = scope;
    if (!targetScope) {
      targetScope = deps.scopeManager.getDefaultScope(agentId);
    }
    const scopeFilter = [targetScope];

    if (!deps.scopeManager.isAccessible(targetScope, agentId)) {
      return {
        content: [{ type: "text", text: `Access denied to scope: ${targetScope}` }],
        isError: true,
      };
    }

    let resolvedId: string;
    if (memoryId) {
      const resolved = await resolveMemoryId(deps, memoryId, scopeFilter);
      if (!resolved.ok) {
        return {
          content: [{ type: "text", text: resolved.message }],
          isError: true,
          metadata: resolved.details,
        };
      }
      resolvedId = resolved.id;
    } else {
      const results = await retrieveWithRetry(deps.retriever, {
        query: query!,
        limit: 1,
        scopeFilter,
      });
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No memory found matching "${query}".` }],
          isError: true,
        };
      }
      resolvedId = results[0].entry.id;
    }

    // Fetch existing entry
    const existing = await deps.store.getById(resolvedId, scopeFilter);
    if (!existing) {
      return {
        content: [{ type: "text", text: `Memory ${resolvedId.slice(0, 8)}... not found in scope ${targetScope}.` }],
        isError: true,
      };
    }

    const patch: Record<string, unknown> = {};
    if (importance !== undefined) {
      patch.importance = clamp01(importance);
    }
    if (category !== undefined) {
      patch.category = category;
    }

    // If text changed, re-embed
    if (text && text !== existing.text) {
      const vector = await deps.embedder.embedPassage(text);
      patch.text = text;
      patch.vector = vector;
      patch.metadata = stringifySmartMetadata(
        buildSmartMetadata(
          { text, category: (category ?? existing.category) as any, importance: importance ?? existing.importance },
          {
            l0_abstract: text,
            l1_overview: `- ${text}`,
            l2_content: text,
            memory_layer: deriveManualMemoryLayer(category ?? existing.category),
            last_confirmed_use_at: Date.now(),
          },
        ),
      );
    }

    await deps.store.patchMetadata(resolvedId, patch, scopeFilter);

    return {
      content: [{ type: "text", text: `Updated memory ${resolvedId.slice(0, 8)}...` }],
      metadata: { action: "updated", id: resolvedId, patch },
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Memory update failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function handleMemoryStats(
  deps: ToolDeps,
  params: {
    scope?: string;
    agentId?: string;
  },
): Promise<CallToolResult> {
  const { scope, agentId = "main" } = params;

  try {
    // Determine accessible scopes
    let scopeFilter = resolveScopeFilter(deps.scopeManager, agentId);
    if (scope) {
      if (deps.scopeManager.isAccessible(scope, agentId)) {
        scopeFilter = [scope];
      } else {
        return {
          content: [
            { type: "text", text: `Access denied to scope: ${scope}` },
          ],
          isError: true,
        };
      }
    }

    const stats = await deps.store.stats(scopeFilter);
    const scopeManagerStats = deps.scopeManager.getStats();
    const retrievalConfig = deps.retriever.getConfig();

    const textLines = [
      `Memory Statistics:`,
      `• Total memories: ${stats.totalCount}`,
      `• Available scopes: ${scopeManagerStats.totalScopes}`,
      `• Retrieval mode: ${retrievalConfig.mode}`,
      `• FTS support: ${deps.store.hasFtsSupport ? "Yes" : "No"}`,
      ``,
      `Memories by scope:`,
      ...Object.entries(stats.scopeCounts).map(
        ([s, count]) => `  • ${s}: ${count}`,
      ),
      ``,
      `Memories by category:`,
      ...Object.entries(stats.categoryCounts).map(
        ([c, count]) => `  • ${c}: ${count}`,
      ),
    ];

    // Include retrieval quality metrics if stats collector is available
    const statsCollector = deps.retriever.getStatsCollector();
    let retrievalStats = undefined;
    if (statsCollector && statsCollector.count > 0) {
      retrievalStats = statsCollector.getStats();
      textLines.push(
        ``,
        `Retrieval Quality (last ${retrievalStats.totalQueries} queries):`,
        `  • Zero-result queries: ${retrievalStats.zeroResultQueries}`,
        `  • Avg latency: ${retrievalStats.avgLatencyMs}ms`,
        `  • P95 latency: ${retrievalStats.p95LatencyMs}ms`,
        `  • Avg result count: ${retrievalStats.avgResultCount}`,
        `  • Rerank used: ${retrievalStats.rerankUsed}`,
        `  • Noise filtered: ${retrievalStats.noiseFiltered}`,
      );
      if (retrievalStats.topDropStages.length > 0) {
        textLines.push(`  Top drop stages:`);
        for (const ds of retrievalStats.topDropStages) {
          textLines.push(`    • ${ds.name}: ${ds.totalDropped} dropped`);
        }
      }
    }

    const text = textLines.join("\n");

    return {
      content: [{ type: "text", text }],
      metadata: {
        stats,
        scopeManagerStats,
        retrievalConfig: {
          ...retrievalConfig,
          rerankApiKey: retrievalConfig.rerankApiKey ? "***" : undefined,
        },
        hasFtsSupport: deps.store.hasFtsSupport,
        retrievalStats,
      },
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to get memory stats: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function handleMemoryDebug(
  deps: ToolDeps,
  params: {
    query: string;
    limit?: number;
    scope?: string;
    agentId?: string;
  },
): Promise<CallToolResult> {
  const { query, limit = 5, scope, agentId = "main" } = params;

  try {
    const safeLimit = clampInt(limit, 1, 20);
    let scopeFilter = resolveScopeFilter(deps.scopeManager, agentId);
    if (scope) {
      if (deps.scopeManager.isAccessible(scope, agentId)) {
        scopeFilter = [scope];
      } else {
        return {
          content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
          isError: true,
        };
      }
    }

    const { results, trace } = await deps.retriever.retrieveWithTrace({
      query, limit: safeLimit, scopeFilter, source: "manual",
    });

    const traceLines: string[] = [
      `Retrieval Debug Trace:`,
      `  Mode: ${trace.mode}`,
      `  Total: ${trace.totalMs}ms`,
      `  Stages:`,
    ];
    for (const stage of trace.stages) {
      const dropped = Math.max(0, stage.inputCount - stage.outputCount);
      const scoreStr = stage.scoreRange
        ? ` scores=[${stage.scoreRange[0].toFixed(3)}, ${stage.scoreRange[1].toFixed(3)}]`
        : "";
      // For search stages (input=0), show "found N" instead of "dropped -N"
      const dropStr = stage.inputCount === 0
        ? `found ${stage.outputCount}`
        : `${stage.inputCount} -> ${stage.outputCount} (-${dropped})`;
      traceLines.push(
        `    ${stage.name}: ${dropStr} ${stage.durationMs}ms${scoreStr}`,
      );
      if (stage.droppedIds.length > 0 && stage.droppedIds.length <= 3) {
        traceLines.push(`      dropped: ${stage.droppedIds.join(", ")}`);
      } else if (stage.droppedIds.length > 3) {
        traceLines.push(
          `      dropped: ${stage.droppedIds.slice(0, 3).join(", ")} (+${stage.droppedIds.length - 3} more)`,
        );
      }
    }

    if (results.length === 0) {
      traceLines.push(``, `No results survived the pipeline.`);
      return {
        content: [{ type: "text", text: traceLines.join("\n") }],
        metadata: { count: 0, query, trace },
      };
    }

    const resultLines = results.map((r, i) => {
      const sources: string[] = [];
      if (r.sources.vector) sources.push("vector");
      if (r.sources.bm25) sources.push("BM25");
      if (r.sources.reranked) sources.push("reranked");
      const categoryTag = getDisplayCategoryTag(r.entry);
      return `${i + 1}. [${r.entry.id}] [${categoryTag}] ${r.entry.text.slice(0, 120)}${r.entry.text.length > 120 ? "..." : ""} (${(r.score * 100).toFixed(1)}%${sources.length > 0 ? `, ${sources.join("+")}` : ""})`;
    });

    const text = [...traceLines, ``, `Results (${results.length}):`, ...resultLines].join("\n");
    return {
      content: [{ type: "text", text }],
      metadata: {
        count: results.length,
        memories: sanitizeMemoryForSerialization(results),
        query,
        trace,
      },
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Memory debug failed: ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
    };
  }
}

async function handleMemoryList(
  deps: ToolDeps,
  params: {
    limit?: number;
    scope?: string;
    category?: MemoryCategory;
    offset?: number;
    agentId?: string;
  },
): Promise<CallToolResult> {
  const {
    limit = 10,
    scope,
    category,
    offset = 0,
    agentId = "main",
  } = params;

  try {
    const safeLimit = clampInt(limit, 1, 50);
    const safeOffset = clampInt(offset, 0, 1000);

    // Determine accessible scopes
    let scopeFilter = resolveScopeFilter(deps.scopeManager, agentId);
    if (scope) {
      if (deps.scopeManager.isAccessible(scope, agentId)) {
        scopeFilter = [scope];
      } else {
        return {
          content: [
            { type: "text", text: `Access denied to scope: ${scope}` },
          ],
          isError: true,
        };
      }
    }

    const entries = await deps.store.list(
      scopeFilter,
      category,
      safeLimit,
      safeOffset,
    );

    if (entries.length === 0) {
      return {
        content: [{ type: "text", text: "No memories found." }],
        metadata: {
          count: 0,
          filters: {
            scope,
            category,
            limit: safeLimit,
            offset: safeOffset,
          },
        },
      };
    }

    const text = entries
      .map((entry, i) => {
        const date = new Date(entry.timestamp)
          .toISOString()
          .split("T")[0];
        const categoryTag = getDisplayCategoryTag(entry);
        return `${safeOffset + i + 1}. [${entry.id}] [${categoryTag}] ${entry.text.slice(0, 100)}${entry.text.length > 100 ? "..." : ""} (${date})`;
      })
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: `Recent memories (showing ${entries.length}):\n\n${text}`,
        },
      ],
      metadata: {
        count: entries.length,
        memories: entries.map((e) => ({
          id: e.id,
          text: e.text,
          category: getDisplayCategoryTag(e),
          rawCategory: e.category,
          scope: e.scope,
          importance: e.importance,
          timestamp: e.timestamp,
        })),
        filters: {
          scope,
          category,
          limit: safeLimit,
          offset: safeOffset,
        },
      },
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to list memories: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function handleMemoryPromote(
  deps: ToolDeps,
  params: {
    memoryId?: string;
    query?: string;
    scope?: string;
    state?: "pending" | "confirmed" | "archived";
    layer?: "durable" | "working" | "reflection" | "archive";
    agentId?: string;
  },
): Promise<CallToolResult> {
  const {
    memoryId,
    query,
    scope,
    state = "confirmed",
    layer = "durable",
    agentId = "main",
  } = params;

  if (!memoryId && !query) {
    return {
      content: [{ type: "text", text: "Provide memoryId or query." }],
      isError: true,
    };
  }

  let scopeFilter = resolveScopeFilter(deps.scopeManager, agentId) ?? [];
  if (scope) {
    if (!deps.scopeManager.isAccessible(scope, agentId)) {
      return {
        content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
        isError: true,
      };
    }
    scopeFilter = [scope];
  }

  const resolved = await resolveMemoryId(
    deps,
    memoryId ?? query ?? "",
    scopeFilter,
  );
  if (!resolved.ok) {
    return {
      content: [{ type: "text", text: resolved.message }],
      isError: true,
      metadata: resolved.details ?? { error: "resolve_failed" },
    };
  }

  const before = await deps.store.getById(resolved.id, scopeFilter);
  if (!before) {
    return {
      content: [{ type: "text", text: `Memory ${resolved.id.slice(0, 8)} not found.` }],
      isError: true,
      metadata: { error: "not_found", id: resolved.id },
    };
  }

  const now = Date.now();
  const updated = await deps.store.patchMetadata(
    resolved.id,
    {
      source: "manual",
      state,
      memory_layer: layer,
      last_confirmed_use_at: state === "confirmed" ? now : undefined,
      bad_recall_count: 0,
      suppressed_until_turn: 0,
    },
    scopeFilter,
  );
  if (!updated) {
    return {
      content: [{ type: "text", text: `Failed to promote memory ${resolved.id.slice(0, 8)}.` }],
      isError: true,
      metadata: { error: "promote_failed", id: resolved.id },
    };
  }

  return {
    content: [{
      type: "text",
      text: `Promoted memory ${resolved.id.slice(0, 8)} to state=${state}, layer=${layer}.`,
    }],
    metadata: {
      action: "promoted",
      id: resolved.id,
      state,
      layer,
    },
  };
}

async function handleMemoryArchive(
  deps: ToolDeps,
  params: {
    memoryId?: string;
    query?: string;
    scope?: string;
    reason?: string;
    agentId?: string;
  },
): Promise<CallToolResult> {
  const { memoryId, query, scope, reason = "manual_archive", agentId = "main" } = params;

  if (!memoryId && !query) {
    return {
      content: [{ type: "text", text: "Provide memoryId or query." }],
      isError: true,
    };
  }

  let scopeFilter = resolveScopeFilter(deps.scopeManager, agentId) ?? [];
  if (scope) {
    if (!deps.scopeManager.isAccessible(scope, agentId)) {
      return {
        content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
        isError: true,
      };
    }
    scopeFilter = [scope];
  }

  const resolved = await resolveMemoryId(
    deps,
    memoryId ?? query ?? "",
    scopeFilter,
  );
  if (!resolved.ok) {
    return {
      content: [{ type: "text", text: resolved.message }],
      isError: true,
      metadata: resolved.details ?? { error: "resolve_failed" },
    };
  }

  const patch = {
    state: "archived" as const,
    memory_layer: "archive" as const,
    archive_reason: reason,
    archived_at: Date.now(),
  };
  const updated = await deps.store.patchMetadata(resolved.id, patch, scopeFilter);
  if (!updated) {
    return {
      content: [{ type: "text", text: `Failed to archive memory ${resolved.id.slice(0, 8)}.` }],
      isError: true,
      metadata: { error: "archive_failed", id: resolved.id },
    };
  }

  return {
    content: [{ type: "text", text: `Archived memory ${resolved.id.slice(0, 8)}.` }],
    metadata: { action: "archived", id: resolved.id, reason },
  };
}

async function handleMemoryCompact(
  deps: ToolDeps,
  params: {
    scope?: string;
    dryRun?: boolean;
    limit?: number;
    agentId?: string;
  },
): Promise<CallToolResult> {
  const { scope, dryRun = true, limit = 200, agentId = "main" } = params;

  const safeLimit = clampInt(limit, 20, 1000);
  let scopeFilter = resolveScopeFilter(deps.scopeManager, agentId);
  if (scope) {
    if (!deps.scopeManager.isAccessible(scope, agentId)) {
      return {
        content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
        isError: true,
      };
    }
    scopeFilter = [scope];
  }

  const entries = await deps.store.list(scopeFilter, undefined, safeLimit, 0);
  const canonicalByKey = new Map<string, typeof entries[number]>();
  const duplicates: Array<{ duplicateId: string; canonicalId: string; key: string }> = [];

  for (const entry of entries) {
    const meta = parseSmartMetadata(entry.metadata, entry);
    if (meta.state === "archived") continue;
    const key = `${meta.memory_category}:${normalizeInlineText(meta.l0_abstract).toLowerCase()}`;
    const existing = canonicalByKey.get(key);
    if (!existing) {
      canonicalByKey.set(key, entry);
      continue;
    }
    const keep =
      existing.timestamp >= entry.timestamp ? existing : entry;
    const drop =
      keep.id === existing.id ? entry : existing;
    canonicalByKey.set(key, keep);
    duplicates.push({ duplicateId: drop.id, canonicalId: keep.id, key });
  }

  let archivedCount = 0;
  if (!dryRun) {
    for (const item of duplicates) {
      await deps.store.patchMetadata(
        item.duplicateId,
        {
          state: "archived",
          memory_layer: "archive",
          canonical_id: item.canonicalId,
          archive_reason: "compact_duplicate",
          archived_at: Date.now(),
        },
        scopeFilter,
      );
      archivedCount++;
    }
  }

  return {
    content: [{
      type: "text",
      text: dryRun
        ? `Compaction preview: ${duplicates.length} duplicate(s) detected across ${entries.length} entries.`
        : `Compaction complete: archived ${archivedCount} duplicate memory record(s).`,
    }],
    metadata: {
      action: dryRun ? "compact_preview" : "compact_applied",
      scanned: entries.length,
      duplicates: duplicates.length,
      archived: archivedCount,
      sample: duplicates.slice(0, 20),
    },
  };
}

async function handleMemoryExplainRank(
  deps: ToolDeps,
  params: {
    query: string;
    limit?: number;
    scope?: string;
    agentId?: string;
  },
): Promise<CallToolResult> {
  const { query, limit = 5, scope, agentId = "main" } = params;

  const safeLimit = clampInt(limit, 1, 20);
  let scopeFilter = resolveScopeFilter(deps.scopeManager, agentId);
  if (scope) {
    if (!deps.scopeManager.isAccessible(scope, agentId)) {
      return {
        content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
        isError: true,
      };
    }
    scopeFilter = [scope];
  }

  const results = await retrieveWithRetry(deps.retriever, {
    query,
    limit: safeLimit,
    scopeFilter,
    source: "manual",
  });
  if (results.length === 0) {
    return {
      content: [{ type: "text", text: "No relevant memories found." }],
      metadata: { action: "empty", query, scopeFilter },
    };
  }

  const lines = results.map((r, idx) => {
    const meta = parseSmartMetadata(r.entry.metadata, r.entry);
    const sourceBreakdown = [];
    if (r.sources.vector) sourceBreakdown.push(`vec=${r.sources.vector.score.toFixed(3)}`);
    if (r.sources.bm25) sourceBreakdown.push(`bm25=${r.sources.bm25.score.toFixed(3)}`);
    if (r.sources.reranked) sourceBreakdown.push(`rerank=${r.sources.reranked.score.toFixed(3)}`);
    return [
      `${idx + 1}. [${r.entry.id}] score=${r.score.toFixed(3)} ${sourceBreakdown.join(" ")}`.trim(),
      `   state=${meta.state} layer=${meta.memory_layer} source=${meta.source} tier=${meta.tier}`,
      `   access=${meta.access_count} injected=${meta.injected_count} badRecall=${meta.bad_recall_count} suppressedUntilTurn=${meta.suppressed_until_turn}`,
      `   text=${truncateText(normalizeInlineText(meta.l0_abstract || r.entry.text), 180)}`,
    ].join("\n");
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    metadata: {
      action: "explain_rank",
      query,
      count: results.length,
      results: sanitizeMemoryForSerialization(results),
    },
  };
}

async function handleSelfImprovementLog(
  _deps: ToolDeps,
  params: {
    type: "learning" | "error";
    summary: string;
    details?: string;
    suggestedAction?: string;
    category?: string;
    area?: string;
    priority?: string;
    workspaceDir?: string;
  },
): Promise<CallToolResult> {
  const {
    type,
    summary,
    details = "",
    suggestedAction = "",
    category = "best_practice",
    area = "config",
    priority = "medium",
    workspaceDir,
  } = params;

  try {
    const baseDir = resolveWorkspaceDir(workspaceDir);
    const { id: entryId, filePath } = await appendSelfImprovementEntry({
      baseDir,
      type,
      summary,
      details,
      suggestedAction,
      category,
      area,
      priority,
      source: "memory-lancedb-pro/self_improvement_log",
    });
    const fileName = type === "learning" ? "LEARNINGS.md" : "ERRORS.md";

    return {
      content: [{ type: "text", text: `Logged ${type} entry ${entryId} to .learnings/${fileName}` }],
      metadata: { action: "logged", type, id: entryId, filePath },
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Failed to log self-improvement entry: ${error instanceof Error ? error.message : String(error)}` }],
      metadata: { error: "self_improvement_log_failed", message: String(error) },
    };
  }
}

async function handleSelfImprovementExtractSkill(
  _deps: ToolDeps,
  params: {
    learningId: string;
    skillName: string;
    sourceFile?: "LEARNINGS.md" | "ERRORS.md";
    outputDir?: string;
    workspaceDir?: string;
  },
): Promise<CallToolResult> {
  const { learningId, skillName, sourceFile = "LEARNINGS.md", outputDir = "skills", workspaceDir } = params;

  try {
    if (!/^(LRN|ERR)-\d{8}-\d{3}$/.test(learningId)) {
      return {
        content: [{ type: "text", text: "Invalid learningId format. Use LRN-YYYYMMDD-001 / ERR-..." }],
        isError: true,
        metadata: { error: "invalid_learning_id" },
      };
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillName)) {
      return {
        content: [{ type: "text", text: "Invalid skillName. Use lowercase letters, numbers, and hyphens only." }],
        isError: true,
        metadata: { error: "invalid_skill_name" },
      };
    }

    const baseDir = resolveWorkspaceDir(workspaceDir);
    await ensureSelfImprovementLearningFiles(baseDir);
    const learningsPath = join(baseDir, ".learnings", sourceFile);
    const learningBody = await readFile(learningsPath, "utf-8");
    const escapedLearningId = escapeRegExp(learningId.trim());
    const entryRegex = new RegExp(`## \\[${escapedLearningId}\\][\\s\\S]*?(?=\\n## \\[|$)`, "m");
    const match = learningBody.match(entryRegex);
    if (!match) {
      return {
        content: [{ type: "text", text: `Learning entry ${learningId} not found in .learnings/${sourceFile}` }],
        isError: true,
        metadata: { error: "learning_not_found", learningId, sourceFile },
      };
    }

    const summaryMatch = match[0].match(/### Summary\n([\s\S]*?)\n###/m);
    const summary = (summaryMatch?.[1] ?? "Summarize the source learning here.").trim();
    const safeOutputDir = outputDir
      .replace(/\\/g, "/")
      .split("/")
      .filter((segment) => segment && segment !== "." && segment !== "..")
      .join("/");
    const skillDir = join(baseDir, safeOutputDir || "skills", skillName);
    await mkdir(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    const skillTitle = skillName
      .split("-")
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(" ");
    const skillContent = [
      "---",
      `name: ${skillName}`,
      `description: "Extracted from learning ${learningId}. Replace with a concise description."`,
      "---",
      "",
      `# ${skillTitle}`,
      "",
      "## Why",
      summary,
      "",
      "## When To Use",
      "- [TODO] Define trigger conditions",
      "",
      "## Steps",
      "1. [TODO] Add repeatable workflow steps",
      "2. [TODO] Add verification steps",
      "",
      "## Source Learning",
      `- Learning ID: ${learningId}`,
      `- Source File: .learnings/${sourceFile}`,
      "",
    ].join("\n");
    await writeFile(skillPath, skillContent, "utf-8");

    const promotedMarker = `**Status**: promoted_to_skill`;
    const skillPathMarker = `- Skill-Path: ${safeOutputDir || "skills"}/${skillName}`;
    let updatedEntry = match[0];
    updatedEntry = updatedEntry.includes("**Status**:")
      ? updatedEntry.replace(/\*\*Status\*\*:\s*.+/m, promotedMarker)
      : `${updatedEntry.trimEnd()}\n${promotedMarker}\n`;
    if (!updatedEntry.includes("Skill-Path:")) {
      updatedEntry = `${updatedEntry.trimEnd()}\n${skillPathMarker}\n`;
    }
    const updatedLearningBody = learningBody.replace(match[0], updatedEntry);
    await writeFile(learningsPath, updatedLearningBody, "utf-8");

    return {
      content: [{ type: "text", text: `Extracted skill scaffold to ${safeOutputDir || "skills"}/${skillName}/SKILL.md and updated ${learningId}.` }],
      metadata: {
        action: "skill_extracted",
        learningId,
        sourceFile,
        skillPath: `${safeOutputDir || "skills"}/${skillName}/SKILL.md`,
      },
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Failed to extract skill: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
      metadata: { error: "self_improvement_extract_skill_failed", message: String(error) },
    };
  }
}

async function handleSelfImprovementReview(
  _deps: ToolDeps,
  params: {
    workspaceDir?: string;
  },
): Promise<CallToolResult> {
  const { workspaceDir } = params;

  try {
    const baseDir = resolveWorkspaceDir(workspaceDir);
    await ensureSelfImprovementLearningFiles(baseDir);
    const learningsDir = join(baseDir, ".learnings");
    const files = ["LEARNINGS.md", "ERRORS.md"] as const;
    const stats = { pending: 0, high: 0, promoted: 0, total: 0 };

    for (const f of files) {
      const content = await readFile(join(learningsDir, f), "utf-8").catch(() => "");
      stats.total += (content.match(/^## \[/gm) || []).length;
      stats.pending += (content.match(/\*\*Status\*\*:\s*pending/gi) || []).length;
      stats.high += (content.match(/\*\*Priority\*\*:\s*(high|critical)/gi) || []).length;
      stats.promoted += (content.match(/\*\*Status\*\*:\s*promoted(_to_skill)?/gi) || []).length;
    }

    const text = [
      "Self-Improvement Governance Snapshot:",
      `- Total entries: ${stats.total}`,
      `- Pending: ${stats.pending}`,
      `- High/Critical: ${stats.high}`,
      `- Promoted: ${stats.promoted}`,
      "",
      "Recommended loop:",
      "1) Resolve high-priority pending entries",
      "2) Distill reusable rules into AGENTS.md / SOUL.md / TOOLS.md",
      "3) Extract repeatable patterns as skills",
    ].join("\n");

    return {
      content: [{ type: "text", text }],
      metadata: { action: "review", stats },
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Failed to review self-improvement backlog: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
      metadata: { error: "self_improvement_review_failed", message: String(error) },
    };
  }
}

// ============================================================================
// Zod Schemas
// ============================================================================

const memoryRecallSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional().default(3),
  includeFullText: z.boolean().optional().default(false),
  maxCharsPerItem: z.number().int().min(60).max(1000).optional().default(180),
  scope: z.string().optional(),
  category: z.enum(MEMORY_CATEGORIES).optional(),
  agentId: z.string().optional().default("main"),
});

const memoryIngestSchema = z.object({
  text: z.string().min(1),
  importance: z.number().min(0).max(1).optional().default(0.7),
  category: z.enum(MEMORY_CATEGORIES).optional().default("other"),
  scope: z.string().optional(),
  agentId: z.string().optional().default("main"),
  significance: z.number().min(0).max(1).optional(),
});

const memoryForgetSchema = z.object({
  memoryId: z.string().optional(),
  query: z.string().optional(),
  scope: z.string().optional(),
  agentId: z.string().optional().default("main"),
}).refine(data => data.memoryId || data.query, {
  message: "Either memoryId or query must be provided.",
});

const memoryUpdateSchema = z.object({
  memoryId: z.string().optional(),
  query: z.string().optional(),
  text: z.string().optional(),
  importance: z.number().min(0).max(1).optional(),
  category: z.enum(MEMORY_CATEGORIES).optional(),
  scope: z.string().optional(),
  agentId: z.string().optional().default("main"),
}).refine(data => data.memoryId || data.query, {
  message: "Either memoryId or query must be provided.",
}).refine(data => data.text !== undefined || data.importance !== undefined || data.category !== undefined, {
  message: "At least one of text, importance, or category must be provided.",
});

const memoryStatsSchema = z.object({
  scope: z.string().optional(),
  agentId: z.string().optional().default("main"),
});

const memoryDebugSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional().default(5),
  scope: z.string().optional(),
  agentId: z.string().optional().default("main"),
});

const memoryListSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().default(10),
  scope: z.string().optional(),
  category: z.enum(MEMORY_CATEGORIES).optional(),
  offset: z.number().int().min(0).max(1000).optional().default(0),
  agentId: z.string().optional().default("main"),
});

const memoryPromoteSchema = z.object({
  memoryId: z.string().optional(),
  query: z.string().optional(),
  scope: z.string().optional(),
  state: z.enum(["pending", "confirmed", "archived"]).optional().default("confirmed"),
  layer: z.enum(["durable", "working", "reflection", "archive"]).optional().default("durable"),
  agentId: z.string().optional().default("main"),
}).refine(data => data.memoryId || data.query, {
  message: "Provide memoryId or query.",
});

const memoryArchiveSchema = z.object({
  memoryId: z.string().optional(),
  query: z.string().optional(),
  scope: z.string().optional(),
  reason: z.string().optional().default("manual_archive"),
  agentId: z.string().optional().default("main"),
}).refine(data => data.memoryId || data.query, {
  message: "Provide memoryId or query.",
});

const memoryCompactSchema = z.object({
  scope: z.string().optional(),
  dryRun: z.boolean().optional().default(true),
  limit: z.number().int().min(20).max(1000).optional().default(200),
  agentId: z.string().optional().default("main"),
});

const memoryExplainRankSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional().default(5),
  scope: z.string().optional(),
  agentId: z.string().optional().default("main"),
});

const selfImprovementLogSchema = z.object({
  type: z.enum(["learning", "error"]),
  summary: z.string().min(1),
  details: z.string().optional().default(""),
  suggestedAction: z.string().optional().default(""),
  category: z.string().optional().default("best_practice"),
  area: z.string().optional().default("config"),
  priority: z.string().optional().default("medium"),
  workspaceDir: z.string().optional(),
});

const selfImprovementExtractSkillSchema = z.object({
  learningId: z.string().min(1),
  skillName: z.string().min(1),
  sourceFile: z.enum(["LEARNINGS.md", "ERRORS.md"]).optional().default("LEARNINGS.md"),
  outputDir: z.string().optional().default("skills"),
  workspaceDir: z.string().optional(),
});

const selfImprovementReviewSchema = z.object({
  workspaceDir: z.string().optional(),
});

// ============================================================================
// Tool Registry
// ============================================================================

export function registerAllMcpTools(server: McpServer, deps: ToolDeps): void {
  // ── memory_recall ──────────────────────────────────────────────────────────
  server.registerTool(
    "memory_recall",
    {
      description:
        "Search through long-term memories using hybrid retrieval (vector + keyword search). Use when you need context about user preferences, past decisions, or previously discussed topics. Returns up to 20 results in full-text mode or 6 in summary mode.",
      inputSchema: {
        query: z.string().describe("Search query for finding relevant memories"),
        limit: z.number().int().min(1).max(20).default(3).describe("Max results (default: 3, max: 20 summary / 6 full)"),
        includeFullText: z.boolean().default(false).describe("Return full memory text"),
        maxCharsPerItem: z.number().int().min(60).max(1000).default(180).describe("Max characters per memory in summary mode"),
        scope: z.string().optional().describe("Specific memory scope to search in"),
        category: z.enum(MEMORY_CATEGORIES).optional().describe("Filter by category"),
        agentId: z.string().default("main").describe("Agent ID for scope resolution"),
      },
    },
    async (args): Promise<CallToolResult> => {
      const parsed = memoryRecallSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }
      return handleMemoryRecall(deps, parsed.data);
    },
  );

  // ── memory_ingest ───────────────────────────────────────────────────────────
  server.registerTool(
    "memory_ingest",
    {
      description:
        "Save important information in long-term memory. Use for preferences, facts, decisions, and other notable information. Performs noise filtering, duplicate detection, and auto-supersede for preference/entity memories.",
      inputSchema: {
        text: z.string().describe("Information to remember"),
        importance: z.number().min(0).max(1).default(0.7).describe("Importance score 0-1"),
        category: z.enum(MEMORY_CATEGORIES).default("other").describe("Memory category"),
        scope: z.string().optional().describe("Memory scope (defaults to agent scope)"),
        agentId: z.string().default("main").describe("Agent ID for scope resolution"),
        significance: z.number().min(0).max(1).optional().describe("Auto-capture significance score 0-1; entries below threshold are skipped"),
      },
    },
    async (args): Promise<CallToolResult> => {
      const parsed = memoryIngestSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }
      return handleMemoryIngest(deps, parsed.data);
    },
  );

  // ── memory_forget ───────────────────────────────────────────────────────────
  server.registerTool(
    "memory_forget",
    {
      description:
        "Delete specific memories. Supports both direct ID-based and search-based deletion. Provide either memoryId or query (not both).",
      inputSchema: {
        memoryId: z.string().optional().describe("Direct memory ID to delete"),
        query: z.string().optional().describe("Search query — best-matching memory will be deleted"),
        scope: z.string().optional().describe("Scope to search/delete in"),
        agentId: z.string().default("main").describe("Agent ID for scope resolution"),
      },
    },
    async (args): Promise<CallToolResult> => {
      const parsed = memoryForgetSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }
      return handleMemoryForget(deps, parsed.data);
    },
  );

  // ── memory_update ───────────────────────────────────────────────────────────
  server.registerTool(
    "memory_update",
    {
      description:
        "Update an existing memory's text, importance, or category. Provide either memoryId or query to identify the target. If text changes, the memory is re-embedded.",
      inputSchema: {
        memoryId: z.string().optional().describe("Direct memory ID to update"),
        query: z.string().optional().describe("Search query — best-matching memory will be updated"),
        text: z.string().optional().describe("New memory text (will trigger re-embedding)"),
        importance: z.number().min(0).max(1).optional().describe("New importance score 0-1"),
        category: z.enum(MEMORY_CATEGORIES).optional().describe("New category"),
        scope: z.string().optional().describe("Scope to search/update in"),
        agentId: z.string().default("main").describe("Agent ID for scope resolution"),
      },
    },
    async (args): Promise<CallToolResult> => {
      const parsed = memoryUpdateSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }
      return handleMemoryUpdate(deps, parsed.data);
    },
  );

  // ── memory_stats ───────────────────────────────────────────────────────────
  server.registerTool(
    "memory_stats",
    {
      description:
        "Get statistics about memory usage, scopes, and categories.",
      inputSchema: {
        scope: z.string().optional().describe("Specific scope to get stats for"),
        agentId: z.string().default("main").describe("Agent ID for scope resolution"),
      },
    },
    async (args): Promise<CallToolResult> => {
      const parsed = memoryStatsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }
      return handleMemoryStats(deps, parsed.data);
    },
  );

  // ── memory_debug ───────────────────────────────────────────────────────────
  server.registerTool(
    "memory_debug",
    {
      description:
        "Debug memory retrieval: search with full pipeline trace showing per-stage drop info, score ranges, and timing.",
      inputSchema: {
        query: z.string().describe("Search query to debug"),
        limit: z.number().int().min(1).max(20).default(5).describe("Max results to return"),
        scope: z.string().optional().describe("Specific memory scope to search in"),
        agentId: z.string().default("main").describe("Agent ID for scope resolution"),
      },
    },
    async (args): Promise<CallToolResult> => {
      const parsed = memoryDebugSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }
      return handleMemoryDebug(deps, parsed.data);
    },
  );

  // ── memory_list ───────────────────────────────────────────────────────────
  server.registerTool(
    "memory_list",
    {
      description:
        "List recent memories with optional filtering by scope and category.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(10).describe("Max memories to list"),
        scope: z.string().optional().describe("Filter by specific scope"),
        category: z.enum(MEMORY_CATEGORIES).optional().describe("Filter by category"),
        offset: z.number().int().min(0).max(1000).default(0).describe("Number of memories to skip"),
        agentId: z.string().default("main").describe("Agent ID for scope resolution"),
      },
    },
    async (args): Promise<CallToolResult> => {
      const parsed = memoryListSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }
      return handleMemoryList(deps, parsed.data);
    },
  );

  // ── memory_promote ───────────────────────────────────────────────────────────
  server.registerTool(
    "memory_promote",
    {
      description:
        "Promote a memory into confirmed/durable governance state so it can participate in conservative auto-recall.",
      inputSchema: {
        memoryId: z.string().optional().describe("Memory id (UUID/prefix). Optional when query is provided."),
        query: z.string().optional().describe("Search query to locate a memory when memoryId is omitted."),
        scope: z.string().optional().describe("Optional scope filter."),
        state: z.enum(["pending", "confirmed", "archived"]).default("confirmed").describe("Target state"),
        layer: z.enum(["durable", "working", "reflection", "archive"]).default("durable").describe("Target layer"),
        agentId: z.string().default("main").describe("Agent ID for scope resolution"),
      },
    },
    async (args): Promise<CallToolResult> => {
      const parsed = memoryPromoteSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }
      return handleMemoryPromote(deps, parsed.data);
    },
  );

  // ── memory_archive ───────────────────────────────────────────────────────────
  server.registerTool(
    "memory_archive",
    {
      description:
        "Archive a memory to remove it from default auto-recall while preserving history.",
      inputSchema: {
        memoryId: z.string().optional().describe("Memory id (UUID/prefix)."),
        query: z.string().optional().describe("Search query when memoryId is omitted."),
        scope: z.string().optional().describe("Optional scope filter."),
        reason: z.string().optional().default("manual_archive").describe("Archive reason for audit trail."),
        agentId: z.string().default("main").describe("Agent ID for scope resolution"),
      },
    },
    async (args): Promise<CallToolResult> => {
      const parsed = memoryArchiveSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }
      return handleMemoryArchive(deps, parsed.data);
    },
  );

  // ── memory_compact ───────────────────────────────────────────────────────────
  server.registerTool(
    "memory_compact",
    {
      description:
        "Compact duplicate low-value memories by archiving redundant entries and linking them to a canonical memory.",
      inputSchema: {
        scope: z.string().optional().describe("Optional scope filter."),
        dryRun: z.boolean().default(true).describe("Preview compaction only (default true)."),
        limit: z.number().int().min(20).max(1000).default(200).describe("Max entries to scan."),
        agentId: z.string().default("main").describe("Agent ID for scope resolution"),
      },
    },
    async (args): Promise<CallToolResult> => {
      const parsed = memoryCompactSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }
      return handleMemoryCompact(deps, parsed.data);
    },
  );

  // ── memory_explain_rank ───────────────────────────────────────────────────────────
  server.registerTool(
    "memory_explain_rank",
    {
      description:
        "Run recall and explain why each memory was ranked, including governance metadata (state/layer/source/suppression).",
      inputSchema: {
        query: z.string().describe("Query used for ranking analysis."),
        limit: z.number().int().min(1).max(20).default(5).describe("How many items to explain."),
        scope: z.string().optional().describe("Optional scope filter."),
        agentId: z.string().default("main").describe("Agent ID for scope resolution"),
      },
    },
    async (args): Promise<CallToolResult> => {
      const parsed = memoryExplainRankSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }
      return handleMemoryExplainRank(deps, parsed.data);
    },
  );

  // ── self_improvement_log ───────────────────────────────────────────────────────────
  server.registerTool(
    "self_improvement_log",
    {
      description:
        "Log structured learning/error entries into .learnings for governance and later distillation.",
      inputSchema: {
        type: z.enum(["learning", "error"]).describe("Entry type"),
        summary: z.string().describe("One-line summary"),
        details: z.string().optional().default("").describe("Detailed context or error output"),
        suggestedAction: z.string().optional().default("").describe("Concrete action to prevent recurrence"),
        category: z.string().optional().default("best_practice").describe("learning category (correction/best_practice/knowledge_gap) when type=learning"),
        area: z.string().optional().default("config").describe("frontend|backend|infra|tests|docs|config or custom area"),
        priority: z.string().optional().default("medium").describe("low|medium|high|critical"),
        workspaceDir: z.string().optional().describe("Override workspace directory"),
      },
    },
    async (args): Promise<CallToolResult> => {
      const parsed = selfImprovementLogSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }
      return handleSelfImprovementLog(deps, parsed.data);
    },
  );

  // ── self_improvement_extract_skill ───────────────────────────────────────────────────────────
  server.registerTool(
    "self_improvement_extract_skill",
    {
      description:
        "Create a new skill scaffold from a learning entry and mark the source learning as promoted_to_skill.",
      inputSchema: {
        learningId: z.string().describe("Learning ID like LRN-YYYYMMDD-001"),
        skillName: z.string().describe("Skill folder name, lowercase with hyphens"),
        sourceFile: z.enum(["LEARNINGS.md", "ERRORS.md"]).optional().default("LEARNINGS.md").describe("Source file"),
        outputDir: z.string().optional().default("skills").describe("Relative output dir under workspace"),
        workspaceDir: z.string().optional().describe("Override workspace directory"),
      },
    },
    async (args): Promise<CallToolResult> => {
      const parsed = selfImprovementExtractSkillSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }
      return handleSelfImprovementExtractSkill(deps, parsed.data);
    },
  );

  // ── self_improvement_review ───────────────────────────────────────────────────────────
  server.registerTool(
    "self_improvement_review",
    {
      description:
        "Summarize governance backlog from .learnings files (pending/high-priority/promoted counts).",
      inputSchema: {
        workspaceDir: z.string().optional().describe("Override workspace directory"),
      },
    },
    async (args): Promise<CallToolResult> => {
      const parsed = selfImprovementReviewSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }
      return handleSelfImprovementReview(deps, parsed.data);
    },
  );
}
