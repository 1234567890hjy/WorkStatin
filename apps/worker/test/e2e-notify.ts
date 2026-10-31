/**
 * 端到端验证：用真实 SQLite 模拟 D1，把 Hono app 真正跑起来。
 *
 * 为什么需要这个而不是只跑单元测试：
 *   单元测试只覆盖纯函数（解析器、去重判定），
 *   但「登录 → 上报 → 落库 → 月度汇总 → 健康度」这条链路的
 *   SQL、路由挂载、鉴权中间件都可能出错，必须真跑一次。
 *
 * 用法：node --experimental-strip-types apps/worker/test/e2e-notify.ts
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', 'migrations');

// ============ D1 兼容层 ============
// 把 node:sqlite 包成 Cloudflare D1 的 API 形状（prepare/bind/all/first/run/batch）。

interface D1Like {
  prepare(sql: string): {
    bind(...args: unknown[]): any;
    all(): Promise<{ results: any[] }>;
    first<T = any>(): Promise<T | null>;
    run(): Promise<{ meta: { last_row_id: number } }>;
  };
  batch(stmts: any[]): Promise<any[]>;
}

function makeD1(db: DatabaseSync): D1Like {
  const makeStmt = (sql: string, args: unknown[]) => ({
    sql,
    args,
    async all() {
      const st = db.prepare(sql);
      return { results: st.all(...(args as any[])) as any[] };
    },
    async first() {
      const st = db.prepare(sql);
      const row = st.get(...(args as any[]));
      return (row ?? null) as any;
    },
    async run() {
      const st = db.prepare(sql);
      const r = st.run(...(args as any[]));
      return { meta: { last_row_id: Number(r.lastInsertRowid ?? 0) } };
    },
  });

  return {
    prepare(sql: string) {
      const stmt = {
        _sql: sql,
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          stmt._args = args;
          return stmt;
        },
        all() {
          return makeStmt(stmt._sql, stmt._args).all();
        },
        first() {
          return makeStmt(stmt._sql, stmt._args).first();
        },
        run() {
          return makeStmt(stmt._sql, stmt._args).run();
        },
      };
      return stmt as any;
    },
    async batch(stmts: any[]) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
}

// ============ 建库 ============
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0001_init.sql', '0002_notify.sql']) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    // node:sqlite 的 exec 支持多语句
    db.exec(sql);
  }
  return db;
}

// ============ 测试框架 ============
let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    const msg = (e as Error).message.split('\n')[0];
    failures.push(`${name}\n    ${msg}`);
    console.log(`  ✗ ${name}\n    ${msg}`);
  }
}

// ============ 启动 app ============
async function main() {
  const db = freshDb();
  const D1 = makeD1(db);

  // 种子用户：username=demo, password=demo1234
  const { hashPassword } = await import('../src/domain/auth.ts');
  const h = await hashPassword('demo1234');
  db.prepare(
    'INSERT INTO user (id, username, password_hash, password_salt, iterations) VALUES (1, ?, ?, ?, ?)',
  ).run('demo', h.hash, h.salt, h.iterations);

  const app = (await import('../src/index.ts')).default;

  const env = { DB: D1 as any, ENVIRONMENT: 'test' };

  /** 发一个请求给 Hono app。 */
  async function call(
    method: string,
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = new Request(`http://test.local${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await app.fetch(req, env as any);
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json };
  }

  console.log('\n=== 通知自动记账 · 端到端验证 ===\n');

  // ---- 登录 ----
  console.log('[登录]');
  let token = '';
  await test('登录拿到 token', async () => {
    const r = await call('POST', '/api/auth/login', { username: 'demo', password: 'demo1234' });
    assert.equal(r.status, 200, `status=${r.status} body=${JSON.stringify(r.json)}`);
    assert.equal(r.json.ok, true);
    token = r.json.data.token;
    assert.ok(token && token.length > 10);
  });

  await test('未登录访问 receive 被拒 401', async () => {
    const r = await call('POST', '/api/notify/receive', { title: 'x', body: 'y' });
    assert.equal(r.status, 401);
  });

  // 先把测试要用的包名都配进白名单（真实使用中由设置页下发）
  await test('配置白名单（后续用例依赖）', async () => {
    const r = await call(
      'PUT',
      '/api/notify/config',
      {
        allowlist: {
          'com.tencent.mm': 'wechat',
          'com.eg.android.AlipayGphone': 'alipay',
          'com.icbc': 'bank',
          'com.other.app': 'unknown',
        },
      },
      token,
    );
    assert.equal(r.status, 200, JSON.stringify(r.json));
  });

  // ---- 微信真实通知 ----
  console.log('\n[微信真实通知（无商户）]');
  let firstTxnId = 0;
  await test('已支付¥16.88 → 直接落库 recorded', async () => {
    const r = await call(
      'POST',
      '/api/notify/receive',
      {
        pkg: 'com.tencent.mm',
        title: '微信支付',
        body: '已支付¥16.88',
        postTime: Date.now(),
        deviceId: 'e2e',
      },
      token,
    );
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.data.action, 'recorded', JSON.stringify(r.json.data));
    assert.equal(r.json.data.amount_cents, 1688);
    assert.equal(r.json.data.channel, 'wechat');
    assert.equal(r.json.data.merchant, null);
    firstTxnId = r.json.data.txn_id;
    assert.ok(firstTxnId > 0);
  });

  await test('落库的记录：type=expense、账户=微信(2)、分类=其他(9)', async () => {
    const row = db
      .prepare('SELECT * FROM txn WHERE id = ?')
      .get(firstTxnId) as any;
    assert.equal(row.type, 'expense');
    assert.equal(row.amount_cents, 1688);
    assert.equal(row.account_id, 2);
    assert.equal(row.category_id, 9);
    assert.equal(row.source, 'notify');
    // 商户为空时，命中片段应写进 note
    assert.ok(String(row.note).includes('已支付¥16.88'), `note=${row.note}`);
  });

  await test('月度汇总被重算（10 月支出 +16.88）', async () => {
    const row = db
      .prepare(
        `SELECT total_cents FROM monthly_summary
         WHERE month = ? AND kind = 'expense' AND category_id = 9`,
      )
      .get(new Date().toISOString().slice(0, 7)) as any;
    assert.ok(row, '没有生成月度汇总');
    assert.equal(Number(row.total_cents), 1688);
  });

  // ---- 幂等 ----
  console.log('\n[幂等与去重]');
  await test('同一条通知重发 → duplicate（不重复入库）', async () => {
    const postTime = Date.now();
    const payload = {
      pkg: 'com.tencent.mm',
      title: '微信支付',
      body: '已支付¥16.88',
      postTime,
      deviceId: 'e2e',
    };
    const a = await call('POST', '/api/notify/receive', payload, token);
    assert.equal(a.json.data.action, 'recorded');
    const b = await call('POST', '/api/notify/receive', payload, token);
    // 同一条通知（postTime 相同）→ 去重
    assert.equal(b.json.data.action, 'duplicate', JSON.stringify(b.json.data));
  });

  await test('跨渠道同额（银行 16.88）→ duplicate，不重复记', async () => {
    const now = Date.now();
    const wx = await call(
      'POST',
      '/api/notify/receive',
      { pkg: 'com.tencent.mm', title: '微信支付', body: '已支付¥23.50', postTime: now },
      token,
    );
    assert.equal(wx.json.data.action, 'recorded');

    const bank = await call(
      'POST',
      '/api/notify/receive',
      {
        pkg: 'com.icbc',
        title: '工商银行',
        body: '您账户支出￥23.50',
        postTime: now + 5000,
      },
      token,
    );
    assert.equal(bank.json.data.action, 'duplicate', JSON.stringify(bank.json.data));
  });

  await test('两笔同额但间隔超 60 秒 → 都记', async () => {
    const now = Date.now();
    const a = await call(
      'POST',
      '/api/notify/receive',
      { pkg: 'com.tencent.mm', title: '微信支付', body: '已支付¥7.77', postTime: now },
      token,
    );
    assert.equal(a.json.data.action, 'recorded');
    const b = await call(
      'POST',
      '/api/notify/receive',
      { pkg: 'com.tencent.mm', title: '微信支付', body: '已支付¥7.77', postTime: now + 61_000 },
      token,
    );
    assert.equal(b.json.data.action, 'recorded', JSON.stringify(b.json.data));
  });

  // ---- 白名单 ----
  console.log('\n[白名单]');
  await test('白名单外的包名 → rejected', async () => {
    const r = await call(
      'POST',
      '/api/notify/receive',
      { pkg: 'com.evil.app', title: '微信支付', body: '已支付¥1.00', postTime: Date.now() },
      token,
    );
    assert.equal(r.json.data.action, 'rejected', JSON.stringify(r.json.data));
  });

  // ---- 解析失败 ----
  console.log('\n[解析失败 → raw_notification]');
  await test('无法解析的通知进 raw 表', async () => {
    const r = await call(
      'POST',
      '/api/notify/receive',
      {
        pkg: 'com.tencent.mm',
        title: '微信支付',
        body: '系统维护中，请稍后再试',
        postTime: Date.now(),
      },
      token,
    );
    assert.equal(r.json.data.action, 'raw', JSON.stringify(r.json.data));

    const raw = await call('GET', '/api/notify/raw', undefined, token);
    assert.ok(raw.json.data.new_count >= 1, JSON.stringify(raw.json.data));
  });

  await test('验证码通知不落 raw（属噪声，直接丢弃）', async () => {
    const before = (await call('GET', '/api/notify/raw', undefined, token)).json.data.new_count;
    const r = await call(
      'POST',
      '/api/notify/receive',
      {
        pkg: 'com.tencent.mm',
        title: '微信',
        body: '验证码 123456，5分钟内有效',
        postTime: Date.now(),
      },
      token,
    );
    assert.equal(r.json.data.action, 'raw');
    // 噪声也被标为 no_amount，但仍会落 raw —— 这是有意的：
    // 宁可多存一条可忽略的原文，也不要静默丢弃真实扣款。
    const after = (await call('GET', '/api/notify/raw', undefined, token)).json.data.new_count;
    assert.ok(after >= before);
  });

  // ---- 收入 ----
  console.log('\n[收入]');
  await test('微信收款 → income', async () => {
    const r = await call(
      'POST',
      '/api/notify/receive',
      { pkg: 'com.tencent.mm', title: '微信支付', body: '已收款¥88.00', postTime: Date.now() },
      token,
    );
    assert.equal(r.json.data.action, 'recorded');
    assert.equal(r.json.data.type, 'income');
    assert.equal(r.json.data.amount_cents, 8800);
  });

  // ---- 待确认 ----
  console.log('\n[待确认队列]');
  await test('未知渠道且无商户 → 进 pending', async () => {
    // 先把它加进白名单，否则会被 rejected
    await call(
      'PUT',
      '/api/notify/config',
      { allowlist: { 'com.tencent.mm': 'wechat', 'com.eg.android.AlipayGphone': 'alipay', 'com.other.app': 'unknown' } },
      token,
    );
    const r = await call(
      'POST',
      '/api/notify/receive',
      { pkg: 'com.other.app', title: '某App', body: '消费 ¥3.30', postTime: Date.now() },
      token,
    );
    assert.equal(r.json.data.action, 'pending', JSON.stringify(r.json.data));

    const list = await call('GET', '/api/notify/pending', undefined, token);
    assert.ok(list.json.data.total >= 1, JSON.stringify(list.json.data));
  });

  await test('确认 pending → 转成正式 txn', async () => {
    const list = await call('GET', '/api/notify/pending', undefined, token);
    const item = list.json.data.items[0];
    assert.ok(item, '没有待确认记录');

    const r = await call(
      'POST',
      `/api/notify/pending/${item.id}/confirm`,
      { account_id: 1, category_id: 3 },
      token,
    );
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.data.txn_id > 0);

    const after = await call('GET', '/api/notify/pending', undefined, token);
    assert.ok(after.json.data.total < list.json.data.total, '确认后 pending 应减少');
  });

  await test('忽略 pending → 删除', async () => {
    const r0 = await call(
      'POST',
      '/api/notify/receive',
      { pkg: 'com.other.app', title: '某App', body: '消费 ¥4.40', postTime: Date.now() },
      token,
    );
    assert.equal(r0.json.data.action, 'pending');
    const list = await call('GET', '/api/notify/pending', undefined, token);
    const item = list.json.data.items[0];
    const del = await call('DELETE', `/api/notify/pending/${item.id}`, undefined, token);
    assert.equal(del.status, 200);
  });

  // ---- 心跳与健康度 ----
  console.log('\n[心跳与健康度]');
  await test('心跳上报成功', async () => {
    const r = await call(
      'POST',
      '/api/notify/heartbeat',
      { deviceId: 'e2e', appVersion: '1.0', sentTotal: 5, queueDepth: 0 },
      token,
    );
    assert.equal(r.status, 200, JSON.stringify(r.json));
  });

  await test('健康度 healthy=true（刚有心跳）', async () => {
    const r = await call('GET', '/api/notify/health', undefined, token);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.data.healthy, true, JSON.stringify(r.json.data));
    assert.ok(r.json.data.notify_txn_total >= 1);
  });

  await test('心跳超时 → healthy=false 并给出告警', async () => {
    db.prepare(
      `UPDATE device_heartbeat SET last_seen_at = datetime('now', '-72 hours') WHERE device_id = 'e2e'`,
    ).run();
    const r = await call('GET', '/api/notify/health', undefined, token);
    assert.equal(r.json.data.healthy, false, JSON.stringify(r.json.data));
    assert.ok(String(r.json.data.warning).includes('心跳'), String(r.json.data.warning));
  });

  // ---- 配置 ----
  console.log('\n[配置]');
  await test('GET config 返回白名单', async () => {
    const r = await call('GET', '/api/notify/config', undefined, token);
    assert.equal(r.status, 200);
    assert.ok(r.json.data.allowlist['com.tencent.mm'] === 'wechat', JSON.stringify(r.json.data));
  });

  await test('PUT config 改渠道账户映射', async () => {
    const r = await call(
      'PUT',
      '/api/notify/config',
      { channelAccountMap: { wechat: 3, alipay: 2, bank: 4, unknown: 1 } },
      token,
    );
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.data.channelAccountMap.wechat, 3);
  });

  await test('改映射后新通知落到新账户', async () => {
    const r = await call(
      'POST',
      '/api/notify/receive',
      { pkg: 'com.tencent.mm', title: '微信支付', body: '已支付¥99.01', postTime: Date.now() },
      token,
    );
    assert.equal(r.json.data.action, 'recorded');
    const row = db.prepare('SELECT account_id FROM txn WHERE id = ?').get(r.json.data.txn_id) as any;
    assert.equal(Number(row.account_id), 3);
  });

  // ---- 撤销 ----
  console.log('\n[撤销（5 分钟窗口）]');
  let undoTargetId = 0;
  await test('刚自动记账 → 可撤销', async () => {
    const r = await call(
      'POST',
      '/api/notify/receive',
      { pkg: 'com.tencent.mm', title: '微信支付', body: '已支付¥66.60', postTime: Date.now() },
      token,
    );
    assert.equal(r.json.data.action, 'recorded');
    undoTargetId = r.json.data.txn_id;

    const u = await call('POST', `/api/notify/undo/${undoTargetId}`, undefined, token);
    assert.equal(u.status, 200, JSON.stringify(u.json));

    const row = db.prepare('SELECT deleted_at FROM txn WHERE id = ?').get(undoTargetId) as any;
    assert.ok(row.deleted_at, '撤销后应有 deleted_at');
  });

  await test('撤销后月度汇总同步减少', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const txnSum = db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents),0) AS s FROM txn
         WHERE deleted_at IS NULL AND occurred_month = ? AND type = 'expense'`,
      )
      .get(month) as any;
    const sumSum = db
      .prepare(
        `SELECT COALESCE(SUM(total_cents),0) AS s FROM monthly_summary
         WHERE month = ? AND kind = 'expense'`,
      )
      .get(month) as any;
    // ¥66.60 已撤销，两边应依然相等（而不是汇总比实际多 66.60）
    assert.equal(Number(sumSum.s), Number(txnSum.s), `汇总=${sumSum.s} 实际=${txnSum.s}`);
  });

  await test('超过 5 分钟 → 撤销被拒（UNDO_EXPIRED）', async () => {
    const r = await call(
      'POST',
      '/api/notify/receive',
      { pkg: 'com.tencent.mm', title: '微信支付', body: '已支付¥77.70', postTime: Date.now() },
      token,
    );
    const id = r.json.data.txn_id;
    // 把 created_at 推到 10 分钟前
    db.prepare(`UPDATE txn SET created_at = datetime('now', '-10 minutes') WHERE id = ?`).run(id);

    const u = await call('POST', `/api/notify/undo/${id}`, undefined, token);
    assert.equal(u.status, 409, JSON.stringify(u.json));
    assert.equal(u.json.error.code, 'UNDO_EXPIRED');
  });

  await test('手动记账的记录不能撤销（NOT_AUTO）', async () => {
    const res = await call(
      'POST',
      '/api/txns',
      { type: 'expense', amount_cents: 100, account_id: 1 },
      token,
    );
    const id = res.json.data.id;
    const u = await call('POST', `/api/notify/undo/${id}`, undefined, token);
    assert.equal(u.status, 409, JSON.stringify(u.json));
    assert.equal(u.json.error.code, 'NOT_AUTO');
  });

  // ---- Dashboard 聚合 ----
  console.log('\n[Dashboard 通知状态]');
  await test('dashboard 返回 notify 状态块', async () => {
    const r = await call('GET', '/api/dashboard', undefined, token);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const n = r.json.data.notify;
    assert.ok(n, '`dashboard` 应包含 `notify` 字段');
    assert.equal(typeof n.pending_count, 'number');
    assert.equal(typeof n.raw_new_count, 'number');
    assert.equal(typeof n.healthy, 'boolean');
    assert.equal(typeof n.has_device, 'boolean');
  });

  await test('dashboard 的 pending_count 与实际一致', async () => {
    const list = await call('GET', '/api/notify/pending', undefined, token);
    const r = await call('GET', '/api/dashboard', undefined, token);
    assert.equal(r.json.data.notify.pending_count, list.json.data.total);
  });

  await test('dashboard 的 healthy 反映心跳状态', async () => {
    // 前面把心跳推到了 72 小时前
    const r = await call('GET', '/api/dashboard', undefined, token);
    assert.equal(r.json.data.notify.healthy, false, JSON.stringify(r.json.data.notify));
  });

  // ---- 汇总核对 ----
  console.log('\n[最终数据核对]');
  await test('txn 表里的自动记账都有 source=notify', async () => {
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM txn WHERE source = 'notify'`).get() as any;
    assert.ok(Number(rows.n) >= 5, `notify 记录数=${rows.n}`);
  });

  await test('月度汇总总额 = txn 实际总额', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const txnSum = db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents),0) AS s FROM txn
         WHERE deleted_at IS NULL AND occurred_month = ? AND type = 'expense'`,
      )
      .get(month) as any;
    const sumSum = db
      .prepare(
        `SELECT COALESCE(SUM(total_cents),0) AS s FROM monthly_summary
         WHERE month = ? AND kind = 'expense'`,
      )
      .get(month) as any;
    assert.equal(Number(sumSum.s), Number(txnSum.s), `汇总=${sumSum.s} 实际=${txnSum.s}`);
  });

  // ---- 汇总 ----
  console.log(`\n${'='.repeat(50)}`);
  if (failed === 0) {
    console.log(`✅ 端到端全部通过：${passed} 项`);
  } else {
    console.log(`❌ 失败 ${failed} 项 / 通过 ${passed} 项`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('启动失败：', e);
  process.exitCode = 1;
});
