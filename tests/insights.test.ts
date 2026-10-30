import { describe, expect, test } from 'bun:test';
import type { Board, Row, Snapshot } from '../src/shared/types.ts';
import { cutoffs, diffSnapshots, nextTier, recentScores, rowKey, schoolStats, scoreHistogram } from '../src/shared/insights.ts';

function r(p: Partial<Row> & { name: string }): Row {
  return {
    rank: 1, school: '', advisor: '', province: '', score: null, rawScore: null,
    bestSubmit: null, updated: null, userId: null, groupId: null, recordId: null, ...p,
  };
}
const board = (id: string, kind: Board['kind'], rows: Row[]): Board => ({
  id, title: `榜${id}`, kind, questionId: null, rows, error: null, stale: false, reportedTotal: null, source: '',
});
const snap = (boards: Board[]): Snapshot => ({ campId: 1, generatedAt: '2026-10-30T08:00:00Z', boards });
/** 按分降序生成竞赛排名 */
function ranked(scores: number[]): Row[] {
  const s = [...scores].sort((a, b) => b - a);
  return s.map((score, i) => r({ name: `t${i}`, groupId: i, score, rank: s.indexOf(score) + 1 }));
}

describe('rowKey', () => {
  test('groupId > userId > 队名', () => {
    expect(rowKey(r({ name: 'a', groupId: 5, userId: 'u' }))).toBe('g5');
    expect(rowKey(r({ name: 'a', groupId: 0 }))).toBe('g0');
    expect(rowKey(r({ name: 'a', userId: 'u9' }))).toBe('uu9');
    expect(rowKey(r({ name: 'a' }))).toBe('na');
  });
});

describe('schoolStats', () => {
  test('聚合、排序、未填最后', () => {
    const rows = [
      r({ name: 'A1', school: '甲大学', province: '四川省', rank: 3, score: 90 }),
      r({ name: 'A2', school: '甲大学', province: '四川省', rank: 12, score: 70 }),
      r({ name: 'A3', school: ' 甲大学 ', province: '重庆市', rank: 40, score: null }),
      r({ name: 'B1', school: '乙大学', province: '北京市', rank: 1, score: 100 }),
      r({ name: 'B2', school: '乙大学', province: '北京市', rank: 2, score: 95 }),
      r({ name: 'N1', school: '', rank: 5, score: 85 }),
      r({ name: 'N2', school: '', rank: 6, score: 80 }),
      r({ name: 'N3', school: '', rank: 7, score: 80 }),
    ];
    const s = schoolStats(rows);
    expect(s.map((x) => x.school)).toEqual(['甲大学', '乙大学', '']);
    expect(s[0]).toEqual({ school: '甲大学', teams: 3, bestRank: 3, top10: 1, avgScore: 80, provinces: ['四川省', '重庆市'], leader: 'A1' });
    expect(s[1].top10).toBe(2);
    expect(s[1].leader).toBe('B1');
    expect(s[2].teams).toBe(3);
  });
});

describe('scoreHistogram', () => {
  test('空 / 单值', () => {
    expect(scoreHistogram([r({ name: 'a' })]).bins).toEqual([]);
    const h = scoreHistogram([r({ name: 'a', score: 5 }), r({ name: 'b', score: 5 })]);
    expect(h.bins).toEqual([{ lo: 5, hi: 5, count: 2, point: true }]);
  });

  test('离散计分：每个分值一个箱', () => {
    const h = scoreHistogram(ranked([0, 10, 10, 20, 30, 30, 30]));
    expect(h.bins.map((b) => [b.lo, b.count])).toEqual([[0, 1], [10, 2], [20, 1], [30, 3]]);
    expect(h.maxCount).toBe(3);
  });

  test('连续分数 + 满分扎堆：满分单独一箱，总数守恒', () => {
    const scores = [...Array.from({ length: 50 }, (_, i) => i * 1.7), ...Array(30).fill(100)];
    const h = scoreHistogram(ranked(scores), 10);
    const last = h.bins.at(-1)!;
    expect(last).toEqual({ lo: 100, hi: 100, count: 30, point: true });
    expect(h.bins.reduce((s, b) => s + b.count, 0)).toBe(80);
    expect(h.bins.length).toBe(11);
    expect(h.min).toBe(0);
    expect(h.max).toBe(100);
    for (const b of h.bins.slice(0, -1)) expect(b.hi).toBeGreaterThan(b.lo);
  });

  test('最高分不扎堆时归入最后一个普通箱', () => {
    const scores = Array.from({ length: 40 }, (_, i) => i + 0.5);
    const h = scoreHistogram(ranked(scores), 4);
    expect(h.bins.map((b) => b.count)).toEqual([10, 10, 10, 10]);
    expect(h.bins.some((b) => b.point)).toBe(false);
  });
});

