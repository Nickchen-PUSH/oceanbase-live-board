import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { fmtDur, fmtScore, fmtTime, toMs } from '../../shared/format.ts';
import { rowKey } from '../../shared/insights.ts';
import { provinceShort } from '../../shared/province.ts';
import type { Board, Row } from '../../shared/types.ts';
import { useRecentChanges } from '../lib/changes.ts';
import { toggleStar, useStars } from '../lib/stars.ts';
import { localRanks } from '../pages/BoardPage.tsx';
import { cx, Empty, RankBadge, RankDelta, ScoreDelta, StarButton } from './ui.tsx';

const col = createColumnHelper<Row>();

/** 关键词高亮 */
function Hl({ text, words }: { text: string; words: string[] }) {
  if (!text) return <span className="text-slate-300 dark:text-slate-600">—</span>;
  if (!words.length) return <>{text}</>;
  const lower = text.toLowerCase();
  const marks: [number, number][] = [];
  for (const w of words) {
    let i = lower.indexOf(w);
    while (i >= 0) {
      marks.push([i, i + w.length]);
      i = lower.indexOf(w, i + w.length);
    }
  }
  if (!marks.length) return <>{text}</>;
  marks.sort((a, b) => a[0] - b[0]);
  const out: React.ReactNode[] = [];
  let pos = 0;
  for (const [s, e] of marks) {
    if (e <= pos) continue;
    const from = Math.max(s, pos);
    if (from > pos) out.push(text.slice(pos, from));
    out.push(
      <mark key={from} className="rounded-sm bg-amber-200/70 px-px text-inherit dark:bg-amber-400/30">
        {text.slice(from, e)}
      </mark>,
    );
    pos = e;
  }
  out.push(text.slice(pos));
  return <>{out}</>;
}

const turnaround = (r: Row) => {
  const a = toMs(r.bestSubmit);
  const b = toMs(r.updated);
  return a != null && b != null && b > a ? (b - a) / 1000 : null;
};

