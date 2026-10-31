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
import {
  parseCoord,
  parseLatLon,
  roundCoord,
  cacheKeyOf,
  normalizeCityName,
  sameArea,
} from '../src/domain/geo.ts';
import { parseNotification, detectChannel } from '../src/domain/notify-parse.ts';
import {
  dedupeVerdict,
  notificationIdentity,
  CHANNEL_PRIORITY,
  DEFAULT_DEDUPE_WINDOW_MS,
} from '../src/domain/notify-dedupe.ts';
import type { DedupeExisting } from '../src/domain/notify-dedupe.ts';

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

// ============ geo 定位 ============
test('geo: 解析数字与数字字符串', () => {
  assert.equal(parseCoord(38.914), 38.914);
  assert.equal(parseCoord('121.6147'), 121.6147);
  assert.equal(parseCoord(' 39.9 '), 39.9);
  assert.equal(parseCoord('-0.5'), -0.5);
});

test('geo: 拒绝非数字', () => {
  assert.equal(parseCoord(''), null);
  assert.equal(parseCoord('abc'), null);
  assert.equal(parseCoord('NaN'), null);
  assert.equal(parseCoord('Infinity'), null);
  assert.equal(parseCoord(null), null);
  assert.equal(parseCoord(undefined), null);
  assert.equal(parseCoord({}), null);
});

test('geo: 合法坐标', () => {
  assert.deepEqual(parseLatLon('38.914', '121.6147'), { lat: 38.914, lon: 121.6147 });
  assert.deepEqual(parseLatLon(39.9042, 116.4074), { lat: 39.9042, lon: 116.4074 });
  assert.deepEqual(parseLatLon(90, 180), { lat: 90, lon: 180 });
  assert.deepEqual(parseLatLon(-90, -180), { lat: -90, lon: -180 });
});

test('geo: 越界坐标被拒', () => {
  assert.equal(parseLatLon(91, 0), null);
  assert.equal(parseLatLon(-91, 0), null);
  assert.equal(parseLatLon(0, 181), null);
  assert.equal(parseLatLon(0, -181), null);
});

test('geo: 0,0 视为定位失败', () => {
  assert.equal(parseLatLon(0, 0), null);
  assert.equal(parseLatLon('0', '0'), null);
  assert.deepEqual(parseLatLon(0, 121), { lat: 0, lon: 121 });
});

test('geo: 缺一项即失效', () => {
  assert.equal(parseLatLon('38.9', undefined), null);
  assert.equal(parseLatLon(undefined, '121.6'), null);
  assert.equal(parseLatLon('', ''), null);
});

test('geo: 缓存键按 2 位小数聚合', () => {
  assert.equal(cacheKeyOf({ lat: 38.914, lon: 121.6147 }), '38.91,121.61');
  assert.equal(cacheKeyOf({ lat: 38.9132, lon: 121.6099 }), '38.91,121.61');
  assert.notEqual(
    cacheKeyOf({ lat: 38.914, lon: 121.6147 }),
    cacheKeyOf({ lat: 38.95, lon: 121.61 }),
  );
});

test('geo: roundCoord', () => {
  assert.equal(roundCoord(38.9145, 2), 38.91);
  assert.equal(roundCoord(121.6147, 2), 121.61);
  assert.equal(roundCoord(38.9155, 2), 38.92);
  assert.equal(roundCoord(-38.9155, 2), -38.92);
});

test('geo: 地名去掉「市」', () => {
  assert.equal(normalizeCityName('大连市'), '大连');
  assert.equal(normalizeCityName('北京市'), '北京');
  assert.equal(normalizeCityName('上海市'), '上海');
  assert.equal(normalizeCityName('大连'), '大连');
  assert.equal(normalizeCityName('市'), '市');
  assert.equal(normalizeCityName('都市'), '都市');
});

test('geo: 地名空值与非法类型', () => {
  assert.equal(normalizeCityName(''), null);
  assert.equal(normalizeCityName('   '), null);
  assert.equal(normalizeCityName(null), null);
  assert.equal(normalizeCityName(undefined), null);
  assert.equal(normalizeCityName(123), null);
});

test('geo: 繁体地名转简体（反查接口实测会返回繁体）', () => {
  // localityLanguage=zh 时实测返回「大連市」
  assert.equal(normalizeCityName('大連市'), '大连');
  assert.equal(normalizeCityName('廣州市'), '广州');
  assert.equal(normalizeCityName('遼寧省瀋陽市'), '辽宁省沈阳');
  assert.equal(normalizeCityName('臺北市'), '台北');
});

