/**
 * 金额处理：内部一律用「分」的整数，杜绝浮点误差。
 * 对外接受用户输入的元（如 "12.34"、"12"、"12.3"）。
 */

export type Cents = number;

/** 解析用户输入的元为分。失败返回 null。 */
export function parseYuanToCents(input: string): Cents | null {
  if (typeof input !== 'string') return null;
  const s = input.trim().replace(/[,，\s]/g, '').replace(/^¥|^￥/, '');
  if (!s) return null;
  // 允许 12 / 12.3 / 12.34 / .5
  if (!/^\d*(\.\d{0,2})?$/.test(s)) return null;
  if (s === '.' || s === '') return null;

  const [intPart = '', fracPart = ''] = s.split('.');
  const intVal = intPart === '' ? 0 : Number(intPart);
  if (!Number.isSafeInteger(intVal)) return null;
  const frac = (fracPart + '00').slice(0, 2);
  const fracVal = Number(frac);
  if (!Number.isSafeInteger(fracVal)) return null;

  const total = intVal * 100 + fracVal;
  if (!Number.isSafeInteger(total) || total < 0) return null;
  return total;
}

/** 分转元的展示字符串，固定两位小数。 */
export function formatCents(cents: Cents): string {
  if (!Number.isFinite(cents)) return '0.00';
  const neg = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const yuan = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${neg ? '-' : ''}${yuan}.${String(frac).padStart(2, '0')}`;
}

/** 分转元，带千分位。 */
export function formatCentsGrouped(cents: Cents): string {
  const s = formatCents(cents);
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [yuan = '0', frac = '00'] = body.split('.');
  const grouped = yuan.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}.${frac}`;
}
