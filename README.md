# TheBase Preisradar v1.9

Long-Stay-Preisradar Berlin/München. Vercel + Upstash KV (geteilter Team-State).

## Struktur
- public/index.html   — komplette App (Aufgaben, Dashboard, Erfassung, Steuerung, Einstellungen)
- api/data.js         — State lesen/schreiben (KV-Key: preisradar:state:v1)
- api/scrape.js       — KI-Scraping per Button (Claude API: web_fetch der Anbieterseiten + Websuche als Fallback)
- vercel.json         — 60s maxDuration für scrape (kein Cron — Scraping nur per Button)

## Env-Variablen (Vercel → Settings → Environment Variables)
- KV_REST_API_URL / KV_REST_API_TOKEN  — via Upstash-Integration (Connect Project)
- ANTHROPIC_API_KEY                     — für das Scraping (console.anthropic.com)

## v1.9 Features
- Marktindex (100 = fair zum Markt, Lage & Größe bereinigt) + Fair-Preis/Δ-fair je Angebot
- Chart "Preis vs. Lage" mit Fair-Preis-Linie
- Datenqualität: latest-only KPIs, Dedupe beim Scrape, Ausreißer-Review-Tasks (>30 %)
- Alerts bei Preisbewegungen 5–30 % (In-App-Banner, optional Slack-Webhook in Einstellungen)
- Anfrage-Vorlage (Mystery Shopping) für Quellen ohne öffentliche Preise
- Auto-Anlage unbekannter Standorte mit Lagefaktor 1,0
