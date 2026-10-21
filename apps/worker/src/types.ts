/** Worker 绑定与环境变量。 */
export interface Env {
  DB: D1Database;
  /** 可选：用于加密备份的密钥（P2 才用） */
  BACKUP_KEY?: string;
  /** 环境标识 */
  ENVIRONMENT?: string;
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  password_salt: string;
  iterations: number;
  totp_secret: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  token_hash: string;
  user_id: number;
  created_at: string;
  expires_at: string;
  last_seen: string;
}

export type TxnType = 'expense' | 'income' | 'transfer';

export interface TxnRow {
  id: number;
  type: TxnType;
  amount_cents: number;
  account_id: number;
  to_account_id: number | null;
  category_id: number | null;
  merchant: string | null;
  note: string | null;
  occurred_at: string;
  occurred_day: string;
  occurred_month: string;
  source: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ApiOk<T> {
  ok: true;
  data: T;
}

export interface ApiErr {
  ok: false;
  error: { code: string; message: string };
}