describe('cutoffs / nextTier', () => {
  const rows = ranked(Array.from({ length: 120 }, (_, i) => 200 - i)); // 200, 199, …, 81
  test('第 n 名的分数，人数不足为 null', () => {
    expect(cutoffs(rows)).toEqual([{ n: 10, score: 191 }, { n: 50, score: 151 }, { n: 100, score: 101 }]);
    expect(cutoffs(rows.slice(0, 30), [10, 50])).toEqual([{ n: 10, score: 191 }, { n: 50, score: null }]);
    // 传入顺序被打乱也按名次取
    expect(cutoffs([...rows].reverse(), [1])[0].score).toBe(200);
  });

  test('下一档：前100/50/10，进前10后看前3/第1', () => {
    expect(nextTier(rows[109], rows)).toEqual({ targetRank: 100, targetScore: 101, gap: 10 });
    expect(nextTier(rows[60], rows)).toEqual({ targetRank: 50, targetScore: 151, gap: 11 });
    expect(nextTier(rows[30], rows)!.targetRank).toBe(10);
    expect(nextTier(rows[5], rows)).toEqual({ targetRank: 3, targetScore: 198, gap: 3 });
    expect(nextTier(rows[2], rows)).toEqual({ targetRank: 1, targetScore: 200, gap: 2 });
    expect(nextTier(rows[0], rows)).toBeNull();
  });

  test('并列：追平即进档；浮点差不出噪声', () => {
    const t = [r({ name: 'a', rank: 1, score: 0.3 }), r({ name: 'b', rank: 2, score: 0.1 + 0.2 - 0.2 })];
    expect(nextTier(t[1], t)!.gap).toBe(0.2);
  });
});

describe('diffSnapshots', () => {
  const prev = snap([
    board('total', 'total', [
      r({ name: 'A', groupId: 1, score: 50, rank: 1 }),
      r({ name: 'B', groupId: 2, score: 40, rank: 2 }),
      r({ name: 'C', groupId: 3, score: 30, rank: 3 }),
      r({ name: 'D', groupId: 4, score: 20, rank: 4 }),
    ]),
    board('qX', 'track', [r({ name: 'A', groupId: 1, score: 10, rank: 1 })]),
  ]);
  const next = snap([
    board('total', 'total', [
      r({ name: 'C', groupId: 3, score: 60, rank: 1, updated: '2026-10-30T07:00:00Z' }),
      r({ name: 'A', groupId: 1, score: 50, rank: 2 }),
      r({ name: 'B', groupId: 2, score: 35, rank: 3, updated: '2026-10-30T07:30:00Z' }),
      r({ name: 'D', groupId: 4, score: 20, rank: 4 }),
      r({ name: 'E', groupId: 5, score: 5, rank: 5, updated: '2026-10-30T06:00:00Z' }),
    ]),
    board('qX', 'track', [r({ name: 'A', groupId: 1, score: 10, rank: 1 })]),
    board('qNew', 'track', [r({ name: 'A', groupId: 1, score: 1, rank: 1 })]),
  ]);
  const at = Date.parse('2026-10-30T08:00:00Z');
  const d = diffSnapshots(prev, next, at);

  test('new / up / down / rank 分类，未变的不出现，新出现的榜不算', () => {
    const k = Object.fromEntries(d.map((c) => [c.name, c.kind]));
    expect(k).toEqual({ C: 'up', A: 'rank', B: 'down', E: 'new' });
    expect(d.every((c) => c.boardId === 'total' && c.detectedAt === at && c.isNew === (c.kind === 'new'))).toBe(true);
  });

  test('字段与排序：分数变化按 at 降序在前，名次变化在后', () => {
    expect(d.map((c) => c.name)).toEqual(['B', 'C', 'E', 'A']);
    const c = d.find((x) => x.name === 'C')!;
    expect(c).toMatchObject({ key: 'g3', prevScore: 30, score: 60, prevRank: 3, rank: 1, at: Date.parse('2026-10-30T07:00:00Z') });
    const e = d.find((x) => x.name === 'E')!;
    expect(e).toMatchObject({ prevScore: null, prevRank: null, isNew: true });
    expect(d.find((x) => x.name === 'A')!.at).toBe(at);
  });

  test('updated 缺失时 at 用检测时刻', () => {
    const p = snap([board('qX', 'track', [])]);
    const n = snap([board('qX', 'track', [r({ name: 'Z', userId: 'u1', score: 3, rank: 1 })])]);
    expect(diffSnapshots(p, n, 123)[0]).toMatchObject({ key: 'uu1', at: 123, kind: 'new' });
  });
});

describe('recentScores', () => {
  const s = snap([
    board('total', 'total', [r({ name: '总', score: 9, updated: '2026-10-30T07:59:00Z' })]),
    board('q1', 'track', [
      r({ name: 'a', groupId: 1, score: 3, rank: 2, updated: '2026-10-30T07:10:00Z' }),
      r({ name: 'b', groupId: 2, score: 5, rank: 1, updated: '2026-10-30T07:40:00Z' }),
      r({ name: 'old', groupId: 3, score: 1, rank: 3, updated: '2026-10-29T07:40:00Z' }),
      r({ name: 'none', groupId: 4, score: null, rank: 4, updated: null }),
    ]),
    board('q2', 'track', [r({ name: 'c', groupId: 1, score: 7, rank: 1, updated: '2026-10-30T07:20:00Z', province: '四川省' })]),
  ]);
  const since = Date.parse('2026-10-30T07:00:00Z');

  test('只看赛道、按时间降序、limit', () => {
    const f = recentScores(s, since);
    expect(f.map((x) => x.name)).toEqual(['b', 'c', 'a']);
    expect(f[1]).toEqual({ boardId: 'q2', boardTitle: '榜q2', name: 'c', key: 'g1', province: '四川省', score: 7, rank: 1, at: Date.parse('2026-10-30T07:20:00Z') });
    expect(recentScores(s, since, 2).map((x) => x.name)).toEqual(['b', 'c']);
    expect(recentScores(s, since, 0)).toEqual([]);
  });
});
