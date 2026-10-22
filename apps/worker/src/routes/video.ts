/**
 * 视频 AI 学习。
 *
 * 关键设计（v2 方案第 3 条）：
 * - **不下载视频、不做 ASR**。转写稿由用户从通义听悟等工具粘贴进来。
 * - 系统只做三件事：抓元数据 → 存人工转写 → 触发 LLM 摘要 → 归档检索。
 * - LLM 是同步 HTTP 调用，Workers 的 CPU 计时不含等待网络的时间，
 *   所以不需要队列（这正是 v1 用 BullMQ 的误判）。
 *
 * 平台支持：B 站公开 view 接口（免登录）；抖音/其他只存链接与手填标题。
 */

import { Hono } from 'hono';
import type { Env } from '../types.ts';
import { ok, err } from '../http.ts';
import { requireSession } from './auth.ts';

export const videoRoutes = new Hono<{ Bindings: Env }>();

videoRoutes.use('*', async (c, next) => {
  const session = await requireSession(c.env, c.req.raw);
  if (!session) return err('UNAUTHORIZED', '未登录或会话已过期', 401);
  await next();
});

/**
 * 从 URL 识别平台。
 *
 * 注意域名边界：不能用 host.endsWith('bilibili.com')，
 * 那会把 evil-bilibili.com 也认成 B 站。必须是「等于」或「以 .bilibili.com 结尾」。
 */
export function detectPlatform(url: string): 'bilibili' | 'douyin' | 'other' {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();

    const isHost = (domain: string): boolean =>
      host === domain || host.endsWith(`.${domain}`);

    if (isHost('bilibili.com') || host === 'b23.tv') return 'bilibili';
    if (isHost('douyin.com') || host === 'v.douyin.com') return 'douyin';
    return 'other';
  } catch {
    return 'other';
  }
}

/** 从 B 站 URL 里抽 BV 号 */
export function extractBvid(url: string): string | null {
  const m = url.match(/\/(BV[0-9A-Za-z]{10})/);
  if (m && m[1]) return m[1];
  // b23.tv 短链里也可能直接带
  const m2 = url.match(/(BV[0-9A-Za-z]{10})/);
  return m2?.[1] ?? null;
}

interface BiliView {
  code: number;
  data?: {
    bvid?: string;
    title?: string;
    duration?: number;
    owner?: { name?: string };
    stat?: { view?: number; like?: number };
  };
}

/** 抓 B 站元数据（公开接口，无需登录） */
async function fetchBilibiliMeta(bvid: string): Promise<{
  title: string | null;
  author: string | null;
  durationSec: number | null;
} | null> {
  try {
    const res = await fetch(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
          Referer: 'https://www.bilibili.com/',
        },
      },
    );
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as BiliView | null;
    if (!json || json.code !== 0 || !json.data) return null;
    return {
      title: json.data.title ?? null,
      author: json.data.owner?.name ?? null,
      durationSec: json.data.duration ?? null,
    };
  } catch {
    return null;
  }
}

/** 列表 */
videoRoutes.get('/', async (c) => {
  const status = c.req.query('status');
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);

  const where: string[] = ['deleted_at IS NULL'];
  const binds: unknown[] = [];
  if (status) {
    where.push('status = ?');
    binds.push(status);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT id, url, platform, title, author, duration_sec, status, tags,
            created_at, updated_at,
            CASE WHEN transcript IS NULL OR transcript = '' THEN 0 ELSE 1 END AS has_transcript,
            CASE WHEN summary    IS NULL OR summary    = '' THEN 0 ELSE 1 END AS has_summary
     FROM video_item
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(...binds, limit)
    .all();

  return ok({ items: results ?? [] });
});

/** 搜索（标题/摘要/标签/转写）
 *  注意：必须注册在 /:id 之前，否则会被当成 id 匹配。 */
