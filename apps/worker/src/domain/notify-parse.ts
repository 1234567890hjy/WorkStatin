/**
 * 通知解析器：把 Android 通知的 (title, body) 解析成记账草稿。
 *
 * ============ 为什么是两层 ============
 *
 * 第一版设计时考虑过两种极端：
 *   A. 纯复用 share-parse.ts 的通用正则 —— 实现最少，但跨渠道误匹配率高。
 *   B. 纯渠道分发，每个渠道一套规则 —— 准确，但新增渠道要重写全部逻辑。
 *
 * 最终选两层：
 *   ┌ 渠道层（channelRules）：认出「这是微信支付」，用固定模板精确抽取
 *   └ 通用层（share-parse）：渠道层没命中时兜底，从任意文本里捞金额
 *
 * 新增一个渠道只需在 CHANNELS 里加一条模板，通用层不用动。
 *
 * ============ 关键事实（来自真实通知截图）============
 *
 * 微信支付通知的真实形态：
 *   标题：微信支付
 *   正文：已支付¥16.88
 *
 * 通知里 **没有商户** —— 背景是京东收银台，但通知只告诉你「付了多少钱」。
 * 因此置信度规则与 share-parse 不同：
 *   share 通道：带货币符号 + 拿到商户 = high
 *   notify 通道：渠道已知 + 金额 + 支出/收入动词 = high（商户允许为空）
 *
 * 这条差异是本模块存在的核心理由，不要为了「统一」而合并两者。
 */

import { parseShareText } from './share-parse.ts';

/** 支付渠道。unknown 表示白名单外或未识别的 App。 */
export type Channel = 'wechat' | 'alipay' | 'bank' | 'unknown';

export type NotifyTxnType = 'expense' | 'income';

export type NotifyConfidence = 'high' | 'medium' | 'low';

export interface NotifyParseResult {
  /** 记账类型。通知只能表达收/支，表达不了转账。 */
  type: NotifyTxnType;
  amountCents: number;
  /** 通知里通常没有商户，允许为 null。 */
  merchant: string | null;
  channel: Channel;
  confidence: NotifyConfidence;
  /** 命中的原始片段，便于人工核对与排查模板失配。 */
  matched: string;
}

/** 解析不出来的原因，落进 raw_notification.reason 供排查。 */
export type NotifyParseFailure =
  | 'empty'
  | 'too_long'
  | 'no_amount'
  | 'amount_out_of_range'
  | 'refund_without_amount';

export type NotifyParseOutcome =
  | { ok: true; result: NotifyParseResult }
  | { ok: false; reason: NotifyParseFailure };

/** 单个渠道的识别与抽取规则。 */
interface ChannelRule {
  channel: Channel;
  /** 标题或正文命中任意一条即认为是该渠道。 */
  identify: RegExp[];
  /**
   * 支出模板。第一捕获组必须是金额（元，字符串）。
   * 命中即 high（渠道已知 + 金额 + 动词齐全）。
   */
  expense: RegExp[];
  /** 收入模板（收款/退款/到账）。 */
  income: RegExp[];
  /**
   * 从通知里尝试抽商户。多数渠道的通知没有商户，
   * 抽不到就返回 null —— 这是正常情况，不是失败。
   */
  merchant?: RegExp[];
}

/**
 * 金额的数字模式：允许千分位与 1~2 位小数。
 * 注意不要写成 `\d+\.\d{2}`，因为「已支付¥16」这种整数金额也存在。
 */
const AMT = '(\\d{1,9}(?:,\\d{3})*(?:\\.\\d{1,2})?)';

/**
 * 渠道规则表。
 *
 * 顺序有意义：越具体的放前面。bank 放最后是因为银行 App 众多，
 * 识别词更泛（「尾号」「储蓄卡」），容易误伤其他渠道。
 */
