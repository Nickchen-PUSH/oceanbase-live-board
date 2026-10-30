// 出分预测：「近期滞后水平 + 工作时钟 + 经验残差校准」
//
// 思路（详见 docs/prediction.md）：
//   1. 每条可见样本的端到端耗时 lag = done - t（排队 + 评测）。
//   2. 从历史里学出「评测机不干活的钟点」（有作业在等、却从没出过分的北京时间小时），
//      把时间换算成只计工作钟点的「工作时钟」。全天都工作的赛道，工作时钟 = 普通时钟。
//   3. 点估计：最近 k 条出分的工作时钟耗时的中位数（≥ 窗口内最小耗时）。
//   4. 区间：对最近 calibK 条已出分样本，回放「它刚提交时」本模型会给出的点估计，
//      得到 实际/预测 比值的经验分布 → 乘到当前点估计上取 10%/90% 分位，
//      并按「已经等了多久」做条件截断（已经等过的部分不可能再发生）。
//   5. 旧算法（推进速率外推）原样保留为 predictLegacy，仅供回测对比。
//
// 纯 TS、无依赖，可在浏览器 / Worker 中运行；时间一律毫秒时间戳。
import type { Row, Sample } from './types.ts';
import { samplesOf } from './types.ts';
import { bj, fmtDur, fmtWhen, TZ_OFFSET_MS } from './format.ts';
import { countLE, median, quantileSorted, sortedCopy, theilSen } from './stats.ts';
import { buildTimingModelFromSamples } from './timing.ts';

const H = 3600e3;
const DAY = 86400e3;

// ============================================================ 工作时钟

/** on[h] = 北京时间 h 点这一小时评测机是否在工作 */
export interface WorkClock {
  on: boolean[];
  /** 工作小时数（1..24） */
  onHours: number;
  /** on 为全 true 时是普通时钟 */
  always: boolean;
  /** 识别出的休息钟点（北京时间小时），升序 */
  offHours: number[];
}

const ALWAYS: WorkClock = { on: Array(24).fill(true), onHours: 24, always: true, offHours: [] };

/**
 * 从样本学习休息钟点：某个北京时间小时 h，在 ≥2 个不同日期里都有作业「整小时在等」，
 * 但所有日期里 h 点都从没出过分 ⇒ h 点评测机不工作。
 * 夜里没人提交的空闲时段没有「在等的作业」，不会被误判。休息钟点超过 18 个视为数据异常，退回全天。
 */
export function learnWorkClock(samples: Sample[]): WorkClock {
  if (samples.length < 20) return ALWAYS;
  const exposed: Set<number>[] = Array.from({ length: 24 }, () => new Set<number>());
  const doneHour = new Array<number>(24).fill(0);
  for (const s of samples) {
    doneHour[bj(s.done).h]++;
    // 只看完整落在 (t, done) 内的整点小时；最多 96 个
    const first = Math.ceil((s.t + TZ_OFFSET_MS) / H) * H - TZ_OFFSET_MS;
    for (let k = 0, x = first; x + H <= s.done && k < 96; k++, x += H) {
      const local = x + TZ_OFFSET_MS;
      exposed[Math.floor((local % DAY) / H)].add(Math.floor(local / DAY));
    }
  }
  const on: boolean[] = [];
  const offHours: number[] = [];
  for (let h = 0; h < 24; h++) {
    const off = doneHour[h] === 0 && exposed[h].size >= 2;
    on.push(!off);
    if (off) offHours.push(h);
  }
  if (!offHours.length || offHours.length > 18) return ALWAYS;
  return { on, onHours: 24 - offHours.length, always: false, offHours };
}

/** 毫秒时间戳 → 工作时钟（只累计工作小时的毫秒数）。休息时段内的时刻映射到下一个工作小时的起点。 */
export function toWork(wc: WorkClock, ts: number): number {
  const local = ts + TZ_OFFSET_MS;
  if (wc.always) return local;
  const day = Math.floor(local / DAY);
  const rem = local - day * DAY;
  const h = Math.floor(rem / H);
  let before = 0;
  for (let i = 0; i < h; i++) if (wc.on[i]) before++;
  return day * wc.onHours * H + before * H + (wc.on[h] ? rem - h * H : 0);
}