export function LeaderTable({
  board,
  rows,
  province,
  query,
  onOpen,
}: {
  board: Board;
  rows: Row[];
  province: string;
  query: string;
  onOpen: (key: string) => void;
}) {
  const { isStarred } = useStars();
  const changes = useRecentChanges(board.id);
  const [sorting, setSorting] = useState<SortingState>([]);
  const words = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const local = useMemo(() => (province ? localRanks(rows) : null), [rows, province]);
  const isTrack = board.kind === 'track';

  const columns = useMemo(
    () => [
      col.display({
        id: 'star',
        header: () => <span className="sr-only">关注</span>,
        cell: (c) => (
          <StarButton on={isStarred(c.row.original)} onClick={() => toggleStar(c.row.original)} label={c.row.original.name} />
        ),
        meta: { className: 'w-9 pl-2 pr-0' },
      }),
      col.accessor('rank', {
        header: '名次',
        sortUndefined: 'last',
        cell: (c) => {
          const r = c.row.original;
          const ch = changes.get(rowKey(r));
          return (
            <div className="flex items-center gap-1.5">
              <RankBadge rank={r.rank} />
              {ch && ch.prevRank != null && <RankDelta d={ch.prevRank - r.rank} />}
              {local && <span className="num text-[11px] text-slate-400">省内 {local.get(r)}</span>}
            </div>
          );
        },
        meta: { className: 'w-[4.25rem] sm:w-[7.5rem]' },
      }),
      col.accessor('name', {
        header: isTrack ? '队伍 / 选手' : '队伍',
        sortingFn: (a, b) => a.original.name.localeCompare(b.original.name, 'zh-CN'),
        cell: (c) => {
          const r = c.row.original;
          const ch = changes.get(rowKey(r));
          return (
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium text-slate-900 dark:text-slate-100">
                  <Hl text={r.name} words={words} />
                </span>
                {ch?.isNew && <span className="badge shrink-0 bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">新</span>}
              </div>
              <div className="truncate text-xs text-slate-500 md:hidden dark:text-slate-400">
                <Hl text={r.school} words={words} />
                {r.province && ` · ${provinceShort(r.province)}`}
              </div>
            </div>
          );
        },
      }),
      col.accessor('school', {
        header: '学校',
        sortingFn: (a, b) => a.original.school.localeCompare(b.original.school, 'zh-CN'),
        cell: (c) => (
          <span className="block truncate">
            <Hl text={c.getValue()} words={words} />
          </span>
        ),
        meta: { className: 'hidden md:table-cell max-w-[14rem]' },
      }),
      col.accessor('province', {
        header: '省份',
        sortingFn: (a, b) => a.original.province.localeCompare(b.original.province, 'zh-CN'),
        cell: (c) =>
          c.getValue() ? (
            <span title={c.getValue()}>{provinceShort(c.getValue())}</span>
          ) : (
            <span className="text-slate-300 dark:text-slate-600">—</span>
          ),
        meta: { className: 'hidden md:table-cell w-[5.5rem]' },
      }),
      col.accessor('advisor', {
        header: '导师',
        enableSorting: false,
        cell: (c) => (
          <span className="block truncate">
            <Hl text={c.getValue()} words={words} />
          </span>
        ),
        meta: { className: 'hidden xl:table-cell max-w-[8rem]' },
      }),
      col.accessor('score', {
        header: '成绩',
        sortUndefined: 'last',
        sortDescFirst: true,
        cell: (c) => {
          const r = c.row.original;
          const ch = changes.get(rowKey(r));
          return (
            <div className="flex items-center justify-end gap-1.5">
              {ch && ch.prevScore != null && <ScoreDelta d={(r.score ?? 0) - ch.prevScore} />}
              <span className="num font-semibold text-slate-900 dark:text-slate-100">{fmtScore(r.score)}</span>
            </div>
          );
        },
        meta: { className: 'text-right w-[6rem] sm:w-[9rem]' },
      }),
      col.accessor((r) => toMs(r.updated), {
        id: 'updated',
        header: isTrack ? '出分时间' : '更新时间',
        sortUndefined: 'last',
        sortDescFirst: true,
        cell: (c) => {
          const r = c.row.original;
          const t = turnaround(r);
          return (
            <div className="text-right leading-tight">
              <div className="num text-slate-700 dark:text-slate-300">{fmtTime(c.getValue())}</div>
              {isTrack && t != null && (
                <div className="num text-[11px] text-slate-400" title={`最优提交 ${fmtTime(r.bestSubmit)}，排队 + 评测共 ${fmtDur(t)}`}>
                  耗时 {fmtDur(t)}
                </div>
              )}
            </div>
          );
        },
        meta: { className: 'hidden sm:table-cell text-right w-[10.5rem]' },
      }),
    ],
    [changes, isStarred, local, words, isTrack],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (r, i) => `${rowKey(r)}:${i}`,
  });

  if (!rows.length) return <Empty>没有符合条件的队伍</Empty>;

  return (
    // 宽屏：overflow-x-clip 不会形成滚动容器，表头可以吸顶到页面 header 下方；窄屏横向滚动、表头不吸顶
    <div className="overflow-x-auto lg:overflow-x-clip">
      <table className="w-full table-fixed text-sm">
        <thead className="z-10 bg-white/95 backdrop-blur lg:sticky lg:top-14 dark:bg-[#0f141d]/95">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id} className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
              {hg.headers.map((h) => {
                const meta = h.column.columnDef.meta as { className?: string } | undefined;
                const sorted = h.column.getIsSorted();
                return (
                  <th key={h.id} className={cx('px-3 py-2.5 font-medium', meta?.className)} aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}>
                    {h.column.getCanSort() ? (
                      <button
                        type="button"
                        className={cx('inline-flex items-center gap-1 hover:text-slate-800 dark:hover:text-slate-200', sorted && 'text-brand-600 dark:text-brand-300')}
                        onClick={h.column.getToggleSortingHandler()}
                        title="点击排序"
                      >
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        <span className="text-[10px]">{sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '↕'}</span>
                      </button>
                    ) : (
                      flexRender(h.column.columnDef.header, h.getContext())
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => {
            const r = row.original;
            const key = rowKey(r);
            const ch = changes.get(key);
            const starred = isStarred(r);
            return (
              <tr
                key={row.id}
                onClick={() => onOpen(key)}
                className={cx(
                  'cv-row cursor-pointer border-b border-slate-100 transition-colors hover:bg-brand-50/60 dark:border-slate-800/70 dark:hover:bg-brand-500/10',
                  starred && 'bg-amber-50/70 dark:bg-amber-400/10',
                  ch && (ch.kind === 'up' || ch.kind === 'new') && 'flash',
                )}
              >
                {row.getVisibleCells().map((cell) => {
                  const meta = cell.column.columnDef.meta as { className?: string } | undefined;
                  return (
                    <td key={cell.id} className={cx('px-3 py-2 align-middle', meta?.className)}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="px-4 py-3 text-xs text-slate-400">
        点击任意一行查看该队在所有赛道的成绩。名次按成绩排序、同分并列；{province ? '「省内」为筛选后的名次；' : ''}
        {board.kind === 'track' ? '耗时 = 最优那次提交从提交到出分的时间。' : '总分 = 各赛道最好成绩之和。'}
      </p>
    </div>
  );
}
