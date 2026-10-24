import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type MonthlyStats, type ShareParse, type Txn } from '../api';
import { formatYuanGrouped } from '../format';
import CategoryBars from '../components/CategoryBars';
import type { AppData } from '../App';

type Kind = 'expense' | 'income' | 'transfer';

/** 当前月与往前 N 个月，供月份切换用。 */
function monthOptions(n = 12): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

export default function TxnPage({ data }: { data: AppData }) {
  const [kind, setKind] = useState<Kind>('expense');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState<number>(data.accounts[0]?.id ?? 0);
  const [toAccountId, setToAccountId] = useState<number>(data.accounts[1]?.id ?? 0);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [merchant, setMerchant] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [pasting, setPasting] = useState(false);

  const [list, setList] = useState<Txn[]>([]);
  const [listKey, setListKey] = useState(0);

  // 月度统计（分类占比图）
  const [month, setMonth] = useState(() => monthOptions(1)[0] ?? '');
  const [statKind, setStatKind] = useState<'expense' | 'income'>('expense');
  const [stats, setStats] = useState<MonthlyStats | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);

  const cats = useMemo(
    () => data.categories.filter((c) => c.kind === (kind === 'income' ? 'income' : 'expense')),
    [data.categories, kind],
  );

  // 切换类型时重置分类选择
  useEffect(() => {
    setCategoryId(null);
  }, [kind]);

  useEffect(() => {
    api
      .get<{ items: Txn[] }>(`/txns?limit=30${month ? `&month=${month}` : ''}`)
      .then((r) => setList(r.items))
      .catch(() => setList([]));
  }, [listKey, month]);

  useEffect(() => {
    api
      .get<MonthlyStats>(`/txns/stats/monthly?month=${month}`)
      .then(setStats)
      .catch(() => setStats(null));
  }, [month, listKey]);

  /**
   * 从剪贴板读取短信/通知文本并解析。
   *
   * 这是 share_target 的替代方案：不依赖浏览器是否支持 Web Share Target，
   * 任何浏览器都能用 —— 复制短信 → 点这个按钮 → 自动填好金额和商户。
   */
  async function pasteFromClipboard() {
    setPasting(true);
    setMsg(null);
    try {
      if (!navigator.clipboard?.readText) {
        setMsg({ type: 'err', text: '当前浏览器不支持读取剪贴板，请手动输入' });
        return;
      }
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setMsg({ type: 'err', text: '剪贴板是空的，请先复制短信内容' });
        return;
      }

      const r = await api.post<ShareParse>('/share/parse', { text });
      if (!r.parsed) {
        setMsg({ type: 'err', text: '没识别出金额，请手动输入' });
        return;
      }

      setAmount(r.draft.amount);
      if (r.draft.merchant) setMerchant(r.draft.merchant);
      setMsg({
        type: 'ok',
        text: `已识别：¥${r.draft.amount}${r.draft.merchant ? ` · ${r.draft.merchant}` : ''}`,
      });
    } catch (e) {
      // 剪贴板权限被拒是常见情况（需要 HTTPS + 用户手势）
      const m = e instanceof ApiError ? e.message : '读取剪贴板失败';
      setMsg({
        type: 'err',
        text: m.includes('denied') || m.includes('permission') ? '剪贴板权限被拒绝，请手动输入' : m,
      });
    } finally {
      setPasting(false);
    }
  }

  const amountCents = useMemo(() => {
    const s = amount.trim();
    if (!s) return null;
    if (!/^\d*(\.\d{0,2})?$/.test(s) || s === '.' || s === '') return null;
    const [i = '0', f = ''] = s.split('.');
    const cents = Number(i) * 100 + Number((f + '00').slice(0, 2));
    return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
  }, [amount]);

  async function submit() {
    if (amountCents === null) {
      setMsg({ type: 'err', text: '请输入有效金额' });
      return;
    }
    if (!accountId) {
      setMsg({ type: 'err', text: '请选择账户' });
      return;
    }
    if (kind === 'transfer' && accountId === toAccountId) {
      setMsg({ type: 'err', text: '转出与转入账户不能相同' });
      return;
    }

    setBusy(true);
    setMsg(null);
    try {
      await api.post('/txns', {
        type: kind,
        amount_cents: amountCents,
        account_id: accountId,
        to_account_id: kind === 'transfer' ? toAccountId : undefined,
        category_id: categoryId ?? undefined,
        merchant: merchant.trim() || undefined,
        note: note.trim() || undefined,
        source: 'manual',
      });
      setAmount('');
      setMerchant('');
      setNote('');
      setMsg({ type: 'ok', text: '已记录' });
      setListKey((k) => k + 1);
    } catch (e) {
      setMsg({ type: 'err', text: e instanceof ApiError ? e.message : '保存失败' });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    try {
      await api.del(`/txns/${id}`);
      setListKey((k) => k + 1);
    } catch {
      setMsg({ type: 'err', text: '删除失败' });
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 pt-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink-900">记一笔</h1>
        <button
          onClick={() => void pasteFromClipboard()}
          disabled={pasting}
          className="rounded-full border border-ink-300 px-3 py-1 text-xs font-medium text-ink-700 disabled:opacity-40"
        >
          {pasting ? '识别中…' : '📋 从剪贴板识别'}
        </button>
      </div>

      {/* 类型切换 */}
      <div className="flex rounded-lg bg-ink-100 p-1">
        {(['expense', 'income', 'transfer'] as Kind[]).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`flex-1 rounded-md py-1.5 text-sm font-medium transition ${
              kind === k ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500'
            }`}
          >
            {k === 'expense' ? '支出' : k === 'income' ? '收入' : '转账'}
          </button>
        ))}
      </div>

      {/* 金额 */}
      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <label className="block">
          <span className="text-xs text-ink-500">金额（元）</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            autoFocus
            className="tabular mt-1 w-full border-0 p-0 text-3xl font-semibold text-ink-900 outline-none placeholder:text-ink-300"
          />
        </label>
      </div>

      {/* 分类 */}
      {kind !== 'transfer' && (
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <p className="mb-2 text-xs text-ink-500">分类</p>
          <div className="flex flex-wrap gap-2">
            {cats.map((c) => (
              <button
                key={c.id}
                onClick={() => setCategoryId(categoryId === c.id ? null : c.id)}
                className={`rounded-full px-3 py-1.5 text-sm transition ${
                  categoryId === c.id
                    ? 'bg-ink-900 text-white'
                    : 'bg-ink-100 text-ink-700'
                }`}
              >
                {c.icon ?? ''} {c.name}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* 账户 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="mb-2 text-xs text-ink-500">{kind === 'transfer' ? '转出账户' : '账户'}</p>
        <div className="flex flex-wrap gap-2">
          {data.accounts.map((a) => (
            <button
              key={a.id}
              onClick={() => setAccountId(a.id)}
              className={`rounded-full px-3 py-1.5 text-sm transition ${
                accountId === a.id ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700'
              }`}
            >
              {a.name}
            </button>
          ))}
        </div>

        {kind === 'transfer' && (
          <>
            <p className="mb-2 mt-3 text-xs text-ink-500">转入账户</p>
            <div className="flex flex-wrap gap-2">
              {data.accounts
                .filter((a) => a.id !== accountId)
                .map((a) => (
                  <button
                    key={a.id}
                    onClick={() => setToAccountId(a.id)}
                    className={`rounded-full px-3 py-1.5 text-sm transition ${
                      toAccountId === a.id ? 'bg-blue-600 text-white' : 'bg-ink-100 text-ink-700'
                    }`}
                  >
                    {a.name}
                  </button>
                ))}
            </div>
          </>
        )}
      </section>

      {/* 商户与备注 */}
      <section className="space-y-2 rounded-2xl bg-white p-4 shadow-sm">
        <input
          value={merchant}
          onChange={(e) => setMerchant(e.target.value)}
          placeholder="商户（可选）"
          className="w-full rounded-lg border border-ink-100 px-3 py-2 text-sm outline-none focus:border-ink-300"
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="备注（可选）"
          className="w-full rounded-lg border border-ink-100 px-3 py-2 text-sm outline-none focus:border-ink-300"
        />
      </section>

      {msg && (
        <p className={`text-sm ${msg.type === 'ok' ? 'text-emerald-600' : 'text-red-600'}`}>
          {msg.text}
        </p>
      )}

      <button
        onClick={submit}
        disabled={busy || amountCents === null}
        className="w-full rounded-lg bg-ink-900 py-3 font-medium text-white disabled:opacity-40"
      >
        {busy ? '保存中…' : '保存'}
      </button>

      {/* 月度分类占比 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <button
            onClick={() => setStatsOpen((v) => !v)}
            className="flex items-baseline gap-1.5 text-sm font-semibold text-ink-900"
          >
            分类占比
            <span className="text-xs text-ink-500">{statsOpen ? '收起 ▲' : '展开 ▼'}</span>
          </button>
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded-lg border border-ink-100 px-2 py-1 text-xs outline-none focus:border-ink-300"
          >
            {monthOptions().map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        {statsOpen && (
          <>
            <div className="mb-3 flex gap-1 rounded-lg bg-ink-100 p-1">
              <button
                onClick={() => setStatKind('expense')}
                className={`flex-1 rounded-md py-1 text-xs font-medium transition ${
                  statKind === 'expense' ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500'
                }`}
              >
                支出
              </button>
              <button
                onClick={() => setStatKind('income')}
                className={`flex-1 rounded-md py-1 text-xs font-medium transition ${
                  statKind === 'income' ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500'
                }`}
              >
                收入
              </button>
            </div>

            {stats ? (
              <CategoryBars
                rows={stats.by_category}
                kind={statKind}
                totalCents={
                  statKind === 'expense' ? stats.expense_cents : stats.income_cents
                }
              />
            ) : (
              <p className="py-6 text-center text-sm text-ink-500">加载中…</p>
            )}
          </>
        )}
      </section>

      {/* 最近记录 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold text-ink-900">
          {month} 最近 30 笔
        </h2>
        {list.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-500">暂无记录</p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {list.map((t) => (
              <li key={t.id} className="flex items-center justify-between py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink-900">
                    {t.merchant || t.category_name || t.note || '未命名'}
                  </p>
                  <p className="text-xs text-ink-500">
                    {t.occurred_day} · {t.account_name ?? ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3 pl-3">
                  <span className="tabular text-sm font-medium text-ink-900">
                    {t.type === 'expense' ? '-' : t.type === 'income' ? '+' : '↔'}¥
                    {formatYuanGrouped(t.amount_cents)}
                  </span>
                  <button
                    onClick={() => remove(t.id)}
                    className="text-xs text-ink-500 hover:text-red-600"
                    aria-label="删除"
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
