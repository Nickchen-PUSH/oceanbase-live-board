import { getTotalBoard, getTrackBoard } from '../lib/upstream.mjs';
import { isForce, toCsv } from './_csv.mjs';

export default async function handler(req, res) {
  const force = isForce(req);
  const raw = String(req.query.board || 'total');
  const questionId = raw.replace(/^q/, '');
  const isTotal = raw === 'total';
  if (!isTotal && !/^\d+$/.test(questionId)) {
    return res.status(400).json({ error: 'board must be "total" or "q<questionId>"' });
  }

  try {
    const board = isTotal
      ? { kind: 'total', questionId: null, rows: (await getTotalBoard({ force })).rows }
      : { kind: 'track', questionId, rows: (await getTrackBoard(questionId, { force })).rows };

    // 赛道榜没有学校/导师，用总榜 userId 关联补齐（与 /api/snapshot 口径一致）
    if (!isTotal) {
      const total = await getTotalBoard();
      const info = new Map(total.rows.filter((r) => r.userId).map((r) => [r.userId, r]));
      board.rows = board.rows.map((r) => {
        const hit = r.userId && info.get(r.userId);
        if (!hit || r.school) return r;
        return { ...r, school: hit.school, advisor: r.advisor || hit.advisor, province: r.province || hit.province };
      });
    }

    const fname = `oceanbase-${isTotal ? 'total' : 'track-' + questionId}-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(toCsv(board));
  } catch (err) {
    res.status(502).json({ error: 'upstream failure', detail: err.message });
  }
}
