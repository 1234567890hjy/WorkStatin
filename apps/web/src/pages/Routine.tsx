import { useEffect, useState } from 'react';
import { api, ApiError, type Cadence, type Routine } from '../api';
import type { AppData } from '../App';

/**
 * 日常管理（习惯打卡）。
 *
 * 对应 worker 的 /api/routines。表在 0001_init.sql 里就建好了，
 * 一直没有路由和页面 —— 这是「半成品裸露」，本页面补完。
 *
 * 交互：点一下打勾，再点一下取消。周/月目标显示「已做/目标」。
 */

const CADENCE_LABEL: Record<Cadence, string> = {
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
};

const PERIOD_HINT: Record<Cadence, string> = {
  daily: '今天',
  weekly: '本周',
  monthly: '本月',
};

export default function RoutinePage({ data: _data }: { data: AppData }) {
  const [items, setItems] = useState<Routine[]>([]);
  const [today, setToday] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  // 新增
  const [name, setName] = useState('');
  const [cadence, setCadence] = useState<Cadence>('daily');
  const [target, setTarget] = useState('1');
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // 编辑
  const [editing, setEditing] = useState<Routine | null>(null);

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    api
      .get<{ items: Routine[]; today: string }>('/routines?include_inactive=1')
      .then((r) => {
        setItems(r.items);
        setToday(r.today);
      })
      .catch(() => setItems([]));
  }, [reloadKey]);

  const active = items.filter((r) => r.is_active);
  const inactive = items.filter((r) => !r.is_active);

  async function add() {
    const n = name.trim();
    if (!n) {
      setMsg({ type: 'err', text: '请填写名称' });
      return;
    }
    setAdding(true);
    setMsg(null);
    try {
      await api.post('/routines', {
        name: n,
        cadence,
        target_per_period: Number(target) || 1,
      });
      setName('');
      setTarget('1');
      setMsg({ type: 'ok', text: '已添加' });
      setReloadKey((k) => k + 1);
    } catch (e) {
      setMsg({ type: 'err', text: e instanceof ApiError ? e.message : '添加失败' });
    } finally {
      setAdding(false);
    }
  }

  async function toggleCheck(r: Routine) {
    setBusyId(r.id);
    try {
      if (r.checked_today) {
        await api.del(`/routines/${r.id}/check`);
      } else {
        await api.post(`/routines/${r.id}/check`, {});
      }
      setReloadKey((k) => k + 1);
    } catch (e) {
      setMsg({ type: 'err', text: e instanceof ApiError ? e.message : '操作失败' });
    } finally {
      setBusyId(null);
    }
  }

  async function toggleActive(r: Routine) {
    setBusyId(r.id);
    try {
      await api.patch(`/routines/${r.id}/active`, { is_active: r.is_active ? 0 : 1 });
      setReloadKey((k) => k + 1);
    } catch {
      setMsg({ type: 'err', text: '操作失败' });
    } finally {
      setBusyId(null);
    }
  }

  async function remove(r: Routine) {
    if (!confirm(`删除「${r.name}」及其全部打卡记录？此操作不可恢复。\n\n如果只是想暂停，请用「停用」。`)) {
      return;
    }
    setBusyId(r.id);
    try {
      await api.del(`/routines/${r.id}`);
      setReloadKey((k) => k + 1);
    } catch {
      setMsg({ type: 'err', text: '删除失败' });
    } finally {
      setBusyId(null);
    }
  }

  if (editing) {
    return (
      <RoutineEditor
        routine={editing}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          setReloadKey((k) => k + 1);
        }}
      />
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 pt-6">
      <h1 className="text-lg font-semibold text-ink-900">日常</h1>

      {/* 新增 */}
      <section className="space-y-2 rounded-2xl bg-white p-4 shadow-sm">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
          placeholder="要养成的习惯，如「每天读书 30 分钟」"
          className="w-full rounded-lg border border-ink-100 px-3 py-2 text-sm outline-none focus:border-ink-300"
        />
        <div className="flex items-center gap-2">
          <div className="flex flex-1 gap-1">
            {(['daily', 'weekly', 'monthly'] as Cadence[]).map((c) => (
              <button
                key={c}
                onClick={() => setCadence(c)}
                className={`flex-1 rounded-md py-1 text-xs transition ${
                  cadence === c ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-600'
                }`}
              >
                {CADENCE_LABEL[c]}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1 text-xs text-ink-500">
            目标
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              inputMode="numeric"
              className="tabular w-10 rounded border border-ink-100 px-1 py-1 text-center text-xs outline-none focus:border-ink-300"
            />
            次
          </label>
          <button
            onClick={() => void add()}
            disabled={adding || !name.trim()}
            className="rounded-lg bg-ink-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {adding ? '…' : '添加'}
          </button>
        </div>
        {msg && (
          <p className={`text-xs ${msg.type === 'ok' ? 'text-emerald-600' : 'text-red-600'}`}>
            {msg.text}
          </p>
        )}
      </section>

      {/* 列表 */}
      {active.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-500">还没有习惯，添加一个吧</p>
      ) : (
        <ul className="space-y-2">
          {active.map((r) => (
            <li key={r.id} className="rounded-2xl bg-white p-4 shadow-sm">
              <div className="flex items-start gap-3">
                <button
                  onClick={() => void toggleCheck(r)}
                  disabled={busyId === r.id}
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${
                    r.checked_today
                      ? 'border-emerald-600 bg-emerald-600 text-white'
                      : 'border-ink-300 text-transparent'
                  } disabled:opacity-40`}
                  aria-label={r.checked_today ? '取消今天的打卡' : '今天打卡'}
                >
                  ✓
                </button>

                <div className="min-w-0 flex-1">
                  <button onClick={() => setEditing(r)} className="block w-full text-left">
                    <p className="text-sm font-medium text-ink-900">{r.name}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-500">
                      <span className="rounded bg-ink-100 px-1 py-px">
                        {CADENCE_LABEL[r.cadence]}
                      </span>
                      <span>
                        {PERIOD_HINT[r.cadence]} {r.period_done ?? 0}/{r.period_target ?? 1}
                      </span>
                      {r.period_met && (
                        <span className="font-medium text-emerald-600">已达标</span>
                      )}
                      {r.cadence === 'daily' && (r.streak ?? 0) > 1 && (
                        <span className="font-medium text-amber-700">
                          连续 {r.streak} 天
                        </span>
                      )}
                      <span>· 累计 {r.total_days ?? 0} 天</span>
                    </p>
                  </button>
                </div>

                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => void toggleActive(r)}
                    disabled={busyId === r.id}
                    className="text-xs text-ink-500 hover:text-ink-900 disabled:opacity-40"
                  >
                    停用
                  </button>
                  <button
                    onClick={() => void remove(r)}
                    disabled={busyId === r.id}
                    className="text-xs text-ink-500 hover:text-red-600 disabled:opacity-40"
                    aria-label="删除"
                  >
                    ✕
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 已停用 */}
      {inactive.length > 0 && (
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-xs font-semibold text-ink-500">已停用</h2>
          <ul className="divide-y divide-ink-100">
            {inactive.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2">
                <span className="text-sm text-ink-500">{r.name}</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => void toggleActive(r)}
                    className="text-xs text-ink-700"
                  >
                    启用
                  </button>
                  <button
                    onClick={() => void remove(r)}
                    className="text-xs text-ink-500 hover:text-red-600"
                    aria-label="删除"
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="pb-4 text-center text-xs text-ink-500">今天 {today}</p>
    </div>
  );
}

function RoutineEditor({
  routine,
  onCancel,
  onSaved,
}: {
  routine: Routine;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(routine.name);
  const [cadence, setCadence] = useState<Cadence>(routine.cadence);
  const [target, setTarget] = useState(String(routine.target_per_period));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) {
      setMsg('名称不能为空');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api.put(`/routines/${routine.id}`, {
        name: name.trim(),
        cadence,
        target_per_period: Number(target) || 1,
        is_active: routine.is_active,
      });
      onSaved();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 pt-6">
      <button onClick={onCancel} className="text-sm text-ink-500">
        ← 返回
      </button>

      <h1 className="text-lg font-semibold text-ink-900">编辑习惯</h1>

      <section className="space-y-3 rounded-2xl bg-white p-4 shadow-sm">
        <label className="block">
          <span className="text-xs text-ink-500">名称</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-ink-100 px-3 py-2 text-sm outline-none focus:border-ink-300"
          />
        </label>

        <div>
          <p className="text-xs text-ink-500">周期</p>
          <div className="mt-1 flex gap-1">
            {(['daily', 'weekly', 'monthly'] as Cadence[]).map((c) => (
              <button
                key={c}
                onClick={() => setCadence(c)}
                className={`flex-1 rounded-md py-1.5 text-xs transition ${
                  cadence === c ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-600'
                }`}
              >
                {CADENCE_LABEL[c]}
              </button>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="text-xs text-ink-500">每周期目标次数</span>
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            inputMode="numeric"
            className="tabular mt-1 w-full rounded-lg border border-ink-100 px-3 py-2 text-sm outline-none focus:border-ink-300"
          />
        </label>

        {msg && <p className="text-xs text-red-600">{msg}</p>}

        <button
          onClick={() => void save()}
          disabled={busy}
          className="w-full rounded-lg bg-ink-900 py-2.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? '保存中…' : '保存'}
        </button>
      </section>
    </div>
  );
}
