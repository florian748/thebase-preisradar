// TheBase Preisradar – Auto-Scraping via Claude API (web_search)
// GET  (Cron 1.+15.): markiert Scraping als fällig -> Task erscheint im Frontend
// POST {batch,restart}: verarbeitet N Quellen aus der Queue, schreibt Preispunkte (method:'auto')

const KEY = 'preisradar:state:v1';

module.exports = async function handler(req, res) {
  let kv = null;
  try {
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) kv = require('@vercel/kv').kv;
  } catch (e) { kv = null; }
  if (!kv) return res.status(501).json({ ok:false, error:'KV nicht konfiguriert' });

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
      const isAgg = reg.type === 'aggregator';
      const points = isAgg
        ? await scrapeAggregator(apiKey, company, city, reg.url)
        : await scrapeOne(apiKey, company, city, reg.url);
      for (const p of points) {
        const realCompany = isAgg ? (p.company || '').trim() : company;
        if (isAgg && !realCompany) continue;
        // Discovery: unbekannten Anbieter automatisch registrieren (ohne manuelle Tasks zu erzeugen — er hat ja sofort Punkte)
        if (isAgg && !(state.registry || []).some(r2 => r2.company === realCompany && r2.city === city)) {
          state.registry.push({ company: realCompany, city, url: '', segment: 'Entdeckt via ' + company });
          state.log = state.log || [];
          state.log.unshift({ ts:new Date().toISOString(), user:'Scraper', action:'Neuer Anbieter entdeckt', details: realCompany + ' (' + city + ') via ' + company });
        }
        const tier = ['t1','t2','t3'].includes(p.tier) ? p.tier : 't1';
        const category = p.category || 'Range';
        // Serie: neuester bestehender Punkt gleicher (Anbieter, Stadt, Kategorie, Tier)
        const series = state.points.filter(x => x.scope==='competitor' && x.company===realCompany && x.city===city && x.category===category && x.tier===tier && x.status!=='review');
        const last = series.sort((a,b)=> (a.date<b.date?1:-1))[0] || null;
        // DEDUPE: identischer Preis -> nur Datum bestätigen, kein neuer Punkt
        if (last && last.price === p.price) { last.date = today; continue; }
        const np = {
          id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          scope:'competitor', company: realCompany, city,
          location: p.location || (last && last.location) || '—',
          category,
          roomType: ['coliving','studio','apartment'].includes(p.roomType) ? p.roomType : (last && last.roomType) || 'studio',
          sqm: (typeof p.sqm === 'number' && p.sqm > 5 && p.sqm < 200) ? p.sqm : (last && last.sqm) || null,
          tier,
          price: p.price,
          priceMax: (typeof p.priceMax === 'number' && p.priceMax > p.price) ? p.priceMax : null,
          serviceFee: null, date: today, method:'auto',
          sourceUrl: p.sourceUrl || reg.url || '', note: isAgg ? 'Auto via ' + company : 'Auto-Scrape', by:'Scraper'
        };
        if (typeof p.address === 'string' && p.address.length > 5) {
          np.address = p.address.slice(0, 120);
          const geo = await geocode(np.address, city);
          if (geo) { np.lat = geo.lat; np.lng = geo.lng; }
        }
        if (last) {
          const chg = p.price / last.price - 1;
          if (Math.abs(chg) > 0.30) {
            // AUSREISSER: nicht ins Dashboard, sondern Review
            np.status = 'review';
            np.note = 'Review: ' + last.price + ' → ' + p.price + ' (' + (chg>0?'+':'') + Math.round(chg*100) + '%)';
          } else if (Math.abs(chg) >= 0.05) {
            // ECHTE BEWEGUNG: übernehmen + Alert
            state.alerts = state.alerts || [];
            state.alerts.unshift({ ts:new Date().toISOString(), seen:false,
              text: company + ' ' + city + ' · ' + category + ' ' + tier.toUpperCase() + ': ' + last.price + ' € → ' + p.price + ' € (' + (chg>0?'+':'') + Math.round(chg*100) + ' %)' });
            if (state.alerts.length > 100) state.alerts.length = 100;
          }
        }
        state.points.push(np);
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
    const newAlerts = (state.alerts || []).filter(a => !a.notified);
    state.log.unshift({ ts:new Date().toISOString(), user:'Scraper', action:'Auto-Scraping abgeschlossen',
      details: state.scrapeRun.checked + ' Quellen geprüft · ' + state.scrapeRun.found + ' neue/geänderte Preispunkte · ' + newAlerts.length + ' Preisbewegungen' });
    if (state.log.length > 500) state.log.length = 500;
    // Optionaler Slack-Alert (Webhook-URL aus Einstellungen)
    const hook = state.settings && state.settings.slackWebhook;
    if (hook && /^https:\/\/hooks\.slack\.com\//.test(hook) && newAlerts.length) {
      try {
        await fetch(hook, { method:'POST', headers:{'content-type':'application/json'},
          body: JSON.stringify({ text: '📡 *Preisradar* — ' + newAlerts.length + ' Preisbewegung(en):\n' + newAlerts.slice(0,10).map(a=>'• '+a.text).join('\n') }) });
      } catch (e) { /* Slack-Fehler nie den Lauf abbrechen lassen */ }
      newAlerts.forEach(a => a.notified = true);
    }
  }

  await kv.set(KEY, state);
  return res.status(200).json({ ok:true, processed:todo.length, remaining, foundThisBatch, run:state.scrapeRun, results });
};

