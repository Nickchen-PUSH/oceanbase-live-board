import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { bj, fmtDur, fmtPct, fmtTime, fmtWhen, timeAgo, TZ_OFFSET_MS } from '../../shared/format.ts';
import { predict, type Prediction } from '../../shared/predict.ts';
import { agg, buildTimingModel, type Metric, type TimingModel } from '../../shared/timing.ts';
import type { Board } from '../../shared/types.ts';
import { hit } from '../lib/api.ts';
import { useNow } from '../lib/hooks.ts';
import { useLive } from '../lib/live.tsx';
import { cx, Empty, Pill } from './ui.tsx';

const p2 = (x: number) => String(x).padStart(2, '0');
/** <input type="datetime-local"> 的值按北京时间解释（不依赖浏览器时区） */
const toInput = (ts: number) => {
  const c = bj(ts);
  return `${c.y}-${p2(c.mo)}-${p2(c.d)}T${p2(c.h)}:${p2(c.mi)}`;
};
const fromInput = (v: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!) - TZ_OFFSET_MS;
};

const METRICS: [Metric, string][] = [
  ['median', '中位数'],
  ['avg', '平均'],
  ['p90', 'P90'],
];
const RANGES = [
  [6, '6 小时'],
  [24, '24 小时'],
  [72, '3 天'],
  [0, '全部'],
] as const;

const KIND_LABEL: Record<Prediction['kind'], [string, 'green' | 'brand' | 'amber' | 'red' | 'slate']> = {
  fast: ['快速评测', 'green'],
  queue: ['正常排队', 'brand'],
  batch: ['跨评测休息时段', 'amber'],
  overdue: ['已超时', 'amber'],
  stalled: ['疑似停摆', 'red'],
  none: ['样本不足', 'slate'],
};
const CONF_LABEL = { high: ['把握较高', 'green'], medium: ['把握一般', 'amber'], low: ['把握较低', 'red'] } as const;

