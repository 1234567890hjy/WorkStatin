import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api, ApiError, type ShareParse } from '../api';
import type { AppData } from '../App';

/**
 * share_target 落地页。
 *
 * Android 分享进来的文本经 GET 查询参数到达，这里调用后端解析，
 * 预填成草稿让用户确认 —— 绝不自动落库。
 */
export default function SharePage({ data }: { data: AppData }) {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [res, setRes] = useState<ShareParse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [amount, setAmount] = useState('');
  const [merchant, setMerchant] = useState('');
  const [accountId, setAccountId] = useState<number>(data.accounts[0]?.id ?? 0);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const raw = [params.get('title'), params.get('text'), params.get('url')]
    .filter(Boolean)
    .join(' ');

  useEffect(() => {
    if (!raw.trim()) {
      setErr('没有收到分享内容');
      return;
    }
    api
      .post<ShareParse>('/share/parse', { text: raw })
      .then((r) => {
        setRes(r);
        setAmount(r.draft.amount);
        setMerchant(r.draft.merchant);
      })
      .catch((e: Error) => setErr(e instanceof ApiError ? e.message : '解析失败'));
  }, [raw]);

  const amountCents = (() => {
    const s = amount.trim();
    if (!s || !/^\d*(\.\d{0,2})?$/.test(s) || s === '.') return null;
    const [i = '0', f = ''] = s.split('.');
    const c = Number(i) * 100 + Number((f + '00').slice(0, 2));
    return Number.isSafeInteger(c) && c > 0 ? c : null;
  })();

  async function save() {
    if (amountCents === null) {
      setMsg('请输入有效金额');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api.post('/txns', {
        type: 'expense',
        amount_cents: amountCents,
        account_id: accountId,
        category_id: categoryId ?? undefined,
        merchant: merchant.trim() || undefined,
        source: 'share',
      });
      nav('/', { replace: true });
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  if (err) {
    return (
      <div className="mx-auto max-w-md px-4 pt-10 text-center">
        <p className="text-sm text-ink-500">{err}</p>
        <button
          onClick={() => nav('/txn')}
          className="mt-4 rounded-lg bg-ink-900 px-5 py-2 text-sm text-white"
        >
          手动记账
        </button>
      </div>
    );
  }

  if (!res) {
    return <div className="flex h-64 items-center justify-center text-sm text-ink-500">解析中…</div>;
  }

  const cats = data.categories.filter((c) => c.kind === 'expense');

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 pt-6">
      <div>
        <h1 className="text-lg font-semibold text-ink-900">确认这笔账</h1>
        <p className="mt-0.5 text-xs text-ink-500">
          {res.parsed
            ? `已自动识别${res.confidence === 'high' ? '（高置信）' : '（请核对）'}`
            : '未能识别金额，请手动填写'}
        </p>
      </div>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <label className="block">
          <span className="text-xs text-ink-500">金额（元）</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            className="tabular mt-1 w-full border-0 p-0 text-3xl font-semibold text-ink-900 outline-none placeholder:text-ink-300"
          />
        </label>
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <input
          value={merchant}
          onChange={(e) => setMerchant(e.target.value)}
          placeholder="商户"
          className="w-full rounded-lg border border-ink-100 px-3 py-2 text-sm outline-none focus:border-ink-300"
        />
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="mb-2 text-xs text-ink-500">分类</p>
        <div className="flex flex-wrap gap-2">
          {cats.map((c) => (
            <button
              key={c.id}
              onClick={() => setCategoryId(categoryId === c.id ? null : c.id)}
              className={`rounded-full px-3 py-1.5 text-sm transition ${
                categoryId === c.id ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700'
              }`}
            >
              {c.icon ?? ''} {c.name}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="mb-2 text-xs text-ink-500">账户</p>
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
      </section>

      {res.raw && (
        <details className="rounded-2xl bg-white p-4 text-xs text-ink-500 shadow-sm">
          <summary className="cursor-pointer">原始分享内容</summary>
          <p className="mt-2 whitespace-pre-wrap break-all">{res.raw}</p>
        </details>
      )}

      {msg && <p className="text-sm text-red-600">{msg}</p>}

      <div className="flex gap-3">
        <button
          onClick={() => nav('/txn')}
          className="flex-1 rounded-lg border border-ink-300 py-3 text-sm font-medium text-ink-700"
        >
          改为手动
        </button>
        <button
          onClick={save}
          disabled={busy || amountCents === null}
          className="flex-1 rounded-lg bg-ink-900 py-3 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? '保存中…' : '确认记账'}
        </button>
      </div>
    </div>
  );
}
