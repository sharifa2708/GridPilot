# GridPilot — Agentic Renewable Energy Orchestrator

An optimisation-based control room for an Indian electricity distribution company (DISCOM). It coordinates **solar and wind farms, thermal
units, battery storage, nine customer groups, the grid interconnection and the day-ahead / real-time power exchange (DAM / RTM)** across the
**96 fifteen-minute settlement blocks** of the day, re-plans every block, explains every decision and lets you stress the system with
real-world disturbances (a unit trip, a cloud burst, a demand surge) and watch the agent respond.

Built for the **ET AI Hackathon · Problem 4**. Runs entirely on your machine or on a single small server; no database is needed.

> **Contents** — [Try the app](#try-the-app) · [Configuration](#configuration) ·
> [What you see](#what-you-see) · [How the agent works](#how-the-agent-works) · [Logic in detail](#logic-in-detail) · [Shortage handling](#shortage-handling-the-ladder) ·
> [Scenario Lab](#scenario-lab) · [Market, DSM and uploads](#market-dsm-and-uploads) · [Optimisation policy](#optimisation-policy-and-action-selection) ·
> [Ask the Agent](#ask-the-agent) · [Data sources](#data-sources) · [Architecture](#architecture) · [API](#api-reference) ·
> [Testing](#testing) · [Known limitations](#known-limitations) · [Troubleshooting](#troubleshooting) · [Security](#security-notes)

---

## Try the app

There are two ways to try GridPilot. Pick whichever suits you.

### A. Hosted demo on Railway

1. Open **https://gridpilot-production-2fe6.up.railway.app**.
2. The first load can show a "starting" screen for up to about a minute while the engine replays the day. Wait for it.
3. Start on the **Control Room**. Watch the dispatch chart, the **Demand · Generation** card and the **agent panel** (Actions · Criteria · Reasoning · Log).
4. Open **Scenario Lab**, inject a disturbance (for example *Thermal unit trip* or *Cloud burst*), then return to the Control Room and watch the alerts, the
   customer table and the agent's actions change. Switch the header toggle from **Live** to **Simulate** (and pick a speed) so a block passes every 5, 8 or 15 seconds instead of every 15 minutes.
5. Open **DAM / RTM Planning** to optimise a schedule, stress-test it and compare it with a baseline.

> **Caveat: price and weather data on the hosted demo might not be live.**
> * **Market prices** (DAM / RTM) are a calibrated IEX *shape* plus modelled forecast error, unless real IEX day-ahead files are uploaded on the **Data Sources** page.
> * **MeritIndia** (all-India demand and generation) and **Vidyut Pravah** (frequency, IEX UMCP) are Indian government / exchange sites that often **refuse
>   connections from servers outside India**. The hosted demo runs on cloud servers abroad, so these two feeds usually show "unreachable" and the app
>   falls back to its modelled values. They work from an Indian network, which is why running locally (option B) from India gives live national data.
> * **Weather** comes from the free Open-Meteo service. If it is rate-limited or unreachable the app uses a synthetic weather model instead.
> * The **Data Sources** page labels every feed as *LIVE*, *MODEL*, *UPLOAD* or *CONFIG*, so you can always see what is real and what is modelled.
>
> Decisions, costs and explanations are internally consistent either way; only the realism of the inputs changes.

The hosted demo has no login and a single shared simulation. If someone else is using it, you will see their scenarios and settings.
Use **Settings → Reset** to start a clean day.

### B. Run it from the GitHub repository

The repository is **https://github.com/sharifa2708/GridPilot** (currently private; you need to be added as a collaborator, or ask the owner to make it public).

```bash
git clone https://github.com/sharifa2708/GridPilot.git
cd GridPilot
npm install          # needs Node.js 22 or newer
npm run build        # builds the web UI into client/dist
npm start            # UI + API on http://localhost:8787
```

Then open **http://localhost:8787** and follow the same steps as in A. Two optional extras:

* **Live data:** nothing to configure. Open-Meteo, MeritIndia and Vidyut Pravah are fetched automatically when reachable. From India you normally get all three.
* **Claude answers in Ask the Agent:** copy `.env.example` to `.env` and put your own Anthropic key after `ANTHROPIC_API_KEY=`, then restart. Never commit `.env`.

For development with hot reload use `npm run dev` and open http://localhost:5173 (port 8787 serves the last *built* UI, so run `npm run build` again after UI changes
if you use that port).

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
858 MW   balanced          ← demand, then the gap
Own gen 547
Grid 13   Buy 298   Sell 0     ← Grid in red: 13 MW drawn beyond the schedule
Δsched +13.0
```

* The big number is the **customers' demand**. Beside it is the gap = *demand − own generation − grid (including over-drawal) − buy + sell*: positive is a
  **deficit** (red), negative a **surplus** (green), within 5 MW "balanced". Battery charging is not counted.
* **Grid** is the contract import. When the block is drawing more from the grid than scheduled, the over-drawal is added and the figure turns red.
* **Δsched** is actual minus scheduled net drawal. Positive = over-drawal (supplied by the grid, settled as a DSM deviation charge), negative = under-drawal.
* **Over-drawal and extra purchases are supply, not a deficit.** A deficit appears only when demand is genuinely **not served** (a demand-response cut or a
  disruption). The three numbers shown (own generation + grid + buy − sell) therefore add up to the demand.

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

## Logic in detail

This section explains, step by step, how GridPilot turns data into a dispatch decision and why. File names point to where each piece lives.

### 1. The two worlds: truth and forecast (`twin.ts`)

GridPilot keeps a **digital twin** of the DISCOM with two views of the same day:

* **Truth**: what physically happens. Weather-driven solar and wind output, customer demand, asset availability, scenario events (a trip, a cloud burst).
* **The agent's view**: what the planner is allowed to know. Forecasts of solar, wind and demand, forecast prices, and the asset status it has been told about.
  Anything injected as a surprise is **invisible to the agent until it has happened**; it only sees it through the next observation.

The gap between the two is the forecast error, and it is what makes the problem hard. Solar and wind come from weather data
(irradiance → MW through performance ratio, DC/AC clipping and a temperature derate; 100 m wind → power curve with cut-in, rated and cut-out speeds),
plus correlated noise and a day-level bias. After each block the engine compares actual with forecast and stores a **persistence ratio** per
plant and for demand. Later forecast blocks are scaled by it, so the agent learns that "the sun is running 8 % below forecast today".

### 2. The loop that runs every block (`engine.ts`)

A block is 15 minutes (96 per day). In **Live** mode the clock is the real IST clock; in **Simulate** mode a block lasts 5, 8 or 15 seconds.

```
1  EXECUTE   run the current block against the truth (physics.ts): what really happened, what it cost, what the DSM charge is
2  OBSERVE   update the persistence ratios, state of charge, unit status, price observations, alerts
3  ASSESS    detect the operating situation (policy/situation.ts) and choose the priority profile
4  PLAN      solve the 96-block MILP for the remaining horizon with that profile (opt/, worker thread)
5  SELECT    compare the new plan with what is already committed; list the differences as actions (policy/candidates.ts, evaluate.ts)
6  EXPLAIN   attach reasons, alternatives, shadow prices and the audit record (agent.ts, policy/audit.ts)
7  PUBLISH   push the new state to every browser over SSE; telemetry streams every second in between
```

A re-plan is also started immediately when something changes outside the clock: a scenario is added or cleared, a maintenance file is uploaded, a schedule
is committed, or a setting changes. Planning never blocks the clock: it runs in worker threads, and the previous plan keeps governing the system until a newer
one lands.

### 3. Detecting the situation (`policy/situation.ts`)

Nine kinds of event are detected from data, not from labels: **frequency deterioration, renewable surplus, evening ramp, price spike, battery outage or low
charge, transmission constraint, demand spike, forecast error, thermal unit failure.** Each detection carries a **severity** (0–1), a **confidence** (0–1), a time window
in blocks and the evidence in plain words.

To stop the profile flipping on noise, every event has **hysteresis**: an *enter* threshold, a lower *exit* threshold, a *persistence* count (it must hold for
several blocks to switch on) and a *hold* time (it stays on briefly after clearing). The thresholds are in `server/policy/policy.config.json`.

### 4. Ranking the objectives, including combined events

There are seven objectives: **Security, Reliability, Reserve, Imbalance (DSM exposure), Cost, Renewable use, Battery use**. Each situation has its own preferred ranking
(the *priority profile*), for example "evening ramp" ranks Cost above DSM exposure and "renewable surplus" ranks Renewable use above Cost.

When several events are active together, the profiles are **blended into one ranking** (severity- and confidence-weighted rank aggregation):

1. The normal-operations ranking always takes part with a small baseline weight (0.25).
2. Each active event contributes its own profile as a ranked vote: an objective ranked first gets the most points, the last gets the fewest.
3. The vote's weight is **event weight × severity × confidence**. A severe, well-evidenced event outweighs a faint one.
4. Pairs of events that make each other worse (listed in the policy file, for example a unit failure during an evening ramp) get a **boost** multiplier.
5. Points are added up and the objectives are sorted. Ties go to the profile of the most severe active event, then to the default order.
6. **Security is always first**, whatever the vote says, because it is a hard physical limit.
7. Events that last only part of the horizon only vote for the blocks they cover.

The audit record keeps every event's severity, confidence, weight, boost and the final order, so any ranking can be traced.

### 5. The optimiser (`opt/model.ts`, solved by HiGHS)

The planner is a **mixed-integer linear programme** over the remaining blocks (up to 96): security-constrained unit commitment plus economic dispatch plus battery
plus exchange trading.

* **Decisions (per block):** solar and wind dispatch (curtailment allowed), thermal on/off (integer) and output, battery charge / discharge, day-ahead and
  real-time buy and sell volumes, contract import, demand-response cut and load shift per customer, unserved energy.
* **Hard constraints:** power balance every block; thermal minimum and maximum output, ramp limits, minimum up and down time, availability and
  maintenance derates; battery power, energy, state-of-charge window and charging dynamics (with efficiency); import, export and **corridor** transfer limits;
  already-committed exchange volumes; DAM / RTM gate times; demand-response limits per customer; critical customers are never cut.
* **Reserve:** an up-reserve and a down-reserve requirement are sized from the demand and from the forecast uncertainty of the renewables
  (larger in storm conditions) and must be held by committed, headroom-bearing units and the battery.
* **Lexicographic stages.** Instead of one weighted cost with trade-off weights, the model solves one **objective group at a time** in the profile's order. It
  minimises group 1, freezes its result plus a documented tolerance as a constraint, then minimises group 2 inside that, and so on. A higher-ranked objective
  can therefore never be bought off by a lower-ranked one. A stage already at its bound (for example zero unserved energy) is skipped. A final tie-break stage
  prefers smooth, stable dispatch so plans do not wobble between equivalent solutions.
* **Time limits.** Two solver lanes (plan and background) run in worker threads with a 45 s watchdog. If the budget runs out, the best feasible plan is returned and
  flagged **approximate**; it is never silently wrong.
* **Independent verification** (`policy/verify.ts`): every result is re-checked by separate code against all the hard constraints. If demand cannot be served, the
  result is an explicit **shortfall** with the unserved energy and the binding limits.
* **Shadow prices.** After the stages, the final LP duals say what one more MWh of a limited resource is worth ("stored energy is worth ₹x against ₹y to store it").
  These become the explanations in the Reasoning tab.

### 6. From plan to actions (`policy/candidates.ts`, `evaluate.ts`)

The plan is not applied blindly. The agent first lists what it **may** do (start or stop a unit, move the battery, buy, sell, draw contract power, cut load) and
what is excluded and why. It then compares the new plan with the **committed schedule** and reports only the differences of 1 MW or more. Clusters of actions
are judged over a 3-hour window against alternatives, with the ₹ difference shown ("not selected: ₹12k dearer").

### 7. What really happens inside a block (`physics.ts`)

Execution is separate from planning. It models what a control room can actually do **within** the 15 minutes:

* The truth is applied: renewables and demand as they are, a tripped unit is lost **at once**, units follow their schedule.
* If the block is short, the **shortage ladder** (next section) is used for physically possible responses only: no purchases or restarts mid-block.
* A planned battery charge stops first when the block is short (it never charges on over-drawn grid power).
* A tripped thermal unit stays down for its **restart time** (per unit) after the fault clears, then the next plan restarts it.
* What is left over becomes a **deviation** from the schedule and is settled by the DSM rules; frequency moves 1 Hz per 10,000 MW of deviation around 50 Hz.
* Costs are accounted per block: fuel, renewable tariffs, exchange, contract, demand response, start-up, fixed charges, battery wear and DSM.

The rule of thumb: **physical facts and protection happen inside the block; economic re-dispatch happens from the next block.**

### 8. Why the answers can be trusted

* The optimiser is **deterministic** and its constraints are **re-verified** independently on every run.
* Every action has a **reason**, a **cost comparison** with an alternative and the **constraint that was binding**.
* Every decision is written to the **audit trail** (`data/audit.jsonl`, `GET /api/audit`).
* Anything the app does not know is labelled (live / model / upload / config) rather than hidden.
* Ask the Agent (Claude) only **explains**; it never makes or changes a dispatch decision. See [Ask the Agent](#ask-the-agent).

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

### How the pieces fit at run time

* **One process holds the state.** `engine.ts` owns the 96-block day: the rows (plan, actual, cost per block), commitments, events, maintenance, settings and
  the persistence ratios. The browser never computes anything; it renders snapshots.
* **Two kinds of updates reach the browser.** A full *state* snapshot is pushed over Server-Sent Events whenever a block executes or a plan lands.
  *Telemetry* (demand, generation, frequency, over-drawal) is pushed every second from a smoothed copy of the current block so the cards move continuously.
* **Optimisation is off the main thread.** `optimizer.ts` hands each model to a worker (`worker.ts`) that loads HiGHS as WebAssembly. The main thread keeps
  serving requests and the clock while a solve runs; a watchdog replaces a stuck worker.
* **Data connectors fail soft.** `data/weather.ts` and `data/national.ts` cache what they fetch (`data/cache/`), retry, and report an error reason. The Data
  Sources page shows each feed as live, model, upload or config, so a failed feed never looks like a real one.
* **Persistence.** State is written to `data/state.json` and every decision to `data/audit.jsonl`. Without a volume on a host, a redeploy starts a fresh day.
* **Agent, policy and optimiser are separate layers.** `policy/` decides *what matters now* (situation, profile, permitted actions, tolerances),
  `opt/` decides *the best schedule under that priority*, `physics.ts` decides *what actually happens*, and `agent.ts` / `llm.ts` decide *how it is explained*.
  This is why the priority order can be edited in a JSON file without touching the optimiser.

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
