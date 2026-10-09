# GridPilot — Agentic Renewable Energy Orchestrator

An optimisation-based control room for an Indian electricity distribution company (DISCOM). It coordinates **solar and wind farms, thermal
units, battery storage, nine customer groups, the grid interconnection and the day-ahead / real-time power exchange (DAM / RTM)** across the
**96 fifteen-minute settlement blocks** of the day, re-plans every block, explains every decision and lets you stress the system with
real-world disturbances (a unit trip, a cloud burst, a demand surge) and watch the agent respond.

Built for the **ET AI Hackathon · Problem 4**. Runs entirely on your machine or on a single small server; no database is needed.

> **Contents** — [Quick start](#quick-start) · [Deploy to Railway](#deploy-to-railway) · [Configuration](#configuration) ·
> [What you see](#what-you-see) · [How the agent works](#how-the-agent-works) · [Shortage handling](#shortage-handling-the-ladder) ·
> [Scenario Lab](#scenario-lab) · [Market, DSM and uploads](#market-dsm-and-uploads) · [Optimisation policy](#optimisation-policy-and-action-selection) ·
> [Ask the Agent](#ask-the-agent) · [Data sources](#data-sources) · [Architecture](#architecture) · [API](#api-reference) ·
> [Testing](#testing) · [Known limitations](#known-limitations) · [Troubleshooting](#troubleshooting) · [Security](#security-notes)

---

## Quick start

**Prerequisites:** [Node.js](https://nodejs.org) 22 or newer (developed on Node 24) and Git. Internet access is optional but recommended
(live weather and national data; the app falls back to a synthetic model without it).

```bash
git clone https://github.com/sharifa2708/GridPilot.git
cd GridPilot
npm install
npm run build        # builds the web UI into client/dist
npm start            # serves UI + API on http://localhost:8787
```

Open **http://localhost:8787**. The first start takes up to about a minute while the engine replays the day; a "starting" screen shows
meanwhile. Later starts are fast because the state is saved to `data/state.json`.

**Development mode** (hot reload for server and UI):

```bash
npm run dev          # API on :8787, UI on http://localhost:5173
```

**Optional — Claude for free-form questions.** Copy `.env.example` to `.env` and put your own Anthropic API key after
`ANTHROPIC_API_KEY=`. Without a key the *Ask the Agent* box still answers common questions from the live data. See [Ask the Agent](#ask-the-agent).

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Server (watch mode) + Vite dev server |
| `npm run build` | Build the UI to `client/dist` |
| `npm start` | Run the server (also serves the built UI) |
| `npm run typecheck` | TypeScript check of server and client |
| `npm test` | Policy / optimiser acceptance tests (17 tests, about 30–45 s) |
| `npm run test:update` | Rewrite `server/test/golden.json` after a deliberate change |

---

## Deploy to Railway

GridPilot is one long-running Node process: it keeps the simulation in memory, ticks every second, streams live updates (Server-Sent Events),
runs the optimiser in worker threads and writes `data/state.json`. It therefore needs a host that keeps a process running (Railway, Render,
Fly.io, a VM). It **cannot run as Vercel serverless functions**; Vercel can only serve the built UI as static files.

1. **Push the project to GitHub** (a private repository is fine). `.gitignore` already excludes `.env`, `data/` and `node_modules/`, so no key or
   saved state is committed.
   ```bash
   git remote add origin https://github.com/sharifa2708/GridPilot.git
   git branch -M main
   git push -u origin main
   ```
2. **Create the service.** In [Railway](https://railway.app): *New Project → Deploy from GitHub repo* and pick the repository.
3. **Build and start commands** (Railway detects Node from `package.json`; set them explicitly if it does not):
   - Build: `npm ci && npm run build`
   - Start: `npm start`
   - Make sure the Node version is 22 or newer (add the variable `NODE_VERSION=24` if needed).
4. **Variables** (*Variables* tab): add `ANTHROPIC_API_KEY` (optional, for Ask the Agent). Do **not** set `PORT`; Railway provides it and the server reads it.
5. **Health check** (*Settings → Deploy*): path `/api/boot`. The service reports `running` once the engine has started.
6. **Persist the state** (optional): add a **Volume** mounted at `/app/data`. Without it every redeploy starts a fresh day, which is fine for a demo.
7. **Size and replicas:** about 1 GB of memory and 1–2 vCPU; the optimiser is CPU-heavy in Simulate mode. Keep **one replica**: the state lives in the
   process, so two instances would not share it.
8. **Public URL:** *Settings → Networking → Generate Domain*. Open it; the first boot takes up to about 75 s.

**Hosting the UI on Vercel (optional).** Add a `vercel.json` that serves `client/dist` and rewrites `/api/*` to your Railway URL. Long-lived
streams through a rewrite can be cut off; if live updates stall, point the UI directly at the Railway address instead (needs an API-base setting
and CORS on the server). Running everything on Railway avoids this.

> Before sharing the URL publicly, read [Security notes](#security-notes): the app has no login.

---

## Configuration

All configuration is by environment variables (put them in `.env` locally, or in the host's variables page). Everything is optional.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | HTTP port (set automatically by most hosts) |
| `ANTHROPIC_API_KEY` | — | Enables Claude for free-form *Ask the Agent* answers |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Model used by Ask the Agent |
| `ANTHROPIC_WORKSPACE_ID` | — | Only if Anthropic says your key "is not scoped to a workspace" |
| `POLICY_CONFIG` | `server/policy/policy.config.json` | Alternative optimisation-policy file |

Runtime settings (autonomy, market and DSM parameters, reserve sizing, simulation speed, the LLM switch) are in the **Settings** page and are saved
with the state. The optimisation policy is a JSON file, see [Editing the policy](#optimisation-policy-and-action-selection).

---

## What you see

The default portfolio is 5 solar farms (600 MW), 3 wind farms (330 MW), 3 thermal units (Korba base 400 MW, Sipat flexible 300 MW, Dahej gas
peaker 150 MW), 2 batteries (200 MW / 800 MWh), and 9 customers (about 1,240 MW peak) on four evacuation corridors. Everything is editable.

| Page | Purpose |
|---|---|
| **Control Room** | Grid frequency, **demand with its surplus / deficit**, market prices, time of day, **cost per unit including DSM**, clean-energy share; stacked dispatch chart with price and battery SOC; the live energy mix; **demand by customer** with cut / deferred / disrupted status; alerts strip; and the **agent panel** (Actions · Criteria · Reasoning · Log) |
| **DAM / RTM Planning** | Optimise a day-ahead or intraday schedule, apply what-if levers, stress-test with Monte-Carlo forecast errors (P10–P90 cost, DSM, deviation), compare with a baseline and **commit** bids. Shows what is already committed |
| **Performance** | Month-end scorecard: renewable utilisation, curtailment, DSM, battery cycles and benefit, forecast error, reserve adequacy, carbon |
| **Portfolio** | Add / edit / remove solar, wind, thermal, battery and customers; place search → coordinates → live weather; map; grid and corridor limits; per-unit restart time after a trip |
| **Maintenance** | Upload an outage plan (CSV / XLSX, template provided), timeline, agent re-scheduling proposals (automatic or by approval) |
| **Data Sources** | What is live, uploaded or modelled; upload IEX day-ahead prices (template provided) |
| **Settings** | Autonomy (autonomous or supervised), market and DSM rules, reserve sizing, simulation speed, reset |
| **Scenario Lab** | Inject disturbances with chosen magnitude, start time and duration; see [Scenario Lab](#scenario-lab) |

### Reading the Demand · Generation card

```
853 MW   27 deficit        ← demand, then the gap
Own gen 675
Grid 177   Buy 0   Sell 0
Δsched +27.4
```

* The big number is the **customers' demand**. Beside it is the gap = *demand − own generation − grid − buy + sell*: positive is a **deficit**
  (red), negative a **surplus** (green), within 5 MW "balanced". Battery charging is not counted.
* **Grid** is the contract import. When the block is drawing more from the grid than scheduled, the over-drawal is added and the figure turns red.
* **Δsched** is actual minus scheduled net drawal. Positive = over-drawal (supplied by the grid, settled as a DSM deviation charge), negative = under-drawal.
  Over-drawal is **not** unserved load.

---

## How the agent works

```
OBSERVE  actual block (digital twin) → persistence-corrected forecasts, prices, asset availability, events
DETECT   situation: frequency, surplus, evening ramp, price spike, battery, transmission, demand spike, forecast error, unit failure
PLAN     96-block MILP (HiGHS, worker thread): unit commitment + economic dispatch + battery + DAM/RTM, every block
DECIDE   changes against the committed schedule, each with its reason and a ₹ comparison
EXPLAIN  shadow prices (LP duals): "stored energy is worth ₹x vs ₹y to store it"
ACT      real-time balancing, DSM settlement, cost accounting
```

**Rolling horizon.** Every block the engine executes the current block, updates its forecasts from what actually happened, and re-plans the next
96 blocks. A re-plan is also triggered at once when a scenario is injected or cleared, a maintenance file is uploaded, or a schedule is committed.

**What happens inside a block and what waits for the next one.** This follows how a control room works:

* **Inside the current block** only physical facts and protective responses happen: generation and demand are what they actually are, a tripped unit
  is lost at once, and the plant follows its schedule. A planned battery charge stops if the block is short. Over-drawal is settled as a deviation.
* **From the next block** the agent changes what is economic: start or stop units, move the battery, buy or sell on the exchange, draw contract power, or cut load.
* The **Actions** panel lists everything the next block's plan does **differently from the committed schedule** (a difference of 1 MW or more).

---

## Shortage handling (the ladder)

When supply cannot cover demand, the agent works down this ladder and stops as soon as the shortage is met:

1. **Thermal** — ramp up (cheapest first, within ramp limits and available capacity)
2. **Contract import** and **exchange purchases** — whichever is cheaper
3. **Demand response** — cut or defer flexible and non-critical load (critical customers are never cut by demand response)
4. **Reserves and battery** — discharge below the normal reserve floor
5. **Curb committed exchange sales** — stop delivering sold energy (settled as a deviation)
6. **Last resort: disruption** shared across all customers, shown as a red "disrupted" status

Inside a block the same order applies to what is physically possible (no purchases or restarts mid-block). The plan uses the ladder in levels:
normal operation keeps demand response off and sales firm; each level releases the next lever only when the shortage requires it, and the plan
notes which levels were used.

---

## Scenario Lab

Inject real-world disturbances to see how the agent responds. Every event has a **magnitude** (where it applies), a **start** (the current block,
the next block, or any block up to 12 hours ahead) and a **duration**.

| Event | Effect |
|---|---|
| Cloud burst | Solar output drops by the chosen % |
| Wind surge / Wind lull | Wind output rises / falls by the chosen % |
| Price spike | Real-time price rises by the chosen % |
| Battery trips | A battery (or all) becomes unavailable |
| Line capacity cut | A corridor's transfer capability falls by the chosen % |
| Demand surge | Customer demand rises by the chosen % (one customer or all) |
| Thermal unit trip | A thermal unit (or all) trips |
| Storm alert | Announced ahead: wind cut-out and reduced solar |
| Forecast update | The agent receives refreshed forecasts |

**Realism.** An event that starts in the current block takes effect **immediately** (cards, customers and alerts change at once, the part of the block
already passed is untouched); the **agent reacts from the next block** because its re-plan comes after it observes the event. Clearing an event works the same way.
Switching between **Live** and **Simulate** clears all scenarios.

**After a thermal trip.** The fault clearing does not bring the unit back instantly. A unit needs its **restart time after a trip** (per unit in
*Portfolio*; defaults Korba 2 h, Sipat 1.5 h, Dahej 30 min) and then the agent plans its start. While it waits, the Control Room shows
"*available – restart pending*" with the time it can return.

**Clock modes.** *Live* follows the real IST clock (15-minute blocks). *Simulate* runs a block every 15, 8 or 5 seconds, or step by step.

---

## Market, DSM and uploads

* **Day-ahead (DAM)**: bids for a delivery day close at **10:00 on the previous day**; after that the day-ahead position is fixed and committing is refused.
* **Real-time (RTM)**: bids close **4 blocks (1 hour)** ahead of delivery; each re-plan may adjust RTM for blocks beyond the gate.
* **DSM (deviation settlement)**, inspired by the CERC 2024 regulations and fully parameterised in *Settings*: deviation from the schedule is charged
  (over-drawal) or credited (under-drawal) against a reference price. The allowed band defaults to 10 % of the scheduled net drawal (at least 200 MW);
  beyond the band the rate rises (×1.2, then ×1.5) up to a ₹12/kWh cap; under-drawal is credited at about 90 % of the reference price inside the band
  only. **A negative DSM figure is a net credit.** Frequency is modelled at 50 Hz and moves only with the DISCOM's own deviation (10,000 MW per Hz).
* **Cost per unit** includes fuel, renewable tariffs, market, contract, demand-response, start-up, fixed charges, battery wear (weighted-average-cost
  accounting) and DSM.
* **Uploads** (Data Sources, Maintenance): a downloadable **template** is provided for both the DAM price file (`Time Block, Time, MCP (Rs/MWh)`) and the
  maintenance plan (`asset, start, end, type, derate_mw, deferrable, description`). Dates are read in IST in several common formats; an empty
  `derate_mw` means a full outage.

---

## Optimisation policy and action selection

One engine decides for the Control Room, the planning workbench and the Scenario Lab:

```
data → SITUATION (what is going on?) → PROFILE (which objectives rank first?) → STAGED OPTIMISATION → VERIFY → ACTIONS + AUDIT
```

* **Situation assessment** (`server/policy/situation.ts`) detects nine kinds of event from actual data, forecasts, asset status, prices and the
  maintenance schedule. Each gets a severity, confidence, time window and evidence. Thresholds, hysteresis (enter / exit) and persistence come from
  the policy file, so noise does not flip the profile.
* **Priority profiles** are ordered objective lists in `server/policy/policy.config.json`. When several events are active their profiles are combined
  by severity- and confidence-weighted rank aggregation, with extra weight for listed interactions.
* **Staged (lexicographic) optimisation** (`server/opt/model.ts`, HiGHS): minimise the first-ranked objective, freeze its result plus a documented
  tolerance, then the next, and so on. A higher-ranked objective is never traded for a lower one. Grid security is a hard constraint and always first.
  Stages already at their bound are skipped; a run that reaches its time limit is reported as **approximate**.
* **Hard constraints** are enforced in the model and re-checked independently on every result (`server/policy/verify.ts`). If demand cannot be served,
  the result is a *shortfall* with unserved energy and the binding limits; nothing is violated silently.
* **Action generators** (`server/policy/candidates.ts`) list what may be done and what is excluded and why; the agent then reports the **changes
  against the committed schedule**. Clusters of actions are judged over a 3-hour window against alternatives (`server/policy/evaluate.ts`).
* **Audit** (`data/audit.jsonl`, `GET /api/audit`): for every run, what was detected, the active profile and why, binding constraints with shadow
  prices, the selected actions, alternatives and uncertainty.

**Editing the policy.** Change `server/policy/policy.config.json` (objectives per profile, thresholds, hysteresis, stage tolerances, allowed actions)
and restart. A broken file is rejected with a message and the previous policy stays in force. There is deliberately no UI for it.

---

## Ask the Agent

The *Reasoning* tab has an **Ask the Agent** box. With `ANTHROPIC_API_KEY` set, a question is answered by Claude using only a JSON snapshot of the
app's own live data (balance, DSM figures and rules, thermal and battery status, customers, market, maintenance, alerts, the plan horizon) and a
glossary of how the app works. The prompt requires: answer only from the data, lead with the direct answer, show any arithmetic, say what is missing
instead of guessing, plain text.

* A reply that is cut off is detected and retried; transient API errors are retried; if Claude is unavailable the **rule-based responder** answers
  common questions (DSM, deficit / surplus, battery, curtailment, cost, thermal units) from the same data.
* Numbers in a Claude answer that cannot be found in the data are flagged under the answer ("figures not found in the live data").
* The last two questions are sent along, so follow-ups work.
* The snapshot is sent to `api.anthropic.com` only when a key is configured and *Allow LLM explanations* is on in Settings.

---

## Data sources

| Input | Source |
|---|---|
| Solar, wind, temperature, storms | **Open-Meteo** (free, no key): irradiance → MW (performance ratio, DC/AC clipping, temperature derate), 100 m wind → power curve, weather codes / gusts → storm risk |
| All-India demand and generation mix | **MeritIndia** (live) → a national stress index scaling the price level |
| Frequency, IEX UMCP | **Vidyut Pravah** (live when published; shown as reference) |
| DAM / RTM prices | Calibrated IEX shape plus forecast error; **upload real IEX DAM MCP files** |
| Maintenance | Your upload (CSV / XLSX); a sample schedule is provided |
| Forecast vs actual | Digital twin: real weather + correlated noise + day-level bias; scenario events perturb the truth |
| Clock | An internet time source (timeapi.io), falling back to the system clock |

Not scraped: Grid-India PDF reports and IEX (no open API); use the uploaders. If a live source is unreachable the app keeps running on its modelled values.

---

## Architecture

```
Browser (React + Vite + Recharts)
   │  REST  /api/*        state snapshots, uploads, settings, planning, scenario events
   │  SSE   /api/stream   state per block / re-plan, telemetry every second
   ▼
Node + Express (server/index.ts)
   ├─ engine.ts      clock, 96-block day, commitments, rolling re-plan, scenario handling, alerts, telemetry
   ├─ twin.ts        "truth" (weather-driven generation, demand) vs the agent's forecast
   ├─ physics.ts     real-time execution of a block, shortage ladder, DSM settlement, cost accounting
   ├─ opt/           MILP model (model.ts) solved by HiGHS in worker threads (optimizer.ts, worker.ts)
   ├─ policy/        situation assessment, priority profiles, action candidates, verification, audit
   ├─ agent.ts       actions, criteria, alerts, reasoning text
   ├─ planning.ts    DAM / RTM workbench and Monte-Carlo
   └─ llm.ts         Ask the Agent (Claude + rule-based fallback)
data/  state.json (persisted state), audit.jsonl, cache/weather.json     ← created at runtime, git-ignored
```

```
server/   index.ts · engine.ts · physics.ts · twin.ts · agent.ts · planning.ts · llm.ts · defaults.ts · types.ts · util.ts
          opt/ (model, optimizer, worker) · policy/ (+ policy.config.json) · data/ (weather, national) · test/
client/   src/pages (Dashboard, Planning, Performance, Portfolio, Maintenance, DataSources, Settings) · src/components · api.ts
scripts/  test-update.mjs
```

Tech: Node 24 / TypeScript (run with `tsx`), Express 5, HiGHS (WebAssembly) for the LP / MILP, React 19, Vite, Recharts, Leaflet, `node:test`.

Planning runs on two solver lanes (plan and background) with a 45 s watchdog; a solve that exceeds its time budget returns the best feasible plan flagged *approximate*.

## API reference

JSON over HTTP under `/api`. The most useful endpoints:

| Method and path | Purpose |
|---|---|
| `GET /api/boot` | Boot status (`running` when ready); use as a health check |
| `GET /api/state` | Full current snapshot |
| `GET /api/stream` | Server-Sent Events: `state`, `telemetry`, `boot` |
| `GET /api/day/:date` · `GET /api/block/:slot` | The 96 rows of a day · one block in detail |
| `GET /api/portfolio` · `POST /api/assets/:kind` · `DELETE /api/assets/:kind/:id` | Read / add / remove solar, wind, thermal, bess |
| `POST /api/customers` · `DELETE /api/customers/:id` | Customers |
| `PUT /api/corridors/:id` · `PUT /api/interconnect` | Grid limits |
| `GET /api/settings` · `PUT /api/settings` | Settings |
| `POST /api/events` · `DELETE /api/events` | Scenario events: add (`type`, `magnitude`, `delayBlocks`, `durationBlocks`, `targetId`) · clear |
| `POST /api/plan` · `POST /api/plan/commit` | Run a DAM / RTM optimisation · commit a draft |
| `GET /api/maintenance` · `…/template` · `POST …/upload` | Maintenance plan |
| `GET /api/market/dam-template` · `POST /api/market/dam-upload` | DAM price file |
| `GET /api/policy` · `GET /api/audit` · `GET /api/audit/latest` | Policy and audit trail |
| `POST /api/ask` | Ask the Agent (`question`, optional `history`) |
| `POST /api/sim/step` · `POST /api/sim/reset` | Advance one block (Simulate) · reset the simulation |

---

## Testing

```bash
npm run typecheck
npm test
```

`npm test` runs 17 tests: ten acceptance cases (normal day, solar surplus, evening ramp with price spike, battery outage in a ramp, demand spike,
transmission constraint, forecast error, thermal failure, combined events, an infeasible demand), the shortage ladder, and tests of the method
(lexicographic ordering, determinism, hysteresis, policy-file validation, action sets). Key results are stored in `server/test/golden.json`; after a
deliberate change to the policy or optimiser run `npm run test:update` and review the diff.

The optimiser result is also checked independently on every run (power balance, thermal limits and ramps, minimum up/down times, battery bounds
and dynamics, import / export / corridor limits, committed volumes, demand-response limits). An additional randomised check of the real-time
physics (20,000 blocks against about 30 invariants) and a planner edge-case sweep were run during development.

---

## Known limitations

This is a simulation and decision-support tool, not a certified dispatch system.

* The **DSM engine is inspired by CERC DSM 2024**, not a settlement-grade implementation; load the exact bands and rates for real use.
* **Settings are not validated on the server.** A non-numeric value in a numeric setting can hang the server until it is restarted, and zero or
  negative values are accepted. Use the Settings page, not hand-written requests.
* **Uploads are accepted loosely**: a blank price cell reads as ₹0, negative or above-cap prices are not rejected, and a maintenance asset name is matched
  by partial text. Check files against the templates.
* **Demand response in the plan** chooses whom to cut by cost within each customer's limit; essential customers (steel, petrochemical, residential and
  so on) have a small allowed share and can be cut when the plan needs it. Critical customers are never cut.
* **Corridor limits** are checked before the shortage ladder, so battery discharge in an emergency can briefly exceed a derated corridor's limit.
* A **started thermal unit reaches its planned output within one block**; start-up ramps are not modelled.
* **Extreme scenarios** (several large events stacked) can make a re-plan take 15–25 s and be flagged approximate; the plan failing is reported, not hidden.
* There is **no authentication** and a single running instance holds all the state.
* Grid frequency is a deliberate simplification: 50 Hz, moved only by the DISCOM's own deviation.

---

## Troubleshooting

| Problem | What to do |
|---|---|
| Blank or "starting" screen for a minute | Normal on first start: the engine replays the day. It is faster once `data/state.json` exists |
| The page looks old after an update | Hard-refresh the browser (Ctrl+Shift+R); the UI is cached |
| Port 8787 already in use | Set `PORT=8790` (or stop the other process) |
| Ask the Agent says "Claude unavailable" | Check `ANTHROPIC_API_KEY`, the *Allow LLM explanations* switch in Settings, and internet access; the rule-based answer is shown meanwhile |
| "Plan failed" | The optimiser exceeded its time budget on an extreme scenario or inconsistent settings (for example battery min SOC = max SOC). Clear the scenarios or fix the setting; the next block re-plans |
| Start over from a clean day | Settings → Reset, or stop the server and delete the `data/` folder |
| Weather or national data missing | The sources are free public APIs; the app keeps running on modelled values and retries |

---

## Security notes

* **No login.** Anyone who can open the URL can change settings, inject scenarios, upload files and use Ask the Agent (which spends your API credit).
  Keep a public deployment private (password in front of it, a private network, or only share it for a short demo).
* **Secrets.** Keep the API key in `.env` or the host's variables, never in the repository. `.env` is git-ignored; only `.env.example` is committed.
* The app makes outbound requests to Open-Meteo, MeritIndia, Vidyut Pravah, timeapi.io and (with a key) `api.anthropic.com`. Nothing else leaves the server.

---

## License and credits

Add a `LICENSE` file before publishing (none is included yet). Weather data from Open-Meteo; national data from MeritIndia and Vidyut Pravah;
optimisation by the HiGHS solver.
