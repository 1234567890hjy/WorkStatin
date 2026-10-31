import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  api,
  ApiError,
  type NotifyHealth,
  type NotifyStatus,
  type PendingTxn,
  type RawNotification,
} from '../api';
import { formatYuanGrouped } from '../format';
import { channelLabel, reasonLabel } from '../notify-format';
import type { AppData } from '../App';

/**
 * 通知自动记账的收件箱。
 *
 * 两个区：
 *   ① 待确认 —— 解析成功但置信度不足，需要你点一下才入账
 *   ② 未识别 —— 解析不出金额，保留原文，可手动记一笔或忽略
 *
 * 为什么单独一页而不是塞进 Dashboard：
 *   待确认是「需要你决策」的东西，Dashboard 只负责提示有几个；
 *   真正处理时要看清金额、商户、渠道，塞在一张小卡片里放不下。
 */
export default function NotifyPage({ data }: { data: AppData }) {
  const nav = useNavigate();
  const [status, setStatus] = useState<NotifyStatus | null>(null);
  const [pending, setPending] = useState<PendingTxn[]>([]);
  const [raws, setRaws] = useState<RawNotification[]>([]);
  const [tab, setTab] = useState<'pending' | 'raw'>('pending');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [h, p, r] = await Promise.all([
        api.get<NotifyHealth>('/notify/health'),
        api.get<{ items: PendingTxn[]; total: number }>('/notify/pending'),
        api.get<{ items: RawNotification[]; new_count: number }>('/notify/raw'),
      ]);
      setStatus({
        pending_count: h.pending_count,
        raw_new_count: h.raw_new_count,
        healthy: h.healthy,
        heartbeat_age_hours: h.heartbeat_age_hours,
        heartbeat_timeout_hours: h.heartbeat_timeout_hours,
        has_device: Boolean(h.device),
        recent_auto_count: 0,
      });
      setPending(p.items);
      setRaws(r.items);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirm(item: PendingTxn, accountId: number) {
    setBusy(true);
    setMsg(null);
    try {
      await api.post(`/notify/pending/${item.id}/confirm`, {
        account_id: accountId,
        category_id: item.category_id ?? undefined,
      });
      await load();
      await data.reload();
      setMsg('已记账');
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '确认失败');
    } finally {
      setBusy(false);
    }
  }

  async function ignorePending(id: number) {
    setBusy(true);
    try {
      await api.del(`/notify/pending/${id}`);
      await load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '忽略失败');
    } finally {
      setBusy(false);
    }
  }

  async function ignoreRaw(id: number) {
    setBusy(true);
    try {
      await api.post(`/notify/raw/${id}/ignore`);
      await load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '忽略失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-3 px-4 pt-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink-900">通知收件箱</h1>
          <p className="text-xs text-ink-500">自动采集的消费记录</p>
        </div>
        <button onClick={() => nav('/')} className="text-xs text-ink-500">
          返回概览
        </button>
      </header>

      {/* 链路状态 */}
      <section
        className={`rounded-2xl p-3.5 text-sm ${
          status?.healthy ? 'bg-white shadow-sm' : 'bg-amber-50'
        }`}
      >
        {status?.healthy ? (
          <p className="text-ink-700">
            ✅ 采集链路正常
            {status.heartbeat_age_hours !== null && (
              <span className="text-ink-500">
                {' '}
                · {status.heartbeat_age_hours} 小时前有心跳
              </span>
            )}
          </p>
        ) : (
          <div>
            <p className="font-medium text-amber-800">⚠️ 采集可能已断开</p>
            <p className="mt-1 text-xs text-amber-700">
              {!status?.has_device
                ? '从未收到设备心跳。请打开手机上的「工作台通知采集」App 完成配置。'
                : `已 ${status?.heartbeat_age_hours ?? '?'} 小时无心跳（阈值 ${
                    status?.heartbeat_timeout_hours ?? 48
                  } 小时）。检查 App 是否被系统杀掉、或通知使用权被撤销。`}
            </p>
          </div>
        )}
      </section>

      {/* 切换 */}
      <div className="flex gap-2">
        <button
          onClick={() => setTab('pending')}
          className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
            tab === 'pending' ? 'bg-ink-900 text-white' : 'bg-white text-ink-700 shadow-sm'
          }`}
        >
          待确认 {pending.length > 0 && `(${pending.length})`}
        </button>
        <button
          onClick={() => setTab('raw')}
          className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
            tab === 'raw' ? 'bg-ink-900 text-white' : 'bg-white text-ink-700 shadow-sm'
          }`}
        >
          未识别 {raws.filter((r) => r.status === 'new').length > 0 &&
            `(${raws.filter((r) => r.status === 'new').length})`}
        </button>
      </div>

      {msg && <p className="text-sm text-emerald-700">{msg}</p>}

      {/* 待确认列表 */}
      {tab === 'pending' &&
        (pending.length === 0 ? (
          <Empty text="没有待确认的记录" hint="高置信度的通知会直接记账，只有识别不确定的才需要你确认" />
        ) : (
          <ul className="space-y-2">
            {pending.map((item) => (
              <PendingCard
                key={item.id}
                item={item}
                accounts={data.accounts}
                busy={busy}
                onConfirm={(accountId) => confirm(item, accountId)}
                onIgnore={() => ignorePending(item.id)}
              />
            ))}
          </ul>
        ))}

      {/* 未识别列表 */}
      {tab === 'raw' &&
        (raws.length === 0 ? (
          <Empty text="没有未识别的通知" hint="解析不出金额的通知会保留原文，方便你手动补记" />
        ) : (
          <ul className="space-y-2">
            {raws.map((r) => (
              <li key={r.id} className="rounded-2xl bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink-900">
                      {r.title || '(无标题)'}
                      <span className="ml-2 rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-normal text-ink-600">
                        {channelLabel(r.channel)}
                      </span>
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-all text-sm text-ink-700">
                      {r.body || '(无正文)'}
                    </p>
                    <p className="mt-1.5 text-xs text-ink-500">
                      {r.received_at} · {reasonLabel(r.reason)}
                    </p>
                  </div>
                </div>
                {r.status === 'new' && (
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => nav(`/txn?raw=${r.id}`)}
                      className="flex-1 rounded-lg bg-ink-900 py-2 text-sm text-white"
                    >
                      手动记一笔
                    </button>
                    <button
                      onClick={() => ignoreRaw(r.id)}
                      disabled={busy}
                      className="flex-1 rounded-lg border border-ink-300 py-2 text-sm text-ink-700 disabled:opacity-40"
                    >
                      忽略
                    </button>
                  </div>
                )}
                {r.status !== 'new' && (
                  <p className="mt-2 text-xs text-ink-400">
                    {r.status === 'ignored' ? '已忽略' : '已记账'}
                  </p>
                )}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

function PendingCard({
  item,
  accounts,
  busy,
  onConfirm,
  onIgnore,
}: {
  item: PendingTxn;
  accounts: AppData['accounts'];
  busy: boolean;
  onConfirm: (accountId: number) => void;
  onIgnore: () => void;
}) {
  // 默认选中记录里带的账户；没有则选第一个
  const [accountId, setAccountId] = useState<number>(
    item.account_id ?? accounts[0]?.id ?? 0,
  );
  const sign = item.type === 'expense' ? '-' : '+';
  const color = item.type === 'expense' ? 'text-ink-900' : 'text-emerald-600';

  return (
    <li className="rounded-2xl bg-white p-4 shadow-sm">
      <div className="flex items-baseline justify-between">
        <span className={`tabular text-xl font-semibold ${color}`}>
          {sign}¥{formatYuanGrouped(item.amount_cents)}
        </span>
        <span className="text-xs text-ink-500">{channelLabel(item.channel)}</span>
      </div>

      <p className="mt-1 text-xs text-ink-500">
        {item.occurred_day} · {item.merchant || item.matched || '未识别商户'}
      </p>

      <p className="mt-2 text-xs text-amber-700">
        {item.confidence === 'low' ? '低置信度' : '中等置信度'}，请核对后再入账
      </p>

      <p className="mb-1.5 mt-3 text-xs text-ink-500">记到哪个账户</p>
      <div className="flex flex-wrap gap-1.5">
        {accounts.map((a) => (
          <button
            key={a.id}
            onClick={() => setAccountId(a.id)}
            className={`rounded-full px-2.5 py-1 text-xs transition ${
              accountId === a.id ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700'
            }`}
          >
            {a.name}
          </button>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <button
          onClick={() => onConfirm(accountId)}
          disabled={busy || accountId === 0}
          className="flex-1 rounded-lg bg-ink-900 py-2 text-sm text-white disabled:opacity-40"
        >
          确认记账
        </button>
        <button
          onClick={onIgnore}
          disabled={busy}
          className="flex-1 rounded-lg border border-ink-300 py-2 text-sm text-ink-700 disabled:opacity-40"
        >
          忽略
        </button>
      </div>
    </li>
  );
}

function Empty({ text, hint }: { text: string; hint: string }) {
  return (
    <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
      <p className="text-sm text-ink-700">{text}</p>
      <p className="mt-1 text-xs text-ink-500">{hint}</p>
    </div>
  );
}
