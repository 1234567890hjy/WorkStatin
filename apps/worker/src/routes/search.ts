/**
 * 全局搜索：一次请求搜遍记账、运动、视频、任务。
 *
 * 为什么要有这个：各模块自己都有搜索或列表，但「我记得记过一笔但忘了是哪天」
 * 这种跨模块回忆，只能靠全局搜索。这也是业界工作台的标配
 * （gethomepage / Dashy / 飞书工作台都有）。
 *
 * 实现取舍：
 * - 不引入 FTS5 虚拟表。D1 的 FTS5 支持与迁移成本对单人数据量（几千行）不划算，
 *   LIKE 足够，且各表都有索引兜底。
 * - 每个模块最多返回 N 条，总量有上限，避免一次拉爆。
 * - 关键词前后带 % 做包含匹配；空关键词直接拒绝。
 */

import { Hono } from 'hono';
import type { Env } from '../types.ts';
import { ok, err } from '../http.ts';
import { requireSession } from './auth.ts';

export const searchRoutes = new Hono<{ Bindings: Env }>();

const MAX_QUERY = 40;
const PER_MODULE = 8;

searchRoutes.use('*', async (c, next) => {
  const session = await requireSession(c.env, c.req.raw);
  if (!session) return err('UNAUTHORIZED', '未登录或会话已过期', 401);
  await next();
});

searchRoutes.get('/', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (!q) return err('EMPTY_QUERY', '请输入搜索词');
  if (q.length > MAX_QUERY) {
    return err('QUERY_TOO_LONG', `搜索词最长 ${MAX_QUERY} 字`);
  }

  const like = `%${q}%`;

  // 四个模块并行搜；单个模块失败不影响其他模块
  const [txns, workouts, videos, tasks] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, type, amount_cents, merchant, note, occurred_day,
              category_id, account_id
       FROM txn
       WHERE deleted_at IS NULL
         AND (merchant LIKE ? OR note LIKE ?)
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`,
    )
      .bind(like, like, PER_MODULE)
      .all()
      .catch(() => ({ results: [] as unknown[] })),

    c.env.DB.prepare(
      `SELECT id, kind, duration_min, distance_m, note, occurred_day
       FROM workout
       WHERE deleted_at IS NULL AND note LIKE ?
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`,
    )
      .bind(like, PER_MODULE)
      .all()
      .catch(() => ({ results: [] as unknown[] })),

    c.env.DB.prepare(
      `SELECT id, url, platform, title, author, status, tags
       FROM video_item
       WHERE deleted_at IS NULL
         AND (title LIKE ? OR summary LIKE ? OR tags LIKE ? OR transcript LIKE ?)
       ORDER BY created_at DESC
       LIMIT ?`,
    )
      .bind(like, like, like, like, PER_MODULE)
      .all()
      .catch(() => ({ results: [] as unknown[] })),

    c.env.DB.prepare(
      `SELECT id, title, detail, status, priority, due_day
       FROM task
       WHERE deleted_at IS NULL
         AND (title LIKE ? OR detail LIKE ?)
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    )
      .bind(like, like, PER_MODULE)
      .all()
      .catch(() => ({ results: [] as unknown[] })),
  ]);

  const r = {
    txns: (txns.results ?? []) as Record<string, unknown>[],
    workouts: (workouts.results ?? []) as Record<string, unknown>[],
    videos: (videos.results ?? []) as Record<string, unknown>[],
    tasks: (tasks.results ?? []) as Record<string, unknown>[],
  };

  const total =
    r.txns.length + r.workouts.length + r.videos.length + r.tasks.length;

  return ok({ q, total, ...r });
});
