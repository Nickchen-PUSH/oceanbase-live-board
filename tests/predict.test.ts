import { describe, expect, test } from 'bun:test';
import type { Row } from '../src/shared/types.ts';
import { bj } from '../src/shared/format.ts';
import { countLE } from '../src/shared/stats.ts';
import { backtestTrack, fromWork, learnWorkClock, predict, predictCore, predictLegacy, prepare, toWork } from '../src/shared/predict.ts';
import { samplesOf } from '../src/shared/types.ts';

const MIN = 60e3;
const H = 3600e3;
const T0 = Date.parse('2026-10-28T01:00:00Z'); // 北京时间 09:00

function row(i: number, t: number, done: number): Row {
  return {
    rank: i + 1, name: `队伍${i}`, school: '', advisor: '', province: '', score: 1, rawScore: 1000,
    bestSubmit: new Date(t).toISOString(), updated: new Date(done).toISOString(),
    userId: null, groupId: i, recordId: i,
  };
}
function steady(n: number, every: number, dur: (i: number) => number, start = T0): Row[] {
  return Array.from({ length: n }, (_, i) => row(i, start + i * every * MIN, start + i * every * MIN + dur(i)));
}
const jitter = (i: number) => ((i * 7919) % 11) / 10 - 0.5; // 确定性的 −0.5..0.5

function checkShape(p: ReturnType<typeof predict>) {
  expect(p.notes.length).toBeGreaterThanOrEqual(2);
  expect(p.notes.length).toBeLessThanOrEqual(4);
  for (const s of [p.headline, ...p.notes]) expect(s).not.toMatch(/[<>]/);
  if (p.etaMs != null && p.lowMs != null && p.highMs != null) {
    expect(p.lowMs).toBeLessThanOrEqual(p.etaMs);
    expect(p.etaMs).toBeLessThanOrEqual(p.highMs);
  }
}

