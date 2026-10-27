/**
 * 前端定位（浏览器 Geolocation）。
 *
 * 为什么不直接用 navigator.geolocation：
 * 1. 需要缓存 —— 每次开页面都等 10 秒是灾难；
 * 2. 需要失败原因 —— 「拒绝授权」和「信号不好」对用户是两件事；
 * 3. 需要持续跟踪 —— 走到别的城市要能自动切换，而不是等下次刷新。
 *
 * 定位失败不是错误：调用方拿到 null 就交给 Worker 用边缘 IP 兜底。
 */

const POS_KEY = 'ws_geo_pos';

/** 定位缓存多久后认为「该重新定位了」。10 分钟足够贴合「走到别的城市」。 */
const POS_TTL_MS = 10 * 60 * 1000;

/** 单次定位最多等多久（毫秒）。室内常常拿不到，所以别设太长。 */
const TIMEOUT_MS = 8000;

export interface Position {
  lat: number;
  lon: number;
  /** 取得定位的时间戳 */
  at: number;
  /** 定位精度（米），可用于判断是否可信 */
  accuracy: number | null;
}

/** 定位失败的原因，用于给用户不同的提示。 */
export type GeoFailure = 'unsupported' | 'denied' | 'timeout' | 'unavailable';

export interface GeoResult {
  pos: Position | null;
  failure?: GeoFailure;
}

function readCache(): Position | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Position;
    if (typeof p?.lat !== 'number' || typeof p?.lon !== 'number') return null;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return null;
    if (p.lat === 0 && p.lon === 0) return null;
    return p;
  } catch {
    return null;
  }
}

function writeCache(p: Position): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(p));
  } catch {
    /* 存不下就算了 */
  }
}

export function clearPosition(): void {
  try {
    localStorage.removeItem(POS_KEY);
  } catch {
    /* ignore */
  }
}

/** 缓存里是否已有「还新鲜」的定位。 */
export function cachedPosition(maxAgeMs = POS_TTL_MS): Position | null {
  const p = readCache();
  if (!p) return null;
  if (Date.now() - p.at > maxAgeMs) return null;
  return p;
}

/** 浏览器是否支持定位 API。 */
export function geoSupported(): boolean {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator;
}

/** 把 GeolocationPosition 转成我们的 Position；0,0 视为失败。 */
function toPosition(pos: GeolocationPosition): Position | null {
  const p: Position = {
    lat: pos.coords.latitude,
    lon: pos.coords.longitude,
    at: Date.now(),
    accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
  };
  if (p.lat === 0 && p.lon === 0) return null;
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return null;
  return p;
}

function failureOf(err: GeolocationPositionError): GeoFailure {
  // 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
  if (err.code === 1) return 'denied';
  if (err.code === 3) return 'timeout';
  return 'unavailable';
}

/**
 * 取当前位置。带失败原因，便于区分「没授权」和「没信号」。
 *
 * @param force 为 true 时忽略缓存，强制重新定位
 */
export async function getPosition(force = false): Promise<GeoResult> {
  if (!force) {
    const hit = cachedPosition();
    if (hit) return { pos: hit };
  }

  if (!geoSupported()) return { pos: null, failure: 'unsupported' };

  return new Promise<GeoResult>((resolve) => {
    let settled = false;
    const done = (r: GeoResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    // 有些浏览器在无权限时不回调，自己加一道保险
    const timer = setTimeout(() => done({ pos: null, failure: 'timeout' }), TIMEOUT_MS + 1000);

    try {
      navigator.geolocation.getCurrentPosition(
        (raw) => {
          clearTimeout(timer);
          const p = toPosition(raw);
          if (!p) return done({ pos: null, failure: 'unavailable' });
          writeCache(p);
          done({ pos: p });
        },
        (err) => {
          clearTimeout(timer);
          done({ pos: null, failure: failureOf(err) });
        },
        { enableHighAccuracy: false, timeout: TIMEOUT_MS, maximumAge: POS_TTL_MS },
      );
    } catch {
      clearTimeout(timer);
      done({ pos: null, failure: 'unavailable' });
    }
  });
}

/**
 * 持续跟踪位置变化（真正「实时」的部分）。
 *
 * 只在页面可见时调用，切后台要清掉 —— 否则既费电又没意义。
 * 返回清理函数。
 */
export function watchPosition(onChange: (p: Position) => void): () => void {
  if (!geoSupported()) return () => {};

  let id: number | null = null;
  try {
    id = navigator.geolocation.watchPosition(
      (raw) => {
        const p = toPosition(raw);
        if (!p) return;
        writeCache(p);
        onChange(p);
      },
      () => {
        /* 跟踪失败静默忽略，已有缓存继续用 */
      },
      // 不需要高精度：城市级天气用粗定位就够，还省电
      { enableHighAccuracy: false, timeout: TIMEOUT_MS, maximumAge: 2 * 60 * 1000 },
    );
  } catch {
    return () => {};
  }

  return () => {
    if (id !== null) {
      try {
        navigator.geolocation.clearWatch(id);
      } catch {
        /* ignore */
      }
    }
  };
}

/** 两个坐标是否落在同一「城市级」格子（2 位小数 ≈ 1km）。 */
export function sameArea(a: Position | null, b: Position | null): boolean {
  if (!a || !b) return false;
  return (
    Math.round(a.lat * 100) === Math.round(b.lat * 100) &&
    Math.round(a.lon * 100) === Math.round(b.lon * 100)
  );
}
