/** Dashboard 聚合：一次请求拿到首页所有卡片数据。 */

import { Hono } from 'hono';
import type { Env } from '../types.ts';
import { currentMonth, currentDay } from '../domain/dates.ts';
import { ok, err } from '../http.ts';
import { requireSession } from './auth.ts';

export const dashboardRoutes = new Hono<{ Bindings: Env }>();

dashboardRoutes.use('*', async (c, next) => {
  const session = await requireSession(c.env, c.req.raw);
  if (!session) return err('UNAUTHORIZED', '未登录或会话已过期', 401);
  await next();
});

dashboardRoutes.get('/', async (c) => {
  const month = c.req.query('month') ?? currentMonth();
  const day = currentDay();

  const [monthStats, todayStats, recent, netWorth, workout7, taskOpen] = await Promise.all([
    c.env.DB.prepare(
      `SELECT kind, SUM(total_cents) AS total FROM monthly_summary
       WHERE month = ? GROUP BY kind`,
    )
      .bind(month)
      .all<{ kind: string; total: number }>(),

    c.env.DB.prepare(
      `SELECT type, SUM(amount_cents) AS total, COUNT(*) AS n FROM txn
       WHERE deleted_at IS NULL AND occurred_day = ? GROUP BY type`,
    )
      .bind(day)
      .all<{ type: string; total: number; n: number }>(),

    c.env.DB.prepare(
      `SELECT t.id, t.type, t.amount_cents, t.merchant, t.note, t.occurred_at,
              a.name AS account_name, c.name AS category_name
       FROM txn t
       LEFT JOIN account a ON a.id = t.account_id
       LEFT JOIN category c ON c.id = t.category_id
       WHERE t.deleted_at IS NULL
       ORDER BY t.occurred_at DESC, t.id DESC LIMIT 8`,
    ).all(),

    c.env.DB.prepare(
      'SELECT COALESCE(SUM(balance_cents), 0) AS total FROM account WHERE is_archived = 0',
    ).first<{ total: number }>(),

    c.env.DB.prepare(
      `SELECT COALESCE(SUM(duration_min), 0) AS minutes, COUNT(*) AS n
       FROM workout WHERE deleted_at IS NULL AND occurred_day >= date(?, '-6 days')`,
    )
      .bind(day)
      .first<{ minutes: number; n: number }>(),

    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM task WHERE deleted_at IS NULL AND status IN ('todo','doing')`,
    ).first<{ n: number }>(),
  ]);

  const pick = (rows: { kind: string; total: number }[], kind: string) =>
    rows.find((r) => r.kind === kind)?.total ?? 0;

  const mRows = monthStats.results ?? [];
  const dRows = todayStats.results ?? [];
  const dayTotal = (t: string) => dRows.find((r) => r.type === t)?.total ?? 0;

  // ---- P1 附加聚合（失败不影响主数据）----
  const [videoCounts, workoutRecent] = await Promise.all([
    c.env.DB.prepare(
      `SELECT
         SUM(CASE WHEN status IN ('draft','transcribed') THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status IN ('summarized','archived') THEN 1 ELSE 0 END) AS done
       FROM video_item WHERE deleted_at IS NULL`,
    )
      .first<{ pending: number | null; done: number | null }>()
      .catch(() => null),

    c.env.DB.prepare(
      `SELECT kind, duration_min, distance_m, occurred_day
       FROM workout WHERE deleted_at IS NULL
       ORDER BY occurred_at DESC, id DESC LIMIT 3`,
    )
      .all()
      .catch(() => ({ results: [] as unknown[] })),
  ]);

  return ok({
    month,
    day,
    month_stats: {
      expense_cents: pick(mRows, 'expense'),
      income_cents: pick(mRows, 'income'),
      transfer_cents: pick(mRows, 'transfer'),
    },
    today_stats: {
      expense_cents: dayTotal('expense'),
      income_cents: dayTotal('income'),
      count: dRows.reduce((a, r) => a + r.n, 0),
    },
    net_worth_cents: netWorth?.total ?? 0,
    workout_7d: { minutes: workout7?.minutes ?? 0, count: workout7?.n ?? 0 },
    open_tasks: taskOpen?.n ?? 0,
    recent_txns: recent.results ?? [],
    // P1
    video_stats: {
      pending: videoCounts?.pending ?? 0,
      done: videoCounts?.done ?? 0,
    },
    recent_workouts: workoutRecent?.results ?? [],
  });
});