describe('predict', () => {
  test('样本不足 → none', () => {
    const p = predict(steady(2, 5, () => MIN), T0 + H, T0 + H);
    expect(p.kind).toBe('none');
    expect(p.etaMs).toBeNull();
    expect(p.headline).toContain('样本不足');
  });

  test('快赛道（旧 bug 1：快赛道优先于批量判断）', () => {
    const rows = steady(120, 4, (i) => (60 + 20 * jitter(i)) * 1000);
    const now = T0 + 120 * 4 * MIN;
    const p = predict(rows, now, now);
    expect(p.kind).toBe('fast');
    expect(Math.abs(p.etaMs! - (now + 60e3))).toBeLessThan(20e3);
    expect(p.confidence).not.toBe('low');
    checkShape(p);
  });

  test('固定 17 分钟评测：新模型不重复计入评测时间（旧模型偏晚约一个评测时长）', () => {
    const rows = steady(150, 6, (i) => (17 * 60 + 30 * jitter(i)) * 1000);
    const now = T0 + 150 * 6 * MIN;
    const p = predict(rows, now, now);
    expect(p.kind).toBe('queue');
    expect(Math.abs(p.etaMs! - (now + 17 * MIN))).toBeLessThan(MIN);
    expect(p.headline).toMatch(/^预计 .* 出分$/);
    expect(p.medTurnaroundSec!).toBeGreaterThan(16 * 60);
    expect(p.rate!).toBeGreaterThan(0.8);
    expect(p.rate!).toBeLessThan(1.2);
    checkShape(p);
    const P = prepare(rows);
    const old = predictLegacy(P, countLE(P.done, now), now, now);
    expect(old.etaMs! - now).toBeGreaterThan(25 * MIN); // 旧算法的已知缺陷，作为 baseline 保留
  });

  test('已等待超过近期几乎所有作业 → overdue', () => {
    const rows = steady(150, 6, (i) => (17 * 60 + 30 * jitter(i)) * 1000);
    const now = T0 + 150 * 6 * MIN;
    const p = predict(rows, now - 2 * H, now);
    expect(p.kind).toBe('overdue');
    expect(p.etaMs!).toBeGreaterThanOrEqual(now);
    checkShape(p);
  });

  test('工作时段零出分数小时 → stalled', () => {
    const rows = steady(100, 5, (i) => (2 * 60 + 20 * jitter(i)) * 1000);
    const lastDone = T0 + 99 * 5 * MIN + 2 * MIN;
    const now = lastDone + 5 * H;
    const p = predict(rows, now - 30 * MIN, now);
    expect(p.kind).toBe('stalled');
    expect(p.confidence).toBe('low');
    expect(p.headline).toContain('停摆');
    checkShape(p);
  });

  test('只在白天评测的赛道：学出休息钟点，夜间提交预测到次日上午（batch）', () => {
    // 北京时间 9:00–17:00 评测，每 20 分钟一次提交，白天 25 分钟出分；夜间提交次日 9:00 起依次出分
    const rows: Row[] = [];
    const day0 = Date.parse('2026-10-25T16:00:00Z'); // 北京 10-26 00:00
    let i = 0;
    let backlog = 0;
    for (let t = day0; t < day0 + 4 * 24 * H; t += 20 * MIN) {
      const h = bj(t).h;
      if (h >= 9 && h < 16) rows.push(row(i++, t, t + 25 * MIN));
      else {
        // 下一个北京 09:00
        let next = day0 + Math.floor((t - day0) / (24 * H)) * 24 * H + 9 * H;
        if (next <= t) next += 24 * H;
        rows.push(row(i++, t, next + (backlog++ % 40) * 2 * MIN));
      }
    }
    const wc = learnWorkClock(samplesOf(rows));
    expect(wc.always).toBe(false);
    expect(wc.offHours).toContain(3);
    expect(wc.offHours).not.toContain(10);
    const now = day0 + 3 * 24 * H + 20 * H; // 第 4 天北京 20:00
    const p = predict(rows.filter((r) => Date.parse(r.updated!) <= now), now, now);
    expect(p.kind).toBe('batch');
    expect(bj(p.etaMs!).h).toBeGreaterThanOrEqual(9);
    expect(bj(p.etaMs!).h).toBeLessThan(12);
    expect(p.etaMs! - now).toBeGreaterThan(12 * H);
    checkShape(p);
  });

  test('工作时钟换算可逆', () => {
    const wc = { on: Array.from({ length: 24 }, (_, h) => h >= 9 && h < 17), onHours: 8, always: false, offHours: [] };
    const t = Date.parse('2026-10-28T03:15:00Z'); // 北京 11:15
    expect(fromWork(wc, toWork(wc, t))).toBe(t);
    expect(toWork(wc, t + 2 * H) - toWork(wc, t)).toBe(2 * H);
    // 北京 16:30 → 次日 10:30 在工作时钟里只隔 2 小时
    const a = Date.parse('2026-10-28T08:30:00Z');
    expect(toWork(wc, a + 18 * H) - toWork(wc, a)).toBe(2 * H);
    // 休息时段的时刻映射到下一个工作小时起点
    const night = Date.parse('2026-10-28T14:00:00Z'); // 北京 22:00
    expect(fromWork(wc, toWork(wc, night))).toBe(Date.parse('2026-10-29T01:00:00Z'));
  });

  test('predictCore 的条件区间：已等待的部分不会再出现在区间里', () => {
    const rows = steady(200, 5, (i) => (10 * 60 + 300 * jitter(i)) * 1000);
    const P = prepare(rows);
    const now = T0 + 200 * 5 * MIN;
    const cut = countLE(P.done, now);
    const o = predictCore(P, cut, now - 9 * MIN, now);
    expect(o.lowMs!).toBeGreaterThanOrEqual(now);
  });
});

describe('backtestTrack', () => {
  test('稳定赛道：误差小、区间覆盖率合理', () => {
    const rows = steady(400, 4, (i) => (5 * 60 + 60 * jitter(i)) * 1000);
    const now = T0 + 400 * 4 * MIN + 10 * MIN;
    const a = backtestTrack(rows, now)!;
    expect(a).not.toBeNull();
    expect(a.n).toBeGreaterThan(30);
    expect(a.medianAbsErrSec).toBeLessThan(60);
    expect(a.coverage).toBeGreaterThan(0.6);
    expect(Math.abs(a.biasSec)).toBeLessThan(60);
  });

  test('无近期样本 → null', () => {
    expect(backtestTrack(steady(50, 4, () => MIN), T0 + 30 * 24 * H)).toBeNull();
  });

  test('性能：650 行 < 30ms', () => {
    const rows = steady(650, 3, (i) => (8 * 60 + 200 * jitter(i)) * 1000);
    const now = T0 + 650 * 3 * MIN;
    backtestTrack(rows, now); // 预热
    const t0 = performance.now();
    for (let k = 0; k < 11; k++) backtestTrack(rows, now);
    expect((performance.now() - t0) / 11).toBeLessThan(30);
  });
});
