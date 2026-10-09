# GridPilot — Agentic Renewable Energy Orchestrator

An enterprise control-room application for an Indian DISCOM (ET AI Hackathon · Problem 4). An optimisation-based
agent coordinates **5+ solar farms, 3+ wind farms, 2 BESS, thermal units, industrial/commercial/residential customers,
grid interconnection and DAM/RTM market access** across the 96 fifteen-minute settlement blocks of the day.

```bash
npm install
npm run dev          # API on :8787, UI on http://localhost:5173
# or, production style:
npm run build && npm start     # serves UI + API on http://localhost:8787
```

Optional: `ANTHROPIC_API_KEY=sk-...` enables free-form "Ask the agent" answers (grounded in optimiser output only).
Without a key a deterministic responder answers from the same data.

## What you see

| Page | Purpose |
|---|---|
| **Control Room** | Frequency, demand, generation, market price, time of day, **cost per unit incl. DSM**, energy mix with ₹/kWh per source; stacked dispatch chart + price + SOC; the **96-row schedule** (history locked, future = live plan); agent panel with **Actions · Criteria · Reasoning · Event log**; reserve, corridor, DSM and forecast-accuracy health cards; alerts strip |
| **DAM / RTM Planning** | Optimise a day-ahead or intraday schedule, apply what-if levers, stress-test with Monte-Carlo forecast errors (P10–P90 cost, DSM, deviation bands), compare to baseline, **commit** bids |
| **Performance** | Month-end KPI scorecard (RE utilisation, curtailment, DSM, BESS cycles & benefit, forecast error, reserve adequacy, carbon…) |
| **Portfolio** | Add / edit / remove solar, wind, thermal, BESS, **customers** (place search → coordinates → live weather), map, grid & corridor limits |
| **Maintenance** | Upload CSV/XLSX outage plan, timeline, agent re-scheduling proposals (auto or approval) |
| **Data Sources** | What is live / uploaded / modelled; upload IEX DAM prices |
| **Settings** | Autonomy (autonomous vs supervised), optimality weights, market & DSM rules, reserve sizing, reset |
| **Scenario Lab** | Inject cloud bursts, wind surges, price spikes, battery trips, line limits, demand surges, frequency events, storm alerts, forecast updates, unit trips |

## How the agent works

```
OBSERVE  actual block (twin) ─► persistence-corrected forecasts, prices, asset availability, events
DETECT   alerts (forecast error, SOC, thermal minimum, RTM>BESS cost, corridor, deficit, curtailment, DSM)
PLAN     96-block MILP (HiGHS, worker thread) — SCUC + economic dispatch + BESS + DAM/RTM, every block
DECIDE   changes to the committed schedule + look-ahead, each with its reason and ₹ comparison
EXPLAIN  shadow prices (LP duals) → "stored energy is worth ₹x vs ₹y to store it"
ACT      real-time balancing (BESS → thermal ramp → deviation), DSM settlement, cost accounting
```

**Priorities** are not one fixed ladder: the objective order depends on the operating situation (see *Optimisation policy and action
selection* below) and is shown live in the *Criteria* tab. Security is always enforced first as a hard constraint.

**Model features:** thermal commitment with min-up/down, ramps, no-load/start-up costs; BESS SOC dynamics, round-trip
efficiency, degradation, grid-support reserve, terminal SOC value; DAM fixed positions + RTM with gate-closure lock;
transmission corridor limits; ISGS/contract import; demand response and load shifting by customer criticality;
upward/downward reserve sized from solar/wind/load forecast error; carbon shadow price; exchange sales only from RE/BESS energy.

## Optimisation policy and action selection

One engine decides for the Control Room, the DAM/RTM planning workbench and the Scenario Lab:

```
data ─► SITUATION (what is going on?) ─► PROFILE (which objectives rank first?) ─► STAGED OPTIMISATION ─► VERIFY ─► ACTIONS + AUDIT
```

* **Situation assessment** (`server/policy/situation.ts`) detects nine kinds of event from actual data, forecasts, asset status, prices and the
  maintenance schedule: frequency deterioration, renewable surplus, evening ramp, price spike, battery outage / low SOC, transmission
  constraint, demand spike, renewable forecast error, thermal unit failure. Each gets a severity, confidence, time window and evidence.
  Thresholds, hysteresis (enter / exit levels) and persistence (evaluations before a change counts, evaluations before it clears) come from the
  policy file, so noise does not flip the profile. System frequency is treated as a grid-wide condition; the DISCOM only responds with reserve,
  restraint on drawal and fast resources.
