import { describe, it, expect } from 'vitest';
import { detectPlatform, extractBvid } from '../src/routes/video';
import { buildSummaryPrompt } from '../src/routes/llm';

describe('detectPlatform', () => {
  it('识别 B 站', () => {
    expect(detectPlatform('https://www.bilibili.com/video/BV1xx411c7mD')).toBe('bilibili');
    expect(detectPlatform('https://b23.tv/abc123')).toBe('bilibili');
    expect(detectPlatform('https://m.bilibili.com/video/BV1xx411c7mD')).toBe('bilibili');
  });

  it('识别抖音', () => {
    expect(detectPlatform('https://www.douyin.com/video/123')).toBe('douyin');
    expect(detectPlatform('https://v.douyin.com/abc/')).toBe('douyin');
  });

  it('其他平台归为 other', () => {
    expect(detectPlatform('https://www.youtube.com/watch?v=abc')).toBe('other');
    expect(detectPlatform('https://example.com/x')).toBe('other');
  });

  it('非法 URL 归为 other 而不是抛错', () => {
    expect(detectPlatform('not-a-url')).toBe('other');
    expect(detectPlatform('')).toBe('other');
  });

  it('不被相似域名骗到', () => {
    // evil-bilibili.com 不应被识别成 B 站
    expect(detectPlatform('https://evil-bilibili.com/x')).toBe('other');
    expect(detectPlatform('https://fakeb23.tv/x')).toBe('other');
  });
});

describe('extractBvid', () => {
  it('从标准链接抽 BV 号', () => {
    expect(extractBvid('https://www.bilibili.com/video/BV1xx411c7mD')).toBe('BV1xx411c7mD');
    expect(extractBvid('https://www.bilibili.com/video/BV1xx411c7mD?p=2')).toBe('BV1xx411c7mD');
  });

  it('从无路径前缀的链接抽', () => {
    expect(extractBvid('https://b23.tv/BV1xx411c7mD')).toBe('BV1xx411c7mD');
  });

  it('没有 BV 号返回 null', () => {
    expect(extractBvid('https://www.bilibili.com/video/av12345')).toBeNull();
    expect(extractBvid('https://example.com')).toBeNull();
  });

  it('BV 号长度必须恰好 10 位', () => {
    // BV 后只有 9 位，不该匹配
    expect(extractBvid('https://b23.tv/BV1xx411c7m')).toBeNull();
  });
});

describe('buildSummaryPrompt', () => {
  it('包含固定结构要求', () => {
    const p = buildSummaryPrompt('这是转写稿');
    expect(p).toContain('一句话总结');
    expect(p).toContain('核心要点');
    expect(p).toContain('可执行行动');
    expect(p).toContain('关键概念');
  });

  it('包含转写稿内容', () => {
    const p = buildSummaryPrompt('独特的内容片段ABC');
    expect(p).toContain('独特的内容片段ABC');
  });

  it('有标题时带上标题', () => {
    const p = buildSummaryPrompt('内容', '我的视频标题');
    expect(p).toContain('我的视频标题');
  });

  it('无标题时不出现标题行', () => {
    const p = buildSummaryPrompt('内容');
    expect(p).not.toContain('视频标题：');
  });

  it('超长转写稿被截断', () => {
    const long = 'x'.repeat(100_000);
    const p = buildSummaryPrompt(long);
    expect(p).toContain('已截断');
    // 整体长度应明显小于原文
    expect(p.length).toBeLessThan(long.length);
  });

  it('要求不编造', () => {
    const p = buildSummaryPrompt('内容');
    expect(p).toContain('不要编造');
  });
});
