/** 金额格式化（前端侧，与后端 money.ts 保持同一语义）。 */

export function formatYuan(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const yuan = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${neg ? '-' : ''}${yuan}.${String(frac).padStart(2, '0')}`;
}

export function formatYuanGrouped(cents: number): string {
  const s = formatYuan(cents);
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [yuan = '0', frac = '00'] = body.split('.');
  const grouped = yuan.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}.${frac}`;
}
