/**
 * 数据库辅助层。
 *
 * monthly_summary 的维护策略：D1 没有物化视图，
 * 每次写事务后按「受影响的月份」整体重算该月的汇总。
 * 单人单月几百行，重算是毫秒级，换来的是「永远不会算错」。
 */

import type { Env } from './types.ts';

/** 重算某个月的月度汇总（写时更新）。 */
export async function rebuildMonth(env: Env, month: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM monthly_summary WHERE month = ?').bind(month),
    env.DB.prepare(
      `INSERT INTO monthly_summary (month, kind, category_id, total_cents, txn_count, updated_at)
       SELECT occurred_month, type, category_id, SUM(amount_cents), COUNT(*), datetime('now')
       FROM txn
       WHERE deleted_at IS NULL AND occurred_month = ?
       GROUP BY occurred_month, type, category_id`,
    ).bind(month),
  ]);
}

/** 批量重算多个月份（去重）。 */
export async function rebuildMonths(env: Env, months: Iterable<string>): Promise<void> {
  const uniq = [...new Set(months)].filter(Boolean);
  for (const m of uniq) await rebuildMonth(env, m);
}
