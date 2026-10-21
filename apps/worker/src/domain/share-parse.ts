/**
 * share_target 文本解析：从 Android 分享过来的短信/通知文本里
 * 抽出「金额」和「商户」。
 *
 * 设计原则：宁可解析不出来（落回手填），也不要解析错。
 * 因此所有规则都是「保守匹配 + 置信度」，低置信度直接返回 null 让用户手填。
 */

export interface ShareParseResult {
  amountCents: number;
  merchant: string | null;
  confidence: 'high' | 'medium';
  /** 命中的原始片段，便于调试与前端提示 */
  matched: string;
}

/** 银行/支付渠道的常见金额写法：¥12.34 / 12.34元 / 消费12.34 / 支付-12.34 */
const AMOUNT_PATTERNS: RegExp[] = [
  // 带货币符号：¥12.34 / ￥12.34
  /[¥￥]\s*(\d{1,9}(?:,\d{3})*(?:\.\d{1,2})?)/,
  // 数字 + 元：12.34元
  /(\d{1,9}(?:,\d{3})*(?:\.\d{1,2})?)\s*元/,
  // 负号金额：-12.34
  /-\s*(\d{1,9}(?:,\d{3})*(?:\.\d{1,2})?)/,
  // 动作词 + 金额：消费12.34 / 支付12.34 / 支出12.34 / 扣款12.34
  /(?:消费|支付|支出|扣款|付款|转账|收入|入账|到账|退款|还款)\s*[:：]?\s*(\d{1,9}(?:,\d{3})*(?:\.\d{1,2})?)/,
];

/** 商户：常见于「向XX支付」「在XX消费」「XX 收款」 */
const MERCHANT_PATTERNS: RegExp[] = [
  /(?:向|在)\s*([^\s，,。；;:：]{2,20}?)\s*(?:支付|消费|付款|转账)/,
  /(?:收款方|商户名称|商户|商家名称|商家|对方)\s*[:：]\s*([^\s，,。；;:：]{1,20})/,
  /([^\s，,。；;:：]{2,20}?)\s*(?:收款|到账|已收款)/,
];

function toCents(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  // 用字符串方式避免浮点
  const [i = '0', f = ''] = cleaned.split('.');
  const intVal = Number(i);
  const frac = Number((f + '00').slice(0, 2));
  if (!Number.isSafeInteger(intVal) || !Number.isSafeInteger(frac)) return null;
  return intVal * 100 + frac;
}

/**
 * 解析分享文本。
 * 返回 null 表示「解析不可靠，应落回手填」。
 */
export function parseShareText(raw: string): ShareParseResult | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > 2000) return null;

  let amountCents: number | null = null;
  let matched = '';

  for (const re of AMOUNT_PATTERNS) {
    const m = text.match(re);
    if (m && m[1]) {
      const c = toCents(m[1]);
      // 过滤明显不合理的值：0 元、超过 100 万
      if (c !== null && c > 0 && c <= 100_000_000) {
        amountCents = c;
        matched = m[0].trim();
        break;
      }
    }
  }

  if (amountCents === null) return null;

  let merchant: string | null = null;
  for (const re of MERCHANT_PATTERNS) {
    const m = text.match(re);
    if (m && m[1]) {
      const cand = m[1].trim();
      if (cand && cand.length >= 2 && cand.length <= 20) {
        merchant = cand;
        break;
      }
    }
  }

  // 置信度：带货币符号或「元」且拿到商户 = high
  const hasCurrencyMarker = /[¥￥]|元|消费|支付|支出|扣款|付款/.test(matched);
  const confidence: 'high' | 'medium' =
    hasCurrencyMarker && merchant ? 'high' : 'medium';

  return { amountCents, merchant, confidence, matched };
}
