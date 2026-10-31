-- 0002_notify.sql
-- 通知自动记账 · schema
--
-- 设计原则（与 0001 一致）：
--   1. 金额一律「分」整数
--   2. 自动采集的账与手动账同表（txn），靠 source='notify' 区分
--   3. 低置信度不污染账本 → 进 pending_txn；解析不出金额 → 进 raw_notification
--
-- 通知里通常没有商户（微信「已支付¥16.88」），所以 merchant 允许为空。

-- ============ 待确认队列 ============
-- 解析成功但置信度不足的记录先落这里；确认后 COPY 进 txn 并删除本行。
-- 独立成表而不是给 txn 加 status 字段：月度汇总不必到处加 status 过滤，
-- 一个漏加就是算错账，风险比多一张表大得多。
CREATE TABLE IF NOT EXISTS pending_txn (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT    NOT NULL CHECK (type IN ('expense','income')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  account_id    INTEGER REFERENCES account(id),
  category_id   INTEGER REFERENCES category(id),
  merchant      TEXT,
  note          TEXT,
  occurred_at   TEXT    NOT NULL,
  occurred_day  TEXT    NOT NULL,
  occurred_month TEXT   NOT NULL,
  -- 渠道标识：wechat / alipay / bank / unknown
  channel       TEXT    NOT NULL DEFAULT 'unknown',
  confidence    TEXT    NOT NULL DEFAULT 'medium', -- medium | low
  -- 命中的原始片段，便于人工核对
  matched       TEXT,
  -- 同一条通知重复上报的幂等键（APK 侧 sbn.key + postTime 的 SHA-256）
  dedupe_key    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pending_created ON pending_txn(created_at DESC);
-- 注意：这里必须是「普通 UNIQUE 约束」而不是部分唯一索引。
-- SQLite 的 INSERT ... ON CONFLICT(dedupe_key) 只认 PRIMARY KEY / UNIQUE 约束，
-- 不认 `CREATE UNIQUE INDEX ... WHERE dedupe_key IS NOT NULL` 这种部分索引。
-- dedupe_key 允许 NULL（NULL 之间互不冲突，符合 SQL 语义）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_dedupe ON pending_txn(dedupe_key);

-- ============ 未识别通知原文 ============
-- 解析不出金额时落这里，与账本完全隔离。
-- Dashboard 显示「有 N 条未识别通知」，点进去可看原文、手动记一笔或忽略。
CREATE TABLE IF NOT EXISTS raw_notification (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel     TEXT    NOT NULL DEFAULT 'unknown',
  pkg         TEXT,                 -- 上报的包名
  title       TEXT,
  body        TEXT,
  posted_at   TEXT,                 -- APK 上报的通知 postTime（ISO8601）
  received_at TEXT    NOT NULL DEFAULT (datetime('now')),
  -- 处理状态：new（待处理）| ignored（用户忽略）| recorded（已手动记账）
  status      TEXT    NOT NULL DEFAULT 'new',
  dedupe_key  TEXT,
  -- 解析失败原因，便于排查模板失配
  reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_status ON raw_notification(status, received_at DESC);
-- 同 pending_txn：普通 UNIQUE 而非部分索引，否则 ON CONFLICT(dedupe_key) 失效
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_dedupe ON raw_notification(dedupe_key);

-- ============ 设备心跳 ============
-- APK 每天发一次；超过 48 小时无心跳则 Dashboard 告警。
-- 单设备场景，用 device_id 区分（换手机时留旧记录无妨）。
CREATE TABLE IF NOT EXISTS device_heartbeat (
  device_id    TEXT PRIMARY KEY,
  app_version  TEXT,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- APK 自报的统计，便于发现「活着但采不到通知」
  sent_total   INTEGER NOT NULL DEFAULT 0,
  queue_depth  INTEGER NOT NULL DEFAULT 0,
  note         TEXT
);

-- ============ 通知自动记账的配置种子 ============
-- 渠道 → 账户映射。值是 account.id，按 0001 的种子顺序：
--   1=现金 2=微信 3=支付宝 4=银行卡
-- 用户可在设置页改。
INSERT OR IGNORE INTO app_config (key, value) VALUES
  ('notify.channel_account_map',
   '{"wechat":2,"alipay":3,"bank":4,"unknown":1}');

-- 采集白名单（服务端下发，APK 执行过滤）。包名 → 渠道。
INSERT OR IGNORE INTO app_config (key, value) VALUES
  ('notify.allowlist',
   '{"com.tencent.mm":"wechat","com.eg.android.AlipayGphone":"alipay"}');

-- 去重时间窗（毫秒）。仅在「双方 merchant 都为空」时生效。
INSERT OR IGNORE INTO app_config (key, value) VALUES
  ('notify.dedupe_window_ms', '60000');

-- 心跳超时阈值（小时）。超过则 Dashboard 告警。
INSERT OR IGNORE INTO app_config (key, value) VALUES
  ('notify.heartbeat_timeout_hours', '48');

-- 自动记账的默认分类（一律先用「其他」）。值是 category.id，按 0001 种子：
--   支出「其他」= 9，收入「其他收入」= 12
INSERT OR IGNORE INTO app_config (key, value) VALUES
  ('notify.default_category',
   '{"expense":9,"income":12}');

-- ============ txn 增加幂等键 ============
-- 没有它就无法区分「同一条通知重发」和「两笔同额真实消费」：
-- 前者应判 duplicate，后者应都记。仅靠金额+时间窗做不到。
ALTER TABLE txn ADD COLUMN dedupe_key TEXT;

-- 同一条通知只允许落库一次（NULL 之间互不冲突，手动记账不受影响）
CREATE UNIQUE INDEX IF NOT EXISTS idx_txn_dedupe ON txn(dedupe_key);

-- txn.source 新增取值 'notify'。0001 里 source 无 CHECK 约束，
-- 注释同步更新（SQLite 不支持改注释，这里仅作说明）：
--   manual | share | import | notify
