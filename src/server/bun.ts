// 本地服务：Bun.serve 原生路由 + HTML import（开发时自带 HMR，生产时启动即打包）
//   bun run dev      → http://127.0.0.1:8791 （热更新）
//   bun run start    → 生产模式
// 环境变量：PORT HOST CAMP_ID CACHE_TTL_MS PUSH_INTERVAL_MS STATS_KEY STATS_DB
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import type { ServerWebSocket } from 'bun';
import index from '../web/index.html';
import type { OnlineInfo, Snapshot } from '../shared/types.ts';
import { createApi } from './app.ts';
import { errMsg, getSnapshot } from './upstream.ts';
import { VisitStats, type KV } from './visits.ts';

const PORT = Number(process.env.PORT || 8791);
const HOST = process.env.HOST || '127.0.0.1';
const PUSH_INTERVAL_MS = Math.max(5_000, Number(process.env.PUSH_INTERVAL_MS || 15_000));
const isDev = process.env.NODE_ENV !== 'production';

// ---------------------------------------------------------------- 访问统计（可选）
// 配了 STATS_KEY（或项目根有 .stats-key 文件）才开启；数据存 bun:sqlite
async function readStatsKey() {
  if (process.env.STATS_KEY) return process.env.STATS_KEY.trim();
  const f = Bun.file(new URL('../../.stats-key', import.meta.url));
  return (await f.exists()) ? (await f.text()).trim() : '';
}
const statsKey = await readStatsKey();

function sqliteKV(path: string): KV {
  const db = new Database(path, { create: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  const sel = db.query<{ v: string }, [string]>('SELECT v FROM kv WHERE k = ?');
  const ups = db.query('INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
  return {
    async get<T>(k: string) {
      const row = sel.get(k);
      return row ? (JSON.parse(row.v) as T) : undefined;
    },
    async put(k: string, v: unknown) {
      ups.run(k, JSON.stringify(v));
    },
  };
}

let visits: VisitStats | null = null;
if (statsKey) {
  const dbPath = process.env.STATS_DB || new URL('../../.cache/stats.sqlite', import.meta.url).pathname;
  await Bun.write(new URL('../../.cache/.keep', import.meta.url), '');
  visits = new VisitStats(sqliteKV(dbPath));
}

// ---------------------------------------------------------------- 推送：有浏览器连着才轮询上游
const TOPIC = 'board';
let clients = 0;
let lastPush: number | null = null;
let latest: Snapshot | null = null;
let latestGz: Uint8Array | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

async function tick() {
  timer = null;
  if (clients <= 0) return;
  try {
    const snap = await getSnapshot({ force: true });
    latest = { ...snap, push: { intervalMs: PUSH_INTERVAL_MS, clients } };
    // WebSocket 帧不走 HTTP 压缩，~1MB JSON 每 15 秒推一次太费流量 → 手动 gzip
    latestGz = Bun.gzipSync(JSON.stringify(latest));
    lastPush = Date.now();
    server.publish(TOPIC, latestGz);
  } catch (err) {
    console.warn('[push] upstream failed:', errMsg(err));
  }
  if (clients > 0) timer = setTimeout(tick, PUSH_INTERVAL_MS);
}

// ---------------------------------------------------------------- Hono API
const api = createApi({
  runtime: 'bun',
  pushIntervalMs: PUSH_INTERVAL_MS,
  snapshot: async (_c, force) => {
    // 推送通道刚抓过就直接用，避免同一份数据抓两遍
    if (!force && latest && Date.now() - Date.parse(latest.generatedAt) < PUSH_INTERVAL_MS + 5_000) {
      return { snap: latest, via: 'push' };
    }
    return { snap: await getSnapshot({ force }), via: 'upstream' };
  },
  stats: visits
    ? (c) => ({
        backend: visits!,
        key: statsKey,
        ctx: {
          ua: c.req.header('user-agent') || '',
          ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || server.requestIP(c.req.raw)?.address || '',
          geo: '本地',
        },
      })
    : undefined,
  online: async (): Promise<OnlineInfo> => ({ sockets: clients, lastPush, intervalMs: PUSH_INTERVAL_MS }),
});
// Bun.serve 不会自动压缩响应；1.3 MB 的快照 gzip 后约 150 KB（hono/compress 用原生 CompressionStream）
const app = new Hono().use('/api/*', compress()).route('/', api);

type WsData = { connectedAt: number };

const server = Bun.serve<WsData>({
  port: PORT,
  hostname: HOST,
  // HMR 默认关：Bun 1.4 的 HMR 运行时处理不了 @tanstack/router-core 内部的循环 import
  // （router.js ⇄ load-client.js，报 reading 'replaceRouteChunk'）。HMR=1 可手动开启试试。
  development: isDev ? { hmr: process.env.HMR === '1', console: true } : false,
  routes: {
    // SPA：所有页面路由都回 index.html（HTML import 由 Bun 原生打包，含 Tailwind 插件，见 bunfig.toml）
    '/': index,
    '/stats': index,
    '/api/stream': (req: Request, srv: Bun.Server<WsData>) => {
      if (srv.upgrade(req, { data: { connectedAt: Date.now() } })) return undefined;
      return Response.json({ error: 'expected websocket' }, { status: 426 });
    },
    '/api/*': (req: Request) => app.fetch(req),
  },
  fetch: () => new Response('Not found', { status: 404 }),
  websocket: {
    perMessageDeflate: false,
    open(ws: ServerWebSocket<WsData>) {
      clients++;
      ws.subscribe(TOPIC);
      // 没人在线时不抓取，latest 可能已经很旧：只发新鲜的，否则立即抓一次
      const fresh = latestGz && latest && Date.now() - Date.parse(latest.generatedAt) < PUSH_INTERVAL_MS + 5_000;
      if (fresh) ws.send(latestGz!);
      if (!timer) timer = setTimeout(tick, fresh ? PUSH_INTERVAL_MS : 0);
    },
    close(ws) {
      ws.unsubscribe(TOPIC);
      clients = Math.max(0, clients - 1);
    },
    message() {
      /* 单向推送，忽略客户端消息 */
    },
  },
});

console.log(
  `▶ OceanBase 榜单看板  ${server.url}  (${isDev ? 'dev' : 'production'}, push ${PUSH_INTERVAL_MS / 1000}s, stats ${visits ? 'on' : 'off'})`,
);
