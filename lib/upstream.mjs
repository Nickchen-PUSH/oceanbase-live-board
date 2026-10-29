// Upstream OceanBase (openwebapi) fetchers + normalizers + TTL cache.
//
// Public endpoints used (no auth required, verified 2026-10-29):
//   题目列表  GET /testplatform/question/webQueryTestPlatformQuestionList?rpcFromType=0&campId=21&pageSize=100&pageNo=1
//   赛道榜    GET /testplatform/score/queryTestPlatformScoreList?questionId=<qid>&pageSize=5000
//   总榜      GET /testplatform/score/queryCompetitionScoreList?rpcFromType=0&pageNo=1&pageSize=5000&campId=21&scoreType=0
//
// Notes discovered by reading the site bundle (umi.ffce7a63.js):
//   * queryTestPlatformScoreList ignores pageNum; pageSize behaves like LIMIT and the
//     response echoes the returned row count, so `total` there is NOT a real total.
//     The page itself sends no pageSize => server default limit 10 (top-10 only).
//   * queryCompetitionScoreList (总榜) does real pagination via pageNo and reports a
//     trustworthy `total` (622 teams for camp 21).

const API = 'https://openwebapi.oceanbase.com/api/techcamp';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 运行时无关：Node（本地 server / Vercel 函数）与 Cloudflare Worker 共用这一份
const envOf = () => (typeof process !== 'undefined' && process.env) || {};

export const CAMP_ID = Number(envOf().CAMP_ID || 21);
export const TTL_MS = Number(envOf().CACHE_TTL_MS || 12000);
const UPSTREAM_TIMEOUT_MS = Number(envOf().UPSTREAM_TIMEOUT_MS || 15000);

// Worker 里没有 process.env，用 env 绑定调这个覆盖
let campId = CAMP_ID;
let ttlMs = TTL_MS;

export function configure(opts = {}) {
  if (opts.campId != null && Number.isFinite(Number(opts.campId))) campId = Number(opts.campId);
  if (opts.ttlMs != null && Number.isFinite(Number(opts.ttlMs))) ttlMs = Number(opts.ttlMs);
}

export const getCampId = () => campId;

async function getJson(path, params = {}, { tries = 3 } = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://open.oceanbase.com/', Accept: 'application/json' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const json = await res.json();
      if (json.code !== 200) throw new Error(`upstream code=${json.code} ${json.message || ''}`.trim());
      return json.data;
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw new Error(`${path} failed: ${lastErr?.message || lastErr}`);
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function normalizeRow(rec, rank, { teamMode }) {
  return {
    rank,
    name: (teamMode ? rec.groupName : rec.userName) || rec.userName || rec.groupName || '-',
    school: rec.graduationSchool || '',
    advisor: rec.advisor || '',
    province: rec.provinceName || '',
    score: num(rec.webTotalScore),
    rawScore: num(rec.totalScore),
    bestSubmit: rec.gmtCreate || null, // 页面上"最优提交时间"
    updated: rec.gmtModified || null,
    userId: rec.userId || null,
    groupId: rec.groupId ?? null,
    recordId: rec.id ?? null,
  };
}

function withRank(list, opts) {
  const rows = list.map((rec, i) => normalizeRow(rec, i + 1, opts));
  // 同名次（分数相同）保持接口顺序，额外标记并列
  let prev = null;
  let prevRank = 0;
  rows.forEach((r, i) => {
    if (prev !== null && r.score === prev) r.rank = prevRank;
    else prevRank = r.rank = i + 1;
    prev = r.score;
  });
  return rows;
}

/** 竞赛总榜（初赛英雄榜） */
export async function fetchTotalBoard() {
  const data = await getJson('/testplatform/score/queryCompetitionScoreList', {
    rpcFromType: 0,
    pageNo: 1,
    pageSize: 5000,
    campId,
    scoreType: 0,
  });
  const list = data?.list || [];
  return { rows: withRank(list, { teamMode: true }), reportedTotal: data?.total ?? list.length };
}

/** camp 下的题目（= 各赛道）列表 */
export async function fetchQuestions() {
  const data = await getJson('/testplatform/question/webQueryTestPlatformQuestionList', {
    rpcFromType: 0,
    campId,
    pageSize: 200,
    pageNo: 1,
  });
  return (data?.list || [])
    .map((q) => ({ id: q.id, name: q.questionName, sort: q.sort ?? 0, scoreType: q.scoreType }))
    .sort((a, b) => a.sort - b.sort);
}

/** 单个赛道榜 */
export async function fetchTrackBoard(questionId) {
  const data = await getJson('/testplatform/score/queryTestPlatformScoreList', {
    questionId,
    pageSize: 5000,
  });
  const list = data?.list || [];
  return { rows: withRank(list, { teamMode: false }), reportedTotal: list.length };
}

// ---------------------------------------------------------------- cache layer

const cache = new Map(); // key -> { at, promise, value, error }
const lastGood = new Map();

function cached(key, loader, ttl = ttlMs) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttl) return hit.promise;
  const entry = { at: now };
  entry.promise = loader()
    .then((value) => {
      lastGood.set(key, { value, at: Date.now() });
      entry.error = null;
      entry.value = value;
      return value;
    })
    .catch((err) => {
      // stale-while-error: 上游抖动时继续供最后一次成功的数据
      entry.error = err.message || String(err);
      const prev = lastGood.get(key);
      if (prev) return { ...prev.value, stale: true, error: entry.error };
      throw err;
    });
  cache.set(key, entry);
  return entry.promise;
}

