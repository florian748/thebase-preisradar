// /api/data.js — geteilte Persistenz über Vercel KV
// GET  -> gibt gespeichertes State-Objekt zurück (oder null)
// POST -> speichert das komplette State-Objekt
//
// Wenn KV (noch) nicht konfiguriert ist, antwortet die Route mit 501,
// damit das Frontend sauber auf LocalStorage zurückfallen kann.

let kv = null;
try {
  // Nur laden wenn die KV-Env-Variablen existieren
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    kv = require('@vercel/kv').kv;
  }
} catch (e) {
  kv = null;
}

const KEY = 'preisradar:state:v1';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!kv) {
    res.status(501).json({ ok: false, reason: 'KV_NOT_CONFIGURED' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const state = await kv.get(KEY);
      res.status(200).json({ ok: true, state: state || null });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (_) { body = null; }
      }
      if (!body || typeof body !== 'object') {
        res.status(400).json({ ok: false, reason: 'INVALID_BODY' });
        return;
      }
      await kv.set(KEY, body);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ ok: false, reason: 'METHOD_NOT_ALLOWED' });
  } catch (e) {
    res.status(500).json({ ok: false, reason: String(e && e.message || e) });
  }
};