/** 工作时钟 → 毫秒时间戳（落在某个工作小时之内） */
export function fromWork(wc: WorkClock, w: number): number {
  if (wc.always) return w - TZ_OFFSET_MS;
  const perDay = wc.onHours * H;
  const day = Math.floor(w / perDay);
  let r = w - day * perDay;
  for (let h = 0; h < 24; h++) {
    if (!wc.on[h]) continue;
    if (r < H) return day * DAY + h * H + r - TZ_OFFSET_MS;
    r -= H;
  }
  return (day + 1) * DAY - TZ_OFFSET_MS; // 不可达（r 恰好等于 perDay 时由下一天处理）
}

// ============================================================ 预处理

export interface Prepared {
  /** 按出分时刻升序 */
  s: Sample[];
  done: number[];
  t: number[];
  /** 工作时钟下的端到端耗时（毫秒） */
  lag: number[];
  /** 真实端到端耗时（毫秒） */
  rawLag: number[];
  wc: WorkClock;
  /** 每条样本在「它自己提交那一刻」本模型给出的点估计（工作时钟毫秒），NaN = 未计算 */
  originHat: number[];
}

export function prepareSamples(samples: Sample[], wc?: WorkClock): Prepared {
  const s = samples.slice().sort((a, b) => a.done - b.done || a.t - b.t);
  const clock = wc ?? learnWorkClock(s);
  return {
    s,
    done: s.map((x) => x.done),
    t: s.map((x) => x.t),
    lag: s.map((x) => Math.max(0, toWork(clock, x.done) - toWork(clock, x.t))),
    rawLag: s.map((x) => x.done - x.t),
    wc: clock,
    originHat: s.map(() => Number.NaN),
  };
}

export function prepare(rows: Row[], wc?: WorkClock): Prepared {
  return prepareSamples(samplesOf(rows), wc);
}

// ============================================================ 核心引擎

export interface EngineCfg {
  /** 窗口最多取最近多少条出分 */
  winN: number;
  /** 窗口时间跨度上限（相对最后一次出分，毫秒） */
  winSpanMs: number;
  /** 当前滞后 = 最近 k 条的中位数 */
  levelK: number;
  /** 校准用的最近完成条数 */
  calibK: number;
  /** 区间分位 */
  qLo: number;
  qHi: number;
  /** 是否使用工作时钟（关掉 = 普通时钟，仅用于消融实验） */
  workClock: boolean;
  /** 区间放宽系数：对数比值乘以该系数（补偿近期样本少、节奏漂移带来的低估） */
  widen: number;
}

export const DEFAULT_CFG: EngineCfg = {
  winN: 30,
  winSpanMs: 12 * H,
  levelK: 5,
  calibK: 50,
  // 名义上取 5%/95% 分位并把对数比值放宽 1.3 倍：回测里这样实际覆盖率才接近 80%
  // （只用 10%/90% 时正常时段覆盖率仅 58%，因为近期节奏会漂移）
  qLo: 0.05,
  qHi: 0.95,
  workClock: true,
  widen: 1.3,
};

function windowStart(P: Prepared, cut: number, cfg: EngineCfg): number {
  const lastDone = P.done[cut - 1];
  let lo = Math.max(0, cut - cfg.winN);
  while (lo < cut - 5 && P.done[lo] < lastDone - cfg.winSpanMs) lo++;
  return lo;
}

/** 用 [0, cut) 的出分样本做点估计：工作时钟下的端到端毫秒 */
export function pointLag(P: Prepared, cut: number, cfg: EngineCfg = DEFAULT_CFG): number {
  if (cut < 3) return Number.NaN;
  const lo = windowStart(P, cut, cfg);
  const k = Math.min(cfg.levelK, cut - lo);
  const lvl: number[] = [];
  for (let j = cut - k; j < cut; j++) lvl.push(P.lag[j]);
  let floor = Number.POSITIVE_INFINITY;
  for (let j = lo; j < cut; j++) floor = Math.min(floor, P.lag[j]);
  return Math.max(median(lvl), floor);
}

function originHat(P: Prepared, j: number, cfg: EngineCfg): number {
  let v = P.originHat[j];
  if (Number.isNaN(v)) {
    const h = pointLag(P, countLE(P.done, P.t[j]), cfg);
    v = P.originHat[j] = Number.isFinite(h) ? h : Number.POSITIVE_INFINITY;
  }
  return v;
}

