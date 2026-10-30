import { useMemo, useState } from 'react';
import { fmtInt, fmtScore, fmtScoreShort } from '../../shared/format.ts';
import { cutoffs, nextTier, rowKey, scoreHistogram, type HistogramBin } from '../../shared/insights.ts';
import { provinceLabel } from '../../shared/province.ts';
import type { Board, Row } from '../../shared/types.ts';
import { useStars } from '../lib/stars.ts';
import { cx, Empty, RankBadge } from './ui.tsx';

const EPS = 1e-9;
const inBin = (b: HistogramBin, s: number, last: boolean) =>
  b.point ? Math.abs(s - b.lo) < 1e-6 : s >= b.lo - EPS && (s < b.hi - EPS || (last && s <= b.hi + EPS));

export function ScoreDist({
  board,
  rows,
  province,
  onOpen,
}: {
  board: Board;
  rows: Row[];
  province: string;
  onOpen: (key: string) => void;
}) {
  const { stars } = useStars();
  const [binN, setBinN] = useState(12);
  const [picked, setPicked] = useState<number | null>(null);
  const hist = useMemo(() => scoreHistogram(rows, binN), [rows, binN]);
  // 分数线永远按全榜算（晋级看的是全榜名次）
  const cuts = useMemo(() => cutoffs(board.rows, [1, 10, 50, 100, 200]), [board.rows]);
  const scored = rows.filter((r) => r.score != null);
  const starredRows = useMemo(() => {
    const keys = new Set(stars.map((s) => s.key));
    return board.rows.filter((r) => keys.has(rowKey(r)));
  }, [board.rows, stars]);

  if (!scored.length) return <Empty>暂无成绩</Empty>;

  // 每个箱的最后一个普通箱索引（含右端点）
  const lastNormal = hist.bins.reduce((acc, b, i) => (b.point ? acc : i), -1);
  const binOf = (s: number | null) => (s == null ? -1 : hist.bins.findIndex((b, i) => inBin(b, s, i === lastNormal)));
  const cutAt = new Map<number, number[]>();
  for (const c of cuts) {
    if (c.score == null || c.n === 1) continue;
    const i = binOf(c.score);
    if (i >= 0) cutAt.set(i, [...(cutAt.get(i) ?? []), c.n]);
  }
  const starAt = new Map<number, string[]>();
  for (const r of starredRows) {
    const i = binOf(r.score);
    if (i >= 0) starAt.set(i, [...(starAt.get(i) ?? []), r.name]);
  }
  const pickedBin = picked != null ? hist.bins[picked] : null;
  const pickedRows = pickedBin ? scored.filter((r) => inBin(pickedBin, r.score!, picked === lastNormal)) : [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-slate-600 dark:text-slate-300">
          {province ? provinceLabel(province) : board.title} · 有成绩 <b className="num">{scored.length}</b> 队 · 分数区间{' '}
          <span className="num">
            {fmtScore(hist.min)} ~ {fmtScore(hist.max)}
          </span>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-500">
          分箱
          <select className="input py-1" value={binN} onChange={(e) => setBinN(Number(e.target.value))}>
            {[6, 12, 20, 30].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* 直方图：原生 flex 柱子，点击查看该区间的队伍 */}
      <div>
        <div className="flex h-56 items-end gap-1 border-b border-slate-200 pt-8 dark:border-slate-700" role="list">
          {hist.bins.map((b, i) => {
            const h = hist.maxCount ? (b.count / hist.maxCount) * 100 : 0;
            const cs = cutAt.get(i);
            const st = starAt.get(i);
            return (
              <button
                key={i}
                type="button"
                role="listitem"
                onClick={() => setPicked(picked === i ? null : i)}
                className="group relative flex h-full min-w-0 flex-1 flex-col justify-end"
                title={`${b.point ? fmtScore(b.lo) : `${fmtScore(b.lo)} ~ ${fmtScore(b.hi)}`}：${b.count} 队`}
              >
                {cs && (
                  <span className="pointer-events-none absolute inset-x-0 top-0 bottom-0 border-l-2 border-dashed border-rose-400/70">
                    <span className="absolute -top-7 left-0 -translate-x-1/2 rounded bg-rose-500 px-1 text-[10px] whitespace-nowrap text-white">
                      前 {cs.join('/')}
                    </span>
                  </span>
                )}
                <span className="num mb-0.5 text-center text-[10px] text-slate-500">{b.count || ''}</span>
                <span
                  className={cx(
                    'w-full rounded-t transition-colors',
                    picked === i ? 'bg-brand-600' : b.point ? 'bg-brand-400 group-hover:bg-brand-500' : 'bg-brand-300 group-hover:bg-brand-500 dark:bg-brand-500/60',
                    st && 'ring-2 ring-amber-400',
                  )}
                  style={{ height: `${Math.max(b.count ? 2 : 0, h)}%` }}
                />
                {st && <span className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-xs text-amber-500" title={`关注：${st.join('、')}`}>★</span>}
              </button>
            );
          })}
        </div>
        <div className="mt-1 flex gap-1">
          {hist.bins.map((b, i) => (
            <span key={i} className="num min-w-0 flex-1 truncate text-center text-[10px] text-slate-400" title={fmtScore(b.lo)}>
              {b.point ? fmtScoreShort(b.lo) : i % Math.ceil(hist.bins.length / 8) === 0 ? fmtScoreShort(b.lo) : ''}
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-400">
          虚线 = 全榜前 N 名分数线；深色单独的柱 = 该分数扎堆（如满分）；★ = 你关注的队伍。点击柱子查看该区间的队伍。
        </p>
      </div>

      {pickedBin && (
        <div className="rounded-lg border border-brand-200 bg-brand-50/50 p-3 dark:border-brand-500/30 dark:bg-brand-500/5">
          <div className="mb-2 flex items-center justify-between text-sm">
            <b>
              {pickedBin.point ? `${fmtScore(pickedBin.lo)} 分` : `${fmtScore(pickedBin.lo)} ~ ${fmtScore(pickedBin.hi)}`} · {pickedRows.length} 队
            </b>
            <button type="button" className="text-xs text-slate-500 hover:text-slate-800" onClick={() => setPicked(null)}>
              收起 ✕
            </button>
          </div>
          <ul className="grid max-h-64 gap-1 overflow-y-auto sm:grid-cols-2">
            {pickedRows.map((r) => (
              <li key={rowKey(r)}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-white dark:hover:bg-slate-800"
                  onClick={() => onOpen(rowKey(r))}
                >
                  <RankBadge rank={r.rank} />
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  <span className="num text-xs text-slate-500">{fmtScore(r.score)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="card-title mb-2">全榜分数线</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="py-1 font-medium">档位</th>
                <th className="py-1 text-right font-medium">分数线</th>
                <th className="py-1 text-right font-medium">{province ? `${provinceLabel(province)}达线` : '达线队伍'}</th>
              </tr>
            </thead>
            <tbody>
              {cuts.map((c) => {
                const n = c.score == null ? null : scored.filter((r) => r.score! >= c.score! - 1e-9).length;
                return (
                  <tr key={c.n} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1.5">{c.n === 1 ? '第 1 名' : `前 ${c.n} 名`}</td>
                    <td className="num py-1.5 text-right font-medium">{fmtScore(c.score)}</td>
                    <td className="num py-1.5 text-right text-slate-500">{n == null ? '—' : fmtInt(n)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-slate-400">名次同分并列，追平分数线即进入该档。</p>
        </div>

        <div>
          <h3 className="card-title mb-2">关注队伍离下一档还差</h3>
          {starredRows.length ? (
            <ul className="space-y-1.5">
              {starredRows.map((r) => {
                const t = nextTier(r, board.rows);
                return (
                  <li key={rowKey(r)}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-left text-sm hover:border-brand-300 dark:border-slate-700"
                      onClick={() => onOpen(rowKey(r))}
                    >
                      <RankBadge rank={r.rank} />
                      <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
                      {t ? (
                        <span className="text-xs text-slate-500">
                          进前 {t.targetRank} 还差 <b className="num text-rose-500">{fmtScore(t.gap)}</b> 分
                        </span>
                      ) : (
                        <span className="text-xs text-emerald-600">已是第 1 档</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="rounded-md border border-dashed border-slate-200 p-4 text-sm text-slate-400 dark:border-slate-700">
              在排行榜里点 ☆ 关注队伍，这里会显示它进入下一档（前 100 / 50 / 10 / 3 / 1）还差多少分。
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
