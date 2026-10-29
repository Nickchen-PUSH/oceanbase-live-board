// 静态构建：抓一次全量快照 → 生成 dist/（GitHub Pages 用）
//
//   node scripts/build-data.mjs            # 输出到 dist/
//   OUT_DIR=site node scripts/build-data.mjs
//
// GitHub Pages 只能托管静态文件，浏览器又无法直连 openwebapi.oceanbase.com
// （任何非 open.oceanbase.com 的 Origin 都会被网关 403），
// 所以由 GitHub Actions 定时跑本脚本重新抓数据、重新部署：
// 页面里的「刷新」= 重新读 dist/data/snapshot.json，数据新鲜度 = workflow 周期。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSnapshot, CAMP_ID } from '../lib/upstream.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT_DIR = path.resolve(ROOT, process.env.OUT_DIR || 'dist');

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const ent of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, ent.name);
    const dst = path.join(to, ent.name);
    if (ent.isDirectory()) await copyDir(src, dst);
    else await fs.copyFile(src, dst);
  }
}

const started = Date.now();
const snap = await getSnapshot({ force: true });

const broken = snap.boards.filter((b) => b.error);
const totalBoard = snap.boards.find((b) => b.id === 'total');
if (!totalBoard || totalBoard.rows.length === 0) {
  throw new Error('总榜抓取为空，放弃本次部署（保留上一版页面）');
}

snap.static = {
  builtAt: new Date().toISOString(),
  builtBy: 'github-actions/build-data.mjs',
  fetchMs: Date.now() - started,
  brokenBoards: broken.map((b) => ({ id: b.id, title: b.title, error: b.error })),
};

await fs.rm(OUT_DIR, { recursive: true, force: true });
await copyDir(PUBLIC_DIR, OUT_DIR);
await fs.mkdir(path.join(OUT_DIR, 'data'), { recursive: true });
await fs.writeFile(path.join(OUT_DIR, 'data', 'snapshot.json'), JSON.stringify(snap));
// GitHub Pages 走 Actions 产物部署时用不到 .nojekyll，但直接推 dist 到分支时需要
await fs.writeFile(path.join(OUT_DIR, '.nojekyll'), '');

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const bytes = Buffer.byteLength(JSON.stringify(snap));
console.log(
  `built ${OUT_DIR}\n  camp ${CAMP_ID} · ${snap.boards.length} 个榜单 · ` +
    `${snap.boards.reduce((a, b) => a + b.rows.length, 0)} 行 · snapshot ${kb(bytes)} · ` +
    `抓取耗时 ${Date.now() - started}ms` +
    (broken.length ? `\n  ⚠ 上游异常榜单：${broken.map((b) => b.title).join('、')}` : '')
);
