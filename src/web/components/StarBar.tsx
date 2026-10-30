import { useMemo } from 'react';
import { fmtScore } from '../../shared/format.ts';
import type { Snapshot } from '../../shared/types.ts';
import { useRecentChanges } from '../lib/changes.ts';
import { unstar, useStars } from '../lib/stars.ts';
import { findTeam } from '../lib/team.ts';
import { RankDelta } from './ui.tsx';

/** 关注的队伍：总榜名次 + 各赛道名次一览 */
export function StarBar({ snap, onOpen }: { snap: Snapshot; onOpen: (key: string) => void }) {
  const { stars } = useStars();
  const totalChanges = useRecentChanges('total');
  const teams = useMemo(() => stars.map((s) => ({ star: s, view: findTeam(snap, s.key) })), [stars, snap]);
  if (!teams.length) return null;

  return (
    <section className="card px-4 py-3" aria-label="我关注的队伍">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="card-title">★ 我关注的队伍</h2>
        <span className="text-xs text-slate-400">保存在本机浏览器</span>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {teams.map(({ star, view }) => {
          const t = view.total;
          const ch = totalChanges.get(star.key);
          const done = view.tracks.filter((x) => x.row && x.full > 0 && (x.row.score ?? 0) >= x.full - 1e-6).length;
          return (
            <div
              key={star.key}
              className="group relative w-[19rem] shrink-0 cursor-pointer rounded-lg border border-amber-200 bg-amber-50/50 p-3 hover:border-amber-300 dark:border-amber-400/30 dark:bg-amber-400/5"
              onClick={() => onOpen(star.key)}
            >
              <button
                type="button"
                className="absolute top-1.5 right-2 text-xs text-slate-400 opacity-0 group-hover:opacity-100 hover:text-rose-500"
                onClick={(e) => {
                  e.stopPropagation();
                  unstar(star.key);
                }}
                title="取消关注"
              >
                ✕
              </button>
              <div className="truncate pr-4 font-semibold">{view.any?.name ?? star.name}</div>
              <div className="truncate text-xs text-slate-500">{view.any?.school || '—'}</div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-xs text-slate-500">总榜</span>
                <span className="num text-xl font-bold">{t ? `#${t.rank}` : '—'}</span>
                {ch?.prevRank != null && <RankDelta d={ch.prevRank - (t?.rank ?? ch.prevRank)} />}
                <span className="num ml-auto text-sm font-medium">{fmtScore(t?.score)}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {view.tracks
                  .filter((x) => x.board.rows.length)
                  .map((x) => {
                    const full = x.row && x.full > 0 && (x.row.score ?? 0) >= x.full - 1e-6;
                    return (
                      <span
                        key={x.board.id}
                        title={`${x.board.title}：${x.row ? `第 ${x.row.rank} 名 · ${fmtScore(x.row.score)}${full ? '（满分）' : ''}` : '无记录'}`}
                        className={
                          'num rounded px-1 text-[10px] ' +
                          (!x.row
                            ? 'bg-slate-100 text-slate-400 dark:bg-slate-800'
                            : full
                              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'
                              : 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300')
                        }
                      >
                        {x.row ? x.row.rank : '—'}
                      </span>
                    );
                  })}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                满分赛道 {done}/{view.tracks.filter((x) => x.board.rows.length).length}（绿=满分，蓝=有分，灰=无记录；数字为赛道名次）
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
