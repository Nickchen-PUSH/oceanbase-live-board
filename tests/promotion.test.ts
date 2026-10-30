import { describe, expect, test } from 'bun:test';
import type { Board, Row, Snapshot } from '../src/shared/types.ts';
import { promotionModel } from '../src/shared/promotion.ts';

let rid = 0;
function r(p: Partial<Row> & { name: string }): Row {
  return {
    rank: 1, school: '', advisor: '', province: '', score: null, rawScore: null,
    bestSubmit: null, updated: null, userId: null, groupId: null, recordId: ++rid, ...p,
  };
}
const board = (id: string, kind: Board['kind'], rows: Row[]): Board => ({
  id, title: id === 'total' ? '总榜' : `赛道${id}`, kind, questionId: null, rows, error: null, stale: false, reportedTotal: null, source: '',
});
const snap = (boards: Board[]): Snapshot => ({ campId: 1, generatedAt: '2026-10-30T08:00:00Z', boards });

describe('promotionModel', () => {
  // 三个赛道满分 10/20/30 → 总分满分 60
  const A = (rows: Row[]) => board('qA', 'track', rows);
  const B = (rows: Row[]) => board('qB', 'track', rows);
  const C = (rows: Row[]) => board('qC', 'track', rows);

  test('满分队、只差一个赛道（partial/zero/none）、差两个赛道', () => {
    const total = board('total', 'total', [
      r({ name: '全满', groupId: 1, score: 60 }),
      r({ name: '差C部分', groupId: 2, score: 45 }),
      r({ name: '差C零分', groupId: 3, score: 30 }),
      r({ name: '差B无记录', groupId: 4, score: 40 }),
      r({ name: '差两个', groupId: 5, score: 10 }),
    ]);
    const m = promotionModel(snap([
      total,
      A([1, 2, 3, 4, 5].map((g) => r({ name: `t${g}`, groupId: g, score: 10 }))),
      B([r({ name: 't1', groupId: 1, score: 20 }), r({ name: 't2', groupId: 2, score: 20 }), r({ name: 't3', groupId: 3, score: 20 })]),
      C([
        r({ name: 't1', groupId: 1, score: 30, bestSubmit: '2026-10-30T01:00:00Z' }),
        r({ name: 't2', groupId: 2, score: 15, bestSubmit: '2026-10-30T03:00:00Z' }),
        r({ name: 't3', groupId: 3, score: 0, bestSubmit: '2026-10-30T02:00:00Z' }),
        r({ name: 't4', groupId: 4, score: 30, bestSubmit: '2026-10-30T00:00:00Z' }),
        r({ name: '未出分', groupId: 9, score: null, bestSubmit: '2026-10-30T05:00:00Z' }),
      ]),
    ]))!;
    expect(m.fullTotal).toBe(60);
    expect(m.topTotal).toBe(60);
    expect(m.fullCount).toBe(1);
    expect(m.mismatch).toBe(false);
    expect(m.oneShort).toBe(3);
    expect(m.groups.map((g) => [g.boardId, g.count])).toEqual([['qC', 2], ['qB', 1]]);
    const gc = m.groups[0];
    expect(gc.full).toBe(30);
    expect(gc.partial.map((e) => e.total.name)).toEqual(['差C部分']);
    expect(gc.zero.map((e) => e.total.name)).toEqual(['差C零分']);
    expect(gc.zero[0].track!.score).toBe(0);
    // frontier 只看已出分记录：未出分那行 05:00 不算
    expect(gc.frontier).toBe(Date.parse('2026-10-30T03:00:00Z'));
    const gb = m.groups[1];
    expect(gb.none.map((e) => [e.total.name, e.track, e.status])).toEqual([['差B无记录', null, 'none']]);
  });

  test('按 groupId 关联：userId 不同、队名重名都不影响', () => {
    const total = board('total', 'total', [
      r({ name: '同名队', groupId: 1, userId: 'u-captain', score: 20 }),
      r({ name: '同名队', groupId: 2, userId: 'u-x', score: 10 }),
    ]);
    const m = promotionModel(snap([
      total,
      // 赛道记录由队员（另一个 userId）提交；另一个同名队拿了满分
      board('qA', 'track', [r({ name: '同名队', groupId: 2, userId: 'u-x', score: 10 }), r({ name: '同名队', groupId: 1, userId: 'u-member', score: 4 })]),
      board('qB', 'track', [r({ name: '同名队', groupId: 1, userId: 'u-member', score: 10 })]),
    ]))!;
    expect(m.fullTotal).toBe(20);
    expect(m.fullCount).toBe(1); // 20 分 = 满分
    // 第 2 队：A 满分、B 没有记录 → 只差 B（none）；不能因为同名而误配到第 1 队的 B 记录
    expect(m.oneShort).toBe(1);
    expect(m.groups[0].boardId).toBe('qB');
    expect(m.groups[0].none[0].total.groupId).toBe(2);
  });

  test('groupId 缺失时退回 userId；两边都有 groupId 且不同则不按 userId 配', () => {
    const total = board('total', 'total', [
      r({ name: 'x', groupId: null, userId: 'u1', score: 15 }),
      r({ name: 'y', groupId: 7, userId: 'u2', score: 5 }),
    ]);
    const m = promotionModel(snap([
      total,
      board('qA', 'track', [r({ name: 'x', userId: 'u1', groupId: null, score: 10 }), r({ name: 'z', userId: 'u2', groupId: 8, score: 10 })]),
      board('qB', 'track', [r({ name: 'x', userId: 'u1', groupId: null, score: 5 }), r({ name: 'y', userId: 'u2', groupId: 7, score: 10 })]),
    ]))!;
    expect(m.fullTotal).toBe(20);
    // x：A 满分、B 5 分 → 只差 B（partial）；y：A 里 u2 属于另一队（groupId 8）→ 视为无记录，只差 A
    const byBoard = Object.fromEntries(m.groups.map((g) => [g.boardId, g]));
    expect(byBoard.qB.partial.map((e) => e.total.name)).toEqual(['x']);
    expect(byBoard.qA.none.map((e) => e.total.name)).toEqual(['y']);
  });

  test('总榜最高分与各赛道满分之和不一致 → mismatch；缺榜 → null', () => {
    const m = promotionModel(snap([
      board('total', 'total', [r({ name: 'a', groupId: 1, score: 9 })]),
      board('qA', 'track', [r({ name: 'a', groupId: 1, score: 9 }), r({ name: 'b', groupId: 2, score: 10 })]),
    ]))!;
    expect(m.mismatch).toBe(true);
    expect(m.fullCount).toBe(0);
    expect(m.oneShort).toBe(1);
    expect(m.groups[0].partial).toHaveLength(1);
    expect(promotionModel(snap([board('total', 'total', [r({ name: 'a' })])]))).toBeNull();
    expect(promotionModel(snap([board('qA', 'track', [r({ name: 'a' })])]))).toBeNull();
  });

  test('有赛道一条已出分记录都没有（上游抓不到）→ missing 非空，不能悄悄当成没有这个赛道', () => {
    const m = promotionModel(snap([
      board('total', 'total', [r({ name: 'a', groupId: 1, score: 10 })]),
      board('qA', 'track', [r({ name: 'a', groupId: 1, score: 10 })]),
      board('qB', 'track', []),
      board('qC', 'track', [r({ name: 'a', groupId: 1, score: null })]),
    ]))!;
    expect(m.missing).toEqual(['赛道qB', '赛道qC']);
    expect(promotionModel(snap([
      board('total', 'total', [r({ name: 'a', groupId: 1, score: 10 })]),
      board('qA', 'track', [r({ name: 'a', groupId: 1, score: 10 })]),
    ]))!.missing).toEqual([]);
  });
});