const CHANNELS: ChannelRule[] = [
  {
    channel: 'wechat',
    // 标题就是「微信支付」；也有「微信收款助手」这类。
    identify: [/微信支付/, /微信收款/, /^微信$/],
    expense: [
      // 真实文案：已支付¥16.88
      new RegExp(`已支付\\s*[¥￥]?\\s*${AMT}`),
      // 变体：支付成功 ¥16.88 / 微信支付凭证
      new RegExp(`支付成功\\s*[¥￥]?\\s*${AMT}`),
      new RegExp(`(?:扣款|付款|消费)\\s*[¥￥]?\\s*${AMT}`),
      // 兜底：只有货币符号，如「微信支付 ¥16.88」
      new RegExp(`[¥￥]\\s*${AMT}`),
    ],
    income: [
      new RegExp(`已收款\\s*[¥￥]?\\s*${AMT}`),
      new RegExp(`收款\\s*[¥￥]?\\s*${AMT}`),
      new RegExp(`退款\\s*(?:到账)?\\s*[¥￥]?\\s*${AMT}`),
      new RegExp(`已退款\\s*[¥￥]?\\s*${AMT}`),
      new RegExp(`红包\\s*[¥￥]?\\s*${AMT}`),
    ],
    // 微信支付通知通常无商户；但「向XX付款」这类文本里可能有。
    merchant: [/(?:向|在)\s*([^\s，,。；;:：]{2,20}?)\s*(?:支付|付款|消费)/],
  },
  {
    channel: 'alipay',
    identify: [/支付宝/, /Alipay/i],
    expense: [
      new RegExp(`(?:付款成功|支付成功|消费|扣款|已付款)\\s*[¥￥]?\\s*${AMT}`),
      new RegExp(`[¥￥]\\s*${AMT}`),
    ],
    income: [
      new RegExp(`(?:收款|已收款|到账|退款)\\s*(?:成功)?\\s*[¥￥]?\\s*${AMT}`),
    ],
    merchant: [
      /(?:向|在)\s*([^\s，,。；;:：]{2,20}?)\s*(?:付款|支付|消费)/,
      /(?:收款方|商户)\s*[:：]\s*([^\s，,。；;:：]{1,20})/,
    ],
  },
  {
    channel: 'bank',
    identify: [
      /银行/,
      /尾号/,
      /储蓄卡|信用卡|借记卡/,
      /账户.*(?:支出|收入|变动)/,
    ],
    expense: [
      // 短信/通知常见：您账户于10月21日支出￥58.00
      new RegExp(`(?:支出|消费|扣款|转出)\\s*[¥￥]?\\s*${AMT}`),
      new RegExp(`[¥￥]\\s*${AMT}`),
    ],
    income: [
      new RegExp(`(?:收入|入账|到账|转入|退款)\\s*[¥￥]?\\s*${AMT}`),
    ],
    merchant: [
      /(?:商户名称|商户|商家)\s*[:：]\s*([^\s，,。；;:：]{1,20})/,
      /(?:向|在)\s*([^\s，,。；;:：]{2,20}?)\s*(?:支付|消费|付款)/,
    ],
  },
];

/**
 * 与「钱进来」相关的词。用于判定收入。
 * 顺序无关，但必须与「支出词」互斥，否则同一句会被判两次。
 */
const INCOME_HINTS = /收款|已收款|到账|退款|已退款|入账|转入|红包|收入/;

/** 明显不是记账通知的文本特征（验证码、登录、营销）。 */
const NOISE = /验证码|校验码|动态码|登录|注册|密码|优惠券|活动|红包雨|点击查看|下载APP/i;

function toCents(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) return null;
  const [i = '0', f = ''] = cleaned.split('.');
  const intVal = Number(i);
  const frac = Number((f + '00').slice(0, 2));
  if (!Number.isSafeInteger(intVal) || !Number.isSafeInteger(frac)) return null;
  return intVal * 100 + frac;
}

/**
 * 从一段文本里按给定模板列表抽金额。
 * 返回第一个「在合理区间内」的命中，避免把「尾号 4122」当成 4122 元。
 */
