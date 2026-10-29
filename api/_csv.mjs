// 共享：把榜单行序列化成 CSV（与本地 server.mjs 输出列一致）
export const CSV_HEAD = ['rank', 'name', 'school', 'advisor', 'score', 'rawScore', 'bestSubmitTime', 'lastUpdated', 'userId', 'groupId', 'recordId'];

const esc = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(board) {
  const lines = [CSV_HEAD.join(',')];
  for (const r of board.rows) {
    lines.push([r.rank, r.name, r.school, r.advisor, r.score, r.rawScore, r.bestSubmit, r.updated, r.userId, r.groupId, r.recordId].map(esc).join(','));
  }
  return '\ufeff' + lines.join('\n') + '\n';
}

export const isForce = (req) => {
  const q = req.query || {};
  return String(q.force ?? '') === '1' || String(q.refresh ?? '') === '1';
};

// 让 Vercel CDN 帮我们挡上游流量：12 秒内共享缓存，过期后先给旧数据再后台刷新
export const cacheHeader = (force) =>
  force ? 'no-store' : 'public, s-maxage=12, stale-while-revalidate=120';
