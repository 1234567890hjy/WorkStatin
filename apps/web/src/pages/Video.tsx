import { useEffect, useState } from 'react';
import { api, ApiError, type VideoItem } from '../api';
import type { AppData } from '../App';

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  draft: { text: '待转写', cls: 'bg-ink-100 text-ink-700' },
  transcribed: { text: '待摘要', cls: 'bg-amber-100 text-amber-800' },
  summarized: { text: '已摘要', cls: 'bg-emerald-100 text-emerald-800' },
  archived: { text: '已归档', cls: 'bg-blue-100 text-blue-800' },
};

export default function VideoPage({ data: _data }: { data: AppData }) {
  const [items, setItems] = useState<VideoItem[]>([]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [active, setActive] = useState<VideoItem | null>(null);

  useEffect(() => {
    api
      .get<{ items: VideoItem[] }>('/videos?limit=100')
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, [reloadKey]);

  async function add() {
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) {
      setMsg({ type: 'err', text: '请填写 http(s) 链接' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api.post('/videos', { url: u });
      setUrl('');
      setMsg({ type: 'ok', text: '已添加，正在抓取标题' });
      setReloadKey((k) => k + 1);
    } catch (e) {
      setMsg({ type: 'err', text: e instanceof ApiError ? e.message : '添加失败' });
    } finally {
      setBusy(false);
    }
  }

  if (active) {
    return (
      <VideoDetail
        item={active}
        onBack={() => {
          setActive(null);
          setReloadKey((k) => k + 1);
        }}
      />
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 pt-6">
      <h1 className="text-lg font-semibold text-ink-900">视频学习</h1>
      <p className="-mt-2 text-xs text-ink-500">
        添加链接 → 粘贴转写稿 → 生成摘要。不下载视频、不做语音识别。
      </p>

      {/* 添加 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="粘贴 B 站 / 抖音 视频链接"
          className="w-full rounded-lg border border-ink-100 px-3 py-2 text-sm outline-none focus:border-ink-300"
        />
        {msg && (
          <p className={`mt-2 text-sm ${msg.type === 'ok' ? 'text-emerald-600' : 'text-red-600'}`}>
            {msg.text}
          </p>
        )}
        <button
          onClick={add}
          disabled={busy || !url.trim()}
          className="mt-3 w-full rounded-lg bg-ink-900 py-2.5 font-medium text-white disabled:opacity-40"
        >
          {busy ? '添加中…' : '添加'}
        </button>
      </section>

      {/* 列表 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold text-ink-900">我的视频（{items.length}）</h2>
        {items.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-500">还没有添加视频</p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {items.map((v) => {
              const st = STATUS_LABEL[v.status] ?? STATUS_LABEL['draft']!;
              return (
                <li key={v.id}>
                  <button
                    onClick={() => setActive(v)}
                    className="flex w-full items-start justify-between gap-2 py-2.5 text-left"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-ink-900">
                        {v.title || '（无标题）'}
                      </p>
                      <p className="truncate text-xs text-ink-500">
                        {v.author ? `${v.author} · ` : ''}
                        {v.platform ?? 'other'}
                        {v.duration_sec
                          ? ` · ${Math.floor(v.duration_sec / 60)}:${String(v.duration_sec % 60).padStart(2, '0')}`
                          : ''}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${st.cls}`}
                    >
                      {st.text}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function VideoDetail({ item, onBack }: { item: VideoItem; onBack: () => void }) {
  const [transcript, setTranscript] = useState(item.transcript ?? '');
  const [summary, setSummary] = useState(item.summary ?? '');
  const [tags, setTags] = useState(item.tags ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  async function saveTranscript() {
    if (!transcript.trim()) {
      setMsg({ type: 'err', text: '转写稿不能为空' });
      return;
    }
    setBusy('transcript');
    setMsg(null);
    try {
      await api.put(`/videos/${item.id}/transcript`, { transcript });
      setMsg({ type: 'ok', text: '转写稿已保存' });
    } catch (e) {
      setMsg({ type: 'err', text: e instanceof ApiError ? e.message : '保存失败' });
    } finally {
      setBusy(null);
    }
  }

  async function genSummary() {
    if (!transcript.trim()) {
      setMsg({ type: 'err', text: '请先粘贴转写稿' });
      return;
    }
    setBusy('llm');
    setMsg(null);
    try {
      const r = await api.post<{ summary: string }>('/llm/summarize', {
        transcript,
        title: item.title,
      });
      setSummary(r.summary);
      setMsg({ type: 'ok', text: '摘要已生成，记得点保存' });
    } catch (e) {
      const m = e instanceof ApiError ? e.message : '生成失败';
      setMsg({
        type: 'err',
        text: m.includes('未配置') ? '未配置 LLM 密钥，可手动填写摘要' : m,
      });
    } finally {
      setBusy(null);
    }
  }

  async function saveSummary() {
    if (!summary.trim()) {
      setMsg({ type: 'err', text: '摘要不能为空' });
      return;
    }
    setBusy('summary');
    setMsg(null);
    try {
      await api.put(`/videos/${item.id}/summary`, { summary, tags });
      setMsg({ type: 'ok', text: '摘要已保存' });
    } catch (e) {
      setMsg({ type: 'err', text: e instanceof ApiError ? e.message : '保存失败' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 pt-6">
      <button onClick={onBack} className="text-sm text-ink-500">
        ← 返回
      </button>

      <header>
        <h1 className="text-base font-semibold leading-snug text-ink-900">
          {item.title || '（无标题）'}
        </h1>
        <p className="mt-0.5 text-xs text-ink-500">
          {item.author ? `${item.author} · ` : ''}
          {item.platform ?? 'other'}
        </p>
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="mt-1 block truncate text-xs text-blue-600"
        >
          {item.url}
        </a>
      </header>

      {/* 转写稿 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-900">转写稿</h2>
          <span className="text-xs text-ink-500">{transcript.length} 字</span>
        </div>
        <textarea
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          rows={8}
          placeholder="从通义听悟等工具复制转写稿，粘贴到这里"
          className="w-full resize-y rounded-lg border border-ink-100 p-2 text-xs leading-relaxed outline-none focus:border-ink-300"
        />
        <button
          onClick={saveTranscript}
          disabled={busy !== null}
          className="mt-2 w-full rounded-lg border border-ink-300 py-2 text-sm font-medium text-ink-700 disabled:opacity-40"
        >
          {busy === 'transcript' ? '保存中…' : '保存转写稿'}
        </button>
      </section>

      {/* 摘要 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-900">摘要</h2>
          <button
            onClick={genSummary}
            disabled={busy !== null || !transcript.trim()}
            className="rounded-full bg-ink-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
          >
            {busy === 'llm' ? '生成中…' : 'AI 生成'}
          </button>
        </div>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={10}
          placeholder="点「AI 生成」，或手动填写摘要"
          className="w-full resize-y rounded-lg border border-ink-100 p-2 text-xs leading-relaxed outline-none focus:border-ink-300"
        />
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="标签，逗号分隔（可选）"
          className="mt-2 w-full rounded-lg border border-ink-100 px-3 py-2 text-xs outline-none focus:border-ink-300"
        />
        <button
          onClick={saveSummary}
          disabled={busy !== null}
          className="mt-2 w-full rounded-lg bg-ink-900 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy === 'summary' ? '保存中…' : '保存摘要'}
        </button>
      </section>

      {msg && (
        <p className={`text-sm ${msg.type === 'ok' ? 'text-emerald-600' : 'text-red-600'}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
