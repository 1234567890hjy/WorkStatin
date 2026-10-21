/**
 * 日期工具：统一产出 occurred_at / occurred_day / occurred_month。
 * 时区固定按东八区处理（单人自用，不引入时区库）。
 */

const CN_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 把任意时间戳规范成东八区的 YYYY-MM-DD / YYYY-MM 与 ISO 字符串。 */
export function normalizeOccurred(input?: string | number | Date): {
  occurredAt: string;
  occurredDay: string;
  occurredMonth: string;
} {
  const d = input === undefined ? new Date() : new Date(input);
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;

  // 东八区的「墙上时间」
  const cn = new Date(safe.getTime() + CN_OFFSET_MS);
  const y = cn.getUTCFullYear();
  const m = String(cn.getUTCMonth() + 1).padStart(2, '0');
  const day = String(cn.getUTCDate()).padStart(2, '0');
  const hh = String(cn.getUTCHours()).padStart(2, '0');
  const mm = String(cn.getUTCMinutes()).padStart(2, '0');
  const ss = String(cn.getUTCSeconds()).padStart(2, '0');

  return {
    occurredAt: `${y}-${m}-${day}T${hh}:${mm}:${ss}+08:00`,
    occurredDay: `${y}-${m}-${day}`,
    occurredMonth: `${y}-${m}`,
  };
}

/** 校验 YYYY-MM-DD。 */
export function isValidDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 校验 YYYY-MM。 */
export function isValidMonth(s: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(s)) return false;
  const m = Number(s.slice(5, 7));
  return m >= 1 && m <= 12;
}

/** 当前月（东八区）。 */
export function currentMonth(): string {
  return normalizeOccurred().occurredMonth;
}

/** 当前日（东八区）。 */
export function currentDay(): string {
  return normalizeOccurred().occurredDay;
}

/** 会话过期时间：now + days。 */
export function expiryFromNow(days: number): string {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}
