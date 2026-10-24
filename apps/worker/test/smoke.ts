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
  workouts: Row[] = [];
  videos: Row[] = [];
  tasks: Row[] = [];
  routines: Row[] = [];
  routineLogs: Row[] = [];
  // 计数器从现有数据的最大 id 起，避免新增记录与种子数据 id 冲突
  // account 种子 id 1/2；category 种子 id 1 和 10
  seq = {
    txn: 0,
    workout: 0,
    video: 0,
    task: 0,
    routine: 0,
    category: 10,
    account: 2,
  };

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
    if (sql.startsWith('SELECT * FROM user WHERE id = ?')) {
      return { results: this.db.users.filter((u) => u.id === a[0]) as T[] };
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
    if (sql.startsWith('SELECT id FROM account WHERE name = ?')) {
      return { results: this.db.accounts.filter((x) => x.name === a[0]) as T[] };
    }
    if (sql.startsWith('SELECT * FROM account WHERE id = ?')) {
      return { results: this.db.accounts.filter((x) => x.id === a[0]) as T[] };
    }
    if (sql.startsWith('SELECT id FROM category WHERE id = ?')) {
      return { results: this.db.categories.filter((x) => x.id === a[0]) as T[] };
    }
    if (sql.startsWith('SELECT id FROM category WHERE name = ? AND kind = ?')) {
      const exclude = a.length > 2 ? a[2] : null;
      return {
        results: this.db.categories.filter(
          (x) => x.name === a[0] && x.kind === a[1] && x.id !== exclude,
        ) as T[],
      };
    }
    if (sql.startsWith('SELECT * FROM category WHERE id = ?')) {
      return { results: this.db.categories.filter((x) => x.id === a[0]) as T[] };
    }
    if (sql.startsWith('SELECT COUNT(*) AS n FROM txn WHERE category_id = ?')) {
      return {
        results: [
          { n: this.db.txns.filter((t) => t.category_id === a[0] && !t.deleted_at).length },
        ] as T[],
      };
    }
    // ---- 全局搜索 ----
    if (sql.includes('FROM txn') && sql.includes('merchant LIKE ?')) {
      const q = String(a[0]).replace(/%/g, '');
      const items = this.db.txns
        .filter(
          (t) =>
            !t.deleted_at &&
            (String(t.merchant ?? '').includes(q) || String(t.note ?? '').includes(q)),
        )
        .slice(0, 8);
      return { results: items as T[] };
    }
    if (sql.includes('FROM workout') && sql.includes('note LIKE ?')) {
      const q = String(a[0]).replace(/%/g, '');
      const items = this.db.workouts
        .filter((w) => !w.deleted_at && String(w.note ?? '').includes(q))
        .slice(0, 8);
      return { results: items as T[] };
    }
    if (sql.includes('FROM video_item') && sql.includes('title LIKE ?')) {
      const q = String(a[0]).replace(/%/g, '');
      const items = this.db.videos
        .filter(
          (v) =>
            !v.deleted_at &&
            (String(v.title ?? '').includes(q) ||
              String(v.summary ?? '').includes(q) ||
              String(v.tags ?? '').includes(q) ||
              String(v.transcript ?? '').includes(q)),
        )
        .slice(0, 8);
      return { results: items as T[] };
    }
    if (sql.includes('FROM task') && sql.includes('title LIKE ?')) {
      const q = String(a[0]).replace(/%/g, '');
      const items = this.db.tasks
        .filter(
          (t) =>
            !t.deleted_at &&
            (String(t.title ?? '').includes(q) || String(t.detail ?? '').includes(q)),
        )
        .slice(0, 8);
      return { results: items as T[] };
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
    // ---- P1: workout ----
    // 精确按 id 查必须最先匹配，否则会被下面的 ORDER BY 分支抢走
    if (sql.startsWith('SELECT * FROM workout WHERE id = ?')) {
      return { results: this.db.workouts.filter((w) => w.id === a[0]) as T[] };
    }
    if (sql.startsWith('SELECT id FROM workout WHERE id = ?')) {
      return {
        results: this.db.workouts.filter((w) => w.id === a[0] && !w.deleted_at) as T[],
      };
    }
    if (sql.includes('FROM workout') && sql.includes('SUM(duration_min)') && sql.includes('date(?')) {
      const cutoff = String(a[0]);
      const days = Number(String(a[1]).replace(/[^0-9]/g, '')) || 0;
      const from = new Date(new Date(cutoff + 'T00:00:00Z').getTime() - days * 86400000)
        .toISOString()
        .slice(0, 10);
      const inRange = this.db.workouts.filter(
        (w) => !w.deleted_at && String(w.occurred_day) >= from && String(w.occurred_day) <= cutoff,
      );
      return {
        results: [
          {
            minutes: inRange.reduce((s, w) => s + Number(w.duration_min), 0),
            distance_m: inRange.reduce((s, w) => s + Number(w.distance_m ?? 0), 0),
            calories: inRange.reduce((s, w) => s + Number(w.calories ?? 0), 0),
            count: inRange.length,
          },
        ] as T[],
      };
    }
    if (sql.includes('FROM workout') && sql.includes('GROUP BY occurred_day')) {
      const cutoff = String(a[0]);
      const days = Number(String(a[1]).replace(/[^0-9]/g, '')) || 0;
      const from = new Date(new Date(cutoff + 'T00:00:00Z').getTime() - days * 86400000)
        .toISOString()
        .slice(0, 10);
      const map = new Map<string, { minutes: number; n: number }>();
      for (const w of this.db.workouts) {
        if (w.deleted_at) continue;
        const d = String(w.occurred_day);
        if (d < from || d > cutoff) continue;
        const cur = map.get(d) ?? { minutes: 0, n: 0 };
        cur.minutes += Number(w.duration_min);
        cur.n += 1;
        map.set(d, cur);
      }
      return {
        results: [...map]
          .sort(([x], [y]) => x.localeCompare(y))
          .map(([occurred_day, v]) => ({ occurred_day, minutes: v.minutes, n: v.n })) as T[],
      };
    }
    if (sql.includes('FROM workout') && sql.includes('ORDER BY occurred_at DESC')) {
      const items = this.db.workouts
        .filter((w) => !w.deleted_at)
        .sort((x, y) => String(y.occurred_at).localeCompare(String(x.occurred_at)));
      const limit = Number(a[a.length - 1]) || 50;
      return { results: items.slice(0, limit) as T[] };
    }
    // ---- P1: video ----
    if (sql.includes('FROM video_item') && sql.includes('has_transcript')) {
      const items = this.db.videos
        .filter((v) => !v.deleted_at)
        .map((v) => ({
          ...v,
          has_transcript: v.transcript ? 1 : 0,
          has_summary: v.summary ? 1 : 0,
        }));
      return { results: items as T[] };
    }
    if (sql.includes('FROM video_item') && sql.includes('AS pending')) {
      const alive = this.db.videos.filter((v) => !v.deleted_at);
      return {
        results: [
          {
            pending: alive.filter((v) => v.status === 'draft' || v.status === 'transcribed').length,
            done: alive.filter((v) => v.status === 'summarized' || v.status === 'archived').length,
          },
        ] as T[],
      };
    }
    if (sql.startsWith('SELECT * FROM video_item WHERE id = ?')) {
      return { results: this.db.videos.filter((v) => v.id === a[0]) as T[] };
    }
    if (sql.startsWith('SELECT id FROM video_item WHERE id = ?')) {
      return {
        results: this.db.videos.filter((v) => v.id === a[0] && !v.deleted_at) as T[],
      };
    }
    if (sql.includes('FROM video_item') && sql.includes('LIKE')) {
      const q = String(a[0]).replace(/%/g, '');
      const items = this.db.videos.filter(
        (v) =>
          !v.deleted_at &&
          (String(v.title ?? '').includes(q) ||
            String(v.summary ?? '').includes(q) ||
            String(v.tags ?? '').includes(q) ||
            String(v.transcript ?? '').includes(q)),
      );
      return { results: items as T[] };
    }
    // ---- task ----
    // 精确按 id 查必须最先，否则会被列表分支抢走
    if (sql.startsWith('SELECT id, status, done_at FROM task WHERE id = ?')) {
      return {
        results: this.db.tasks.filter((t) => t.id === a[0] && !t.deleted_at) as T[],
      };
    }
    if (sql.startsWith('SELECT id FROM task WHERE id = ?')) {
      return {
        results: this.db.tasks.filter((t) => t.id === a[0] && !t.deleted_at) as T[],
      };
    }
    if (sql.startsWith('SELECT * FROM task WHERE id = ?')) {
      return { results: this.db.tasks.filter((t) => t.id === a[0]) as T[] };
    }
    if (sql.startsWith('SELECT COUNT(*) AS n FROM task')) {
      // 三种计数：全部未完成 / 今天到期 / 已逾期
      const alive = this.db.tasks.filter((t) => !t.deleted_at);
      const open = alive.filter((t) => t.status === 'todo' || t.status === 'doing');
      if (sql.includes('due_day = ?')) {
        return { results: [{ n: open.filter((t) => t.due_day === a[0]).length }] as T[] };
      }
      if (sql.includes('due_day < ?')) {
        const cutoff = String(a[0]);
        return {
          results: [{ n: open.filter((t) => t.due_day && String(t.due_day) < cutoff).length }] as T[],
        };
      }
      return { results: [{ n: open.length }] as T[] };
    }
    if (sql.includes('FROM task') && sql.includes('ORDER BY')) {
      let items = this.db.tasks.filter((t) => !t.deleted_at);
      const statusQ = a.find((x) => typeof x === 'string' && ['todo','doing','done','dropped'].includes(x));
      if (statusQ) items = items.filter((t) => t.status === statusQ);
      if (sql.includes("status IN ('todo','doing')") && !statusQ) {
        items = items.filter((t) => t.status === 'todo' || t.status === 'doing');
      }
      // due 过滤
      const today = typeof a[0] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a[0]) ? a[0] : null;
      if (today && sql.includes('due_day = ?')) items = items.filter((t) => t.due_day === today);
      if (today && sql.includes('due_day < ?')) {
        items = items.filter((t) => t.due_day && t.due_day < today);
      }
      if (today && sql.includes('due_day >= ?')) {
        items = items.filter((t) => t.due_day && t.due_day >= today);
      }
      items = [...items].sort((x, y) => {
        // 无截止日的排最后，其余按日期、优先级、id
        if (!x.due_day && y.due_day) return 1;
        if (x.due_day && !y.due_day) return -1;
        if (x.due_day && y.due_day && x.due_day !== y.due_day) {
          return String(x.due_day).localeCompare(String(y.due_day));
        }
        if (x.priority !== y.priority) return Number(x.priority) - Number(y.priority);
        return Number(y.id) - Number(x.id);
      });
      const limit = Number(a[a.length - 1]);
      const out = Number.isFinite(limit) && limit > 0 ? items.slice(0, limit) : items;
      return { results: out as T[] };
    }
    // ---- routine ----
    if (sql.startsWith('SELECT COUNT(*) AS n FROM routine')) {
      const active = this.db.routines.filter((r) => r.is_active === 1);
      if (sql.includes("cadence = 'daily'")) {
        const daily = active.filter((r) => r.cadence === 'daily');
        if (sql.includes('EXISTS')) {
          return {
            results: [
              { n: daily.filter((r) => this.db.routineLogs.some((l) => l.routine_id === r.id)).length },
            ] as T[],
          };
        }
        return { results: [{ n: daily.length }] as T[] };
      }
      return { results: [{ n: active.length }] as T[] };
    }
    if (sql.startsWith('SELECT * FROM routine WHERE id = ?')) {
      return { results: this.db.routines.filter((r) => r.id === a[0]) as T[] };
    }
    if (sql.startsWith('SELECT id FROM routine WHERE id = ?')) {
      return { results: this.db.routines.filter((r) => r.id === a[0]) as T[] };
    }
    if (sql.startsWith('SELECT * FROM routine')) {
      const items = sql.includes('WHERE is_active = 1')
        ? this.db.routines.filter((r) => r.is_active === 1)
        : [...this.db.routines];
      return { results: items.sort((x, y) => Number(x.id) - Number(y.id)) as T[] };
    }
    if (sql.startsWith('SELECT routine_id, done_day FROM routine_log')) {
      const logs = [...this.db.routineLogs].sort((x, y) =>
        String(y.done_day).localeCompare(String(x.done_day)),
      );
      return { results: logs as T[] };
    }
    if (sql.startsWith('SELECT done_day FROM routine_log')) {
      // 绑定顺序：(routine_id, currentDay, '-N days')
      const rid = a[0];
      const cutoff = String(a[1]);
      const days = Number(String(a[2]).replace(/[^0-9]/g, '')) || 0;
      const from = new Date(new Date(cutoff + 'T00:00:00Z').getTime() - days * 86400000)
        .toISOString()
        .slice(0, 10);
      const items = this.db.routineLogs
        .filter((l) => l.routine_id === rid && String(l.done_day) >= from)
        .sort((x, y) => String(y.done_day).localeCompare(String(x.done_day)));
      return { results: items as T[] };
    }
    if (sql.startsWith('SELECT COUNT(*) AS n FROM task')) {
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
    if (sql.startsWith('DELETE FROM session WHERE user_id')) {
      const before = this.db.sessions.length;
      this.db.sessions = this.db.sessions.filter((s) => s.token_hash === a[1]);
      return { meta: { last_row_id: 0, changes: before - this.db.sessions.length } };
    }
    if (sql.startsWith('UPDATE user SET password_hash')) {
      const u = this.db.users.find((x) => x.id === a[a.length - 1]);
      if (u) {
        u.password_hash = a[0];
        u.password_salt = a[1];
        u.iterations = a[2];
      }
      return { meta: { last_row_id: 0, changes: 1 } };
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
    if (sql.startsWith('INSERT INTO account')) {
      const id = ++this.db.seq.account;
      this.db.accounts.push({
        id,
        name: a[0],
        kind: a[1],
        balance_cents: a[2],
        is_archived: a[3],
      });
      return { meta: { last_row_id: id, changes: 1 } };
    }
    if (sql.startsWith('INSERT INTO category')) {
      const id = ++this.db.seq.category;
      this.db.categories.push({
        id,
        name: a[0],
        kind: a[1],
        icon: a[2],
        sort: a[3],
      });
      return { meta: { last_row_id: id, changes: 1 } };
    }
    if (sql.startsWith('UPDATE category SET name')) {
      const c = this.db.categories.find((x) => x.id === a[4]);
      if (c) {
        c.name = a[0];
        c.kind = a[1];
        c.icon = a[2];
        c.sort = a[3];
      }
      return { meta: { last_row_id: 0, changes: 1 } };
    }
    if (sql.startsWith('DELETE FROM category WHERE id = ?')) {
      this.db.categories = this.db.categories.filter((x) => x.id !== a[0]);
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
    // ---- P1: workout 写入 ----
    if (sql.startsWith('INSERT INTO workout')) {
      const id = ++this.db.seq.workout;
      this.db.workouts.push({
        id,
        kind: a[0],
        duration_min: a[1],
        distance_m: a[2],
        calories: a[3],
        note: a[4],
        occurred_at: a[5],
        occurred_day: a[6],
        deleted_at: null,
      });
      return { meta: { last_row_id: id, changes: 1 } };
    }
    if (sql.startsWith('UPDATE workout SET deleted_at')) {
      const w = this.db.workouts.find((x) => x.id === a[0]);
      if (w) w.deleted_at = 'now';
      return { meta: { last_row_id: 0, changes: 1 } };
    }
    // ---- P1: video 写入 ----
    if (sql.startsWith('INSERT INTO video_item')) {
      const id = ++this.db.seq.video;
      this.db.videos.push({
        id,
        url: a[0],
        platform: a[1],
        title: a[2],
        author: a[3],
        duration_sec: a[4],
        status: 'draft',
        tags: null,
        transcript: null,
        summary: null,
        deleted_at: null,
      });
      return { meta: { last_row_id: id, changes: 1 } };
    }
    if (sql.startsWith('UPDATE video_item SET transcript')) {
      const v = this.db.videos.find((x) => x.id === a[1]);
      if (v) {
        v.transcript = a[0];
        v.status = 'transcribed';
      }
      return { meta: { last_row_id: 0, changes: 1 } };
    }
    if (sql.startsWith('UPDATE video_item SET summary')) {
      const v = this.db.videos.find((x) => x.id === a[2]);
      if (v) {
        v.summary = a[0];
        if (a[1] !== null) v.tags = a[1];
        v.status = 'summarized';
      }
      return { meta: { last_row_id: 0, changes: 1 } };
    }
    if (sql.startsWith('UPDATE video_item SET status')) {
      const v = this.db.videos.find((x) => x.id === a[0]);
      if (v) v.status = 'archived';
      return { meta: { last_row_id: 0, changes: 1 } };
    }
    if (sql.startsWith('UPDATE video_item SET deleted_at')) {
      const v = this.db.videos.find((x) => x.id === a[0]);
      if (v) v.deleted_at = 'now';
      return { meta: { last_row_id: 0, changes: 1 } };
    }
    // ---- task 写入 ----
    if (sql.startsWith('INSERT INTO task')) {
      const id = ++this.db.seq.task;
      this.db.tasks.push({
        id,
        title: a[0],
        detail: a[1],
        status: a[2],
        priority: a[3],
        due_day: a[4],
        done_at: null,
        deleted_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      return { meta: { last_row_id: id, changes: 1 } };
    }
    if (sql.startsWith('UPDATE task SET title = ?')) {
      const t = this.db.tasks.find((x) => x.id === a[a.length - 1]);
      if (t) {
        t.title = a[0];
        t.detail = a[1];
        t.status = a[2];
        t.priority = a[3];
        t.due_day = a[4];
        t.done_at = a[5];
      }
      return { meta: { last_row_id: 0, changes: 1 } };
    }
    if (sql.startsWith('UPDATE task SET status')) {
      const t = this.db.tasks.find((x) => x.id === a[2]);
      if (t) {
        t.status = a[0];
        t.done_at = a[1];
      }
      return { meta: { last_row_id: 0, changes: 1 } };
    }
    if (sql.startsWith('UPDATE task SET deleted_at')) {
      const t = this.db.tasks.find((x) => x.id === a[0]);
      if (t) t.deleted_at = 'now';
      return { meta: { last_row_id: 0, changes: 1 } };
    }
    // ---- routine 写入 ----
    if (sql.startsWith('INSERT INTO routine')) {
      const id = ++this.db.seq.routine;
      this.db.routines.push({
        id,
        name: a[0],
        cadence: a[1],
        target_per_period: a[2],
        is_active: 1,
        created_at: new Date().toISOString(),
      });
      return { meta: { last_row_id: id, changes: 1 } };
    }
    if (sql.startsWith('UPDATE routine SET name')) {
      const r = this.db.routines.find((x) => x.id === a[a.length - 1]);
      if (r) {
        r.name = a[0];
        r.cadence = a[1];
        r.target_per_period = a[2];
        r.is_active = a[3];
      }
      return { meta: { last_row_id: 0, changes: 1 } };
    }
    if (sql.startsWith('UPDATE routine SET is_active')) {
      const r = this.db.routines.find((x) => x.id === a[1]);
      if (r) r.is_active = a[0];
      return { meta: { last_row_id: 0, changes: 1 } };
    }
    if (sql.startsWith('INSERT OR IGNORE INTO routine_log')) {
      const dup = this.db.routineLogs.some(
        (l) => l.routine_id === a[0] && l.done_day === a[1],
      );
      if (dup) return { meta: { last_row_id: 0, changes: 0 } };
      this.db.routineLogs.push({
        id: this.db.routineLogs.length + 1,
        routine_id: a[0],
        done_day: a[1],
        created_at: new Date().toISOString(),
      });
      return { meta: { last_row_id: 1, changes: 1 } };
    }
    if (sql.startsWith('DELETE FROM routine_log WHERE routine_id = ? AND done_day = ?')) {
      const before = this.db.routineLogs.length;
      this.db.routineLogs = this.db.routineLogs.filter(
        (l) => !(l.routine_id === a[0] && l.done_day === a[1]),
      );
      return { meta: { last_row_id: 0, changes: before - this.db.routineLogs.length } };
    }
    if (sql.startsWith('DELETE FROM routine_log WHERE routine_id = ?')) {
      const before = this.db.routineLogs.length;
      this.db.routineLogs = this.db.routineLogs.filter((l) => l.routine_id !== a[0]);
      return { meta: { last_row_id: 0, changes: before - this.db.routineLogs.length } };
    }
    if (sql.startsWith('DELETE FROM routine WHERE id = ?')) {
      this.db.routines = this.db.routines.filter((r) => r.id !== a[0]);
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

// ---- 修改口令 ----
await t('改密: 旧口令错误被拒绝', async () => {
  const r = await call('/api/auth/password', {
    method: 'PUT',
    body: JSON.stringify({ old_password: 'wrong-old-pass', new_password: 'newpass12345' }),
  });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'BAD_CREDENTIALS');
});

await t('改密: 新口令太弱被拒绝', async () => {
  const r = await call('/api/auth/password', {
    method: 'PUT',
    body: JSON.stringify({ old_password: 'password123', new_password: '123' }),
  });
  assert.equal(r.body.error.code, 'WEAK_PASSWORD');
});

await t('改密: 新口令与旧口令相同被拒绝', async () => {
  const r = await call('/api/auth/password', {
    method: 'PUT',
    body: JSON.stringify({ old_password: 'password123', new_password: 'password123' }),
  });
  assert.equal(r.body.error.code, 'SAME_PASSWORD');
});

await t('改密: 未登录被拒', async () => {
  const saved = token;
  token = '';
  const r = await call('/api/auth/password', {
    method: 'PUT',
    body: JSON.stringify({ old_password: 'password123', new_password: 'newpass12345' }),
  });
  assert.equal(r.status, 401);
  token = saved;
});

await t('改密: 成功后当前会话仍有效', async () => {
  const r = await call('/api/auth/password', {
    method: 'PUT',
    body: JSON.stringify({ old_password: 'password123', new_password: 'newpass12345' }),
  });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.username, 'owner');
  // 当前会话应该还能用
  const me = await call('/api/auth/me');
  assert.equal(me.body.data.username, 'owner');
});

await t('改密: 旧口令再也登不进来', async () => {
  const r = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'owner', password: 'password123' }),
  });
  assert.equal(r.body.error.code, 'BAD_CREDENTIALS');
});

await t('改密: 新口令可以登录', async () => {
  const r = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'owner', password: 'newpass12345' }),
  });
  assert.equal(r.body.ok, true);
  assert.ok(r.body.data.token);
  token = r.body.data.token;
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

