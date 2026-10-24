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
import { validateTask } from '../src/domain/task.ts';
import { validateRoutine, periodRange, currentStreak } from '../src/domain/routine.ts';
import { validateAccountCreate, validateCategory } from '../src/domain/meta.ts';

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

// ============ task ============
function okValue(b: Parameters<typeof validateTask>[0]) {
  const r = validateTask(b);
  if ('error' in r) throw new Error(`期望通过，却报错 ${r.error.code}`);
  return r.value;
}

function errCode(b: Parameters<typeof validateTask>[0]) {
  const r = validateTask(b);
  if (!('error' in r)) throw new Error('期望报错，却通过了');
  return r.error.code;
}

test('task: 最小输入通过，默认值与中优先级', () => {
  const v = okValue({ title: '写周报' });
  assert.equal(v.title, '写周报');
  assert.equal(v.status, 'todo');
  assert.equal(v.priority, 2);
  assert.equal(v.dueDay, null);
  assert.equal(v.detail, null);
});

test('task: 标题去除首尾空格', () => {
  assert.equal(okValue({ title: '  买菜  ' }).title, '买菜');
});

test('task: 空标题被拒', () => {
  assert.equal(errCode({ title: '' }), 'EMPTY_TITLE');
  assert.equal(errCode({ title: '   ' }), 'EMPTY_TITLE');
  assert.equal(errCode({}), 'EMPTY_TITLE');
  assert.equal(errCode({ title: undefined }), 'EMPTY_TITLE');
});

test('task: 超长标题被拒', () => {
  assert.equal(errCode({ title: 'x'.repeat(121) }), 'TITLE_TOO_LONG');
});

test('task: 120 字标题刚好通过', () => {
  assert.equal(okValue({ title: 'x'.repeat(120) }).title.length, 120);
});

test('task: 非法状态被拒', () => {
  assert.equal(errCode({ title: 'x', status: 'bogus' }), 'INVALID_STATUS');
  assert.equal(errCode({ title: 'x', status: 'TODO' }), 'INVALID_STATUS');
});

test('task: 四个合法状态都通过', () => {
  for (const s of ['todo', 'doing', 'done', 'dropped'] as const) {
    assert.equal(okValue({ title: 'x', status: s }).status, s);
  }
});

test('task: 非法优先级被拒', () => {
  assert.equal(errCode({ title: 'x', priority: 0 }), 'INVALID_PRIORITY');
  assert.equal(errCode({ title: 'x', priority: 4 }), 'INVALID_PRIORITY');
  assert.equal(errCode({ title: 'x', priority: 1.5 }), 'INVALID_PRIORITY');
});

test('task: 合法优先级都通过', () => {
  assert.equal(okValue({ title: 'x', priority: 1 }).priority, 1);
  assert.equal(okValue({ title: 'x', priority: 2 }).priority, 2);
  assert.equal(okValue({ title: 'x', priority: 3 }).priority, 3);
});

test('task: 非法截止日被拒', () => {
  assert.equal(errCode({ title: 'x', due_day: '2026/01/01' }), 'INVALID_DUE_DAY');
  assert.equal(errCode({ title: 'x', due_day: '2026-1-1' }), 'INVALID_DUE_DAY');
  assert.equal(errCode({ title: 'x', due_day: '2026-13-01' }), 'INVALID_DUE_DAY');
  assert.equal(errCode({ title: 'x', due_day: '2025-02-29' }), 'INVALID_DUE_DAY');
  assert.equal(errCode({ title: 'x', due_day: 'abc' }), 'INVALID_DUE_DAY');
});

test('task: 合法截止日通过（含闰日）', () => {
  assert.equal(okValue({ title: 'x', due_day: '2026-10-24' }).dueDay, '2026-10-24');
  assert.equal(okValue({ title: 'x', due_day: '2024-02-29' }).dueDay, '2024-02-29');
});

test('task: null 与空串表示清除截止日', () => {
  assert.equal(okValue({ title: 'x', due_day: null }).dueDay, null);
  assert.equal(okValue({ title: 'x', due_day: '' }).dueDay, null);
  assert.equal(okValue({ title: 'x' }).dueDay, null);
});

test('task: 备注为空串归一为 null', () => {
  assert.equal(okValue({ title: 'x', detail: '   ' }).detail, null);
  assert.equal(okValue({ title: 'x', detail: '有内容' }).detail, '有内容');
});

test('task: 超长备注被截断而非报错', () => {
  const v = okValue({ title: 'x', detail: 'y'.repeat(5000) });
  assert.equal(v.detail?.length, 2000);
});

