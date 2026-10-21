import { describe, it, expect } from 'vitest';
import { parseShareText } from '../src/domain/share-parse';

describe('parseShareText —— 银行/支付短信', () => {
  it('微信支付通知', () => {
    const r = parseShareText('微信支付 向 瑞幸咖啡 支付 12.34 元');
    expect(r).not.toBeNull();
    expect(r!.amountCents).toBe(1234);
    expect(r!.merchant).toBe('瑞幸咖啡');
    expect(r!.confidence).toBe('high');
  });

  it('支付宝消费', () => {
    const r = parseShareText('您有一笔支付宝消费12.34元，商户：全家便利店');
    expect(r).not.toBeNull();
    expect(r!.amountCents).toBe(1234);
    expect(r!.merchant).toBe('全家便利店');
  });

  it('银行扣款短信', () => {
    const r = parseShareText('【招商银行】您账户于10月21日支出￥58.00，商户名称：美团');
    expect(r).not.toBeNull();
    expect(r!.amountCents).toBe(5800);
    expect(r!.merchant).toBe('美团');
  });

  it('带千分位的金额', () => {
    const r = parseShareText('消费 ￥1,234.56 元');
    expect(r).not.toBeNull();
    expect(r!.amountCents).toBe(123456);
  });

  it('负数金额取绝对值', () => {
    const r = parseShareText('账户变动 -25.50');
    expect(r).not.toBeNull();
    expect(r!.amountCents).toBe(2550);
  });
});

describe('parseShareText —— 边界与拒绝', () => {
  it('无金额返回 null', () => {
    expect(parseShareText('今天天气不错')).toBeNull();
  });

  it('空文本返回 null', () => {
    expect(parseShareText('')).toBeNull();
    expect(parseShareText('   ')).toBeNull();
  });

  it('超长文本返回 null', () => {
    expect(parseShareText('消费12元' + 'x'.repeat(2000))).toBeNull();
  });

  it('金额为 0 视为无效', () => {
    expect(parseShareText('消费 0.00 元')).toBeNull();
  });

  it('非字符串返回 null', () => {
    expect(parseShareText(null as unknown as string)).toBeNull();
    expect(parseShareText(undefined as unknown as string)).toBeNull();
  });

  it('有金额无商户时置信度为 medium', () => {
    const r = parseShareText('消费12.34');
    expect(r).not.toBeNull();
    expect(r!.amountCents).toBe(1234);
    expect(r!.confidence).toBe('medium');
  });

  it('超大金额被拒绝', () => {
    expect(parseShareText('消费 999999999 元')).toBeNull();
  });
});
