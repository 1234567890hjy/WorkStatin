import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Weather } from '../api';
import {
  getPosition,
  cachedPosition,
  watchPosition,
  geoSupported,
  type Position,
  type GeoFailure,
} from '../geo';

/** 天气数据缓存（30 分钟）。位置变了会作废重取。 */
const CACHE_KEY = 'ws_weather_cache';
const CACHE_MS = 30 * 60 * 1000;

interface Cached {
  at: number;
  /** 缓存对应的坐标格子；null 表示「服务端兜底坐标」 */
  grid: string | null;
  data: Weather;
}

/** 2 位小数 ≈ 1km，城市级天气用这个粒度就够，也避免走动就狂刷请求。 */
function gridOf(p: Position | null): string | null {
  return p ? `${Math.round(p.lat * 100)},${Math.round(p.lon * 100)}` : null;
}

function readCache(): Cached | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Cached;
    if (Date.now() - c.at >= CACHE_MS) return null;
    return c;
  } catch {
    return null;
  }
}

const FAILURE_TEXT: Record<GeoFailure, string> = {
  unsupported: '设备不支持定位',
  denied: '定位未授权',
  timeout: '定位超时',
  unavailable: '暂时无法定位',
};

/**
 * 天气卡片（实时定位）。
 *
 * 数据流：
 *   1. 先读本地缓存立刻渲染，避免白屏；
 *   2. 向浏览器要定位 —— 拿到就把 lat/lon 传给 Worker；
 *   3. 定位失败/被拒绝时什么都不传，Worker 自动用边缘 IP 兜底；
 *   4. 页面可见期间 watchPosition 持续跟踪，位置跨格子就自动换城市；
 *   5. 切到后台停掉跟踪（省电），回到前台再续上。
 *
 * 隐私：坐标只在本机缓存 10 分钟用于「是否移动过」的判断，只发给自己的 Worker，
 * 不落库、不打日志。
 */
export default function WeatherCard() {
  const [w, setW] = useState<Weather | null>(null);
  const [loading, setLoading] = useState(true);
  const [locating, setLocating] = useState(false);
  const [failure, setFailure] = useState<GeoFailure | null>(null);

  /** 当前展示数据对应的坐标格子，用来判断「要不要重取」 */
  const currentGrid = useRef<string | null>(null);
  /** 防止并发请求互相覆盖（快速移动时会连发） */
  const inFlight = useRef(false);

  const load = useCallback(async (opts: { force?: boolean } = {}) => {
    if (inFlight.current) return;
    inFlight.current = true;

    try {
      const cached = readCache();
      const fresh = cachedPosition();
      const cachedGrid = cached?.grid ?? null;
      const freshGrid = gridOf(fresh);

      // ---- 1. 缓存命中且位置没变 → 直接渲染 ----
      if (cached && !opts.force && cachedGrid === freshGrid) {
        setW(cached.data);
        currentGrid.current = cachedGrid;
        setLoading(false);
        setFailure(null);
        // 缓存还够新就不再打网络
        if (Date.now() - cached.at < CACHE_MS / 3) return;
      }

      // ---- 2. 定位 ----
      setLocating(true);
      const { pos, failure: f } = await getPosition(opts.force);
      setLocating(false);
      setFailure(f ?? null);

      const grid = gridOf(pos);

      // 位置没变 + 有缓存 → 省一次请求
      if (!opts.force && cached && grid === cachedGrid) {
        setW(cached.data);
        currentGrid.current = grid;
        setLoading(false);
        return;
      }

      // ---- 3. 请求天气 ----
      const qs = pos ? `?lat=${pos.lat}&lon=${pos.lon}` : '';
      const data = await api.get<Weather>(`/weather${qs}`);
      setW(data);
      currentGrid.current = grid;
      try {
        localStorage.setItem(
          CACHE_KEY,
          JSON.stringify({ at: Date.now(), grid, data } satisfies Cached),
        );
      } catch {
        /* 存不下就算了 */
      }
    } catch {
      // 请求失败时退回缓存，别把已有内容清掉
      if (!readCache()) setW(null);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  // 首次加载
  useEffect(() => {
    void load();
  }, [load]);

  // 持续跟踪位置：跨格子才重取
  useEffect(() => {
    let stop: (() => void) | null = null;

    const start = () => {
      if (stop) return;
      stop = watchPosition((p) => {
        const grid = gridOf(p);
        if (grid && grid !== currentGrid.current) void load();
      });
    };

    const halt = () => {
      stop?.();
      stop = null;
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        start();
        // 回到前台时缓存可能已经过期，顺手检查一次
        const fresh = cachedPosition();
        const grid = gridOf(fresh);
        if (grid && grid !== currentGrid.current) void load();
      } else {
        halt();
      }
    };

    start();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      halt();
    };
  }, [load]);

  // ---------- 渲染 ----------

  if (loading && !w) {
    return (
      <div className="rounded-2xl bg-white p-3.5 shadow-sm">
        <p className="text-xs text-ink-500">天气</p>
        <p className="mt-1 text-lg font-semibold text-ink-300">…</p>
        <p className="text-xs text-ink-500">{locating ? '定位中' : '加载中'}</p>
      </div>
    );
  }

  if (!w || !w.available || !w.current) {
    return (
      <div className="rounded-2xl bg-white p-3.5 shadow-sm">
        <p className="text-xs text-ink-500">天气</p>
        <p className="mt-1 text-lg font-semibold text-ink-900">—</p>
        <p className="truncate text-xs text-ink-500">{w?.reason ?? '暂不可用'}</p>
        <button
          type="button"
          onClick={() => void load({ force: true })}
          className="mt-1 text-xs text-ink-400 underline-offset-2 hover:underline"
        >
          {locating ? '定位中…' : '重试'}
        </button>
      </div>
    );
  }

  const c = w.current;
  const today = w.daily?.[0];
  const sourceHint = w.source === 'gps' ? '定位' : w.source === 'edge' ? '网络位置' : null;

  return (
    <div className="rounded-2xl bg-white p-3.5 shadow-sm">
      <div className="flex items-start justify-between gap-1">
        <p className="flex min-w-0 items-center gap-1 text-xs text-ink-500">
          <span className="truncate">{w.label}</span>
          {sourceHint && (
            <span className="shrink-0 rounded bg-ink-100 px-1 text-[10px]">{sourceHint}</span>
          )}
        </p>
        <button
          type="button"
          aria-label="重新定位"
          onClick={() => void load({ force: true })}
          className={`shrink-0 text-sm leading-none text-ink-400 ${locating ? 'animate-spin' : ''}`}
        >
          {locating ? '◌' : '📍'}
        </button>
      </div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <p className="tabular text-lg font-semibold text-ink-900">
          {c.temp !== null ? `${Math.round(c.temp)}°` : '—'}
        </p>
        <span className="text-lg leading-none">{c.icon}</span>
      </div>
      <p className="text-xs text-ink-500">
        {c.text}
        {today ? ` · ${Math.round(today.min ?? 0)}~${Math.round(today.max)}°` : ''}
      </p>
      {failure && geoSupported() && (
        <p className="mt-1 truncate text-[10px] text-ink-400">
          {FAILURE_TEXT[failure]}，已按网络位置显示
        </p>
      )}
    </div>
  );
}
