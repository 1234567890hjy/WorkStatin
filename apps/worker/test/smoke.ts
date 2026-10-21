/**
 * Worker 冒烟测试：用内存版 D1 替身跑通「初始化 → 记账 → 汇总 → Dashboard」全链路。
 *
 * 沙箱禁止 wrangler 起本地 server，所以这里用最小 D1 替身直接调 Hono app.fetch，
 * 验证路由、校验、汇总重算逻辑是否真的能跑，而不只是能编译。
 */

import assert from 'node:assert/strict';
import app from '../src/index.ts';

// ---------- 最小 D1 替身 ----------
// 只实现本项目用到的能力：prepare/bind/first/all/run/batch + 少量 SQL 语义。
// 这不是通用 SQLite，是按本项目 SQL 定制的假实现，用于验证控制流。

type Row = Record<string, unknown>;

class FakeD1 {
  users: Row[] = [];
  sessions: Row[] = [];
  attempts: Row[] = [];
  accounts: Row[] = [
    { id: 1, name: '现金', kind: 'cash', balance_cents: 0, is_archived: 0 },
    { id: 2, name: '微信', kind: 'ewallet', balance_cents: 0, is_archived: 0 },
  ];
  categories: Row[] = [
    { id: 1, name: '餐饮', kind: 'expense', icon: '🍚', sort: 1 },
    { id: 10, name: '工资', kind: 'income', icon: '💰', sort: 1 },
  ];
  txns: Row[] = [];
  summary: Row[] = [];
  seq = { txn: 0 };

  prepare(sql: string) {
    return new Stmt(this, sql);
  }

  async batch(stmts: Stmt[]): Promise<unknown[]> {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
}

class Stmt {
  args: unknown[] = [];
  private db: FakeD1;
  private sql: string;

  constructor(db: FakeD1, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...args: unknown[]): Stmt {
    const s = new Stmt(this.db, this.sql);
    s.args = args;
    return s;
  }

  async first<T = Row>(): Promise<T | null> {
    const rows = await this.all<T>();
    return (rows.results?.[0] as T) ?? null;
  }

  async all<T = Row>(): Promise<{ results: T[] }> {
    const sql = this.sql.replace(/\s+/g, ' ').trim();
    const a = this.args;

    if (sql.includes('SELECT COUNT(*) AS n FROM user')) {
      return { results: [{ n: this.db.users.length }] as T[] };
    }
    if (sql.includes('SELECT COUNT(*) AS n FROM login_attempt')) {
      const n = this.db.attempts.filter((x) => x.ok === 0).length;
      return { results: [{ n }] as T[] };
    }
    if (sql.startsWith('SELECT * FROM user WHERE username')) {
      return { results: this.db.users.filter((u) => u.username === a[0]) as T[] };
    }
    if (sql.startsWith('SELECT username FROM user WHERE id')) {
      return { results: this.db.users.filter((u) => u.id === a[0]) as T[] };
    }
    if (sql.includes('FROM session WHERE token_hash = ?')) {
      const s = this.db.sessions.find((x) => x.token_hash === a[0]);
      return { results: (s ? [s] : []) as T[] };
    }
    if (sql.startsWith('SELECT * FROM account WHERE is_archived = 0 ORDER BY id')) {
      return { results: this.db.accounts.filter((x) => x.is_archived === 0) as T[] };
    }
    if (sql.startsWith('SELECT * FROM category')) {
      return { results: [...this.db.categories] as T[] };
    }
    if (sql.includes('SUM(balance_cents)')) {
      const total = this.db.accounts
        .filter((x) => x.is_archived === 0)
        .reduce((acc, x) => acc + Number(x.balance_cents), 0);
      return { results: [{ total }] as T[] };
    }
    if (sql.startsWith('SELECT * FROM txn WHERE id = ?')) {
      return { results: this.db.txns.filter((t) => t.id === a[0]) as T[] };
    }
    if (sql.startsWith('SELECT t.*') && sql.includes('ORDER BY t.occurred_at DESC')) {
      const items = [...this.db.txns]
        .filter((t) => !t.deleted_at)
        .sort((x, y) => String(y.occurred_at).localeCompare(String(x.occurred_at)));
      return { results: items.slice(-100) as T[] };
    }
    if (sql.includes('FROM monthly_summary') && sql.includes('GROUP BY kind')) {
      const map = new Map<string, number>();
      for (const r of this.db.summary) {
        if (r.month !== a[0]) continue;
        map.set(String(r.kind), (map.get(String(r.kind)) ?? 0) + Number(r.total_cents));
      }
      return { results: [...map].map(([kind, total]) => ({ kind, total })) as T[] };
    }
    if (sql.includes('FROM monthly_summary') && sql.includes('LEFT JOIN category')) {
      return { results: this.db.summary.filter((r) => r.month === a[0]) as T[] };
    }
    if (sql.includes('FROM txn') && sql.includes('occurred_day = ?')) {
      const map = new Map<string, { total: number; n: number }>();
      for (const t of this.db.txns) {
        if (t.deleted_at || t.occurred_day !== a[0]) continue;
        const k = String(t.type);
        const cur = map.get(k) ?? { total: 0, n: 0 };
        cur.total += Number(t.amount_cents);
        cur.n += 1;
        map.set(k, cur);
      }
      return {
        results: [...map].map(([type, v]) => ({ type, total: v.total, n: v.n })) as T[],
      };
    }
    if (sql.includes('FROM workout')) {
      return { results: [{ minutes: 0, n: 0 }] as T[] };
    }
    if (sql.includes('SELECT COUNT(*) AS n FROM task')) {
      return { results: [{ n: 0 }] as T[] };
    }
    if (sql.startsWith('SELECT t.id, t.type') || sql.includes('LIMIT 8')) {
      const items = [...this.db.txns].filter((t) => !t.deleted_at).slice(0, 8);
      return { results: items as T[] };
    }
    return { results: [] as T[] };
  }