// ================= P1 =================
// 重新登录（前面的登出用例让 token 失效了；口令已在「改密」用例中改为 newpass12345）
await t('P1: 重新登录', async () => {
  const r = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'owner', password: 'newpass12345' }),
  });
  assert.equal(r.body.ok, true);
  token = r.body.data.token;
});

// ---- 运动 ----
await t('P1 运动: 非法类型被拒绝', async () => {
  const r = await call('/api/workouts', {
    method: 'POST',
    body: JSON.stringify({ kind: 'bogus', duration_min: 30 }),
  });
  assert.equal(r.body.error.code, 'INVALID_KIND');
});

await t('P1 运动: 时长非法被拒绝', async () => {
  const r = await call('/api/workouts', {
    method: 'POST',
    body: JSON.stringify({ kind: 'run', duration_min: 0 }),
  });
  assert.equal(r.body.error.code, 'INVALID_DURATION');
});

await t('P1 运动: 时长超上限被拒绝', async () => {
  const r = await call('/api/workouts', {
    method: 'POST',
    body: JSON.stringify({ kind: 'run', duration_min: 2000 }),
  });
  assert.equal(r.body.error.code, 'INVALID_DURATION');
});

await t('P1 运动: 正常录入', async () => {
  const r = await call('/api/workouts', {
    method: 'POST',
    body: JSON.stringify({ kind: 'run', duration_min: 35, distance_m: 5200, calories: 320 }),
  });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.duration_min, 35);
  assert.equal(r.body.data.distance_m, 5200);
});

