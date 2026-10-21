/**
 * 认证路由：初始化 / 登录 / 登出 / 当前用户。
 *
 * 单人单用户：第一次访问 /api/auth/setup 时创建唯一的账号，
 * 之后 setup 永久关闭（已存在用户则 409）。
 */

import { Hono } from 'hono';
import type { Env, SessionRow, UserRow } from '../types.ts';
import { hashPassword, verifyPassword, randomToken, sha256Hex } from '../domain/auth.ts';
import { expiryFromNow } from '../domain/dates.ts';
import { ok, err, readToken, clientIp } from '../http.ts';

const SESSION_DAYS = 30;
const MAX_FAILED_PER_HOUR = 10;

export const authRoutes = new Hono<{ Bindings: Env }>();

/** 是否已完成初始化 */
authRoutes.get('/status', async (c) => {
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM user').first<{ n: number }>();
  const initialized = (row?.n ?? 0) > 0;
  return ok({ initialized });
});

/** 首次创建账号 */
authRoutes.post('/setup', async (c) => {
  const existing = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM user').first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) return err('ALREADY_INITIALIZED', '账号已初始化，请直接登录', 409);

  const body = await c.req.json<{ username?: string; password?: string }>().catch(() => null);
  const username = (body?.username ?? '').trim();
  const password = body?.password ?? '';

  if (!/^[A-Za-z0-9_\u4e00-\u9fa5]{2,32}$/.test(username)) {
    return err('INVALID_USERNAME', '用户名 2~32 位，仅字母/数字/下划线/中文');
  }
  if (password.length < 8) return err('WEAK_PASSWORD', '口令至少 8 位');

  const { hash, salt, iterations } = await hashPassword(password);
  await c.env.DB.prepare(
    `INSERT INTO user (id, username, password_hash, password_salt, iterations)
     VALUES (1, ?, ?, ?, ?)`,
  )
    .bind(username, hash, salt, iterations)
    .run();

  const token = await issueSession(c.env, 1);
  return ok({ token, username });
});

/** 登录 */
authRoutes.post('/login', async (c) => {
  const ip = clientIp(c.req.raw);

  // 限流：一小时内同一 IP 失败次数
  const fails = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM login_attempt
     WHERE ip = ? AND ok = 0 AND attempted_at > datetime('now', '-1 hour')`,
  )
    .bind(ip)
    .first<{ n: number }>();

  if ((fails?.n ?? 0) >= MAX_FAILED_PER_HOUR) {
    return err('TOO_MANY_ATTEMPTS', '尝试过于频繁，请一小时后再试', 429);
  }

  const body = await c.req.json<{ username?: string; password?: string }>().catch(() => null);
  const username = (body?.username ?? '').trim();
  const password = body?.password ?? '';

  const user = await c.env.DB.prepare('SELECT * FROM user WHERE username = ?')
    .bind(username)
    .first<UserRow>();

  const passed =
    user !== null &&
    (await verifyPassword(password, user.password_hash, user.password_salt, user.iterations));

  await c.env.DB.prepare('INSERT INTO login_attempt (ip, ok) VALUES (?, ?)')
    .bind(ip, passed ? 1 : 0)
    .run();

  if (!passed || !user) return err('BAD_CREDENTIALS', '用户名或口令不正确', 401);

  const token = await issueSession(c.env, user.id);
  return ok({ token, username: user.username });
});

/** 登出：删除当前会话 */
authRoutes.post('/logout', async (c) => {
  const token = readToken(c.req.raw);
  if (token) {
    const h = await sha256Hex(token);
    await c.env.DB.prepare('DELETE FROM session WHERE token_hash = ?').bind(h).run();
  }
  return ok({ loggedOut: true });
});

/** 当前用户 */
authRoutes.get('/me', async (c) => {
  const session = await requireSession(c.env, c.req.raw);
  if (!session) return err('UNAUTHORIZED', '未登录或会话已过期', 401);

  const user = await c.env.DB.prepare('SELECT username FROM user WHERE id = ?')
    .bind(session.user_id)
    .first<{ username: string }>();

  return ok({ username: user?.username ?? null });
});

// ---------- 内部工具 ----------

async function issueSession(env: Env, userId: number): Promise<string> {
  const token = randomToken();
  const hash = await sha256Hex(token);
  await env.DB.prepare(
    'INSERT INTO session (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
  )
    .bind(hash, userId, expiryFromNow(SESSION_DAYS))
    .run();
  return token;
}

export async function requireSession(env: Env, req: Request): Promise<SessionRow | null> {
  const token = readToken(req);
  if (!token) return null;
  const hash = await sha256Hex(token);

  const row = await env.DB.prepare(
    `SELECT * FROM session WHERE token_hash = ? AND expires_at > datetime('now')`,
  )
    .bind(hash)
    .first<SessionRow>();

  if (!row) return null;

  // 顺手清理过期会话（低频，成本可忽略）
  await env.DB.prepare(`DELETE FROM session WHERE expires_at <= datetime('now')`).run();
  return row;
}
