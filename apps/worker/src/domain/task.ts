/**
 * 任务校验：从路由里抽出来的纯函数，便于单测。
 *
 * 为什么单独放 domain：routes/task.ts 要 import Hono，单测会连带把整个
 * Worker 拉起来；而这里只做字段校验，没有任何运行时依赖。
 */

export const TASK_STATUSES = ['todo', 'doing', 'done', 'dropped'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = [1, 2, 3] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface TaskInput {
  title?: string;
  detail?: string;
  status?: string;
  priority?: number;
  due_day?: string | null;
}

export interface TaskValue {
  title: string;
  detail: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDay: string | null;
}

export type TaskValidation =
  | { value: TaskValue }
  | { error: { code: string; message: string } };

const MAX_TITLE = 120;
const MAX_DETAIL = 2000;

function isDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 校验并规范化任务输入。 */
export function validateTask(body: TaskInput): TaskValidation {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return { error: { code: 'EMPTY_TITLE', message: '标题不能为空' } };
  if (title.length > MAX_TITLE) {
    return { error: { code: 'TITLE_TOO_LONG', message: `标题最长 ${MAX_TITLE} 字` } };
  }

  const detail =
    typeof body.detail === 'string' ? body.detail.trim().slice(0, MAX_DETAIL) || null : null;

  const status = String(body.status ?? 'todo') as TaskStatus;
  if (!TASK_STATUSES.includes(status)) {
    return {
      error: { code: 'INVALID_STATUS', message: `status 必须是 ${TASK_STATUSES.join('/')}` },
    };
  }

  const priority = Number(body.priority ?? 2);
  if (!TASK_PRIORITIES.includes(priority as TaskPriority)) {
    return { error: { code: 'INVALID_PRIORITY', message: 'priority 必须是 1/2/3' } };
  }

  // due_day 允许显式传 null / '' 表示清除
  let dueDay: string | null = null;
  if (body.due_day !== undefined && body.due_day !== null && body.due_day !== '') {
    if (typeof body.due_day !== 'string' || !isDay(body.due_day)) {
      return { error: { code: 'INVALID_DUE_DAY', message: 'due_day 格式应为 YYYY-MM-DD' } };
    }
    dueDay = body.due_day;
  }

  return { value: { title, detail, status, priority: priority as TaskPriority, dueDay } };
}