await t('P1 运动: 再录一条', async () => {
  const r = await call('/api/workouts', {
    method: 'POST',
    body: JSON.stringify({ kind: 'gym', duration_min: 45 }),
  });
  assert.equal(r.body.ok, true);
});

await t('P1 运动: 列表可读', async () => {
  const r = await call('/api/workouts');
  assert.equal(r.body.data.items.length, 2);
});

await t('P1 运动: 近 7 天统计', async () => {
  const r = await call('/api/workouts/stats?days=7');
  assert.equal(r.body.data.minutes, 80);
  assert.equal(r.body.data.distance_m, 5200);
  assert.equal(r.body.data.calories, 320);
  assert.equal(r.body.data.count, 2);
  assert.ok(Array.isArray(r.body.data.by_day));
});

await t('P1 运动: 软删除生效', async () => {
  const list = await call('/api/workouts');
  const id = list.body.data.items[0].id;
  const d = await call(`/api/workouts/${id}`, { method: 'DELETE' });
  assert.equal(d.body.ok, true);
  const after = await call('/api/workouts');
  assert.equal(after.body.data.items.length, 1);
});

await t('P1 运动: 删除后统计同步', async () => {
  const r = await call('/api/workouts/stats?days=7');
  assert.equal(r.body.data.count, 1);
});

