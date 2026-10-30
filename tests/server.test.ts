// 服务端：上游归一化 / 排名 / 补全 / 缓存、CSV、Hono 路由、访问统计
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createApi } from '../src/server/app.ts';
import { contentDisposition, csvFilename, rowsToCsv } from '../src/server/csv.ts';
import {
  clearCache,
  enrichRows,
  getQuestions,
  getSnapshot,
  normalizeRow,
  parseBoardId,
  rankRows,
  setFetch,
  type FetchFn,
} from '../src/server/upstream.ts';
import { clampDays, deviceOf, memoryKV, parseHit, referrerBucket, VisitStats } from '../src/server/visits.ts';
import type { Board, Row } from '../src/shared/types.ts';

const row = (p: Partial<Row>): Row => ({
  rank: 0,
  name: 'x',
  school: '',
  advisor: '',
  province: '',
  score: null,
  rawScore: null,
  bestSubmit: null,
  updated: null,
  userId: null,
  groupId: null,
  recordId: null,
  ...p,
});

describe('rankRows', () => {
  test('按分数降序、同分并列（1,1,3）、无成绩沉底，不信任上游顺序', () => {
    const out = rankRows([
      row({ name: 'c', score: 10 }),
      row({ name: 'n', score: null }),
      row({ name: 'a', score: 30 }),
      row({ name: 'b', score: 30 }),
    ]);
    expect(out.map((r) => [r.name, r.rank])).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 3],
      ['n', 4],
    ]);
  });
});

describe('normalizeRow', () => {
  test('总榜用队名、赛道用选手名；数字与空值', () => {
    const rec = { groupName: ' 队A ', userName: '张三', webTotalScore: '12.5', totalScore: '', groupId: 7, userId: 9 };
    expect(normalizeRow(rec, true)).toMatchObject({ name: '队A', score: 12.5, rawScore: null, groupId: 7, userId: '9' });
    expect(normalizeRow(rec, false).name).toBe('张三');
  });
});

describe('enrichRows', () => {
  const total = [row({ groupId: 1, userId: 'u1', school: '川大', province: '四川省', advisor: '王' })];
  test('按 groupId 关联，逐字段补齐（有学校也要补省份）', () => {
    const [r] = enrichRows([row({ groupId: 1, userId: 'other', school: '自己填的' })], total);
    expect(r).toMatchObject({ school: '自己填的', province: '四川省', advisor: '王' });
  });
  test('无 groupId 时用 userId 兜底；都对不上不补，也不按名字猜', () => {
    expect(enrichRows([row({ userId: 'u1' })], total)[0]!.province).toBe('四川省');
    expect(enrichRows([row({ name: 'x', userId: 'zz' })], total)[0]!.province).toBe('');
  });
});

test('parseBoardId', () => {
  expect(parseBoardId('total')).toBe('total');
  expect(parseBoardId('600071')).toBe('q600071');
  expect(parseBoardId('q600071')).toBe('q600071');
  expect(parseBoardId('../etc')).toBeNull();
  expect(parseBoardId(undefined)).toBeNull();
});

describe('csv', () => {
  test('带省份列、BOM、CRLF，转义逗号/引号/换行（含 \\r），防公式注入', () => {
    const csv = rowsToCsv([row({ rank: 1, name: '=cmd|a', school: 'a,"b"', province: '四川省', advisor: 'x\ry', score: 1 })]);
    expect(csv.startsWith('\ufeff')).toBe(true);
    const [head, line] = csv.slice(1).split('\r\n');
    expect(head).toContain('province');
    expect(line).toContain("'=cmd|a");
    expect(line).toContain('"a,""b"""');
    expect(line).toContain('"x\ry"');
    expect(line).toContain('四川省');
  });
  test('文件名与 Content-Disposition（RFC 5987）', () => {
    const b = { id: 'q1', title: 't' } as Board;
    const name = csvFilename(b, '四川省');
    expect(name).toContain('q1');
    expect(contentDisposition(name)).toContain(`filename*=UTF-8''${encodeURIComponent(name)}`);
  });
});

// ---------------------------------------------------------------- 上游 mock

const upstream = {
  fail: false,
  calls: 0,
  questions: [{ id: 1, questionName: '赛道一', sort: 1 }],
  total: [
    { groupId: 1, groupName: '队A', userId: 'u1', webTotalScore: 30, graduationSchool: '川大', provinceName: '四川省' },
    { groupId: 2, groupName: '队B', userId: 'u2', webTotalScore: 50, graduationSchool: '北大', provinceName: '北京市' },
  ],
  track: [
    { groupId: 1, userName: '张三', userId: 'u9', webTotalScore: 30, gmtCreate: '2026-10-30T01:00:00Z', gmtModified: '2026-10-30T01:05:00Z' },
    { groupId: 2, userName: '李四', userId: 'u2', webTotalScore: 50 },
  ],
};

