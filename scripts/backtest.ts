// 离线回测：bun scripts/backtest.ts [--md]
//   ① 跨快照真·未来验证：只用 .cache/snapshot-1029.json 的信息，在其生成时刻 g1 预测，
//      与 .cache/snapshot-live.json 里真实出分比较。
//        A = g1 时已提交、尚未出分的作业；B = g1 之后才提交的作业（预测时刻仍是 g1）。
//   ② live 快照内滚动起点回测：最近 72h 内提交的每条样本 i，在 now = t_i + {0, 15 分钟, 1 小时, 4 小时}
//      （且 now < done_i）时，用 done ≤ now 的样本预测 done_i。
//      R = 全部；RN = 排除「作业等待期与评测暂停窗口重叠 ≥10 分钟」的（正常时段）。
// 指标：中位绝对误差、P80 绝对误差、80% 区间覆盖率、偏差（误差中位数，正 = 预测偏晚）。
// 消融：VARIANTS='{"k7":{"levelK":7},"noWC":{"workClock":false}}' bun scripts/backtest.ts
import type { Snapshot } from '../src/shared/types.ts';
import { countLE } from '../src/shared/stats.ts';
import {
  backtestTrack,
  type CoreOut,
  DEFAULT_CFG,
  type EngineCfg,
  predictCore,
  predictLegacy,
  prepare,
  type Prepared,
  summarize,
  type TrackAccuracy,
} from '../src/shared/predict.ts';
import { detectPauses, overlapMs } from '../src/shared/timing.ts';
import { fmtDur } from '../src/shared/format.ts';

const root = new URL('../.cache/', import.meta.url);
const s1: Snapshot = await Bun.file(new URL('snapshot-1029.json', root)).json();
const s2: Snapshot = await Bun.file(new URL('snapshot-live.json', root)).json();
const g1 = Date.parse(s1.generatedAt);
const g2 = Date.parse(s2.generatedAt);
const md = process.argv.includes('--md');

interface Method { name: string; run: (P: Prepared, cut: number, submit: number, now: number) => CoreOut }
const methods: Method[] = [
  { name: '旧', run: predictLegacy },
  { name: '新', run: (P, c, s, n) => predictCore(P, c, s, n) },
];
const variants: Record<string, Partial<EngineCfg>> = JSON.parse(process.env.VARIANTS || '{}');
for (const [name, v] of Object.entries(variants)) {
  const cfg = { ...DEFAULT_CFG, ...v };
  methods.push({ name, run: (P, c, s, n) => predictCore(P, c, s, n, cfg) });
}

type Case = { err: number; covered: boolean };
function evalCase(m: Method, P: Prepared, cut: number, t: number, now: number, actual: number): Case | null {
  const o = m.run(P, cut, t, now);
  if (o.etaMs == null) return null;
  return { err: o.etaMs - actual, covered: o.lowMs != null && o.highMs != null && actual >= o.lowMs && actual <= o.highMs };
}

const f = (s: number) => (Number.isFinite(s) ? fmtDur(Math.abs(s)).replace(' ', '') : '—');
const fs = (s: number) => (Number.isFinite(s) ? (s < 0 ? '−' : '+') + f(s) : '—');
const cell = (a: TrackAccuracy | null) =>
  a ? `${f(a.medianAbsErrSec)} / ${f(a.p80AbsErrSec)} / ${(a.coverage * 100).toFixed(0)}% / ${fs(a.biasSec)}` : '—';

const KEYS = ['A', 'B', 'R', 'RN'] as const;
type K = (typeof KEYS)[number];
const tracks = s2.boards.filter((b) => b.kind === 'track');
const tables: Record<K, string[][]> = { A: [], B: [], R: [], RN: [] };
const pooled: Record<K, Record<string, Case[]>> = { A: {}, B: {}, R: {}, RN: {} };

for (const b2 of tracks) {
  const b1 = s1.boards.find((b) => b.id === b2.id);
  const rowsOf: Record<K, string[]> = { A: [], B: [], R: [], RN: [] };
  const nOf: Record<K, number> = { A: 0, B: 0, R: 0, RN: 0 };
  for (const m of methods) {
    const sets: Record<K, Case[]> = { A: [], B: [], R: [], RN: [] };
    if (b1) {
      const P1 = prepare(b1.rows);
      const cut1 = countLE(P1.done, g1);
      for (const x of prepare(b2.rows).s) {
        if (x.done <= g1) continue;
        const r = evalCase(m, P1, cut1, x.t, g1, x.done);
        if (r) (x.t <= g1 ? sets.A : sets.B).push(r);
      }
    }
    const P = prepare(b2.rows);
    const pz = detectPauses(P.done);
    for (const x of P.s) {
      if (x.t < g2 - 72 * 3600e3) continue;
      for (const w of [0, 15 * 60e3, 3600e3, 4 * 3600e3]) {
        const now = x.t + w;
        if (x.done <= now) continue;
        const cut = countLE(P.done, now);
        if (cut < 10) continue;
        const r = evalCase(m, P, cut, x.t, now, x.done);
        if (!r) continue;
        sets.R.push(r);
        if (overlapMs(x.t, x.done, pz) < 10 * 60e3) sets.RN.push(r);
      }
    }
    for (const k of KEYS) {
      rowsOf[k].push(cell(summarize(sets[k])));
      nOf[k] = sets[k].length;
      (pooled[k][m.name] ??= []).push(...sets[k]);
    }
  }
  for (const k of KEYS) tables[k].push([b2.title, String(nOf[k]), ...rowsOf[k]]);
}

const titles: Record<K, string> = {
  A: `① 跨快照·A：1029 快照时刻（${s1.generatedAt}）已提交未出分的作业`,
  B: '① 跨快照·B：1029 快照之后才提交的作业（仍在 1029 时刻预测）',
  R: '② live 快照滚动起点（近 72h，起点 = 提交后 0/15m/1h/4h）·全部',
  RN: '② 滚动起点·正常时段（排除与评测暂停重叠 ≥10 分钟的作业）',
};
const head = ['赛道', 'n', ...methods.map((m) => `${m.name}：中位/P80/覆盖/偏差`)];
for (const k of KEYS) {
  console.log(`\n${md ? '### ' : '== '}${titles[k]}\n`);
  const rows = [...tables[k]];
  rows.push(['（合并）', String(pooled[k][methods[0].name]?.length ?? 0), ...methods.map((m) => cell(summarize(pooled[k][m.name] ?? [])))]);
  if (md) {
    console.log(`| ${head.join(' | ')} |`);
    console.log(`|${head.map(() => '---').join('|')}|`);
    for (const r of rows) console.log(`| ${r.join(' | ')} |`);
  } else {
    for (const r of [head, ...rows]) console.log(r.map((c, i) => (i === 0 ? c.slice(0, 12).padEnd(13) : i === 1 ? c.padStart(4) : c.padEnd(30))).join(' '));
  }
}

let worst = 0;
for (const b of tracks) {
  const t0 = performance.now();
  backtestTrack(b.rows, g2);
  worst = Math.max(worst, performance.now() - t0);
}
console.log(`\nbacktestTrack（近 24h）单赛道最慢 ${worst.toFixed(1)} ms`);