test('geo: 简体地名不受影响', () => {
  assert.equal(normalizeCityName('大连市'), '大连');
  assert.equal(normalizeCityName('广州市'), '广州');
  assert.equal(normalizeCityName('成都市'), '成都');
  assert.equal(normalizeCityName('深圳市'), '深圳');
});

test('geo: sameArea 同格判断', () => {
  const a = { lat: 38.914, lon: 121.6147 };
  const b = { lat: 38.9132, lon: 121.6099 };
  const c = { lat: 39.9042, lon: 116.4074 };
  assert.equal(sameArea(a, b), true);
  assert.equal(sameArea(a, c), false);
  assert.equal(sameArea(a, null), false);
  assert.equal(sameArea(null, null), false);
});

// ============ notify-parse ============
// 核心样本来自真实通知截图：标题「微信支付」+ 正文「已支付¥16.88」。
// 这条通知没有商户，是决定整个置信度规则的关键样本。

test('notify: 微信真实通知（无商户也判 high）', () => {
  const r = parseNotification('微信支付', '已支付¥16.88');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.type, 'expense');
  assert.equal(r.result.amountCents, 1688);
  assert.equal(r.result.merchant, null);
  assert.equal(r.result.channel, 'wechat');
  // 关键：没有商户也要 high，否则自动记账退化成全量待确认
  assert.equal(r.result.confidence, 'high');
});

test('notify: 整数金额', () => {
  const r = parseNotification('微信支付', '已支付¥15');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.amountCents, 1500);
});

test('notify: 千分位金额', () => {
  const r = parseNotification('微信支付', '已支付¥1,234.56');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.amountCents, 123456);
});

test('notify: 微信收款判 income', () => {
  const r = parseNotification('微信支付', '已收款¥88.00');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.type, 'income');
  assert.equal(r.result.amountCents, 8800);
});

test('notify: 微信退款判 income', () => {
  const r = parseNotification('微信支付', '退款到账¥25.50');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.type, 'income');
  assert.equal(r.result.amountCents, 2550);
});

test('notify: 支付宝付款成功', () => {
  const r = parseNotification('支付宝', '付款成功 ¥11.20');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.channel, 'alipay');
  assert.equal(r.result.amountCents, 1120);
  assert.equal(r.result.confidence, 'high');
});

test('notify: 支付宝带商户', () => {
  const r = parseNotification('支付宝', '向 瑞幸咖啡 付款 12.34 元');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.merchant, '瑞幸咖啡');
  assert.equal(r.result.amountCents, 1234);
});

test('notify: 银行支出', () => {
  const r = parseNotification('招商银行', '您账户于10月21日支出￥58.00');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.channel, 'bank');
  assert.equal(r.result.amountCents, 5800);
});

test('notify: 银行入账判 income', () => {
  const r = parseNotification('招商银行', '您账户入账￥1000.00');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.type, 'income');
  assert.equal(r.result.amountCents, 100000);
});

test('notify: 验证码不记账', () => {
  assert.equal(parseNotification('微信', '验证码 123456，5分钟内有效').ok, false);
});

test('notify: 营销推送不记账', () => {
  assert.equal(parseNotification('支付宝', '点击查看优惠券活动').ok, false);
});

test('notify: 空通知', () => {
  assert.equal(parseNotification('', '').ok, false);
});

test('notify: 超长文本拒绝', () => {
  assert.equal(parseNotification('x', 'a'.repeat(3000)).ok, false);
});

test('notify: 卡号不被当成金额', () => {
  assert.equal(parseNotification('招商银行', '您尾号4122的储蓄卡已绑定').ok, false);
});

test('notify: 退款无金额给出具体原因', () => {
  const r = parseNotification('微信支付', '退款已受理，将原路退回');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'refund_without_amount');
});

test('notify: detectChannel', () => {
  assert.equal(detectChannel('微信支付', '已支付¥1'), 'wechat');
  assert.equal(detectChannel('支付宝', '付款成功'), 'alipay');
  assert.equal(detectChannel('招商银行', '支出'), 'bank');
  assert.equal(detectChannel('某App', '随便'), 'unknown');
});

test('notify: 未知渠道走通用层，无商户则 medium', () => {
  const r = parseNotification('某记账App', '消费 ¥9.90');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.channel, 'unknown');
  assert.equal(r.result.confidence, 'medium');
});

// ============ notify-dedupe ============
const DT0 = 1_700_000_000_000;

function dedupeRow(over: Partial<DedupeExisting> = {}): DedupeExisting {
  return {
    id: 1,
    kind: 'txn',
    amountCents: 1688,
    merchant: null,
    atMs: DT0,
    channel: 'bank',
    ...over,
  };
}