const mockFetch: FetchFn = async (input) => {
  upstream.calls++;
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (upstream.fail) return new Response('down', { status: 502 });
  const ok = (data: unknown) => Response.json({ code: 200, data });
  if (url.pathname.endsWith('webQueryTestPlatformQuestionList')) return ok({ list: upstream.questions });
  if (url.pathname.endsWith('queryCompetitionScoreList')) return ok({ list: upstream.total, total: upstream.total.length });
  if (url.pathname.endsWith('queryTestPlatformScoreList')) return ok({ list: upstream.track });
  return new Response('?', { status: 404 });
};

beforeEach(() => {
  clearCache();
  upstream.fail = false;
  upstream.calls = 0;
  setFetch(mockFetch);
});
afterEach(() => clearCache());

describe('upstream cache', () => {
  test('快照：总榜排名、赛道按 groupId 补省份', async () => {
    const snap = await getSnapshot();
    expect(snap.boards.map((b) => b.id)).toEqual(['total', 'q1']);
    expect(snap.boards[0]!.rows[0]).toMatchObject({ name: '队B', rank: 1 });
    const zs = snap.boards[1]!.rows.find((r) => r.name === '张三')!;
    expect(zs.province).toBe('四川省');
    expect(zs.rank).toBe(2);
  });

  test('stale-while-error：数组值不被改写（旧实现会把题目列表摊成对象）', async () => {
    const first = await getQuestions();
    upstream.fail = true;
    const again = await getQuestions({ force: true });
    expect(Array.isArray(again.value)).toBe(true);
    expect(again.value).toEqual(first.value);
    expect(again.stale).toBe(true);
    expect(again.error).toContain('HTTP 502');
  });

  test('没有兜底时失败不缓存：上游恢复后立即成功', async () => {
    upstream.fail = true;
    await expect(getQuestions()).rejects.toThrow();
    upstream.fail = false;
    const q = await getQuestions();
    expect(q.value).toHaveLength(1);
  }, 10_000);
});

describe('Hono API', () => {
  const kv = memoryKV();
  const stats = new VisitStats(kv);
  const app = createApi({
    runtime: 'bun',
    pushIntervalMs: 15000,
    stats: () => ({
      backend: { hit: (e, ctx) => stats.hit(e, ctx), summary: (d, o) => stats.summary(d, o) },
      key: 'secret',
      ctx: { ua: 'Mozilla/5.0 (iPhone)', ip: '1.2.3.4', geo: 'CN' },
    }),
  });

  test('/api/health', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, runtime: 'bun', stats: true });
  });

  test('/api/snapshot 与 /api/board/:id', async () => {
    const snap = await (await app.request('/api/snapshot')).json();
    expect(snap.boards).toHaveLength(2);
    expect((await app.request('/api/board/1')).status).toBe(200);
    expect((await app.request('/api/board/abc')).status).toBe(400);
  });

  test('/api/export.csv 按省份过滤', async () => {
    const res = await app.request('/api/export.csv?board=total&province=' + encodeURIComponent('北京市'));
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    expect(text).toContain('队B');
    expect(text).not.toContain('队A');
  });

  test('打点与统计：key 校验、days 非法不崩、UV 去重', async () => {
    for (let i = 0; i < 3; i++) await app.request('/api/hit', { method: 'POST', body: JSON.stringify({ k: 'pv', r: 'https://github.com/x' }) });
    await app.request('/api/hit', { method: 'POST', body: JSON.stringify({ k: 'province', t: '四川省' }) });
    expect((await app.request('/api/hit', { method: 'POST', body: '{bad' })).status).toBe(400);
    expect((await app.request('/api/stats?key=wrong')).status).toBe(404);
    const res = await app.request('/api/stats?days=abc', { headers: { Authorization: 'Bearer secret' } });
    expect(res.status).toBe(200);
    const s = await res.json();
    expect(s.days).toBe(14);
    expect(s.today).toMatchObject({ pv: 3, uv: 1, prov: 1 });
    expect(s.refs[0]).toMatchObject({ name: 'GitHub', count: 3 });
    expect(s.dev[0].name).toBe('mobile');
    expect(s.provinces[0]).toMatchObject({ name: '四川省', count: 1 });
  });
});

describe('visits helpers', () => {
  test('clampDays', () => {
    expect(clampDays('abc')).toBe(14);
    expect(clampDays('')).toBe(14);
    expect(clampDays('0')).toBe(1);
    expect(clampDays('999')).toBe(60);
    expect(clampDays('7')).toBe(7);
  });
  test('parseHit 拒绝未知类型', () => {
    expect(parseHit({ k: 'nope' })).toBeNull();
    expect(parseHit({ k: 'board', t: 'q1' })).toMatchObject({ k: 'board', t: 'q1' });
  });
  test('referrer / device', () => {
    expect(referrerBucket('')).toBe('直接访问');
    expect(deviceOf('Googlebot/2.1')).toBe('bot');
    expect(deviceOf('Mozilla/5.0 (Macintosh)')).toBe('desktop');
  });
});