export interface CoreOut {
  kind: 'none' | 'queue' | 'overdue';
  etaMs: number | null;
  lowMs: number | null;
  highMs: number | null;
  /** 点估计（工作时钟毫秒） */
  Lhat?: number;
  /** 校准样本数 */
  calibN?: number;
  /** 区间宽度 / 点估计（相对离散度） */
  spread?: number;
}

/**
 * 核心预测：信息集 = P 中前 cut 条（按出分时刻升序）已出分样本。
 * submit = 作业提交时刻，now = 此刻。返回真实毫秒时间戳。
 */
export function predictCore(P: Prepared, cut: number, submit: number, now: number, cfg: EngineCfg = DEFAULT_CFG): CoreOut {
  if (cut < 3) return { kind: 'none', etaMs: null, lowMs: null, highMs: null };
  const wc = cfg.workClock ? P.wc : ALWAYS;
  const Lhat = pointLag(P, cut, cfg);
  const ws = toWork(wc, submit);
  const elapsed = Math.max(0, toWork(wc, now) - ws);
  const at = (w: number) => Math.max(now, fromWork(wc, ws + w));
  const ratios: number[] = [];
  for (let j = cut - 1; j >= 0 && ratios.length < cfg.calibK; j--) {
    const h = originHat(P, j, cfg);
    if (Number.isFinite(h) && h > 0) ratios.push(P.lag[j] / h);
  }
  if (cfg.widen !== 1) for (let i = 0; i < ratios.length; i++) ratios[i] = ratios[i] > 0 ? Math.pow(ratios[i], cfg.widen) : 0;
  if (ratios.length < 5) {
    const pt = Math.max(Lhat, elapsed);
    return { kind: 'queue', etaMs: at(pt), lowMs: at(Math.max(Lhat * 0.5, elapsed)), highMs: at(Math.max(Lhat * 2, elapsed)), Lhat, calibN: ratios.length, spread: 1.5 };
  }
  // 条件分布：只保留「比已等待时间更长」的情形
  const cand = sortedCopy(ratios.map((r) => r * Lhat)).filter((c) => c > elapsed);
  if (cand.length < Math.max(3, Math.floor(ratios.length / 6))) {
    // 已经比近期几乎所有作业都等得久：按「随时可能出分」处理
    return {
      kind: 'overdue',
      etaMs: at(elapsed + Math.max(60e3, 0.25 * Lhat)),
      lowMs: now,
      highMs: at(elapsed + Math.max(120e3, Lhat)),
      Lhat,
      calibN: ratios.length,
      spread: 2,
    };
  }
  const pt = Lhat > elapsed ? Lhat : quantileSorted(cand, 0.5);
  const lo = Math.min(pt, quantileSorted(cand, cfg.qLo));
  const hi = Math.max(pt, quantileSorted(cand, cfg.qHi));
  return {
    kind: 'queue',
    etaMs: at(pt),
    lowMs: at(lo),
    highMs: at(hi),
    Lhat,
    calibN: ratios.length,
    spread: (hi - lo) / Math.max(pt, 60e3),
  };
}

// ============================================================ 对外：predict()

export type PredictionKind = 'none' | 'fast' | 'queue' | 'overdue' | 'batch' | 'stalled';

export interface Prediction {
  kind: PredictionKind;
  /** 点估计 + 约 80% 区间（毫秒时间戳） */
  etaMs: number | null;
  lowMs: number | null;
  highMs: number | null;
  confidence: 'high' | 'medium' | 'low';
  /** 队头此刻推进到的「提交时刻」：在此之前提交的作业按近期节奏此刻应已出分 */
  frontMs: number | null;
  /** 当前积压（now - frontMs，秒） */
  backlogSec: number | null;
  /** 队头推进速率（提交时刻推进 / 墙钟，1 = 与提交同步） */
  rate: number | null;
  rateLabel: string;
  judgeSec: number | null;
  /** 近期（窗口内、清洗后）端到端耗时中位数 / P90（秒） */
  medTurnaroundSec: number | null;
  p90TurnaroundSec: number | null;
  lastDoneMs: number | null;
  /** 信息集中可见的已出分样本数 */
  samples: number;
  /** 估计用的窗口跨度（小时） */
  windowH: number | null;
  /** 识别出的评测休息钟点（北京时间小时），无则空数组 */
  offHours: number[];
  /** 此刻距最近一次出分（秒） */
  idleSec: number | null;
  /** 该赛道近 24h 滚动回测（与 backtestTrack 相同口径），用于置信度；样本不足为 null */
  accuracy: TrackAccuracy | null;
  headline: string;
  notes: string[];
}

