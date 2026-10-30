import { useMemo, useState } from 'react';
import { fmtHM, fmtScore, timeAgo } from '../../shared/format.ts';
import { recentScores, type Change } from '../../shared/insights.ts';
import { filterByProvince, provinceShort } from '../../shared/province.ts';
import type { Board, Snapshot } from '../../shared/types.ts';
import { useNow } from '../lib/hooks.ts';
import { changesStore } from '../lib/live.tsx';
import { useStars } from '../lib/stars.ts';
import { useStore } from '../lib/store.ts';
import { cx, ScoreDelta } from './ui.tsx';

const WINDOWS = [
  [1, '1 小时'],
  [6, '6 小时'],
  [24, '24 小时'],
] as const;

/**
 * 实时动态：各赛道最近出分 / 提分（按出分时刻）。
 * 页面开着期间观察到的变化（changesStore）会补上「涨了多少分、名次从多少到多少」。
 */
export function FeedPanel({
  snap,
  board,
  province,
  onOpen,
}: {
  snap: Snapshot;
  board: Board;
  province: string;
  onOpen: (key: string) => void;
}) {
  const now = useNow(30_000);
  const changes = useStore(changesStore);
  const { stars } = useStars();
  const [hours, setHours] = useState<number>(6);
  const [scope, setScope] = useState<'all' | 'board' | 'star'>('all');

  const items = useMemo(() => {
    const byKey = new Map<string, Change>();
    for (const c of changes) {
      if (c.kind === 'rank') continue;
      const k = `${c.boardId}|${c.key}`;
      if (!byKey.has(k)) byKey.set(k, c);
    }
    const starKeys = new Set(stars.map((s) => s.key));
    let list = recentScores(snap, now - hours * 3600_000, 400);
    if (scope === 'board' && board.kind === 'track') list = list.filter((x) => x.boardId === board.id);
    if (scope === 'star') list = list.filter((x) => starKeys.has(x.key));
    if (province) list = filterByProvince(list, province);
    return list.slice(0, 80).map((x) => {
      const c = byKey.get(`${x.boardId}|${x.key}`);
      // 只有当这条变化对应同一次出分时才拿它的增量
      const match = c && Math.abs(c.at - x.at) < 1000 ? c : undefined;
      return { ...x, change: match, starred: starKeys.has(x.key) };
    });
  }, [snap, changes, stars, hours, scope, board, province, now]);

  const short = (title: string) => title.replace(/^.*?·\s*/, '').slice(0, 14);

  return (
    <section className="card p-4">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h2 className="card-title flex items-center gap-1.5">
          <span className="pulse-dot size-2 rounded-full bg-emerald-500" />
          实时动态
        </h2>
        <select className="input py-0.5 text-xs" value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="时间范围">
          {WINDOWS.map(([h, l]) => (
            <option key={h} value={h}>
              近 {l}
            </option>
          ))}
        </select>
      </header>
      <div className="mb-2 flex gap-1">
        {(
          [
            ['all', '全部赛道'],
            ['board', '当前赛道'],
            ['star', '★ 关注'],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            className="chip px-2 py-0.5 text-[11px]"
            aria-pressed={scope === k}
            disabled={k === 'board' && board.kind !== 'track'}
            onClick={() => setScope(k)}
          >
            {l}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">这段时间没有新的出分{province ? '（当前省份）' : ''}</p>
      ) : (
        <ol className="max-h-[540px] space-y-0.5 overflow-y-auto pr-1">
          {items.map((x) => (
            <li key={`${x.boardId}|${x.key}|${x.at}`}>
              <button
                type="button"
                onClick={() => onOpen(x.key)}
                className={cx(
                  'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60',
                  x.starred && 'bg-amber-50/70 dark:bg-amber-400/10',
                )}
              >
                <span className="num mt-0.5 w-10 shrink-0 text-[11px] text-slate-400" title={timeAgo(x.at, now)}>
                  {fmtHM(x.at)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1">
                    {x.starred && <span className="text-amber-500">★</span>}
                    <span className="truncate text-[13px] font-medium">{x.name}</span>
                    {x.province && <span className="shrink-0 text-[11px] text-slate-400">{provinceShort(x.province)}</span>}
                  </span>
                  <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400">
                    {short(x.boardTitle)} · 第 {x.rank} 名
                    {x.change?.prevRank != null && x.change.prevRank !== x.rank && (
                      <span className="text-emerald-600 dark:text-emerald-400">（↑ 自 {x.change.prevRank}）</span>
                    )}
                    {x.change?.isNew && <span className="text-brand-600"> · 首次上榜</span>}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  <span className="num text-[13px] font-semibold">{fmtScore(x.score)}</span>
                  {x.change?.prevScore != null && <ScoreDelta d={(x.score ?? 0) - x.change.prevScore} />}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
        按出分时刻倒序；分数增量与名次变化是页面打开期间实时比对得出的。榜单只记录每队最好成绩，没提分的提交不会出现。
      </p>
    </section>
  );
}
