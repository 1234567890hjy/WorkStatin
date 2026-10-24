/**
 * 账户与分类的校验：从 routes/meta.ts 抽出来的纯函数，便于单测。
 */

export const ACCOUNT_KINDS = ['cash', 'bank', 'credit', 'ewallet'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const CATEGORY_KINDS = ['expense', 'income'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const MAX_ACCOUNT_NAME = 32;
export const MAX_CATEGORY_NAME = 20;

// ---------- 账户 ----------

export interface AccountInput {
  name?: string;
  kind?: string;
  balance_cents?: number;
  is_archived?: number;
}

export type AccountValidation =
  | { value: { name: string; kind: AccountKind; balanceCents: number; isArchived: number } }
  | { error: { code: string; message: string } };

/** 校验新增账户的输入。 */
export function validateAccountCreate(body: AccountInput): AccountValidation {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { error: { code: 'EMPTY_NAME', message: '账户名不能为空' } };
  if (name.length > MAX_ACCOUNT_NAME) {
    return { error: { code: 'NAME_TOO_LONG', message: `账户名最长 ${MAX_ACCOUNT_NAME} 字` } };
  }

  const kind = String(body.kind ?? 'cash') as AccountKind;
  if (!ACCOUNT_KINDS.includes(kind)) {
    return { error: { code: 'INVALID_KIND', message: `kind 必须是 ${ACCOUNT_KINDS.join('/')}` } };
  }

  const balance = Number(body.balance_cents ?? 0);
  if (!Number.isSafeInteger(balance) || balance < 0) {
    return { error: { code: 'INVALID_BALANCE', message: '余额必须是非负整数（分）' } };
  }

  return {
    value: { name, kind, balanceCents: balance, isArchived: body.is_archived ? 1 : 0 },
  };
}

// ---------- 分类 ----------

export interface CategoryInput {
  name?: string;
  kind?: string;
  icon?: string | null;
  sort?: number;
}

export type CategoryValidation =
  | {
      value: {
        name: string;
        kind: CategoryKind;
        icon: string | null;
        sort: number;
      };
    }
  | { error: { code: string; message: string } };

/** 校验新增/修改分类的输入。 */
export function validateCategory(body: CategoryInput): CategoryValidation {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { error: { code: 'EMPTY_NAME', message: '分类名不能为空' } };
  if (name.length > MAX_CATEGORY_NAME) {
    return { error: { code: 'NAME_TOO_LONG', message: `分类名最长 ${MAX_CATEGORY_NAME} 字` } };
  }

  const kind = String(body.kind ?? 'expense') as CategoryKind;
  if (!CATEGORY_KINDS.includes(kind)) {
    return { error: { code: 'INVALID_KIND', message: `kind 必须是 ${CATEGORY_KINDS.join('/')}` } };
  }

  // icon 允许 emoji 或短文本；null / 空串都归一为 null
  let icon: string | null = null;
  if (typeof body.icon === 'string') {
    const s = body.icon.trim();
    icon = s ? s.slice(0, 8) : null;
  }

  const sort = Number(body.sort ?? 0);
  if (!Number.isInteger(sort) || sort < 0 || sort > 999) {
    return { error: { code: 'INVALID_SORT', message: 'sort 必须是 0~999 的整数' } };
  }

  return { value: { name, kind, icon, sort } };
}
