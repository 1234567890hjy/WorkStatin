/**
 * 记账路由：支出/收入/转账合一。
 * 所有金额以「分」整数传输。
 */

import { Hono } from 'hono';
import type { Env, TxnRow, TxnType } from '../types.ts';
import { parseYuanToCents } from '../domain/money.ts';
import { normalizeOccurred, isValidDay, isValidMonth, currentMonth } from '../domain/dates.ts';
import { rebuildMonth } from '../db.ts';
import { ok, err } from '../http.ts';
import { requireSession } from './auth.ts';

export const txnRoutes = new Hono<{ Bindings: Env }>();

const VALID_TYPES: TxnType[] = ['expense', 'income', 'transfer'];

interface TxnInput {
  type?: string;
  /** 元，字符串或数字；也接受 amount_cents 直接给分 */
  amount?: string | number;
  amount_cents?: number;
  account_id?: number;
  to_account_id?: number;
  category_id?: number;
  merchant?: string;
  note?: string;
  occurred_at?: string;
  source?: string;
}

/** 统一鉴权 */
txnRoutes.use('*', async (c, next) => {
  const session = await requireSession(c.env, c.req.raw);
  if (!session) return err('UNAUTHORIZED', '未登录或会话已过期', 401);
  await next();
});

/** 列表：按日/月/账户过滤 */
txnRoutes.get('/', async (c) => {
  const month = c.req.query('month');
  const day = c.req.query('day');
  const accountId = c.req.query('account_id');
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);

  const where: string[] = ['t.deleted_at IS NULL'];
  const binds: unknown[] = [];

  if (month) {
    if (!isValidMonth(month)) return err('INVALID_MONTH', 'month 格式应为 YYYY-MM');
    where.push('t.occurred_month = ?');
    binds.push(month);
  }
  if (day) {
    if (!isValidDay(day)) return err('INVALID_DAY', 'day 格式应为 YYYY-MM-DD');
    where.push('t.occurred_day = ?');
    binds.push(day);
  }
  if (accountId) {
    where.push('(t.account_id = ? OR t.to_account_id = ?)');
    binds.push(Number(accountId), Number(accountId));
  }

  const sql = `
    SELECT t.*, a.name AS account_name, ta.name AS to_account_name, c.name AS category_name
    FROM txn t
    LEFT JOIN account a  ON a.id  = t.account_id
    LEFT JOIN account ta ON ta.id = t.to_account_id
    LEFT JOIN category c ON c.id  = t.category_id
    WHERE ${where.join(' AND ')}
    ORDER BY t.occurred_at DESC, t.id DESC
    LIMIT ? OFFSET ?`;

  const { results } = await c.env.DB.prepare(sql)
    .bind(...binds, limit, offset)
    .all();

  return ok({ items: results ?? [], limit, offset });
});

/** 单笔详情 */
txnRoutes.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return err('INVALID_ID', 'id 非法');

  const row = await c.env.DB.prepare(
    `SELECT t.*, a.name AS account_name, c.name AS category_name
     FROM txn t
     LEFT JOIN account a ON a.id = t.account_id
     LEFT JOIN category c ON c.id = t.category_id
     WHERE t.id = ? AND t.deleted_at IS NULL`,
  )
    .bind(id)
    .first();

  if (!row) return err('NOT_FOUND', '记录不存在', 404);
  return ok(row);
});

/** 新增 */
txnRoutes.post('/', async (c) => {
  const body = await c.req.json<TxnInput>().catch(() => null);
  if (!body) return err('INVALID_BODY', '请求体必须是 JSON');

  const parsed = validateInput(body);
  if ('error' in parsed) return err(parsed.error.code, parsed.error.message);

  const v = parsed.value;
  const dates = normalizeOccurred(v.occurredAt);

  const res = await c.env.DB.prepare(
    `INSERT INTO txn
       (type, amount_cents, account_id, to_account_id, category_id,
        merchant, note, occurred_at, occurred_day, occurred_month, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      v.type,
      v.amountCents,
      v.accountId,
      v.toAccountId,
      v.categoryId,
      v.merchant,
      v.note,
      dates.occurredAt,
      dates.occurredDay,
      dates.occurredMonth,
      v.source,
    )
    .run();

  const id = res.meta.last_row_id;
  await rebuildMonth(c.env, dates.occurredMonth);

  const row = await c.env.DB.prepare('SELECT * FROM txn WHERE id = ?').bind(id).first<TxnRow>();
  return ok(row);
});

/** 修改 */
txnRoutes.put('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return err('INVALID_ID', 'id 非法');

  const old = await c.env.DB.prepare(
    'SELECT * FROM txn WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(id)
    .first<TxnRow>();
  if (!old) return err('NOT_FOUND', '记录不存在', 404);

  const body = await c.req.json<TxnInput>().catch(() => null);
  if (!body) return err('INVALID_BODY', '请求体必须是 JSON');

  const parsed = validateInput({ ...toInput(old), ...body });
  if ('error' in parsed) return err(parsed.error.code, parsed.error.message);

  const v = parsed.value;
  const dates = normalizeOccurred(v.occurredAt);

  await c.env.DB.prepare(
    `UPDATE txn SET
       type = ?, amount_cents = ?, account_id = ?, to_account_id = ?, category_id = ?,
       merchant = ?, note = ?, occurred_at = ?, occurred_day = ?, occurred_month = ?,
       source = ?, updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(
      v.type,
      v.amountCents,
      v.accountId,
      v.toAccountId,
      v.categoryId,
      v.merchant,
      v.note,
      dates.occurredAt,
      dates.occurredDay,
      dates.occurredMonth,
      v.source,
      id,
    )
    .run();

  // 跨月移动时两个月都要重算
  await rebuildMonth(c.env, old.occurred_month);
  if (old.occurred_month !== dates.occurredMonth) {
    await rebuildMonth(c.env, dates.occurredMonth);
  }

  const row = await c.env.DB.prepare('SELECT * FROM txn WHERE id = ?').bind(id).first<TxnRow>();
  return ok(row);
});

/** 软删除 */
txnRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return err('INVALID_ID', 'id 非法');

  const old = await c.env.DB.prepare(
    'SELECT * FROM txn WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(id)
    .first<TxnRow>();
  if (!old) return err('NOT_FOUND', '记录不存在', 404);

  await c.env.DB.prepare(`UPDATE txn SET deleted_at = datetime('now') WHERE id = ?`)
    .bind(id)
    .run();

  await rebuildMonth(c.env, old.occurred_month);
  return ok({ deleted: id });
});

