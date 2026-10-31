/**
 * 通知自动记账 · 接收端。
 *
 * 链路：
 *   Android APK（NotificationListenerService）
 *     → POST /api/notify/receive   （session 鉴权，复用现有登录）
 *     → 解析 → 去重 → 高置信落 txn / 低置信落 pending_txn / 失败落 raw_notification
 *
 * 关键设计：
 *   1. 绝不静默丢弃 —— 解析失败也落 raw_notification，否则模板失配时
 *      你会以为「一切正常」而实际一笔都没记上。
 *   2. 高置信才自动落库；低置信进待确认，避免污染账本。
 *   3. 所有金额以「分」整数处理，与全仓库一致。
 */

import { Hono } from 'hono';
import type { Env } from '../types.ts';
import { parseNotification } from '../domain/notify-parse.ts';
import type { Channel } from '../domain/notify-parse.ts';
import {
  dedupeVerdict,
  notificationIdentity,
  DEFAULT_DEDUPE_WINDOW_MS,
} from '../domain/notify-dedupe.ts';
import { normalizeOccurred } from '../domain/dates.ts';
import { rebuildMonth } from '../db.ts';
import { ok, err } from '../http.ts';
import { requireSession } from './auth.ts';
import { sha256Hex } from '../domain/auth.ts';

export const notifyRoutes = new Hono<{ Bindings: Env }>();

/** 只对本路由路径鉴权，避免通配中间件拦到兄弟路由。 */
const authMw = async (c: any, next: any) => {
  const session = await requireSession(c.env, c.req.raw);
  if (!session) return err('UNAUTHORIZED', '未登录或会话已过期', 401);
  await next();
};

notifyRoutes.use('/receive', authMw);
notifyRoutes.use('/pending', authMw);
notifyRoutes.use('/pending/*', authMw);
notifyRoutes.use('/raw', authMw);
notifyRoutes.use('/raw/*', authMw);
notifyRoutes.use('/config', authMw);
notifyRoutes.use('/heartbeat', authMw);
notifyRoutes.use('/health', authMw);
notifyRoutes.use('/undo/*', authMw);

// ============ 配置读取 ============

interface NotifyConfig {
  channelAccountMap: Record<string, number>;
  allowlist: Record<string, string>;
  dedupeWindowMs: number;
  heartbeatTimeoutHours: number;
  defaultCategory: { expense: number; income: number };
}

