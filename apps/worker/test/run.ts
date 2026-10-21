/**
 * 自包含测试跑器：沙箱禁止 spawn 子进程（esbuild / node --test 都起不来），
 * 所以直接 import 模块 + node:assert，单进程跑完。
 *
 * 用法：node --experimental-strip-types test/run.ts
 */

import assert from 'node:assert/strict';
import { parseYuanToCents, formatCents, formatCentsGrouped } from '../src/domain/money.ts';
import { parseShareText } from '../src/domain/share-parse.ts';
import { normalizeOccurred, isValidDay, isValidMonth, expiryFromNow } from '../src/domain/dates.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}\n    ${(e as Error).message.split('\n')[0]}`);
  }
}

// ============ money ============
test('money: 整数元', () => {
  assert.equal(parseYuanToCents('12'), 1200);
  assert.equal(parseYuanToCents('0'), 0);
});

test('money: 两位小数', () => {
  assert.equal(parseYuanToCents('12.34'), 1234);
  assert.equal(parseYuanToCents('0.01'), 1);
  assert.equal(parseYuanToCents('0.1'), 10);
});

test('money: 一位小数补齐', () => {
  assert.equal(parseYuanToCents('12.3'), 1230);
});

test('money: 省略整数部分', () => {
  assert.equal(parseYuanToCents('.5'), 50);
});

test('money: 货币符号与千分位', () => {
  assert.equal(parseYuanToCents('¥12.34'), 1234);
  assert.equal(parseYuanToCents('￥ 1,234.56'), 123456);
  assert.equal(parseYuanToCents(' 12.34 '), 1234);
});

test('money: 拒绝非法输入', () => {
  assert.equal(parseYuanToCents(''), null);
  assert.equal(parseYuanToCents('abc'), null);
  assert.equal(parseYuanToCents('12.345'), null);
  assert.equal(parseYuanToCents('12.3.4'), null);
  assert.equal(parseYuanToCents('-5'), null);
  assert.equal(parseYuanToCents('.'), null);
});

test('money: 无浮点误差', () => {
  assert.equal(parseYuanToCents('0.29'), 29);
  assert.equal(parseYuanToCents('1.15'), 115);
  assert.equal(parseYuanToCents('8.20'), 820);
});

test('money: formatCents', () => {
  assert.equal(formatCents(1234), '12.34');
  assert.equal(formatCents(0), '0.00');
  assert.equal(formatCents(1), '0.01');
  assert.equal(formatCents(100), '1.00');
  assert.equal(formatCents(-1234), '-12.34');
  assert.equal(formatCents(-1), '-0.01');
});

test('money: formatCentsGrouped', () => {
  assert.equal(formatCentsGrouped(123456), '1,234.56');
  assert.equal(formatCentsGrouped(123456789), '1,234,567.89');
  assert.equal(formatCentsGrouped(100), '1.00');
  assert.equal(formatCentsGrouped(-123456), '-1,234.56');
});

// ============ share-parse ============
test('share: 微信支付通知', () => {
  const r = parseShareText('微信支付 向 瑞幸咖啡 支付 12.34 元');
  assert.ok(r);
  assert.equal(r.amountCents, 1234);
  assert.equal(r.merchant, '瑞幸咖啡');
  assert.equal(r.confidence, 'high');
});

test('share: 支付宝消费', () => {
  const r = parseShareText('您有一笔支付宝消费12.34元，商户：全家便利店');
  assert.ok(r);
  assert.equal(r.amountCents, 1234);
  assert.equal(r.merchant, '全家便利店');
});

test('share: 银行扣款短信', () => {
  const r = parseShareText('【招商银行】您账户于10月21日支出￥58.00，商户名称：美团');
  assert.ok(r);
  assert.equal(r.amountCents, 5800);
  assert.equal(r.merchant, '美团');
});

test('share: 千分位金额', () => {
  const r = parseShareText('消费 ￥1,234.56 元');
  assert.ok(r);
  assert.equal(r.amountCents, 123456);
});

