import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Dashboard, type Txn } from '../api';
import { formatYuanGrouped } from '../format';
import type { AppData } from '../App';

export default function DashboardPage({ data }: { data: AppData }) {
  const [d, setD] = useState<Dashboard | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Dashboard>('/dashboard')
      .then(setD)
      .catch((e: Error) => setErr(e.message));
  }, []);

  if (err) return <Centered>{err}</Centered>;
  if (!d) return <Centered>加载中…</Centered>;

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 pt-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink-900">概览</h1>
          <p className="text-xs text-ink-500">{d.day}</p>
        </div>
        <Link
          to="/txn"
          className="rounded-full bg-ink-900 px-4 py-1.5 text-sm font-medium text-white"
        >
          记一笔
        </Link>
      </header>

      {/* 本月收支 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="text-xs text-ink-500">{d.month} 本月支出</p>
        <p className="tabular mt-1 text-3xl font-semibold text-ink-900">
          ¥{formatYuanGrouped(d.month_stats.expense_cents)}
        </p>
        <div className="mt-3 flex gap-6 text-sm">
          <div>
            <p className="text-xs text-ink-500">收入</p>
            <p className="tabular font-medium text-emerald-600">
              ¥{formatYuanGrouped(d.month_stats.income_cents)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-500">今日支出</p>
            <p className="tabular font-medium text-ink-900">
              ¥{formatYuanGrouped(d.today_stats.expense_cents)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-500">今日笔数</p>
            <p className="tabular font-medium text-ink-900">{d.today_stats.count}</p>
          </div>
        </div>
      </section>

      {/* 卡片区 */}
      <section className="grid grid-cols-2 gap-3">
        <Card title="净资产" value={`¥${formatYuanGrouped(d.net_worth_cents)}`} hint="手动维护" />
        <Card
          title="近 7 天运动"
          value={`${d.workout_7d.minutes} 分钟`}
          hint={`${d.workout_7d.count} 次`}
        />
        <Card title="待办任务" value={`${d.open_tasks}`} hint="未完成" />
        <Card title="天气" value="—" hint="P1 接入" />
      </section>

      {/* 最近流水 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-ink-900">最近流水</h2>
        {d.recent_txns.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-500">还没有记录，去记第一笔吧</p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {d.recent_txns.map((t) => (
              <TxnRow key={t.id} t={t} />
            ))}
          </ul>
        )}
      </section>

      <p className="pb-4 text-center text-xs text-ink-500">
        共 {data.accounts.length} 个账户 · {data.categories.length} 个分类
      </p>
    </div>
  );
}

function TxnRow({ t }: { t: Txn }) {
  const sign = t.type === 'expense' ? '-' : t.type === 'income' ? '+' : '↔';
  const color =
    t.type === 'expense' ? 'text-ink-900' : t.type === 'income' ? 'text-emerald-600' : 'text-blue-600';
  const label = t.merchant || t.category_name || t.note || '未命名';

  return (
    <li className="flex items-center justify-between py-2.5">
      <div className="min-w-0">
        <p className="truncate text-sm text-ink-900">{label}</p>
        <p className="text-xs text-ink-500">
          {t.occurred_day} · {t.account_name ?? ''}
          {t.category_name ? ` · ${t.category_name}` : ''}
        </p>
      </div>
      <span className={`tabular shrink-0 pl-3 text-sm font-medium ${color}`}>
        {sign}¥{formatYuanGrouped(t.amount_cents)}
      </span>
    </li>
  );
}

function Card({ title, value, hint }: { title: string; value: string; hint: string }) {
  return (
    <div className="rounded-2xl bg-white p-3.5 shadow-sm">
      <p className="text-xs text-ink-500">{title}</p>
      <p className="tabular mt-1 truncate text-lg font-semibold text-ink-900">{value}</p>
      <p className="text-xs text-ink-500">{hint}</p>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-64 items-center justify-center text-sm text-ink-500">{children}</div>
  );
}
