import { useEffect, useState } from 'react';
import { api, setToken, ApiError } from '../api';

export default function LoginPage({ onDone }: { onDone: () => void }) {
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ initialized: boolean }>('/auth/status')
      .then((r) => setInitialized(r.initialized))
      .catch(() => setInitialized(false));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const path = initialized ? '/auth/login' : '/auth/setup';
      const r = await api.post<{ token: string }>(path, { username, password });
      setToken(r.token);
      onDone();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : '请求失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  if (initialized === null) {
    return <div className="flex h-full items-center justify-center text-ink-500">加载中…</div>;
  }

  return (
    <div className="flex min-h-full items-center justify-center px-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <div className="mb-8 text-center">
          <div className="text-3xl">🗂️</div>
          <h1 className="mt-3 text-xl font-semibold text-ink-900">个人工作台</h1>
          <p className="mt-1 text-sm text-ink-500">
            {initialized ? '登录以继续' : '首次使用，创建你的账号'}
          </p>
        </div>

        <label className="block">
          <span className="text-sm text-ink-700">用户名</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            className="mt-1 w-full rounded-lg border border-ink-300 px-3 py-2 outline-none focus:border-ink-900"
            placeholder="2~32 位"
          />
        </label>

        <label className="block">
          <span className="text-sm text-ink-700">口令</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={initialized ? 'current-password' : 'new-password'}
            className="mt-1 w-full rounded-lg border border-ink-300 px-3 py-2 outline-none focus:border-ink-900"
            placeholder={initialized ? '' : '至少 8 位'}
          />
        </label>

        {msg && <p className="text-sm text-red-600">{msg}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-ink-900 py-2.5 font-medium text-white disabled:opacity-50"
        >
          {busy ? '处理中…' : initialized ? '登录' : '创建账号'}
        </button>
      </form>
    </div>
  );
}