// ---- 视频 ----
await t('P1 视频: 非法 URL 被拒绝', async () => {
  const r = await call('/api/videos', {
    method: 'POST',
    body: JSON.stringify({ url: 'not-a-url' }),
  });
  assert.equal(r.body.error.code, 'INVALID_URL');
});

await t('P1 视频: 添加抖音链接（无元数据）', async () => {
  const r = await call('/api/videos', {
    method: 'POST',
    body: JSON.stringify({ url: 'https://www.douyin.com/video/123456' }),
  });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.platform, 'douyin');
  assert.equal(r.body.data.status, 'draft');
});

await t('P1 视频: 添加 B 站链接（自动抓元数据）', async () => {
  const r = await call('/api/videos', {
    method: 'POST',
    body: JSON.stringify({ url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: '手填标题' }),
  });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.platform, 'bilibili');
  // 联网可达时用真实标题覆盖手填；不可达时保留手填 —— 两者都算通过
  assert.ok(r.body.data.title, '标题不应为空');
});

await t('P1 视频: 列表带 has_transcript 标记', async () => {
  const r = await call('/api/videos');
  assert.equal(r.body.data.items.length, 2);
  assert.equal(r.body.data.items[0].has_transcript, 0);
});

await t('P1 视频: 空转写稿被拒绝', async () => {
  const list = await call('/api/videos');
  const id = list.body.data.items[0].id;
  const r = await call(`/api/videos/${id}/transcript`, {
    method: 'PUT',
    body: JSON.stringify({ transcript: '   ' }),
  });
  assert.equal(r.body.error.code, 'EMPTY_TRANSCRIPT');
});

