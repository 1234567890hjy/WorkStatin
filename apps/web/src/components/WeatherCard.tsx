import { useEffect, useState } from 'react';
import { api, type Weather } from '../api';

const CACHE_KEY = 'ws_weather_cache';
const CACHE_MS = 30 * 60 * 1000; // 30 分钟

interface Cached {
  at: number;
  data: Weather;
}

/**
 * 天气卡片。
 *
 * 前端也做一层缓存（30 分钟），减少请求；Worker 侧还有 Cache API 兜底。
 * 天气拿不到时显示「—」而不是报错 —— 它只是锦上添花，不能挡住主流程。
 */
export default function WeatherCard() {
  const [w, setW] = useState<Weather | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 先读本地缓存
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const c = JSON.parse(raw) as Cached;
        if (Date.now() - c.at < CACHE_MS) {
          setW(c.data);
          setLoading(false);
          return;
        }
      }
    } catch {
      /* 缓存坏了就当没有 */
    }

    api
      .get<Weather>('/weather')
      .then((data) => {
        setW(data);
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
        } catch {
          /* 存不下就算了 */
        }
      })
      .catch(() => setW(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="rounded-2xl bg-white p-3.5 shadow-sm">
        <p className="text-xs text-ink-500">天气</p>
        <p className="mt-1 text-lg font-semibold text-ink-300">…</p>
        <p className="text-xs text-ink-500">加载中</p>
      </div>
    );
  }

  if (!w || !w.available || !w.current) {
    return (
      <div className="rounded-2xl bg-white p-3.5 shadow-sm">
        <p className="text-xs text-ink-500">天气</p>
        <p className="mt-1 text-lg font-semibold text-ink-900">—</p>
        <p className="truncate text-xs text-ink-500">{w?.reason ?? '暂不可用'}</p>
      </div>
    );
  }

  const c = w.current;
  const today = w.daily?.[0];

  return (
    <div className="rounded-2xl bg-white p-3.5 shadow-sm">
      <div className="flex items-start justify-between">
        <p className="text-xs text-ink-500">{w.label}</p>
        <span className="text-lg leading-none">{c.icon}</span>
      </div>
      <p className="tabular mt-0.5 text-lg font-semibold text-ink-900">
        {c.temp !== null ? `${Math.round(c.temp)}°` : '—'}
      </p>
      <p className="text-xs text-ink-500">
        {c.text}
        {today ? ` · ${Math.round(today.min ?? 0)}~${Math.round(today.max)}°` : ''}
      </p>
    </div>
  );
}
