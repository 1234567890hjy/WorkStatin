import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type Task, type TaskPriority, type TaskStatus } from '../api';
import type { AppData } from '../App';

/**
 * 计划与任务。
 *
 * 对应 worker 的 /api/tasks。表在 0001_init.sql 里就建好了，
 * Dashboard 也早就在返回 open_tasks，这个页面把它接完。
 *
 * 交互取向：新增要快（一个输入框 + 回车），完成要更快（点一下打勾）。
 */

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  dropped: '已放弃',
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  1: '高',
  2: '中',
  3: '低',
};

const FILTERS: { key: 'open' | 'today' | 'overdue' | 'done'; label: string }[] = [
  { key: 'open', label: '未完成' },
  { key: 'today', label: '今天' },
  { key: 'overdue', label: '已逾期' },
  { key: 'done', label: '已完成' },
];

export default function TaskPage({ data: _data }: { data: AppData }) {
  const [items, setItems] = useState<Task[]>([]);
  const [today, setToday] = useState('');
  const [filter, setFilter] = useState<'open' | 'today' | 'overdue' | 'done'>('open');

  // 新增表单
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<TaskPriority>(2);
  const [dueDay, setDueDay] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // 编辑
  const [editing, setEditing] = useState<Task | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const params = new URLSearchParams();
    if (filter === 'today') params.set('due', 'today');
    else if (filter === 'overdue') params.set('due', 'overdue');
    else if (filter === 'done') params.set('status', 'done');
    if (filter === 'open') params.set('include_closed', '0');

    api
      .get<{ items: Task[]; today: string }>(`/tasks?${params.toString()}`)
      .then((r) => {
        setItems(r.items);
        setToday(r.today);
      })
      .catch(() => setItems([]));
  }, [reloadKey, filter]);

  const overdueCount = useMemo(
    () => items.filter((t) => t.due_day && t.due_day < today && t.status !== 'done').length,
    [items, today],
  );

  async function add() {
    const t = title.trim();
    if (!t) {
      setMsg({ type: 'err', text: '请填写任务标题' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api.post('/tasks', {
        title: t,
        priority,
        due_day: dueDay || undefined,
      });
      setTitle('');
      setDueDay('');
      setMsg({ type: 'ok', text: '已添加' });
      setReloadKey((k) => k + 1);
    } catch (e) {
      setMsg({ type: 'err', text: e instanceof ApiError ? e.message : '添加失败' });
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: number, status: TaskStatus) {
    try {
      await api.patch(`/tasks/${id}/status`, { status });
      setReloadKey((k) => k + 1);
    } catch (e) {
      setMsg({ type: 'err', text: e instanceof ApiError ? e.message : '操作失败' });
    }
  }

  async function remove(id: number) {
    try {
      await api.del(`/tasks/${id}`);
      setReloadKey((k) => k + 1);
    } catch {
      setMsg({ type: 'err', text: '删除失败' });
    }
  }

  if (editing) {
    return (
      <TaskEditor
        task={editing}
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
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-ink-900">计划</h1>
        {overdueCount > 0 && (
          <span className="text-xs font-medium text-red-600">{overdueCount} 项已逾期</span>
        )}
      </div>

      {/* 任务 / 日常 切换 */}
      <div className="flex gap-1 rounded-lg bg-ink-100 p-1">
        <Link
          to="/tasks"
          className="flex-1 rounded-md bg-white py-1.5 text-center text-xs font-medium text-ink-900 shadow-sm"
        >
          任务
        </Link>
        <Link
          to="/routines"
          className="flex-1 rounded-md py-1.5 text-center text-xs font-medium text-ink-500"
        >
          日常打卡
        </Link>
      </div>

      {/* 新增 */}
      <section className="space-y-2 rounded-2xl bg-white p-4 shadow-sm">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
          placeholder="要做什么？回车快速添加"
          className="w-full rounded-lg border border-ink-100 px-3 py-2 text-sm outline-none focus:border-ink-300"
        />
        <div className="flex items-center gap-2">
          <div className="flex flex-1 gap-1">
            {([1, 2, 3] as TaskPriority[]).map((p) => (
              <button
                key={p}
                onClick={() => setPriority(p)}
                className={`flex-1 rounded-md py-1 text-xs transition ${
                  priority === p ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-600'
                }`}
              >
                {PRIORITY_LABEL[p]}
              </button>
            ))}
          </div>
          <input
            type="date"
            value={dueDay}
            onChange={(e) => setDueDay(e.target.value)}
            className="rounded-lg border border-ink-100 px-2 py-1 text-xs outline-none focus:border-ink-300"
          />
          <button
            onClick={() => void add()}
            disabled={busy || !title.trim()}
            className="rounded-lg bg-ink-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? '…' : '添加'}
          </button>
        </div>
        {msg && (
          <p className={`text-xs ${msg.type === 'ok' ? 'text-emerald-600' : 'text-red-600'}`}>
            {msg.text}
          </p>
        )}
      </section>

      {/* 筛选 */}
      <div className="flex gap-1 rounded-lg bg-ink-100 p-1">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${
              filter === f.key ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* 列表 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        {items.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-500">
            {filter === 'done' ? '还没有完成的任务' : '没有任务，添加一个吧'}
          </p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {items.map((t) => (
              <li key={t.id} className="flex items-start gap-3 py-2.5">
                <button
                  onClick={() => void setStatus(t.id, t.status === 'done' ? 'todo' : 'done')}
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${
                    t.status === 'done'
                      ? 'border-emerald-600 bg-emerald-600 text-white'
                      : 'border-ink-300 text-transparent'
                  }`}
                  aria-label={t.status === 'done' ? '标记为未完成' : '标记为完成'}
                >
                  ✓
                </button>

                <div className="min-w-0 flex-1">
                  <button
                    onClick={() => setEditing(t)}
                    className="block w-full text-left"
                  >
                    <p
                      className={`truncate text-sm ${
                        t.status === 'done'
                          ? 'text-ink-500 line-through'
                          : t.status === 'dropped'
                            ? 'text-ink-500 line-through'
                            : 'text-ink-900'
                      }`}
                    >
                      {t.title}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-500">
                      {t.status !== 'done' && (
                        <span
                          className={`rounded px-1 py-px ${
                            t.priority === 1
                              ? 'bg-red-100 text-red-700'
                              : t.priority === 3
                                ? 'bg-ink-100 text-ink-600'
                                : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {PRIORITY_LABEL[t.priority]}
                        </span>
                      )}
                      {t.due_day && (
                        <span
                          className={
                            t.due_day < today && t.status !== 'done'
                              ? 'font-medium text-red-600'
                              : t.due_day === today && t.status !== 'done'
                                ? 'font-medium text-amber-700'
                                : ''
                          }
                        >
                          {t.due_day === today && t.status !== 'done'
                            ? '今天'
                            : t.due_day < today && t.status !== 'done'
                              ? `逾期 ${t.due_day}`
                              : t.due_day}
                        </span>
                      )}
                      {t.status === 'doing' && <span>· {STATUS_LABEL.doing}</span>}
                      {t.status === 'dropped' && <span>· {STATUS_LABEL.dropped}</span>}
                      {t.detail && <span>· 有备注</span>}
                    </p>
                  </button>
                </div>

                <button
                  onClick={() => void remove(t.id)}
                  className="shrink-0 pt-0.5 text-xs text-ink-500 hover:text-red-600"
                  aria-label="删除"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function TaskEditor({
  task,
  onCancel,
  onSaved,
}: {
  task: Task;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [detail, setDetail] = useState(task.detail ?? '');
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [dueDay, setDueDay] = useState(task.due_day ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    if (!title.trim()) {
      setMsg('标题不能为空');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api.put(`/tasks/${task.id}`, {
        title: title.trim(),
        detail: detail.trim() || null,
        priority,
        status,
        due_day: dueDay || null,
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

      <h1 className="text-lg font-semibold text-ink-900">编辑任务</h1>

      <section className="space-y-3 rounded-2xl bg-white p-4 shadow-sm">
        <label className="block">
          <span className="text-xs text-ink-500">标题</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-1 w-full rounded-lg border border-ink-100 px-3 py-2 text-sm outline-none focus:border-ink-300"
          />
        </label>

        <label className="block">
          <span className="text-xs text-ink-500">备注</span>
          <textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            rows={4}
            className="mt-1 w-full resize-y rounded-lg border border-ink-100 px-3 py-2 text-sm outline-none focus:border-ink-300"
          />
        </label>

        <div>
          <p className="text-xs text-ink-500">优先级</p>
          <div className="mt-1 flex gap-1">
            {([1, 2, 3] as TaskPriority[]).map((p) => (
              <button
                key={p}
                onClick={() => setPriority(p)}
                className={`flex-1 rounded-md py-1.5 text-xs transition ${
                  priority === p ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-600'
                }`}
              >
                {PRIORITY_LABEL[p]}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="text-xs text-ink-500">状态</p>
          <div className="mt-1 flex gap-1">
            {(['todo', 'doing', 'done', 'dropped'] as TaskStatus[]).map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`flex-1 rounded-md py-1.5 text-xs transition ${
                  status === s ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-600'
                }`}
              >
                {STATUS_LABEL[s]}
              </button>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="text-xs text-ink-500">截止日</span>
          <input
            type="date"
            value={dueDay}
            onChange={(e) => setDueDay(e.target.value)}
            className="mt-1 w-full rounded-lg border border-ink-100 px-3 py-2 text-sm outline-none focus:border-ink-300"
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