export function TimingPanel({ board }: { board: Board }) {
  const now = useNow(30_000);
  const [metric, setMetric] = useState<Metric>('median');
  const [rangeH, setRangeH] = useState<number>(24);
  const [submitText, setSubmitText] = useState<string>('');
  const submitMs = (submitText && fromInput(submitText)) || now;

  const model = useMemo(() => buildTimingModel(board.rows, { now }), [board.rows, now]);
  const pred = useMemo(() => predict(board.rows, submitMs, Math.max(now, 0)), [board.rows, submitMs, now]);

  useEffect(() => {
    if (submitText) hit({ k: 'predict', t: board.id });
  }, [submitText, board.id]);

  if (model.insufficient && !model.pts.length) return <Empty>该赛道还没有足够的出分记录</Empty>;

  return (
    <div className="space-y-6">
      <PredictCard pred={pred} now={now} submitMs={submitMs} submitText={submitText} setSubmitText={setSubmitText} />
      <Overview model={model} pred={pred} now={now} />

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="card-title">提交 → 出分耗时（按提交时刻）</h3>
          <div className="flex flex-wrap gap-1">
            {RANGES.map(([h, l]) => (
              <button key={h} type="button" className="chip px-2 py-0.5 text-[11px]" aria-pressed={rangeH === h} onClick={() => setRangeH(h)}>
                {l}
              </button>
            ))}
            <span className="mx-1 w-px bg-slate-200 dark:bg-slate-700" />
            {METRICS.map(([m, l]) => (
              <button key={m} type="button" className="chip px-2 py-0.5 text-[11px]" aria-pressed={metric === m} onClick={() => setMetric(m)}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <TimingChart model={model} metric={metric} rangeH={rangeH} now={now} pred={pred} submitMs={submitMs} />
        <CleanupNote model={model} />
      </section>

      <TrackCompare current={board.id} metric={metric} now={now} />
    </div>
  );
}

function PredictCard({
  pred,
  now,
  submitMs,
  submitText,
  setSubmitText,
}: {
  pred: Prediction;
  now: number;
  submitMs: number;
  submitText: string;
  setSubmitText: (v: string) => void;
}) {
  const [kindLabel, kindTone] = KIND_LABEL[pred.kind];
  const [confLabel, confTone] = CONF_LABEL[pred.confidence];
  const acc = pred.accuracy;
  const waitSec = pred.etaMs != null ? Math.max(0, (pred.etaMs - Math.max(now, submitMs)) / 1000) : null;
  return (
    <section className="rounded-xl border border-brand-200 bg-gradient-to-br from-brand-50 to-white p-4 dark:border-brand-500/30 dark:from-brand-500/10 dark:to-transparent">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-brand-800 dark:text-brand-200">出分预测</h3>
        <Pill tone={kindTone}>{kindLabel}</Pill>
        {pred.kind !== 'none' && <Pill tone={confTone}>{confLabel}</Pill>}
        <label className="ml-auto flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
          我的提交时间（北京时间）
          <input
            type="datetime-local"
            className="input py-1 text-xs"
            value={submitText || toInput(now)}
            max={toInput(now + 86400_000)}
            onChange={(e) => setSubmitText(e.target.value)}
          />
          {submitText && (
            <button type="button" className="text-brand-600 hover:underline" onClick={() => setSubmitText('')}>
              现在
            </button>
          )}
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-x-8 gap-y-2">
        <div>
          <div className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">{pred.headline}</div>
          {pred.lowMs != null && pred.highMs != null && pred.kind !== 'stalled' && (
            <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              80% 区间 <b className="num">{fmtWhen(pred.lowMs, now)}</b> ~ <b className="num">{fmtWhen(pred.highMs, now)}</b>
              {waitSec != null && <span className="text-slate-400"> · 距现在约 {fmtDur(waitSec)}</span>}
            </div>
          )}
        </div>
        {acc && (
          <div className="text-xs text-slate-500 dark:text-slate-400" title="用该赛道近 24 小时真实出分记录回放：假设在当时提交，预测与真实出分时间的偏差">
            近 24h 回测（{acc.n} 次）：中位误差 <b className="num text-slate-700 dark:text-slate-200">{fmtDur(acc.medianAbsErrSec)}</b> · 区间命中率{' '}
            <b className="num text-slate-700 dark:text-slate-200">{fmtPct(acc.coverage)}</b>
          </div>
        )}
      </div>

      {pred.notes.length > 0 && (
        <ul className="mt-3 space-y-1 text-[13px] leading-relaxed text-slate-600 dark:text-slate-300">
          {pred.notes.map((n, i) => (
            <li key={i} className="flex gap-2">
              <span className="mt-2 size-1 shrink-0 rounded-full bg-brand-400" />
              {n}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Overview({ model, pred, now }: { model: TimingModel; pred: Prediction; now: number }) {
  const recent = model.recent.pts.map((p) => p.sec);
  const items: [string, string, string?][] = [
    ['近期耗时中位数', fmtDur(recent.length ? agg(recent, 'median') : null), `${model.recent.pts.length} 条${model.recent.stale ? '（较旧）' : ''}`],
    ['近期 P90', fmtDur(recent.length ? agg(recent, 'p90') : null)],
    [
      '单次评测',
      fmtDur(model.judge.sec),
      model.judge.kind === 'measured' ? `空载实测 ${model.judge.samples} 条` : model.judge.kind === 'inferred' ? '由出分节拍推断' : '粗估',
    ],
    ['当前积压', fmtDur(pred.backlogSec), pred.frontMs ? `队头 ≈ ${fmtWhen(pred.frontMs, now)} 的提交` : undefined],
    ['最近出分', model.latest ? timeAgo(model.latest.done, now) : '—', model.latest ? `${model.latest.name} · 耗时 ${fmtDur(model.latest.sec)}` : undefined],
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
      {items.map(([l, v, s]) => (
        <div key={l} className={cx('rounded-lg bg-slate-50 px-3 py-2.5 dark:bg-slate-800/50', l === '最近出分' && model.stalled && 'bg-amber-50 dark:bg-amber-500/10')}>
          <div className="text-xs text-slate-500 dark:text-slate-400">{l}</div>
          <div className="num mt-0.5 text-lg font-semibold">{v}</div>
          {s && <div className="truncate text-[11px] text-slate-500">{s}</div>}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ 图表（原生 SVG，对数纵轴）

const W = 760;
const H = 280;
const PAD = { l: 52, r: 14, t: 12, b: 28 };
const Y_TICKS = [1, 10, 30, 60, 300, 600, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 3 * 86400];
const tickLabel = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${s / 60}m` : s < 86400 ? `${s / 3600}h` : `${s / 86400}d`);

function TimingChart({
  model,
  metric,
  rangeH,
  now,
  pred,
  submitMs,
}: {
  model: TimingModel;
  metric: Metric;
  rangeH: number;
  now: number;
  pred: Prediction;
  submitMs: number;
}) {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const view = useMemo(() => {
    const first = model.pts[0]?.t ?? now - 86400_000;
    const x0 = rangeH ? Math.max(first, now - rangeH * 3600_000) : first;
    const x1 = Math.max(now, pred.etaMs != null && submitMs >= x0 ? submitMs : now);
    const pts = model.pts.filter((p) => p.t >= x0);
    const series = model.series.filter((s) => s.t >= x0 && s.n > 0).map((s) => ({ t: s.t, v: agg(s.totals, metric) }));
    const secs = pts.map((p) => p.sec).filter((s) => s > 0);
    let ymin = Math.max(1, Math.min(...secs, 60) / 1.5);
    let ymax = Math.max(...secs, 120) * 1.5;
    if (pred.etaMs != null && pred.highMs != null) ymax = Math.max(ymax, ((pred.highMs - submitMs) / 1000) * 1.3);
    if (!Number.isFinite(ymin)) ymin = 1;
    return { x0, x1: Math.max(x1, x0 + 60_000), pts, series, ymin, ymax };
  }, [model, rangeH, metric, now, pred, submitMs]);

  if (!view.pts.length) return <Empty>该时间范围内没有出分记录，换个范围试试</Empty>;

  const sx = (t: number) => PAD.l + ((t - view.x0) / (view.x1 - view.x0)) * (W - PAD.l - PAD.r);
  const ly0 = Math.log(view.ymin);
  const ly1 = Math.log(view.ymax);
  const sy = (s: number) => PAD.t + (1 - (Math.log(Math.max(s, view.ymin)) - ly0) / (ly1 - ly0)) * (H - PAD.t - PAD.b);
  const yt = Y_TICKS.filter((s) => s >= view.ymin && s <= view.ymax);
  const span = view.x1 - view.x0;
  const step = span > 3 * 86400_000 ? 24 * 3600_000 : span > 36 * 3600_000 ? 6 * 3600_000 : span > 12 * 3600_000 ? 3 * 3600_000 : 3600_000;
  const xt: number[] = [];
  for (let t = Math.ceil((view.x0 + TZ_OFFSET_MS) / step) * step - TZ_OFFSET_MS; t <= view.x1; t += step) xt.push(t);
  const line = view.series.map((s, i) => `${i ? 'L' : 'M'}${sx(s.t).toFixed(1)},${sy(s.v).toFixed(1)}`).join('');
  const hasPred = pred.etaMs != null && pred.kind !== 'none' && pred.kind !== 'stalled' && submitMs >= view.x0;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseLeave={() => setTip(null)}>
        {model.pauses
          .filter(([a, b]) => b >= view.x0 && a <= view.x1)
          .map(([a, b], i) => (
            <rect
              key={i}
              x={sx(Math.max(a, view.x0))}
              y={PAD.t}
              width={Math.max(1, sx(Math.min(b, view.x1)) - sx(Math.max(a, view.x0)))}
              height={H - PAD.t - PAD.b}
              className="fill-amber-400/10"
            >
              <title>评测暂停 {fmtTime(a)} ~ {fmtTime(b)}（这段时间已从耗时里扣除）</title>
            </rect>
          ))}
        {yt.map((s) => (
          <g key={s}>
            <line x1={PAD.l} x2={W - PAD.r} y1={sy(s)} y2={sy(s)} className="stroke-slate-200 dark:stroke-slate-800" strokeDasharray="3 3" />
            <text x={PAD.l - 6} y={sy(s) + 4} textAnchor="end" className="num fill-slate-400 text-[10px]">
              {tickLabel(s)}
            </text>
          </g>
        ))}
        {xt.map((t) => {
          const c = bj(t);
          return (
            <text key={t} x={sx(t)} y={H - 8} textAnchor="middle" className="num fill-slate-400 text-[10px]">
              {c.h === 0 || step >= 86400_000 ? `${p2(c.mo)}-${p2(c.d)}` : `${p2(c.h)}:00`}
            </text>
          );
        })}
        <line x1={sx(now)} x2={sx(now)} y1={PAD.t} y2={H - PAD.b} className="stroke-slate-300 dark:stroke-slate-600" strokeDasharray="2 3" />
        <text x={sx(now) - 3} y={PAD.t + 10} textAnchor="end" className="fill-slate-400 text-[10px]">
          现在
        </text>
        {view.pts.map((p, i) => (
          <circle
            key={i}
            cx={sx(p.t)}
            cy={sy(p.sec)}
            r={3}
            className={cx(p.pausedSec > 0 ? 'fill-amber-500/70' : 'fill-brand-500/55', 'hover:fill-brand-700')}
            onMouseEnter={() =>
              setTip({
                x: sx(p.t) / W,
                y: sy(p.sec) / H,
                text: `${p.name}\n提交 ${fmtTime(p.t)} → 出分 ${fmtTime(p.done)}\n耗时 ${fmtDur(p.sec)}${p.pausedSec > 0 ? `（已扣暂停 ${fmtDur(p.pausedSec)}）` : ''}`,
              })
            }
          />
        ))}
        {line && <path d={line} fill="none" className="stroke-rose-500" strokeWidth={2} strokeLinejoin="round" />}
        {hasPred && (
          <g>
            {pred.lowMs != null && pred.highMs != null && (
              <line
                x1={sx(submitMs)}
                x2={sx(submitMs)}
                y1={sy(Math.max(1, (pred.highMs - submitMs) / 1000))}
                y2={sy(Math.max(1, (pred.lowMs - submitMs) / 1000))}
                className="stroke-emerald-500"
                strokeWidth={3}
                strokeLinecap="round"
                opacity={0.5}
              />
            )}
            <circle cx={sx(submitMs)} cy={sy(Math.max(1, (pred.etaMs! - submitMs) / 1000))} r={6} className="fill-emerald-500 stroke-white" strokeWidth={2}>
              <title>你的提交：预计耗时 {fmtDur((pred.etaMs! - submitMs) / 1000)}</title>
            </circle>
          </g>
        )}
      </svg>
      {tip && (
        <div
          className="pointer-events-none absolute z-10 rounded-md bg-slate-900/90 px-2 py-1 text-[11px] whitespace-pre text-white shadow"
          style={{ left: `${tip.x * 100}%`, top: `${tip.y * 100}%`, transform: 'translate(-50%, calc(-100% - 8px))' }}
        >
          {tip.text}
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
        <span className="flex items-center gap-1">
          <i className="size-2 rounded-full bg-brand-500/60" /> 每队最优提交的耗时
        </span>
        <span className="flex items-center gap-1">
          <i className="size-2 rounded-full bg-amber-500/70" /> 跨评测暂停（已扣除）
        </span>
        <span className="flex items-center gap-1">
          <i className="h-0.5 w-3 bg-rose-500" /> 滚动{METRICS.find((m) => m[0] === metric)![1]}
        </span>
        {hasPred && (
          <span className="flex items-center gap-1">
            <i className="size-2 rounded-full bg-emerald-500" /> 你的提交（竖线 = 80% 区间）
          </span>
        )}
        <span className="flex items-center gap-1">
          <i className="h-2 w-3 bg-amber-400/20" /> 评测暂停
        </span>
      </div>
    </div>
  );
}

function CleanupNote({ model }: { model: TimingModel }) {
  const c = model.cleanup;
  const parts = [`原始 ${c.rawN} 条，保留 ${c.keptN} 条`];
  if (c.pausedN) parts.push(`${c.pausedN} 条跨了评测暂停，共扣除 ${fmtDur(c.deductSec)}`);
  if (c.zeroedN) parts.push(`${c.zeroedN} 条整段落在暂停里`);
  if (c.outlierN) parts.push(`${c.outlierN} 条极端异常（> ${fmtDur(c.fence)}）已剔除`);
  return (
    <p className="mt-2 text-xs leading-relaxed text-slate-400">
      数据清洗：{parts.join('；')}。榜单只保留每队最好那次提交，没提分的提交看不到，所以这里只反映「提分的提交」的耗时。
    </p>
  );
}

// ------------------------------------------------------------------ 各赛道对比（不含总榜：总榜是聚合，没有单次提交耗时）

function TrackCompare({ current, metric, now }: { current: string; metric: Metric; now: number }) {
  const { data } = useLive();
  const navigate = useNavigate({ from: '/' });
  const gen = data?.snap.generatedAt;
  const list = useMemo(() => {
    const tracks = data?.snap.boards.filter((b) => b.kind === 'track' && b.rows.length) ?? [];
    return tracks
      .map((b) => {
        const m = buildTimingModel(b.rows, { now });
        const recent = m.recent.pts.map((p) => p.sec);
        const p = predict(b.rows, now, now);
        return { b, v: recent.length ? agg(recent, metric) : null, stale: m.recent.stale, stalled: p.kind === 'stalled', p };
      })
      .sort((x, y) => (x.v ?? Infinity) - (y.v ?? Infinity));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen, metric, Math.floor(now / 60_000)]);
  const max = Math.max(1, ...list.map((x) => Math.log10(1 + (x.v ?? 0))));

  return (
    <section>
      <h3 className="card-title mb-2">各赛道近期耗时（{METRICS.find((m) => m[0] === metric)![1]}）与现在提交的预计出分</h3>
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {list.map(({ b, v, stale, stalled, p }) => (
          <button
            key={b.id}
            type="button"
            onClick={() => void navigate({ search: (s: Record<string, unknown>) => ({ ...s, board: b.id, tab: 'timing' }) })}
            className={cx(
              'grid w-full grid-cols-[minmax(0,11rem)_1fr_5rem_7.5rem] items-center gap-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800/40',
              b.id === current && 'bg-brand-50/70 dark:bg-brand-500/10',
            )}
          >
            <span className="truncate" title={b.title}>
              {b.title}
            </span>
            <span className="h-2 rounded-full bg-slate-100 dark:bg-slate-800">
              <span
                className={cx('block h-2 rounded-full', stalled ? 'bg-amber-400' : 'bg-brand-400')}
                style={{ width: `${(Math.log10(1 + (v ?? 0)) / max) * 100}%` }}
              />
            </span>
            <span className={cx('num text-right text-xs', stale && 'text-slate-400')} title={stale ? '近期没有新出分，这是较早的数据' : undefined}>
              {fmtDur(v)}
            </span>
            <span className={cx('text-right text-xs', p.kind === 'stalled' ? 'text-amber-600' : 'text-slate-600 dark:text-slate-300')}>
              {p.kind === 'stalled' ? '疑似停摆' : p.kind === 'none' ? '—' : fmtWhen(p.etaMs, now)}
            </span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-400">点击赛道切换。条长为对数刻度；黄色 = 疑似停摆（很久没有新出分）；灰字 = 近期无新出分，用的是较早数据。</p>
    </section>
  );
}
