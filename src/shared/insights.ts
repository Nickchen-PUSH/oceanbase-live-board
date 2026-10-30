// 榜单洞察：学校统计、分数分布、分数线、下一档差距、快照差分、最近动态。纯函数，无依赖。

import type { Row, Snapshot } from './types.ts';

const EPS = 1e-9;

/** 跨快照 / 跨榜识别同一支队伍：groupId 优先，其次 userId，最后队名 */
export const rowKey = (r: Row): string =>
  r.groupId != null ? `g${r.groupId}` : r.userId ? `u${r.userId}` : `n${r.name}`;

const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** 0.1 + 0.2 之类的浮点噪声：成绩是 rawScore/1000，按 1e-6 取整足够 */
const tidy = (x: number) => Math.round(x * 1e6) / 1e6;

// ───────────────────────────── 学校统计 ─────────────────────────────

export interface SchoolStat {
  /** '' = 未填 */
  school: string;
  teams: number;
  bestRank: number | null;
  /** 排名前 10 的队伍数 */
  top10: number;
  /** 有分队伍的平均分 */
  avgScore: number | null;
  /** 出现过的省份，按队伍数降序 */
  provinces: string[];
  /** 该校最好名次队伍的队名 */
  leader: string | null;
}

export function schoolStats(rows: Row[]): SchoolStat[] {
  interface Acc { teams: number; best: Row | null; top10: number; sum: number; scored: number; prov: Map<string, number> }
  const by = new Map<string, Acc>();
  for (const r of rows) {
    const key = (r.school ?? '').trim();
    let a = by.get(key);
    if (!a) by.set(key, (a = { teams: 0, best: null, top10: 0, sum: 0, scored: 0, prov: new Map() }));
    a.teams++;
    if (r.rank > 0 && (!a.best || r.rank < a.best.rank)) a.best = r;
    if (r.rank > 0 && r.rank <= 10) a.top10++;
    if (r.score != null) { a.sum += r.score; a.scored++; }
    const p = (r.province ?? '').trim();
    if (p) a.prov.set(p, (a.prov.get(p) ?? 0) + 1);
  }
  const out: SchoolStat[] = [];
  for (const [school, a] of by) {
    out.push({
      school,
      teams: a.teams,
      bestRank: a.best?.rank ?? null,
      top10: a.top10,
      avgScore: a.scored ? tidy(a.sum / a.scored) : null,
      provinces: [...a.prov].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], 'zh-CN')).map((x) => x[0]),
      leader: a.best?.name ?? null,
    });
  }
  out.sort((x, y) =>
    (x.school === '' ? 1 : 0) - (y.school === '' ? 1 : 0) ||
    y.teams - x.teams ||
    (x.bestRank ?? Infinity) - (y.bestRank ?? Infinity) ||
    x.school.localeCompare(y.school, 'zh-CN'));
  return out;
}

// ───────────────────────────── 分数分布 ─────────────────────────────

export interface HistogramBin {
  lo: number;
  hi: number;
  count: number;
  /** true = 单值箱（lo === hi），用于把大量集中在满分 / 最低分的队伍单独显示 */
  point?: boolean;
}

export interface Histogram {
  /** 升序；普通箱为 [lo, hi)，最后一个普通箱含 hi（若 hi 没被单值箱占用） */
  bins: HistogramBin[];
  maxCount: number;
  min: number;
  max: number;
}

/**
 * 有分的行做直方图。
 * - 不同分值 ≤ binCount 个（离散计分的赛道）：每个分值一个单值箱。
 * - 否则：最高分 / 最低分各自人数 ≥ max(3, 5%) 时单独成「单值箱」（满分 / 0 分扎堆），
 *   其余分数在 [min, max] 上等宽分 binCount 箱。
 */