// ============ routine ============
function routineOk(b: Parameters<typeof validateRoutine>[0]) {
  const r = validateRoutine(b);
  if ('error' in r) throw new Error(`期望通过，却报错 ${r.error.code}`);
  return r.value;
}

function routineErr(b: Parameters<typeof validateRoutine>[0]) {
  const r = validateRoutine(b);
  if (!('error' in r)) throw new Error('期望报错，却通过了');
  return r.error.code;
}

test('routine: 最小输入通过，默认每天一次', () => {
  const v = routineOk({ name: '读书' });
  assert.equal(v.name, '读书');
  assert.equal(v.cadence, 'daily');
  assert.equal(v.targetPerPeriod, 1);
});

test('routine: 空名称被拒', () => {
  assert.equal(routineErr({ name: '' }), 'EMPTY_NAME');
  assert.equal(routineErr({ name: '  ' }), 'EMPTY_NAME');
  assert.equal(routineErr({}), 'EMPTY_NAME');
});

test('routine: 超长名称被拒', () => {
  assert.equal(routineErr({ name: 'x'.repeat(61) }), 'NAME_TOO_LONG');
});

test('routine: 非法周期被拒', () => {
  assert.equal(routineErr({ name: 'x', cadence: 'yearly' }), 'INVALID_CADENCE');
});

test('routine: 三个周期都合法', () => {
  assert.equal(routineOk({ name: 'x', cadence: 'daily' }).cadence, 'daily');
  assert.equal(routineOk({ name: 'x', cadence: 'weekly' }).cadence, 'weekly');
  assert.equal(routineOk({ name: 'x', cadence: 'monthly' }).cadence, 'monthly');
});

test('routine: 目标次数边界', () => {
  assert.equal(routineErr({ name: 'x', target_per_period: 0 }), 'INVALID_TARGET');
  assert.equal(routineErr({ name: 'x', target_per_period: 32 }), 'INVALID_TARGET');
  assert.equal(routineErr({ name: 'x', target_per_period: 1.5 }), 'INVALID_TARGET');
  assert.equal(routineOk({ name: 'x', target_per_period: 1 }).targetPerPeriod, 1);
  assert.equal(routineOk({ name: 'x', target_per_period: 31 }).targetPerPeriod, 31);
});

test('routine: daily 周期就是当天', () => {
  const r = periodRange('daily', '2026-10-24');
  assert.equal(r.from, '2026-10-24');
  assert.equal(r.to, '2026-10-24');
});

test('routine: weekly 周期是周一到周日', () => {
  // 2026-10-24 是周六
  const sat = periodRange('weekly', '2026-10-24');
  assert.equal(sat.from, '2026-10-19');
  assert.equal(sat.to, '2026-10-25');

  // 周一自身是一周的开始
  const mon = periodRange('weekly', '2026-10-19');
  assert.equal(mon.from, '2026-10-19');
  assert.equal(mon.to, '2026-10-25');
});

test('routine: weekly 跨周日时归到上一周', () => {
  // 2026-10-25 是周日，仍属于 10-19 那一周
  const sun = periodRange('weekly', '2026-10-25');
  assert.equal(sun.from, '2026-10-19');
  assert.equal(sun.to, '2026-10-25');
});

test('routine: monthly 周期是 1 号到月末', () => {
  const r = periodRange('monthly', '2026-10-24');
  assert.equal(r.from, '2026-10-01');
  assert.equal(r.to, '2026-10-31');
});

test('routine: monthly 二月天数正确', () => {
  assert.equal(periodRange('monthly', '2026-02-10').to, '2026-02-28');
  assert.equal(periodRange('monthly', '2024-02-10').to, '2024-02-29');
});

test('routine: streak 空记录为 0', () => {
  assert.equal(currentStreak([], '2026-10-24'), 0);
});

test('routine: streak 连续 3 天', () => {
  const days = ['2026-10-22', '2026-10-23', '2026-10-24'];
  assert.equal(currentStreak(days, '2026-10-24'), 3);
});

test('routine: streak 今天未打卡时从昨天算，不判中断', () => {
  // 昨天和前天打了，今天还没 —— 连续记录应保留
  const days = ['2026-10-22', '2026-10-23'];
  assert.equal(currentStreak(days, '2026-10-24'), 2);
});

test('routine: streak 昨天也没打则归零', () => {
  const days = ['2026-10-20', '2026-10-21'];
  assert.equal(currentStreak(days, '2026-10-24'), 0);
});

