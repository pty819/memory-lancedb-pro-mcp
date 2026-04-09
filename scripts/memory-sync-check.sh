#!/bin/bash
# =============================================================================
# memory-lancedb-pro upstream sync checker
# 用法: bash scripts/memory-sync-check.sh
# =============================================================================

set -e

PLUGIN_DIR="$HOME/.hermes/plugins/memory-lancedb-pro"
cd "$PLUGIN_DIR"

echo "=========================================="
echo "memory-lancedb-pro Upstream Sync Check"
echo "时间: $(date '+%Y-%m-%d %H:%M')"
echo "=========================================="

# --- Layer A: 核心业务文件列表 ---
CORE_FILES=(
  "src/store.ts"
  "src/retriever.ts"
  "src/embedder.ts"
  "src/smart-extractor.ts"
  "src/smart-metadata.ts"
  "src/decay-engine.ts"
  "src/tier-manager.ts"
  "src/chunker.ts"
  "src/scopes.ts"
  "src/noise-prototypes.ts"
  "src/noise-filter.ts"
  "src/adaptive-retrieval.ts"
  "src/llm-client.ts"
  "src/llm-oauth.ts"
)

# --- Layer B: 本地修复应推回上游的文件（对 Layer A 的有意改动）---
# 这些文件的本地改动是预期的，不需要警告
LAYER_B_FILES=(
  "src/store.ts"
  "src/embedder.ts"
)

# --- Layer C: 本地维护文件（纯新增 untracked） ---
LOCAL_FILES=(
  "src/mcp-server.ts"
  "src/mcp-tools.ts"
  "src/mcp-config.ts"
  "scripts/memory-sync-check.sh"
  "scripts/memory-upstream-pull.sh"
  "docs/MIGRATION-PLAN.md"
  "docs/INGEST-REFORM-PLAN.md"
  "docs/UPSTREAM-SYNC.md"
)

# --- Layer C: 本地修改的已跟踪文件（可能冲突） ---
LOCAL_MODIFIED_TRACKED=(
  "package.json"
  "package-lock.json"
  "tsconfig.json"
  "docs/long-context-chunking.md"
  "docs/memory_architecture_analysis.md"
  "docs/openclaw-integration-playbook.md"
  "docs/openclaw-integration-playbook.zh-CN.md"
)

# --- Step 1: Fetch and check upstream ---

echo ""
echo ">>> Step 1: 检查 upstream 状态"
echo ""

git fetch origin -q 2>/dev/null || true

LOCAL_HASH=$(git rev-parse HEAD)
REMOTE_HASH=$(git rev-parse origin/master)

if [ "$LOCAL_HASH" = "$REMOTE_HASH" ]; then
  echo "✅ 本地与 origin/master 完全同步 ($LOCAL_HASH)"
else
  echo "⚠️  本地落后于 origin/master"
  echo "   本地:   $LOCAL_HASH"
  echo "   remote: $REMOTE_HASH"
  echo ""
  echo "最近 upstream 提交:"
  git log origin/master --oneline -10
fi

# --- Step 2: 检查核心文件是否有未提交的本地改动 ---

echo ""
echo ">>> Step 2: 检查 Layer A 核心文件改动"
echo ""

# 先报告 Layer B 改动（预期内）
for f in "${LAYER_B_FILES[@]}"; do
  if [ -f "$f" ]; then
    if ! git diff HEAD -- "$f" 2>/dev/null | grep -q "^"; then
      :
    else
      echo "📝 $f — Layer B 本地修复（待推 PR 上游）"
      git diff --stat HEAD -- "$f"
    fi
  fi
done

# 再报告真正的 Layer A 意外改动
UNEXPECTED_CHANGES=false
for f in "${CORE_FILES[@]}"; do
  # 跳过 Layer B 文件
  IS_LAYER_B=false
  for lb in "${LAYER_B_FILES[@]}"; do
    if [ "$f" = "$lb" ]; then
      IS_LAYER_B=true
      break
    fi
  done
  if [ "$IS_LAYER_B" = true ]; then continue; fi

  if [ -f "$f" ]; then
    if ! git diff HEAD -- "$f" 2>/dev/null | grep -q "^"; then
      :
    else
      echo "⚠️  $f 有本地未提交改动（非 Layer B，异常）"
      git diff --stat HEAD -- "$f"
      UNEXPECTED_CHANGES=true
    fi
  fi