export function rateLabelOf(r: number | null): string {
  if (r == null || !Number.isFinite(r)) return '—';
  if (r >= 2.5) return '回填中';
  if (r > 1.25) return '积压被消化';
  if (r >= 0.8) return '饱和';
  return '积压在增长';
}

/** 快赛道阈值：近期点估计不超过 3 分钟 */
const FAST_MS = 3 * 60e3;

/** 判断是否停摆：此刻是工作时段、距最近出分已超过 max(1 小时, 10×近期出分间隔, 2×点估计) */
function stallInfo(P: Prepared, cut: number, now: number, Lhat: number): { stalled: boolean; idle: number } {
  const last = P.done[cut - 1];
  const idle = now - last;
  const gaps: number[] = [];
  for (let j = Math.max(1, cut - 30); j < cut; j++) gaps.push(P.done[j] - P.done[j - 1]);
  const thr = Math.max(H, 10 * (gaps.length ? median(gaps) : 0), 2 * Lhat);
  const working = P.wc.on[bj(now).h];
  return { stalled: idle > thr && working, idle };
}

export function predict(rows: Row[], submitMs: number, nowMs: number): Prediction {
  const P = prepare(rows);
  const cut = countLE(P.done, nowMs);
  return predictPrepared(P, cut, submitMs, nowMs);
}

export function predictPrepared(P: Prepared, cut: number, submitMs: number, nowMs: number): Prediction {
  const base: Prediction = {
    kind: 'none', etaMs: null, lowMs: null, highMs: null, confidence: 'low',
    frontMs: null, backlogSec: null, rate: null, rateLabel: '—', judgeSec: null,
    medTurnaroundSec: null, p90TurnaroundSec: null, lastDoneMs: cut ? P.done[cut - 1] : null,
    samples: cut, windowH: null, offHours: P.wc.offHours, accuracy: null, idleSec: cut ? Math.round((nowMs - P.done[cut - 1]) / 1000) : null,
    headline: '样本不足，暂无法预测出分时间', notes: [],
  };
  if (cut < 3) {
    base.notes.push(`该赛道目前只有 ${cut} 条可见的出分记录，至少需要 3 条才能估计耗时。`);
    return base;
  }
  const core = predictCore(P, cut, submitMs, nowMs);
  const Lhat = core.Lhat ?? 0;
  const lo = windowStart(P, cut, DEFAULT_CFG);
  const wc = P.wc;

  // 描述性统计：窗口内、清洗后的真实耗时（修旧 bug 3：不用含暂停/极端异常的原始值）
  const winSamples = P.s.slice(lo, cut);
  const tm = buildTimingModelFromSamples(winSamples.slice().sort((a, b) => a.t - b.t), nowMs);
  const secs = sortedCopy(tm.pts.map((p) => p.sec));
  const med = secs.length ? quantileSorted(secs, 0.5) : null;
  const p90 = secs.length ? quantileSorted(secs, 0.9) : null;
  const windowH = (P.done[cut - 1] - P.done[lo]) / H;

  // 队头推进速率：窗口内「提交时刻 ~ 出分时刻」的 Theil–Sen 斜率
  let rate: number | null = null;
  if (cut - lo >= 6 && windowH >= 0.5) {
    const ts = theilSen(P.done.slice(lo, cut), P.t.slice(lo, cut));
    if (ts && Number.isFinite(ts.slope)) rate = Math.max(0, ts.slope);
  }
  const frontMs = Math.min(nowMs, fromWork(wc, toWork(wc, nowMs) - Lhat));
  const st = stallInfo(P, cut, nowMs, Lhat);

  const p: Prediction = {
    ...base,
    kind: 'queue',
    etaMs: core.etaMs,
    lowMs: core.lowMs,
    highMs: core.highMs,
    frontMs,
    backlogSec: Math.max(0, Math.round((nowMs - frontMs) / 1000)),
    rate,
    rateLabel: rateLabelOf(rate),
    judgeSec: tm.insufficient ? null : tm.judge.sec,
    medTurnaroundSec: med,
    p90TurnaroundSec: p90,
    windowH: Math.round(windowH * 10) / 10,
    idleSec: Math.round(st.idle / 1000),
  };

  // 区间是否跨越休息时段 ⇒ batch
  const start = Math.max(nowMs, submitMs);
  const crossesOff =
    !wc.always && core.etaMs != null && core.etaMs - start - (toWork(wc, core.etaMs) - toWork(wc, start)) > 30 * 60e3;

  if (st.stalled && submitMs < nowMs) p.kind = 'stalled';
  else if (core.kind === 'overdue') p.kind = 'overdue';
  else if (crossesOff) p.kind = 'batch';
  else if (Lhat <= FAST_MS) p.kind = 'fast';

  // 置信度：优先看该赛道近 24h 回测的相对误差与区间命中率；回测样本不足时看区间相对宽度
  const acc = backtestPrepared(P, nowMs, { lookbackH: 24, maxCases: 60 });
  p.accuracy = acc;
  const levels = ['low', 'medium', 'high'] as const;
  let lv: number;
  if (acc && acc.n >= 10 && med != null && med > 0) {
    // 秒级赛道的几秒误差无关紧要：分母至少 2 分钟
    const rel = acc.medianAbsErrSec / Math.max(med, 120);
    lv = rel <= 0.25 ? 2 : rel <= 0.6 ? 1 : 0;
    if (acc.coverage < 0.6) lv = Math.max(0, lv - 1);
  } else {
    const spread = core.spread ?? 3;
    lv = spread <= 1.2 ? 2 : spread <= 3 ? 1 : 0;
  }
  if (p.kind === 'stalled' || cut < 10) lv = 0;
  if (p.kind === 'overdue') lv = Math.min(lv, 1);
  p.confidence = levels[lv];

  writeText(p, submitMs, nowMs, Lhat, cut - lo);
  return p;
}

