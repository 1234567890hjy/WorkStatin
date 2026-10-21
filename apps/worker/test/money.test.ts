import { describe, it, expect } from 'vitest';
import { parseYuanToCents, formatCents, formatCentsGrouped } from '../src/domain/money';

describe('parseYuanToCents', () => {
  it('整数元', () => {
    expect(parseYuanToCents('12')).toBe(1200);
    expect(parseYuanToCents('0')).toBe(0);
  });

  it('两位小数', () => {
    expect(parseYuanToCents('12.34')).toBe(1234);
    expect(parseYuanToCents('0.01')).toBe(1);
    expect(parseYuanToCents('0.1')).toBe(10);
  });

  it('一位小数补齐', () => {
    expect(parseYuanToCents('12.3')).toBe(1230);
  });

  it('允许省略整数部分', () => {
    expect(parseYuanToCents('.5')).toBe(50);
  });

  it('去掉货币符号、千分位、空白', () => {
    expect(parseYuanToCents('¥12.34')).toBe(1234);
    expect(parseYuanToCents('￥ 1,234.56')).toBe(123456);
    expect(parseYuanToCents(' 12.34 ')).toBe(1234);
  });

  it('拒绝非法输入', () => {
    expect(parseYuanToCents('')).toBeNull();
    expect(parseYuanToCents('abc')).toBeNull();
    expect(parseYuanToCents('12.345')).toBeNull(); // 超过两位小数
    expect(parseYuanToCents('12.3.4')).toBeNull();
    expect(parseYuanToCents('-5')).toBeNull();
    expect(parseYuanToCents('.')).toBeNull();
  });

  it('避免浮点误差（0.1 + 0.2 类问题）', () => {
    // 用浮点算 0.29 * 100 = 28.999999999999996
    expect(parseYuanToCents('0.29')).toBe(29);
    expect(parseYuanToCents('1.15')).toBe(115);
    expect(parseYuanToCents('8.20')).toBe(820);
  });
});

describe('formatCents', () => {
  it('基本格式', () => {
    expect(formatCents(1234)).toBe('12.34');
    expect(formatCents(0)).toBe('0.00');
    expect(formatCents(1)).toBe('0.01');
    expect(formatCents(100)).toBe('1.00');
  });

  it('负数', () => {
    expect(formatCents(-1234)).toBe('-12.34');
    expect(formatCents(-1)).toBe('-0.01');
  });
});

describe('formatCentsGrouped', () => {
  it('千分位', () => {
    expect(formatCentsGrouped(123456)).toBe('1,234.56');
    expect(formatCentsGrouped(123456789)).toBe('1,234,567.89');
    expect(formatCentsGrouped(100)).toBe('1.00');
  });

  it('负数千分位', () => {
    expect(formatCentsGrouped(-123456)).toBe('-1,234.56');
  });
});
