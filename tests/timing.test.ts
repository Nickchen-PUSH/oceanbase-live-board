import { describe, expect, test } from 'bun:test';
import type { Row } from '../src/shared/types.ts';
import { agg, buildTimingModel, detectPauses, overlapMs, pauseThreshold } from '../src/shared/timing.ts';
import { countLE, median, quantile, theilSen } from '../src/shared/stats.ts';

const T0 = Date.parse('2026-10-29T02:00:00Z'); // 北京时间 10:00
const MIN = 60e3;

export function row(i: number, t: number, done: number): Row {
  return {
    rank: i + 1, name: `队伍${i}`, school: '', advisor: '', province: '', score: 1, rawScore: 1000,
    bestSubmit: new Date(t).toISOString(), updated: new Date(done).toISOString(),
    userId: null, groupId: i, recordId: i,
  };
}

/** 每 every 分钟一条提交，耗时 dur(i) 毫秒 */
export function steady(n: number, every: number, dur: (i: number) => number, start = T0): Row[] {
  return Array.from({ length: n }, (_, i) => row(i, start + i * every * MIN, start + i * every * MIN + dur(i)));
}

describe('stats', () => {
  test('quantile / median 线性插值', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(quantile([0, 10], 0.9)).toBeCloseTo(9);
  });
  test('countLE 二分', () => {
    const a = [1, 2, 2, 5];
    expect(countLE(a, 2)).toBe(3);
    expect(countLE(a, 0)).toBe(0);
    expect(countLE(a, 9)).toBe(4);
  });
  test('Theil–Sen 抗离群', () => {
    const xs = Array.from({ length: 20 }, (_, i) => i);
    const ys = xs.map((x) => 2 * x + 1);
    ys[5] = 1000;
    const r = theilSen(xs, ys)!;
    expect(r.slope).toBeCloseTo(2, 5);
    expect(r.intercept).toBeCloseTo(1, 5);
  });
});

describe('timing', () => {
  test('稳定赛道：耗时、近期窗口、无暂停', () => {
    const rows = steady(60, 5, () => 2 * MIN);
    const now = T0 + 60 * 5 * MIN;
    const m = buildTimingModel(rows, { now });
    expect(m.insufficient).toBe(false);
    expect(m.pts.length).toBe(60);
    expect(m.pauses).toEqual([]);
    expect(agg(m.pts.map((p) => p.sec), 'median')).toBe(120);
    expect(m.latest?.sec).toBe(120);
    expect(m.recent.stale).toBe(false);
    for (let i = 1; i < m.pts.length; i++) expect(m.pts[i].t).toBeGreaterThanOrEqual(m.pts[i - 1].t);
    for (const p of m.pts) expect(p.judge + p.queue).toBeCloseTo(p.sec, 6);
  });

  test('recent 相对 now：赛道停摆数小时后标记 stale / stalled（旧 bug 5）', () => {
    const rows = steady(60, 5, () => 2 * MIN);
    const lastDone = T0 + 59 * 5 * MIN + 2 * MIN;
    const m = buildTimingModel(rows, { now: lastDone + 6 * 3600e3 });
    expect(m.recent.stale).toBe(true);
    expect(m.stalled).toBe(true);
    expect(m.idleSec).toBe(6 * 3600);
  });

  test('评测暂停：识别窗口并从耗时中扣除', () => {
    // 前 40 条正常；第 40~49 条提交后遇到 5 小时暂停，恢复后集中出分；之后恢复正常
    const rows: Row[] = [];
    let i = 0;
    for (; i < 40; i++) rows.push(row(i, T0 + i * 3 * MIN, T0 + i * 3 * MIN + MIN));
    const stop = T0 + 40 * 3 * MIN;
    const resume = stop + 5 * 3600e3;
    for (let k = 0; k < 10; k++, i++) rows.push(row(i, stop + k * 3 * MIN, resume + k * 20e3));
    for (let k = 0; k < 40; k++, i++) {
      const t = resume + 30 * MIN + k * 3 * MIN;
      rows.push(row(i, t, t + MIN));
    }
    const dones = rows.map((r) => Date.parse(r.updated!)).sort((a, b) => a - b);
    const pz = detectPauses(dones);
    expect(pz.length).toBe(1);
    expect(pz[0][1] - pz[0][0]).toBeGreaterThan(4 * 3600e3);
    expect(pauseThreshold(dones).thresholdMs).toBeGreaterThanOrEqual(3600e3);
    const m = buildTimingModel(rows, { now: dones[dones.length - 1] + MIN });
    expect(m.cleanup.pausedN).toBeGreaterThanOrEqual(9);
    expect(m.cleanup.deductSec).toBeGreaterThan(9 * 4 * 3600);
    // 扣除暂停后，没有样本残留「几小时」的耗时
    expect(Math.max(...m.pts.map((p) => p.sec))).toBeLessThan(3600);
    expect(m.pauses.length).toBe(1);
  });

  test('overlapMs', () => {
    expect(overlapMs(0, 10, [[5, 20]])).toBe(5);
    expect(overlapMs(0, 10, [[1, 2], [3, 4]])).toBe(2);
    expect(overlapMs(0, 10, [[20, 30]])).toBe(0);
  });

  test('极端异常值被剔除并单独计数（旧 bug 4：不与「扣暂停后为 0」混在一起）', () => {
    const rows = steady(80, 5, (i) => (i === 30 ? 50 * 3600e3 : 90e3));
    const m = buildTimingModel(rows, { now: T0 + 100 * 5 * MIN });
    expect(m.cleanup.outlierN).toBe(1);
    expect(m.cleanup.rawN).toBe(80);
    expect(m.cleanup.keptN).toBe(79);
    expect(m.cleanup.zeroedN).toBe(0);
  });

  test('样本不足', () => {
    const m = buildTimingModel(steady(2, 5, () => MIN), { now: T0 + 3600e3 });
    expect(m.insufficient).toBe(true);
  });

  test('series 滚动窗口', () => {
    const m = buildTimingModel(steady(200, 2, (i) => (60 + (i % 7) * 10) * 1000), { now: T0 + 500 * MIN });
    expect(m.series.length).toBeGreaterThan(5);
    for (const s of m.series) {
      expect(s.totals.length).toBe(s.n);
      expect(s.judges.length).toBe(s.n);
      expect(s.queues.length).toBe(s.n);
    }
  });

  test('性能：650 行 × 11 赛道 < 60ms', () => {
    const rows = steady(650, 3, (i) => (120 + (i % 13) * 30) * 1000);
    const t0 = performance.now();
    for (let k = 0; k < 11; k++) buildTimingModel(rows, { now: T0 + 2000 * 3 * MIN });
    expect(performance.now() - t0).toBeLessThan(60);
  });
});