test('routine: streak 中间断一天则取最后一段', () => {
  const days = ['2026-10-18', '2026-10-22', '2026-10-23', '2026-10-24'];
  assert.equal(currentStreak(days, '2026-10-24'), 3);
});

// ============ meta ============
function accOk(b: Parameters<typeof validateAccountCreate>[0]) {
  const r = validateAccountCreate(b);
  if ('error' in r) throw new Error(`期望通过，却报错 ${r.error.code}`);
  return r.value;
}

function accErr(b: Parameters<typeof validateAccountCreate>[0]) {
  const r = validateAccountCreate(b);
  if (!('error' in r)) throw new Error('期望报错，却通过了');
  return r.error.code;
}

test('meta 账户: 最小输入通过，默认现金与 0 余额', () => {
  const v = accOk({ name: '招行' });
  assert.equal(v.name, '招行');
  assert.equal(v.kind, 'cash');
  assert.equal(v.balanceCents, 0);
  assert.equal(v.isArchived, 0);
});

test('meta 账户: 空名被拒', () => {
  assert.equal(accErr({ name: '' }), 'EMPTY_NAME');
  assert.equal(accErr({ name: '   ' }), 'EMPTY_NAME');
  assert.equal(accErr({}), 'EMPTY_NAME');
});

test('meta 账户: 超长名被拒', () => {
  assert.equal(accErr({ name: 'x'.repeat(33) }), 'NAME_TOO_LONG');
});

test('meta 账户: 非法类型被拒', () => {
  assert.equal(accErr({ name: 'x', kind: 'crypto' }), 'INVALID_KIND');
});

test('meta 账户: 四种类型都合法', () => {
  for (const k of ['cash', 'bank', 'credit', 'ewallet'] as const) {
    assert.equal(accOk({ name: 'x', kind: k }).kind, k);
  }
});

test('meta 账户: 余额必须非负整数分', () => {
  assert.equal(accErr({ name: 'x', balance_cents: -1 }), 'INVALID_BALANCE');
  assert.equal(accErr({ name: 'x', balance_cents: 1.5 }), 'INVALID_BALANCE');
  assert.equal(accOk({ name: 'x', balance_cents: 100000 }).balanceCents, 100000);
});

function catOk(b: Parameters<typeof validateCategory>[0]) {
  const r = validateCategory(b);
  if ('error' in r) throw new Error(`期望通过，却报错 ${r.error.code}`);
  return r.value;
}

function catErr(b: Parameters<typeof validateCategory>[0]) {
  const r = validateCategory(b);
  if (!('error' in r)) throw new Error('期望报错，却通过了');
  return r.error.code;
}

test('meta 分类: 最小输入通过，默认支出', () => {
  const v = catOk({ name: '宠物' });
  assert.equal(v.name, '宠物');
  assert.equal(v.kind, 'expense');
  assert.equal(v.icon, null);
  assert.equal(v.sort, 0);
});

test('meta 分类: 空名被拒', () => {
  assert.equal(catErr({ name: '' }), 'EMPTY_NAME');
  assert.equal(catErr({}), 'EMPTY_NAME');
});

test('meta 分类: 超长名被拒', () => {
  assert.equal(catErr({ name: 'x'.repeat(21) }), 'NAME_TOO_LONG');
});

test('meta 分类: 非法类型被拒', () => {
  assert.equal(catErr({ name: 'x', kind: 'transfer' }), 'INVALID_KIND');
});

test('meta 分类: 两种类型都合法', () => {
  assert.equal(catOk({ name: 'x', kind: 'expense' }).kind, 'expense');
  assert.equal(catOk({ name: 'x', kind: 'income' }).kind, 'income');
});

test('meta 分类: 图标空串归一为 null', () => {
  assert.equal(catOk({ name: 'x', icon: '' }).icon, null);
  assert.equal(catOk({ name: 'x', icon: '   ' }).icon, null);
  assert.equal(catOk({ name: 'x', icon: '🐱' }).icon, '🐱');
});

test('meta 分类: sort 边界', () => {
  assert.equal(catErr({ name: 'x', sort: -1 }), 'INVALID_SORT');
  assert.equal(catErr({ name: 'x', sort: 1000 }), 'INVALID_SORT');
  assert.equal(catErr({ name: 'x', sort: 1.5 }), 'INVALID_SORT');
  assert.equal(catOk({ name: 'x', sort: 0 }).sort, 0);
  assert.equal(catOk({ name: 'x', sort: 999 }).sort, 999);
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
