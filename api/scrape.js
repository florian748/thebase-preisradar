// /api/scrape.js — Cron-Ziel für den späteren Auto-Scraper (v1.5)
//
// ARCHITEKTUR (zweistufig, spiegelt die Habyt-Hierarchie):
//   Stufe 1 – DISCOVERY: von der Stadt-/Landing-Page eines Wettbewerbers
//             alle Standort-URLs einsammeln -> als Sub-Quellen anlegen.
//   Stufe 2 – DETAIL:    pro Standort Zimmerkategorien + qm + Monatsraten
//             (T1/T2/T3) ziehen -> als Preispunkte speichern (method:'auto').
//
// Auto-vs-Manuell entscheidet sich PRO STANDORT, nicht pro Wettbewerber.
// Standorte, die sich hier nicht sauber ziehen lassen, bleiben method:'manual'
// und tauchen im Steuerungs-Panel als "nachzutragen" auf.
//
// v1 liefert bewusst noch keine Live-Scrapes (kein Zahl-Dienst, JS-schwere
// Seiten + Anti-Bot lassen sich kostenlos nicht robust scrapen). Diese Route
// ist das fertige Gerüst: Cron ist verdrahtet (vercel.json: 1. & 15. je Monat),
// Adapter werden hier pro Quelle ergänzt.

module.exports = async function handler(req, res) {
  // Optionaler Schutz: nur mit CRON_SECRET auslösbar, falls gesetzt.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${secret}`) {
      res.status(401).json({ ok: false, reason: 'UNAUTHORIZED' });
      return;
    }
  }

  // Adapter-Registry — hier kommen echte Scraper pro Quelle rein.
  const adapters = [
    // { company:'Habyt', city:'Berlin', discover: async()=>[...urls], detail: async(url)=>[...points] },
  ];

  const result = { ranAt: new Date().toISOString(), adapters: adapters.length, scraped: 0, notes: [] };

  if (adapters.length === 0) {
    result.notes.push('Noch keine Adapter konfiguriert – manuelle Erfassung ist aktiv.');
  }

  res.status(200).json({ ok: true, result });
};