await t('P1 视频: 保存转写稿', async () => {
  const list = await call('/api/videos');
  const id = list.body.data.items[0].id;
  const r = await call(`/api/videos/${id}/transcript`, {
    method: 'PUT',
    body: JSON.stringify({ transcript: '这是视频的转写稿内容，讲了一些要点。' }),
  });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.status, 'transcribed');
});

await t('P1 视频: 保存摘要并打标签', async () => {
  const list = await call('/api/videos');
  const id = list.body.data.items[0].id;
  const r = await call(`/api/videos/${id}/summary`, {
    method: 'PUT',
    body: JSON.stringify({ summary: '## 一句话总结\n测试摘要', tags: '测试,学习' }),
  });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.status, 'summarized');
});

await t('P1 视频: 搜索命中摘要', async () => {
  const r = await call('/api/videos/search?q=测试摘要');
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.items.length, 1);
});

await t('P1 视频: 搜索无结果', async () => {
  const r = await call('/api/videos/search?q=不存在的关键词xyz');
  assert.equal(r.body.data.items.length, 0);
});

await t('P1 视频: 归档', async () => {
  const list = await call('/api/videos');
  const id = list.body.data.items[0].id;
  const r = await call(`/api/videos/${id}/archive`, { method: 'POST' });
  assert.equal(r.body.data.status, 'archived');
});

// ---- LLM ----
await t('P1 LLM: 未配置密钥时明确报错', async () => {
  const r = await call('/api/llm/summarize', {
    method: 'POST',
    body: JSON.stringify({ transcript: '一些转写内容' }),
  });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'LLM_NOT_CONFIGURED');
});

// ---- 天气 ----
await t('P1 天气: 未登录被拒', async () => {
  const saved = token;
  token = '';
  const r = await call('/api/weather');
  assert.equal(r.status, 401);
  token = saved;
});

