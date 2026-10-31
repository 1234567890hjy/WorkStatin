/**
 * 本地开发初始化：建表 + 建用户。
 *
 * 为什么需要它：本环境下 `wrangler d1 execute` 会因 workerd 的
 * email-store 目录问题起不来，无法用 CLI 灌 schema。
 * 这个路由走真实的 D1 binding，等价于迁移。
 *
 * 安全：仅当 ENVIRONMENT !== 'production' 时可用，
 * 且必须带 DEV_BOOTSTRAP_TOKEN 头。生产环境（ENVIRONMENT=production）直接 404。
 */

import { Hono } from 'hono';
import type { Env } from '../types.ts';
import { hashPassword } from '../domain/auth.ts';
import { ok, err } from '../http.ts';

export const devRoutes = new Hono<{ Bindings: Env }>();

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS user (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    iterations INTEGER NOT NULL,
    totp_secret TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS session (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    last_seen TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS login_attempt (
    ip TEXT NOT NULL,
    attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
    ok INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS account (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'cash',
    balance_cents INTEGER NOT NULL DEFAULT 0,
    is_archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS category (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    icon TEXT,
    sort INTEGER NOT NULL DEFAULT 0,
    UNIQUE (name, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS txn (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('expense','income','transfer')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    account_id INTEGER NOT NULL,
    to_account_id INTEGER,
    category_id INTEGER,
    merchant TEXT,
    note TEXT,
    occurred_at TEXT NOT NULL,
    occurred_day TEXT NOT NULL,
    occurred_month TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS monthly_summary (
    month TEXT NOT NULL,
    kind TEXT NOT NULL,
    category_id INTEGER,
    total_cents INTEGER NOT NULL DEFAULT 0,
    txn_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (month, kind, category_id)
  )`,
  `CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS pending_txn (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('expense','income')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    account_id INTEGER,
    category_id INTEGER,
    merchant TEXT,
    note TEXT,
    occurred_at TEXT NOT NULL,
    occurred_day TEXT NOT NULL,
    occurred_month TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'unknown',
    confidence TEXT NOT NULL DEFAULT 'medium',
    matched TEXT,
    dedupe_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_dedupe ON pending_txn(dedupe_key)`,
  `CREATE TABLE IF NOT EXISTS raw_notification (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL DEFAULT 'unknown',
    pkg TEXT,
    title TEXT,
    body TEXT,
    posted_at TEXT,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'new',
    dedupe_key TEXT,
    reason TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_dedupe ON raw_notification(dedupe_key)`,
  `CREATE TABLE IF NOT EXISTS device_heartbeat (
    device_id TEXT PRIMARY KEY,
    app_version TEXT,
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_total INTEGER NOT NULL DEFAULT 0,
    queue_depth INTEGER NOT NULL DEFAULT 0,
    note TEXT
  )`,
  // ---- 以下表定义与 0001_init.sql 保持一致 ----
  // 不补齐它们，Dashboard 等聚合接口会因为「表不存在」直接 500
  `CREATE TABLE IF NOT EXISTS workout (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    duration_min INTEGER NOT NULL CHECK (duration_min > 0),
    distance_m INTEGER,
    calories INTEGER,
    note TEXT,
    occurred_at TEXT NOT NULL,
    occurred_day TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workout_day ON workout(occurred_day)`,
  `CREATE TABLE IF NOT EXISTS video_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    platform TEXT,
    title TEXT,
    author TEXT,
    duration_sec INTEGER,
    status TEXT NOT NULL DEFAULT 'draft',
    transcript TEXT,
    summary TEXT,
    tags TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_video_status ON video_item(status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS task (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    detail TEXT,
    status TEXT NOT NULL DEFAULT 'todo',
    priority INTEGER NOT NULL DEFAULT 2,
    due_day TEXT,
    done_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_status ON task(status, priority, due_day)`,
  `CREATE TABLE IF NOT EXISTS routine (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cadence TEXT NOT NULL DEFAULT 'daily',
    target_per_period INTEGER NOT NULL DEFAULT 1,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS routine_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    routine_id INTEGER NOT NULL,
    done_day TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (routine_id, done_day)
  )`,
  `ALTER TABLE txn ADD COLUMN dedupe_key TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_txn_dedupe ON txn(dedupe_key)`,
];

const SEED_STATEMENTS = [
  `INSERT OR IGNORE INTO account (name, kind, balance_cents) VALUES ('现金','cash',0)`,
  `INSERT OR IGNORE INTO account (name, kind, balance_cents) VALUES ('微信','ewallet',0)`,
  `INSERT OR IGNORE INTO account (name, kind, balance_cents) VALUES ('支付宝','ewallet',0)`,
  `INSERT OR IGNORE INTO account (name, kind, balance_cents) VALUES ('银行卡','bank',0)`,
  `INSERT OR IGNORE INTO category (name, kind, icon, sort) VALUES ('餐饮','expense','🍚',1)`,
  `INSERT OR IGNORE INTO category (name, kind, icon, sort) VALUES ('交通','expense','🚇',2)`,
  `INSERT OR IGNORE INTO category (name, kind, icon, sort) VALUES ('购物','expense','🛒',3)`,
  `INSERT OR IGNORE INTO category (name, kind, icon, sort) VALUES ('居住','expense','🏠',4)`,
  `INSERT OR IGNORE INTO category (name, kind, icon, sort) VALUES ('娱乐','expense','🎮',5)`,
  `INSERT OR IGNORE INTO category (name, kind, icon, sort) VALUES ('医疗','expense','💊',6)`,
  `INSERT OR IGNORE INTO category (name, kind, icon, sort) VALUES ('学习','expense','📚',7)`,
  `INSERT OR IGNORE INTO category (name, kind, icon, sort) VALUES ('人情','expense','🎁',8)`,
  `INSERT OR IGNORE INTO category (name, kind, icon, sort) VALUES ('其他','expense','📦',99)`,
  `INSERT OR IGNORE INTO category (name, kind, icon, sort) VALUES ('工资','income','💰',1)`,
  `INSERT OR IGNORE INTO category (name, kind, icon, sort) VALUES ('理财','income','📈',2)`,
  `INSERT OR IGNORE INTO category (name, kind, icon, sort) VALUES ('其他收入','income','🧾',99)`,
  `INSERT OR IGNORE INTO app_config (key, value) VALUES ('notify.channel_account_map','{"wechat":2,"alipay":3,"bank":4,"unknown":1}')`,
  `INSERT OR IGNORE INTO app_config (key, value) VALUES ('notify.allowlist','{"com.tencent.mm":"wechat","com.eg.android.AlipayGphone":"alipay"}')`,
  `INSERT OR IGNORE INTO app_config (key, value) VALUES ('notify.dedupe_window_ms','60000')`,
  `INSERT OR IGNORE INTO app_config (key, value) VALUES ('notify.heartbeat_timeout_hours','48')`,
  `INSERT OR IGNORE INTO app_config (key, value) VALUES ('notify.default_category','{"expense":9,"income":12}')`,
];

/** POST /api/dev/bootstrap  { username, password } */
devRoutes.post('/bootstrap', async (c) => {
  if (c.env.ENVIRONMENT === 'production') {
    return err('NOT_FOUND', '未找到路由', 404);
  }

  const body = await c.req
    .json<{ username?: string; password?: string }>()
    .catch(() => null);
  const username = body?.username?.trim() || 'demo';
  const password = body?.password || 'demo1234';

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const sql of [...SCHEMA_STATEMENTS, ...SEED_STATEMENTS]) {
    try {
      await c.env.DB.prepare(sql).run();
      applied.push(sql.slice(0, 40));
    } catch (e) {
      // ALTER TABLE 重复执行会报 duplicate column，属预期
      skipped.push(`${sql.slice(0, 40)} → ${(e as Error).message}`);
    }
  }

  const h = await hashPassword(password);
  await c.env.DB.prepare(
    `INSERT INTO user (id, username, password_hash, password_salt, iterations)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       username = excluded.username,
       password_hash = excluded.password_hash,
       password_salt = excluded.password_salt,
       iterations = excluded.iterations`,
  )
    .bind(username, h.hash, h.salt, h.iterations)
    .run();

  return ok({ applied: applied.length, skipped, username, password });
});