// ---- Nominatim-Geocoding (OSM, sparsam & mit User-Agent gemäß Usage Policy) ----
async function geocode(address, city) {
  try {
    const q = encodeURIComponent(address + ', ' + city + ', Deutschland');
    const r = await fetch('https://nominatim.openstreetmap.org/search?q=' + q + '&format=json&limit=1',
      { headers: { 'User-Agent': 'thebase-preisradar/1.6 (internal pricing tool)' } });
    if (!r.ok) return null;
    const j = await r.json();
    if (Array.isArray(j) && j[0]) return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon) };
  } catch (e) {}
  return null;
}

// ---- Ein Anbieter: Claude mit Web-Search recherchiert aktuelle Monatspreise ----
async function scrapeOne(apiKey, company, city, url) {
  const prompt =
`Recherchiere die AKTUELLEN öffentlich einsehbaren Monatsmieten (möblierte Apartments/Zimmer, Long-Stay ab 1 Monat) des Anbieters "${company}" in ${city}, Deutschland.${url ? ' Offizielle Website: ' + url : ''}
Vorgehen (in dieser Reihenfolge):
1. ${url ? 'Rufe ZUERST die offizielle Website ab (web_fetch auf ' + url + ' und naheliegende Preis-/Zimmerseiten wie /preise, /rooms, /apartments).' : 'Suche zuerst die offizielle Website des Anbieters und rufe deren Preisseite ab.'} Preise von der Anbieterseite sind die bevorzugte Quelle (sourceUrl = Anbieterseite).
2. Nur wenn die Anbieterseite keine konkreten Preise zeigt: Websuche nach aktuellen Inseraten (WG-Gesucht/ImmoScout/Immowelt o.ä.) als Fallback.
Regeln:
- Nur konkrete Euro-Beträge aus Quellen von 2026.
- Je gefundener Zimmerkategorie EIN Eintrag. Mietdauer-Zuordnung: t1 = ~1 Monat, t2 = ~3 Monate, t3 = ~6+ Monate. Wenn Dauer unklar: t1.
- roomType: "coliving" (Zimmer in geteilter Wohnung), "studio" (eigene Küche+Bad), "apartment" (größer/getrennte Räume).
- Wenn nichts Belastbares gefunden wird: leeres Array.
Antworte AUSSCHLIESSLICH mit einem JSON-Array, ohne Markdown, ohne Erklärtext:
[{"category":"Studio M","location":"Bezirk/Stadtteil","address":"Straße Hausnr (falls genannt, sonst null)","roomType":"studio","sqm":22,"tier":"t1","price":1234,"priceMax":null,"sourceUrl":"https://..."}]`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      tools: [{ type:'web_fetch_20250910', name:'web_fetch', max_uses:4 }, { type:'web_search_20250305', name:'web_search', max_uses:3 }],
      messages: [{ role:'user', content: prompt }]
    })
  });
  if (!r.ok) throw new Error('Claude API ' + r.status);
  const data = await r.json();
  return parseJsonArray(data, 8);
}

// ---- Aggregator (Wunderflats/Homelike/HousingAnywhere): liefert Angebote MIT echtem Anbieternamen ----
async function scrapeAggregator(apiKey, aggName, city, url) {
  const prompt =
`Durchsuche die Plattform "${aggName}" (${url}) nach möblierten Long-Stay-Angeboten (ab 1 Monat) in ${city} von PROFESSIONELLEN Anbietern (Coliving-Betreiber, Serviced-Apartment-Ketten — keine Privatvermieter).
Regeln:
- Je Angebot: den ECHTEN Anbieter-/Betreibernamen als "company" (z. B. "Habyt", "Vonder"), NICHT den Plattformnamen.
- Nur konkrete Euro-Monatspreise von 2026. Mietdauer: t1 = ~1 Monat, t2 = ~3 Monate, t3 = ~6+ Monate; unklar = t1.
- Maximal 6 Angebote, bevorzugt bekannte Betreiber mit mehreren Einheiten.
- Wenn nichts Belastbares: leeres Array.
Antworte AUSSCHLIESSLICH mit einem JSON-Array:
[{"company":"Habyt","category":"Studio","location":"Bezirk","address":"Straße Hausnr oder null","roomType":"studio","sqm":22,"tier":"t1","price":1234,"priceMax":null,"sourceUrl":"https://..."}]`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 2000,
      tools: [{ type:'web_fetch_20250910', name:'web_fetch', max_uses:4 }, { type:'web_search_20250305', name:'web_search', max_uses:3 }],
      messages: [{ role:'user', content: prompt }]
    })
  });
  if (!r.ok) throw new Error('Claude API ' + r.status);
  const data = await r.json();
  return parseJsonArray(data, 6);
}

function parseJsonArray(data, cap) {
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[0]); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(p => p && typeof p.price === 'number' && p.price > 200 && p.price < 6000)
    .slice(0, cap);
}