/** 读 app_config 里的 notify.* 键，缺省时回落到默认值。 */
async function loadConfig(env: Env): Promise<NotifyConfig> {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM app_config WHERE key LIKE 'notify.%'`,
  ).all();

  const map = new Map<string, string>();
  for (const r of (results ?? []) as { key: string; value: string }[]) {
    map.set(r.key, r.value);
  }

  const num = (key: string, fallback: number): number => {
    const raw = map.get(key);
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  const json = <T>(key: string, fallback: T): T => {
    const raw = map.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  };

  return {
    channelAccountMap: json('notify.channel_account_map', { unknown: 1 }),
    allowlist: json('notify.allowlist', {}),
    dedupeWindowMs: num('notify.dedupe_window_ms', DEFAULT_DEDUPE_WINDOW_MS),
    heartbeatTimeoutHours: num('notify.heartbeat_timeout_hours', 48),
    defaultCategory: json('notify.default_category', { expense: 9, income: 12 }),
  };
}

/** APK 启动时拉一次：白名单 + 去重窗 + 服务端地址约定。 */
notifyRoutes.get('/config', async (c) => {
  const cfg = await loadConfig(c.env);
  return ok({
    allowlist: cfg.allowlist,
    dedupeWindowMs: cfg.dedupeWindowMs,
    // APK 只用于本地丢弃判断，不需要账户/分类映射（那是服务端的事）
  });
});

/** 设置页改白名单 / 渠道映射 / 去重窗。 */
notifyRoutes.put('/config', async (c) => {
  const body = await c.req
    .json<{
      allowlist?: Record<string, string>;
      channelAccountMap?: Record<string, number>;
      dedupeWindowMs?: number;
      heartbeatTimeoutHours?: number;
      defaultCategory?: { expense: number; income: number };
    }>()
    .catch(() => null);
  if (!body) return err('INVALID_BODY', '请求体必须是 JSON');

  const writes: { key: string; value: string }[] = [];

  if (body.allowlist !== undefined) {
    if (typeof body.allowlist !== 'object' || body.allowlist === null) {
      return err('INVALID_ALLOWLIST', 'allowlist 必须是对象');
    }
    for (const [pkg, ch] of Object.entries(body.allowlist)) {
      if (typeof pkg !== 'string' || !pkg.includes('.')) {
        return err('INVALID_PACKAGE', `包名非法：${pkg}`);
      }
      if (!['wechat', 'alipay', 'bank', 'unknown'].includes(String(ch))) {
        return err('INVALID_CHANNEL', `渠道非法：${ch}`);
      }
    }
    writes.push({ key: 'notify.allowlist', value: JSON.stringify(body.allowlist) });
  }

  if (body.channelAccountMap !== undefined) {
    for (const [ch, id] of Object.entries(body.channelAccountMap)) {
      if (!Number.isInteger(id) || id <= 0) {
        return err('INVALID_ACCOUNT', `渠道 ${ch} 的 account_id 非法`);
      }
    }
    writes.push({
      key: 'notify.channel_account_map',
      value: JSON.stringify(body.channelAccountMap),
    });
  }

  if (body.dedupeWindowMs !== undefined) {
    if (!Number.isInteger(body.dedupeWindowMs) || body.dedupeWindowMs < 0) {
      return err('INVALID_WINDOW', 'dedupeWindowMs 必须是非负整数');
    }
    writes.push({ key: 'notify.dedupe_window_ms', value: String(body.dedupeWindowMs) });
  }

  if (body.heartbeatTimeoutHours !== undefined) {
    if (!Number.isInteger(body.heartbeatTimeoutHours) || body.heartbeatTimeoutHours <= 0) {
      return err('INVALID_TIMEOUT', 'heartbeatTimeoutHours 必须是正整数');
    }
    writes.push({
      key: 'notify.heartbeat_timeout_hours',
      value: String(body.heartbeatTimeoutHours),
    });
  }

  if (body.defaultCategory !== undefined) {
    const d = body.defaultCategory;
    if (!Number.isInteger(d.expense) || !Number.isInteger(d.income)) {
      return err('INVALID_CATEGORY', 'defaultCategory 必须给 expense/income 两个 id');
    }
    writes.push({
      key: 'notify.default_category',
      value: JSON.stringify(d),
    });
  }

  if (writes.length === 0) return err('NO_CHANGES', '没有可更新的字段');

  await c.env.DB.batch(
    writes.map((w) =>
      c.env.DB.prepare(
        `INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      ).bind(w.key, w.value),
    ),
  );

  const cfg = await loadConfig(c.env);
  return ok(cfg);
});

// ============ 接收通知 ============

interface NotifyPayload {
  /** 包名，用于二次校验白名单 */
  pkg?: string;
  title?: string;
  body?: string;
  /** 通知 postTime（毫秒） */
  postTime?: number;
  /** APK 侧生成的设备标识 */
  deviceId?: string;
  appVersion?: string;
}

/**
 * 接收一条通知。
 *
 * 返回 action 说明服务端做了什么，APK 据此决定是否从本地队列删除：
 *   recorded  → 已落库，可删
 *   pending   → 进待确认，可删
 *   raw       → 未识别，可删（原文已存）
 *   duplicate → 重复，可删
 *   rejected  → 白名单外/非法，可删（不该再重试）
 */
