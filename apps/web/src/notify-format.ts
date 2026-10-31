/**
 * 通知相关的展示用纯函数。
 *
 * 单独成文件的原因：
 *   1. Notify.tsx 是 TSX，Node 的 --experimental-strip-types 不能直接加载，
 *      抽出来才能在被测试引用时不牵扯 JSX 编译。
 *   2. 这些映射在多个页面都要用，放独立的领域模块更合理。
 */

export type NotifyChannel = 'wechat' | 'alipay' | 'bank' | 'unknown';

/** 渠道标识 → 中文名。未知值原样返回，避免后端新增渠道时显示空白。 */
export function channelLabel(c: NotifyChannel | string): string {
  const map: Record<string, string> = {
    wechat: '微信',
    alipay: '支付宝',
    bank: '银行卡',
    unknown: '未知渠道',
  };
  return map[c] ?? c;
}

/** 解析失败原因 → 可读文案。 */
export function reasonLabel(reason: string | null): string {
  if (!reason) return '未识别';
  const map: Record<string, string> = {
    empty: '内容为空',
    too_long: '内容过长',
    no_amount: '没找到金额',
    amount_out_of_range: '金额超出合理范围',
    refund_without_amount: '退款通知缺金额',
  };
  return map[reason] ?? reason;
}

/** 倒计时秒数文案。 */
export function undoCountdownText(leftMs: number): string {
  const secs = Math.max(0, Math.ceil(leftMs / 1000));
  return `${secs}s 内可撤销`;
}

/**
 * 撤销 toast 的展示数据。
 *
 * 把「算什么」和「怎么排」分开：这个函数是纯的、可测的，
 * TSX 组件只负责把结果画出来。
 * 在这个无法跑 vite build 的环境里，这是唯一能真正验证逻辑的方式。
 */
export interface UndoToastModel {
  /** 「自动记了一笔 -¥16.88」 */
  title: string;
  /** 「微信 · 瑞幸咖啡 · 300s 内可撤销」 */
  detail: string;
  /** 距撤销窗口关闭还剩几秒 */
  secondsLeft: number;
  canUndo: boolean;
}

export interface UndoTxnLike {
  type: 'expense' | 'income' | 'transfer';
  amount_cents: number;
  account_name?: string | null;
  merchant?: string | null;
}

/** 金额格式化（分 → 千分位元），与 format.ts 行为一致但独立，避免循环依赖。 */
function yuanGrouped(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const int = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const grouped = int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${frac}`;
}

export function buildUndoToast(txn: UndoTxnLike, leftMs: number): UndoToastModel {
  const sign = txn.type === 'expense' ? '-' : '+';
  const parts: string[] = [];
  if (txn.account_name) parts.push(txn.account_name);
  if (txn.merchant) parts.push(txn.merchant);
  parts.push(undoCountdownText(leftMs));

  return {
    title: `自动记了一笔 ${sign}¥${yuanGrouped(txn.amount_cents)}`,
    detail: parts.join(' · '),
    secondsLeft: Math.max(0, Math.ceil(leftMs / 1000)),
    canUndo: leftMs > 0,
  };
}
