/** 统一 API 客户端。token 存 localStorage，随请求带 Authorization。 */

const TOKEN_KEY = 'ws_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: { code: string; message: string };
}
type ApiRes<T> = ApiOk<T> | ApiErr;

export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`/api${path}`, { ...init, headers });
  const json = (await res.json().catch(() => null)) as ApiRes<T> | null;

  if (!json) throw new ApiError('BAD_RESPONSE', '服务器返回了无法解析的内容');
  if (!json.ok) {
    if (res.status === 401) clearToken();
    throw new ApiError(json.error.code, json.error.message);
  }
  return json.data;
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(p: string) => request<T>(p, { method: 'DELETE' }),
};

// ---------- 类型 ----------

export interface Account {
  id: number;
  name: string;
  kind: string;
  balance_cents: number;
  is_archived: number;
}

export interface Category {
  id: number;
  name: string;
  kind: string;
  icon: string | null;
  sort: number;
}

export interface Txn {
  id: number;
  type: 'expense' | 'income' | 'transfer';
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
  account_name?: string;
  category_name?: string;
}

export interface Dashboard {
  month: string;
  day: string;
  month_stats: { expense_cents: number; income_cents: number; transfer_cents: number };
  today_stats: { expense_cents: number; income_cents: number; count: number };
  net_worth_cents: number;
  workout_7d: { minutes: number; count: number };
  open_tasks: number;
  recent_txns: Txn[];
}

export interface ShareParse {
  parsed: boolean;
  confidence?: 'high' | 'medium';
  raw: string;
  matched?: string;
  draft: {
    type: string;
    amount: string;
    amount_cents?: number;
    merchant: string;
    occurred_at: string;
  };
}
