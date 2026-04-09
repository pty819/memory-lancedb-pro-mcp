#!/bin/bash
# =============================================================================
# memory-lancedb-pro upstream pull + impact analysis
# 用法: bash scripts/memory-upstream-pull.sh [--dry-run]
#   --dry-run: 只看有什么更新，不实际 pull
# =============================================================================

set -e

PLUGIN_DIR="$HOME/.hermes/plugins/memory-lancedb-pro"
cd "$PLUGIN_DIR"

DRY_RUN=false
if [ "$1" = "--dry-run" ]; then
  DRY_RUN=true
fi

echo "=========================================="
echo "memory-lancedb-pro Upstream Pull"
echo "时间: $(date '+%Y-%m-%d %H:%M')"
echo "模式: $([ "$DRY_RUN" = true ] && echo "DRY RUN（不实际 pull）" || echo "LIVE（将 pull）")"
echo "=========================================="

# --- Step 1: Fetch ---
echo ""
echo ">>> Step 1: Fetch upstream"
git fetch origin -q

LOCAL_HASH=$(git rev-parse HEAD)
REMOTE_HASH=$(git rev-parse origin/master)
BEHIND=$(git rev-list --count HEAD..origin/master 2>/dev/null || echo 0)

if [ "$BEHIND" = "0" ]; then
  echo "✅ Already up to date with origin/master ($LOCAL_HASH)"
  exit 0
fi

echo "📦 本地落后 origin/master $BEHIND 个提交"
echo ""
echo "最近 upstream 提交:"
git log origin/master --oneline -10

# --- Step 2: Changed core files ---
echo ""
echo ">>> Step 2: 改动范围分析"
git diff --stat HEAD..origin/master -- \
  src/store.ts src/retriever.ts src/embedder.ts \
  src/smart-extractor.ts src/smart-metadata.ts \
  src/decay-engine.ts src/tier-manager.ts \
  src/chunker.ts src/scopes.ts \
  src/noise-prototypes.ts src/noise-filter.ts \
  src/adaptive-retrieval.ts \
  src/llm-client.ts src/llm-oauth.ts \
  | grep -v "^\s*$" || echo "（无核心文件改动）"

# --- Step 3: 接口兼容性预估 ---
echo ""
echo ">>> Step 3: MCP 适配层兼容性预估"

COMPATIBLE=true
declare -a NEEDS_FIX=()

# 检查 embedder.ts 接口
if git diff HEAD..origin/master -- src/embedder.ts | grep -q "^\+.*EmbeddingConfig\|^\+.*interface.*Embed"; then
  echo "⚠️  embedder.ts: EmbeddingConfig 接口疑似变更，mcp-config.ts 可能需同步"
  NEEDS_FIX+=("src/mcp-config.ts")
  COMPATIBLE=false
fi

# 检查 retriever.ts 接口
if git diff HEAD..origin/master -- src/retriever.ts | grep -q "^\+.*RetrievalResult\|^\+.*retrieve("; then
  echo "⚠️  retriever.ts: retrieve() 接口疑似变更，mcp-tools.ts 可能需同步"
  NEEDS_FIX+=("src/mcp-tools.ts")
  COMPATIBLE=false
fi

# 检查 smart-extractor.ts 接口
if git diff HEAD..origin/master -- src/smart-extractor.ts | grep -q "^\+.*extractAndPersist\|^\+.*SmartExtractor"; then
  echo "⚠️  smart-extractor.ts: extractAndPersist() 接口疑似变更，mcp-tools.ts 可能需同步"
  NEEDS_FIX+=("src/mcp-tools.ts")
  COMPATIBLE=false
fi

# 检查 store.ts 接口
if git diff HEAD..origin/master -- src/store.ts | grep -q "^\+.*MemoryStore\|^\+.*interface.*Store"; then
  echo "⚠️  store.ts: MemoryStore 接口疑似变更，mcp-tools.ts 可能需同步"
  NEEDS_FIX+=("src/mcp-tools.ts")
  COMPATIBLE=false
