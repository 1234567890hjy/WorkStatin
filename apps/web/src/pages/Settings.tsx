import { useState } from 'react';
import { api, ApiError, clearToken } from '../api';
import { formatYuan, formatYuanGrouped } from '../format';
import type { AppData } from '../App';

export default function SettingsPage({ data }: { data: AppData }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const total = data.accounts.reduce((a, x) => a + x.balance_cents, 0);

  async function saveBalance(id: number) {
    const s = draft.trim();
    if (!s || !/^\d*(\.\d{0,2})?$/.test(s) || s === '.') {
      setMsg('金额格式不对');
      return;
    }
    const [i = '0', f = ''] = s.split('.');
    const cents = Number(i) * 100 + Number((f + '00').slice(0, 2));
    try {
      await api.put(`/accounts/${id}`, { balance_cents: cents });
      await data.reload();
      setEditing(null);
      setMsg(null);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '保存失败');
    }
  }

  async function logout() {
    try {
      await api.post('/auth/logout');
    } catch {
      /* 忽略 */
    }
    clearToken();
    location.reload();
  }

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 pt-6">
      <h1 className="text-lg font-semibold text-ink-900">设置</h1>

      {/* 净资产 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="text-xs text-ink-500">净资产合计</p>
        <p className="tabular mt-1 text-2xl font-semibold text-ink-900">
          ¥{formatYuanGrouped(total)}
        </p>
        <p className="mt-1 text-xs text-ink-500">
          由各账户余额相加；余额手动维护（自动联动推迟到 v2.1）
        </p>
      </section>

      {/* 账户余额 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-ink-900">账户余额</h2>
        <ul className="divide-y divide-ink-100">
          {data.accounts.map((a) => (
            <li key={a.id} className="flex items-center justify-between py-2.5">
              <span className="text-sm text-ink-900">{a.name}</span>
              {editing === a.id ? (
                <div className="flex items-center gap-2">
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    inputMode="decimal"
                    autoFocus
                    className="tabular w-24 rounded border border-ink-300 px-2 py-1 text-right text-sm outline-none"
                  />
                  <button
                    onClick={() => void saveBalance(a.id)}
                    className="text-xs font-medium text-ink-900"
                  >
                    保存
                  </button>
                  <button onClick={() => setEditing(null)} className="text-xs text-ink-500">
                    取消
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setEditing(a.id);
                    setDraft(formatYuan(a.balance_cents));
                  }}
                  className="tabular text-sm font-medium text-ink-900"
                >
                  ¥{formatYuanGrouped(a.balance_cents)}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {msg && <p className="text-sm text-red-600">{msg}</p>}

      {/* 其他 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold text-ink-900">其他</h2>
        <ul className="divide-y divide-ink-100 text-sm">
          <li className="flex items-center justify-between py-2.5">
            <span className="text-ink-700">数据备份</span>
            <span className="text-xs text-ink-500">P2 接入</span>
          </li>
          <li className="flex items-center justify-between py-2.5">
            <span className="text-ink-700">天气卡片</span>
            <span className="text-xs text-ink-500">P1 接入</span>
          </li>
          <li className="flex items-center justify-between py-2.5">
            <span className="text-ink-700">视频 AI 学习</span>
            <span className="text-xs text-ink-500">P1 接入</span>
          </li>
        </ul>
      </section>

      <button
        onClick={() => void logout()}
        className="w-full rounded-lg border border-ink-300 py-3 text-sm font-medium text-ink-700"
      >
        退出登录
      </button>

      <p className="pb-4 text-center text-xs text-ink-500">个人工作台 v0.1.0 · P0</p>
    </div>
  );
}