function writeText(p: Prediction, submit: number, now: number, Lhat: number, winN: number): void {
  const when = (ts: number | null) => fmtWhen(ts, now);
  const range = p.lowMs != null && p.highMs != null ? `${when(p.lowMs)} ~ ${when(p.highMs)}` : '';
  const dur = (ms: number) => fmtDur(Math.max(1, Math.round(ms / 1000)));
  const notes: string[] = [];
  const waited = now - submit;
  switch (p.kind) {
    case 'fast':
      p.headline = `预计 ${dur(Math.max(0, (p.etaMs ?? now) - Math.max(submit, now)) || Lhat)}内出分（约 ${when(p.etaMs)}）`;
      notes.push(`该赛道近期评测很快：最近 ${winN} 条出分的端到端耗时中位数 ${fmtDur(p.medTurnaroundSec)}，P90 ${fmtDur(p.p90TurnaroundSec)}。`);
      break;
    case 'queue':
      p.headline = `预计 ${when(p.etaMs)} 出分`;
      notes.push(`按最近 ${winN} 条出分的排队节奏，提交后约 ${dur(Lhat)} 出分；此刻队头推进到 ${when(p.frontMs)} 提交的作业。`);
      if (p.rate != null) notes.push(`队头推进速率 ${p.rate.toFixed(2)}×（${p.rateLabel}）。`);
      break;
    case 'batch':
      p.headline = `预计 ${when(p.etaMs)} 出分`;
      notes.push(`该赛道评测机在北京时间 ${hourRanges(p.offHours)} 不出分（从历史里「有作业在等却从不出分」的钟点识别），这段时间不计入排队。`);
      notes.push(`扣除休息时段后，近期作业约 ${dur(Lhat)} 出分。`);
      break;
    case 'overdue':
      p.headline = '按近期节奏应已出分，随时可能出分';
      notes.push(`已等待 ${dur(waited)}，超过了近期绝大多数作业的耗时（中位数 ${fmtDur(p.medTurnaroundSec)}）。`);
      notes.push('若这次提交没有刷新最好成绩，榜单不会变化——看不到更新不代表还没评测完。');
      break;
    case 'stalled':
      p.headline = `评测疑似停摆：已 ${fmtDur(p.idleSec)} 没有新出分`;
      notes.push(`最近一次出分在 ${when(p.lastDoneMs)}；如果评测恢复，按此前节奏预计 ${when(p.etaMs)} 前后出分，但恢复时间无法预估。`);
      notes.push('停摆期间提交的作业通常会在恢复后集中出分。');
      break;
    default:
      break;
  }
  if (p.kind === 'fast' && p.lowMs != null && p.highMs != null) {
    const s0 = Math.max(submit, now);
    notes.push(`约 80% 的把握在 ${dur(Math.max(0, p.lowMs - s0))} ~ ${dur(Math.max(0, p.highMs - s0))}内出分（区间由近期预测误差校准）。`);
  } else if (p.kind !== 'stalled' && p.kind !== 'none' && range) notes.push(`约 80% 的把握在 ${range} 之间（区间由近期预测误差校准）。`);
  if (p.kind !== 'overdue' && p.kind !== 'none') notes.push('榜单只记录刷新了最好成绩的提交，没提分的提交不会显示出分。');
  p.notes = notes.slice(0, 4);
}

