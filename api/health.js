import { CAMP_ID, TTL_MS } from '../lib/upstream.mjs';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, campId: CAMP_ID, cacheTtlMs: TTL_MS, at: new Date().toISOString(), runtime: 'vercel' });
}
