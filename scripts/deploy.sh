#!/usr/bin/env bash
# 部署到 Cloudflare：D1 迁移 + Worker 上传。
#
# 为什么单独写一个脚本：
#   部署有严格顺序，漏一步就会出问题 ——
#   先 deploy 再迁移，新代码会打到不存在的表上（notify 相关接口全 500）；
#   先迁移再 deploy，旧代码不认识新表但也不受影响，是安全的。
#
# 用法：
#   bash scripts/deploy.sh              # 完整部署
#   bash scripts/deploy.sh --dry-run    # 只检查前置条件和迁移清单
#
# 前置：
#   npx wrangler login   （或在 CI 里设 CLOUDFLARE_API_TOKEN）
#
# 注意：本机网络对 *.workers.dev 有 DNS 污染（见 docs/部署记录.md 第四节），
# 部署能否成功与能否访问是两个问题 —— API 调用是通的。

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"
WORKER="$ROOT/apps/worker"
WEB="$ROOT/apps/web"
DB=workstation-db

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

# ---- 前置检查 ----
step "0/4 前置检查"

[ -f "$WORKER/wrangler.toml" ] || fail "找不到 apps/worker/wrangler.toml"
grep -q "database_id" "$WORKER/wrangler.toml" || fail "wrangler.toml 缺少 database_id"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  # 没有环境变量时，wrangler 只能靠 oauth 登录态
  echo "  未检测到 CLOUDFLARE_API_TOKEN，将使用 wrangler 登录态"
  echo "  如未登录，请先执行： npx wrangler login"
fi

# 迁移文件必须齐全
for f in "$WORKER/migrations/0001_init.sql" "$WORKER/migrations/0002_notify.sql"; do
  [ -f "$f" ] || fail "缺少迁移文件：$f"
done
echo "  ✓ 迁移文件齐全"

# 工作区干净，避免部署了未提交的代码
if [ -d "$ROOT/.git" ]; then
  DIRTY=$(git status --porcelain | grep -v '^?? ' | wc -l | tr -d ' ')
  if [ "$DIRTY" != "0" ]; then
    echo "  ⚠ 工作区有 $DIRTY 个未提交改动，请确认这是你要部署的内容"
  else
    echo "  ✓ 工作区干净"
  fi
fi

# ---- 类型检查与测试 ----
step "1/4 类型检查与测试（不合格不部署）"

( cd "$ROOT" && npx tsc -p tsconfig.worker.json ) || fail "Worker 类型检查失败"
echo "  ✓ Worker 类型检查通过"

node --experimental-strip-types "$WORKER/test/run.ts" > /tmp/ws-unit.log 2>&1 \
  || { cat /tmp/ws-unit.log; fail "单元测试失败"; }
tail -2 /tmp/ws-unit.log | head -1
echo "  ✓ 单元测试通过"

node --experimental-strip-types "$WORKER/test/e2e-notify.ts" > /tmp/ws-e2e.log 2>&1 \
  || { cat /tmp/ws-e2e.log; fail "端到端测试失败"; }
tail -2 /tmp/ws-e2e.log | head -1
echo "  ✓ 端到端测试通过"

# ---- D1 迁移 ----
step "2/4 D1 迁移（必须先于 deploy）"

echo "  待应用的迁移："
( cd "$WORKER" && npx wrangler d1 migrations list "$DB" --remote 2>&1 | tail -10 )

if [ "$DRY_RUN" = "1" ]; then
  echo
  echo "  [dry-run] 跳过实际迁移与应用部署"
  exit 0
fi

echo
echo "  开始迁移…"
( cd "$WORKER" && npx wrangler d1 migrations apply "$DB" --remote ) \
  || fail "D1 迁移失败（未继续部署，线上保持旧版本可正常使用）"
echo "  ✓ 迁移完成"

# ---- 前端构建 ----
step "3/4 前端构建"

# vite build 需要 spawn esbuild 子进程；某些沙箱环境禁止，
# 这时必须先在有权限的环境里构建好 dist 再部署。
if ( cd "$WEB" && npx vite build ) > /tmp/ws-web.log 2>&1; then
  tail -3 /tmp/ws-web.log
  echo "  ✓ 前端构建完成"
else
  if [ -f "$WEB/dist/index.html" ]; then
    echo "  ⚠ vite build 失败，但 dist/ 已存在，将使用现有产物"
    echo "    （沙箱禁止 esbuild 子进程时这是预期行为）"
    ls -la "$WEB/dist" | head -5
  else
    cat /tmp/ws-web.log | tail -10
    fail "前端构建失败且没有可用产物"
  fi
fi

# ---- 部署 ----
step "4/4 部署 Worker"

( cd "$WORKER" && npx wrangler deploy ) || fail "wrangler deploy 失败"
echo "  ✓ 部署完成"

cat <<'DONE'

────────────────────────────────────────
部署后自检（本机可能因 DNS 污染访问不了，用手机流量验）：

  1. 打开线上地址，确认「通知收件箱」页面能进
  2. 首页看是否出现「有 N 笔待确认」横幅
  3. 手机上的 APK 把服务器地址改成线上域名，点「立即上传队列」
  4. 回到工作台，确认健康度从「未配置」变成「正常」

如果第 3 步后健康度仍是「从未收到设备心跳」：
  → APK 里的服务器地址要填公网域名，不能是 127.0.0.1
  → 确认域名能被手机访问（workers.dev 在国内不稳，建议绑自定义域）
────────────────────────────────────────
DONE
