// Zero-dependency HTTP server: serves the dashboard SPA and proxies/normalizes the
// OceanBase leaderboard APIs (CORS + cache + stale-while-error live in here).
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSnapshot, getTrackBoard, getTotalBoard, CAMP_ID, TTL_MS } from './lib/upstream.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8791);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(req, res, status, body) {
  let buf = Buffer.from(JSON.stringify(body));
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
  };
  // 快照接近 1MB，gzip 后约 1/8；本地轮询时这点带宽也值得省
  if (buf.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    buf = zlib.gzipSync(buf, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(buf);
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(board) {
  const head = ['rank', 'name', 'school', 'advisor', 'score', 'rawScore', 'bestSubmitTime', 'lastUpdated', 'userId', 'groupId', 'recordId'];
  const lines = [head.join(',')];
  for (const r of board.rows) {
    lines.push(
      [r.rank, r.name, r.school, r.advisor, r.score, r.rawScore, r.bestSubmit, r.updated, r.userId, r.groupId, r.recordId]
        .map(csvEscape)
        .join(',')
    );
  }
  return '\ufeff' + lines.join('\n') + '\n';
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const target = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const buf = await fs.readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const force = url.searchParams.get('force') === '1' || url.searchParams.get('refresh') === '1';

  try {
    if (url.pathname === '/api/health') {
      return sendJson(req, res, 200, { ok: true, campId: CAMP_ID, cacheTtlMs: TTL_MS, at: new Date().toISOString() });
    }

    if (url.pathname === '/api/snapshot') {
      const snap = await getSnapshot({ force });
      return sendJson(req, res, 200, snap);
    }

    if (url.pathname.startsWith('/api/board/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/board/'.length));
      const payload = id === 'total' ? await getTotalBoard({ force }) : await getTrackBoard(id.replace(/^q/, ''), { force });
      return sendJson(req, res, 200, { id, ...payload });
    }

    if (url.pathname === '/api/export.csv') {
      // 只抓需要的那一个榜（不必为导出解析全部 11 个榜）
      const raw = url.searchParams.get('board') || 'total';
      const questionId = raw.replace(/^q/, '');
      const isTotal = raw === 'total';
      if (!isTotal && !/^\d+$/.test(questionId)) {
        return sendJson(req, res, 400, { error: 'board must be "total" or "q<questionId>"' });
      }
      const board = isTotal
        ? { kind: 'total', questionId: null, rows: (await getTotalBoard({ force })).rows }
        : { kind: 'track', questionId, rows: (await getTrackBoard(questionId, { force })).rows };

      // 赛道榜本身没有学校/导师，用总榜 userId 关联补上（与 /api/snapshot 口径一致）
      if (!isTotal) {
        const total = await getTotalBoard();
        const info = new Map(total.rows.filter((r) => r.userId).map((r) => [r.userId, r]));
        board.rows = board.rows.map((r) => {
          const hit = r.userId && info.get(r.userId);
          if (!hit || r.school) return r;
          return { ...r, school: hit.school, advisor: r.advisor || hit.advisor, province: r.province || hit.province };
        });
      }
      const buf = Buffer.from(toCsv(board), 'utf8');
      const fname = `oceanbase-${board.kind === 'total' ? 'total' : 'track-' + board.questionId}-${new Date().toISOString().slice(0, 10)}.csv`;
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fname}"`,
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
      });
      return res.end(buf);
    }

    if (url.pathname.startsWith('/api/')) return sendJson(req, res, 404, { error: 'unknown endpoint' });

    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error('[error]', req.method, url.pathname, err.message);
    return sendJson(req, res, 502, { error: 'upstream failure', detail: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`oceanbase-live-board → http://${HOST}:${PORT}  (camp ${CAMP_ID}, cache ${TTL_MS}ms)`);
});