* **Priority profiles** are ordered objective lists in `server/policy/policy.config.json` (normal, frequency, surplus, ramp, price spike, battery
  outage, transmission, demand spike, forecast error, thermal failure). When several events are active their profiles are **combined** by
  severity- and confidence-weighted rank aggregation, with extra weight for listed interactions (for example an evening ramp together with a
  battery outage). The rationale of every ranking is recorded.
* **Staged (lexicographic) optimisation** (`server/opt/model.ts`, HiGHS): the model minimises the first-ranked objective, freezes its result plus
  a documented tolerance, then the next, and so on. There are no weights between objectives, so a higher-ranked one is never traded for a lower
  one. Stage metrics are physical (MWh unserved, MW·h reserve shortfall, MWh deviation, ₹ cost, MWh curtailed, MWh battery throughput); a final
  tie-break stage prefers smooth thermal output and steady purchases. Grid security (transmission and interconnection limits) always comes
  first because it is a hard constraint. A stage already at its lower bound is skipped; one probe solve can skip all leading slack stages.
  Demand response and load shifting are only available when the active profile allows them, and (policy default) only used when the
  objectives ranked above cost cannot be met without them.
* **Hard constraints** are enforced in the model and re-checked independently on every result (`server/policy/verify.ts`). If demand cannot be
  served the result is a *shortfall* with unserved energy and the limits that bind; if the model is infeasible the constraint families whose
  relaxation restores feasibility are named. Nothing is violated silently.
* **Action generators** (`server/policy/candidates.ts`) list, per category, what may be done (feasible range, constraints, cost components,
  uncertainty, advisory / simulated / approved) and what is excluded and why. The optimiser chooses within them; the agent then reports only the
  **changes against the committed day-ahead schedule**.
* **Action clusters** are judged over the 3-hour window against the committed schedule left untouched, a cost-only dispatch and a
  conservative dispatch (less renewable, more demand), computed with one cost function (`server/policy/evaluate.ts`).
* **Audit** (`server/policy/audit.ts`, `data/audit.jsonl`, `GET /api/audit`, Agent card → Audit tab): for every run, what was detected, the
  active profile and why, binding constraints with shadow prices, feasible actions, the selected cluster, expected impact, alternatives,
  uncertainty and when to re-evaluate.

**Editing the policy.** Change `server/policy/policy.config.json` (objectives per profile, thresholds, hysteresis, stage tolerances, which
actions are allowed, compensation assumptions) and restart. A broken file is rejected with a message and the previous policy stays in force.
There is deliberately no UI for it.

**Tests.** `npm test` runs ten acceptance cases (normal day, solar surplus, evening ramp with price spike, battery outage in a ramp, demand spike,
transmission constraint, forecast error, thermal failure, combined events, an infeasible demand) plus tests of the method (lexicographic
ordering, determinism, hysteresis, policy-file validation, action sets). Results of those cases are stored in `server/test/golden.json`; after a
deliberate change run `npm run test:update` and review the diff.

**Known limits.** One objective order applies to a whole optimisation run (events anywhere in the next 3 hours raise their objectives for the
run); per-block orders are not used. Objectives a profile does not list rank after the listed ones, in the normal-profile order. A stage that
ends on its time limit is reported as approximate (the tie-break stage is exempt). Alternatives are evaluated in the background only when the
situation is not normal.

## Data: real where possible

| Input | Source |
|---|---|
| Solar, wind, temperature, storms | **Open-Meteo** (live, per asset location): irradiance → MW (PR, DC/AC clipping, temperature derate), 100 m wind → power curve, WMO codes/gusts → storm risk |
| All-India demand & generation mix | **MeritIndia** (live) → national stress index scaling the price level |
| Frequency, IEX UMCP | **Vidyut Pravah** (live when published; shown as reference) |
| DAM/RTM prices | Calibrated IEX October shape + forecast error; **upload real IEX DAM MCP files** |
| Maintenance | **Your upload** (CSV/XLSX), sample provided |
| Forecast vs actual | Digital twin: real weather + AR(1) noise + day-level bias; scenario events perturb truth |

Not scraped: Grid-India PDF reports and IEX (no open API) — load them through the uploaders.
The DSM engine is *CERC DSM-2024 inspired* and fully parameterised (Settings); load the exact bands for settlement use.

## Layout

```
server/  engine.ts (clock, rows, commitments, replanning) · opt/model.ts (MILP) · physics.ts (real-time + DSM + ledger)
         twin.ts (truth vs forecast) · agent.ts (actions/criteria/alerts) · planning.ts (DAM/RTM + Monte-Carlo) · data/*
client/  Vite + React + Recharts; pages/ for each view
data/    state.json (persisted), cache/weather.json
```