notifyRoutes.post('/receive', async (c) => {
  const body = await c.req.json<NotifyPayload>().catch(() => null);
  if (!body) return err('INVALID_BODY', '请求体必须是 JSON');

  const title = typeof body.title === 'string' ? body.title : '';
  const text = typeof body.body === 'string' ? body.body : '';
  if (!title && !text) return err('EMPTY_NOTIFICATION', '标题和正文都为空');

  const cfg = await loadConfig(c.env);

  // 白名单二次校验：手机端已过滤，这里防「APK 被改」或「配置未同步」
  const pkg = typeof body.pkg === 'string' ? body.pkg : null;
  if (pkg && Object.keys(cfg.allowlist).length > 0 && !(pkg in cfg.allowlist)) {
    return ok({ action: 'rejected', reason: 'not_in_allowlist' });
  }

  // 幂等键：同一条通知重发不重复入库
  const identity = notificationIdentity({
    pkg,
    title,
    body: text,
    postTime: body.postTime ?? null,
  });
  const dedupeKey = await sha256Hex(identity);

  const parsed = parseNotification(title, text);

  // ---- 幂等：同一条通知重发直接返回，不参与金额去重 ----
  // 必须放在金额去重之前：否则「同一条通知重发」会被误判成
  // 「新来的更可信 → 替换旧的」，结果旧的被软删、新的插入，账目看起来变了。
  const existingTxn = await c.env.DB.prepare(
    'SELECT id FROM txn WHERE dedupe_key = ? AND deleted_at IS NULL',
  )
    .bind(dedupeKey)
    .first<{ id: number }>();
  if (existingTxn) {
    return ok({ action: 'duplicate', reason: 'same_notification', txn_id: existingTxn.id });
  }

  const existingPending = await c.env.DB.prepare(
    'SELECT id FROM pending_txn WHERE dedupe_key = ?',
  )
    .bind(dedupeKey)
    .first<{ id: number }>();
  if (existingPending) {
    return ok({ action: 'duplicate', reason: 'same_notification', pending_id: existingPending.id });
  }

  // ---- 解析失败：落原文，不丢 ----
  if (!parsed.ok) {
    await c.env.DB.prepare(
      `INSERT INTO raw_notification
         (channel, pkg, title, body, posted_at, status, dedupe_key, reason)
       VALUES (?, ?, ?, ?, ?, 'new', ?, ?)
       ON CONFLICT(dedupe_key) DO NOTHING`,
    )
      .bind(
        detectChannelLoose(title, text),
        pkg,
        title.slice(0, 500),
        text.slice(0, 2000),
        isoFromPostTime(body.postTime),
        dedupeKey,
        parsed.reason,
      )
      .run();

    return ok({ action: 'raw', reason: parsed.reason });
  }

  const r = parsed.result;

  // ---- 时间基准 ----
  // 用户拍板：以服务端接收时间为准，但 postTime 与之偏差超过 5 分钟时
  // 回退到 postTime。这样断网补传的账能落回付款当天，不会跨月记错。
  const nowMs = Date.now();
  const postMs = typeof body.postTime === 'number' ? body.postTime : null;
  const usePost = postMs !== null && Number.isFinite(postMs) && Math.abs(nowMs - postMs) > 5 * 60_000;
  const occurredInput = usePost ? postMs : nowMs;
  const dates = normalizeOccurred(occurredInput);

  // ---- 账户与分类 ----
  const accountId = cfg.channelAccountMap[r.channel] ?? cfg.channelAccountMap['unknown'] ?? null;
  const categoryId = cfg.defaultCategory[r.type] ?? null;

  if (!accountId) {
    // 映射缺失：不该静默失败，落待确认让用户指定账户
    await insertPending(c.env, {
      type: r.type,
      amountCents: r.amountCents,
      accountId: null,
      categoryId,
      merchant: r.merchant,
      occurredAt: dates.occurredAt,
      occurredDay: dates.occurredDay,
      occurredMonth: dates.occurredMonth,
      channel: r.channel,
      confidence: 'medium',
      matched: r.matched,
      dedupeKey,
    });
    return ok({ action: 'pending', reason: 'no_account_mapping' });
  }

  // ---- 去重 ----
  // 匹配条件：金额相同 + 时间窗内 + 双方商户都为空（用户拍板）。
  // 渠道不参与匹配、只参与仲裁 —— 微信与银行的跨渠道重复正是要解决的核心问题。
  // 范围查询放宽到 2×窗口，函数内部再精确校验。
  const sinceIso = new Date(occurredInput - cfg.dedupeWindowMs * 2).toISOString().slice(0, 19);

  // txn 表没有 channel 列，只能靠 source 粗判：notify 来的统一按 bank 处理
  // （宁可判低优先级，让新来的微信通知替换它，而不是反过来）。
  const { results: recentTxn } = await c.env.DB.prepare(
    `SELECT id, amount_cents, merchant, occurred_at, source FROM txn
     WHERE deleted_at IS NULL AND amount_cents = ? AND occurred_at >= ?`,
  )
    .bind(r.amountCents, sinceIso)
    .all();

  const { results: recentPending } = await c.env.DB.prepare(
    `SELECT id, amount_cents, merchant, occurred_at, channel FROM pending_txn
     WHERE amount_cents = ? AND occurred_at >= ?`,
  )
    .bind(r.amountCents, sinceIso)
    .all();

  const existing = [
    ...((recentTxn ?? []) as any[]).map((row) => ({
      id: Number(row.id),
      kind: 'txn' as const,
      channel: (row.source === 'notify' ? 'bank' : 'unknown') as Channel,
      amountCents: Number(row.amount_cents),
      merchant: row.merchant ?? null,
      atMs: Date.parse(row.occurred_at),
    })),
    ...((recentPending ?? []) as any[]).map((row) => ({
      id: Number(row.id),
      kind: 'pending' as const,
      channel: (row.channel ?? 'unknown') as Channel,
      amountCents: Number(row.amount_cents),
      merchant: row.merchant ?? null,
      atMs: Date.parse(row.occurred_at),
    })),
  ].filter((e) => Number.isFinite(e.atMs));

  const verdict = dedupeVerdict(
    {
      channel: r.channel,
      amountCents: r.amountCents,
      merchant: r.merchant,
      atMs: occurredInput,
    },
    existing,
    { windowMs: cfg.dedupeWindowMs },
  );

  if (verdict.kind === 'drop_new') {
    return ok({
      action: 'duplicate',
      amount_cents: r.amountCents,
      channel: r.channel,
      kept: verdict.duplicateOf.channel,
    });
  }

  // 新来的更可信（如微信通知 vs 之前的银行通知）：删掉旧的再继续
  let replaced: { kind: string; id: number } | null = null;
  if (verdict.kind === 'replace_old') {
    const old = verdict.duplicateOf;
    if (old.kind === 'txn') {
      const oldRow = await c.env.DB.prepare(
        `SELECT occurred_month FROM txn WHERE id = ?`,
      )
        .bind(old.id)
        .first<{ occurred_month: string }>();
      await c.env.DB.prepare(
        `UPDATE txn SET deleted_at = datetime('now') WHERE id = ?`,
      )
        .bind(old.id)
        .run();
      if (oldRow?.occurred_month) await rebuildMonth(c.env, oldRow.occurred_month);
    } else {
      await c.env.DB.prepare('DELETE FROM pending_txn WHERE id = ?').bind(old.id).run();
    }
    replaced = { kind: old.kind, id: old.id };
  }

  // ---- 高置信：直接落库 ----
  if (r.confidence === 'high') {
    const res = await c.env.DB.prepare(
      `INSERT INTO txn
         (type, amount_cents, account_id, category_id, merchant, note,
          occurred_at, occurred_day, occurred_month, source, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'notify', ?)`,
    )
      .bind(
        r.type,
        r.amountCents,
        accountId,
        categoryId,
        r.merchant,
        // 商户为空时把命中片段留在 note，便于事后回忆「这笔花在哪」
        r.merchant ? null : `自动记账：${r.matched}`.slice(0, 200),
        dates.occurredAt,
        dates.occurredDay,
        dates.occurredMonth,
        dedupeKey,
      )
      .run();

    await rebuildMonth(c.env, dates.occurredMonth);

    return ok({
      action: 'recorded',
      txn_id: res.meta.last_row_id,
      type: r.type,
      amount_cents: r.amountCents,
      merchant: r.merchant,
      channel: r.channel,
      occurred_at: dates.occurredAt,
      replaced,
      // 前端据此在 5 分钟内提供「撤销」
      undo_window_ms: 5 * 60_000,
    });
  }

  // ---- 低置信：进待确认 ----
  await insertPending(c.env, {
    type: r.type,
    amountCents: r.amountCents,
    accountId,
    categoryId,
    merchant: r.merchant,
    occurredAt: dates.occurredAt,
    occurredDay: dates.occurredDay,
    occurredMonth: dates.occurredMonth,
    channel: r.channel,
    confidence: r.confidence,
    matched: r.matched,
    dedupeKey,
  });

  return ok({ action: 'pending', amount_cents: r.amountCents, confidence: r.confidence });
});

