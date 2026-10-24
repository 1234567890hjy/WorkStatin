/**
 * 日常管理（习惯打卡）：周期计算与校验。
 *
 * 表在 0001_init.sql 里就建好了：`routine`（定义）+ `routine_log`（打卡记录，
 * UNIQUE(routine_id, done_day) 保证同一天只能打一次）。
 *
 * 「周期」的语义：cadence=daily 时一个周期就是一天；weekly 是一周；monthly 是一月。
 * target_per_period 是「每周期要完成几次」—— 比如每周跑步 3 次。
 * 所以判断「这个周期达标了吗」要数该周期内的打卡次数是否 >= target。
 */

export const CADENCES = ['daily', 'weekly', 'monthly'] as const;
export type Cadence = (typeof CADENCES)[number];

export const MIN_NAME = 1;
export const MAX_NAME = 60;
export const MAX_TARGET = 31;

export interface RoutineInput {
  name?: string;
  cadence?: string;
  target_per_period?: number;
}

export interface RoutineValue {
  name: string;
  cadence: Cadence;
  targetPerPeriod: number;
}

export type RoutineValidation =
  | { value: RoutineValue }
  | { error: { code: string; message: string } };

/** 校验并规范化 routine 输入。 */
export function validateRoutine(body: RoutineInput): RoutineValidation {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < MIN_NAME) {
    return { error: { code: 'EMPTY_NAME', message: '名称不能为空' } };
  }
  if (name.length > MAX_NAME) {
    return { error: { code: 'NAME_TOO_LONG', message: `名称最长 ${MAX_NAME} 字` } };
  }

  const cadence = String(body.cadence ?? 'daily') as Cadence;
  if (!CADENCES.includes(cadence)) {
    return {
      error: { code: 'INVALID_CADENCE', message: `cadence 必须是 ${CADENCES.join('/')}` },
    };
  }

  const target = Number(body.target_per_period ?? 1);
  if (!Number.isInteger(target) || target < 1 || target > MAX_TARGET) {
    return {
      error: { code: 'INVALID_TARGET', message: `target_per_period 必须是 1~${MAX_TARGET} 的整数` },
    };
  }

  return { value: { name, cadence, targetPerPeriod: target } };
}

/**
 * 取某一天所在周期的起止日（含端点），用于统计打卡次数。
 *
 * daily:   [day, day]
 * weekly:  [周一, 周日]  —— 按 ISO 周，周一开始
 * monthly: [1号, 月末]
 */
export function periodRange(cadence: Cadence, day: string): { from: string; to: string } {
  const d = new Date(`${day}T00:00:00Z`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const date = d.getUTCDate();

  if (cadence === 'daily') {
    return { from: day, to: day };
  }

  if (cadence === 'weekly') {
    // getUTCDay(): 0=周日 ... 6=周六；转成「周一=0」的偏移
    const dow = d.getUTCDay();
    const offset = dow === 0 ? 6 : dow - 1;
    const monday = new Date(Date.UTC(y, m, date - offset));
    const sunday = new Date(Date.UTC(y, m, date - offset + 6));
    return { from: iso(monday), to: iso(sunday) };
  }

  // monthly
  const first = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(y, m + 1, 0));
  return { from: iso(first), to: iso(last) };
}

/** 当前连续打卡天数（streak），从今天（或昨天）往前数。 */
export function currentStreak(days: string[], today: string): number {
  if (days.length === 0) return 0;

  const set = new Set(days);
  const t = new Date(`${today}T00:00:00Z`).getTime();

  // 今天还没打卡时，从昨天起算 —— 否则「今天忘了打卡」会让昨天的连续记录归零，
  // 这不符合习惯类应用的通例（当天未结束前不应判断中断）。
  let cursor = set.has(today) ? t : t - 86_400_000;

  // 昨天也没打卡，说明已经断了
  if (!set.has(iso(new Date(cursor)))) return 0;

  let n = 0;
  while (set.has(iso(new Date(cursor)))) {
    n++;
    cursor -= 86_400_000;
  }
  return n;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