// ---- Dashboard 集成 ----
await t('P1 Dashboard: 含 P1 字段', async () => {
  const r = await call('/api/dashboard');
  assert.equal(r.body.ok, true);
  assert.ok('video_stats' in r.body.data);
  assert.ok('recent_workouts' in r.body.data);
  assert.ok(Array.isArray(r.body.data.recent_workouts));
});

// ---- 计划与任务 ----
await t('P1 任务: 空标题被拒绝', async () => {
  const r = await call('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ title: '   ' }),
  });
  assert.equal(r.body.error.code, 'EMPTY_TITLE');
});

await t('P1 任务: 非法状态被拒绝', async () => {
  const r = await call('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ title: 'x', status: 'bogus' }),
  });
  assert.equal(r.body.error.code, 'INVALID_STATUS');
});

await t('P1 任务: 非法优先级被拒绝', async () => {
  const r = await call('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ title: 'x', priority: 9 }),
  });
  assert.equal(r.body.error.code, 'INVALID_PRIORITY');
});

await t('P1 任务: 非法截止日被拒绝', async () => {
  const r = await call('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ title: 'x', due_day: '2026/01/01' }),
  });
  assert.equal(r.body.error.code, 'INVALID_DUE_DAY');
});

await t('P1 任务: 正常新增', async () => {
  const r = await call('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ title: '写周报', priority: 1, due_day: '2099-12-31' }),
  });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.title, '写周报');
  assert.equal(r.body.data.status, 'todo');
  assert.equal(r.body.data.priority, 1);
});

await t('P1 任务: 默认优先级为中', async () => {
  const r = await call('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ title: '买菜' }),
  });
  assert.equal(r.body.data.priority, 2);
});

await t('P1 任务: 未登录被拒', async () => {
  const saved = token;
  token = '';
  const r = await call('/api/tasks');
  assert.equal(r.status, 401);
  token = saved;
});

await t('P1 任务: 列表默认只返回未完成', async () => {
  const r = await call('/api/tasks');
  assert.equal(r.body.data.items.length, 2);
  assert.ok(r.body.data.items.every((t: any) => t.status === 'todo' || t.status === 'doing'));
});

await t('P1 任务: 逾期筛选', async () => {
  const r = await call('/api/tasks?due=overdue');
  // 两条都没截止日或截止日在未来，应无逾期
  assert.equal(r.body.data.items.length, 0);
});

await t('P1 任务: 打勾完成并记 done_at', async () => {
  const list = await call('/api/tasks');
  const id = list.body.data.items[0].id;
  const r = await call(`/api/tasks/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'done' }),
  });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.status, 'done');
  assert.ok(r.body.data.done_at, 'done_at 应被记录');
});

await t('P1 任务: 完成后不再出现在未完成列表', async () => {
  const r = await call('/api/tasks');
  assert.equal(r.body.data.items.length, 1);
});

await t('P1 任务: 重复打勾幂等，不重写 done_at', async () => {
  const done = await call('/api/tasks?status=done');
  const target = done.body.data.items[0];
  assert.ok(target, '应能找到已完成任务');
  const first = target.done_at;
  const r = await call(`/api/tasks/${target.id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'done' }),
  });
  assert.equal(r.body.data.done_at, first);
});

await t('P1 任务: 改回未完成会清空 done_at', async () => {
  const done = await call('/api/tasks?status=done');
  const target = done.body.data.items[0];
  const r = await call(`/api/tasks/${target.id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'todo' }),
  });
  assert.equal(r.body.data.status, 'todo');
  assert.equal(r.body.data.done_at, null);
});

await t('P1 任务: 整条修改', async () => {
  const list = await call('/api/tasks');
  const id = list.body.data.items[0].id;
  const r = await call(`/api/tasks/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      title: '改过的标题',
      detail: '一些备注',
      priority: 3,
      status: 'doing',
      due_day: '2099-01-01',
    }),
  });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.title, '改过的标题');
  assert.equal(r.body.data.status, 'doing');
  assert.equal(r.body.data.priority, 3);
});

await t('P1 任务: 状态流转不合法被拒', async () => {
  const list = await call('/api/tasks');
  const id = list.body.data.items[0].id;
  const r = await call(`/api/tasks/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'nope' }),
  });
  assert.equal(r.body.error.code, 'INVALID_STATUS');
});

await t('P1 任务: 操作不存在的任务 404', async () => {
  const r = await call('/api/tasks/9999/status', {
    method: 'PATCH',
    body: JSON.stringify({ status: 'done' }),
  });
  assert.equal(r.status, 404);
});

await t('P1 任务: 软删除后不再出现', async () => {
  const list = await call('/api/tasks');
  assert.ok(list.body.data.items.length > 0, '删除前应有未完成的任务');
  const before = list.body.data.items.length;
  const id = list.body.data.items[0].id;
  const d = await call(`/api/tasks/${id}`, { method: 'DELETE' });
  assert.equal(d.body.ok, true);
  const after = await call('/api/tasks');
  assert.equal(after.body.data.items.length, before - 1);
  assert.ok(!after.body.data.items.some((t: any) => t.id === id), '被删的不应再出现');
});

await t('P1 任务: 删除后不再能操作', async () => {
  // 上一条用例删掉的是列表第一条，这里取当时被删的 id 不可靠，
  // 改为：删一条，再用它的 id 操作，应 404
  const list = await call('/api/tasks');
  const target = list.body.data.items[0];
  await call(`/api/tasks/${target.id}`, { method: 'DELETE' });
  const r = await call(`/api/tasks/${target.id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'done' }),
  });
  assert.equal(r.status, 404);
});

await t('P1 Dashboard: 含任务字段', async () => {
  const r = await call('/api/dashboard');
  assert.equal(r.body.ok, true);
  assert.equal(typeof r.body.data.open_tasks, 'number');
  assert.equal(typeof r.body.data.tasks_today, 'number');
  assert.equal(typeof r.body.data.tasks_overdue, 'number');
  assert.ok(Array.isArray(r.body.data.recent_tasks));
});