// ============ 待确认队列 ============

notifyRoutes.get('/pending', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
  const { results } = await c.env.DB.prepare(
    `SELECT p.*, a.name AS account_name, cat.name AS category_name
     FROM pending_txn p
     LEFT JOIN account a ON a.id = p.account_id
     LEFT JOIN category cat ON cat.id = p.category_id
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all();

  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM pending_txn').first<{ n: number }>();
  return ok({ items: results ?? [], total: count?.n ?? 0 });
});

/** 确认一笔：COPY 进 txn 并删除 pending 行。 */
notifyRoutes.post('/pending/:id/confirm', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const row = await c.env.DB.prepare('SELECT * FROM pending_txn WHERE id = ?').bind(id).first<any>();
  if (!row) return err('NOT_FOUND', '待确认记录不存在', 404);

  // 允许确认时覆盖字段（用户可能顺手改了账户/分类/金额）
  const body = await c.req
    .json<{ account_id?: number; category_id?: number; amount_cents?: number; merchant?: string }>()
    .catch(() => null);

  const accountId = body?.account_id ?? row.account_id;
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return err('INVALID_ACCOUNT', '请指定账户');
  }

  const amountCents =
    typeof body?.amount_cents === 'number' ? body.amount_cents : Number(row.amount_cents);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return err('INVALID_AMOUNT', '金额非法');
  }

  const categoryId = body?.category_id ?? row.category_id ?? null;
  const merchant = body?.merchant !== undefined ? body.merchant : row.merchant;

  const res = await c.env.DB.prepare(
    `INSERT INTO txn
       (type, amount_cents, account_id, category_id, merchant, note,
        occurred_at, occurred_day, occurred_month, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'notify')`,
  )
    .bind(
      row.type,
      amountCents,
      accountId,
      categoryId,
      merchant,
      `待确认转正：${String(row.matched ?? '').slice(0, 200)}`,
      row.occurred_at,
      row.occurred_day,
      row.occurred_month,
    )
    .run();

  await c.env.DB.prepare('DELETE FROM pending_txn WHERE id = ?').bind(id).run();
  await rebuildMonth(c.env, row.occurred_month);

  return ok({ txn_id: res.meta.last_row_id, from_pending: id });
});

/** 忽略一笔：直接删除。 */
notifyRoutes.delete('/pending/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const row = await c.env.DB.prepare('SELECT id FROM pending_txn WHERE id = ?').bind(id).first();
  if (!row) return err('NOT_FOUND', '待确认记录不存在', 404);

  await c.env.DB.prepare('DELETE FROM pending_txn WHERE id = ?').bind(id).run();
  return ok({ deleted: id });
});

// ============ 未识别通知原文 ============

notifyRoutes.get('/raw', async (c) => {
  const status = c.req.query('status') ?? 'new';
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM raw_notification WHERE status = ?
     ORDER BY received_at DESC, id DESC LIMIT ?`,
  )
    .bind(status, limit)
    .all();

  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM raw_notification WHERE status = 'new'`,
  ).first<{ n: number }>();

  return ok({ items: results ?? [], new_count: count?.n ?? 0 });
});

/** 标记忽略（不记账）。 */
notifyRoutes.post('/raw/:id/ignore', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const row = await c.env.DB.prepare('SELECT id FROM raw_notification WHERE id = ?')
    .bind(id)
    .first();
  if (!row) return err('NOT_FOUND', '记录不存在', 404);

  await c.env.DB.prepare(`UPDATE raw_notification SET status = 'ignored' WHERE id = ?`)
    .bind(id)
    .run();
  return ok({ ignored: id });
});

// ============ 心跳 ============

notifyRoutes.post('/heartbeat', async (c) => {
  const body = await c.req
    .json<{
      deviceId?: string;
      appVersion?: string;
      sentTotal?: number;
      queueDepth?: number;
      note?: string;
    }>()
    .catch(() => null);

  const deviceId = body?.deviceId?.trim() || 'default';

  await c.env.DB.prepare(
    `INSERT INTO device_heartbeat
       (device_id, app_version, last_seen_at, sent_total, queue_depth, note)
     VALUES (?, ?, datetime('now'), ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       app_version  = excluded.app_version,
       last_seen_at = datetime('now'),
       sent_total   = excluded.sent_total,
       queue_depth  = excluded.queue_depth,
       note         = excluded.note`,
  )
    .bind(
      deviceId,
      body?.appVersion ?? null,
      Number.isInteger(body?.sentTotal) ? body!.sentTotal : 0,
      Number.isInteger(body?.queueDepth) ? body!.queueDepth : 0,
      body?.note ?? null,
    )
    .run();

  return ok({ device_id: deviceId, ok: true });
});

/**
 * 采集链路健康度。
 * Dashboard 据此显示「通知采集可能已断开」。
 */
notifyRoutes.get('/health', async (c) => {
  const cfg = await loadConfig(c.env);

  const beat = await c.env.DB.prepare(
    `SELECT device_id, last_seen_at, sent_total, queue_depth, app_version
     FROM device_heartbeat ORDER BY last_seen_at DESC LIMIT 1`,
  ).first<any>();

  const lastTxn = await c.env.DB.prepare(
    `SELECT MAX(created_at) AS last_at, COUNT(*) AS n FROM txn
     WHERE source = 'notify' AND deleted_at IS NULL`,
  ).first<{ last_at: string | null; n: number }>();

  const pendingCount = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM pending_txn',
  ).first<{ n: number }>();

  const rawCount = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM raw_notification WHERE status = 'new'`,
  ).first<{ n: number }>();

  let heartbeatAgeHours: number | null = null;
  let healthy = true;
  let warning: string | null = null;

  if (!beat) {
    healthy = false;
    warning = '从未收到设备心跳，通知采集可能未配置';
  } else {
    const lastMs = Date.parse(String(beat.last_seen_at).replace(' ', 'T') + 'Z');
    if (Number.isFinite(lastMs)) {
      heartbeatAgeHours = Math.round(((Date.now() - lastMs) / 3_600_000) * 10) / 10;
      if (heartbeatAgeHours > cfg.heartbeatTimeoutHours) {
        healthy = false;
        warning = `已 ${heartbeatAgeHours} 小时无心跳（阈值 ${cfg.heartbeatTimeoutHours} 小时），通知采集可能已断开`;
      }
    }
  }

  return ok({
    healthy,
    warning,
    heartbeat_age_hours: heartbeatAgeHours,
    heartbeat_timeout_hours: cfg.heartbeatTimeoutHours,
    device: beat ?? null,
    last_notify_txn_at: lastTxn?.last_at ?? null,
    notify_txn_total: lastTxn?.n ?? 0,
    pending_count: pendingCount?.n ?? 0,
    raw_new_count: rawCount?.n ?? 0,
  });
});