  async run(): Promise<{ meta: { last_row_id: number; changes: number } }> {
    const sql = this.sql.replace(/\s+/g, ' ').trim();
    const a = this.args;

    if (sql.startsWith('INSERT INTO user')) {
      this.db.users.push({
        id: 1,
        username: a[0],
        password_hash: a[1],
        password_salt: a[2],
        iterations: a[3],
      });
      return { meta: { last_row_id: 1, changes: 1 } };
    }
    if (sql.startsWith('INSERT INTO session')) {
      this.db.sessions.push({
        token_hash: a[0],
        user_id: a[1],
        expires_at: a[2],
        created_at: new Date().toISOString(),
      });
      return { meta: { last_row_id: 1, changes: 1 } };
    }
    if (sql.startsWith('INSERT INTO login_attempt')) {
      this.db.attempts.push({ ip: a[0], ok: a[1] });
      return { meta: { last_row_id: 1, changes: 1 } };
    }
    if (sql.startsWith('DELETE FROM session WHERE token_hash')) {
      this.db.sessions = this.db.sessions.filter((s) => s.token_hash !== a[0]);
      return { meta: { last_row_id: 0, changes: 1 } };
    }
    if (sql.startsWith('DELETE FROM session WHERE expires_at')) {
      return { meta: { last_row_id: 0, changes: 0 } };
    }
    if (sql.startsWith('INSERT INTO txn')) {
      const id = ++this.db.seq.txn;
      this.db.txns.push({
        id,
        type: a[0],
        amount_cents: a[1],
        account_id: a[2],
        to_account_id: a[3],
        category_id: a[4],
        merchant: a[5],
        note: a[6],
        occurred_at: a[7],
        occurred_day: a[8],
        occurred_month: a[9],
        source: a[10],
        deleted_at: null,
      });
      return { meta: { last_row_id: id, changes: 1 } };
    }
    if (sql.startsWith('UPDATE txn SET deleted_at')) {
      const t = this.db.txns.find((x) => x.id === a[0]);
      if (t) t.deleted_at = 'now';
      return { meta: { last_row_id: 0, changes: 1 } };
    }
    if (sql.startsWith('UPDATE account SET')) {
      const t = this.db.accounts.find((x) => x.id === a[a.length - 1]);
      if (t && typeof a[0] === 'number') t.balance_cents = a[0];
      return { meta: { last_row_id: 0, changes: 1 } };
    }
    if (sql.startsWith('DELETE FROM monthly_summary')) {
      this.db.summary = this.db.summary.filter((r) => r.month !== a[0]);
      return { meta: { last_row_id: 0, changes: 1 } };
    }
    if (sql.startsWith('INSERT INTO monthly_summary')) {
      // 模拟写时重算：按 txn 聚合出该月汇总
      const month = a[0];
      const agg = new Map<string, { kind: string; category_id: unknown; total: number; n: number }>();
      for (const t of this.db.txns) {
        if (t.deleted_at || t.occurred_month !== month) continue;
        const key = `${t.type}|${t.category_id}`;
        const cur = agg.get(key) ?? {
          kind: String(t.type),
          category_id: t.category_id,
          total: 0,
          n: 0,
        };
        cur.total += Number(t.amount_cents);
        cur.n += 1;
        agg.set(key, cur);
      }
      for (const [key, v] of agg) {
        const [kind, cid] = key.split('|');
        this.db.summary.push({
          month,
          kind,
          category_id: cid === 'null' || cid === 'undefined' ? null : Number(cid),
          total_cents: v.total,
          txn_count: v.n,
        });
      }
      return { meta: { last_row_id: 0, changes: 1 } };
    }
    return { meta: { last_row_id: 0, changes: 0 } };
  }
}

// ---------- 测试工具 ----------
const db = new FakeD1();
const env = { DB: db as unknown as D1Database, ENVIRONMENT: 'test' };
let token = '';

function req(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return new Request(`http://test${path}`, { ...init, headers });
}

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await app.fetch(req(path, init), env as never);
  return { status: res.status, body: await res.json() };
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function t(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}\n    ${(e as Error).message.split('\n')[0]}`);
  }
}

// ---------- 用例 ----------
await t('health 可达', async () => {
  const r = await call('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

await t('未初始化时 status.initialized=false', async () => {
  const r = await call('/api/auth/status');
  assert.equal(r.body.data.initialized, false);
});

await t('弱口令被拒绝', async () => {
  const r = await call('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ username: 'me', password: '123' }),
  });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error.code, 'WEAK_PASSWORD');
});

await t('非法用户名被拒绝', async () => {
  const r = await call('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ username: 'a', password: 'password123' }),
  });
  assert.equal(r.body.error.code, 'INVALID_USERNAME');
});

await t('初始化成功并拿到 token', async () => {
  const r = await call('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ username: 'owner', password: 'password123' }),
  });
  assert.equal(r.body.ok, true);
  assert.ok(r.body.data.token);
  token = r.body.data.token;
});

await t('重复初始化被拒绝', async () => {
  const r = await call('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ username: 'other', password: 'password123' }),
  });
  assert.equal(r.body.error.code, 'ALREADY_INITIALIZED');
});

await t('错误口令登录失败', async () => {
  const r = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'owner', password: 'wrongpass' }),
  });
  assert.equal(r.body.error.code, 'BAD_CREDENTIALS');
});

await t('正确口令登录成功', async () => {
  const r = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'owner', password: 'password123' }),
  });
  assert.equal(r.body.ok, true);
  assert.ok(r.body.data.token);
});

await t('me 返回当前用户', async () => {
  const r = await call('/api/auth/me');
  assert.equal(r.body.data.username, 'owner');
});

await t('未登录访问记账被拒', async () => {
  const saved = token;
  token = '';
  const r = await call('/api/txns');
  assert.equal(r.status, 401);
  token = saved;
});

await t('账户与分类可读', async () => {
  const a = await call('/api/accounts');
  assert.equal(a.body.data.items.length, 2);
  const c = await call('/api/categories');
  assert.ok(c.body.data.items.length >= 2);
});

await t('金额为 0 被拒绝', async () => {
  const r = await call('/api/txns', {
    method: 'POST',
    body: JSON.stringify({ type: 'expense', amount_cents: 0, account_id: 1 }),
  });
  assert.equal(r.body.error.code, 'ZERO_AMOUNT');
});

await t('非法类型被拒绝', async () => {
  const r = await call('/api/txns', {
    method: 'POST',
    body: JSON.stringify({ type: 'bogus', amount_cents: 100, account_id: 1 }),
  });
  assert.equal(r.body.error.code, 'INVALID_TYPE');
});

await t('转账必须指定转入账户', async () => {
  const r = await call('/api/txns', {
    method: 'POST',
    body: JSON.stringify({ type: 'transfer', amount_cents: 100, account_id: 1 }),
  });
  assert.equal(r.body.error.code, 'INVALID_TO_ACCOUNT');
});

await t('转账转出转入不能相同', async () => {
  const r = await call('/api/txns', {
    method: 'POST',
    body: JSON.stringify({
      type: 'transfer',
      amount_cents: 100,
      account_id: 1,
      to_account_id: 1,
    }),
  });
  assert.equal(r.body.error.code, 'SAME_ACCOUNT');
});

await t('用元录入支出', async () => {
  const r = await call('/api/txns', {
    method: 'POST',
    body: JSON.stringify({ type: 'expense', amount: '12.34', account_id: 1, category_id: 1 }),
  });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.amount_cents, 1234);
});

await t('用分录入收入', async () => {
  const r = await call('/api/txns', {
    method: 'POST',
    body: JSON.stringify({ type: 'income', amount_cents: 500000, account_id: 2, category_id: 10 }),
  });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.amount_cents, 500000);
});

await t('月度汇总正确', async () => {
  const r = await call('/api/txns/stats/monthly');
  assert.equal(r.body.data.expense_cents, 1234);
  assert.equal(r.body.data.income_cents, 500000);
});

await t('列表可读', async () => {
  const r = await call('/api/txns');
  assert.equal(r.body.data.items.length, 2);
});

await t('软删除后不再出现在列表', async () => {
  const list = await call('/api/txns');
  // 明确挑「支出」那条删，避免依赖排序细节
  const target = list.body.data.items.find((x: any) => x.type === 'expense');
  assert.ok(target, '应能找到支出记录');
  const d = await call(`/api/txns/${target.id}`, { method: 'DELETE' });
  assert.equal(d.body.ok, true);
  const after = await call('/api/txns');
  assert.equal(after.body.data.items.length, 1);
  assert.equal(after.body.data.items[0].type, 'income');
});

await t('分享解析：识别微信支付短信', async () => {
  const r = await call('/api/share/parse', {
    method: 'POST',
    body: JSON.stringify({ text: '微信支付 向 瑞幸咖啡 支付 12.34 元' }),
  });
  assert.equal(r.body.data.parsed, true);
  assert.equal(r.body.data.draft.amount_cents, 1234);
  assert.equal(r.body.data.draft.merchant, '瑞幸咖啡');
});

await t('分享解析：无金额时落回手填', async () => {
  const r = await call('/api/share/parse', {
    method: 'POST',
    body: JSON.stringify({ text: '今天天气不错' }),
  });
  assert.equal(r.body.data.parsed, false);
  assert.equal(r.body.data.draft.amount, '');
});

await t('分享解析：空内容报错', async () => {
  const r = await call('/api/share/parse', {
    method: 'POST',
    body: JSON.stringify({ text: '' }),
  });
  assert.equal(r.body.error.code, 'EMPTY_SHARE');
});

await t('Dashboard 聚合可用', async () => {
  const r = await call('/api/dashboard');
  assert.equal(r.body.ok, true);
  // 支出那条已在「软删除」用例中删掉，故支出应为 0
  assert.equal(r.body.data.month_stats.expense_cents, 0);
  assert.equal(r.body.data.month_stats.income_cents, 500000);
  assert.equal(r.body.data.net_worth_cents, 0);
});

await t('净资产随账户余额变化', async () => {
  await call('/api/accounts/1', {
    method: 'PUT',
    body: JSON.stringify({ balance_cents: 100000 }),
  });
  const r = await call('/api/net-worth');
  assert.equal(r.body.data.total_cents, 100000);
});

await t('登出后 token 失效', async () => {
  await call('/api/auth/logout', { method: 'POST' });
  const r = await call('/api/auth/me');
  assert.equal(r.status, 401);
});

await t('未知路由 404', async () => {
  const r = await call('/api/nope');
  assert.equal(r.status, 404);
});

// ---------- 汇总 ----------
console.log(`\n${'='.repeat(50)}`);
if (failed === 0) {
  console.log(`✅ Worker 冒烟测试全部通过：${passed} 项`);
} else {
  console.log(`❌ 失败 ${failed} 项 / 通过 ${passed} 项`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
