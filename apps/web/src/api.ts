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
  patch: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
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

export type AccountKind = 'cash' | 'bank' | 'credit' | 'ewallet';
export type CategoryKind = 'expense' | 'income';

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

// ---------- 日常管理 ----------

export type Cadence = 'daily' | 'weekly' | 'monthly';

export interface Routine {
  id: number;
  name: string;
  cadence: Cadence;
  target_per_period: number;
  is_active: number;
  created_at: string;
  // 列表接口附带的进度字段
  period_from?: string;
  period_to?: string;
  period_done?: number;
  period_target?: number;
  period_met?: boolean;
  checked_today?: boolean;
  streak?: number;
  total_days?: number;
}

// ---------- 计划与任务 ----------

export type TaskStatus = 'todo' | 'doing' | 'done' | 'dropped';
export type TaskPriority = 1 | 2 | 3;

export interface Task {
  id: number;
  title: string;
  detail: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_day: string | null;
  done_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MonthlyCategoryRow {
  kind: string;
  category_id: number | null;
  category_name: string | null;
  total_cents: number;
  txn_count: number;
}

export interface MonthlyStats {
  month: string;
  expense_cents: number;
  income_cents: number;
  transfer_cents: number;
  by_category: MonthlyCategoryRow[];
}

export interface Dashboard {
  month: string;
  day: string;
  month_stats: { expense_cents: number; income_cents: number; transfer_cents: number };
  today_stats: { expense_cents: number; income_cents: number; count: number };
  net_worth_cents: number;
  workout_7d: { minutes: number; count: number };
  open_tasks: number;
  tasks_today: number;
  tasks_overdue: number;
  routines_today_total: number;
  routines_today_done: number;
  recent_tasks: Task[];
  recent_txns: Txn[];
  // P1
  video_stats: { pending: number; done: number };
  recent_workouts: Workout[];
  // 通知自动记账
  notify?: NotifyStatus;
}

// ---------- 通知自动记账 ----------

export interface NotifyStatus {
  pending_count: number;
  raw_new_count: number;
  healthy: boolean;
  heartbeat_age_hours: number | null;
  heartbeat_timeout_hours: number;
  has_device: boolean;
  recent_auto_count: number;
}

/** GET /notify/health 的原始形状（APK 与设置页共用） */
export interface NotifyHealth {
  healthy: boolean;
  warning: string | null;
  heartbeat_age_hours: number | null;
  heartbeat_timeout_hours: number;
  device: {
    device_id: string;
    last_seen_at: string;
    sent_total: number;
    queue_depth: number;
    app_version: string | null;
  } | null;
  last_notify_txn_at: string | null;
  notify_txn_total: number;
  pending_count: number;
  raw_new_count: number;
}

export type NotifyChannel = 'wechat' | 'alipay' | 'bank' | 'unknown';

export interface PendingTxn {
  id: number;
  type: 'expense' | 'income';
  amount_cents: number;
  account_id: number | null;
  category_id: number | null;
  merchant: string | null;
  note: string | null;
  occurred_at: string;
  occurred_day: string;
  occurred_month: string;
  channel: NotifyChannel;
  confidence: 'medium' | 'low';
  matched: string | null;
  created_at: string;
  account_name?: string | null;
  category_name?: string | null;
}

export interface RawNotification {
  id: number;
  channel: NotifyChannel;
  pkg: string | null;
  title: string | null;
  body: string | null;
  posted_at: string | null;
  received_at: string;
  status: 'new' | 'ignored' | 'recorded';
  reason: string | null;
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

// ---------- P1 ----------

export type WorkoutKind = 'run' | 'walk' | 'cycle' | 'gym' | 'swim' | 'other';

export interface Workout {
  id: number;
  kind: WorkoutKind;
  duration_min: number;
  distance_m: number | null;
  calories: number | null;
  note: string | null;
  occurred_at: string;
  occurred_day: string;
}

export interface WorkoutStats {
  days: number;
  end: string;
  minutes: number;
  distance_m: number;
  calories: number;
  count: number;
  by_day: { occurred_day: string; minutes: number; n: number }[];
}

export interface Weather {
  available: boolean;
  reason?: string;
  label: string;
  /** 实际使用的坐标（4 位小数） */
  lat?: number;
  lon?: number;
  /** 坐标来源：gps=浏览器定位 / edge=边缘 IP / config=服务端兜底 */
  source?: 'gps' | 'edge' | 'config';
  current?: {
    temp: number | null;
    feels_like: number | null;
    humidity: number | null;
    wind: number | null;
    code: number;
    text: string;
    icon: string;
  };
  daily?: {
    max: number;
    min: number | null;
    code: number;
    text: string;
    icon: string;
    rain_prob: number | null;
  }[];
  updated_at?: string;
  cached?: boolean;
}

export type VideoStatus = 'draft' | 'transcribed' | 'summarized' | 'archived';
export interface VideoItem {
  id: number;
  url: string;
  platform: string | null;
  title: string | null;
  author: string | null;
  duration_sec: number | null;
  status: VideoStatus;
  tags: string | null;
  transcript?: string | null;
  summary?: string | null;
  has_transcript?: number;
  has_summary?: number;
  created_at: string;
  updated_at: string;
}
