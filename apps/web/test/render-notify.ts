/**
 * 通知前端逻辑验证。
 *
 * 为什么测的是纯函数而不是组件：
 *   本环境 `vite build` 会因 esbuild 子进程失败（见 README 沙箱说明），
 *   装了 jsdom 也跑不起 React 渲染。而把「算什么」抽成纯函数后，
 *   真正容易出错的部分（金额符号、千分位、倒计时文案、渠道映射）
 *   可以被完整断言 —— 这比「渲染出一坨 HTML 然后字符串包含」更有价值。
 *
 * 用法：node --experimental-strip-types apps/web/test/render-notify.ts
 */

import assert from 'node:assert/strict';
import {
  channelLabel,
  reasonLabel,
  undoCountdownText,
  buildUndoToast,
} from '../src/notify-format.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    const msg = (e as Error).message.split('\n')[0];
    failures.push(`${name}\n    ${msg}`);
    console.log(`  ✗ ${name}\n    ${msg}`);
  }
}

console.log('\n=== 通知前端逻辑验证 ===\n');

// ---------- 渠道 ----------
console.log('[渠道标签]');

test('四个渠道都有中文名', () => {
  assert.equal(channelLabel('wechat'), '微信');
  assert.equal(channelLabel('alipay'), '支付宝');
  assert.equal(channelLabel('bank'), '银行卡');
  assert.equal(channelLabel('unknown'), '未知渠道');
});

test('后端新增渠道时原样返回，不显示空白', () => {
  assert.equal(channelLabel('unionpay'), 'unionpay');
});

// ---------- 失败原因 ----------
console.log('\n[未识别原因]');

test('已知原因翻译成可读文案', () => {
  assert.equal(reasonLabel('no_amount'), '没找到金额');
  assert.equal(reasonLabel('refund_without_amount'), '退款通知缺金额');
  assert.equal(reasonLabel('too_long'), '内容过长');
});

test('null 与未知原因有兜底', () => {
  assert.equal(reasonLabel(null), '未识别');
  assert.equal(reasonLabel('brand_new_reason'), 'brand_new_reason');
});

// ---------- 倒计时 ----------
console.log('\n[撤销倒计时]');

test('300 秒窗口文案', () => {
  assert.equal(undoCountdownText(5 * 60_000), '300s 内可撤销');
});

test('不足 1 秒向上取整', () => {
  assert.equal(undoCountdownText(1), '1s 内可撤销');
  assert.equal(undoCountdownText(999), '1s 内可撤销');
});

test('已过期不显示负数', () => {
  assert.equal(undoCountdownText(-5000), '0s 内可撤销');
});

// ---------- toast 模型 ----------
console.log('\n[撤销 toast]');

test('支出：负号 + 千分位', () => {
  const m = buildUndoToast(
    { type: 'expense', amount_cents: 123456, account_name: '微信' },
    300_000,
  );
  assert.equal(m.title, '自动记了一笔 -¥1,234.56');
  assert.ok(m.detail.includes('微信'));
  assert.ok(m.detail.includes('300s 内可撤销'));
});

test('收入：正号', () => {
  const m = buildUndoToast(
    { type: 'income', amount_cents: 8800, account_name: '微信' },
    300_000,
  );
  assert.equal(m.title, '自动记了一笔 +¥88.00');
});

test('小额金额补零', () => {
  const m = buildUndoToast(
    { type: 'expense', amount_cents: 5 },
    300_000,
  );
  assert.equal(m.title, '自动记了一笔 -¥0.05');
});

test('整元显示两位小数', () => {
  const m = buildUndoToast(
    { type: 'expense', amount_cents: 1500 },
    300_000,
  );
  assert.equal(m.title, '自动记了一笔 -¥15.00');
});

test('有商户时附加到 detail', () => {
  const m = buildUndoToast(
    { type: 'expense', amount_cents: 1234, account_name: '现金', merchant: '瑞幸咖啡' },
    300_000,
  );
  assert.ok(m.detail.includes('现金'), m.detail);
  assert.ok(m.detail.includes('瑞幸咖啡'), m.detail);
});

test('无账户无商户时 detail 只有倒计时', () => {
  const m = buildUndoToast(
    { type: 'expense', amount_cents: 100, account_name: null, merchant: null },
    300_000,
  );
  assert.equal(m.detail, '300s 内可撤销');
});

test('过期后 canUndo=false', () => {
  const m = buildUndoToast({ type: 'expense', amount_cents: 100 }, 0);
  assert.equal(m.canUndo, false);
  const m2 = buildUndoToast({ type: 'expense', amount_cents: 100 }, -1);
  assert.equal(m2.canUndo, false);
});

test('窗口内 canUndo=true', () => {
  const m = buildUndoToast({ type: 'expense', amount_cents: 100 }, 1);
  assert.equal(m.canUndo, true);
});

// ---------- 汇总 ----------
console.log(`\n${'='.repeat(50)}`);
if (failed === 0) {
  console.log(`✅ 前端逻辑全部通过：${passed} 项`);
} else {
  console.log(`❌ 失败 ${failed} 项 / 通过 ${passed} 项`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