done

if [ "$UNEXPECTED_CHANGES" = false ]; then
  echo "✅ Layer A 核心文件无意外改动"
fi

# --- Step 3: 检查上游核心文件相比本地的变化 ---

echo ""
echo ">>> Step 3: 检查 upstream 是否有新的核心逻辑更新"
echo ""

CORE_UPDATED=false
for f in "${CORE_FILES[@]}"; do
  if [ -f "$f" ]; then
    BEHIND=$(git rev-list --count HEAD..origin/master -- "$f" 2>/dev/null || echo "0")
    if [ "$BEHIND" -gt 0 ]; then
      echo "📦 $f — upstream 有 $BEHIND 个新提交"
      git log origin/master --oneline -3 -- "$f"
      CORE_UPDATED=true
    fi
  fi
done

if [ "$CORE_UPDATED" = true ]; then
  echo ""
  echo "⚠️  建议执行: git pull origin master"
else
  echo "✅ Layer A 核心文件与 upstream 同步"
fi

# --- Step 4: 检查 Layer C 本地维护文件 ---
echo ""
echo ">>> Step 4: 检查 Layer C 本地维护文件（untracked）"
echo ""

ALL_LOCAL_FILES_OK=true
for f in "${LOCAL_FILES[@]}"; do
  if [ -f "$f" ]; then
    lines=$(wc -l < "$f" 2>/dev/null || echo "?")
    echo "✅ $f ($lines 行)"
  else
    echo "❌ $f 缺失"
    ALL_LOCAL_FILES_OK=false
  fi
done

# --- Step 4b: 检查 Layer C 已跟踪文件的本地修改 ---
echo ""
echo ">>> Step 4b: 检查 Layer C 已跟踪文件的本地修改（可能的冲突源）"
echo ""

HAS_MODIFIED=false
for f in "${LOCAL_MODIFIED_TRACKED[@]}"; do
  if [ -f "$f" ]; then
    if ! git diff HEAD -- "$f" 2>/dev/null | grep -q "^"; then
      :
    else
      echo "📝 $f — 有本地修改（pull 时需关注是否冲突）"
      git diff --stat HEAD -- "$f"
      HAS_MODIFIED=true
    fi
  fi
done

if [ "$HAS_MODIFIED" = false ]; then
  echo "✅ Layer C 已跟踪文件无意外改动"
fi

# --- Step 5: config.yaml 是否在 gitignore ---

echo ""
echo ">>> Step 5: config.yaml 检查"
echo ""

if git check-ignore -q config.yaml 2>/dev/null; then
  echo "✅ config.yaml 在 .gitignore 中"
else
  echo "⚠️  config.yaml 不在 .gitignore，建议加入避免提交敏感信息"
fi

# --- Step 6: 编译验证 ---
# 注意：上游用 jiti 直接跑 TS，不需要编译。
# 本地 MCP 入口需要 tsc 编译，检查 dist 是否存在即可。

echo ""
echo ">>> Step 6: MCP 编译验证"
echo ""

if [ -f "dist/mcp-server.js" ]; then
  # 检查 dist 是否比源文件新
  MCP_SRC="src/mcp-server.ts"
  if [ -f "$MCP_SRC" ]; then
    DIST_MTIME=$(stat -c %Y dist/mcp-server.js 2>/dev/null || echo 0)
    SRC_MTIME=$(stat -c %Y "$MCP_SRC" 2>/dev/null || echo 0)
    if [ "$DIST_MTIME" -ge "$SRC_MTIME" ]; then
      echo "✅ dist/mcp-server.js 已编译且最新"
    else
      echo "⚠️  dist/mcp-server.js 比源文件旧，建议重新编译"
      echo "   运行: cd $PLUGIN_DIR && npm run build"
    fi
  else
    echo "✅ dist/mcp-server.js 存在"
  fi
else
  echo "⚠️  dist/mcp-server.js 不存在，需编译"
  echo "   运行: npm install && npm run build"
fi

# --- Summary ---

echo ""
echo "=========================================="
echo "摘要"
echo "=========================================="
echo ""
echo "Layer A (核心逻辑): 上游活跃，需定期 sync"
echo "Layer B (本地修复): embedder console.error / store ESM"
echo "Layer C (MCP 入口): 自主维护，不依赖上游"
echo ""
echo "参考文档: docs/UPSTREAM-SYNC.md"
echo "=========================================="
