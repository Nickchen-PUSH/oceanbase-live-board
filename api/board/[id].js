import { getTotalBoard, getTrackBoard } from '../../lib/upstream.mjs';
import { cacheHeader, isForce } from '../_csv.mjs';

export default async function handler(req, res) {
  const force = isForce(req);
  const id = String(req.query.id || 'total');
  try {
    const payload =
      id === 'total'
        ? await getTotalBoard({ force })
        : /^\d+$/.test(id.replace(/^q/, ''))
          ? await getTrackBoard(id.replace(/^q/, ''), { force })
          : null;
    if (!payload) return res.status(400).json({ error: 'board must be "total" or "q<questionId>"' });
    res.setHeader('Cache-Control', cacheHeader(force));
    res.status(200).json({ id, ...payload });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'upstream failure', detail: err.message });
  }
}
