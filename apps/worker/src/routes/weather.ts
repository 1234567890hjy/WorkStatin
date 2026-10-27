/**
 * 天气卡片 —— 支持实时定位。
 *
 * 定位优先级（前端拿到坐标就传过来，拿不到就靠边缘）：
 *   1. 前端 GPS / 浏览器定位 → ?lat=&lon=   （source: gps）
 *   2. Cloudflare 边缘推断的城市坐标         （source: edge）
 *   3. 环境变量里配的兜底坐标                （source: config）
 *
 * 设计要点：
 * 1. 密钥只存在 Worker 环境变量里，前端永远看不到；
 * 2. 缓存按「坐标格子」分片（2 位小数 ≈ 1km），换城市立刻换一份；
 * 3. 任何一步失败都往下兜底，不抛错 —— 天气是锦上添花，不能挡住主流程；
 * 4. 精确坐标只在请求内使用，不落库、不打日志。
 *
 * 用的是 Open-Meteo（天气，免密钥）+ BigDataCloud（反查城市名，免密钥）。
 */

import { Hono } from 'hono';
import type { Env } from '../types.ts';
import { ok } from '../http.ts';
import { requireSession } from './auth.ts';
import { parseLatLon, cacheKeyOf, normalizeCityName, type LatLon } from '../domain/geo.ts';

export const weatherRoutes = new Hono<{ Bindings: Env }>();

/** WMO 天气代码 → 中文描述 + 图标 */
const WMO: Record<number, { text: string; icon: string }> = {
  0: { text: '晴', icon: '☀️' },
  1: { text: '晴间多云', icon: '🌤️' },
  2: { text: '多云', icon: '⛅' },
  3: { text: '阴', icon: '☁️' },
  45: { text: '雾', icon: '🌫️' },
  48: { text: '雾凇', icon: '🌫️' },
  51: { text: '小毛毛雨', icon: '🌦️' },
  53: { text: '毛毛雨', icon: '🌦️' },
  55: { text: '大毛毛雨', icon: '🌧️' },
  56: { text: '冻毛毛雨', icon: '🌧️' },
  57: { text: '强冻毛毛雨', icon: '🌧️' },
  61: { text: '小雨', icon: '🌦️' },
  63: { text: '中雨', icon: '🌧️' },
  65: { text: '大雨', icon: '🌧️' },
  66: { text: '冻雨', icon: '🌧️' },
  67: { text: '强冻雨', icon: '🌧️' },
  71: { text: '小雪', icon: '🌨️' },
  73: { text: '中雪', icon: '🌨️' },
  75: { text: '大雪', icon: '❄️' },
  77: { text: '米雪', icon: '🌨️' },
  80: { text: '阵雨', icon: '🌦️' },
  81: { text: '强阵雨', icon: '🌧️' },
  82: { text: '暴雨', icon: '⛈️' },
  85: { text: '阵雪', icon: '🌨️' },
  86: { text: '强阵雪', icon: '❄️' },
  95: { text: '雷阵雨', icon: '⛈️' },
  96: { text: '雷阵雨伴冰雹', icon: '⛈️' },
  99: { text: '强雷阵雨伴冰雹', icon: '⛈️' },
};

function describe(code: number): { text: string; icon: string } {
  return WMO[code] ?? { text: '未知', icon: '🌡️' };
}

interface OpenMeteoResponse {
  current?: {
    temperature_2m?: number;
    relative_humidity_2m?: number;
    apparent_temperature?: number;
    weather_code?: number;
    wind_speed_10m?: number;
  };
  daily?: {
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    weather_code?: number[];
    precipitation_probability_max?: number[];
  };
}

interface ReverseGeoResponse {
  city?: string;
  locality?: string;
  principalSubdivision?: string;
}

weatherRoutes.use('*', async (c, next) => {
  const session = await requireSession(c.env, c.req.raw);
  if (!session) return err401();
  await next();
});

function err401() {
  return Response.json(
    { ok: false, error: { code: 'UNAUTHORIZED', message: '未登录或会话已过期' } },
    { status: 401 },
  );
}

/**
 * Cloudflare 边缘推断的坐标。
 * 本地 dev 或某些网络下 cf 对象不存在，返回 null 交给下一级兜底。
 */
function edgeCoord(req: Request): LatLon | null {
  const cf = (req as Request & { cf?: Record<string, unknown> }).cf;
  if (!cf) return null;
  return parseLatLon(cf.latitude, cf.longitude);
}

/** 环境变量兜底坐标（保持老行为：不配就是北京）。 */
function configCoord(env: Env): { point: LatLon; label: string } {
  const point =
    parseLatLon(env.WEATHER_LAT ?? '39.9042', env.WEATHER_LON ?? '116.4074') ?? {
      lat: 39.9042,
      lon: 116.4074,
    };
  return { point, label: normalizeCityName(env.WEATHER_LABEL) ?? '北京' };
}

/**
 * 反查城市名。失败返回 null（调用方用兜底名），不抛错。
 *
 * 用 BigDataCloud 的 reverse-geocode-client：免密钥、免费额度够单人自用。
 * 注意两点（都实测过）：
 * 1. localityLanguage 必须用 zh-Hans，zh 会返回繁体「大連市」；
 * 2. 带 User-Agent 时它会 307 到 api-bdc.io，云端 fetch 默认跟随，无需特殊处理。
 */
