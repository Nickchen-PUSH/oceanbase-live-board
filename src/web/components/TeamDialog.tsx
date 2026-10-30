import { useEffect, useMemo, useRef } from 'react';
import { fmtDur, fmtScore, fmtTime, fmtWhen, toMs } from '../../shared/format.ts';
import { nextTier } from '../../shared/insights.ts';
import { predict } from '../../shared/predict.ts';
import type { Snapshot } from '../../shared/types.ts';
import { useNow } from '../lib/hooks.ts';
import { toggleStar, useStars } from '../lib/stars.ts';
import { findTeam } from '../lib/team.ts';
import { cx, Pill, RankBadge, StarButton } from './ui.tsx';

/** 队伍详情：原生 <dialog>（Esc 关闭、焦点陷阱、背景遮罩都由浏览器提供） */
export function TeamDialog({ snap, teamKey, onClose }: { snap: Snapshot; teamKey: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const now = useNow(60_000);
  const { isStarred } = useStars();
  const team = useMemo(() => findTeam(snap, teamKey), [snap, teamKey]);
  const totalBoard = snap.boards.find((b) => b.kind === 'total');

  useEffect(() => {
    const d = ref.current;
    // 不在 cleanup 里 close()：那会触发 close 事件 → onClose，StrictMode 的二次挂载会把弹窗立刻关掉。
    // 元素卸载时浏览器自然移除顶层弹窗。
    if (d && !d.open) d.showModal();
  }, []);

  const tracks = useMemo(
    () =>
      team.tracks
        .filter((x) => x.board.rows.length)
        .map((x) => {
          const full = !!x.row && x.full > 0 && (x.row.score ?? 0) >= x.full - 1e-6;
          // 没满分的赛道：此刻提交大约什么时候出分
          const eta = full ? null : predict(x.board.rows, now, now);
          const a = toMs(x.row?.bestSubmit);
          const b = toMs(x.row?.updated);
          return { ...x, isFull: full, eta, turn: a != null && b != null && b > a ? (b - a) / 1000 : null };
        })
        .sort((p, q) => Number(p.isFull) - Number(q.isFull) || (q.row ? 1 : 0) - (p.row ? 1 : 0)),
    [team, now],
  );

  const info = team.any;
  const total = team.total;
  const tier = total && totalBoard ? nextTier(total, totalBoard.rows) : null;
  const fullN = tracks.filter((t) => t.isFull).length;
  const sumTracks = tracks.reduce((s, t) => s + (t.row?.score ?? 0), 0);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current?.close()}
      className="m-auto w-[min(860px,calc(100vw-1.5rem))] max-h-[min(92dvh,900px)] rounded-xl border border-slate-200 bg-white p-0 text-slate-800 shadow-2xl backdrop:bg-slate-900/40 backdrop:backdrop-blur-[2px] dark:border-slate-700 dark:bg-[#0f141d] dark:text-slate-100"
      aria-label={info ? `${info.name} 详情` : '队伍详情'}
    >
      {!info ? (
        <div className="p-8 text-center text-slate-500">
          在当前数据里找不到这支队伍
          <div className="mt-4">
            <button type="button" className="btn" onClick={() => ref.current?.close()}>
              关闭
            </button>
          </div>
        </div>
      ) : (
        <div className="flex max-h-[inherit] flex-col">
          <header className="flex items-start gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-lg font-semibold">{info.name}</h2>
                <StarButton on={isStarred(info)} onClick={() => toggleStar(info)} label={info.name} />
              </div>
              <div className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                {[info.school, info.province, info.advisor && `导师 ${info.advisor}`].filter(Boolean).join(' · ') || '—'}
              </div>
            </div>
            <button type="button" autoFocus className="btn px-2" onClick={() => ref.current?.close()} aria-label="关闭">
              ✕
            </button>
          </header>

          <div className="overflow-y-auto px-5 py-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Box label="总榜名次" value={total ? (total.rank <= 3 ? <RankBadge rank={total.rank} /> : `第 ${total.rank} 名`) : '未上总榜'} />
              <Box label="总分" value={fmtScore(total?.score)} sub={Math.abs(sumTracks - (total?.score ?? 0)) > 1e-3 && total ? `赛道合计 ${fmtScore(sumTracks)}` : '= 各赛道之和'} />
              <Box label="满分赛道" value={`${fullN} / ${tracks.length}`} />
              <Box
                label="下一档"
                value={tier ? `差 ${fmtScore(tier.gap)}` : total?.rank === 1 ? '已并列第 1' : '—'}
                sub={tier ? `追平第 ${tier.targetRank} 名 ${fmtScore(tier.targetScore)}` : undefined}
              />
            </div>

            <h3 className="card-title mt-5 mb-2">各赛道成绩</h3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800">
                    <th className="py-2 font-medium">赛道</th>
                    <th className="py-2 font-medium">名次</th>
                    <th className="py-2 text-right font-medium">成绩 / 满分</th>
                    <th className="py-2 text-right font-medium">最优提交 → 出分</th>
                    <th className="py-2 pl-4 font-medium">现在提交预计出分</th>
                  </tr>
                </thead>
                <tbody>
                  {tracks.map((t) => (
                    <tr key={t.board.id} className="border-b border-slate-100 dark:border-slate-800/70">
                      <td className="max-w-[13rem] truncate py-2 pr-2" title={t.board.title}>
                        {t.board.title}
                      </td>
                      <td className="py-2">{t.row ? <RankBadge rank={t.row.rank} /> : <span className="text-slate-400">—</span>}</td>
                      <td className="py-2 text-right">
                        {t.row ? (
                          <span className={cx('num font-medium', t.isFull ? 'text-emerald-600 dark:text-emerald-400' : (t.row.score ?? 0) > 0 ? '' : 'text-rose-500')}>
                            {fmtScore(t.row.score)}
                          </span>
                        ) : (
                          <Pill>无记录</Pill>
                        )}
                        <span className="num text-xs text-slate-400"> / {fmtScore(t.full)}</span>
                      </td>
                      <td className="num py-2 text-right text-xs text-slate-500">
                        {t.row ? (
                          <>
                            {fmtTime(t.row.bestSubmit)}
                            {t.turn != null && <div>耗时 {fmtDur(t.turn)}</div>}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2 pl-4 text-xs">
                        {t.isFull ? (
                          <Pill tone="green">已满分</Pill>
                        ) : t.eta && t.eta.etaMs ? (
                          <span title={t.eta.notes.join('\n')}>
                            <span className={cx('font-medium', t.eta.kind === 'stalled' && 'text-amber-600')}>
                              {t.eta.kind === 'stalled' ? '评测疑似停摆' : fmtWhen(t.eta.etaMs, now)}
                            </span>
                            {t.eta.lowMs != null && t.eta.highMs != null && t.eta.kind !== 'stalled' && (
                              <span className="block text-slate-400">
                                {fmtWhen(t.eta.lowMs, now)} ~ {fmtWhen(t.eta.highMs, now)}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-slate-400">样本不足</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-slate-400">
              按队伍 ID（groupId）跨榜关联，不靠队名匹配。「现在提交预计出分」基于该赛道近期排队节奏，80% 区间；详细推算见该赛道的「出分耗时与预测」页。
            </p>
          </div>
        </div>
      )}
    </dialog>
  );
}

function Box({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2.5 dark:bg-slate-800/50">
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className="num mt-0.5 text-lg font-semibold">{value}</div>
      {sub && <div className="truncate text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}