fi

if [ "$COMPATIBLE" = true ]; then
  echo "✅ 未检测到接口签名变更，MCP 适配层应兼容"
fi

# --- Step 4: 实际 pull（如果不是 dry-run）---
if [ "$DRY_RUN" = true ]; then
  echo ""
  echo ">>> [DRY-RUN] 跳过实际 pull"
  echo ""
  echo "=========================================="
  echo "DRY RUN 摘要"
  echo "=========================================="
  echo "上游有 $BEHIND 个新提交待合入"
  if [ ${#NEEDS_FIX[@]} -gt 0 ]; then
    echo "⚠️  建议先处理: ${NEEDS_FIX[*]}"
    echo "   运行不带 --dry-run 执行实际 pull"
  else
    echo "✅ 接口兼容，可直接 pull"
    echo "   运行不带 --dry-run 执行实际 pull"
  fi
  exit 0
fi

echo ""
echo ">>> Step 4: 执行 git pull origin master"
if git pull origin master; then
  echo "✅ pull 成功"
else
  echo "❌ pull 失败（可能有冲突），手动解决后再运行本脚本"
  exit 1
fi

# --- Step 5: 编译验证 ---
echo ""
echo ">>> Step 5: 编译验证"

if [ -f "dist/mcp-server.js" ]; then
  OLD_DIST_MTIME=$(stat -c %Y dist/mcp-server.js 2>/dev/null || echo 0)
fi

# 只编译 MCP 相关文件的依赖（加速）
if npx tsc --version >/dev/null 2>&1; then
  # 编译，看看有没有错误
  BUILD_OUTPUT=$(npx tsc --noEmit 2>&1 || true)
  if echo "$BUILD_OUTPUT" | grep -q "error TS"; then
    echo "⚠️  编译有错误（可能是上游接口变更）:"
    echo "$BUILD_OUTPUT" | grep "error TS" | head -20
    echo ""
    echo "需要手动检查 mcp-tools.ts / mcp-config.ts 对应接口"
  else
    echo "✅ 编译通过"
  fi
else
  echo "⚠️  tsc 不可用，跳过编译检查（上游用 jiti，不需要 tsc）"
fi

# --- Step 6: MCP 层源文件时间戳检查 ---
echo ""
echo ">>> Step 6: MCP 适配层是否需要重新编译"

MCP_STALE=false
for f in src/mcp-server.ts src/mcp-tools.ts src/mcp-config.ts; do
  if [ -f "$f" ]; then
    SRC_MTIME=$(stat -c %Y "$f" 2>/dev/null || echo 0)
    if [ -f "dist/$(basename "$f" .ts").js" ]; then
      DIST_MTIME=$(stat -c %Y "dist/$(basename "$f" .ts").js" 2>/dev/null || echo 0)
      if [ "$SRC_MTIME" -gt "$DIST_MTIME" ]; then
        echo "📝 $f 源码比 dist 新"
        MCP_STALE=true
      fi
    fi
  fi
done

if [ "$MCP_STALE" = true ]; then
  echo ""
  echo "⚠️  dist 需要更新，建议运行: npm run build"
fi

# --- Final Report ---
echo ""
echo "=========================================="
echo "Pull 摘要"
echo "=========================================="
echo "合入了 $BEHIND 个 upstream 提交"
echo ""

if [ ${#NEEDS_FIX[@]} -gt 0 ]; then
  echo "⚠️  检测到接口变更，可能需要修以下文件:"
  for f in "${NEEDS_FIX[@]}"; do
    echo "   - $f"
  done
  echo ""
  echo "下一步: 手动修完后运行 npm run build && 重启 hermes-gateway"
elif [ "$MCP_STALE" = true ]; then
  echo "⚠️  dist 需要更新"
  echo "下一步: npm run build && systemctl restart hermes-gateway"
else
  echo "✅ 无需额外修复"
  echo "下一步: systemctl restart hermes-gateway 验证"
fi
echo "=========================================="