// ---- 日常管理 ----
await t('P1 日常: 空名称被拒绝', async () => {
  const r = await call('/api/routines', {
    method: 'POST',
    body: JSON.stringify({ name: '  ' }),
  });
  assert.equal(r.body.error.code, 'EMPTY_NAME');
});

await t('P1 日常: 非法周期被拒绝', async () => {
  const r = await call('/api/routines', {
    method: 'POST',
    body: JSON.stringify({ name: 'x', cadence: 'yearly' }),
  });
  assert.equal(r.body.error.code, 'INVALID_CADENCE');
});

await t('P1 日常: 非法目标次数被拒绝', async () => {
  const r = await call('/api/routines', {
    method: 'POST',
    body: JSON.stringify({ name: 'x', target_per_period: 0 }),
  });
  assert.equal(r.body.error.code, 'INVALID_TARGET');
});

await t('P1 日常: 新增每天习惯', async () => {
  const r = await call('/api/routines', {
    method: 'POST',
    body: JSON.stringify({ name: '每天读书', cadence: 'daily', target_per_period: 1 }),
  });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.cadence, 'daily');
  assert.equal(r.body.data.is_active, 1);
});

await t('P1 日常: 新增每周习惯', async () => {
  const r = await call('/api/routines', {
    method: 'POST',
    body: JSON.stringify({ name: '每周跑步 3 次', cadence: 'weekly', target_per_period: 3 }),
  });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.target_per_period, 3);
});

await t('P1 日常: 未登录被拒', async () => {
  const saved = token;
  token = '';
  const r = await call('/api/routines');
  assert.equal(r.status, 401);
  token = saved;
});

await t('P1 日常: 列表带进度字段', async () => {
  const r = await call('/api/routines');
  assert.equal(r.body.data.items.length, 2);
  const first = r.body.data.items[0];
  assert.equal(first.period_done, 0);
  assert.equal(first.period_met, false);
  assert.equal(first.checked_today, false);
  assert.ok('period_from' in first && 'period_to' in first);
});

await t('P1 日常: 打卡', async () => {
  const list = await call('/api/routines');
  const id = list.body.data.items[0].id;
  const r = await call(`/api/routines/${id}/check`, { method: 'POST', body: '{}' });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.checked, true);
});

await t('P1 日常: 重复打卡幂等（不写第二行）', async () => {
  const list = await call('/api/routines');
  const id = list.body.data.items[0].id;
  const before = await call(`/api/routines/${id}/logs`);
  await call(`/api/routines/${id}/check`, { method: 'POST', body: '{}' });
  const after = await call(`/api/routines/${id}/logs`);
  assert.equal(after.body.data.items.length, before.body.data.items.length);
});

await t('P1 日常: 打卡后进度变为已达标', async () => {
  const list = await call('/api/routines');
  const first = list.body.data.items[0];
  assert.equal(first.checked_today, true);
  assert.equal(first.period_done, 1);
  assert.equal(first.period_met, true);
});

await t('P1 日常: 取消打卡', async () => {
  const list = await call('/api/routines');
  const id = list.body.data.items[0].id;
  const r = await call(`/api/routines/${id}/check`, { method: 'DELETE' });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.checked, false);
  const after = await call('/api/routines');
  assert.equal(after.body.data.items[0].checked_today, false);
});

await t('P1 日常: 停用后不在默认列表', async () => {
  const list = await call('/api/routines');
  const id = list.body.data.items[0].id;
  const r = await call(`/api/routines/${id}/active`, {
    method: 'PATCH',
    body: JSON.stringify({ is_active: 0 }),
  });
  assert.equal(r.body.data.is_active, 0);
  const def = await call('/api/routines');
  assert.ok(!def.body.data.items.some((x: any) => x.id === id));
  // 但 include_inactive=1 能看到
  const all = await call('/api/routines?include_inactive=1');
  assert.ok(all.body.data.items.some((x: any) => x.id === id));
});

await t('P1 日常: 重新启用', async () => {
  const all = await call('/api/routines?include_inactive=1');
  const id = all.body.data.items[0].id;
  await call(`/api/routines/${id}/active`, {
    method: 'PATCH',
    body: JSON.stringify({ is_active: 1 }),
  });
  const def = await call('/api/routines');
  assert.ok(def.body.data.items.some((x: any) => x.id === id));
});

