import { useMemo, useState } from 'react';
import { fmtScore } from '../../shared/format.ts';
import { NO_PROVINCE, provinceShort, type ProvinceStat } from '../../shared/province.ts';
import { cx } from './ui.tsx';

/** 省份瓦片地图：每个省一个方块，按大致地理位置排布（[行, 列]） */
const TILES: Record<string, [number, number]> = {
  黑龙江: [0, 7],
  内蒙古: [1, 4], 北京: [1, 5], 辽宁: [1, 6], 吉林: [1, 7],
  新疆: [2, 0], 宁夏: [2, 3], 山西: [2, 4], 河北: [2, 5], 天津: [2, 6],
  西藏: [3, 0], 青海: [3, 1], 甘肃: [3, 2], 陕西: [3, 3], 河南: [3, 4], 山东: [3, 5],
  四川: [4, 2], 重庆: [4, 3], 湖北: [4, 4], 安徽: [4, 5], 江苏: [4, 6],
  云南: [5, 2], 贵州: [5, 3], 湖南: [5, 4], 江西: [5, 5], 浙江: [5, 6], 上海: [5, 7],
  广西: [6, 3], 广东: [6, 4], 福建: [6, 5], 台湾: [6, 7],
  海南: [7, 3], 澳门: [7, 4], 香港: [7, 5],
};
const S = 44;
const G = 4;
const COLS = 8;
const ROWS = 8;

type Mode = 'teams' | 'top' | 'avg';

export function ProvinceMap({
  stats,
  province,
  onPick,
}: {
  stats: ProvinceStat[];
  province: string;
  onPick: (p: string) => void;
}) {
  const [mode, setMode] = useState<Mode>('teams');
  const [hover, setHover] = useState<ProvinceStat | null>(null);
  const byShort = useMemo(() => new Map(stats.filter((s) => s.province).map((s) => [provinceShort(s.province), s])), [stats]);
  const missing = stats.find((s) => !s.province);
  const val = (s: ProvinceStat | undefined) =>
    !s ? 0 : mode === 'teams' ? s.teams : mode === 'top' ? (s.bestRank ? 1 / Math.sqrt(s.bestRank) : 0) : (s.avgScore ?? 0);
  const vals = [...byShort.values()].map(val).filter((v) => v > 0);
  const lo = mode === 'avg' ? Math.min(...vals) : 0;
  const hi = Math.max(...vals, 1e-9);
  const shade = (s: ProvinceStat | undefined) => {
    const v = val(s);
    if (!s || v <= 0) return 0;
    const x = hi > lo ? (v - lo) / (hi - lo) : 1;
    return mode === 'teams' ? Math.sqrt(x) : x;
  };
  // 未在瓦片表里的省份（数据异常时）也列出来，避免被漏掉
  const extra = [...byShort.keys()].filter((k) => !TILES[k]);
  const info = hover ?? (province && province !== NO_PROVINCE ? stats.find((s) => s.province === province) : null) ?? null;

  return (
    <section className="card p-4">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h2 className="card-title">省份分布</h2>
        <div className="flex gap-1">
          {(
            [
              ['teams', '队伍数'],
              ['top', '最好名次'],
              ['avg', '平均分'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} type="button" className="chip px-2 py-0.5 text-[11px]" aria-pressed={mode === k} onClick={() => setMode(k)}>
              {l}
            </button>
          ))}
        </div>
      </header>

      <svg viewBox={`0 0 ${COLS * (S + G)} ${ROWS * (S + G)}`} className="w-full select-none" role="group" aria-label="省份瓦片地图，点击筛选">
        {Object.entries(TILES).map(([name, [r, c]]) => {
          const s = byShort.get(name);
          const on = !!s && province === s.province;
          const k = shade(s);
          const x = c * (S + G);
          const y = r * (S + G);
          return (
            <g
              key={name}
              transform={`translate(${x},${y})`}
              className={cx(s ? 'cursor-pointer' : 'cursor-default')}
              onClick={() => s && onPick(s.province)}
              onMouseEnter={() => s && setHover(s)}
              onMouseLeave={() => setHover(null)}
              role={s ? 'button' : undefined}
              aria-label={s ? `${s.province} ${s.teams} 队` : `${name} 无队伍`}
              aria-pressed={s ? on : undefined}
              tabIndex={s ? 0 : -1}
              onKeyDown={(e) => {
                if (s && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  onPick(s.province);
                }
              }}
            >
              <rect
                width={S}
                height={S}
                rx={7}
                className={cx(!s && 'fill-slate-100 dark:fill-slate-800/60', on ? 'stroke-amber-500' : 'stroke-transparent')}
                strokeWidth={on ? 3 : 0}
                style={s ? { fill: `color-mix(in oklab, var(--color-brand-600) ${Math.round(12 + k * 88)}%, var(--tile-base))` } : undefined}
              />
              <text
                x={S / 2}
                y={s ? 19 : S / 2 + 4}
                textAnchor="middle"
                className={cx('text-[11px] font-medium', !s ? 'fill-slate-400 dark:fill-slate-600' : k > 0.45 ? 'fill-white' : 'fill-slate-700 dark:fill-slate-200')}
              >
                {name}
              </text>
              {s && (
                <text x={S / 2} y={34} textAnchor="middle" className={cx('num text-[11px]', k > 0.45 ? 'fill-white/90' : 'fill-slate-500 dark:fill-slate-300')}>
                  {mode === 'teams' ? s.teams : mode === 'top' ? `#${s.bestRank ?? '—'}` : fmtScore(s.avgScore, 0)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <div className="mt-2 min-h-[2.75rem] rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800/50 dark:text-slate-300">
        {info ? (
          <>
            <b className="text-slate-800 dark:text-slate-100">{info.province || '未填省份'}</b> · {info.teams} 队 · 最好第 {info.bestRank ?? '—'} 名
            {info.top10 ? ` · 前 10 有 ${info.top10} 队` : ''} · 平均 {fmtScore(info.avgScore, 1)}
            {info.leader && <div className="truncate text-slate-500">领跑：{info.leader}</div>}
          </>
        ) : (
          <span className="text-slate-400">悬停查看详情，点击省份筛选整个页面</span>
        )}
      </div>

      {(missing || extra.length > 0 || province) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {extra.map((k) => {
            const s = byShort.get(k)!;
            return (
              <button key={k} type="button" className="chip py-0.5 text-xs" aria-pressed={province === s.province} onClick={() => onPick(s.province)}>
                {k} {s.teams}
              </button>
            );
          })}
          {missing && (
            <button type="button" className="chip py-0.5 text-xs" aria-pressed={province === NO_PROVINCE} onClick={() => onPick(NO_PROVINCE)}>
              未填省份 {missing.teams}
            </button>
          )}
          {province && (
            <button type="button" className="chip py-0.5 text-xs" onClick={() => onPick('')}>
              全部省份 ✕
            </button>
          )}
        </div>
      )}
    </section>
  );
}
