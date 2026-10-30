import { useMemo } from 'react';
import { fmtInt, fmtScore, fmtTime, timeAgo, toMs } from '../../shared/format.ts';
import { cutoffs } from '../../shared/insights.ts';
import { provinceLabel } from '../../shared/province.ts';
import { median } from '../../shared/stats.ts';
import type { Board, Row, Snapshot } from '../../shared/types.ts';
import { useNow } from '../lib/hooks.ts';
import { Stat } from './ui.tsx';

/** 顶部 4 个关键指标：跟随省份筛选 */
export function Kpis({ board, rows, province }: { board: Board; rows: Row[]; province: string; snap: Snapshot }) {
  const now = useNow(30_000);
  const m = useMemo(() => {
    const scored = rows.filter((r) => r.score != null);
    const top = scored[0] ?? null;
    const full = board.rows.reduce((mx, r) => Math.max(mx, r.score ?? 0), 0);
    const fullN = full > 0 ? rows.filter((r) => (r.score ?? 0) >= full - 1e-6).length : 0;
    let lastDone: Row | null = null;
    let lastMs = -Infinity;
    let day = 0;
    for (const r of rows) {
      const t = toMs(r.updated);
      if (t == null) continue;
      if (t > lastMs) {
        lastMs = t;
        lastDone = r;
      }
      if (now - t < 24 * 3600_000) day++;
    }
    const cut = cutoffs(board.rows, [10, 50, 100]);
    return {
      scored: scored.length,
      top,
      med: scored.length ? median(scored.map((r) => r.score!)) : null,
      full,
      fullN,
      lastDone,
      lastMs: Number.isFinite(lastMs) ? lastMs : null,
      day,
      cut,
    };
  }, [rows, board.rows, now]);

  const scope = province ? provinceLabel(province) : board.kind === 'total' ? '全部队伍' : '全部提交队伍';
  const cut50 = m.cut.find((c) => c.n === 50)?.score;
  const cut10 = m.cut.find((c) => c.n === 10)?.score;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat
        label={province ? `${provinceLabel(province)} · 队伍数` : '队伍数'}
        value={fmtInt(rows.length)}
        sub={province ? `占全榜 ${((rows.length / Math.max(1, board.rows.length)) * 100).toFixed(1)}%（共 ${board.rows.length} 队）` : `${scope}，有成绩 ${m.scored}`}
        tone="brand"
      />
      <Stat
        label={province ? '省内最高分' : '最高分'}
        value={fmtScore(m.top?.score)}
        sub={m.top ? `${m.top.name} · 全榜第 ${m.top.rank}` : '—'}
      />
      <Stat
        label={m.full > 0 ? '满分队伍' : '中位分'}
        value={m.full > 0 ? fmtInt(m.fullN) : fmtScore(m.med)}
        sub={
          m.full > 0
            ? `满分 ${fmtScore(m.full)} · 中位分 ${fmtScore(m.med)}`
            : `前 10 线 ${fmtScore(cut10)} · 前 50 线 ${fmtScore(cut50)}`
        }
      />
      <Stat
        label="最近出分"
        value={m.lastMs ? timeAgo(m.lastMs, now) : '—'}
        sub={m.lastDone ? `${m.lastDone.name} · ${fmtTime(m.lastMs)}${m.day ? ` · 24h 内 ${m.day} 队` : ''}` : '暂无'}
      />
    </div>
  );
}