function hourRanges(hours: number[]): string {
  if (!hours.length) return '';
  const set = new Set(hours);
  // 找一个不休息的起点，按环形拼出连续段
  let start = 0;
  while (set.has(start) && start < 24) start++;
  const parts: string[] = [];
  let i = 0;
  while (i < 24) {
    const h = (start + i) % 24;
    if (!set.has(h)) { i++; continue; }
    let j = i;
    while (j < 24 && set.has((start + j) % 24)) j++;
    parts.push(`${h}:00–${(start + j) % 24}:00`);
    i = j;
  }
  return parts.join('、');
}

// ============================================================ 回测

export interface TrackAccuracy {
  n: number;
  medianAbsErrSec: number;
  p80AbsErrSec: number;
  /** 真实值落在区间内的比例 */
  coverage: number;
  /** 误差中位数（正 = 预测偏晚） */
  biasSec: number;
}

export interface BacktestCase {
  submit: number;
  now: number;
  actual: number;
  etaMs: number;
  lowMs: number | null;
  highMs: number | null;
}

export function summarize(cases: { err: number; covered: boolean }[]): TrackAccuracy | null {
  if (!cases.length) return null;
  const abs = sortedCopy(cases.map((c) => Math.abs(c.err) / 1000));
  const errs = sortedCopy(cases.map((c) => c.err / 1000));
  return {
    n: cases.length,
    medianAbsErrSec: quantileSorted(abs, 0.5),
    p80AbsErrSec: quantileSorted(abs, 0.8),
    coverage: cases.filter((c) => c.covered).length / cases.length,
    biasSec: quantileSorted(errs, 0.5),
  };
}

/**
 * 滚动起点回测：取 [nowMs - lookbackH, nowMs] 内提交且已出分的样本，
 * 以「刚提交那一刻」为起点（信息集 = 当时已出分的样本）预测出分时刻，与真实值比较。
 * 多于 maxCases 条时等距抽样。工作时钟用全部数据学习（轻微前视，仅影响休息钟点识别）。
 */
export function backtestTrack(rows: Row[], nowMs: number, opts: { lookbackH?: number; maxCases?: number } = {}): TrackAccuracy | null {
  return backtestPrepared(prepare(rows), nowMs, opts);
}

export function backtestPrepared(P: Prepared, nowMs: number, opts: { lookbackH?: number; maxCases?: number } = {}): TrackAccuracy | null {
  const lookback = (opts.lookbackH ?? 24) * H;
  const maxCases = opts.maxCases ?? 80;
  const idx: number[] = [];
  for (let i = 0; i < P.s.length; i++) {
    if (P.t[i] >= nowMs - lookback && P.done[i] <= nowMs) idx.push(i);
  }
  if (!idx.length) return null;
  const step = idx.length > maxCases ? idx.length / maxCases : 1;
  const cases: { err: number; covered: boolean }[] = [];
  for (let k = 0; k < idx.length; k += step) {
    const i = idx[Math.floor(k)];
    const submit = P.t[i];
    const cut = countLE(P.done, submit);
    if (cut < 10) continue;
    const o = predictCore(P, cut, submit, submit);
    if (o.etaMs == null) continue;
    const actual = P.done[i];
    cases.push({ err: o.etaMs - actual, covered: o.lowMs != null && o.highMs != null && actual >= o.lowMs && actual <= o.highMs });
  }
  return summarize(cases);
}