function extractAmount(
  text: string,
  patterns: RegExp[],
): { cents: number; matched: string } | null {
  for (const re of patterns) {
    const m = text.match(re);
    if (!m || !m[1]) continue;
    const cents = toCents(m[1]);
    // 0 元不是有效记账；超过 100 万视为误匹配（如把卡号当金额）
    if (cents === null || cents <= 0 || cents > 100_000_000) continue;
    return { cents, matched: m[0].trim() };
  }
  return null;
}

function extractMerchant(text: string, patterns?: RegExp[]): string | null {
  if (!patterns) return null;
  for (const re of patterns) {
    const m = text.match(re);
    if (!m || !m[1]) continue;
    const cand = m[1].trim();
    // 过短多半是「元」「块」这类噪声；过长则不是商户名
    if (cand.length >= 2 && cand.length <= 20) return cand;
  }
  return null;
}

/** 按标题/正文识别渠道。白名单已在手机端过滤过，这里只做兜底识别。 */
export function detectChannel(title: string, body: string): Channel {
  const text = `${title} ${body}`;
  for (const rule of CHANNELS) {
    if (rule.identify.some((re) => re.test(text))) return rule.channel;
  }
  return 'unknown';
}

/**
 * 解析一条通知。
 *
 * @param title 通知标题（Android 上通常是 App 自定义的 tickerTitle）
 * @param body  通知正文
 *
 * 返回 { ok: false, reason } 时，调用方应把原文落进 raw_notification，
 * 而不是丢弃 —— 否则模板失配时你会以为「什么都没发生」。
 */
export function parseNotification(title: string, body: string): NotifyParseOutcome {
  const t = typeof title === 'string' ? title.trim() : '';
  const b = typeof body === 'string' ? body.trim() : '';
  const text = `${t} ${b}`.trim();

  if (!text) return { ok: false, reason: 'empty' };
  // 通知正文极少超过这个长度；超长多半是聊天摘要，不是记账通知
  if (text.length > 2000) return { ok: false, reason: 'too_long' };
  // 验证码/营销类直接排除，不落库也不告警
  if (NOISE.test(text)) return { ok: false, reason: 'no_amount' };

  const channel = detectChannel(t, b);
  const rule = CHANNELS.find((r) => r.channel === channel);

  // ---- 第一层：渠道模板 ----
  if (rule) {
    const isIncome = INCOME_HINTS.test(text);

    // 收入优先判定：同一句里「退款」比「支付」更能定性
    if (isIncome) {
      const hit = extractAmount(text, rule.income);
      if (hit) {
        return {
          ok: true,
          result: {
            type: 'income',
            amountCents: hit.cents,
            merchant: extractMerchant(text, rule.merchant),
            channel,
            // 渠道已知 + 金额 + 动词齐全 = high，商户为空不影响
            confidence: 'high',
            matched: hit.matched,
          },
        };
      }
      // 有退款词但没有金额 —— 值得单独记一笔原因，方便排查
      if (/退款/.test(text)) return { ok: false, reason: 'refund_without_amount' };
    }

    const hit = extractAmount(text, rule.expense);
    if (hit) {
      return {
        ok: true,
        result: {
          type: 'expense',
          amountCents: hit.cents,
          merchant: extractMerchant(text, rule.merchant),
          channel,
          confidence: 'high',
          matched: hit.matched,
        },
      };
    }
  }

  // ---- 第二层：通用兜底 ----
  // 渠道未知或模板失配时，退回 share-parse 的通用正则。
  // 这一层拿不到商户就只能是 medium —— 进待确认，不自动落库。
  const generic = parseShareText(text);
  if (!generic) return { ok: false, reason: 'no_amount' };

  return {
    ok: true,
    result: {
      type: INCOME_HINTS.test(text) ? 'income' : 'expense',
      amountCents: generic.amountCents,
      merchant: generic.merchant,
      channel,
      // 通用层：有商户才 high，否则 medium 进待确认
      confidence: generic.confidence === 'high' ? 'high' : 'medium',
      matched: generic.matched,
    },
  };
}