test('share: 负数金额取绝对值', () => {
  const r = parseShareText('账户变动 -25.50');
  assert.ok(r);
  assert.equal(r.amountCents, 2550);
});

test('share: 无金额返回 null', () => {
  assert.equal(parseShareText('今天天气不错'), null);
});

test('share: 空文本返回 null', () => {
  assert.equal(parseShareText(''), null);
  assert.equal(parseShareText('   '), null);
});

test('share: 超长文本返回 null', () => {
  assert.equal(parseShareText('消费12元' + 'x'.repeat(2000)), null);
});

test('share: 金额 0 无效', () => {
  assert.equal(parseShareText('消费 0.00 元'), null);
});

test('share: 非字符串返回 null', () => {
  assert.equal(parseShareText(null as unknown as string), null);
  assert.equal(parseShareText(undefined as unknown as string), null);
});

test('share: 无商户时 medium', () => {
  const r = parseShareText('消费12.34');
  assert.ok(r);
  assert.equal(r.amountCents, 1234);
  assert.equal(r.confidence, 'medium');
});

test('share: 超大金额拒绝', () => {
  assert.equal(parseShareText('消费 999999999 元'), null);
});

// ============ dates ============
test('dates: 东八区墙上时间', () => {
  const r = normalizeOccurred('2026-10-21T16:00:00Z');
  assert.equal(r.occurredDay, '2026-10-22');
  assert.equal(r.occurredMonth, '2026-10');
  assert.equal(r.occurredAt, '2026-10-22T00:00:00+08:00');
});

test('dates: 跨月边界', () => {
  const r = normalizeOccurred('2026-10-31T16:30:00Z');
  assert.equal(r.occurredDay, '2026-11-01');
  assert.equal(r.occurredMonth, '2026-11');
});

test('dates: 跨年边界', () => {
  const r = normalizeOccurred('2026-12-31T16:00:00Z');
  assert.equal(r.occurredDay, '2027-01-01');
  assert.equal(r.occurredMonth, '2027-01');
});

test('dates: 默认取当前时间', () => {
  const r = normalizeOccurred();
  assert.match(r.occurredDay, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(r.occurredMonth, /^\d{4}-\d{2}$/);
  assert.match(r.occurredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
});

test('dates: 非法输入回退', () => {
  const r = normalizeOccurred('not-a-date');
  assert.match(r.occurredDay, /^\d{4}-\d{2}-\d{2}$/);
});

test('dates: isValidDay 合法', () => {
  assert.equal(isValidDay('2026-10-21'), true);
  assert.equal(isValidDay('2024-02-29'), true);
});

test('dates: isValidDay 非法', () => {
  assert.equal(isValidDay('2026-13-01'), false);
  assert.equal(isValidDay('2026-02-30'), false);
  assert.equal(isValidDay('2025-02-29'), false);
  assert.equal(isValidDay('2026-1-1'), false);
  assert.equal(isValidDay('abc'), false);
});

test('dates: isValidMonth', () => {
  assert.equal(isValidMonth('2026-01'), true);
  assert.equal(isValidMonth('2026-12'), true);
  assert.equal(isValidMonth('2026-00'), false);
  assert.equal(isValidMonth('2026-13'), false);
  assert.equal(isValidMonth('2026-1'), false);
});

test('dates: expiryFromNow', () => {
  const e = expiryFromNow(30);
  const t = new Date(e).getTime();
  assert.ok(t > Date.now());
  const expected = Date.now() + 30 * 24 * 3600 * 1000;
  assert.ok(Math.abs(t - expected) < 60_000);
});

// ============ 汇总 ============
console.log(`\n${'='.repeat(50)}`);
if (failed === 0) {
  console.log(`✅ 全部通过：${passed} 项`);
} else {
  console.log(`❌ 失败 ${failed} 项 / 通过 ${passed} 项`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
