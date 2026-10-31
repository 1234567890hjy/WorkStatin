# Workstatin Me

个人工作台 —— 记账、运动、学习与计划的自用工作台。

## 技术栈

Cloudflare Pages + Workers + D1 + R2 · Hono (TypeScript) · React + Vite + Tailwind

**为什么不用 FastAPI + PostgreSQL + Docker**：固定成本从 ¥30~60/月降到 0；
手机「分享导入」要求 7×24 公网 HTTPS，NAS 做不到。

## 当前进度：P0 + P1 完成

| 模块 | 状态 |
|---|---|
| 记账（支出/收入/转账） | ✅ 可用 |
| 分享导入（Android share_target） | ✅ 可用 |
| 通知自动记账（服务端 + APK + 前端） | 🟡 待部署 |
| Dashboard 概览 | ✅ 可用 |
| 认证与会话 | ✅ 可用 |
| 修改口令 | ✅ 可用 |
| 净资产（手动维护） | ✅ 可用 |
| 运动记录 | ✅ 可用 |
| 天气卡片 | ✅ 可用 |
| 视频 AI 学习 | ✅ 可用 |
| 计划与任务 | ✅ 可用 |
| 日常管理（习惯打卡） | ✅ 可用 |
| 全局搜索 | ✅ 可用 |
| 分类占比图 | ✅ 可用 |
| 分类/账户管理 | ✅ 可用 |
| 备份恢复演练 / 预算告警 / 天气×运动相关性 | ⬜ P2 |

## 快速开始

```bash
npm install --ignore-scripts     # 沙箱环境必须加 --ignore-scripts
npx tsc -p tsconfig.worker.json  # Worker 类型检查
npx tsc -p tsconfig.test.json    # 测试代码类型检查
node --experimental-strip-types apps/worker/test/run.ts        # 117 项单元测试
node --experimental-strip-types apps/worker/test/e2e-notify.ts # 31 项端到端
node --experimental-strip-types apps/web/test/render-notify.ts # 15 项前端逻辑
node --experimental-strip-types apps/worker/test/smoke.ts      # 112 项接口冒烟
python tools/check-migrations.py # 迁移脚本跑真实 SQLite 验证

# Android APK（需 JDK 17 + Android SDK platform 28 + build-tools 29.0.3）
bash apps/android/build.sh                                     # 手工链路，无 Gradle
PYTHONIOENCODING=utf-8 python apps/android/e2e_device.py       # 模拟器真机链路验证

# 部署（需先 npx wrangler login）
bash scripts/deploy.sh           # 检查 → 测试 → D1 迁移 → 构建 → deploy
bash scripts/deploy.sh --dry-run # 只检查，不动线上
```

> **沙箱限制**：`vitest` 与 `vite build` 都要 spawn esbuild 子进程，本环境禁止，
> 所以单元测试走 `test/run.ts`（自包含 runner，直接 import 模块）。
> 在 `danger-full-access` 下可改用 `npx vitest run`。

详见 [开发说明](docs/开发说明.md)、[方案 v2](docs/个人工作台-方案v2.md) 与
[通知自动记账](docs/通知自动记账.md)。

## 关键约束

- **金额一律用「分」的整数**，绝不用浮点
- **P0 验收标准**：本人真的在户外用它记 3 天账，比鲨鱼记账慢就返工
- **模块准入原则**：任何模块在「连续使用 7 天」之前，不进路线图
- **通知置信度与分享通道不同**：通知里没有商户，渠道+金额+动词即判 high；
  分享通道仍需商户。两条规则不要为了「统一」而合并（详见通知文档第二节）
