/**
 * notify-dedupe 单元测试。
 *
 * 关键用例：微信 + 银行的跨渠道重复必须只留一条，
 * 而「两笔同额真实消费」不能被误吞。
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  dedupeVerdict,
  notificationIdentity,
  CHANNEL_PRIORITY,
  DEFAULT_DEDUPE_WINDOW_MS,
} from '../src/domain/notify-dedupe.ts';
import type { DedupeExisting } from '../src/domain/notify-dedupe.ts';

const T0 = 1_700_000_000_000;

function row(over: Partial<DedupeExisting> = {}): DedupeExisting {
  return {
    id: 1,
    kind: 'txn',
    amountCents: 1688,
    merchant: null,
    atMs: T0,
    channel: 'bank',
    ...over,
  };
}

describe('notify-dedupe: 跨渠道重复', () => {
  it('微信 vs 银行 同额同窗 → 保留微信，丢弃银行', () => {
    // 已有银行通知，新来微信通知（优先级更高）→ 替换旧的
    const v = dedupeVerdict(
      { amountCents: 1688, merchant: null, atMs: T0, channel: 'wechat' },
      [row({ channel: 'bank' })],
    );
    assert.equal(v.kind, 'replace_old');
  });

  it('已有微信，新来银行 → 丢弃新来的', () => {
    const v = dedupeVerdict(
      { amountCents: 1688, merchant: null, atMs: T0, channel: 'bank' },
      [row({ channel: 'wechat' })],
    );
    assert.equal(v.kind, 'drop_new');
  });

  it('同渠道同额同窗 → 丢弃新来的', () => {
    const v = dedupeVerdict(
      { amountCents: 1688, merchant: null, atMs: T0, channel: 'wechat' },
      [row({ channel: 'wechat' })],
    );
    assert.equal(v.kind, 'drop_new');
  });
});

describe('notify-dedupe: 不应误吞', () => {
  it('金额不同 → 两笔都记', () => {
    const v = dedupeVerdict(
      { amountCents: 1500, merchant: null, atMs: T0, channel: 'wechat' },
      [row({ amountCents: 1688 })],
    );
    assert.equal(v.kind, 'unique');
  });

  it('超出时间窗 → 两笔都记', () => {
    const v = dedupeVerdict(
      { amountCents: 1688, merchant: null, atMs: T0 + 61_000, channel: 'wechat' },
      [row({ atMs: T0 })],
    );
    assert.equal(v.kind, 'unique');
  });

  it('窗口边界内（正好 60 秒）→ 视为重复', () => {
    const v = dedupeVerdict(
      { amountCents: 1688, merchant: null, atMs: T0 + 60_000, channel: 'wechat' },
      [row({ atMs: T0 })],
    );
    assert.equal(v.kind, 'drop_new');
  });

  it('新记录带商户 → 不参与去重（两杯同价咖啡但商户不同）', () => {
    const v = dedupeVerdict(
      { amountCents: 1500, merchant: '瑞幸', atMs: T0, channel: 'wechat' },
      [row({ amountCents: 1500, merchant: null })],
    );
    assert.equal(v.kind, 'unique');
  });

  it('已有记录带商户 → 不认为是同一笔', () => {
    const v = dedupeVerdict(
      { amountCents: 1500, merchant: null, atMs: T0, channel: 'wechat' },
      [row({ amountCents: 1500, merchant: '星巴克' })],
    );
    assert.equal(v.kind, 'unique');
  });

  it('空列表 → unique', () => {
    const v = dedupeVerdict(
      { amountCents: 1688, merchant: null, atMs: T0, channel: 'wechat' },
      [],
    );
    assert.equal(v.kind, 'unique');
  });
});

describe('notify-dedupe: 多条候选取最近的', () => {
  it('两条候选时选时间更近的那条', () => {
    const v = dedupeVerdict(
      { amountCents: 1688, merchant: null, atMs: T0 + 1000, channel: 'wechat' },
      [
        row({ id: 10, atMs: T0 - 30_000, channel: 'bank' }),
        row({ id: 11, atMs: T0 + 500, channel: 'bank' }),
      ],
    );
    assert.equal(v.kind, 'replace_old');
    if (v.kind !== 'replace_old') return;
    assert.equal(v.duplicateOf.id, 11);
  });
});

describe('notify-dedupe: 幂等键', () => {
  it('同一条通知 → 同一身份串', () => {
    const a = notificationIdentity({ pkg: 'com.tencent.mm', title: '微信支付', body: '已支付¥16.88', postTime: T0 });
    const b = notificationIdentity({ pkg: 'com.tencent.mm', title: '微信支付', body: '已支付¥16.88', postTime: T0 });
    assert.equal(a, b);
  });

  it('postTime 不同 → 不同身份串（两次真实支付不误判）', () => {
    const a = notificationIdentity({ pkg: 'p', title: 't', body: 'b', postTime: T0 });
    const b = notificationIdentity({ pkg: 'p', title: 't', body: 'b', postTime: T0 + 1000 });
    assert.notEqual(a, b);
  });

  it('缺字段不抛异常', () => {
    assert.equal(typeof notificationIdentity({}), 'string');
  });
});

describe('notify-dedupe: 常量', () => {
  it('渠道优先级 微信 > 支付宝 > 银行 > 未知', () => {
    assert.ok(CHANNEL_PRIORITY.wechat < CHANNEL_PRIORITY.alipay);
    assert.ok(CHANNEL_PRIORITY.alipay < CHANNEL_PRIORITY.bank);
    assert.ok(CHANNEL_PRIORITY.bank < CHANNEL_PRIORITY.unknown);
  });

  it('默认窗口 60 秒', () => {
    assert.equal(DEFAULT_DEDUPE_WINDOW_MS, 60_000);
  });
});
