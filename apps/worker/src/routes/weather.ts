/**
 * 天气卡片。
 *
 * 设计要点：
 * 1. 密钥只存在 Worker 环境变量里，前端永远看不到；
 * 2. Worker 侧缓存 30 分钟（Cache API），避免每次打开页面都打第三方；
 * 3. 无密钥时返回「未配置」而不是报错 —— 天气是锦上添花，不能挡住主流程。
 *
 * 用的是 Open-Meteo：免密钥、免费、无需注册，适合单人自用。
 * 如果以后换成需要 key 的服务，只需在这里改 URL 与解析。
 */

import { Hono } from 'hono';
import type { Env } from '../types.ts';
import { ok } from '../http.ts';
import { requireSession } from './auth.ts';

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

weatherRoutes.get('/', async (c) => {
  // 位置可在环境变量里配；默认北京
  const lat = c.env.WEATHER_LAT ?? '39.9042';
  const lon = c.env.WEATHER_LON ?? '116.4074';
  const label = c.env.WEATHER_LABEL ?? '北京';

  const cacheKey = new Request(
    `https://weather-cache.internal/${lat},${lon}`,
    { method: 'GET' },
  );

  // 优先读 Cache API（30 分钟）
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const data = (await cached.json()) as unknown;
    return ok({ ...(data as object), cached: true });
  }

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}` +
    `&longitude=${encodeURIComponent(lon)}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
    '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max' +
    '&timezone=Asia%2FShanghai&forecast_days=3';

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: { 'User-Agent': 'workstation-me/0.1' },
    });
  } catch {
    return ok({ available: false, reason: '网络不可达', label });
  }

  if (!upstream.ok) {
    return ok({ available: false, reason: `上游返回 ${upstream.status}`, label });
  }

  const json = (await upstream.json().catch(() => null)) as OpenMeteoResponse | null;
  if (!json?.current) {
    return ok({ available: false, reason: '上游返回格式异常', label });
  }

  const cur = json.current;
  const code = cur.weather_code ?? -1;
  const desc = describe(code);

  const payload = {
    available: true,
    label,
    current: {
      temp: cur.temperature_2m ?? null,
      feels_like: cur.apparent_temperature ?? null,
      humidity: cur.relative_humidity_2m ?? null,
      wind: cur.wind_speed_10m ?? null,
      code,
      text: desc.text,
      icon: desc.icon,
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
    cached: false,
  };

  // 写缓存 30 分钟
  const toCache = new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=1800' },
  });
  c.executionCtx.waitUntil(caches.default.put(cacheKey, toCache));

  return ok(payload);
});
