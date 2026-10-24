/** 账户与分类：记账的基础数据。 */

import { Hono } from 'hono';
import type { Env } from '../types.ts';
import { validateAccountCreate, validateCategory } from '../domain/meta.ts';
import { ok, err } from '../http.ts';
import { requireSession } from './auth.ts';

export const metaRoutes = new Hono<{ Bindings: Env }>();

// 注意：只对自身路径做鉴权，不能用 use('*') —— 本路由挂载在 /api 上，
// 通配中间件会拦截 /api/dashboard、/api/share 等兄弟路由以及未知路由。
const authMw = async (c: any, next: any) => {
  const session = await requireSession(c.env, c.req.raw);
  if (!session) return err('UNAUTHORIZED', '未登录或会话已过期', 401);
  await next();
};

metaRoutes.use('/accounts', authMw);
metaRoutes.use('/accounts/*', authMw);
metaRoutes.use('/categories', authMw);
metaRoutes.use('/categories/*', authMw);
metaRoutes.use('/net-worth', authMw);

/** 账户列表（含余额） */
metaRoutes.get('/accounts', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM account WHERE is_archived = 0 ORDER BY id',
  ).all();
  return ok({ items: results ?? [] });
});

/** 分类列表 */
metaRoutes.get('/categories', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM category ORDER BY kind, sort, id',
  ).all();
  return ok({ items: results ?? [] });
});

/** 更新账户余额（净资产手动维护，v2.1 才自动联动） */
metaRoutes.put('/accounts/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const body = await c.req
    .json<{ name?: string; balance_cents?: number; is_archived?: number }>()
    .catch(() => null);
  if (!body) return err('INVALID_BODY', '请求体必须是 JSON');

  const sets: string[] = [];
  const binds: unknown[] = [];

  if (typeof body.name === 'string' && body.name.trim()) {
    sets.push('name = ?');
    binds.push(body.name.trim().slice(0, 32));
  }
  if (typeof body.balance_cents === 'number' && Number.isSafeInteger(body.balance_cents)) {
    sets.push('balance_cents = ?');
    binds.push(body.balance_cents);
  }
  if (typeof body.is_archived === 'number') {
    sets.push('is_archived = ?');
    binds.push(body.is_archived ? 1 : 0);
  }
  if (sets.length === 0) return err('NO_CHANGES', '没有可更新的字段');

  binds.push(id);
  await c.env.DB.prepare(`UPDATE account SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM account WHERE id = ?').bind(id).first();
  return ok(row);
});

/** 新增账户 */
metaRoutes.post('/accounts', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return err('INVALID_BODY', '请求体必须是 JSON');

  const v = validateAccountCreate(body);
  if ('error' in v) return err(v.error.code, v.error.message);

  // 账户名唯一（schema 有 UNIQUE 约束），提前查一次给出友好错误
  const dup = await c.env.DB.prepare('SELECT id FROM account WHERE name = ?')
    .bind(v.value.name)
    .first();
  if (dup) return err('DUPLICATE_NAME', '已存在同名账户', 409);

  const res = await c.env.DB.prepare(
    'INSERT INTO account (name, kind, balance_cents, is_archived) VALUES (?, ?, ?, ?)',
  )
    .bind(v.value.name, v.value.kind, v.value.balanceCents, v.value.isArchived)
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM account WHERE id = ?')
    .bind(res.meta.last_row_id)
    .first();

  return ok(row);
});

/** 新增分类 */
metaRoutes.post('/categories', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return err('INVALID_BODY', '请求体必须是 JSON');

  const v = validateCategory(body);
  if ('error' in v) return err(v.error.code, v.error.message);

  // (name, kind) 唯一
  const dup = await c.env.DB.prepare(
    'SELECT id FROM category WHERE name = ? AND kind = ?',
  )
    .bind(v.value.name, v.value.kind)
    .first();
  if (dup) return err('DUPLICATE_NAME', '已存在同名同类型的分类', 409);

  const res = await c.env.DB.prepare(
    'INSERT INTO category (name, kind, icon, sort) VALUES (?, ?, ?, ?)',
  )
    .bind(v.value.name, v.value.kind, v.value.icon, v.value.sort)
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM category WHERE id = ?')
    .bind(res.meta.last_row_id)
    .first();

  return ok(row);
});

/** 修改分类 */
metaRoutes.put('/categories/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const old = await c.env.DB.prepare('SELECT id FROM category WHERE id = ?')
    .bind(id)
    .first();
  if (!old) return err('NOT_FOUND', '分类不存在', 404);

  const body = await c.req.json().catch(() => null);
  if (!body) return err('INVALID_BODY', '请求体必须是 JSON');

  const v = validateCategory(body);
  if ('error' in v) return err(v.error.code, v.error.message);

  const dup = await c.env.DB.prepare(
    'SELECT id FROM category WHERE name = ? AND kind = ? AND id != ?',
  )
    .bind(v.value.name, v.value.kind, id)
    .first();
  if (dup) return err('DUPLICATE_NAME', '已存在同名同类型的分类', 409);

  await c.env.DB.prepare(
    'UPDATE category SET name = ?, kind = ?, icon = ?, sort = ? WHERE id = ?',
  )
    .bind(v.value.name, v.value.kind, v.value.icon, v.value.sort, id)
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM category WHERE id = ?').bind(id).first();
  return ok(row);
});

/**
 * 删除分类。
 *
 * 有流水引用时不能删 —— 会把历史记录的 category_name 变成 null。
 * 正确做法是让用户先新建一个分类、把旧分类的流水改过去，再删。
 */
metaRoutes.delete('/categories/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const cat = await c.env.DB.prepare('SELECT id FROM category WHERE id = ?')
    .bind(id)
    .first();
  if (!cat) return err('NOT_FOUND', '分类不存在', 404);

  const used = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM txn WHERE category_id = ? AND deleted_at IS NULL',
  )
    .bind(id)
    .first<{ n: number }>();

  if ((used?.n ?? 0) > 0) {
    return err(
      'CATEGORY_IN_USE',
      `还有 ${used?.n ?? 0} 笔流水在用这个分类，请先把它们改到别的分类`,
      409,
    );
  }

  await c.env.DB.prepare('DELETE FROM category WHERE id = ?').bind(id).run();
  return ok({ deleted: id });
});

/** 净资产 = 所有未归档账户余额之和 */
metaRoutes.get('/net-worth', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT COALESCE(SUM(balance_cents), 0) AS total FROM account WHERE is_archived = 0',
  ).first<{ total: number }>();
  return ok({ total_cents: row?.total ?? 0 });
});
