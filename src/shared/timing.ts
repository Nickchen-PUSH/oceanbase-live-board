// 耗时模型：把赛道榜行转成「提交 → 出分」样本，清洗（扣评测暂停、剔除极端异常），
// 拆成「评测 + 等待」，并给出滚动窗口序列与近期窗口。纯函数，无副作用。
//
// 数据口径：赛道榜每行 = 该队「最优那次提交」，updated - bestSubmit = 这次提交的真实端到端耗时。
// 没提升分数的提交不可见（幸存者偏差），所以这里的统计只覆盖「提分的那些提交」。

import type { Row, Sample } from './types.ts';
import { samplesOf } from './types.ts';
import { countLE, mean, quantile, quantileSorted, sortedCopy } from './stats.ts';

export interface TimingPoint extends Sample {
  /** 清洗后耗时（秒）= rawSec - pausedSec */
  sec: number;
  /** 原始端到端耗时（秒）= (done - t) / 1000 */
  rawSec: number;
  /** 与评测暂停窗口重叠、已被扣掉的秒数 */
  pausedSec: number;
  /** 拆分：评测部分（秒）= min(sec, judge.sec) */
  judge: number;
  /** 拆分：等待部分（秒）= sec - judge */
  queue: number;
}

export interface TimingCleanup {
  /** 原始有效样本数（done > t） */
  rawN: number;
  /** 清洗后保留数 */
  keptN: number;
  /** 极端异常剔除数（扣暂停后仍 > fence） */
  outlierN: number;
  /** 扣暂停后耗时变成 0 的样本数（整段都落在暂停里，单独计数，不算异常） */
  zeroedN: number;
  /** 跨了暂停窗口、被扣过时间的样本数 */
  pausedN: number;
  /** 这些样本总共被扣掉的秒数 */
  deductSec: number;
  /** 识别出的暂停窗口数（全部，含不影响样本的） */
  pauseWin: number;
  /** 暂停窗口总时长（秒） */
  pauseSec: number;
  /** 异常阈值（秒）= max(P99, 10 × 中位数, 60) */
  fence: number;
}

export interface TimingJudge {
  /** measured = 空载样本实测；inferred = 完成节拍 × 并发槽推断；fallback = 最快 20% 粗估 */
  kind: 'measured' | 'inferred' | 'fallback';
  /** 单次评测时长估计（秒） */
  sec: number;
  /** 空载样本数（提交时在途 ≤ 1 且不跨暂停） */
  samples: number;
  /** 完成节拍：相邻两次出分间隔的中位数（秒），不跨暂停；样本不足为 0 */
  cadenceSec: number;
  /** 隐含并发槽数（measured: sec / cadence；inferred: 固定 2.5；fallback: null） */
  slots: number | null;
}

export interface TimingSeriesPoint {
  t: number;
  n: number;
  totals: number[];
  judges: number[];
  queues: number[];
}

export interface TimingModel {
  /** 清洗后样本，按 t 升序 */
  pts: TimingPoint[];
  /** 识别出的评测暂停窗口（仅影响到留存样本的），[开始, 结束] 毫秒 */
  pauses: [number, number][];
  cleanup: TimingCleanup;
  judge: TimingJudge;
  /** 最近一次出分（全部原始样本里 done 最晚的那条；sec = 原始端到端耗时） */
  latest: { name: string; t: number; done: number; sec: number } | null;
  /**
   * 近期窗口（相对 now）：近 30 分钟内出分的样本；不足 5 条退回最近 20 条出分。
   * from/to 是这些样本的「提交时刻」范围（图表横轴是提交时刻）。
   * stale = 最近一次出分距 now 已超过停摆阈值（这时「近期」其实是旧数据）。
   */
  recent: { pts: TimingPoint[]; from: number; to: number; stale: boolean; ageSec: number | null };
  /** 滚动窗口，按 t 升序；每个点含窗口内的原始数组，前端按口径聚合 */
  series: TimingSeriesPoint[];
  /** now - 最近一次出分（秒）；无样本为 null */
  idleSec: number | null;
  /** 停摆阈值（秒）= max(60 分钟, 10 × 出分间隔中位数)，与暂停识别同口径 */
  stallSec: number;
  /** idleSec ≥ stallSec：此刻处于「长时间零出分」状态（可能停摆，也可能只是没人提分） */
  stalled: boolean;
  /** now（毫秒） */
  now: number;
  insufficient: boolean;
}

export type Metric = 'avg' | 'median' | 'p90';

/** 按口径聚合；空数组返回 0（便于直接画图） */
export function agg(arr: number[], m: Metric): number {
  if (!arr.length) return 0;
  if (m === 'avg') return mean(arr);
  if (m === 'p90') return quantile(arr, 0.9);
  return quantile(arr, 0.5);
}

// ---------------------------------------------------------------- 常量

