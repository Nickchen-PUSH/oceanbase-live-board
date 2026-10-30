// 全项目共享的数据契约：上游归一化 → 服务端 / Worker → 前端 / 分析模块。

/** 榜单上的一行（总榜 = 一支队伍；赛道榜 = 该队伍在这个赛道的最优记录） */
export interface Row {
  /** 本看板按成绩重算的名次（同分并列，竞赛排名 1,1,3…） */
  rank: number;
  name: string;
  school: string;
  advisor: string;
  /** 省份全称（如「四川省」）；上游缺失且无法从总榜补齐时为空串 */
  province: string;
  /** 页面显示成绩（webTotalScore） */
  score: number | null;
  /** 原始整数成绩（totalScore，= score × 1000） */
  rawScore: number | null;
  /**
   * gmtCreate（UTC ISO）。
   * 赛道榜：该队「最优那次提交」的提测时刻（分数提升时随之变化，实测 2026-10-29→30 两份快照完全一致）。
   * 总榜：聚合记录的创建时刻。
   */
  bestSubmit: string | null;
  /**
   * gmtModified（UTC ISO）。
   * 赛道榜：最优那次提交的出分（写库）时刻 —— 与 bestSubmit 的差就是这次提交的端到端耗时。
   * 总榜：聚合记录最后一次更新。
   */
  updated: string | null;
  userId: string | null;
  /** 队伍 id：总榜与赛道榜之间唯一可靠的关联键（userId 只是某个提交成员，关联率仅 ~65%） */
  groupId: number | null;
  recordId: number | null;
}

export type BoardKind = 'total' | 'track';

export interface Board {
  /** 'total' 或 'q<questionId>' */
  id: string;
  title: string;
  kind: BoardKind;
  questionId: number | null;
  rows: Row[];
  /** 上游抓取失败的错误信息（此时 rows 可能是最后一次成功的数据，见 stale） */
  error: string | null;
  /** true = 上游抖动，rows 是最后一次成功的数据 */
  stale: boolean;
  /** 上游报告的总数（总榜可信；赛道榜只是本次返回条数） */
  reportedTotal: number | null;
  /** 源站页面 */
  source: string;
}

export interface StaticBuildInfo {
  builtAt: string;
  builtBy: string;
  fetchMs: number;
  brokenBoards: { id: string; title: string; error: string | null }[];
}

export interface Snapshot {
  campId: number;
  /** 本快照生成时刻（UTC ISO） */
  generatedAt: string;
  /** boards[0] 恒为总榜，其余赛道按参与人数降序 */
  boards: Board[];
  /** 仅 GitHub Pages 构建产物带 */
  static?: StaticBuildInfo;
  /** 由推送中枢（Worker Durable Object / Bun WebSocket）下发时带 */
  push?: PushInfo;
}

export interface PushInfo {
  intervalMs: number;
  clients: number;
}

/** /api/online */
export interface OnlineInfo {
  sockets: number;
  lastPush: number | null;
  intervalMs: number;
}

/** /api/health */
export interface HealthInfo {
  ok: true;
  campId: number;
  cacheTtlMs: number;
  at: string;
  runtime: 'bun' | 'cloudflare-worker';
  push: { intervalMs: number } | null;
  stats: boolean;
}

/** 前端打点事件（/api/hit，sendBeacon text/plain） */
export type HitKind = 'pv' | 'board' | 'csv' | 'out' | 'predict' | 'province';
export interface HitEvent {
  k: HitKind;
  /** 榜单 id / 省份名等 */
  t?: string;
  /** document.referrer（仅 pv） */
  r?: string;
}

export interface StatsDay {
  day: string;
  pv: number;
  uv: number;
  csv: number;
  out: number;
  pred: number;
  prov: number;
}

export interface NamedCount {
  name: string;
  count: number;
}

/** /api/stats */
export interface StatsSummary {
  ok: true;
  days: number;
  today: StatsDay;
  series: StatsDay[];
  totals: {
    pv: number;
    /** 区间内日 UV 之和（访客哈希按天加盐，跨天无法去重） */
    uvDaySum: number;
    /** 区间内单日 UV 峰值 */
    uvPeak: number;
    csv: number;
    out: number;
    pred: number;
    prov: number;
  };
  boards: NamedCount[];
  todayBoards: NamedCount[];
  provinces: NamedCount[];
  refs: NamedCount[];
  geo: NamedCount[];
  dev: NamedCount[];
  online: number;
}

/** 一条「提交 → 出分」样本（毫秒时间戳），由赛道榜行转换而来 */
export interface Sample {
  /** 提测时刻（bestSubmit） */
  t: number;
  /** 出分时刻（updated） */
  done: number;
  name: string;
  groupId: number | null;
}

/** 把赛道榜行转换成有效样本（done > t），按提交时刻升序 */
export function samplesOf(rows: Row[]): Sample[] {
  const out: Sample[] = [];
  for (const r of rows) {
    const t = r.bestSubmit ? Date.parse(r.bestSubmit) : Number.NaN;
    const done = r.updated ? Date.parse(r.updated) : Number.NaN;
    if (!Number.isFinite(t) || !Number.isFinite(done) || done <= t) continue;
    out.push({ t, done, name: r.name, groupId: r.groupId });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}
