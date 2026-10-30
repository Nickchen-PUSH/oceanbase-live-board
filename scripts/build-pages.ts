// GitHub Pages 静态构建：前端 + 一份榜单快照（CI 每 10 分钟跑一次）
//   bun scripts/build-pages.ts   → dist/pages
// 页面运行时优先连 Cloudflare Worker（LIVE_ORIGIN）的实时接口 / 推送，失败才读 ./data/snapshot.json。
import { cp, mkdir, rm } from 'node:fs/promises';
import { buildClient } from './build.ts';
import { errMsg, getSnapshot } from '../src/server/upstream.ts';
import type { Snapshot } from '../src/shared/types.ts';

const OUT = 'dist/pages';
const LIVE_ORIGIN = process.env.LIVE_ORIGIN ?? 'https://board.nerv-base.com';

await buildClient('dist/client');
await rm(OUT, { recursive: true, force: true });
await cp('dist/client', OUT, { recursive: true });

// 标记静态模式（页面据此显示「静态快照」并改用 LIVE_ORIGIN）
const htmlPath = `${OUT}/index.html`;
const html = await Bun.file(htmlPath).text();
const cfg = `<script>window.__BOARD_CONFIG__=${JSON.stringify({ mode: 'pages', liveOrigin: LIVE_ORIGIN })}</script>`;
const patched = html.replace('</head>', `${cfg}</head>`);
await Bun.write(htmlPath, patched);
// GitHub Pages 没有 SPA 回退：/stats 之类的路径靠 404.html 打开同一个页面
await Bun.write(`${OUT}/404.html`, patched);
await Bun.write(`${OUT}/.nojekyll`, '');

const t0 = performance.now();
let snap: Snapshot;
try {
  snap = await getSnapshot({ force: true });
} catch (err) {
  console.error('✘ snapshot failed:', errMsg(err));
  process.exit(1);
}
const fetchMs = Math.round(performance.now() - t0);
const broken = snap.boards.filter((b) => b.error).map((b) => ({ id: b.id, title: b.title, error: b.error }));
const total = snap.boards.find((b) => b.kind === 'total');
if (!total?.rows.length) {
  // 总榜为空说明上游挂了：直接失败，保留上一次部署
  console.error('✘ total board is empty, aborting deploy', total?.error ?? '');
  process.exit(1);
}
snap.static = {
  builtAt: new Date().toISOString(),
  builtBy: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
  fetchMs,
  brokenBoards: broken,
};
await mkdir(`${OUT}/data`, { recursive: true });
await Bun.write(`${OUT}/data/snapshot.json`, JSON.stringify(snap));

const rows = snap.boards.reduce((n, b) => n + b.rows.length, 0);
console.log(`✔ snapshot: ${snap.boards.length} boards, ${rows} rows, ${fetchMs} ms${broken.length ? `, broken: ${broken.map((b) => b.id).join(',')}` : ''}`);