export const RECENT_WINDOW_MS = 30 * 60 * 1000;
/** 评测暂停：相邻两次出分空档 ≥ max(60 分钟, 10 × 出分间隔中位数) */
export const PAUSE_GAP_MIN_MS = 60 * 60 * 1000;
export const PAUSE_GAP_FACTOR = 10;
/** 暂停总时长占观测跨度比例过高 = 样本太稀疏，整体不修正 */
export const PAUSE_SPAN_MAX_RATIO = 0.6;
/** 修正后仍超过 max(P99, 10 × 中位数, 60 秒) 的当极端异常剔除 */
export const OUTLIER_FACTOR = 10;
/** 推断评测时长时假设的并发槽数（同集群实测 2~5 槽） */
export const INFERRED_SLOTS = 2.5;

// ---------------------------------------------------------------- 暂停识别

/** 出分间隔中位数（毫秒）与暂停阈值；dones 需升序 */
export function pauseThreshold(dones: ArrayLike<number>): { medGapMs: number; thresholdMs: number } {
  const gaps: number[] = [];
  for (let i = 1; i < dones.length; i++) gaps.push(dones[i] - dones[i - 1]);
  const medGapMs = gaps.length ? quantile(gaps, 0.5) : 0;
  return { medGapMs, thresholdMs: Math.max(PAUSE_GAP_MIN_MS, PAUSE_GAP_FACTOR * medGapMs) };
}

/**
 * 只用「出分」事件识别暂停（提交是用户行为，不能证明平台在评测）。
 * dones 需升序。少于 8 个事件不识别。
 */
export function detectPauses(dones: ArrayLike<number>): [number, number][] {
  if (dones.length < 8) return [];
  const { thresholdMs } = pauseThreshold(dones);
  const merged: [number, number][] = [];
  for (let i = 1; i < dones.length; i++) {
    if (dones[i] - dones[i - 1] < thresholdMs) continue;
    const last = merged[merged.length - 1];
    if (last && dones[i - 1] <= last[1]) last[1] = Math.max(last[1], dones[i]);
    else merged.push([dones[i - 1], dones[i]]);
  }
  const span = dones[dones.length - 1] - dones[0];
  let paused = 0;
  for (const [a, b] of merged) paused += b - a;
  if (!span || paused / span > PAUSE_SPAN_MAX_RATIO) return [];
  return merged;
}

export function overlapMs(a: number, b: number, windows: [number, number][]): number {
  let sum = 0;
  for (const [s0, e0] of windows) {
    const lo = Math.max(a, s0);
    const hi = Math.min(b, e0);
    if (hi > lo) sum += hi - lo;
  }
  return sum;
}

// ---------------------------------------------------------------- 模型

const emptyCleanup = (): TimingCleanup => ({
  rawN: 0,
  keptN: 0,
  outlierN: 0,
  zeroedN: 0,
  pausedN: 0,
  deductSec: 0,
  pauseWin: 0,
  pauseSec: 0,
  fence: 0,
});

export function buildTimingModel(rows: Row[], opts: { now?: number } = {}): TimingModel {
  const now = opts.now ?? Date.now();
  const samples = samplesOf(rows);
  return buildTimingModelFromSamples(samples, now);
}

