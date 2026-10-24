import { useState } from 'react';
import { api, ApiError, clearToken, type AccountKind, type Category, type CategoryKind } from '../api';
import { formatYuan, formatYuanGrouped } from '../format';
import type { AppData } from '../App';

const ACCOUNT_KINDS: AccountKind[] = ['cash', 'bank', 'credit', 'ewallet'];
const ACCOUNT_KIND_LABEL: Record<AccountKind, string> = {
  cash: '现金',
  bank: '银行卡',
  credit: '信用',
  ewallet: '电子钱包',
};

const CATEGORY_KINDS: CategoryKind[] = ['expense', 'income'];

/** 把用户输入的元字符串转成「分」的整数；空或非法返回 0。 */
function parseBalance(s: string): number {
  const t = s.trim();
  if (!t || !/^\d*(\.\d{0,2})?$/.test(t) || t === '.') return 0;
  const [i = '0', f = ''] = t.split('.');
  return Number(i) * 100 + Number((f + '00').slice(0, 2));
}

export default function SettingsPage({ data }: { data: AppData }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  // 修改口令
  const [pwOpen, setPwOpen] = useState(false);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<string | null>(null);

  // 新增账户
  const [accOpen, setAccOpen] = useState(false);
  const [accName, setAccName] = useState('');
  const [accKind, setAccKind] = useState<AccountKind>('cash');
  const [accBalance, setAccBalance] = useState('');
  const [accBusy, setAccBusy] = useState(false);
  const [accMsg, setAccMsg] = useState<string | null>(null);

  // 分类管理
  const [catOpen, setCatOpen] = useState(false);
  const [catEditing, setCatEditing] = useState<Category | null>(null);
  const [catName, setCatName] = useState('');
  const [catIcon, setCatIcon] = useState('');
  const [catKind, setCatKind] = useState<CategoryKind>('expense');
  const [catBusy, setCatBusy] = useState(false);
  const [catMsg, setCatMsg] = useState<string | null>(null);

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

  async function addAccount() {
    const n = accName.trim();
    if (!n) {
      setAccMsg('请填写账户名');
      return;
    }
    setAccBusy(true);
    setAccMsg(null);
    try {
      await api.post('/accounts', {
        name: n,
        kind: accKind,
        balance_cents: parseBalance(accBalance),
      });
      await data.reload();
      setAccName('');
      setAccBalance('');
      setAccOpen(false);
    } catch (e) {
      setAccMsg(e instanceof ApiError ? e.message : '添加失败');
    } finally {
      setAccBusy(false);
    }
  }

  async function archiveAccount(id: number) {
    if (!confirm('归档后该账户不再计入净资产，历史流水仍保留。确定归档？')) return;
    try {
      await api.put(`/accounts/${id}`, { is_archived: 1 });
      await data.reload();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '操作失败');
    }
  }

  async function saveCategory() {
    const n = catName.trim();
    if (!n) {
      setCatMsg('请填写分类名');
      return;
    }
    setCatBusy(true);
    setCatMsg(null);
    try {
      if (catEditing) {
        await api.put(`/categories/${catEditing.id}`, {
          name: n,
          kind: catKind,
          icon: catIcon.trim() || null,
        });
      } else {
        await api.post('/categories', {
          name: n,
          kind: catKind,
          icon: catIcon.trim() || null,
        });
      }
      await data.reload();
      setCatEditing(null);
      setCatName('');
      setCatIcon('');
    } catch (e) {
      setCatMsg(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setCatBusy(false);
    }
  }

  async function removeCategory(id: number, name: string) {
    if (!confirm(`删除分类「${name}」？\n\n如果还有流水在用这个分类，系统会拒绝删除。`)) return;
    try {
      await api.del(`/categories/${id}`);
      await data.reload();
    } catch (e) {
      setCatMsg(e instanceof ApiError ? e.message : '删除失败');
      setCatOpen(true);
    }
  }

  async function changePassword() {

    if (!oldPw) {
      setPwMsg('请填写当前口令');
      return;
    }
    if (newPw.length < 8) {
      setPwMsg('新口令至少 8 位');
      return;
    }
    if (newPw !== newPw2) {
      setPwMsg('两次输入的新口令不一致');
      return;
    }
    if (newPw === oldPw) {
      setPwMsg('新口令不能与当前口令相同');
      return;
    }

    setPwBusy(true);
    try {
      await api.put('/auth/password', { old_password: oldPw, new_password: newPw });
      // 改密成功：其他设备已全部下线，当前会话仍有效，无需重新登录
      setPwOpen(false);
      setOldPw('');
      setNewPw('');
      setNewPw2('');
      setPwMsg(null);
      setMsg('口令已修改，其他设备已全部退出登录');
    } catch (e) {
      const m = e instanceof ApiError ? e.message : '修改失败';
      setPwMsg(m);
      // 401 说明旧口令错或被踢，api.ts 已清 token，这里 reload 回登录页
      if (e instanceof ApiError && e.code === 'UNAUTHORIZED') location.reload();
    } finally {
      setPwBusy(false);
    }
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
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-900">账户</h2>
          <button
            onClick={() => setAccOpen((v) => !v)}
            className="text-xs font-medium text-ink-700"
          >
            {accOpen ? '取消' : '+ 新增'}
          </button>
        </div>

        {accOpen && (
          <div className="mb-3 space-y-2 rounded-lg bg-ink-50 p-3">
            <input
              value={accName}
              onChange={(e) => setAccName(e.target.value)}
              placeholder="账户名，如「招行信用卡」"
              className="w-full rounded-lg border border-ink-100 px-3 py-2 text-sm outline-none focus:border-ink-300"
            />
            <div className="flex gap-1">
              {ACCOUNT_KINDS.map((k) => (
                <button
                  key={k}
                  onClick={() => setAccKind(k)}
                  className={`flex-1 rounded-md py-1 text-xs transition ${
                    accKind === k ? 'bg-ink-900 text-white' : 'bg-white text-ink-600'
                  }`}
                >
                  {ACCOUNT_KIND_LABEL[k]}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs text-ink-500">
              初始余额
              <input
                value={accBalance}
                onChange={(e) => setAccBalance(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="tabular w-28 rounded-lg border border-ink-100 px-2 py-1 text-right text-sm outline-none focus:border-ink-300"
              />
              元
            </label>
            {accMsg && <p className="text-xs text-red-600">{accMsg}</p>}
            <button
              onClick={() => void addAccount()}
              disabled={accBusy || !accName.trim()}
              className="w-full rounded-lg bg-ink-900 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {accBusy ? '提交中…' : '添加账户'}
            </button>
          </div>
        )}

        <ul className="divide-y divide-ink-100">
          {data.accounts.map((a) => (
            <li key={a.id} className="flex items-center justify-between py-2.5">
              <span className="text-sm text-ink-900">
                {a.name}
                <span className="ml-1.5 text-[10px] text-ink-500">
                  {ACCOUNT_KIND_LABEL[a.kind as AccountKind] ?? a.kind}
                </span>
              </span>
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
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setEditing(a.id);
                      setDraft(formatYuan(a.balance_cents));
                    }}
                    className="tabular text-sm font-medium text-ink-900"
                  >
                    ¥{formatYuanGrouped(a.balance_cents)}
                  </button>
                  <button
                    onClick={() => void archiveAccount(a.id)}
                    className="text-xs text-ink-500 hover:text-red-600"
                    aria-label="归档"
                  >
                    归档
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-ink-500">
          归档后不再计入净资产，历史流水仍保留。
        </p>
      </section>

      {/* 分类管理 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-900">分类</h2>
          <button
            onClick={() => {
              setCatEditing(null);
              setCatName('');
              setCatIcon('');
              setCatKind('expense');
              setCatOpen((v) => !v);
              setCatMsg(null);
            }}
            className="text-xs font-medium text-ink-700"
          >
            {catOpen && !catEditing ? '取消' : '+ 新增'}
          </button>
        </div>

        {catOpen && (
          <div className="mb-3 space-y-2 rounded-lg bg-ink-50 p-3">
            <div className="flex gap-2">
              <input
                value={catIcon}
                onChange={(e) => setCatIcon(e.target.value)}
                placeholder="图标"
                className="w-16 rounded-lg border border-ink-100 px-2 py-2 text-center text-sm outline-none focus:border-ink-300"
              />
              <input
                value={catName}
                onChange={(e) => setCatName(e.target.value)}
                placeholder={catEditing ? '分类名' : '新分类名'}
                className="flex-1 rounded-lg border border-ink-100 px-3 py-2 text-sm outline-none focus:border-ink-300"
              />
            </div>
            <div className="flex gap-1">
              {CATEGORY_KINDS.map((k) => (
                <button
                  key={k}
                  onClick={() => setCatKind(k)}
                  className={`flex-1 rounded-md py-1 text-xs transition ${
                    catKind === k ? 'bg-ink-900 text-white' : 'bg-white text-ink-600'
                  }`}
                >
                  {k === 'expense' ? '支出' : '收入'}
                </button>
              ))}
            </div>
            {catMsg && <p className="text-xs text-red-600">{catMsg}</p>}
            <div className="flex gap-2">
              <button
                onClick={() => void saveCategory()}
                disabled={catBusy || !catName.trim()}
                className="flex-1 rounded-lg bg-ink-900 py-2 text-sm font-medium text-white disabled:opacity-40"
              >
                {catBusy ? '提交中…' : catEditing ? '保存修改' : '添加分类'}
              </button>
              {catEditing && (
                <button
                  onClick={() => {
                    setCatEditing(null);
                    setCatName('');
                    setCatIcon('');
                    setCatMsg(null);
                  }}
                  className="rounded-lg border border-ink-300 px-3 text-xs text-ink-600"
                >
                  取消编辑
                </button>
              )}
            </div>
          </div>
        )}

        <div className="space-y-3">
          {(['expense', 'income'] as CategoryKind[]).map((k) => (
            <div key={k}>
              <p className="mb-1 text-[11px] font-medium text-ink-500">
                {k === 'expense' ? '支出' : '收入'}
              </p>
              <ul className="divide-y divide-ink-100">
                {data.categories
                  .filter((c) => c.kind === k)
                  .map((c) => (
                    <li key={c.id} className="flex items-center justify-between py-1.5">
                      <span className="text-sm text-ink-700">
                        {c.icon ?? ''} {c.name}
                      </span>
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            setCatEditing(c);
                            setCatName(c.name);
                            setCatIcon(c.icon ?? '');
                            setCatKind(c.kind as CategoryKind);
                            setCatOpen(true);
                            setCatMsg(null);
                          }}
                          className="text-xs text-ink-500"
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => void removeCategory(c.id, c.name)}
                          className="text-xs text-ink-500 hover:text-red-600"
                          aria-label="删除"
                        >
                          ✕
                        </button>
                      </div>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {msg && <p className="text-sm text-red-600">{msg}</p>}

      {/* 其他 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold text-ink-900">账户与数据</h2>
        <ul className="divide-y divide-ink-100 text-sm">
          <li>
            <button
              onClick={() => {
                setPwOpen((v) => !v);
                setPwMsg(null);
              }}
              className="flex w-full items-center justify-between py-2.5 text-left"
            >
              <span className="text-ink-700">修改口令</span>
              <span className="text-xs text-ink-500">{pwOpen ? '收起 ▲' : '展开 ▼'}</span>
            </button>

            {pwOpen && (
              <div className="space-y-2 pb-3">
                <label className="block">
                  <span className="text-xs text-ink-500">当前口令</span>
                  <input
                    type="password"
                    value={oldPw}
                    onChange={(e) => setOldPw(e.target.value)}
                    autoComplete="current-password"
                    className="mt-1 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-ink-900"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-ink-500">新口令（至少 8 位）</span>
                  <input
                    type="password"
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    autoComplete="new-password"
                    className="mt-1 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-ink-900"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-ink-500">确认新口令</span>
                  <input
                    type="password"
                    value={newPw2}
                    onChange={(e) => setNewPw2(e.target.value)}
                    autoComplete="new-password"
                    className="mt-1 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-ink-900"
                  />
                </label>

                {pwMsg && <p className="text-xs text-red-600">{pwMsg}</p>}

                <p className="text-[11px] leading-relaxed text-ink-500">
                  修改后其他设备将全部退出登录，当前设备不受影响。
                </p>

                <button
                  onClick={() => void changePassword()}
                  disabled={pwBusy}
                  className="w-full rounded-lg bg-ink-900 py-2 text-sm font-medium text-white disabled:opacity-40"
                >
                  {pwBusy ? '提交中…' : '确认修改'}
                </button>
              </div>
            )}
          </li>
          <li className="flex items-center justify-between py-2.5">
            <span className="text-ink-700">数据备份</span>
            <span className="text-xs text-ink-500">P2 接入</span>
          </li>
        </ul>
      </section>

      <button
        onClick={() => void logout()}
        className="w-full rounded-lg border border-ink-300 py-3 text-sm font-medium text-ink-700"
      >
        退出登录
      </button>

      <p className="pb-4 text-center text-xs text-ink-500">个人工作台 v0.2.0 · P1</p>
    </div>
  );
}
