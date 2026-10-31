import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Txn } from '../api';
import { buildUndoToast } from '../notify-format';

/**
 * 「刚自动记了一笔」的 toast，5 分钟内可一键撤销。
 *
 * 为什么要有它：高置信度通知会直接落库，用户没有任何确认动作。
 * 如果识别错了（比如金额对但记到了错账户），必须有一个
 * 「刚发生了什么、可以反悔」的窗口，否则用户只能去账单列表里翻。
 *
 * 撤销走 /notify/undo/:id，该接口只允许 5 分钟内、source=notify 的记录。
 */

interface Props {
  txn: Txn;
  onUndone: () => void;
  onDismiss: () => void;
}

const WINDOW_MS = 5 * 60_000;

export default function UndoToast({ txn, onUndone, onDismiss }: Props) {
  // created_at 是服务器时间；用本地倒计时近似即可（误差秒级）
  const [leftMs, setLeftMs] = useState(WINDOW_MS);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const startRef = useRef(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => {
      const left = WINDOW_MS - (Date.now() - startRef.current);
      setLeftMs(left);
      if (left <= 0) {
        window.clearInterval(id);
        onDismiss();
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [onDismiss]);

  async function undo() {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/notify/undo/${txn.id}`);
      onUndone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '撤销失败');
    } finally {
      setBusy(false);
    }
  }

  const model = buildUndoToast(txn, leftMs);

  return (
    <div className="fixed inset-x-0 bottom-20 z-50 mx-auto max-w-md px-4">
      <div className="flex items-center gap-3 rounded-2xl bg-ink-900 px-4 py-3 text-white shadow-lg">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{model.title}</p>
          <p className="truncate text-xs text-white/60">{model.detail}</p>
          {err && <p className="mt-0.5 text-xs text-red-300">{err}</p>}
        </div>
        <button
          onClick={undo}
          disabled={busy}
          className="shrink-0 rounded-lg bg-white/15 px-3 py-1.5 text-sm font-medium disabled:opacity-40"
        >
          {busy ? '撤销中' : '撤销'}
        </button>
        <button
          onClick={onDismiss}
          className="shrink-0 text-lg leading-none text-white/50"
          aria-label="关闭"
        >
          ×
        </button>
      </div>
    </div>
  );
}