// ============ 撤销 ============

/** 撤销窗口：高置信度自动记账后 5 分钟内可一键撤销。 */
const UNDO_WINDOW_MS = 5 * 60_000;

/**
 * 撤销一笔自动记账。
 *
 * 为什么不用通用的 DELETE /txns/:id：
 *   那个接口能删任何记录、任何时候。撤销是「刚记错了」的快捷操作，
 *   应该严格限制在「5 分钟内 + source=notify」，
 *   超出窗口就该去账单列表里正常删除（并承担看清楚的责任）。
 */
notifyRoutes.post('/undo/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const row = await c.env.DB.prepare(
    `SELECT id, source, occurred_month, created_at FROM txn
     WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<{ id: number; source: string; occurred_month: string; created_at: string }>();

  if (!row) return err('NOT_FOUND', '记录不存在', 404);

  if (row.source !== 'notify') {
    return err('NOT_AUTO', '只能撤销自动记账的记录', 409);
  }

  // created_at 是 UTC 的 'YYYY-MM-DD HH:MM:SS'
  const createdMs = Date.parse(String(row.created_at).replace(' ', 'T') + 'Z');
  if (Number.isFinite(createdMs) && Date.now() - createdMs > UNDO_WINDOW_MS) {
    return err(
      'UNDO_EXPIRED',
      '已超过 5 分钟撤销窗口，请到账单列表删除',
      409,
    );
  }

  await c.env.DB.prepare(
    `UPDATE txn SET deleted_at = datetime('now') WHERE id = ?`,
  )
    .bind(id)
    .run();

  await rebuildMonth(c.env, row.occurred_month);

  return ok({ undone: id, month: row.occurred_month });
});

// ============ 内部工具 ============

function isoFromPostTime(postTime: unknown): string | null {
  if (typeof postTime !== 'number' || !Number.isFinite(postTime)) return null;
  return normalizeOccurred(postTime).occurredAt;
}

/**
 * 解析失败时也要给 channel 一个大致判断，方便在原文列表里分类展示。
 * 这里不追求准确 —— 反正没解析出金额。
 */
function detectChannelLoose(title: string, body: string): string {
  const t = `${title} ${body}`;
  if (/微信/.test(t)) return 'wechat';
  if (/支付宝/.test(t)) return 'alipay';
  if (/银行|尾号|储蓄卡|信用卡/.test(t)) return 'bank';
  return 'unknown';
}

/** txn.source 到 channel 的粗映射已不需要：去重时统一按 bank 处理。 */

interface PendingInsert {
  type: string;
  amountCents: number;
  accountId: number | null;
  categoryId: number | null;
  merchant: string | null;
  occurredAt: string;
  occurredDay: string;
  occurredMonth: string;
  channel: string;
  confidence: string;
  matched: string;
  dedupeKey: string;
}

async function insertPending(env: Env, p: PendingInsert): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pending_txn
       (type, amount_cents, account_id, category_id, merchant, note,
        occurred_at, occurred_day, occurred_month, channel, confidence, matched, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`,
  )
    .bind(
      p.type,
      p.amountCents,
      p.accountId,
      p.categoryId,
      p.merchant,
      null,
      p.occurredAt,
      p.occurredDay,
      p.occurredMonth,
      p.channel,
      p.confidence,
      p.matched.slice(0, 200),
      p.dedupeKey,
    )
    .run();
}