/** 月度汇总 */
txnRoutes.get('/stats/monthly', async (c) => {
  const month = c.req.query('month') ?? currentMonth();
  if (!isValidMonth(month)) return err('INVALID_MONTH', 'month 格式应为 YYYY-MM');

  const { results } = await c.env.DB.prepare(
    `SELECT ms.kind, ms.category_id, c.name AS category_name,
            ms.total_cents, ms.txn_count
     FROM monthly_summary ms
     LEFT JOIN category c ON c.id = ms.category_id
     WHERE ms.month = ?
     ORDER BY ms.kind, ms.total_cents DESC`,
  )
    .bind(month)
    .all();

  const rows = results ?? [];
  const sumOf = (kind: string) =>
    rows
      .filter((r) => (r as { kind: string }).kind === kind)
      .reduce((acc, r) => acc + Number((r as { total_cents: number }).total_cents), 0);

  return ok({
    month,
    expense_cents: sumOf('expense'),
    income_cents: sumOf('income'),
    transfer_cents: sumOf('transfer'),
    by_category: rows,
  });
});

// ---------- 校验 ----------

function toInput(row: TxnRow): TxnInput {
  return {
    type: row.type,
    amount_cents: row.amount_cents,
    account_id: row.account_id,
    to_account_id: row.to_account_id ?? undefined,
    category_id: row.category_id ?? undefined,
    merchant: row.merchant ?? undefined,
    note: row.note ?? undefined,
    occurred_at: row.occurred_at,
    source: row.source,
  };
}

interface ValidValue {
  type: TxnType;
  amountCents: number;
  accountId: number;
  toAccountId: number | null;
  categoryId: number | null;
  merchant: string | null;
  note: string | null;
  occurredAt: string | undefined;
  source: string;
}

function validateInput(
  body: TxnInput,
): { value: ValidValue } | { error: { code: string; message: string } } {
  const type = String(body.type ?? '') as TxnType;
  if (!VALID_TYPES.includes(type)) {
    return { error: { code: 'INVALID_TYPE', message: 'type 必须是 expense/income/transfer' } };
  }

  // 金额：优先 amount_cents，其次 amount（元）
  let amountCents: number | null = null;
  if (typeof body.amount_cents === 'number') {
    if (Number.isSafeInteger(body.amount_cents) && body.amount_cents >= 0) {
      amountCents = body.amount_cents;
    }
  } else if (body.amount !== undefined) {
    amountCents = parseYuanToCents(String(body.amount));
  }
  if (amountCents === null) return { error: { code: 'INVALID_AMOUNT', message: '金额非法' } };
  if (amountCents === 0) return { error: { code: 'ZERO_AMOUNT', message: '金额不能为 0' } };

  const accountId = Number(body.account_id);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return { error: { code: 'INVALID_ACCOUNT', message: 'account_id 非法' } };
  }

  let toAccountId: number | null = null;
  if (type === 'transfer') {
    const t = Number(body.to_account_id);
    if (!Number.isInteger(t) || t <= 0) {
      return { error: { code: 'INVALID_TO_ACCOUNT', message: '转账必须指定 to_account_id' } };
    }
    if (t === accountId) {
      return { error: { code: 'SAME_ACCOUNT', message: '转出与转入账户不能相同' } };
    }
    toAccountId = t;
  }

  let categoryId: number | null = null;
  if (body.category_id !== undefined && body.category_id !== null) {
    const cid = Number(body.category_id);
    if (!Number.isInteger(cid) || cid <= 0) {
      return { error: { code: 'INVALID_CATEGORY', message: 'category_id 非法' } };
    }
    categoryId = cid;
  }

  const merchant = cleanText(body.merchant, 64);
  const note = cleanText(body.note, 500);
  const source = cleanText(body.source, 16) ?? 'manual';

  return {
    value: {
      type,
      amountCents,
      accountId,
      toAccountId,
      categoryId,
      merchant,
      note,
      occurredAt: body.occurred_at,
      source,
    },
  };
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}
