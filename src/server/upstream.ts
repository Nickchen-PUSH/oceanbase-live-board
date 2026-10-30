// 上游 OceanBase openwebapi 抓取 + 字段归一化 + TTL 缓存（Bun 本地服务、Cloudflare Worker、静态构建共用）。
//
// 公开接口（免登录，2026-10-29 验证）：
//   题目列表  GET /testplatform/question/webQueryTestPlatformQuestionList?rpcFromType=0&campId=21&pageSize=200&pageNo=1
//   赛道榜    GET /testplatform/score/queryTestPlatformScoreList?questionId=<qid>&pageSize=5000
//   总榜      GET /testplatform/score/queryCompetitionScoreList?rpcFromType=0&pageNo=1&pageSize=5000&campId=21&scoreType=0
//
// 踩过的坑：
//   * queryTestPlatformScoreList 忽略 pageNum，pageSize 等价于 LIMIT，响应里的 total 只是本次返回条数。
//   * queryCompetitionScoreList 是真分页（pageNo 生效、total 可信），必须同时带 campId 与 scoreType=0。
//   * 赛道榜 userId 只是「提交的那个成员」，与总榜的 userId 关联率只有 ~65%；groupId（队伍 id）100% 对得上。
import type { Board, Row, Snapshot } from '../shared/types.ts';

const API = 'https://openwebapi.oceanbase.com/api/techcamp';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PAGE_SIZE = 5000;

export interface UpstreamConfig {
  campId: number;
  /** 榜单缓存时长 */
  ttlMs: number;
  /** 单次上游请求超时 */
  timeoutMs: number;
}

const envOf = (): Record<string, string | undefined> =>
  (typeof process !== 'undefined' && process.env) || {};
const numOr = (v: unknown, d: number) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

const config: UpstreamConfig = {
  campId: numOr(envOf().CAMP_ID, 21),
  ttlMs: numOr(envOf().CACHE_TTL_MS, 12_000),
  timeoutMs: numOr(envOf().UPSTREAM_TIMEOUT_MS, 15_000),
};

/** Worker 没有 process.env，用 env 绑定调用这个覆盖 */
export function configure(opts: Partial<Record<keyof UpstreamConfig, unknown>>) {
  if (opts.campId != null) config.campId = numOr(opts.campId, config.campId);
  if (opts.ttlMs != null) config.ttlMs = numOr(opts.ttlMs, config.ttlMs);
  if (opts.timeoutMs != null) config.timeoutMs = numOr(opts.timeoutMs, config.timeoutMs);
}

export const getConfig = (): Readonly<UpstreamConfig> => config;

/** 测试用：替换底层 fetch */
export type FetchFn = (input: URL | string | Request, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchFn = (input, init) => fetch(input, init);
export function setFetch(f: FetchFn) {
  fetchImpl = f;
}

async function getJson(path: string, params: Record<string, string | number>, tries = 3): Promise<any> {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': UA, Referer: 'https://open.oceanbase.com/', Accept: 'application/json' },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
      const json: any = await res.json();
      if (json?.code !== 200) throw new Error(`upstream code=${json?.code} ${json?.message || ''}`.trim());
      return json.data;
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw new Error(`${path} failed: ${errMsg(lastErr)}`);
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function normalizeRow(rec: any, teamMode: boolean): Row {
  return {
    rank: 0,
    name: str(teamMode ? rec.groupName : rec.userName) || str(rec.userName) || str(rec.groupName) || '-',
    school: str(rec.graduationSchool),
    advisor: str(rec.advisor),
    province: str(rec.provinceName),
    score: num(rec.webTotalScore),
    rawScore: num(rec.totalScore),
    bestSubmit: rec.gmtCreate || null,
    updated: rec.gmtModified || null,
    userId: rec.userId != null ? String(rec.userId) : null,
    groupId: num(rec.groupId),
    recordId: num(rec.id),
  };
}

/**
 * 按成绩降序排（稳定排序：同分保持接口顺序；无成绩的沉底），再按竞赛排名规则赋名次：
 * 同分并列，下一个名次跳过并列人数（1,1,1,4…）。
 * 旧实现直接信任接口顺序按 index 赋名次——接口一旦不按分数排，名次就全错。
 */
export function rankRows(rows: Row[]): Row[] {
  const sorted = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const x = a.r.score;
      const y = b.r.score;
      if (x == null && y == null) return a.i - b.i;
      if (x == null) return 1;
      if (y == null) return -1;
      return y - x || a.i - b.i;
    })
    .map((x) => x.r);
  let prevScore: number | null | undefined;
  let prevRank = 0;
  sorted.forEach((r, i) => {
    if (i > 0 && r.score === prevScore) r.rank = prevRank;
    else prevRank = r.rank = i + 1;
    prevScore = r.score;
  });
  return sorted;
}

