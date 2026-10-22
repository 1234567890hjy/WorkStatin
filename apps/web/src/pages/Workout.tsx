import { useEffect, useState } from 'react';
import { api, ApiError, type Workout, type WorkoutKind, type WorkoutStats } from '../api';
import type { AppData } from '../App';

const KINDS: { key: WorkoutKind; label: string; icon: string }[] = [
  { key: 'run', label: '跑步', icon: '🏃' },
  { key: 'walk', label: '快走', icon: '🚶' },
  { key: 'cycle', label: '骑行', icon: '🚴' },
  { key: 'gym', label: '健身', icon: '🏋️' },
  { key: 'swim', label: '游泳', icon: '🏊' },
  { key: 'other', label: '其他', icon: '🤸' },
];

const KIND_MAP = Object.fromEntries(KINDS.map((k) => [k.key, k])) as Record<
  WorkoutKind,
  (typeof KINDS)[number]
>;

export default function WorkoutPage({ data: _data }: { data: AppData }) {
  const [kind, setKind] = useState<WorkoutKind>('run');
  const [duration, setDuration] = useState('');
  const [distance, setDistance] = useState('');
  const [calories, setCalories] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [list, setList] = useState<Workout[]>([]);
  const [stats, setStats] = useState<WorkoutStats | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    Promise.all([
      api.get<{ items: Workout[] }>('/workouts?limit=50'),
      api.get<WorkoutStats>('/workouts/stats?days=7'),
    ])
      .then(([l, s]) => {
        setList(l.items);
        setStats(s);
      })
      .catch(() => {
        setList([]);
        setStats(null);
      });
  }, [reloadKey]);

  async function submit() {
    const d = Number(duration);
    if (!Number.isInteger(d) || d <= 0) {
      setMsg({ type: 'err', text: '请填写有效时长（分钟）' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api.post('/workouts', {
        kind,
        duration_min: d,
        distance_m: distance ? Math.round(Number(distance) * 1000) : undefined,
        calories: calories ? Number(calories) : undefined,
        note: note.trim() || undefined,
      });
      setDuration('');
      setDistance('');
      setCalories('');
      setNote('');
      setMsg({ type: 'ok', text: '已记录' });
      setReloadKey((k) => k + 1);
    } catch (e) {
      setMsg({ type: 'err', text: e instanceof ApiError ? e.message : '保存失败' });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    try {
      await api.del(`/workouts/${id}`);
      setReloadKey((k) => k + 1);
    } catch {
      setMsg({ type: 'err', text: '删除失败' });
    }
  }

  const maxMinutes = Math.max(1, ...(stats?.by_day.map((d) => d.minutes) ?? [1]));

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 pt-6">
      <h1 className="text-lg font-semibold text-ink-900">运动</h1>

      {/* 近 7 天概览 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="text-xs text-ink-500">近 7 天</p>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="tabular text-2xl font-semibold text-ink-900">
            {stats?.minutes ?? 0}
          </span>
          <span className="text-sm text-ink-500">分钟 · {stats?.count ?? 0} 次</span>
        </div>
        <div className="mt-2 flex gap-4 text-xs text-ink-500">
          <span>
            距离{' '}
            {stats && stats.distance_m > 0
              ? `${(stats.distance_m / 1000).toFixed(1)} km`
              : '—'}
          </span>
          <span>消耗 {stats?.calories || '—'} kcal</span>
        </div>

        {/* 简易柱状图 */}
        {stats && stats.by_day.length > 0 && (
          <div className="mt-3 flex h-16 items-end gap-1">
            {stats.by_day.map((d) => (
              <div key={d.occurred_day} className="flex flex-1 flex-col items-center gap-1">
                <div
                  className="w-full rounded-t bg-ink-900/80"
                  style={{ height: `${Math.max(4, (d.minutes / maxMinutes) * 52)}px` }}
                  title={`${d.occurred_day}: ${d.minutes} 分钟`}
                />
                <span className="text-[10px] text-ink-500">{d.occurred_day.slice(5)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 录入 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="mb-2 text-xs text-ink-500">类型</p>
        <div className="flex flex-wrap gap-2">
          {KINDS.map((k) => (
            <button
              key={k.key}
              onClick={() => setKind(k.key)}
              className={`rounded-full px-3 py-1.5 text-sm transition ${
                kind === k.key ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700'
              }`}
            >
              {k.icon} {k.label}
            </button>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <label className="block">
            <span className="text-xs text-ink-500">时长(分)</span>
            <input
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              inputMode="numeric"
              placeholder="30"
              className="tabular mt-1 w-full rounded-lg border border-ink-100 px-2 py-2 text-center text-sm outline-none focus:border-ink-300"
            />
          </label>
          <label className="block">
            <span className="text-xs text-ink-500">距离(km)</span>
            <input
              value={distance}
              onChange={(e) => setDistance(e.target.value)}
              inputMode="decimal"
              placeholder="可选"
              className="tabular mt-1 w-full rounded-lg border border-ink-100 px-2 py-2 text-center text-sm outline-none focus:border-ink-300"
            />
          </label>
          <label className="block">
            <span className="text-xs text-ink-500">消耗(kcal)</span>
            <input
              value={calories}
              onChange={(e) => setCalories(e.target.value)}
              inputMode="numeric"
              placeholder="可选"
              className="tabular mt-1 w-full rounded-lg border border-ink-100 px-2 py-2 text-center text-sm outline-none focus:border-ink-300"
            />
          </label>
        </div>

        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="备注（可选）"
          className="mt-2 w-full rounded-lg border border-ink-100 px-3 py-2 text-sm outline-none focus:border-ink-300"
        />

        {msg && (
          <p className={`mt-2 text-sm ${msg.type === 'ok' ? 'text-emerald-600' : 'text-red-600'}`}>
            {msg.text}
          </p>
        )}

        <button
          onClick={submit}
          disabled={busy || !duration}
          className="mt-3 w-full rounded-lg bg-ink-900 py-2.5 font-medium text-white disabled:opacity-40"
        >
          {busy ? '保存中…' : '记录'}
        </button>
      </section>

      {/* 历史 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold text-ink-900">历史</h2>
        {list.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-500">还没有运动记录</p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {list.map((w) => {
              const k = KIND_MAP[w.kind] ?? { icon: '🤸', label: w.kind };
              return (
                <li key={w.id} className="flex items-center justify-between py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink-900">
                      {k.icon} {k.label} · {w.duration_min} 分钟
                    </p>
                    <p className="text-xs text-ink-500">
                      {w.occurred_day}
                      {w.distance_m ? ` · ${(w.distance_m / 1000).toFixed(2)} km` : ''}
                      {w.calories ? ` · ${w.calories} kcal` : ''}
                      {w.note ? ` · ${w.note}` : ''}
                    </p>
                  </div>
                  <button
                    onClick={() => remove(w.id)}
                    className="shrink-0 pl-3 text-xs text-ink-500 hover:text-red-600"
                    aria-label="删除"
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
