/** 账户与分类：记账的基础数据。 */

import { Hono } from 'hono';
import type { Env } from '../types.ts';
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

/** 净资产 = 所有未归档账户余额之和 */
metaRoutes.get('/net-worth', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT COALESCE(SUM(balance_cents), 0) AS total FROM account WHERE is_archived = 0',
  ).first<{ total: number }>();
  return ok({ total_cents: row?.total ?? 0 });
});
