/**
 * notify-parse 单元测试。
 *
 * 核心用例直接来自真实通知截图：
 *   标题「微信支付」+ 正文「已支付¥16.88」
 * 这条通知**没有商户**，是决定整个置信度规则的关键样本。
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { parseNotification, detectChannel } from '../src/domain/notify-parse.ts';

describe('notify-parse: 微信真实通知', () => {
  it('「微信支付 / 已支付¥16.88」判 high 且商户为空', () => {
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

  it('整数金额「已支付¥15」', () => {
    const r = parseNotification('微信支付', '已支付¥15');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.amountCents, 1500);
  });

  it('千分位「已支付¥1,234.56」', () => {
    const r = parseNotification('微信支付', '已支付¥1,234.56');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.amountCents, 123456);
  });

  it('微信收款判为 income', () => {
    const r = parseNotification('微信支付', '已收款¥88.00');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.type, 'income');
    assert.equal(r.result.amountCents, 8800);
  });

  it('微信退款判为 income', () => {
    const r = parseNotification('微信支付', '退款到账¥25.50');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.type, 'income');
    assert.equal(r.result.amountCents, 2550);
  });
});

describe('notify-parse: 支付宝', () => {
  it('付款成功', () => {
    const r = parseNotification('支付宝', '付款成功 ¥11.20');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.channel, 'alipay');
    assert.equal(r.result.amountCents, 1120);
    assert.equal(r.result.type, 'expense');
    assert.equal(r.result.confidence, 'high');
  });

  it('带商户的支付宝通知能抽出商户', () => {
    const r = parseNotification('支付宝', '向 瑞幸咖啡 付款 12.34 元');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.merchant, '瑞幸咖啡');
    assert.equal(r.result.amountCents, 1234);
  });
});

describe('notify-parse: 银行', () => {
  it('支出通知', () => {
    const r = parseNotification('招商银行', '您账户于10月21日支出￥58.00');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.channel, 'bank');
    assert.equal(r.result.amountCents, 5800);
    assert.equal(r.result.type, 'expense');
  });

  it('入账判 income', () => {
    const r = parseNotification('招商银行', '您账户入账￥1000.00');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.type, 'income');
    assert.equal(r.result.amountCents, 100000);
  });
});

describe('notify-parse: 应被拒绝的通知', () => {
  it('验证码不记账', () => {
    const r = parseNotification('微信', '验证码 123456，5分钟内有效');
    assert.equal(r.ok, false);
  });

  it('营销推送不记账', () => {
    const r = parseNotification('支付宝', '点击查看优惠券活动');
    assert.equal(r.ok, false);
  });

  it('空通知', () => {
    assert.equal(parseNotification('', '').ok, false);
  });

  it('超长文本拒绝', () => {
    assert.equal(parseNotification('x', 'a'.repeat(3000)).ok, false);
  });

  it('卡号不被当成金额', () => {
    // 「尾号 4122」里的 4122 若被当金额会记成 4122 元
    const r = parseNotification('招商银行', '您尾号4122的储蓄卡已绑定');
    assert.equal(r.ok, false);
  });

  it('退款无金额时给出具体原因', () => {
    const r = parseNotification('微信支付', '退款已受理，将原路退回');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'refund_without_amount');
  });
});

describe('notify-parse: 渠道识别', () => {
  it('detectChannel', () => {
    assert.equal(detectChannel('微信支付', '已支付¥1'), 'wechat');
    assert.equal(detectChannel('支付宝', '付款成功'), 'alipay');
    assert.equal(detectChannel('招商银行', '支出'), 'bank');
    assert.equal(detectChannel('某App', '随便'), 'unknown');
  });

  it('未知渠道走通用层，无商户则 medium', () => {
    const r = parseNotification('某记账App', '消费 ¥9.90');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.channel, 'unknown');
    // 通用层没有商户 → medium，进待确认
    assert.equal(r.result.confidence, 'medium');
  });
});
