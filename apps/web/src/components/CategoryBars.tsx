import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MonthlyCategoryRow } from '../api';
import { formatYuanGrouped } from '../format';

/**
 * 分类占比图。
 *
 * 为什么用横向条形图而不是饼图：手机上饼图的图例和百分比标签会挤成一团，
 * 而分类通常有 8~12 项，条形图能直接读名字和长度。
 *
 * 数据来自 `/txns/stats/monthly` 的 `by_category` —— 这个接口早就写好了，
 * 前端一直没调用，recharts 也装了但全项目零使用。
 */

const MAX_ROWS = 10;

/** 给每根条一个稳定的颜色（不依赖分类顺序）。 */
const PALETTE = [
  '#0f172a',
  '#334155',
  '#475569',
  '#64748b',
  '#94a3b8',
  '#0e7490',
  '#155e75',
  '#1e40af',
  '#3730a3',
  '#6b21a8',
];

interface Props {
  rows: MonthlyCategoryRow[];
  /** expense | income */
  kind?: string;
  totalCents: number;
}

export default function CategoryBars({ rows, kind = 'expense', totalCents }: Props) {
  const data = useMemo(() => {
    const filtered = rows.filter((r) => r.kind === kind && r.total_cents > 0);
    const sorted = [...filtered].sort((a, b) => b.total_cents - a.total_cents);

    // 超过 MAX_ROWS 的把尾部合并成「其他」，避免图过高
    if (sorted.length <= MAX_ROWS) {
      return sorted.map((r, i) => ({
        name: r.category_name ?? '未分类',
        cents: r.total_cents,
        count: r.txn_count,
        color: PALETTE[i % PALETTE.length],
      }));
    }

    const head = sorted.slice(0, MAX_ROWS - 1);
    const tail = sorted.slice(MAX_ROWS - 1);
    const restCents = tail.reduce((a, r) => a + r.total_cents, 0);
    const restCount = tail.reduce((a, r) => a + r.txn_count, 0);

    return [
      ...head.map((r, i) => ({
        name: r.category_name ?? '未分类',
        cents: r.total_cents,
        count: r.txn_count,
        color: PALETTE[i % PALETTE.length],
      })),
      {
        name: `其他 ${tail.length} 项`,
        cents: restCents,
        count: restCount,
        color: '#cbd5e1',
      },
    ];
  }, [rows, kind]);

  if (data.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-ink-500">
        {kind === 'expense' ? '本月还没有支出' : '本月还没有收入'}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {/* 顶部：总额 */}
      <div className="flex items-baseline justify-between">
        <div>
          <p className="text-xs text-ink-500">
            {kind === 'expense' ? '支出' : '收入'}合计
          </p>
          <p className="tabular text-xl font-semibold text-ink-900">
            ¥{formatYuanGrouped(totalCents)}
          </p>
        </div>
        <p className="text-xs text-ink-500">{data.length} 个分类</p>
      </div>

      {/* 条形图 */}
      <div style={{ height: data.length * 30 + 20 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 0, right: 56, bottom: 0, left: 0 }}
            barCategoryGap={4}
          >
            <XAxis type="number" hide domain={[0, 'dataMax']} />
            <YAxis
              type="category"
              dataKey="name"
              width={64}
              tick={{ fontSize: 11, fill: '#64748b' }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              formatter={(v: number) => [`¥${formatYuanGrouped(v)}`, '金额']}
              labelFormatter={(label: string) => label}
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
            />
            <Bar dataKey="cents" radius={[0, 4, 4, 0]} isAnimationActive={false}>
              {data.map((d) => (
                <Cell key={d.name} fill={d.color} />
              ))}
              <LabelList
                dataKey="cents"
                position="right"
                fontSize={11}
                fill="#334155"
                formatter={(v: number) =>
                  totalCents > 0 ? `${((v / totalCents) * 100).toFixed(0)}%` : ''
                }
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* 明细列表：图上看不清精确金额，这里补上 */}
      <ul className="divide-y divide-ink-100">
        {data.map((d) => (
          <li key={d.name} className="flex items-center justify-between py-1.5">
            <span className="flex min-w-0 items-center gap-2">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: d.color }}
              />
              <span className="truncate text-xs text-ink-700">{d.name}</span>
              <span className="shrink-0 text-[10px] text-ink-500">{d.count} 笔</span>
            </span>
            <span className="tabular shrink-0 pl-3 text-xs font-medium text-ink-900">
              ¥{formatYuanGrouped(d.cents)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
