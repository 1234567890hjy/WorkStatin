/**
 * share_target 接收端。
 *
 * Android PWA 分享过来的是 text/plain（或 urlencoded 表单）。
 * 这里只做「解析 + 返回预填数据」，不直接落库 ——
 * 用户必须在 App 里确认后才写入，避免把无关文本记成账。
 */

import { Hono } from 'hono';
import type { Env } from '../types.ts';
import { parseShareText } from '../domain/share-parse.ts';
import { normalizeOccurred } from '../domain/dates.ts';
import { ok, err } from '../http.ts';
import { requireSession } from './auth.ts';

export const shareRoutes = new Hono<{ Bindings: Env }>();

/** 解析分享文本，返回预填草稿（不落库） */
shareRoutes.post('/parse', async (c) => {
  const session = await requireSession(c.env, c.req.raw);
  if (!session) return err('UNAUTHORIZED', '未登录或会话已过期', 401);

  const ct = c.req.header('Content-Type') ?? '';
  let text = '';

  if (ct.includes('application/json')) {
    const body = await c.req.json<{ text?: string; title?: string; url?: string }>().catch(() => null);
    text = [body?.title, body?.text, body?.url].filter(Boolean).join(' ');
  } else if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
    const form = await c.req.parseBody().catch(() => null);
    text = [form?.['title'], form?.['text'], form?.['url']]
      .filter((v): v is string => typeof v === 'string')
      .join(' ');
  } else {
    text = await c.req.text().catch(() => '');
  }

  if (!text.trim()) return err('EMPTY_SHARE', '分享内容为空');

  const parsed = parseShareText(text);
  const now = normalizeOccurred();

  if (!parsed) {
    // 解析失败不是错误：前端应落回手填，并把原文带过去
    return ok({
      parsed: false,
      raw: text.slice(0, 500),
      draft: {
        type: 'expense',
        amount: '',
        merchant: '',
        occurred_at: now.occurredAt,
      },
    });
  }

  return ok({
    parsed: true,
    confidence: parsed.confidence,
    raw: text.slice(0, 500),
    matched: parsed.matched,
    draft: {
      type: 'expense',
      amount: (parsed.amountCents / 100).toFixed(2),
      amount_cents: parsed.amountCents,
      merchant: parsed.merchant ?? '',
      occurred_at: now.occurredAt,
    },
  });
});