export interface BoardPayload {
  rows: Row[];
  reportedTotal: number | null;
}

/** 竞赛总榜（初赛英雄榜）：真分页，超过一页时继续翻 */
export async function fetchTotalBoard(): Promise<BoardPayload> {
  const list: any[] = [];
  let total: number | null = null;
  for (let pageNo = 1; pageNo <= 20; pageNo++) {
    const data = await getJson('/testplatform/score/queryCompetitionScoreList', {
      rpcFromType: 0,
      pageNo,
      pageSize: PAGE_SIZE,
      campId: config.campId,
      scoreType: 0,
    });
    const page: any[] = data?.list || [];
    list.push(...page);
    total = num(data?.total) ?? list.length;
    if (page.length < PAGE_SIZE || list.length >= total) break;
  }
  return { rows: rankRows(list.map((r) => normalizeRow(r, true))), reportedTotal: total };
}

export interface Question {
  id: number;
  name: string;
  sort: number;
}

/** camp 下的题目（= 各赛道）列表 */
export async function fetchQuestions(): Promise<Question[]> {
  const data = await getJson('/testplatform/question/webQueryTestPlatformQuestionList', {
    rpcFromType: 0,
    campId: config.campId,
    pageSize: 200,
    pageNo: 1,
  });
  return ((data?.list || []) as any[])
    .filter((q) => q?.id != null)
    .map((q) => ({ id: Number(q.id), name: str(q.questionName) || `题目 ${q.id}`, sort: num(q.sort) ?? 0 }))
    .sort((a, b) => a.sort - b.sort);
}

/** 单个赛道榜 */
export async function fetchTrackBoard(questionId: number | string): Promise<BoardPayload> {
  const data = await getJson('/testplatform/score/queryTestPlatformScoreList', { questionId, pageSize: PAGE_SIZE });
  const list: any[] = data?.list || [];
  return { rows: rankRows(list.map((r) => normalizeRow(r, false))), reportedTotal: list.length };
}

// ---------------------------------------------------------------- cache layer

export interface Cached<T> {
  value: T;
  /** true = 本次上游失败，value 是最后一次成功的数据 */
  stale: boolean;
  error: string | null;
  /** value 抓取成功的时刻 */
  at: number;
}

interface Entry<T> {
  at: number;
  promise: Promise<Cached<T>>;
}

const cache = new Map<string, Entry<any>>();
const lastGood = new Map<string, { value: any; at: number }>();

export function clearCache() {
  cache.clear();
  lastGood.clear();
}

/**
 * TTL 缓存 + 并发合并 + stale-while-error。
 * 修掉旧实现的两个坑：
 *   1. 兜底时 `{ ...prev.value, stale }` 会把数组（题目列表）摊成对象，导致后续 `.map is not a function`；
 *      现在统一包一层 Cached<T>，不改写 value 本身。
 *   2. 失败且没有兜底时，被拒绝的 promise 留在缓存里，TTL 内所有请求都直接失败；现在失败立即清掉条目。
 */
function cached<T>(key: string, loader: () => Promise<T>, ttl: number): Promise<Cached<T>> {
  const hit = cache.get(key) as Entry<T> | undefined;
  const now = Date.now();
  if (hit && now - hit.at < ttl) return hit.promise;
  const entry: Entry<T> = { at: now, promise: null as unknown as Promise<Cached<T>> };
  entry.promise = loader().then(
    (value) => {
      const at = Date.now();
      lastGood.set(key, { value, at });
      return { value, stale: false, error: null, at };
    },
    (err) => {
      const prev = lastGood.get(key);
      if (!prev) {
        if (cache.get(key) === entry) cache.delete(key);
        throw err;
      }
      // 有兜底：失败结果只复用 3 秒，避免上游挂掉时每个请求都再重试 3 次
      entry.at = Date.now() - Math.max(0, ttl - 3000);
      return { value: prev.value as T, stale: true, error: errMsg(err), at: prev.at };
    },
  );
  cache.set(key, entry);
  return entry.promise;
}

export const getQuestions = ({ force = false } = {}) => cached('questions', fetchQuestions, force ? 0 : 60_000);

export const getTotalBoard = ({ force = false } = {}) =>
  cached('board:total', fetchTotalBoard, force ? 0 : config.ttlMs);

export const getTrackBoard = (questionId: number | string, { force = false } = {}) =>
  cached(`board:q${questionId}`, () => fetchTrackBoard(questionId), force ? 0 : config.ttlMs);

