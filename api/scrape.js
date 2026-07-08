// TheBase Preisradar – Auto-Scraping via Claude API (web_search)
// GET  (Cron 1.+15.): markiert Scraping als fällig -> Task erscheint im Frontend
// POST {batch,restart}: verarbeitet N Quellen aus der Queue, schreibt Preispunkte (method:'auto')

const KEY = 'preisradar:state';

export default async function handler(req, res) {
  let kv;
  try { ({ kv } = await import('@vercel/kv')); }
  catch (e) { return res.status(501).json({ ok:false, error:'KV nicht konfiguriert' }); }

  let state;
  try { state = await kv.get(KEY); }
  catch (e) { return res.status(500).json({ ok:false, error:'KV-Lesefehler' }); }
  if (!state) return res.status(400).json({ ok:false, error:'Kein State – Tool zuerst im Browser öffnen' });

  // ---- Cron: nur Fällig-Flag setzen (schnell, kein Timeout-Risiko) ----
  if (req.method === 'GET') {
    state.meta = state.meta || {};
    state.meta.scrapeDueAt = new Date().toISOString();
    state.log = state.log || [];
    state.log.unshift({ ts:new Date().toISOString(), user:'System', action:'Auto-Scraping fällig', details:'Zeitplan (1. & 15. des Monats)' });
    await kv.set(KEY, state);
    return res.status(200).json({ ok:true, marked:true });
  }

  if (req.method !== 'POST') { res.setHeader('Allow','GET, POST'); return res.status(405).json({ ok:false }); }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(501).json({ ok:false, error:'ANTHROPIC_API_KEY fehlt (Vercel → Settings → Environment Variables)' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e){ body = {}; } }
  body = body || {};

  // ---- Queue initialisieren / fortsetzen ----
  const stale = state.scrapeRun && (Date.now() - new Date(state.scrapeRun.startedAt).getTime() > 2*3600*1000);
  if (!Array.isArray(state.scrapeQueue) || body.restart || stale) {
    state.scrapeQueue = (state.registry || []).map(r => r.company + '|' + r.city);
    state.scrapeRun = { startedAt:new Date().toISOString(), checked:0, found:0 };
  }
  const batch = Math.max(1, Math.min(parseInt(body.batch) || 2, 3));
  const todo = state.scrapeQueue.splice(0, batch);
  const today = new Date().toISOString().slice(0, 10);
  let foundThisBatch = 0;
  const results = [];

  for (const key of todo) {
    const [company, city] = key.split('|');
    const reg = (state.registry || []).find(r => r.company === company && r.city === city) || {};
    try {
      const points = await scrapeOne(apiKey, company, city, reg.url);
      for (const p of points) {
        state.points.push({
          id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          scope:'competitor', company, city,
          location: p.location || '—',
          category: p.category || 'Range',
          roomType: ['coliving','studio','apartment'].includes(p.roomType) ? p.roomType : 'studio',
          sqm: (typeof p.sqm === 'number' && p.sqm > 5 && p.sqm < 200) ? p.sqm : null,
          tier: ['t1','t2','t3'].includes(p.tier) ? p.tier : 't1',
          price: p.price,
          priceMax: (typeof p.priceMax === 'number' && p.priceMax > p.price) ? p.priceMax : null,
          serviceFee: null, date: today, method:'auto',
          sourceUrl: p.sourceUrl || reg.url || '', note:'Auto-Scrape', by:'Scraper'
        });
        foundThisBatch++;
      }
      reg.lastScrape = { at:new Date().toISOString(), found:points.length };
      results.push({ source:key, found:points.length });
    } catch (e) {
      reg.lastScrape = { at:new Date().toISOString(), found:0, error:String(e && e.message || e).slice(0,140) };
      results.push({ source:key, found:0, error:String(e && e.message || e).slice(0,140) });
    }
    state.scrapeRun.checked++;
  }
  state.scrapeRun.found += foundThisBatch;

  const remaining = state.scrapeQueue.length;
  if (remaining === 0) {
    state.meta = state.meta || {};
    state.meta.lastScrapeAt = new Date().toISOString();
    delete state.meta.scrapeDueAt;
    delete state.scrapeQueue;
    state.log = state.log || [];
    state.log.unshift({ ts:new Date().toISOString(), user:'Scraper', action:'Auto-Scraping abgeschlossen',
      details: state.scrapeRun.checked + ' Quellen geprüft · ' + state.scrapeRun.found + ' Preispunkte gefunden' });
    if (state.log.length > 500) state.log.length = 500;
  }

  await kv.set(KEY, state);
  return res.status(200).json({ ok:true, processed:todo.length, remaining, foundThisBatch, run:state.scrapeRun, results });
}

// ---- Ein Anbieter: Claude mit Web-Search recherchiert aktuelle Monatspreise ----
async function scrapeOne(apiKey, company, city, url) {
  const prompt =
`Recherchiere die AKTUELLEN öffentlich einsehbaren Monatsmieten (möblierte Apartments/Zimmer, Long-Stay ab 1 Monat) des Anbieters "${company}" in ${city}, Deutschland.${url ? ' Offizielle Website: ' + url : ''}
Regeln:
- Nur konkrete Euro-Beträge aus Quellen von 2026 (Anbieterseite, Inserate auf WG-Gesucht/ImmoScout/Immowelt, aktuelle Vergleichsportale).
- Je gefundener Zimmerkategorie EIN Eintrag. Mietdauer-Zuordnung: t1 = ~1 Monat, t2 = ~3 Monate, t3 = ~6+ Monate. Wenn Dauer unklar: t1.
- roomType: "coliving" (Zimmer in geteilter Wohnung), "studio" (eigene Küche+Bad), "apartment" (größer/getrennte Räume).
- Wenn nichts Belastbares gefunden wird: leeres Array.
Antworte AUSSCHLIESSLICH mit einem JSON-Array, ohne Markdown, ohne Erklärtext:
[{"category":"Studio M","location":"Bezirk/Stadtteil","roomType":"studio","sqm":22,"tier":"t1","price":1234,"priceMax":null,"sourceUrl":"https://..."}]`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      tools: [{ type:'web_search_20250305', name:'web_search', max_uses:3 }],
      messages: [{ role:'user', content: prompt }]
    })
  });
  if (!r.ok) throw new Error('Claude API ' + r.status);
  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[0]); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(p => p && typeof p.price === 'number' && p.price > 200 && p.price < 6000)
    .slice(0, 8);
}
