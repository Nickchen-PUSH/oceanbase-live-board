// 晋级形势（移植自 PR #1 的 promotionModel）。
// 口径：
// - 各赛道满分 = 该赛道当前最高分；总分满分 = 各赛道满分之和。
// - 总分达到满分的队伍数 = fullCount；剩余名额 = 名额 − fullCount（名额由前端减，不进模型）。
// - 「只差一个赛道」= 其余赛道全部满分，只有一个赛道没满分；按该赛道的状态分
//   partial（有部分分）/ zero（有记录但 0 分）/ none（没有记录）。
// - frontier = 该赛道已出分记录里最晚的 bestSubmit（评测进度大致推进到这个提交时刻）。
// 修正：原实现按 userId + 队名关联总榜与赛道（userId 只命中约 65%，队名会误配）；
// 这里用 groupId 关联，groupId 缺失时才退回 userId，绝不用队名。

import type { Board, Row, Snapshot } from './types.ts';

export const PROMO_EPS = 1e-6;

export interface PromoEntry {
  total: Row;
  track: Row | null;
  status: 'partial' | 'zero' | 'none';
}

export interface PromoGroup {
  boardId: string;
  title: string;
  /** 该赛道满分（当前最高分） */
  full: number;
  /** = partial + zero + none 的条数 */
  count: number;
  partial: PromoEntry[];
  zero: PromoEntry[];
  none: PromoEntry[];
  /** 该赛道已出分记录里最晚的提交时刻（毫秒） */
  frontier: number | null;
}

export interface PromotionModel {
  /** 总分满分 = 各赛道满分之和 */
  fullTotal: number;
  /** 总榜当前最高分 */
  topTotal: number;
  /** 总分达到满分的队伍数 */
  fullCount: number;
  /** 按 count 降序、同数按赛道名 */
  groups: PromoGroup[];
  /** 只差一个赛道的队伍总数 */
  oneShort: number;
  /** 总榜最高分 ≠ 各赛道满分之和（总榜与赛道榜不同步，或无人全满） */
  mismatch: boolean;
  /**
   * 一条已出分记录都没有的赛道（通常是上游暂时抓不到）。非空时满分口径不完整：
   * 满分会被低估、满分队数虚高、剩余名额偏小，调用方不应给出数字。（PR #1 6805e82）
   */
  missing: string[];
}

/** 某赛道的关联索引：groupId 优先，userId 兜底 */
interface TrackIndex {
  board: Board;
  full: number;
  byGroup: Map<number, Row>;
  byUser: Map<string, Row>;
}

const better = (a: Row | undefined, b: Row): Row => (!a || (b.score ?? -Infinity) > (a.score ?? -Infinity) ? b : a);

function indexTrack(board: Board): TrackIndex {
  const byGroup = new Map<number, Row>();
  const byUser = new Map<string, Row>();
  let full = 0;
  for (const r of board.rows) {
    if (r.score != null && r.score > full) full = r.score;
    if (r.groupId != null) byGroup.set(r.groupId, better(byGroup.get(r.groupId), r));
    if (r.userId) byUser.set(r.userId, better(byUser.get(r.userId), r));
  }
  return { board, full, byGroup, byUser };
}

/** 在赛道里找总榜某队的记录。groupId 两边都有时只认 groupId；任一侧缺失才用 userId。 */
export function findTrackRow(ix: TrackIndex, total: Row): Row | null {
  if (total.groupId != null) {
    const hit = ix.byGroup.get(total.groupId);
    if (hit) return hit;
  }
  if (total.userId) {
    const u = ix.byUser.get(total.userId);
    if (u && (u.groupId == null || total.groupId == null)) return u;
  }
  return null;
}

function frontierOf(rows: Row[]): number | null {
  let best: number | null = null;
  for (const r of rows) {
    if (r.score == null || !r.bestSubmit) continue;
    const t = Date.parse(r.bestSubmit);
    if (Number.isFinite(t) && (best == null || t > best)) best = t;
  }
  return best;
}

export function promotionModel(snap: Snapshot): PromotionModel | null {
  const total = snap.boards.find((b) => b.kind === 'total');
  const allTracks = snap.boards.filter((b) => b.kind === 'track');
  const scored = (b: Board) => b.rows.some((r) => r.score != null);
  const tracks = allTracks.filter(scored);
  const missing = allTracks.filter((b) => !scored(b)).map((b) => b.title);
  if (!total || !total.rows.length || !tracks.length) return null;

  const idx = tracks.map(indexTrack);
  const fullTotal = idx.reduce((s, t) => s + t.full, 0);
  const topTotal = total.rows.reduce((m, r) => Math.max(m, r.score ?? 0), 0);

  const groups = new Map<string, PromoGroup>();
  for (const t of idx) {
    groups.set(t.board.id, {
      boardId: t.board.id, title: t.board.title, full: t.full, count: 0,
      partial: [], zero: [], none: [], frontier: frontierOf(t.board.rows),
    });
  }

  let fullCount = 0;
  for (const r of total.rows) {
    if ((r.score ?? 0) >= fullTotal - PROMO_EPS) {
      fullCount++;
      continue;
    }
    let missIx: TrackIndex | null = null;
    let missRow: Row | null = null;
    let misses = 0;
    for (const t of idx) {
      const hit = findTrackRow(t, r);
      if (!hit || (hit.score ?? 0) < t.full - PROMO_EPS) {
        if (++misses > 1) break;
        missIx = t;
        missRow = hit;
      }
    }
    if (misses !== 1 || !missIx) continue;
    const g = groups.get(missIx.board.id)!;
    const status: PromoEntry['status'] = !missRow ? 'none' : (missRow.score ?? 0) > 0 ? 'partial' : 'zero';
    g[status].push({ total: r, track: missRow, status });
    g.count++;
  }

  const list = [...groups.values()].filter((g) => g.count > 0);
  for (const g of list) {
    // 部分分里分数高的在前；其余保持总榜顺序
    g.partial.sort((a, b) => (b.track?.score ?? 0) - (a.track?.score ?? 0) || a.total.rank - b.total.rank);
  }
  list.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, 'zh-CN'));

  return {
    fullTotal,
    topTotal,
    fullCount,
    groups: list,
    oneShort: list.reduce((s, g) => s + g.count, 0),
    mismatch: Math.abs(topTotal - fullTotal) > PROMO_EPS,
    missing,
  };
}
