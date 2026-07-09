# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

TheBase Preisradar — an internal long-stay rent price-tracking tool for TheBase's Berlin and Munich locations vs. coliving/serviced-apartment competitors. German-language UI and code comments; keep new UI text and comments in German to match the existing app.

Deployed on Vercel with Upstash KV (Vercel KV) as shared team state. There is no build step, package manager install, bundler, or test suite — this is deployed as-is.

## Git workflow

- When Florian says "push", "commit", "update GitHub" or similar: run `git add`, `git commit`, and `git push` to `main` directly — **without asking for confirmation first**.
- Otherwise, the default applies: don't commit/push changes on your own initiative, only on explicit instruction.

## Architecture

Three files make up the whole system:

- `public/index.html` — the entire frontend: a single-file app (HTML/CSS/JS, no framework, no build). Chart.js and Leaflet are loaded from CDN via `<script>` tags. All logic (state, rendering, tabs, forms) lives inline in one `<script>` block at the bottom of the file.
- `api/data.js` — a Vercel serverless function that reads/writes the entire app state as one JSON blob in Vercel KV under the key `preisradar:state:v1`. GET returns the stored state (or 501 if KV env vars aren't configured, so the frontend falls back to `localStorage`); POST overwrites it wholesale.
- `api/scrape.js` — a Vercel serverless function that drives AI-assisted competitor price scraping via the Claude API (`web_fetch` + `web_search` tools). GET marks scraping as "due" (used by an external cron trigger — there's no `vercel.json` cron config, scraping is otherwise triggered manually via a button in the UI). POST processes a small batch (1–2 sources) of the scrape queue per call and persists results back to KV, because Vercel's function `maxDuration` (60s, set in `vercel.json`) can't cover scraping the whole registry at once.

### State shape

Everything lives in one JSON object (`STATE` in the frontend, same shape in KV):

- `points` — array of price data points. `scope` is `'base'` (TheBase's own prices) or `'competitor'`. Each point has `company`, `city`, `location`, `category`, `roomType` (`coliving`/`studio`/`apartment`), `sqm`, `tier` (`t1`/`t2`/`t3` = short/medium/long lease length), `price`, `priceBasis` (`warm`/`kalt`), `date`, `method` (`manual`/`auto`), and `status` (e.g. `'review'` for outlier points pending human review).
- `registry` — list of competitors/sources being tracked, each with `company`, `city`, `url`, `segment`, and optionally `type: 'aggregator'` (aggregator sources like Wunderflats/Homelike list many operators under one entry, resolved to real operator names during scraping).
- `lageFactors` — location-quality multipliers keyed by `"city|location"`, used to normalize prices for fair comparison.
- `settings` — `refSqm` (reference apartment size per city), `damp` (dampening factors for location/size normalization), `freshDays`/`dueDays`/`staleDays` (data freshness thresholds), `occupancy` (monthly occupancy % per city), `baseGeo`, `slackWebhook` (optional, for price-movement alerts).
- `log`, `alerts`, `scrapeQueue`/`scrapeRun`, `meta` — activity log, price-movement alerts, in-progress scrape batch state, and misc metadata (versioning, migration flags).

### Frontend structure (`public/index.html`)

- `buildSeed()` — generates the initial seed dataset (hardcoded historical prices for TheBase properties and known competitors) when there's no existing state.
- `migrate(s)` — versioned, idempotent migration of older stored states to the current shape (adds missing fields, merges duplicate registry entries, fixes stale `roomType`s, etc.). Runs on every load. When changing the state shape, add a migration step here rather than assuming existing KV/localStorage data matches the new shape.
- `loadState()` / `save()` — sync state with `/api/data`; fall back to `localStorage` (key in `LS`) if KV isn't configured or the request fails. `save()` always writes to `localStorage` first, then KV if available.
- Pricing/normalization math: `lageOf`, `sizeFactor`, `normPrice`, `fairPrice`, `deltaFair`, `marketBasis`, `entryIndex` — these compute the "Marktindex" (fair-price index normalized for location and size) that the dashboard is built around.
- Rendering is organized by tab, each with a `render*` function (`renderTasks`, `renderDash`, `renderMap`, `renderControl`, `renderSettings`, etc.), invoked together via `renderCurrent()` after any state mutation. There's no component framework or virtual DOM — renders directly rebuild DOM/innerHTML from `STATE`.
- `VERSION` constant at the top of the script — bump it when shipping a change, matching the version number already in `README.md` and page title conventions.

## Environment variables (Vercel project settings)

- `KV_REST_API_URL` / `KV_REST_API_TOKEN` — Upstash KV, via Vercel's Upstash integration.
- `ANTHROPIC_API_KEY` — required for `api/scrape.js` (Claude API calls with `web_fetch`/`web_search` tools).

## Working in this repo

- No install/build/lint/test commands exist. Verify changes by opening `public/index.html` behavior mentally or via a local static server; there is no test harness to run.
- Deployment is via Vercel (git push triggers a deploy per `vercel.json`/Vercel project settings) — there's no separate local dev server defined in this repo.
- Keep `api/data.js` and `api/scrape.js` defensive about missing KV/API-key env vars (they currently degrade gracefully to 501 responses) — don't assume they're always configured.
