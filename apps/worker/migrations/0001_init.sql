-- 0001_init.sql
-- 个人工作台 · 初始 schema
-- 设计原则：单人自用；金额一律用「分」的整数存储，绝不用浮点。

-- ============ 认证 ============
-- 单人单用户：只有一行。password_hash 为 PBKDF2-SHA256 的 base64
CREATE TABLE IF NOT EXISTS user (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  password_salt TEXT    NOT NULL,
  iterations    INTEGER NOT NULL,
  totp_secret   TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 会话：存 token 的 SHA-256，不存原文
CREATE TABLE IF NOT EXISTS session (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES user(id),
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT    NOT NULL,
  last_seen  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_session_expires ON session(expires_at);

-- 登录限流：按 IP 计数
CREATE TABLE IF NOT EXISTS login_attempt (
  ip         TEXT    NOT NULL,
  attempted_at TEXT  NOT NULL DEFAULT (datetime('now')),
  ok         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_login_attempt_ip ON login_attempt(ip, attempted_at);

-- ============ 记账（支出/收入/转账合一）============
-- type: expense | income | transfer
-- 金额单位：分（整数）。transfer 时 amount 为转出金额，to_account_id 为转入账户。
CREATE TABLE IF NOT EXISTS account (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  kind       TEXT    NOT NULL DEFAULT 'cash',  -- cash | bank | credit | ewallet
  balance_cents INTEGER NOT NULL DEFAULT 0,     -- 手动维护的余额（v2.1 才自动联动）
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS category (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT    NOT NULL,
  kind     TEXT    NOT NULL,   -- expense | income
  icon     TEXT,
  sort     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (name, kind)
);

CREATE TABLE IF NOT EXISTS txn (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT    NOT NULL CHECK (type IN ('expense','income','transfer')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  account_id    INTEGER NOT NULL REFERENCES account(id),
  to_account_id INTEGER REFERENCES account(id),
  category_id   INTEGER REFERENCES category(id),
  merchant      TEXT,
  note          TEXT,
  occurred_at   TEXT    NOT NULL,             -- ISO8601
  occurred_day  TEXT    NOT NULL,             -- YYYY-MM-DD，便于按日/月聚合
  occurred_month TEXT   NOT NULL,             -- YYYY-MM，便于月度汇总
  source        TEXT    NOT NULL DEFAULT 'manual', -- manual | share | import
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_txn_day     ON txn(occurred_day);
CREATE INDEX IF NOT EXISTS idx_txn_month   ON txn(occurred_month);
CREATE INDEX IF NOT EXISTS idx_txn_account ON txn(account_id);
CREATE INDEX IF NOT EXISTS idx_txn_alive   ON txn(deleted_at, occurred_at DESC);

-- 月度汇总：写时更新（D1 无物化视图）
CREATE TABLE IF NOT EXISTS monthly_summary (
  month        TEXT NOT NULL,          -- YYYY-MM
  kind         TEXT NOT NULL,          -- expense | income | transfer
  category_id  INTEGER,
  total_cents  INTEGER NOT NULL DEFAULT 0,
  txn_count    INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (month, kind, category_id)
);

-- ============ 运动 ============
CREATE TABLE IF NOT EXISTS workout (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT    NOT NULL,        -- run | walk | cycle | gym | swim | other
  duration_min INTEGER NOT NULL CHECK (duration_min > 0),
  distance_m   INTEGER,
  calories     INTEGER,
  note         TEXT,
  occurred_at  TEXT    NOT NULL,
  occurred_day TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_workout_day ON workout(occurred_day);

-- ============ 视频 AI 学习 ============
-- 系统只存元数据 + 人工粘贴的转写稿，不下载视频、不做 ASR
CREATE TABLE IF NOT EXISTS video_item (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  url          TEXT    NOT NULL,
  platform     TEXT,                    -- bilibili | douyin | other
  title        TEXT,
  author       TEXT,
  duration_sec INTEGER,
  status       TEXT    NOT NULL DEFAULT 'draft', -- draft | transcribed | summarized | archived
  transcript   TEXT,                    -- 人工粘贴
  summary      TEXT,                    -- LLM 生成
  tags         TEXT,                    -- 逗号分隔
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_video_status ON video_item(status, created_at DESC);

-- ============ 计划与任务 ============
CREATE TABLE IF NOT EXISTS task (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  detail      TEXT,
  status      TEXT    NOT NULL DEFAULT 'todo', -- todo | doing | done | dropped
  priority    INTEGER NOT NULL DEFAULT 2,      -- 1 高 2 中 3 低
  due_day     TEXT,
  done_at     TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_status ON task(status, priority, due_day);

-- ============ 日常管理 ============
CREATE TABLE IF NOT EXISTS routine (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  cadence     TEXT    NOT NULL DEFAULT 'daily', -- daily | weekly | monthly
  target_per_period INTEGER NOT NULL DEFAULT 1,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS routine_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id INTEGER NOT NULL REFERENCES routine(id),
  done_day   TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (routine_id, done_day)
);

-- ============ 设置（KV）============
CREATE TABLE IF NOT EXISTS app_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ 种子数据 ============
INSERT OR IGNORE INTO account (name, kind, balance_cents) VALUES ('现金', 'cash', 0);
INSERT OR IGNORE INTO account (name, kind, balance_cents) VALUES ('微信', 'ewallet', 0);
INSERT OR IGNORE INTO account (name, kind, balance_cents) VALUES ('支付宝', 'ewallet', 0);
INSERT OR IGNORE INTO account (name, kind, balance_cents) VALUES ('银行卡', 'bank', 0);

INSERT OR IGNORE INTO category (name, kind, icon, sort) VALUES
  ('餐饮', 'expense', '🍚', 1),
  ('交通', 'expense', '🚇', 2),
  ('购物', 'expense', '🛒', 3),
  ('居住', 'expense', '🏠', 4),
  ('娱乐', 'expense', '🎮', 5),
  ('医疗', 'expense', '💊', 6),
  ('学习', 'expense', '📚', 7),
  ('人情', 'expense', '🎁', 8),
  ('其他', 'expense', '📦', 99),
  ('工资', 'income', '💰', 1),
  ('理财', 'income', '📈', 2),
  ('其他收入', 'income', '🧾', 99);
