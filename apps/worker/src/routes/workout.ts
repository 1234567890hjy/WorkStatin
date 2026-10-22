/**
 * 运动记录。
 *
 * 只记「做了什么、多久、多远、多少卡」——不做 GPS 轨迹、不接手环。
 * 单次录入必须能在 10 秒内完成，否则会重蹈记账摩擦的覆辙。
 */

import { Hono } from 'hono';
import type { Env } from '../types.ts';
import { normalizeOccurred, isValidDay, currentDay } from '../domain/dates.ts';
import { ok, err } from '../http.ts';
import { requireSession } from './auth.ts';

export const workoutRoutes = new Hono<{ Bindings: Env }>();

const KINDS = ['run', 'walk', 'cycle', 'gym', 'swim', 'other'] as const;
type Kind = (typeof KINDS)[number];

workoutRoutes.use('*', async (c, next) => {
  const session = await requireSession(c.env, c.req.raw);
  if (!session) return err('UNAUTHORIZED', '未登录或会话已过期', 401);
  await next();
});

interface WorkoutInput {
  kind?: string;
  duration_min?: number;
  distance_m?: number;
  calories?: number;
  note?: string;
  occurred_at?: string;
}

/** 列表 */
workoutRoutes.get('/', async (c) => {
  const day = c.req.query('day');
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);

  const where: string[] = ['deleted_at IS NULL'];
  const binds: unknown[] = [];

  if (day) {
    if (!isValidDay(day)) return err('INVALID_DAY', 'day 格式应为 YYYY-MM-DD');
    where.push('occurred_day = ?');
    binds.push(day);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM workout WHERE ${where.join(' AND ')}
     ORDER BY occurred_at DESC, id DESC LIMIT ?`,
  )
    .bind(...binds, limit)
    .all();

  return ok({ items: results ?? [] });
});

/** 近 N 天汇总 */
workoutRoutes.get('/stats', async (c) => {
  const days = Math.min(Number(c.req.query('days') ?? 7), 365);
  const end = c.req.query('end') ?? currentDay();
  if (!isValidDay(end)) return err('INVALID_DAY', 'end 格式应为 YYYY-MM-DD');

  const row = await c.env.DB.prepare(
    `SELECT
       COALESCE(SUM(duration_min), 0) AS minutes,
       COALESCE(SUM(distance_m), 0)   AS distance_m,
       COALESCE(SUM(calories), 0)     AS calories,
       COUNT(*)                       AS count
     FROM workout
     WHERE deleted_at IS NULL AND occurred_day >= date(?, ?)`,
  )
    .bind(end, `-${days - 1} days`)
    .first<{ minutes: number; distance_m: number; calories: number; count: number }>();

  // 按天分组，前端画柱状图
  const { results } = await c.env.DB.prepare(
    `SELECT occurred_day, SUM(duration_min) AS minutes, COUNT(*) AS n
     FROM workout
     WHERE deleted_at IS NULL AND occurred_day >= date(?, ?)
     GROUP BY occurred_day ORDER BY occurred_day`,
  )
    .bind(end, `-${days - 1} days`)
    .all<{ occurred_day: string; minutes: number; n: number }>();

  return ok({
    days,
    end,
    minutes: row?.minutes ?? 0,
    distance_m: row?.distance_m ?? 0,
    calories: row?.calories ?? 0,
    count: row?.count ?? 0,
    by_day: results ?? [],
  });
});

/** 新增 */
workoutRoutes.post('/', async (c) => {
  const body = await c.req.json<WorkoutInput>().catch(() => null);
  if (!body) return err('INVALID_BODY', '请求体必须是 JSON');

  const kind = String(body.kind ?? '') as Kind;
  if (!KINDS.includes(kind)) {
    return err('INVALID_KIND', `kind 必须是 ${KINDS.join('/')}`);
  }

  const duration = Number(body.duration_min);
  if (!Number.isInteger(duration) || duration <= 0 || duration > 1440) {
    return err('INVALID_DURATION', '时长必须是 1~1440 的整数分钟');
  }

  const distance = optionalNonNegInt(body.distance_m, 1_000_000);
  if (distance === 'bad') return err('INVALID_DISTANCE', '距离非法');
  const calories = optionalNonNegInt(body.calories, 100_000);
  if (calories === 'bad') return err('INVALID_CALORIES', '卡路里非法');

  const dates = normalizeOccurred(body.occurred_at);
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null;

  const res = await c.env.DB.prepare(
    `INSERT INTO workout (kind, duration_min, distance_m, calories, note, occurred_at, occurred_day)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(kind, duration, distance, calories, note, dates.occurredAt, dates.occurredDay)
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM workout WHERE id = ?')
    .bind(res.meta.last_row_id)
    .first();

  return ok(row);
});

/** 软删除 */
workoutRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const row = await c.env.DB.prepare(
    'SELECT id FROM workout WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(id)
    .first();
  if (!row) return err('NOT_FOUND', '记录不存在', 404);

  await c.env.DB.prepare(`UPDATE workout SET deleted_at = datetime('now') WHERE id = ?`)
    .bind(id)
    .run();

  return ok({ deleted: id });
});

function optionalNonNegInt(v: unknown, max: number): number | null | 'bad' {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) return 'bad';
  return n;
}
