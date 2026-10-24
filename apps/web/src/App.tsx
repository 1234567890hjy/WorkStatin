import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import { api, getToken, clearToken, type Account, type Category } from './api';
import LoginPage from './pages/Login';
import DashboardPage from './pages/Dashboard';
import TxnPage from './pages/Txn';
import SharePage from './pages/Share';
import SettingsPage from './pages/Settings';
import WorkoutPage from './pages/Workout';
import VideoPage from './pages/Video';
import TaskPage from './pages/Task';
import RoutinePage from './pages/Routine';
import SearchPage from './pages/Search';

export interface AppData {
  accounts: Account[];
  categories: Category[];
  reload: () => Promise<void>;
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const loc = useLocation();

  async function loadMeta() {
    const [a, c] = await Promise.all([
      api.get<{ items: Account[] }>('/accounts'),
      api.get<{ items: Category[] }>('/categories'),
    ]);
    setAccounts(a.items);
    setCategories(c.items);
  }

  async function bootstrap() {
    if (!getToken()) {
      setAuthed(false);
      setReady(true);
      return;
    }
    try {
      await api.get<{ username: string | null }>('/auth/me');
      await loadMeta();
      setAuthed(true);
    } catch {
      clearToken();
      setAuthed(false);
    } finally {
      setReady(true);
    }
  }

  useEffect(() => {
    void bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-ink-500">加载中…</div>
    );
  }

  if (!authed) {
    return <LoginPage onDone={() => void bootstrap()} />;
  }

  const data: AppData = { accounts, categories, reload: loadMeta };

  return (
    <div className="flex min-h-full flex-col">
      <main className="flex-1 pb-16">
        <Routes>
          <Route path="/" element={<DashboardPage data={data} />} />
          <Route path="/txn" element={<TxnPage data={data} />} />
          <Route path="/workout" element={<WorkoutPage data={data} />} />
          <Route path="/video" element={<VideoPage data={data} />} />
          <Route path="/tasks" element={<TaskPage data={data} />} />
          <Route path="/routines" element={<RoutinePage data={data} />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/share" element={<SharePage data={data} />} />
          <Route path="/settings" element={<SettingsPage data={data} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <TabBar path={loc.pathname} />
    </div>
  );
}

const TABS = [
  { to: '/', label: '概览', icon: '📊' },
  { to: '/txn', label: '记账', icon: '💰' },
  { to: '/tasks', label: '计划', icon: '✅' },
  { to: '/workout', label: '运动', icon: '🏃' },
  { to: '/video', label: '学习', icon: '🎬' },
  { to: '/settings', label: '设置', icon: '⚙️' },
];

function TabBar({ path }: { path: string }) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 border-t border-ink-300/40 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-md">
        {TABS.map((t) => {
          const active = path === t.to;
          return (
            <Link
              key={t.to}
              to={t.to}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-xs ${
                active ? 'text-ink-900 font-semibold' : 'text-ink-500'
              }`}
            >
              <span className="text-lg leading-none">{t.icon}</span>
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