export async function getQuestions({ force = false } = {}) {
  return cached('questions', fetchQuestions, force ? 0 : 60_000);
}

export async function getTotalBoard({ force = false } = {}) {
  return cached('board:total', fetchTotalBoard, force ? 0 : ttlMs);
}

export async function getTrackBoard(questionId, { force = false } = {}) {
  return cached(`board:q${questionId}`, () => fetchTrackBoard(questionId), force ? 0 : ttlMs);
}

/** 整站快照：总榜 + 全部赛道，赛道行补齐学校/导师（来自总榜的 userId 关联） */
export async function getSnapshot({ force = false } = {}) {
  const questions = await getQuestions({ force });
  const [total, ...tracks] = await Promise.all([
    getTotalBoard({ force }).catch((e) => ({ rows: [], error: e.message })),
    ...questions.map((q) => getTrackBoard(q.id, { force }).catch((e) => ({ rows: [], error: e.message }))),
  ]);

  const info = new Map();
  for (const r of total.rows) {
    if (r.userId && !info.has(r.userId)) {
      info.set(r.userId, { school: r.school, advisor: r.advisor, province: r.province });
    }
  }

  const boards = [
    {
      id: 'total',
      title: '总榜 · 初赛英雄榜',
      kind: 'total',
      questionId: null,
      rows: total.rows,
      error: total.error || null,
      stale: !!total.stale,
      reportedTotal: total.reportedTotal ?? null,
      source: 'https://open.oceanbase.com/competition/armory',
    },
    ...questions.map((q, i) => {
      const board = tracks[i] || { rows: [] };
      const rows = board.rows.map((r) => {
        const extra = r.userId && info.get(r.userId);
        if (!extra || r.school) return r;
        return { ...r, school: extra.school, advisor: r.advisor || extra.advisor, province: r.province || extra.province };
      });
      return {
        id: `q${q.id}`,
        title: q.name,
        kind: 'track',
        questionId: q.id,
        rows,
        error: board.error || null,
        stale: !!board.stale,
        reportedTotal: board.reportedTotal ?? rows.length,
        source: `https://open.oceanbase.com/train/detail/21?questionId=${q.id}`,
      };
    }),
  ];

  // 侧边栏按参与人数排序更实用（源站按 sort 字段，人数多寡无关）
  const [head, ...tracksSorted] = boards;
  tracksSorted.sort((a, b) => b.rows.length - a.rows.length);

  return { campId, generatedAt: new Date().toISOString(), boards: [head, ...tracksSorted] };
}