/** 同 buildTimingModel，但直接吃样本（按 t 升序），供预测 / 回测复用 */
export function buildTimingModelFromSamples(samples: Sample[], now: number): TimingModel {
  const dones = sortedCopy(samples.map((s) => s.done));
  const { thresholdMs } = pauseThreshold(dones);
  const lastDone = dones.length ? dones[dones.length - 1] : null;
  const idleSec = lastDone == null ? null : Math.max(0, (now - lastDone) / 1000);
  const stallSec = thresholdMs / 1000;
  const stalled = idleSec != null && dones.length >= 3 && idleSec >= stallSec;

  // 1. 扣暂停
  const allPauses = detectPauses(dones);
  const cleanup = emptyCleanup();
  cleanup.rawN = samples.length;
  cleanup.pauseWin = allPauses.length;
  for (const [a, b] of allPauses) cleanup.pauseSec += (b - a) / 1000;

  const raw: TimingPoint[] = samples.map((s) => {
    const rawSec = (s.done - s.t) / 1000;
    const ov = allPauses.length ? overlapMs(s.t, s.done, allPauses) / 1000 : 0;
    if (ov > 0) {
      cleanup.pausedN += 1;
      cleanup.deductSec += ov;
    }
    return { ...s, rawSec, pausedSec: ov, sec: Math.max(0, rawSec - ov), judge: 0, queue: 0 };
  });

  // 2. 剔除：扣完变 0 的单独计数；剩下的超过 fence 才算极端异常
  const positives = raw.filter((p) => p.sec > 0).map((p) => p.sec);
  const posSorted = sortedCopy(positives);
  const med = posSorted.length ? quantileSorted(posSorted, 0.5) : 0;
  const fence = posSorted.length ? Math.max(quantileSorted(posSorted, 0.99), med * OUTLIER_FACTOR, 60) : 0;
  cleanup.fence = fence;
  const pts: TimingPoint[] = [];
  for (const p of raw) {
    if (p.sec <= 0) cleanup.zeroedN += 1;
    else if (p.sec > fence) cleanup.outlierN += 1;
    else pts.push(p);
  }
  cleanup.keptN = pts.length;
  const pauses = allPauses.filter(([a, b]) => pts.some((p) => p.t < b && p.done > a));

  // 3. 单次评测时长
  const judge = estimateJudge(pts, pauses);
  for (const p of pts) {
    p.judge = Math.min(p.sec, judge.sec);
    p.queue = Math.max(0, p.sec - p.judge);
  }

  // 4. 最近一次出分（全部原始样本）
  let latest: TimingModel['latest'] = null;
  for (const s of samples) {
    if (latest && s.done <= latest.done) continue;
    latest = { name: s.name, t: s.t, done: s.done, sec: (s.done - s.t) / 1000 };
  }

  // 5. 滚动窗口序列（按提交时刻，窗口大小随样本量走，约 60~120 个点）
  const series: TimingSeriesPoint[] = [];
  if (pts.length) {
    const w = Math.max(5, Math.min(80, Math.round(pts.length / 10)));
    const step = Math.max(1, Math.floor(w / 4));
    const push = (endIdx: number) => {
      const win = pts.slice(Math.max(0, endIdx - w + 1), endIdx + 1);
      series.push({
        t: pts[endIdx].t,
        n: win.length,
        totals: win.map((p) => p.sec),
        judges: win.map((p) => p.judge),
        queues: win.map((p) => p.queue),
      });
    };
    for (let i = w - 1; i < pts.length; i += step) push(i);
    if (!series.length || series[series.length - 1].t !== pts[pts.length - 1].t) push(pts.length - 1);
  }

  // 6. 近期窗口：相对 now（按出分时刻），不是相对最后一次提交
  const byDone = pts.slice().sort((a, b) => a.done - b.done);
  let recentPts = byDone.filter((p) => p.done <= now && now - p.done <= RECENT_WINDOW_MS);
  if (recentPts.length < 5) recentPts = byDone.filter((p) => p.done <= now).slice(-20);
  recentPts.sort((a, b) => a.t - b.t);
  const recentLast = recentPts.length ? Math.max(...recentPts.map((p) => p.done)) : null;
  const recentAge = recentLast == null ? null : Math.max(0, (now - recentLast) / 1000);
  const recent = {
    pts: recentPts,
    from: recentPts.length ? recentPts[0].t : now,
    to: recentPts.length ? recentPts[recentPts.length - 1].t : now,
    stale: recentAge != null && recentAge >= stallSec,
    ageSec: recentAge,
  };

  return {
    pts,
    pauses,
    cleanup,
    judge,
    latest,
    recent,
    series,
    idleSec,
    stallSec,
    stalled,
    now,
    insufficient: pts.length < 3,
  };
}

/**
 * 单次评测时长：
 * ① 队列基本空的样本（提交时在途 ≤ 1、且不跨暂停）≈ 真实评测开销 → ≥20 条取中位数（measured）
 * ② 否则用「完成节拍 × 隐含并发槽」推断（队列饱和时出分间隔 = 单次时长 ÷ 并发），不超过整体中位 × 0.9
 * ③ 再不行取最快 20%（上限 5 分钟）
 */
export function estimateJudge(pts: TimingPoint[], pauses: [number, number][]): TimingJudge {
  if (!pts.length) return { kind: 'fallback', sec: 0, samples: 0, cadenceSec: 0, slots: null };
  // 在途数 = 提交时刻 ≤ p.t 的样本数 − 出分时刻 ≤ p.t 的样本数 − 自己（O(n log n)，与逐对计数等价）
  const ts = sortedCopy(pts.map((p) => p.t));
  const ds = sortedCopy(pts.map((p) => p.done));
  const idle: number[] = [];
  for (const p of pts) {
    const inflight = countLE(ts, p.t) - countLE(ds, p.t) - 1;
    const ov = pauses.length ? overlapMs(p.t, p.done, pauses) : 0;
    if (inflight <= 1 && ov < 60 * 1000) idle.push(p.sec);
  }
  const gaps: number[] = [];
  for (let i = 1; i < ds.length; i++) {
    if (pauses.length && overlapMs(ds[i - 1], ds[i], pauses) > 0) continue;
    gaps.push((ds[i] - ds[i - 1]) / 1000);
  }
  const cadenceSec = gaps.length >= 5 ? quantile(gaps, 0.5) : 0;
  const medAll = quantile(pts.map((p) => p.sec), 0.5) || 0;
  if (idle.length >= 20) {
    const sec = quantile(idle, 0.5);
    return { kind: 'measured', sec, samples: idle.length, cadenceSec, slots: cadenceSec > 0 ? sec / cadenceSec : null };
  }
  if (cadenceSec > 0) {
    return {
      kind: 'inferred',
      sec: Math.min(cadenceSec * INFERRED_SLOTS, medAll * 0.9),
      samples: idle.length,
      cadenceSec,
      slots: INFERRED_SLOTS,
    };
  }
  return {
    kind: 'fallback',
    sec: Math.min(quantile(pts.map((p) => p.sec), 0.2), 300),
    samples: idle.length,
    cadenceSec: 0,
    slots: null,
  };
}
