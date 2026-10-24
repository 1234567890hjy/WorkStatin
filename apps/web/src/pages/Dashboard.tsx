import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Dashboard, type Txn, type Workout } from '../api';import { formatYuanGrouped } from '../format';
import type { AppData } from '../App';
import WeatherCard from '../components/WeatherCard';

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
        <div className="flex gap-2">
          <Link
            to="/search"
            className="rounded-full border border-ink-300 px-3 py-1.5 text-sm font-medium text-ink-700"
          >
            🔍 搜索
          </Link>
          <Link
            to="/tasks"
            className="rounded-full border border-ink-300 px-3 py-1.5 text-sm font-medium text-ink-700"
          >
            计划
          </Link>
          <Link
            to="/txn"
            className="rounded-full bg-ink-900 px-4 py-1.5 text-sm font-medium text-white"
          >
            记一笔
          </Link>
        </div>
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
        <Link to="/settings" className="contents">
          <Card
            title="净资产"
            value={`¥${formatYuanGrouped(d.net_worth_cents)}`}
            hint="点击维护余额"
          />
        </Link>
        <Link to="/workout" className="contents">
          <Card
            title="近 7 天运动"
            value={`${d.workout_7d.minutes} 分钟`}
            hint={`${d.workout_7d.count} 次`}
          />
        </Link>
        <Link to="/tasks" className="contents">
          <Card
            title="待办任务"
            value={`${d.open_tasks} 项`}
            hint={
              d.tasks_overdue > 0
                ? `${d.tasks_overdue} 项已逾期`
                : d.tasks_today > 0
                  ? `今天到期 ${d.tasks_today} 项`
                  : '无近期到期'
            }
          />
        </Link>
        <Link to="/routines" className="contents">
          <Card
            title="今日打卡"
            value={`${d.routines_today_done ?? 0}/${d.routines_today_total ?? 0}`}
            hint={
              (d.routines_today_total ?? 0) === 0
                ? '还没有习惯'
                : (d.routines_today_done ?? 0) >= (d.routines_today_total ?? 0)
                  ? '今天全完成了 🎉'
                  : '去打卡 →'
            }
          />
        </Link>
        <WeatherCard />
        <Link to="/video" className="contents">
          <Card
            title="视频学习"
            value={`${d.video_stats?.pending ?? 0} 待处理`}
            hint={`已摘要 ${d.video_stats?.done ?? 0} 条`}
          />
        </Link>
      </section>

      {/* 近期待办 */}
      {d.recent_tasks && d.recent_tasks.length > 0 && (
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-ink-900">近期待办</h2>
            <Link to="/tasks" className="text-xs text-ink-500">
              全部 →
            </Link>
          </div>
          <ul className="divide-y divide-ink-100">
            {d.recent_tasks.map((t) => {
              const late = t.due_day && t.due_day < d.day;
              const isToday = t.due_day === d.day;
              return (
                <li key={t.id} className="flex items-center justify-between gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-900">{t.title}</span>
                  {t.due_day && (
                    <span
                      className={`shrink-0 text-xs ${
                        late ? 'font-medium text-red-600' : isToday ? 'text-amber-700' : 'text-ink-500'
                      }`}
                    >
                      {late ? `逾期 ${t.due_day.slice(5)}` : isToday ? '今天' : t.due_day.slice(5)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* 最近运动 */}
      {d.recent_workouts && d.recent_workouts.length > 0 && (
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-ink-900">最近运动</h2>
          <ul className="divide-y divide-ink-100">
            {d.recent_workouts.map((w: Workout) => (
              <li key={w.id} className="flex items-center justify-between py-2">
                <span className="text-sm text-ink-900">
                  {workoutLabel(w.kind)} · {w.duration_min} 分钟
                </span>
                <span className="text-xs text-ink-500">{w.occurred_day}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

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

function workoutLabel(kind: string): string {
  const map: Record<string, string> = {
    run: '🏃 跑步',
    walk: '🚶 快走',
    cycle: '🚴 骑行',
    gym: '🏋️ 健身',
    swim: '🏊 游泳',
    other: '🤸 其他',
  };
  return map[kind] ?? kind;
}
