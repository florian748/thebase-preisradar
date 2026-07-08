# TheBase · Preisradar (v1)

Wettbewerber-Preisradar für Long-Stay-Monatsraten. Berlin + München, erweiterbar.
Erfassung → geteilte Historie → Normalisierung (Größe/Lage) → Base-Benchmark → Charts + CSV.

## Was v1 kann
- **Datenmodell:** atomarer Preispunkt je Kategorie × Tier (T1 Kurz / T2 Mittel / T3 Lang)
- **Seed:** eure aktuellen Base-Raten (BER + MUC) + Wettbewerber aus den zwei Analyse-Sheets
- **Normalisierung:** `Vergleichspreis = Rohpreis / (Größenfaktor × Lagefaktor)` — Umschalter Roh/Normalisiert
- **Steuerung:** pro Quelle (Anbieter × Standort) frisch/fällig/überfällig + To-Do-Liste
- **Dashboard:** Ø Base vs. Ø Wettbewerb, Delta %, Marktband, Balken + Zeitreihe, CSV-Export
- **Persistenz:** Vercel KV (geteilt im Team) mit LocalStorage-Fallback

## Deploy (wie deine anderen Tools)

1. **GitHub:** dieses Verzeichnis in ein Repo pushen (z.B. `florian748/thebase-preisradar`).
2. **Vercel:** Repo importieren → „Deploy". Läuft sofort (nutzt zunächst LocalStorage).
3. **Geteilte Persistenz aktivieren (KV):**
   - Vercel-Projekt → **Storage** → KV-/Redis-Store anlegen → mit dem Projekt verbinden.
   - Vercel setzt `KV_REST_API_URL` und `KV_REST_API_TOKEN` automatisch als Env-Variablen.
   - **Redeploy.** Ab jetzt sehen alle Nutzer dieselben Daten (Header-Punkt wird grün „Cloud (KV) verbunden").
   - Beim ersten Cloud-Start wird der Seed automatisch hochgeladen.

> Ohne KV läuft alles, aber Einträge bleiben nur auf dem jeweiligen Gerät. Für den Team-Use (Mitarbeiterin trägt ein, du wertest aus) KV verbinden.

## Struktur
```
/public/index.html   Frontend (komplettes Dashboard, The Base Brand)
/api/data.js         GET/POST geteilter State über KV
/api/scrape.js       Cron-Ziel (Scraper-Gerüst, v1.5)
/vercel.json         Cron: 1. & 15. jeden Monats, 06:00
/package.json        @vercel/kv
```

## Roadmap
- **v1.5 Auto-Scraper:** Adapter je Quelle in `/api/scrape.js`. Zweistufig (Discovery → Detail),
  Auto/Manuell pro Standort. Kostenlose Quellen zuerst; JS-schwere/Anti-Bot-Quellen später ggf. über Scraping-API.
- **v1.6 Discovery-Enrichment:** Umkreis-Recherche je Base-Standort → Kandidatenvorschläge zum Freigeben.
- **v2 Alerts:** Schwellen-Benachrichtigung (z.B. Wettbewerber −8 % / Woche).
