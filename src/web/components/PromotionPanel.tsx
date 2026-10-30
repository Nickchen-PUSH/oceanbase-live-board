// 晋级形势（移植自 PR #1，作者 @Nickchen-PUSH）：名额只按满分计
import { useMemo, useState } from 'react';
import { fmtClock, fmtScore, fmtTime } from '../../shared/format.ts';
import { rowKey } from '../../shared/insights.ts';
import { filterByProvince, provinceLabel } from '../../shared/province.ts';
import { promotionModel, type PromoEntry, type PromoGroup } from '../../shared/promotion.ts';
import type { Snapshot } from '../../shared/types.ts';
import { createStore, useStore } from '../lib/store.ts';
import { cx, Empty, Pill } from './ui.tsx';

const quotaStore = createStore<number>(50, 'ob-board:promo-quota');

const STATUS = [
  ['partial', '有部分分', '还要交一版更好的', 'bg-brand-500/70', 'brand'],
  ['zero', '已判 0 分', '要重交，重新排队', 'bg-rose-500/70', 'red'],
  ['none', '无记录', '没交，或还在排队', 'bg-slate-300 dark:bg-slate-600', 'slate'],
] as const;

export function PromotionPanel({ snap, province, onOpen }: { snap: Snapshot; province: string; onOpen: (key: string) => void }) {
  const quota = useStore(quotaStore);
  const [open, setOpen] = useState<string | null>(null);
  const model = useMemo(() => promotionModel(snap), [snap]);

  // 省份筛选只影响名单与计数，不影响名额口径（名额是全国的）
  const groups = useMemo(() => {
    if (!model) return [];
    if (!province) return model.groups;
    const f = (xs: PromoEntry[]) => xs.filter((x) => filterByProvince([x.total], province).length > 0);
    return model.groups
      .map((g) => {
        const partial = f(g.partial);
        const zero = f(g.zero);
        const none = f(g.none);
        return { ...g, partial, zero, none, count: partial.length + zero.length + none.length };
      })
      .filter((g) => g.count > 0);
  }, [model, province]);

  if (!model) return <Empty>总榜或赛道榜还没有数据，暂时算不出来</Empty>;
  // 有赛道完全没有已出分记录时，满分只能按剩下的赛道推，名额和分组都会算错，先不给数字（PR #1 6805e82）
  if (model.missing.length)
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
        {model.missing.join('、')} 还没有已出分记录（通常是上游暂时抓不到），满分口径算不准，晋级名额和分组先不显示。
      </div>
    );

  const left = quota - model.fullCount;
  const maxCount = Math.max(1, ...groups.map((g) => g.count));
  const shownShort = groups.reduce((s, g) => s + g.count, 0);
  const total = snap.boards.find((b) => b.kind === 'total');
  const provFull = province && total ? filterByProvince(total.rows, province).filter((r) => (r.score ?? 0) >= model.fullTotal - 1e-6).length : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <div className={cx('text-xs', left > 0 ? 'text-slate-500' : 'text-rose-500')}>{left > 0 ? '剩余名额' : '名额已满'}</div>
          <div className={cx('num text-4xl font-bold tracking-tight', left > 0 ? 'text-brand-600 dark:text-brand-300' : 'text-rose-500')}>
            {Math.max(0, left)}
          </div>
        </div>
        <div className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          前 {quota} 名 − 总分满分（{fmtScore(model.fullTotal)} 分）<b className="num">{model.fullCount}</b> 队
          {provFull != null && <span className="text-slate-400">（其中 {provinceLabel(province)} {provFull} 队）</span>}
          <br />
          {left > 0 ? (
            <>
              只差一个赛道就满分的 <b className="num">{model.oneShort}</b> 队在抢
              {province && <span className="text-slate-400">（{provinceLabel(province)} {shownShort} 队）</span>}
            </>
          ) : (
            '之后再满分的队伍只能排在后面'
          )}
        </div>
        <label className="ml-auto flex items-center gap-2 text-xs text-slate-500">
          晋级名额
          <input
            type="number"
            className="input w-20 py-1"
            min={1}
            max={9999}
            value={quota}
            onChange={(e) => {
              const v = Math.round(Number(e.target.value));
              if (v >= 1 && v <= 9999) quotaStore.set(v);
            }}
          />
        </label>
      </div>

      {model.mismatch && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          总榜最高分 {fmtScore(model.topTotal)} 和各赛道最高分之和 {fmtScore(model.fullTotal)} 不一致：可能有赛道还没人拿到满分，或总榜尚未同步，满分口径会偏低。
        </p>
      )}

      {groups.length === 0 ? (
        <Empty>目前没有只差一个赛道的队伍{province ? `（${provinceLabel(province)}）` : ''}</Empty>
      ) : (
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {groups.map((g) => (
            <GroupRow key={g.boardId} g={g} maxCount={maxCount} open={open === g.boardId} onToggle={() => setOpen(open === g.boardId ? null : g.boardId)} onOpen={onOpen} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        {STATUS.map(([k, name, tip, color]) => (
          <span key={k} className="flex items-center gap-1.5">
            <i className={cx('inline-block size-2.5 rounded-sm', color)} />
            {name}：{tip}
          </span>
        ))}
      </div>
      <p className="text-xs leading-relaxed text-slate-400">
        名额只按满分计：只有总分满分的队伍才稳占晋级名额。各赛道满分取该赛道当前最高分。「已评到」= 该赛道已出分记录里最晚的提交时间，排队中的提交公开接口看不到。
        总榜与赛道按队伍 ID 关联。名次相同时按平台规则排序，这里不做推测。原始想法来自 PR #1（@Nickchen-PUSH）。
      </p>
    </div>
  );
}

function GroupRow({
  g,
  maxCount,
  open,
  onToggle,
  onOpen,
}: {
  g: PromoGroup;
  maxCount: number;
  open: boolean;
  onToggle: () => void;
  onOpen: (key: string) => void;
}) {
  const items = STATUS.flatMap(([k, name, , , tone]) => g[k].map((x) => ({ ...x, name, tone })));
  items.sort((a, b) => a.total.rank - b.total.rank);
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="grid w-full grid-cols-[minmax(0,12rem)_1fr_4rem] sm:grid-cols-[minmax(0,12rem)_1fr_17rem] items-center gap-3 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40"
      >
        <span className="truncate text-sm" title={g.title}>
          <span className="text-slate-400">{open ? '▾' : '▸'} 只差 </span>
          {g.title}
        </span>
        <span className="flex h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          {STATUS.map(([k, , , color]) =>
            g[k].length ? <span key={k} className={color} style={{ width: `${(g[k].length / maxCount) * 100}%` }} /> : null,
          )}
        </span>
        <span className="text-right text-xs">
          <b className="num text-sm">{g.count} 队</b>
          <span className="ml-2 hidden text-slate-500 sm:inline">
            {STATUS.filter(([k]) => g[k].length)
              .map(([k, name]) => `${name} ${g[k].length}`)
              .join(' · ')}
          </span>
        </span>
      </button>
      {open && (
        <div className="mb-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <p className="mb-2 text-xs text-slate-500">
            {g.title} 已评到 <b>{g.frontier ? fmtClock(g.frontier) : '—'}</b> 的提交 · 满分 {fmtScore(g.full)}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="py-1 font-medium">总榜</th>
                  <th className="py-1 font-medium">队伍</th>
                  <th className="py-1 font-medium">学校</th>
                  <th className="py-1 text-right font-medium">总分</th>
                  <th className="py-1 pl-3 font-medium">该赛道</th>
                  <th className="py-1 font-medium">该赛道最优提交</th>
                </tr>
              </thead>
              <tbody>
                {items.map((x) => (
                  <tr
                    key={rowKey(x.total)}
                    className="cursor-pointer border-t border-slate-100 hover:bg-brand-50/60 dark:border-slate-800 dark:hover:bg-brand-500/10"
                    onClick={() => onOpen(rowKey(x.total))}
                  >
                    <td className="num py-1.5">{x.total.rank}</td>
                    <td className="max-w-[12rem] truncate py-1.5 font-medium">{x.total.name}</td>
                    <td className="max-w-[10rem] truncate py-1.5 text-slate-500">{x.total.school || '—'}</td>
                    <td className="num py-1.5 text-right">{fmtScore(x.total.score)}</td>
                    <td className="py-1.5 pl-3">
                      {x.track ? (
                        <span className="num">
                          {fmtScore(x.track.score)} <span className="text-slate-400">/ {fmtScore(g.full)}</span>
                        </span>
                      ) : (
                        <Pill tone={x.tone}>{x.name}</Pill>
                      )}
                    </td>
                    <td className="num py-1.5 text-xs text-slate-500">{x.track ? fmtTime(x.track.bestSubmit) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
