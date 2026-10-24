/**
 * 日常管理（习惯打卡）。
 *
 * 表 0001_init.sql 里就建好了，Dashboard 一直没用到 —— 这是「半成品裸露」，本文件补完。
 *
 * 设计要点：
 * - 打卡是 `POST /:id/check`，内部 INSERT OR IGNORE：`routine_log` 有
 *   UNIQUE(routine_id, done_day)，重复打同一天不会写两行，天然幂等。
 * - 取消打卡是 `DELETE /:id/check?day=YYYY-MM-DD`。
 * - 列表一次带回「本周/本月进度」和「连续天数」，前端不必自己算。
 */

import { Hono } from 'hono';
import type { Env } from '../types.ts';
import { currentDay, isValidDay } from '../domain/dates.ts';
import { validateRoutine, periodRange, currentStreak } from '../domain/routine.ts';
import { ok, err } from '../http.ts';
import { requireSession } from './auth.ts';

export const routineRoutes = new Hono<{ Bindings: Env }>();

routineRoutes.use('*', async (c, next) => {
  const session = await requireSession(c.env, c.req.raw);
  if (!session) return err('UNAUTHORIZED', '未登录或会话已过期', 401);
  await next();
});

interface RoutineRow {
  id: number;
  name: string;
  cadence: string;
  target_per_period: number;
  is_active: number;
  created_at: string;
}

/** 列表：带进度与连续天数 */
routineRoutes.get('/', async (c) => {
  const includeInactive = c.req.query('include_inactive') === '1';

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM routine ${includeInactive ? '' : 'WHERE is_active = 1'} ORDER BY id`,
  ).all<RoutineRow>();

  const rows = results ?? [];
  if (rows.length === 0) return ok({ items: [], today: currentDay() });

  const today = currentDay();

  // 一次取回所有打卡记录（单人数据量小，避免 N+1）
  const { results: logs } = await c.env.DB.prepare(
    'SELECT routine_id, done_day FROM routine_log ORDER BY done_day',
  ).all<{ routine_id: number; done_day: string }>();

  const byRoutine = new Map<number, string[]>();
  for (const l of logs ?? []) {
    const arr = byRoutine.get(l.routine_id) ?? [];
    arr.push(l.done_day);
    byRoutine.set(l.routine_id, arr);
  }

  const items = rows.map((r) => {
    const days = byRoutine.get(r.id) ?? [];
    const { from, to } = periodRange(
      r.cadence as 'daily' | 'weekly' | 'monthly',
      today,
    );
    const inPeriod = days.filter((d) => d >= from && d <= to);

    return {
      ...r,
      period_from: from,
      period_to: to,
      period_done: inPeriod.length,
      period_target: r.target_per_period,
      period_met: inPeriod.length >= r.target_per_period,
      checked_today: days.includes(today),
      streak: r.cadence === 'daily' ? currentStreak(days, today) : 0,
      total_days: days.length,
    };
  });

  return ok({ items, today });
});

/** 新增 */
routineRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return err('INVALID_BODY', '请求体必须是 JSON');

  const v = validateRoutine(body);
  if ('error' in v) return err(v.error.code, v.error.message);

  const res = await c.env.DB.prepare(
    'INSERT INTO routine (name, cadence, target_per_period) VALUES (?, ?, ?)',
  )
    .bind(v.value.name, v.value.cadence, v.value.targetPerPeriod)
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM routine WHERE id = ?')
    .bind(res.meta.last_row_id)
    .first();

  return ok(row);
});

/** 修改 */
routineRoutes.put('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const old = await c.env.DB.prepare('SELECT id FROM routine WHERE id = ?')
    .bind(id)
    .first();
  if (!old) return err('NOT_FOUND', '习惯不存在', 404);

  const body = await c.req.json().catch(() => null);
  if (!body) return err('INVALID_BODY', '请求体必须是 JSON');

  const v = validateRoutine(body);
  if ('error' in v) return err(v.error.code, v.error.message);

  // is_active 允许单独切换（不停用只归档）
  const isActive =
    typeof (body as { is_active?: number }).is_active === 'number'
      ? (body as { is_active: number }).is_active
        ? 1
        : 0
      : 1;

  await c.env.DB.prepare(
    `UPDATE routine SET name = ?, cadence = ?, target_per_period = ?, is_active = ?
     WHERE id = ?`,
  )
    .bind(v.value.name, v.value.cadence, v.value.targetPerPeriod, isActive, id)
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM routine WHERE id = ?').bind(id).first();
  return ok(row);
});

/** 停用/启用 */
routineRoutes.patch('/:id/active', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const body = await c.req.json<{ is_active?: number }>().catch(() => null);
  if (!body) return err('INVALID_BODY', '请求体必须是 JSON');

  const old = await c.env.DB.prepare('SELECT id FROM routine WHERE id = ?')
    .bind(id)
    .first();
  if (!old) return err('NOT_FOUND', '习惯不存在', 404);

  await c.env.DB.prepare('UPDATE routine SET is_active = ? WHERE id = ?')
    .bind(body.is_active ? 1 : 0, id)
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM routine WHERE id = ?').bind(id).first();
  return ok(row);
});

/**
 * 打卡。幂等：同一天重复打不会写两行（依赖 UNIQUE 约束）。
 * day 缺省为今天。
 */
routineRoutes.post('/:id/check', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const body = await c.req.json<{ day?: string }>().catch(() => ({ day: undefined }));
  const day = body.day ?? currentDay();

  if (!isValidDay(day)) return err('INVALID_DAY', 'day 格式应为 YYYY-MM-DD');

  const r = await c.env.DB.prepare('SELECT id FROM routine WHERE id = ?')
    .bind(id)
    .first();
  if (!r) return err('NOT_FOUND', '习惯不存在', 404);

  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO routine_log (routine_id, done_day) VALUES (?, ?)',
  )
    .bind(id, day)
    .run();

  return ok({ routine_id: id, day, checked: true });
});

/** 取消打卡 */
routineRoutes.delete('/:id/check', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const day = c.req.query('day') ?? currentDay();
  if (!isValidDay(day)) return err('INVALID_DAY', 'day 格式应为 YYYY-MM-DD');

  await c.env.DB.prepare('DELETE FROM routine_log WHERE routine_id = ? AND done_day = ?')
    .bind(id, day)
    .run();

  return ok({ routine_id: id, day, checked: false });
});

/**
 * 删除习惯。硬删除，连带删掉它的打卡记录。
 *
 * 为什么不像 task/txn 那样软删除：routine 是「定义」不是「流水」，
 * 软删除会让 routine_log 的历史统计越来越难算，而单人场景下误删的代价
 * 可以用「停用」来规避 —— 所以这里提供停用，删除则干脆删干净。
 */
routineRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const r = await c.env.DB.prepare('SELECT id FROM routine WHERE id = ?')
    .bind(id)
    .first();
  if (!r) return err('NOT_FOUND', '习惯不存在', 404);

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM routine_log WHERE routine_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM routine WHERE id = ?').bind(id),
  ]);

  return ok({ deleted: id });
});

/** 某习惯的打卡历史（用于日历视图） */
routineRoutes.get('/:id/logs', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const days = Math.min(Number(c.req.query('days') ?? 90), 365);

  const { results } = await c.env.DB.prepare(
    `SELECT done_day FROM routine_log
     WHERE routine_id = ? AND done_day >= date(?, ?)
     ORDER BY done_day DESC`,
  )
    .bind(id, currentDay(), `-${days - 1} days`)
    .all<{ done_day: string }>();

  return ok({ items: results ?? [] });
});
