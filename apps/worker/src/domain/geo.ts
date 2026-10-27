/**
 * 地理坐标与地名归一（纯函数，方便单测）。
 *
 * 定位链路的每一步都可能拿到脏数据：
 * - 浏览器 GPS 可能返回 0,0（未授权时的默认值）
 * - Cloudflare 边缘给的 cf.latitude 是字符串
 * - 反向地理编码给的是「大连市」，而卡片上想要「大连」
 * 这里统一收口，路由层只做编排。
 */

export interface LatLon {
  lat: number;
  lon: number;
}

/** 把 number / 数字字符串解析成有限数；其它一律 null。 */
export function parseCoord(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 校验并组装坐标。任何一项不合法都返回 null，调用方继续往下兜底，
 * 而不是报错 —— 天气不该因为坐标脏了就整块挂掉。
 */
export function parseLatLon(latRaw: unknown, lonRaw: unknown): LatLon | null {
  const lat = parseCoord(latRaw);
  const lon = parseCoord(lonRaw);
  if (lat === null || lon === null) return null;
  if (lat < -90 || lat > 90) return null;
  if (lon < -180 || lon > 180) return null;
  // 0,0 在几内亚湾，实际使用中几乎总是「定位失败但字段有值」的默认值
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

/** 按位数取整，用于缓存键：2 位小数 ≈ 1.1km，城市级天气完全够用。 */
export function roundCoord(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** 坐标 → 缓存键。同一个街区复用同一份天气。 */
export function cacheKeyOf(p: LatLon): string {
  return `${roundCoord(p.lat, 2)},${roundCoord(p.lon, 2)}`;
}

/**
 * 地名归一：去掉「市」后缀，并把常见繁体字折成简体。
 * 「大连市」→「大连」、「大連市」→「大连」；英文地名原样保留。
 */
export function normalizeCityName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let t = raw.trim();
  if (!t) return null;
  t = toSimplified(t);
  if (t.length >= 3 && t.endsWith('市')) return t.slice(0, -1);
  return t;
}

/**
 * 极简繁→简映射：只覆盖地名词里高频出现的字。
 *
 * 为什么不引入完整转换表：二维表动辄上千行，而这里只会遇到「城市名」，
 * 常见的繁体写法就那么几十个。宁可漏转，也不要把包撑大。
 * 上游已改用 zh-Hans 参数，这里是双保险。
 */
const T2S: Record<string, string> = {
  連: '连',
  廣: '广',
  東: '东',
  蘇: '苏',
  瀋: '沈',
  興: '兴',
  陽: '阳',
  開: '开',
  門: '门',
  廈: '厦',
  慶: '庆',
  貴: '贵',
  遼: '辽',
  寧: '宁',
  龍: '龙',
  鳳: '凤',
  臺: '台',
  灣: '湾',
  濟: '济',
  賓: '宾',
  齊: '齐',
  漢: '汉',
  滬: '沪',
  陝: '陕',
  鄭: '郑',
  郵: '邮',
  鐵: '铁',
  烏: '乌',
  葉: '叶',
  錦: '锦',
  雲: '云',
  駐: '驻',
  雞: '鸡',
  鶴: '鹤',
  瀾: '澜',
  滄: '沧',
  漁: '渔',
  壽: '寿',
  縣: '县',
  區: '区',
  鎮: '镇',
  鄉: '乡',
  島: '岛',
};

function toSimplified(s: string): string {
  let out = '';
  for (const ch of s) out += T2S[ch] ?? ch;
  return out;
}

/** 坐标是否落在同一个「城市级」格子内，用于判断是否需要重新定位。 */
export function sameArea(a: LatLon | null, b: LatLon | null): boolean {
  if (!a || !b) return false;
  return cacheKeyOf(a) === cacheKeyOf(b);
}
