/**
 * 通知去重：决定「这条通知是不是刚才那笔的重复」。
 *
 * ============ 真实场景 ============
 *
 * 微信付款后，通知栏可能同时出现两条：
 *   1. 微信支付：已支付¥16.88
 *   2. 银行 App：您账户支出￥16.88
 * 这是同一笔钱，必须只记一次。
 *
 * 但两杯 15 元咖啡间隔 30 秒也是真实存在的，一刀切会丢一笔。
 *
 * ============ 最终规则（用户拍板）============
 *
 *   匹配条件：金额相同 + 时间窗内 + **双方 merchant 都为空**
 *   仲裁方式：命中后按渠道优先级保留一条（微信 > 支付宝 > 银行 > 未知）
 *
 * 注意「渠道」不参与匹配 —— 它参与仲裁。
 * 因为跨渠道重复（微信 vs 银行）正是要解决的核心问题，
 * 若把 channel 当匹配条件，微信和银行的通知永远匹配不上，去重直接失效。
 *
 * 「双方商户都为空」这个条件对微信通知特别安全 —— 它的通知本来就不带商户。
 * 一旦任一方带了商户名，说明信息足够区分两笔消费，全部保留。
 */

export type Channel = 'wechat' | 'alipay' | 'bank' | 'unknown';

export interface DedupeCandidate {
  amountCents: number;
  merchant: string | null;
  /** 毫秒时间戳 */
  atMs: number;
  channel: Channel;
}

export interface DedupeExisting {
  /** 记录 id（txn 或 pending 的 id），用于仲裁后决定删谁 */
  id: number;
  /** 该记录来自哪张表，仲裁后决定删 txn 还是 pending */
  kind: 'txn' | 'pending';
  amountCents: number;
  merchant: string | null;
  atMs: number;
  channel: Channel;
}

export interface DedupeOptions {
  /** 时间窗（毫秒），默认 60 秒 */
  windowMs?: number;
}

export const DEFAULT_DEDUPE_WINDOW_MS = 60_000;

/**
 * 渠道优先级：数字越小越可信。
 * 微信支付通知直接来自支付方，比银行的转述更准确。
 */
export const CHANNEL_PRIORITY: Record<Channel, number> = {
  wechat: 0,
  alipay: 1,
  bank: 2,
  unknown: 3,
};

export type DedupeVerdict =
  /** 没找到重复，正常入库 */
  | { kind: 'unique' }
  /** 找到重复，且已有记录更可信 → 丢弃新来的 */
  | { kind: 'drop_new'; duplicateOf: DedupeExisting }
  /** 找到重复，但新来的更可信 → 用新的替换旧的 */
  | { kind: 'replace_old'; duplicateOf: DedupeExisting };

/**
 * 判定一条新通知与已有记录的关系。
 *
 * `existing` 应只包含时间窗附近的记录（调用方负责范围查询）；
 * 本函数仍会再校验一次时间差，避免调用方传错范围时静默出错。
 */
export function dedupeVerdict(
  candidate: DedupeCandidate,
  existing: DedupeExisting[],
  options: DedupeOptions = {},
): DedupeVerdict {
  const windowMs = options.windowMs ?? DEFAULT_DEDUPE_WINDOW_MS;

  // 新记录带了商户 → 信息足够区分，不参与去重
  if (hasMerchant(candidate.merchant)) return { kind: 'unique' };

  let best: DedupeExisting | null = null;

  for (const row of existing) {
    if (row.amountCents !== candidate.amountCents) continue;
    // 已有记录带了商户 → 认为是另一笔
    if (hasMerchant(row.merchant)) continue;
    if (!Number.isFinite(row.atMs)) continue;
    if (Math.abs(row.atMs - candidate.atMs) > windowMs) continue;

    // 多条候选时取时间最近的一条
    if (best === null || Math.abs(row.atMs - candidate.atMs) < Math.abs(best.atMs - candidate.atMs)) {
      best = row;
    }
  }

  if (!best) return { kind: 'unique' };

  const newRank = CHANNEL_PRIORITY[candidate.channel] ?? CHANNEL_PRIORITY.unknown;
  const oldRank = CHANNEL_PRIORITY[best.channel] ?? CHANNEL_PRIORITY.unknown;

  return newRank < oldRank
    ? { kind: 'replace_old', duplicateOf: best }
    : { kind: 'drop_new', duplicateOf: best };
}

function hasMerchant(m: string | null | undefined): boolean {
  return typeof m === 'string' && m.trim().length > 0;
}

/**
 * 通知幂等键：同一条通知被 APK 重发时用来兜底。
 *
 * 用 (pkg, title, body, postTime) 拼接后取 SHA-256：
 *   - 不含 postTime 会把「同金额的两次真实支付」误判成重复
 *   - 含 postTime 则重发同一条通知必然命中，新通知必然不命中
 *
 * 注意：这不是「金额去重」，只是「同一条通知不重复入库」。
 * 跨渠道的金额去重由 dedupeVerdict 负责。
 */
export function notificationIdentity(input: {
  pkg?: string | null;
  title?: string | null;
  body?: string | null;
  postTime?: number | string | null;
}): string {
  const parts = [
    input.pkg ?? '',
    input.title ?? '',
    input.body ?? '',
    String(input.postTime ?? ''),
  ];
  return parts.join('\u0000');
}
