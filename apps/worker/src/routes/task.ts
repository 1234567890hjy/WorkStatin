/**
 * 计划与任务。
 *
 * 设计要点：
 * - 表在 `0001_init.sql` 里就建好了（`task`），Dashboard 也早就在返回 `open_tasks`，
 *   但一直没有路由和页面 —— 这是「半成品裸露」，本文件把它补完。
 * - 字段沿用原设计：status 四态、priority 1高/2中/3低、due_day 可空。
 * - 软删除，与 txn / workout / video_item 保持一致。
 * - 状态流转用 PATCH /:id/status，而不是 PUT 整条覆盖：
 *   前端「点一下完成」只需要改一个字段，整条 PUT 容易漏字段把数据写坏。
 */

import { Hono } from 'hono';
import type { Env } from '../types.ts';
import { currentDay } from '../domain/dates.ts';
import {
  TASK_STATUSES,
  validateTask,
  type TaskInput,
  type TaskStatus,
} from '../domain/task.ts';
import { ok, err } from '../http.ts';
import { requireSession } from './auth.ts';

export const taskRoutes = new Hono<{ Bindings: Env }>();

const STATUSES = TASK_STATUSES;
type Status = TaskStatus;

taskRoutes.use('*', async (c, next) => {
  const session = await requireSession(c.env, c.req.raw);
  if (!session) return err('UNAUTHORIZED', '未登录或会话已过期', 401);
  await next();
});

/** 列表：按 status/priority/due_day 过滤 */
taskRoutes.get('/', async (c) => {
  const status = c.req.query('status');
  const due = c.req.query('due'); // today | overdue | upcoming | all
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);

  const where: string[] = ['deleted_at IS NULL'];
  const binds: unknown[] = [];

  if (status) {
    if (!STATUSES.includes(status as Status)) {
      return err('INVALID_STATUS', `status 必须是 ${STATUSES.join('/')}`);
    }
    where.push('status = ?');
    binds.push(status);
  }

  // 默认只看未完成的，避免 done/dropped 越堆越长
  if (!status && !c.req.query('include_closed')) {
    where.push(`status IN ('todo','doing')`);
  }

  const today = currentDay();
  if (due === 'today') {
    where.push('due_day = ?');
    binds.push(today);
  } else if (due === 'overdue') {
    where.push("due_day IS NOT NULL AND due_day < ? AND status IN ('todo','doing')");
    binds.push(today);
  } else if (due === 'upcoming') {
    where.push("due_day IS NOT NULL AND due_day >= ? AND status IN ('todo','doing')");
    binds.push(today);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM task WHERE ${where.join(' AND ')}
     ORDER BY
       CASE WHEN due_day IS NULL THEN 1 ELSE 0 END,
       due_day,
       priority,
       id DESC
     LIMIT ?`,
  )
    .bind(...binds, limit)
    .all();

  return ok({ items: results ?? [], today });
});

/** 详情 */
taskRoutes.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const row = await c.env.DB.prepare(
    'SELECT * FROM task WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(id)
    .first();

  if (!row) return err('NOT_FOUND', '任务不存在', 404);
  return ok(row);
});

/** 新增 */
taskRoutes.post('/', async (c) => {
  const body = await c.req.json<TaskInput>().catch(() => null);
  if (!body) return err('INVALID_BODY', '请求体必须是 JSON');

  const v = validateTask(body);
  if ('error' in v) return err(v.error.code, v.error.message);

  const res = await c.env.DB.prepare(
    `INSERT INTO task (title, detail, status, priority, due_day)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(v.value.title, v.value.detail, v.value.status, v.value.priority, v.value.dueDay)
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM task WHERE id = ?')
    .bind(res.meta.last_row_id)
    .first();

  return ok(row);
});

/** 修改（整条覆盖） */
taskRoutes.put('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const old = await c.env.DB.prepare(
    'SELECT * FROM task WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(id)
    .first<{ id: number; status: string }>();
  if (!old) return err('NOT_FOUND', '任务不存在', 404);

  const body = await c.req.json<TaskInput>().catch(() => null);
  if (!body) return err('INVALID_BODY', '请求体必须是 JSON');

  const v = validateTask(body);
  if ('error' in v) return err(v.error.code, v.error.message);

  await c.env.DB.prepare(
    `UPDATE task SET title = ?, detail = ?, status = ?, priority = ?, due_day = ?,
       done_at = ?, updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(
      v.value.title,
      v.value.detail,
      v.value.status,
      v.value.priority,
      v.value.dueDay,
      // 只有「变成完成」的那一刻记 done_at；从完成改回未完成则清空
      v.value.status === 'done' && old.status !== 'done'
        ? new Date().toISOString()
        : v.value.status === 'done'
          ? (old as { done_at?: string | null }).done_at ?? new Date().toISOString()
          : null,
      id,
    )
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM task WHERE id = ?').bind(id).first();
  return ok(row);
});

/**
 * 只改状态。前端「点一下打勾」走这里。
 * 幂等：重复请求同一状态不会重复写 done_at。
 */
taskRoutes.patch('/:id/status', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const body = await c.req.json<{ status?: string }>().catch(() => null);
  if (!body) return err('INVALID_BODY', '请求体必须是 JSON');

  const status = String(body.status ?? '');
  if (!STATUSES.includes(status as Status)) {
    return err('INVALID_STATUS', `status 必须是 ${STATUSES.join('/')}`);
  }

  const old = await c.env.DB.prepare(
    'SELECT id, status, done_at FROM task WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(id)
    .first<{ id: number; status: string; done_at: string | null }>();
  if (!old) return err('NOT_FOUND', '任务不存在', 404);

  // 已经是目标状态：幂等返回，不动 done_at
  if (old.status === status) {
    const row = await c.env.DB.prepare('SELECT * FROM task WHERE id = ?').bind(id).first();
    return ok(row);
  }

  const doneAt = status === 'done' ? new Date().toISOString() : null;

  await c.env.DB.prepare(
    'UPDATE task SET status = ?, done_at = ?, updated_at = datetime(\'now\') WHERE id = ?',
  )
    .bind(status, doneAt, id)
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM task WHERE id = ?').bind(id).first();
  return ok(row);
});

/** 软删除 */
taskRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const row = await c.env.DB.prepare(
    'SELECT id FROM task WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(id)
    .first();
  if (!row) return err('NOT_FOUND', '任务不存在', 404);

  await c.env.DB.prepare(
    `UPDATE task SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(id)
    .run();

  return ok({ deleted: id });
});