async function reverseGeocode(p: LatLon): Promise<string | null> {
  const url =
    'https://api.bigdatacloud.net/data/reverse-geocode-client' +
    `?latitude=${encodeURIComponent(p.lat)}` +
    `&longitude=${encodeURIComponent(p.lon)}` +
    '&localityLanguage=zh-Hans';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'workstation-me/0.1' } });
    if (!res.ok) return null;
    const j = (await res.json().catch(() => null)) as ReverseGeoResponse | null;
    if (!j) return null;
    // city 是「大连市」，locality 是区县；优先 city
    return normalizeCityName(j.city) ?? normalizeCityName(j.locality) ?? null;
  } catch {
    return null;
  }
}

/** Cache API 在测试环境/某些运行时不存在，统一包一层。 */
function cacheOrNull(): Cache | null {
  try {
    return typeof caches !== 'undefined' && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

/**
 * 后台写缓存。
 * executionCtx 在单测（直接 app.fetch）里不存在，直接调会抛错，
 * 而写缓存失败绝不该影响这次响应，所以整段吞掉。
 */
function background(c: { executionCtx?: unknown }, task: Promise<unknown>): void {
  try {
    const ctx = c.executionCtx as { waitUntil?: (p: Promise<unknown>) => void } | undefined;
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(task);
      return;
    }
  } catch {
    /* 没有 executionCtx，落到下面的 void */
  }
  // 没有运行时上下文时让它在后台自己跑完，不阻塞响应
  void task.catch(() => undefined);
}

weatherRoutes.get('/', async (c) => {
  // ---- 1. 定坐标：GPS > 边缘 > 配置 ----
  const qLat = c.req.query('lat');
  const qLon = c.req.query('lon');

  let point: LatLon;
  let source: 'gps' | 'edge' | 'config';
  let fallbackLabel: string;

  const gps = parseLatLon(qLat, qLon);
  const cfg = configCoord(c.env);

  if (gps) {
    point = gps;
    source = 'gps';
    fallbackLabel = '';
  } else {
    const edge = edgeCoord(c.req.raw);
    if (edge) {
      point = edge;
      source = 'edge';
      fallbackLabel = '';
    } else {
      point = cfg.point;
      source = 'config';
      fallbackLabel = cfg.label;
    }
  }

  const grid = cacheKeyOf(point);
  const cache = cacheOrNull();

  // ---- 2. 天气本体（按坐标格子缓存 30 分钟）----
  const weatherKey = new Request(`https://weather-cache.internal/${grid}`, { method: 'GET' });

  let payload: Record<string, unknown> | null = null;
  let cached = false;

  if (cache) {
    const hit = await cache.match(weatherKey).catch(() => null);
    if (hit) {
      payload = (await hit.json().catch(() => null)) as Record<string, unknown> | null;
      cached = payload !== null;
    }
  }

  if (!payload) {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(point.lat)}` +
      `&longitude=${encodeURIComponent(point.lon)}` +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
      '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max' +
      '&timezone=auto&forecast_days=3';

    let upstream: Response;
    try {
      upstream = await fetch(url, { headers: { 'User-Agent': 'workstation-me/0.1' } });
    } catch {
      return ok({ available: false, reason: '网络不可达', label: fallbackLabel || '—', source });
    }

    if (!upstream.ok) {
      return ok({
        available: false,
        reason: `上游返回 ${upstream.status}`,
        label: fallbackLabel || '—',
        source,
      });
    }

    const json = (await upstream.json().catch(() => null)) as OpenMeteoResponse | null;
    if (!json?.current) {
      return ok({ available: false, reason: '上游返回格式异常', label: fallbackLabel || '—', source });
    }

    const cur = json.current;
    const code = cur.weather_code ?? -1;

    payload = {
      available: true,
      current: {
        temp: cur.temperature_2m ?? null,
        feels_like: cur.apparent_temperature ?? null,
        humidity: cur.relative_humidity_2m ?? null,
        wind: cur.wind_speed_10m ?? null,
        code,
        text: describe(code).text,
        icon: describe(code).icon,
      },
      daily: (json.daily?.temperature_2m_max ?? []).map((max, i) => ({
        max,
        min: json.daily?.temperature_2m_min?.[i] ?? null,
        code: json.daily?.weather_code?.[i] ?? -1,
        text: describe(json.daily?.weather_code?.[i] ?? -1).text,
        icon: describe(json.daily?.weather_code?.[i] ?? -1).icon,
        rain_prob: json.daily?.precipitation_probability_max?.[i] ?? null,
      })),
      updated_at: new Date().toISOString(),
    };

    if (cache) {
      const toCache = new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=1800' },
      });
      background(c, cache.put(weatherKey, toCache));
    }
  }

  // ---- 3. 城市名（按坐标格子缓存 24 小时，地名变得慢）----
  let label = fallbackLabel;
  if (!label) {
    const nameKey = new Request(`https://weather-name.internal/${grid}`, { method: 'GET' });
    let resolved: string | null = null;

    if (cache) {
      const hit = await cache.match(nameKey).catch(() => null);
      if (hit) resolved = normalizeCityName(await hit.text().catch(() => ''));
    }

    if (!resolved) {
      resolved = await reverseGeocode(point);
      if (resolved && cache) {
        const toCache = new Response(resolved, {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'max-age=86400' },
        });
        background(c, cache.put(nameKey, toCache));
      }
    }

    label = resolved ?? (source === 'gps' ? '当前位置' : '未知位置');
  }

  return ok({
    ...payload,
    label,
    lat: Number(point.lat.toFixed(4)),
    lon: Number(point.lon.toFixed(4)),
    source,
    cached,
  });
});