/**
 * 赛道榜的学校/导师/省份很多是空的：用总榜按 groupId（队伍）补齐，userId 兜底。
 * 每个字段独立补——旧实现「有学校就整行跳过」，导致有学校没省份的行（每个赛道 20%+）省份永远为空。
 */
export function enrichRows(rows: Row[], totalRows: Row[]): Row[] {
  const byGroup = new Map<number, Row>();
  const byUser = new Map<string, Row>();
  for (const r of totalRows) {
    if (r.groupId != null && !byGroup.has(r.groupId)) byGroup.set(r.groupId, r);
    if (r.userId && !byUser.has(r.userId)) byUser.set(r.userId, r);
  }
  return rows.map((r) => {
    const hit = (r.groupId != null && byGroup.get(r.groupId)) || (r.userId && byUser.get(r.userId)) || null;
    if (!hit || (r.school && r.advisor && r.province)) return r;
    return {
      ...r,
      school: r.school || hit.school,
      advisor: r.advisor || hit.advisor,
      province: r.province || hit.province,
    };
  });
}

export const TOTAL_TITLE = '总榜 · 初赛英雄榜';
export const TOTAL_SOURCE = 'https://open.oceanbase.com/competition/armory';
export const trackSource = (campId: number, qid: number) =>
  `https://open.oceanbase.com/train/detail/${campId}?questionId=${qid}`;

const emptyPayload = (e: unknown): Cached<BoardPayload> => ({
  value: { rows: [], reportedTotal: null },
  stale: false,
  error: errMsg(e),
  at: 0,
});

/** 整站快照：总榜 + 全部赛道（赛道按参与人数降序） */
export async function getSnapshot({ force = false } = {}): Promise<Snapshot> {
  const campId = config.campId;
  const totalP = getTotalBoard({ force }).catch(emptyPayload);
  const questions = (await getQuestions({ force })).value;
  const [total, ...tracks] = await Promise.all([
    totalP,
    ...questions.map((q) => getTrackBoard(q.id, { force }).catch(emptyPayload)),
  ]);

  const totalBoard: Board = {
    id: 'total',
    title: TOTAL_TITLE,
    kind: 'total',
    questionId: null,
    rows: total.value.rows,
    error: total.error,
    stale: total.stale,
    reportedTotal: total.value.reportedTotal,
    source: TOTAL_SOURCE,
  };

  const trackBoards: Board[] = questions.map((q, i) => {
    const t = tracks[i]!;
    return {
      id: `q${q.id}`,
      title: q.name,
      kind: 'track',
      questionId: q.id,
      rows: enrichRows(t.value.rows, totalBoard.rows),
      error: t.error,
      stale: t.stale,
      reportedTotal: t.value.reportedTotal,
      source: trackSource(campId, q.id),
    };
  });
  trackBoards.sort((a, b) => b.rows.length - a.rows.length);

  return { campId, generatedAt: new Date().toISOString(), boards: [totalBoard, ...trackBoards] };
}

/** 解析榜单 id：'total' | 'q600071' | '600071' → 规范 id；非法返回 null */
export function parseBoardId(raw: string | null | undefined): string | null {
  const id = String(raw ?? '').trim();
  if (id === 'total') return 'total';
  const m = /^q?(\d{1,12})$/.exec(id);
  return m ? `q${m[1]}` : null;
}

/** 单榜（CSV 导出 / /api/board 用）：赛道榜同样用总榜补齐学校/省份 */
export async function getBoard(rawId: string, { force = false } = {}): Promise<Board | null> {
  const id = parseBoardId(rawId);
  if (!id) return null;
  const campId = config.campId;
  if (id === 'total') {
    const t = await getTotalBoard({ force });
    return {
      id,
      title: TOTAL_TITLE,
      kind: 'total',
      questionId: null,
      rows: t.value.rows,
      error: t.error,
      stale: t.stale,
      reportedTotal: t.value.reportedTotal,
      source: TOTAL_SOURCE,
    };
  }
  const qid = Number(id.slice(1));
  const [track, total, questions] = await Promise.all([
    getTrackBoard(qid, { force }),
    getTotalBoard().catch(() => null),
    getQuestions().catch(() => null),
  ]);
  return {
    id,
    title: questions?.value.find((q) => q.id === qid)?.name || `题目 ${qid}`,
    kind: 'track',
    questionId: qid,
    rows: total ? enrichRows(track.value.rows, total.value.rows) : track.value.rows,
    error: track.error,
    stale: track.stale,
    reportedTotal: track.value.reportedTotal,
    source: trackSource(campId, qid),
  };
}