test('dedupe: 微信 vs 银行同额同窗 → 替换旧的', () => {
  const v = dedupeVerdict(
    { amountCents: 1688, merchant: null, atMs: DT0, channel: 'wechat' },
    [dedupeRow({ channel: 'bank' })],
  );
  assert.equal(v.kind, 'replace_old');
});

test('dedupe: 已有微信新来银行 → 丢弃新的', () => {
  const v = dedupeVerdict(
    { amountCents: 1688, merchant: null, atMs: DT0, channel: 'bank' },
    [dedupeRow({ channel: 'wechat' })],
  );
  assert.equal(v.kind, 'drop_new');
});

test('dedupe: 同渠道同额同窗 → 丢弃新的', () => {
  const v = dedupeVerdict(
    { amountCents: 1688, merchant: null, atMs: DT0, channel: 'wechat' },
    [dedupeRow({ channel: 'wechat' })],
  );
  assert.equal(v.kind, 'drop_new');
});

test('dedupe: 金额不同 → 两笔都记', () => {
  const v = dedupeVerdict(
    { amountCents: 1500, merchant: null, atMs: DT0, channel: 'wechat' },
    [dedupeRow({ amountCents: 1688 })],
  );
  assert.equal(v.kind, 'unique');
});

test('dedupe: 超窗 → 两笔都记', () => {
  const v = dedupeVerdict(
    { amountCents: 1688, merchant: null, atMs: DT0 + 61_000, channel: 'wechat' },
    [dedupeRow({ atMs: DT0 })],
  );
  assert.equal(v.kind, 'unique');
});

test('dedupe: 窗口边界正好 60 秒 → 视为重复', () => {
  const v = dedupeVerdict(
    { amountCents: 1688, merchant: null, atMs: DT0 + 60_000, channel: 'wechat' },
    [dedupeRow({ atMs: DT0, channel: 'wechat' })],
  );
  assert.equal(v.kind, 'drop_new');
});

test('dedupe: 新记录带商户 → 不参与去重', () => {
  const v = dedupeVerdict(
    { amountCents: 1500, merchant: '瑞幸', atMs: DT0, channel: 'wechat' },
    [dedupeRow({ amountCents: 1500, merchant: null })],
  );
  assert.equal(v.kind, 'unique');
});

test('dedupe: 已有记录带商户 → 不认为是同一笔', () => {
  const v = dedupeVerdict(
    { amountCents: 1500, merchant: null, atMs: DT0, channel: 'wechat' },
    [dedupeRow({ amountCents: 1500, merchant: '星巴克' })],
  );
  assert.equal(v.kind, 'unique');
});

test('dedupe: 空列表 → unique', () => {
  const v = dedupeVerdict(
    { amountCents: 1688, merchant: null, atMs: DT0, channel: 'wechat' },
    [],
  );
  assert.equal(v.kind, 'unique');
});

test('dedupe: 多条候选取时间最近', () => {
  const v = dedupeVerdict(
    { amountCents: 1688, merchant: null, atMs: DT0 + 1000, channel: 'wechat' },
    [
      dedupeRow({ id: 10, atMs: DT0 - 30_000, channel: 'bank' }),
      dedupeRow({ id: 11, atMs: DT0 + 500, channel: 'bank' }),
    ],
  );
  assert.equal(v.kind, 'replace_old');
  if (v.kind !== 'replace_old') return;
  assert.equal(v.duplicateOf.id, 11);
});

test('dedupe: 幂等键同通知相同', () => {
  const a = notificationIdentity({ pkg: 'com.tencent.mm', title: '微信支付', body: '已支付¥16.88', postTime: DT0 });
  const b = notificationIdentity({ pkg: 'com.tencent.mm', title: '微信支付', body: '已支付¥16.88', postTime: DT0 });
  assert.equal(a, b);
});

test('dedupe: postTime 不同则身份串不同', () => {
  const a = notificationIdentity({ pkg: 'p', title: 't', body: 'b', postTime: DT0 });
  const b = notificationIdentity({ pkg: 'p', title: 't', body: 'b', postTime: DT0 + 1000 });
  assert.notEqual(a, b);
});

test('dedupe: 缺字段不抛异常', () => {
  assert.equal(typeof notificationIdentity({}), 'string');
});

test('dedupe: 渠道优先级与默认窗口', () => {
  assert.ok(CHANNEL_PRIORITY.wechat < CHANNEL_PRIORITY.alipay);
  assert.ok(CHANNEL_PRIORITY.alipay < CHANNEL_PRIORITY.bank);
  assert.ok(CHANNEL_PRIORITY.bank < CHANNEL_PRIORITY.unknown);
  assert.equal(DEFAULT_DEDUPE_WINDOW_MS, 60_000);
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