// ============================================================ legacy（旧算法原样移植，作 baseline）

function qNearest(arr: number[], q: number): number {
  if (!arr.length) return 0;
  const s = sortedCopy(arr);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

/** 旧版 public/app.js predictQueue + predictEta 的忠实移植（含其原有缺陷），仅用于回测对比 */
export function predictLegacy(P: Prepared, cut: number, submit: number, now: number): CoreOut & { legacyKind: string } {
  const none = { kind: 'none' as const, legacyKind: 'none', etaMs: null, lowMs: null, highMs: null };
  if (cut < 1) return none;
  const pts = P.s.slice(0, cut);
  let win: { front: Sample; rate: number } | null = null;
  for (const h of [6, 24, 72]) {
    const set = pts.filter((p) => p.done >= now - h * H);
    if (set.length < 5) continue;
    const front = set[set.length - 1];
    const back = set[0];
    const dClockH = (front.done - back.done) / H;
    if (dClockH < 0.5) continue;
    const rate = (front.t - back.t) / (dClockH * H);
    if (!Number.isFinite(rate) || rate <= 0.05 || rate > 80) continue;
    win = { front, rate };
    break;
  }
  const durs = pts.slice(-60).map((p) => (p.done - p.t) / 1000);
  const medDur = qNearest(durs, 0.5);
  const p90Dur = qNearest(durs, 0.9);
  const tm = buildTimingModelFromSamples(pts.slice().sort((a, b) => a.t - b.t), now);
  const judgeKnown = tm.judge.kind === 'measured';
  const judgeSec = judgeKnown || tm.judge.sec >= 15 ? tm.judge.sec : 0;
  if (!win) {
    // 旧缺陷 1：快赛道判断在批量分支之后
    const bursts: { start: number; done: number }[] = [];
    for (const p of pts) {
      const last = bursts[bursts.length - 1];
      if (last && p.done - last.done <= 10 * 60e3) last.done = p.done;
      else bursts.push({ start: p.done, done: p.done });
    }
    const hours = [...new Set(bursts.slice(-12).map((x) => bj(x.start).h))];
    const from = Math.max(now, submit);
    const w = nextWindowBj(hours.length ? hours : [bj(pts[pts.length - 1].done).h], from);
    return { kind: 'queue', legacyKind: 'batch', etaMs: w, lowMs: w != null ? w - 45 * 60e3 : null, highMs: w != null ? w + 105 * 60e3 : null };
  }
  const r = win.rate;
  const frontPos = win.front.t + r * (now - win.front.done);
  if (medDur <= 15 * 60) {
    return { kind: 'queue', legacyKind: 'fast', etaMs: submit + medDur * 1000, lowMs: submit + Math.max(5, medDur * 0.5) * 1000, highMs: submit + Math.max(60, p90Dur) * 1000 };
  }
  if (submit <= frontPos) return { kind: 'overdue', legacyKind: 'overdue', etaMs: now, lowMs: null, highMs: null };
  const spread = r >= 2.5 ? 0.5 : 0.3;
  const jm = judgeSec * 1000;
  return {
    kind: 'queue',
    legacyKind: 'queue',
    etaMs: now + (submit - frontPos) / r + jm,
    lowMs: now + (submit - frontPos) / (r * (1 + spread)) + jm,
    highMs: now + (submit - frontPos) / (r * (1 - spread)) + jm,
  };
}

/** 北京时间：from 之后（允许早 30 分钟）最近的整点窗口 */
export function nextWindowBj(hours: number[], from: number): number | null {
  let best: number | null = null;
  const day0 = Math.floor((from + TZ_OFFSET_MS) / DAY) * DAY - TZ_OFFSET_MS;
  for (let day = 0; day < 4; day++) {
    for (const h of hours) {
      const ms = day0 + day * DAY + h * H;
      if (ms < from - 30 * 60e3) continue;
      if (best == null || ms < best) best = ms;
    }
  }
  return best;
}
