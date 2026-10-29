import { getSnapshot } from '../lib/upstream.mjs';
import { cacheHeader, isForce } from './_csv.mjs';

export default async function handler(req, res) {
  const force = isForce(req);
  try {
    const snap = await getSnapshot({ force });
    res.setHeader('Cache-Control', cacheHeader(force));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify(snap));
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'upstream failure', detail: err.message });
  }
}