videoRoutes.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (!q) return err('EMPTY_QUERY', '请输入搜索词');

  const like = `%${q}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT id, url, platform, title, author, status, tags, created_at
     FROM video_item
     WHERE deleted_at IS NULL
       AND (title LIKE ? OR summary LIKE ? OR tags LIKE ? OR transcript LIKE ?)
     ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(like, like, like, like)
    .all();

  return ok({ items: results ?? [] });
});

/** 详情（含转写与摘要全文） */
videoRoutes.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const row = await c.env.DB.prepare(
    'SELECT * FROM video_item WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(id)
    .first();

  if (!row) return err('NOT_FOUND', '记录不存在', 404);
  return ok(row);
});

interface CreateInput {
  url?: string;
  title?: string;
}

/** 新增：自动抓元数据 */
videoRoutes.post('/', async (c) => {
  const body = await c.req.json<CreateInput>().catch(() => null);
  if (!body) return err('INVALID_BODY', '请求体必须是 JSON');

  const url = (body.url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return err('INVALID_URL', '请填写 http(s) 链接');

  const platform = detectPlatform(url);
  let title = body.title?.trim() || null;
  let author: string | null = null;
  let durationSec: number | null = null;

  // B 站：自动抓元数据（失败不阻塞，落手填）
  if (platform === 'bilibili') {
    const bvid = extractBvid(url);
    if (bvid) {
      const meta = await fetchBilibiliMeta(bvid);
      if (meta) {
        title = meta.title ?? title;
        author = meta.author;
        durationSec = meta.durationSec;
      }
    }
  }

  const res = await c.env.DB.prepare(
    `INSERT INTO video_item (url, platform, title, author, duration_sec, status)
     VALUES (?, ?, ?, ?, ?, 'draft')`,
  )
    .bind(url, platform, title, author, durationSec)
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM video_item WHERE id = ?')
    .bind(res.meta.last_row_id)
    .first();

  return ok(row);
});

/** 保存转写稿（人工粘贴） */
videoRoutes.put('/:id/transcript', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const body = await c.req.json<{ transcript?: string }>().catch(() => null);
  if (!body) return err('INVALID_BODY', '请求体必须是 JSON');

  const transcript = (body.transcript ?? '').trim();
  if (!transcript) return err('EMPTY_TRANSCRIPT', '转写稿不能为空');
  if (transcript.length > 500_000) return err('TOO_LONG', '转写稿过长（上限 50 万字）');

  const row = await c.env.DB.prepare(
    'SELECT id FROM video_item WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(id)
    .first();
  if (!row) return err('NOT_FOUND', '记录不存在', 404);

  await c.env.DB.prepare(
    `UPDATE video_item SET transcript = ?, status = 'transcribed', updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(transcript, id)
    .run();

  return ok({ id, status: 'transcribed', length: transcript.length });
});

/** 保存摘要（由前端调 LLM 或人工写） */
videoRoutes.put('/:id/summary', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  const body = await c.req.json<{ summary?: string; tags?: string }>().catch(() => null);
  if (!body) return err('INVALID_BODY', '请求体必须是 JSON');

  const summary = (body.summary ?? '').trim();
  if (!summary) return err('EMPTY_SUMMARY', '摘要不能为空');
  if (summary.length > 100_000) return err('TOO_LONG', '摘要过长');

  const tags = typeof body.tags === 'string' ? body.tags.trim().slice(0, 500) || null : null;

  const row = await c.env.DB.prepare(
    'SELECT id FROM video_item WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(id)
    .first();
  if (!row) return err('NOT_FOUND', '记录不存在', 404);

  await c.env.DB.prepare(
    `UPDATE video_item SET summary = ?, tags = COALESCE(?, tags), status = 'summarized',
       updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(summary, tags, id)
    .run();

  return ok({ id, status: 'summarized' });
});

/** 归档 */
videoRoutes.post('/:id/archive', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  await c.env.DB.prepare(
    `UPDATE video_item SET status = 'archived', updated_at = datetime('now')
     WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(id)
    .run();

  return ok({ id, status: 'archived' });
});

/** 软删除 */
videoRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return err('INVALID_ID', 'id 非法');

  await c.env.DB.prepare(
    `UPDATE video_item SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(id)
    .run();

  return ok({ deleted: id });
});
