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
| Dashboard 概览 | ✅ 可用 |
| 认证与会话 | ✅ 可用 |
| 净资产（手动维护） | ✅ 可用 |
| 运动记录 | ✅ 可用 |
| 天气卡片 | ✅ 可用 |
| 视频 AI 学习 | ✅ 可用 |
| 计划任务 / 日常管理 / 备份演练 | ⬜ P2 |

## 快速开始

```bash
npm install --ignore-scripts     # 沙箱环境必须加 --ignore-scripts
npx tsc -p tsconfig.worker.json  # 类型检查
npx vitest run                   # 48 项单元测试
node --experimental-strip-types apps/worker/test/smoke.ts   # 50 项接口冒烟
```

详见 [开发说明](docs/开发说明.md) 与 [方案 v2](docs/个人工作台-方案v2.md)。

## 关键约束

- **金额一律用「分」的整数**，绝不用浮点
- **P0 验收标准**：本人真的在户外用它记 3 天账，比鲨鱼记账慢就返工
- **模块准入原则**：任何模块在「连续使用 7 天」之前，不进路线图
