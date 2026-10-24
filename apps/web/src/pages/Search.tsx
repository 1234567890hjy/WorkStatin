import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import { formatYuanGrouped } from '../format';

/**
 * 全局搜索：一次搜遍记账、运动、视频、任务。
 *
 * 对应 worker 的 /api/search。这是业界工作台的标配
 * （gethomepage / Dashy / 飞书工作台都有），本项目此前只有视频模块内搜索。
 */

interface SearchResult {
  q: string;
  total: number;
  txns: {
    id: number;
    type: string;
    amount_cents: number;
    merchant: string | null;
    note: string | null;
    occurred_day: string;
  }[];
  workouts: {
    id: number;
    kind: string;
    duration_min: number;
    distance_m: number | null;
    note: string | null;
    occurred_day: string;
  }[];
  videos: {
    id: number;
    url: string;
    platform: string | null;
    title: string | null;
    author: string | null;
    status: string;
    tags: string | null;
  }[];
  tasks: {
    id: number;
    title: string;
    detail: string | null;
    status: string;
    priority: number;
    due_day: string | null;
  }[];
}

const WORKOUT_LABEL: Record<string, string> = {
  run: '跑步',
  walk: '快走',
  cycle: '骑行',
  gym: '健身',
  swim: '游泳',
  other: '其他',
};

const VIDEO_STATUS: Record<string, string> = {
  draft: '待转写',
  transcribed: '待摘要',
  summarized: '已摘要',
  archived: '已归档',
};

const TASK_STATUS: Record<string, string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  dropped: '已放弃',
};

export default function SearchPage() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // URL 上的 ?q= 直接触发搜索（从别处跳转过来时）
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('q');
    if (fromUrl) {
      setQ(fromUrl);
      void run(fromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(keyword: string) {
    const k = keyword.trim();
    if (!k) {
      setRes(null);
      return;
    }
    setBusy(true);
    setErrMsg(null);
    try {
      const r = await api.get<SearchResult>(`/search?q=${encodeURIComponent(k)}`);
      setRes(r);
    } catch (e) {
      setErrMsg(e instanceof ApiError ? e.message : '搜索失败');
      setRes(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 pt-6">
      <h1 className="text-lg font-semibold text-ink-900">搜索</h1>

      <div className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run(q);
          }}
          placeholder="搜记账、运动、视频、任务"
          autoFocus
          className="flex-1 rounded-lg border border-ink-100 px-3 py-2 text-sm outline-none focus:border-ink-300"
        />
        <button
          onClick={() => void run(q)}
          disabled={busy || !q.trim()}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? '…' : '搜索'}
        </button>
      </div>

      {errMsg && <p className="text-sm text-red-600">{errMsg}</p>}

      {res && res.total === 0 && (
        <p className="py-10 text-center text-sm text-ink-500">
          没有找到与「{res.q}」相关的内容
        </p>
      )}

      {res && res.total > 0 && (
        <>
          <p className="text-xs text-ink-500">共 {res.total} 条结果</p>

          {/* 记账 */}
          {res.txns.length > 0 && (
            <Group title="记账" count={res.txns.length} to="/txn">
              {res.txns.map((t) => (
                <li key={t.id} className="flex items-center justify-between py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink-900">
                      {t.merchant || t.note || '未命名'}
                    </p>
                    <p className="text-xs text-ink-500">{t.occurred_day}</p>
                  </div>
                  <span className="tabular shrink-0 pl-3 text-sm font-medium text-ink-900">
                    {t.type === 'expense' ? '-' : t.type === 'income' ? '+' : '↔'}¥
                    {formatYuanGrouped(t.amount_cents)}
                  </span>
                </li>
              ))}
            </Group>
          )}

          {/* 运动 */}
          {res.workouts.length > 0 && (
            <Group title="运动" count={res.workouts.length} to="/workout">
              {res.workouts.map((w) => (
                <li key={w.id} className="flex items-center justify-between py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink-900">
                      {WORKOUT_LABEL[w.kind] ?? w.kind} · {w.duration_min} 分钟
                    </p>
                    <p className="truncate text-xs text-ink-500">{w.note}</p>
                  </div>
                  <span className="shrink-0 pl-3 text-xs text-ink-500">{w.occurred_day}</span>
                </li>
              ))}
            </Group>
          )}

          {/* 视频 */}
          {res.videos.length > 0 && (
            <Group title="视频学习" count={res.videos.length} to="/video">
              {res.videos.map((v) => (
                <li key={v.id} className="py-2">
                  <p className="truncate text-sm text-ink-900">{v.title || '（无标题）'}</p>
                  <p className="truncate text-xs text-ink-500">
                    {v.author ? `${v.author} · ` : ''}
                    {VIDEO_STATUS[v.status] ?? v.status}
                    {v.tags ? ` · ${v.tags}` : ''}
                  </p>
                </li>
              ))}
            </Group>
          )}

          {/* 任务 */}
          {res.tasks.length > 0 && (
            <Group title="任务" count={res.tasks.length} to="/tasks">
              {res.tasks.map((t) => (
                <li key={t.id} className="py-2">
                  <p
                    className={`truncate text-sm ${
                      t.status === 'done' || t.status === 'dropped'
                        ? 'text-ink-500 line-through'
                        : 'text-ink-900'
                    }`}
                  >
                    {t.title}
                  </p>
                  <p className="truncate text-xs text-ink-500">
                    {TASK_STATUS[t.status] ?? t.status}
                    {t.due_day ? ` · ${t.due_day}` : ''}
                    {t.detail ? ` · ${t.detail}` : ''}
                  </p>
                </li>
              ))}
            </Group>
          )}
        </>
      )}
    </div>
  );
}

function Group({
  title,
  count,
  to,
  children,
}: {
  title: string;
  count: number;
  to: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-ink-900">
          {title} <span className="text-xs text-ink-500">{count}</span>
        </h2>
        <Link to={to} className="text-xs text-ink-500">
          查看全部 →
        </Link>
      </div>
      <ul className="divide-y divide-ink-100">{children}</ul>
    </section>
  );
}