await t('P1 日常: 修改名称与目标', async () => {
  const list = await call('/api/routines');
  const id = list.body.data.items[0].id;
  const r = await call(`/api/routines/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name: '改过的习惯', cadence: 'daily', target_per_period: 2 }),
  });
  assert.equal(r.body.data.name, '改过的习惯');
  assert.equal(r.body.data.target_per_period, 2);
});

await t('P1 日常: 非法打卡日期被拒', async () => {
  const list = await call('/api/routines');
  const id = list.body.data.items[0].id;
  const r = await call(`/api/routines/${id}/check`, {
    method: 'POST',
    body: JSON.stringify({ day: '2026/01/01' }),
  });
  assert.equal(r.body.error.code, 'INVALID_DAY');
});

await t('P1 日常: 操作不存在的习惯 404', async () => {
  const r = await call('/api/routines/9999/check', { method: 'POST', body: '{}' });
  assert.equal(r.status, 404);
});

await t('P1 日常: 删除连带清掉打卡记录', async () => {
  const list = await call('/api/routines');
  const id = list.body.data.items[0].id;
  // 先打一天卡，确保有日志
  await call(`/api/routines/${id}/check`, { method: 'POST', body: '{}' });
  const logs = await call(`/api/routines/${id}/logs`);
  assert.ok(logs.body.data.items.length > 0);

  const d = await call(`/api/routines/${id}`, { method: 'DELETE' });
  assert.equal(d.body.ok, true);
  const after = await call('/api/routines?include_inactive=1');
  assert.ok(!after.body.data.items.some((x: any) => x.id === id));
  const logsAfter = await call(`/api/routines/${id}/logs`);
  assert.equal(logsAfter.body.data.items.length, 0);
});

// ---- 分类与账户管理 ----
await t('P1 账户: 新增', async () => {
  const r = await call('/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ name: '招行信用卡', kind: 'credit' }),
  });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.name, '招行信用卡');
  assert.equal(r.body.data.kind, 'credit');
  // 新增后应出现在列表里
  const list = await call('/api/accounts');
  assert.ok(list.body.data.items.some((a: any) => a.name === '招行信用卡'));
});

await t('P1 账户: 空名被拒', async () => {
  const r = await call('/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ name: '  ' }),
  });
  assert.equal(r.body.error.code, 'EMPTY_NAME');
});

await t('P1 账户: 非法类型被拒', async () => {
  const r = await call('/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ name: 'x', kind: 'crypto' }),
  });
  assert.equal(r.body.error.code, 'INVALID_KIND');
});

await t('P1 账户: 负余额被拒', async () => {
  const r = await call('/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ name: 'x', balance_cents: -1 }),
  });
  assert.equal(r.body.error.code, 'INVALID_BALANCE');
});

await t('P1 账户: 重名被拒', async () => {
  const r = await call('/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ name: '招行信用卡' }),
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'DUPLICATE_NAME');
});

await t('P1 分类: 新增', async () => {
  const r = await call('/api/categories', {
    method: 'POST',
    body: JSON.stringify({ name: '宠物', kind: 'expense', icon: '🐱' }),
  });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.name, '宠物');
  assert.equal(r.body.data.icon, '🐱');
});
await t('P1 分类: 空名被拒', async () => {
  const r = await call('/api/categories', {
    method: 'POST',
    body: JSON.stringify({ name: '' }),
  });
  assert.equal(r.body.error.code, 'EMPTY_NAME');
});

await t('P1 分类: 非法类型被拒', async () => {
  const r = await call('/api/categories', {
    method: 'POST',
    body: JSON.stringify({ name: 'x', kind: 'transfer' }),
  });
  assert.equal(r.body.error.code, 'INVALID_KIND');
});

await t('P1 分类: 同名同类型被拒', async () => {
  const r = await call('/api/categories', {
    method: 'POST',
    body: JSON.stringify({ name: '宠物', kind: 'expense' }),
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'DUPLICATE_NAME');
});

await t('P1 分类: 修改', async () => {
  const list = await call('/api/categories');
  const pet = list.body.data.items.find((c: any) => c.name === '宠物');
  assert.ok(pet, '应能找到刚新增的分类');
  const r = await call(`/api/categories/${pet.id}`, {
    method: 'PUT',
    body: JSON.stringify({ name: '宠物用品', kind: 'expense', icon: '🐾' }),
  });
  assert.equal(r.body.data.name, '宠物用品');
});

await t('P1 分类: 无流水引用时可删除', async () => {
  const list = await call('/api/categories');
  const pet = list.body.data.items.find((c: any) => c.name === '宠物用品');
  const r = await call(`/api/categories/${pet.id}`, { method: 'DELETE' });
  assert.equal(r.body.ok, true);
  const after = await call('/api/categories');
  assert.ok(!after.body.data.items.some((c: any) => c.id === pet.id));
});

await t('P1 分类: 有流水引用时拒绝删除', async () => {
  // 先记一笔用「餐饮」分类的账
  await call('/api/txns', {
    method: 'POST',
    body: JSON.stringify({ type: 'expense', amount: '10', account_id: 1, category_id: 1 }),
  });
  const r = await call('/api/categories/1', { method: 'DELETE' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'CATEGORY_IN_USE');
});

// ---- 全局搜索 ----
await t('P1 搜索: 空关键词被拒', async () => {
  const r = await call('/api/search?q=');
  assert.equal(r.body.error.code, 'EMPTY_QUERY');
});

await t('P1 搜索: 超长关键词被拒', async () => {
  const r = await call(`/api/search?q=${'x'.repeat(41)}`);
  assert.equal(r.body.error.code, 'QUERY_TOO_LONG');
});

await t('P1 搜索: 命中记账', async () => {
  // 先记一笔带商户的账
  await call('/api/txns', {
    method: 'POST',
    body: JSON.stringify({
      type: 'expense',
      amount: '25.5',
      account_id: 1,
      merchant: '瑞幸咖啡测试',
    }),
  });
  const r = await call(`/api/search?q=${encodeURIComponent('瑞幸')}`);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.data.txns.length > 0, '应搜到记账');
  assert.equal(r.body.data.txns[0].merchant, '瑞幸咖啡测试');
});

await t('P1 搜索: 命中任务', async () => {
  await call('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ title: '搜索测试任务' }),
  });
  const r = await call(`/api/search?q=${encodeURIComponent('搜索测试')}`);
  assert.ok(r.body.data.tasks.length > 0, '应搜到任务');
});

await t('P1 搜索: 命中运动备注', async () => {
  await call('/api/workouts', {
    method: 'POST',
    body: JSON.stringify({ kind: 'run', duration_min: 30, note: '搜索测试跑步' }),
  });
  const r = await call(`/api/search?q=${encodeURIComponent('搜索测试')}`);
  assert.ok(r.body.data.workouts.length > 0, '应搜到运动');
});

await t('P1 搜索: 无结果时 total 为 0', async () => {
  const r = await call(`/api/search?q=${encodeURIComponent('绝不存在的关键词zzz')}`);
  assert.equal(r.body.data.total, 0);
  assert.equal(r.body.data.txns.length, 0);
});

await t('P1 搜索: 未登录被拒', async () => {
  const saved = token;
  token = '';
  const r = await call('/api/search?q=x');
  assert.equal(r.status, 401);
  token = saved;
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
