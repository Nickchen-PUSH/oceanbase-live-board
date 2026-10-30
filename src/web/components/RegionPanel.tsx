import { useMemo, useState } from 'react';
import { fmtScore } from '../../shared/format.ts';
import { schoolStats } from '../../shared/insights.ts';
import { NO_PROVINCE, provinceLabel, provinceShort, type ProvinceStat } from '../../shared/province.ts';
import type { Board, Row } from '../../shared/types.ts';
import { cx } from './ui.tsx';

export function RegionPanel({
  board,
  rows,
  provinces,
  province,
  onProvince,
  onSchool,
}: {
  board: Board;
  rows: Row[];
  provinces: ProvinceStat[];
  province: string;
  onProvince: (p: string) => void;
  onSchool: (school: string) => void;
}) {
  const [sortBy, setSortBy] = useState<'teams' | 'best' | 'avg'>('teams');
  const [allSchools, setAllSchools] = useState(false);
  const schools = useMemo(() => schoolStats(rows), [rows]);
  const maxTeams = Math.max(1, ...provinces.map((p) => p.teams));
  const sorted = useMemo(() => {
    const list = [...provinces];
    if (sortBy === 'best') list.sort((a, b) => (a.bestRank ?? 1e9) - (b.bestRank ?? 1e9));
    if (sortBy === 'avg') list.sort((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1));
    return list;
  }, [provinces, sortBy]);
  const maxSchool = Math.max(1, ...schools.map((s) => s.teams));
  const shownSchools = allSchools ? schools : schools.slice(0, 20);

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="card-title">各省份 · {board.kind === 'total' ? '总榜' : board.title}</h3>
          <div className="flex gap-1 text-xs">
            {(
              [
                ['teams', '队伍数'],
                ['best', '最好名次'],
                ['avg', '平均分'],
              ] as const
            ).map(([k, l]) => (
              <button key={k} type="button" className="chip px-2 py-0.5 text-xs" aria-pressed={sortBy === k} onClick={() => setSortBy(k)}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="w-[5.5rem] py-1.5 font-medium">省份</th>
              <th className="py-1.5 font-medium">队伍</th>
              <th className="w-14 py-1.5 text-right font-medium" title="全榜前 10 名中的队伍数">前10</th>
              <th className="w-16 py-1.5 text-right font-medium">最好</th>
              <th className="w-20 py-1.5 text-right font-medium">平均分</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => {
              const key = p.province || NO_PROVINCE;
              const on = province === key;
              return (
                <tr
                  key={key}
                  onClick={() => onProvince(on ? '' : key)}
                  className={cx(
                    'cursor-pointer border-t border-slate-100 hover:bg-brand-50/60 dark:border-slate-800 dark:hover:bg-brand-500/10',
                    on && 'bg-brand-50 dark:bg-brand-500/15',
                  )}
                  title={p.leader ? `${provinceLabel(key)} 最好：${p.leader}` : undefined}
                >
                  <td className={cx('py-1.5', !p.province && 'text-slate-400', on && 'font-semibold text-brand-700 dark:text-brand-300')}>
                    {p.province ? provinceShort(p.province) : '未填'}
                  </td>
                  <td className="py-1.5 pr-3">
                    <div className="flex items-center gap-2">
                      <div className="h-2 flex-1 rounded-full bg-slate-100 dark:bg-slate-800">
                        <div className="h-2 rounded-full bg-brand-400" style={{ width: `${(p.teams / maxTeams) * 100}%` }} />
                      </div>
                      <span className="num w-8 text-right text-xs">{p.teams}</span>
                    </div>
                  </td>
                  <td className="num py-1.5 text-right">{p.top10 || <span className="text-slate-300">0</span>}</td>
                  <td className="num py-1.5 text-right">{p.bestRank ?? '—'}</td>
                  <td className="num py-1.5 text-right">{fmtScore(p.avgScore, 1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-slate-400">点击省份即筛选整个页面；再点一次取消。</p>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="card-title">
            学校{province ? ` · ${provinceLabel(province)}` : ''}（{schools.filter((s) => s.school).length} 所）
          </h3>
        </div>
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="py-1.5 font-medium">学校</th>
              <th className="w-28 py-1.5 font-medium">队伍</th>
              <th className="w-14 py-1.5 text-right font-medium">最好</th>
              <th className="w-20 py-1.5 text-right font-medium">平均分</th>
            </tr>
          </thead>
          <tbody>
            {shownSchools.map((s) => (
              <tr
                key={s.school || '__none'}
                onClick={() => s.school && onSchool(s.school)}
                className={cx('border-t border-slate-100 dark:border-slate-800', s.school && 'cursor-pointer hover:bg-brand-50/60 dark:hover:bg-brand-500/10')}
                title={s.school ? `${s.school}：最好 ${s.leader ?? '—'}${s.provinces.length ? `；${s.provinces.join('、')}` : ''}（点击在排行榜中只看该校）` : undefined}
              >
                <td className={cx('truncate py-1.5 pr-2', !s.school && 'text-slate-400')}>
                  {s.school || '未填学校'}
                  {s.top10 > 0 && <span className="badge ml-1.5 bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">前10×{s.top10}</span>}
                </td>
                <td className="py-1.5 pr-3">
                  <div className="flex items-center gap-2">
                    <div className="h-2 flex-1 rounded-full bg-slate-100 dark:bg-slate-800">
                      <div className="h-2 rounded-full bg-emerald-400" style={{ width: `${(s.teams / maxSchool) * 100}%` }} />
                    </div>
                    <span className="num w-7 text-right text-xs">{s.teams}</span>
                  </div>
                </td>
                <td className="num py-1.5 text-right">{s.bestRank ?? '—'}</td>
                <td className="num py-1.5 text-right">{fmtScore(s.avgScore, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {schools.length > 20 && (
          <button type="button" className="btn mt-2 w-full justify-center" onClick={() => setAllSchools((v) => !v)}>
            {allSchools ? '收起' : `展开全部 ${schools.length} 所`}
          </button>
        )}
        <p className="mt-2 text-xs text-slate-400">点击学校会在排行榜里搜索该校。</p>
      </section>
    </div>
  );
}
