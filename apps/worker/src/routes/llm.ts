/**
 * LLM 摘要：调用 DeepSeek。
 *
 * 设计（v2 方案第 12 条）：半手动 —— 用户在网页版验证过 prompt 之后，
 * 这里才自动化。所以 prompt 保持简洁、可预测，不做花哨的 agent 编排。
 *
 * 同步调用：Workers 的 CPU 计时不含网络等待，等 10~30 秒不烧 CPU，
 * 因此不需要队列。超时用 AbortController 兜底。
 */

import { Hono } from 'hono';
import type { Env } from '../types.ts';
import { ok, err } from '../http.ts';
import { requireSession } from './auth.ts';

export const llmRoutes = new Hono<{ Bindings: Env }>();

llmRoutes.use('*', async (c, next) => {
  const session = await requireSession(c.env, c.req.raw);
  if (!session) return err('UNAUTHORIZED', '未登录或会话已过期', 401);
  await next();
});

const TIMEOUT_MS = 90_000;
const MAX_INPUT_CHARS = 60_000;

/** 构造摘要 prompt。转写稿可能很长，先截断到预算内。 */
export function buildSummaryPrompt(transcript: string, title?: string | null): string {
  const trimmed =
    transcript.length > MAX_INPUT_CHARS
      ? transcript.slice(0, MAX_INPUT_CHARS) + '\n\n[转写稿过长，已截断]'
      : transcript;

  return [
    '你是一个学习笔记助手。下面是一段视频的转写稿，请提取要点。',
    '',
    '要求：',
    '1. 用中文输出 Markdown；',
    '2. 结构固定为：一句话总结 / 核心要点（3~7 条）/ 可执行行动（0~3 条）/ 关键概念；',
    '3. 只基于转写稿内容，不要编造；信息不足就写「转写稿未涉及」；',
    '4. 总长度控制在 600 字以内。',
    '',
    title ? `视频标题：${title}` : '',
    '',
    '--- 转写稿开始 ---',
    trimmed,
    '--- 转写稿结束 ---',
  ]
    .filter((x) => x !== '')
    .join('\n');
}

interface DeepSeekResp {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

/** 生成摘要 */
llmRoutes.post('/summarize', async (c) => {
  const apiKey = c.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return err(
      'LLM_NOT_CONFIGURED',
      '未配置 DEEPSEEK_API_KEY，可在设置页手动填写摘要',
      503,
    );
  }

  const body = await c.req.json<{ transcript?: string; title?: string }>().catch(() => null);
  if (!body) return err('INVALID_BODY', '请求体必须是 JSON');

  const transcript = (body.transcript ?? '').trim();
  if (!transcript) return err('EMPTY_TRANSCRIPT', '转写稿不能为空');

  const prompt = buildSummaryPrompt(transcript, body.title ?? null);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1500,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return err(
        'LLM_UPSTREAM_ERROR',
        `LLM 返回 ${res.status}${detail ? `：${detail.slice(0, 200)}` : ''}`,
        502,
      );
    }

    const json = (await res.json().catch(() => null)) as DeepSeekResp | null;
    const content = json?.choices?.[0]?.message?.content?.trim();

    if (!content) {
      return err('LLM_EMPTY', json?.error?.message ?? 'LLM 未返回内容', 502);
    }

    return ok({ summary: content, model: 'deepseek-chat' });
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError';
    return err(
      'LLM_TIMEOUT',
      aborted ? `LLM 调用超时（${TIMEOUT_MS / 1000} 秒）` : 'LLM 调用失败',
      504,
    );
  } finally {
    clearTimeout(timer);
  }
});