export function scoreHistogram(rows: Row[], binCount = 10): Histogram {
  const xs: number[] = [];
  for (const r of rows) if (r.score != null && Number.isFinite(r.score)) xs.push(r.score);
  if (!xs.length) return { bins: [], maxCount: 0, min: 0, max: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (const x of xs) { if (x < min) min = x; if (x > max) max = x; }
  // 离散分数（如只有 0/10/20/30 四档）：每个取值一个单值箱，比等宽分箱直观得多
  const distinct = new Map<number, number>();
  for (const x of xs) {
    const v = tidy(x);
    distinct.set(v, (distinct.get(v) ?? 0) + 1);
    if (distinct.size > binCount) break;
  }
  if (distinct.size <= Math.max(1, binCount)) {
    const bins = [...distinct].sort((p, q) => p[0] - q[0]).map(([v, count]) => ({ lo: v, hi: v, count, point: true }));
    return { bins, maxCount: bins.reduce((m, b) => Math.max(m, b.count), 0), min, max };
  }

  const spike = Math.max(3, Math.ceil(xs.length * 0.05));
  const nMin = xs.filter((x) => x - min < EPS).length;
  const nMax = xs.filter((x) => max - x < EPS).length;
  const lowPoint = nMin >= spike;
  const highPoint = nMax >= spike;

  const k = Math.max(1, Math.floor(binCount));
  const w = (max - min) / k;
  const mid: HistogramBin[] = Array.from({ length: k }, (_, i) => ({
    lo: tidy(min + i * w),
    hi: i === k - 1 ? max : tidy(min + (i + 1) * w),
    count: 0,
  }));
  let midN = 0;
  for (const x of xs) {
    if (lowPoint && x - min < EPS) continue;
    if (highPoint && max - x < EPS) continue;
    mid[Math.min(k - 1, Math.floor((x - min) / w))].count++;
    midN++;
  }
  const bins: HistogramBin[] = [];
  if (lowPoint) bins.push({ lo: min, hi: min, count: nMin, point: true });
  if (midN) bins.push(...mid);
  if (highPoint) bins.push({ lo: max, hi: max, count: nMax, point: true });
  return { bins, maxCount: bins.reduce((m, b) => Math.max(m, b.count), 0), min, max };
}

// ───────────────────────────── 分数线 / 下一档 ─────────────────────────────

export interface Cutoff {
  n: number;
  /** 第 n 名（按名次排序后的第 n 行）的分数；人数不足为 null */
  score: number | null;
}

const byRank = (rows: Row[]) =>
  [...rows].sort((a, b) => a.rank - b.rank || (b.score ?? -Infinity) - (a.score ?? -Infinity));

export function cutoffs(rows: Row[], ns: number[] = [10, 50, 100]): Cutoff[] {
  const sorted = byRank(rows);
  return ns.map((n) => ({ n, score: n >= 1 && n <= sorted.length ? sorted[n - 1].score ?? null : null }));
}

/** 档位从差到好；已在前 10 则看前 3 / 第 1 */
export const TIERS = [100, 50, 10, 3, 1];

/**
 * 到下一档（比当前名次更好的最近一档）需要涨多少分。
 * 名次是竞赛排名（同分并列），所以追平第 targetRank 行的分数即进入该档。
 * 已是第 1 名 / 数据不足时返回 null。
 */
export function nextTier(row: Row, rows: Row[]): { targetRank: number; targetScore: number; gap: number } | null {
  if (!(row.rank > 1)) return null;
  const target = [...TIERS].find((t) => t < row.rank);
  if (target == null) return null;
  const sorted = byRank(rows);
  const s = sorted[target - 1]?.score;
  if (s == null) return null;
  return { targetRank: target, targetScore: s, gap: Math.max(0, tidy(s - (row.score ?? 0))) };
}

// ───────────────────────────── 快照差分 ─────────────────────────────

export type ChangeKind = 'new' | 'up' | 'down' | 'rank';

export interface Change {
  boardId: string;
  boardTitle: string;
  key: string;
  name: string;
  province: string;
  school: string;
  prevScore: number | null;
  score: number | null;
  prevRank: number | null;
  rank: number;
  /** new / up / down：row.updated（毫秒，缺失时用 detectedAt）；rank：detectedAt */
  at: number;
  /** = diffSnapshots 的 detectedAt 参数 */
  detectedAt: number;
  /** new = 新上榜；up / down = 分数涨 / 跌；rank = 分数没变、只有名次变了 */
  kind: ChangeKind;
  /** = (kind === 'new') */
  isNew: boolean;
}

const KIND_ORDER: Record<ChangeKind, number> = { new: 0, up: 1, down: 2, rank: 3 };

/**
 * 两份快照之间每个榜的变化：新上榜、分数变化、只名次变化。
 * 只比较两边都存在的榜（新出现的榜不算，否则首屏会刷出整榜）。
 * 排序：分数类变化（new/up/down）在前，按 at 降序；名次变化在后，按名次升序。
 */
export function diffSnapshots(prev: Snapshot, next: Snapshot, detectedAt: number): Change[] {
  const prevBoards = new Map(prev.boards.map((b) => [b.id, b]));
  const out: Change[] = [];
  for (const b of next.boards) {
    const pb = prevBoards.get(b.id);
    if (!pb) continue;
    const old = new Map<string, Row>();
    for (const r of pb.rows) old.set(rowKey(r), r);
    for (const r of b.rows) {
      const key = rowKey(r);
      const p = old.get(key);
      let kind: ChangeKind;
      if (!p) kind = 'new';
      else {
        const a = p.score ?? 0;
        const c = r.score ?? 0;
        if (c - a > EPS) kind = 'up';
        else if (a - c > EPS) kind = 'down';
        else if (p.rank !== r.rank) kind = 'rank';
        else continue;
      }
      const upd = ms(r.updated);
      out.push({
        boardId: b.id,
        boardTitle: b.title,
        key,
        name: r.name,
        province: r.province,
        school: r.school,
        prevScore: p ? p.score : null,
        score: r.score,
        prevRank: p ? p.rank : null,
        rank: r.rank,
        at: kind === 'rank' ? detectedAt : upd ?? detectedAt,
        detectedAt,
        kind,
        isNew: kind === 'new',
      });
    }
  }
  out.sort((x, y) => {
    const xr = x.kind === 'rank' ? 1 : 0;
    const yr = y.kind === 'rank' ? 1 : 0;
    if (xr !== yr) return xr - yr;
    if (xr) return x.rank - y.rank;
    return y.at - x.at || KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.rank - y.rank;
  });
  return out;
}

// ───────────────────────────── 最近动态 ─────────────────────────────

export interface FeedItem {
  boardId: string;
  boardTitle: string;
  name: string;
  key: string;
  province: string;
  score: number | null;
  rank: number;
  /** row.updated 毫秒 = 出分 / 提分时刻 */
  at: number;
}

/** 只看赛道榜：updated ≥ sinceMs 的行（最近出分或提分），按 at 降序，最多 limit 条 */
export function recentScores(snap: Snapshot, sinceMs: number, limit = 50): FeedItem[] {
  const out: FeedItem[] = [];
  for (const b of snap.boards) {
    if (b.kind !== 'track') continue;
    for (const r of b.rows) {
      const at = ms(r.updated);
      if (at == null || at < sinceMs) continue;
      out.push({ boardId: b.id, boardTitle: b.title, name: r.name, key: rowKey(r), province: r.province, score: r.score, rank: r.rank, at });
    }
  }
  out.sort((a, b) => b.at - a.at || a.rank - b.rank);
  return out.slice(0, Math.max(0, limit));
}
