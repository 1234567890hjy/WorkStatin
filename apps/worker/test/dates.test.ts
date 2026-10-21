import { describe, it, expect } from 'vitest';
import { normalizeOccurred, isValidDay, isValidMonth, expiryFromNow } from '../src/domain/dates';

describe('normalizeOccurred', () => {
  it('东八区墙上时间', () => {
    // UTC 2026-10-21T16:00:00Z = 北京时间 2026-10-22 00:00:00
    const r = normalizeOccurred('2026-10-21T16:00:00Z');
    expect(r.occurredDay).toBe('2026-10-22');
    expect(r.occurredMonth).toBe('2026-10');
    expect(r.occurredAt).toBe('2026-10-22T00:00:00+08:00');
  });

  it('跨月边界', () => {
    // UTC 2026-10-31T16:30:00Z = 北京时间 2026-11-01 00:30
    const r = normalizeOccurred('2026-10-31T16:30:00Z');
    expect(r.occurredDay).toBe('2026-11-01');
    expect(r.occurredMonth).toBe('2026-11');
  });

  it('跨年边界', () => {
    // UTC 2026-12-31T16:00:00Z = 北京时间 2027-01-01 00:00
    const r = normalizeOccurred('2026-12-31T16:00:00Z');
    expect(r.occurredDay).toBe('2027-01-01');
    expect(r.occurredMonth).toBe('2027-01');
  });

  it('默认取当前时间', () => {
    const r = normalizeOccurred();
    expect(r.occurredDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.occurredMonth).toMatch(/^\d{4}-\d{2}$/);
    expect(r.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
  });

  it('非法输入回退到当前时间', () => {
    const r = normalizeOccurred('not-a-date');
    expect(r.occurredDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('isValidDay', () => {
  it('合法日期', () => {
    expect(isValidDay('2026-10-21')).toBe(true);
    expect(isValidDay('2024-02-29')).toBe(true); // 闰年
  });

  it('非法日期', () => {
    expect(isValidDay('2026-13-01')).toBe(false);
    expect(isValidDay('2026-02-30')).toBe(false);
    expect(isValidDay('2025-02-29')).toBe(false); // 非闰年
    expect(isValidDay('2026-1-1')).toBe(false);
    expect(isValidDay('abc')).toBe(false);
  });
});

describe('isValidMonth', () => {
  it('合法月份', () => {
    expect(isValidMonth('2026-01')).toBe(true);
    expect(isValidMonth('2026-12')).toBe(true);
  });

  it('非法月份', () => {
    expect(isValidMonth('2026-00')).toBe(false);
    expect(isValidMonth('2026-13')).toBe(false);
    expect(isValidMonth('2026-1')).toBe(false);
  });
});

describe('expiryFromNow', () => {
  it('返回未来的 ISO 时间', () => {
    const e = expiryFromNow(30);
    const t = new Date(e).getTime();
    expect(t).toBeGreaterThan(Date.now());
    // 约 30 天后（容忍 1 分钟误差）
    const expected = Date.now() + 30 * 24 * 3600 * 1000;
    expect(Math.abs(t - expected)).toBeLessThan(60_000);
  });
});
