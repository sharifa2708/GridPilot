// GridPilot engine: clock, 96-block day records, DAM/RTM commitments, real-time execution, rolling re-optimisation,
// agent outputs and persistence. One instance per process.
import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentAction, Alert, BlockRow, Criterion, EventType, Flows, LogEntry, MaintenanceItem, Portfolio, ScenarioEvent, Settings, Telemetry,
} from './types.js';
import { defaultMaintenance, defaultPortfolio, defaultSettings } from './defaults.js';
import { FRC_MW_PER_HZ, getClockOffset, nowMs, setClockOffset, BLOCKS, DT, blockOf, clamp, dateStr, dayOf, gauss, hhmm, mulberry32, round, slotLabel, slotNow, slotOf, sum } from './util.js';
import { createTwin, type Persistence, type Twin } from './twin.js';
import { getNational, nationalStress, refreshNational } from './data/national.js';
import { refreshWeather, weatherStatus } from './data/weather.js';
import type { PlanBlock, PlanInput, PlanOutput } from './opt/model.js';
import { solvePlan } from './opt/optimizer.js';
import {
  accountFlows, cloneState, emptyFlows, executeBlock, initFleetState, thermalHold, type FleetState,
} from './physics.js';
import { assessSituation } from './policy/situation.js';
import { buildPolicyInput } from './policy/build.js';
import { getPolicy } from './policy/config.js';
import { verifyPlan } from './policy/verify.js';
import { generateCandidates } from './policy/candidates.js';
import { metricsOfBaseline, metricsOfPlan } from './policy/evaluate.js';
import { auditLog, buildAudit, judgeAlternative } from './policy/audit.js';
import { GROUP_OBJECTIVE, TIE_LABEL, type HysteresisState, type Situation } from './policy/types.js';
import type { BaselineBlock } from './agent.js';
import { buildActions, buildAlerts, buildCriteria, buildLookahead, buildReasoning, proposeMaintenance, type AgentCtx } from './agent.js';

const DATA_DIR = path.resolve('data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const VERSION = 3;

export interface DamPosition { buy: number[]; sell: number[]; committedSlot: number; objective: number; source: string }

interface AgentOutputs {
  actions: AgentAction[]; lookahead: AgentAction[]; criteria: Criterion[];
  reasoning: { headline: string; bullets: string[]; tradeoff: string };
  alerts: Alert[]; slot: number;
  situation: { profileId: string; label: string; objectives: { id: string; name: string }[]; events: { kind: string; label: string; severity: number; confidence: number; active: boolean; window: [number, number]; evidence: string; note?: string }[]; interactions: string[]; rationale: string[]; frequencyNote: string; stages: { objective: string; status: string; metric: number | null; ms: number; note?: string }[] } | null;
}

export class Engine {
  P: Portfolio = defaultPortfolio();
  S: Settings = defaultSettings();
  maint: MaintenanceItem[] = [];
  events: ScenarioEvent[] = [];
  damUploads = new Map<number, number[]>();
  damPos = new Map<number, DamPosition>();
  /** The committed day-ahead schedule per block; the Actions panel reports only departures from it. */
  baseline = new Map<number, BaselineBlock>();
  rtmCommit = new Map<number, { buy: number; sell: number }>();
  days = new Map<number, BlockRow[]>();
  cursor = 0;
  fleet!: FleetState;
  fleetPrev!: FleetState;
  persistFc: Persistence = { solar: {}, wind: {}, demand: 1, rtmSpread: 0 };
  twin!: Twin;
  log: LogEntry[] = [];
  logSeq = 1;
  status: 'booting' | 'backfilling' | 'running' = 'booting';
  statusMsg = 'Starting…';
  vetoes = new Map<number, { dr?: boolean; curtail?: boolean }>();
  lastPlan: PlanOutput | null = null;
  planVersion = 0;
  planInFlight = false;
  planDirty = false;
  agent: AgentOutputs = { actions: [], lookahead: [], criteria: [], reasoning: { headline: '', bullets: [], tradeoff: '' }, alerts: [], slot: 0, situation: null };
  situation: Situation | null = null;
  hyst: HysteresisState = {};
  auditSeq = 1;
  altBusy = false;
  /** What the optimiser is doing, shown in the header so a block never leaves the operator wondering whether it was planned. */
  optState: { busy: boolean; forTime: string; version: number; ms: number; ok: boolean; approximate: boolean; finishedAt: number; stale: boolean; nextAt: string } = { busy: false, forTime: '', version: 0, ms: 0, ok: true, approximate: false, finishedAt: 0, stale: false, nextAt: '' };
  pendingApprovals: AgentAction[] = [];
  maintProposals: { id: string; itemId: string; newStart: number; newEnd: number; saving: number; reason: string; status: 'pending' | 'approved' | 'rejected' | 'auto-applied' }[] = [];
  alertIds = new Set<string>();
  lastTickWall = 0;
  /** Operating point after an event that began inside the current block; the live cards show it until the next interval. */
  instantAct: Flows | null = null;
  blockElapsedFraction(): number {
    const m = this.S.sim.mode;
    if (m === 'live') return ((Date.now() % 900000) / 900000);
    if (m === 'accelerated') return Math.min(1, Math.max(0, (Date.now() - this.lastTickWall) / (this.S.sim.secondsPerBlock * 1000)));
    return 0;
  }
  subscribers = new Set<(ev: string, data: any) => void>();
  jitter = { f: 0, d: 0, re: 0 };
  actionSeq = 1;
  lastActionSig = new Set<string>();
  lastNotes: string[] = [];
  lastBlockStats = { dsmMW: 0, dsmBand: 100, dsmRate: 0, ratioSolar: 1, ratioWind: 1, ratioLoad: 1 };
  ratioHist: Record<string, number[]> = {};
  prevBessMode: Record<string, number> = {};
  saveTimer: NodeJS.Timeout | null = null;
  tickCount = 0;
  uploadsMeta: { maintenance: string | null; dam: string | null } = { maintenance: null, dam: null };
  ticking = false;

  // ------------------------------------------------------------------ boot
  async boot() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const loaded = this.load();
    this.twin = createTwin({ portfolio: () => this.P, settings: () => this.S, events: () => this.events, maintenance: () => this.maint, damUpload: () => this.damUploads });
    await this.syncClock();
    this.S.sim.mode = 'live'; // always start on the real clock; the operator can switch to simulation afterwards
    this.statusMsg = 'Fetching weather and national grid data…';
    await Promise.allSettled([refreshWeather(this.allLocations()), refreshNational()]);
    const now = slotNow();
    if (!loaded || this.cursor > now || Math.abs(this.cursor - now) > BLOCKS * 3) {
      await this.freshStart(now);
    } else {
      if (this.S.sim.mode === 'live' && this.cursor < now) await this.fastForward(now);
      await this.ensureBaseline(dayOf(now));
      await this.ensureBaseline(dayOf(now) + 1);
      this.status = 'running';
      void this.replan('boot');
    }
    this.status = 'running';
    this.statusMsg = 'Running';
    this.lastTickWall = Date.now();
    setInterval(() => void this.loop(), 1000);
    setInterval(() => void refreshWeather(this.allLocations()).then(() => { this.twin.invalidate(); }), 50 * 60 * 1000);
    setInterval(() => void refreshNational(), 5 * 60 * 1000);
    setInterval(() => void this.syncClock(), 60 * 60 * 1000);
    process.on('SIGINT', () => { this.saveNow(); process.exit(0); });
    process.on('SIGTERM', () => { this.saveNow(); process.exit(0); });
  }

  clockInfo: { source: string; offsetMs: number; checkedAt: number } = { source: 'system clock', offsetMs: 0, checkedAt: 0 };
  /** Cross-check the machine clock against an internet time source (IST); fall back to the system clock. */
  async syncClock() {
    const sources: [string, string, (j: any) => number][] = [
      ['worldtimeapi.org', 'https://worldtimeapi.org/api/timezone/Asia/Kolkata', (j) => Date.parse(j.utc_datetime)],
      ['timeapi.io', 'https://timeapi.io/api/Time/current/zone?timeZone=Asia/Kolkata', (j) => Date.parse(j.dateTime + '+05:30')],
    ];
    for (const [name, url, parse] of sources) {
      try {
        const t0 = Date.now();
        const j: any = await fetch(url, { signal: AbortSignal.timeout(6000) }).then((r) => r.json());
        const t1 = Date.now();
        const remote = parse(j);
        if (!Number.isFinite(remote)) continue;
        const off = remote - (t0 + t1) / 2;
        if (Math.abs(off) < 12 * 3600 * 1000) { setClockOffset(Math.abs(off) < 2000 ? 0 : off); this.clockInfo = { source: name, offsetMs: getClockOffset(), checkedAt: Date.now() }; return; }
      } catch { /* try next */ }
    }
    this.clockInfo = { source: 'system clock', offsetMs: 0, checkedAt: Date.now() };
  }

  allLocations() {
    return [...this.P.solar, ...this.P.wind, ...this.P.thermal, ...this.P.bess].map((a) => a.location).concat(this.P.customers.map((c) => c.location));
  }

  async freshStart(now: number, keepMaint = false) {
    this.status = 'backfilling';
    this.statusMsg = 'Building today\'s day-ahead plan…';
    const day = dayOf(now);
    this.hyst = {};
    this.days.clear(); this.damPos.clear(); this.baseline.clear(); this.rtmCommit.clear(); this.log = []; this.events = [];
    if (!keepMaint) this.maint = defaultMaintenance(day);
    this.fleet = initFleetState(this.P);
    this.fleetPrev = cloneState(this.fleet);
    this.cursor = now;
    for (const d of [day, day + 1]) this.ensureDay(d);
    // D-1 plans for today and tomorrow
    await this.planAndCommitDam(day, 'bootstrap');
    this.statusMsg = 'Day-ahead plan for tomorrow…';
    await this.planAndCommitDam(day + 1, 'bootstrap');
    // replay the elapsed part of today so history is already populated
    this.statusMsg = 'Replaying elapsed blocks of today…';
    this.fleet = initFleetState(this.P);
    this.fleetPrev = cloneState(this.fleet);
    const d0 = slotOf(day, 0);
    for (let s = d0; s <= now; s++) {
      this.cursor = s;
      this.commitRtmWindow(s - 1);
      this.executeCurrent(s, s < now);
      if (s < now && (s - d0) % 4 === 3) { this.statusMsg = `Replaying elapsed blocks… ${hhmm(blockOf(s))}`; await this.replan('replay', true); }
    }
    this.addLog('info', 'system', `Boot complete – replayed ${blockOf(now)} elapsed blocks of ${dateStr(day)}; data from Open-Meteo weather (${weatherStatus.source}).`);
    this.status = 'running';
    void this.replan('boot');
    this.scheduleSave();
  }

  /** Live mode must always show the real block. If the simulation ran ahead, rebuild today from the real time. */
  async resyncToReal() {
    if (this.resyncing) return;
    this.resyncing = true;
    try {
      this.ticking = true;
      const prev = this.status;
      this.status = 'backfilling';
      this.broadcastBoot();
      await this.freshStart(slotNow(), true);
      this.addLog('info', 'system', 'Clock resynced to real IST time (Live mode).');
      void prev;
      this.broadcast();
    } finally { this.ticking = false; this.resyncing = false; }
  }
  resyncing = false;
  broadcastBoot() { for (const f of this.subscribers) f('boot', { status: this.status, msg: this.statusMsg }); }

  async fastForward(now: number) {
    while (this.cursor < now) {
      this.cursor++;
      this.ensureDay(dayOf(this.cursor)); this.ensureDay(dayOf(this.cursor) + 1);
      this.executeCurrent(this.cursor, true);
    }
  }

  // ------------------------------------------------------------------ rows
  blankRow(slot: number): BlockRow {
    const b = blockOf(slot);
    const fc = this.twin.forecastOnly(slot);
    const dam = this.twin.damForecast(slot);
    return {
      slot, b, time: hhmm(b), status: 'future',
      demandFc: sum(Object.values(fc.demand)), demand: sum(Object.values(fc.demand)),
      solarAvailFc: sum(Object.values(fc.solar)), solarAvail: sum(Object.values(fc.solar)),
      windAvailFc: sum(Object.values(fc.wind)), windAvail: sum(Object.values(fc.wind)),
      damPrice: dam, rtmPrice: dam, freq: null, plan: null, act: null, soc: 0, socMWh: 0, shadowPrice: null, smc: null,
      scheduledNet: null, dsmMW: null, cost: null, costPerUnit: null, dsmRate: null, dsmCost: null,
      reserveUpReq: 0, reserveUpAvail: 0, reserveDnReq: 0, reserveDnAvail: 0, emissionsT: null, planVersion: 0,
    };
  }
  ensureDay(day: number): BlockRow[] {
    let rows = this.days.get(day);
    if (!rows) {
      rows = Array.from({ length: BLOCKS }, (_, b) => this.blankRow(slotOf(day, b)));
      const pos = this.damPos.get(day);
      if (pos) rows.forEach((r, b) => { r.damPrice = this.twin.damTruth(r.slot); void pos; void b; });
      this.days.set(day, rows);
    }
    return rows;
  }
  rowAt(slot: number): BlockRow { return this.ensureDay(dayOf(slot))[blockOf(slot)]; }
  totalBessMWh() { return sum(this.P.bess.filter((b) => b.enabled).map((b) => b.energyMWh)); }
  priceFor(slot: number) { return this.damPos.has(dayOf(slot)) ? this.twin.damTruth(slot) : this.twin.damForecast(slot); }

  // ------------------------------------------------------------------ planning inputs
  projectedState(slot0: number) {
    // state entering slot0
    if (slot0 === this.cursor + 1) return { fleet: this.fleet };
    const prev = this.rowAt(slot0 - 1);
    const st = cloneState(this.fleet);
    if (prev.plan) {
      for (const b of this.P.bess) if (prev.plan.by['soc:' + b.id] != null) st.socMWh[b.id] = prev.plan.by['soc:' + b.id];
      for (const u of this.P.thermal) {
        if (prev.plan.by['on:' + u.id] != null) st.thermalOn[u.id] = prev.plan.by['on:' + u.id] > 0.5;
        st.thermalP[u.id] = prev.plan.by[u.id] ?? st.thermalP[u.id];
        st.thermalSince[u.id] = 99;
      }
    }
    return { fleet: st };
  }

  buildInput(mode: 'DAM' | 'INTRADAY', slot0: number, H: number, opt: { overrides?: Overrides; settings?: Settings; fleet?: FleetState; terminalSocPct?: number; stateless?: boolean } = {}): { input: PlanInput; view: ReturnType<Twin['agentView']>; situation: Situation; hysteresis: HysteresisState } {
    const S = opt.settings ?? this.S;
    const st = opt.fleet ?? this.projectedState(slot0).fleet;
    const view = this.twin.agentView(slot0, H, mode === 'DAM' ? slot0 - 1 : this.cursor, this.persistFc, (slot) => (this.damPos.has(dayOf(slot)) ? this.twin.damTruth(slot) : null));
    const o = opt.overrides;
    if (o) {
      for (let t = 0; t < H; t++) {
        for (const k of Object.keys(view.solar[t])) view.solar[t][k] *= 1 + (o.solarPct ?? 0) / 100;
        for (const k of Object.keys(view.wind[t])) view.wind[t][k] *= 1 + (o.windPct ?? 0) / 100;
        for (const k of Object.keys(view.demand[t])) view.demand[t][k] *= 1 + (o.loadPct ?? 0) / 100;
        view.damFc[t] = clamp(view.damFc[t] * (1 + (o.priceShiftPct ?? 0) / 100), 0.5, S.market.priceCap);
        view.rtmFc[t] = clamp(view.rtmFc[t] * (1 + (o.priceShiftPct ?? 0) / 100), 0.5, S.market.priceCap);
        if (o.bessAvailPct != null) for (const k of Object.keys(view.bessPower[t])) view.bessPower[t][k] *= o.bessAvailPct / 100;
        if (o.thermalOutId) view.thermalCap[t][o.thermalOutId] = 0;
        if (o.corridorDeratePct) for (const k of Object.keys(view.ttc[t])) view.ttc[t][k] *= 1 - o.corridorDeratePct / 100;
        view.sigmaUp[t] *= 1 + Math.abs(o.solarPct ?? 0) / 100;
      }
    }
    const lead = S.market.rtmLeadBlocks;
    const lockedDamBuy: (number | null)[] = [], lockedDamSell: (number | null)[] = [], lockedRtmBuy: (number | null)[] = [], lockedRtmSell: (number | null)[] = [];
    const vetoDr: boolean[] = [], vetoCur: boolean[] = [];
    for (let t = 0; t < H; t++) {
      const slot = slot0 + t, day = dayOf(slot), b = blockOf(slot);
      const dp = this.damPos.get(day);
      lockedDamBuy.push(dp ? dp.buy[b] : 0); lockedDamSell.push(dp ? dp.sell[b] : 0);
      const rc = this.rtmCommit.get(slot);
      const rb = rc ? Math.min(rc.buy, Math.max(0, S.market.maxBuyMW - lockedDamBuy[t]!)) : 0, rsl = rc ? Math.min(rc.sell, Math.max(0, S.market.maxSellMW - lockedDamSell[t]!)) : 0;
      if (t < lead) { lockedRtmBuy.push(rb); lockedRtmSell.push(rsl); }
      else { lockedRtmBuy.push(rc ? rb : null); lockedRtmSell.push(rc ? rsl : null); }
      const v = this.vetoes.get(slot);
      vetoDr.push(!!v?.dr); vetoCur.push(!!v?.curtail);
    }
    // 1) situation: what is going on, and therefore which objectives rank first (before anything is optimised)
    const cfg = getPolicy();
    const baseB = this.baseline.get(slot0);
    const live = mode === 'INTRADAY';
    const sitRes = assessSituation({
      cfg, P: this.P, S, view, H, slot0, socMWh: st.socMWh, freq: live ? this.cursorFreq() : 50,
      events: this.events.filter((e) => e.announceSlot <= (live ? this.cursor : slot0)), maint: this.maint,
      last: live ? this.lastBlockStats : { dsmMW: 0, dsmBand: 100, ratioSolar: 1, ratioWind: 1, ratioLoad: 1 },
      committedBuy: lockedDamBuy.map((d, t) => (d ?? 0) + (lockedRtmBuy[t] ?? 0)),
      baseline: live && baseB ? { demand: baseB.demand, solar: baseB.solar, wind: baseB.wind } : null,
      hysteresis: opt.stateless || !live ? {} : this.hyst, stateless: !!opt.stateless || !live,
    });
    // 2) policy: stage order, tolerances, per-block reserve requirement and which actions are permitted
    const policy = buildPolicyInput(cfg, sitRes.situation, H, mode);
    const input: PlanInput = {
      mode, slot0, H, portfolio: this.P, settings: S,
      view: { solar: view.solar, wind: view.wind, demand: view.demand, damPrice: view.damFc, rtmPrice: view.rtmFc, thermalCap: view.thermalCap, bessPower: view.bessPower, ttc: view.ttc, sigmaUp: view.sigmaUp, stormRisk: view.stormRisk },
      state: { socMWh: { ...st.socMWh }, thermalOn: { ...st.thermalOn }, thermalP: { ...st.thermalP }, thermalHold: thermalHold(this.P, st) },
      locked: { damBuy: lockedDamBuy, damSell: lockedDamSell, rtmBuy: lockedRtmBuy, rtmSell: lockedRtmSell },
      vetoes: { dr: vetoDr, curtail: vetoCur },
      terminalSocPct: opt.overrides?.terminalSocPct ?? opt.terminalSocPct ?? 45,
      policy,
    };
    return { input, view, situation: sitRes.situation, hysteresis: sitRes.hysteresis };
  }

  cursorFreq(): number {
    const r = this.days.get(dayOf(this.cursor))?.[blockOf(this.cursor)];
    return r?.freq ?? 50;
  }

  planFlows(pb: PlanBlock): Flows {
    const by = { ...pb.flows.by };
    for (const [k, v] of Object.entries(pb.socByBess)) by['soc:' + k] = v;
    for (const [k, v] of Object.entries(pb.thermalOn)) by['on:' + k] = v ? 1 : 0;
    const f = pb.flows;
    return {
      solar: f.solar, wind: f.wind, thermal: f.thermal, bessDis: f.bessDis, bessCh: f.bessCh, damBuy: f.damBuy, damSell: f.damSell,
      rtmBuy: f.rtmBuy, rtmSell: f.rtmSell, grid: f.grid, curtailSolar: f.curtailSolar, curtailWind: f.curtailWind, dr: f.dr, shiftNet: f.shiftNet,
      unserved: f.unserved, dsmDraw: 0, load: f.load, demand: f.demand, by,
    };
  }

  // ------------------------------------------------------------------ DAM
  storeBaseline(out: PlanOutput, view: ReturnType<Twin['agentView']>) {
    const sv = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    out.blocks.forEach((pb, i) => {
      const f = pb.flows;
      this.baseline.set(pb.slot, { slot: pb.slot, by: { ...f.by }, thermalOn: { ...pb.thermalOn }, socByBess: { ...pb.socByBess }, damBuy: f.damBuy, damSell: f.damSell, rtmBuy: 0, rtmSell: 0, grid: f.grid, curtailSolar: f.curtailSolar, curtailWind: f.curtailWind, dr: f.dr, shiftNet: f.shiftNet, demand: sv(view.demand[i]), solar: sv(view.solar[i]), wind: sv(view.wind[i]) });
    });
  }

  /** Audit record of one optimisation run, plus (when the situation is not normal) alternative action clusters evaluated in the background. */
  recordRun(mode: 'DAM' | 'INTRADAY', input: PlanInput, view: ReturnType<Twin['agentView']>, out: PlanOutput, situation: Situation, actions: AgentAction[]) {
    try {
      const cfg = getPolicy();
      const W = Math.min(cfg.evaluation.windowBlocks, out.blocks.length);
      const verification = verifyPlan(input, out);
      const candidates = generateCandidates({ input, cfg, situation, sigma: view.sigmaUp[0] ?? 0, maint: this.maint });
      const planMetrics = metricsOfPlan('Selected plan', out, view, this.P, this.S, W);
      const baseBlocks = out.blocks.slice(0, W).map((b) => this.baseline.get(b.slot)).filter((x): x is BaselineBlock => !!x);
      const baselineMetrics = mode === 'INTRADAY' && baseBlocks.length === W ? metricsOfBaseline('Committed schedule without intervention', baseBlocks, view, this.P, this.S, W, this.cursorFreq()) : null;
      const rec = buildAudit({ id: `run${this.auditSeq++}`, mode, cfg, situation, input, policy: input.policy!, out, verification, candidates, actions, planMetrics, baselineMetrics, sigma: view.sigmaUp[0] ?? 0, stormRisk: view.stormRisk[0] ?? 0 });
      auditLog.push(rec);
      if (!verification.ok) this.addLog('critical', 'planning', `Plan failed the constraint check: ${verification.violations.slice(0, 2).map((x) => x.constraint + ' ' + x.detail).join('; ')}`);
      if (mode === 'INTRADAY' && cfg.evaluation.alternativesWhenNonNormal && situation.activeKinds.length && !this.altBusy) void this.evaluateAlternatives(rec.id, input, view, planMetrics, W);
    } catch (e: any) {
      this.addLog('warn', 'planning', `Audit record could not be built: ${e?.message ?? e}`);
    }
  }

  async evaluateAlternatives(id: string, input: PlanInput, view: ReturnType<Twin['agentView']>, sel: ReturnType<typeof metricsOfPlan>, W: number) {
    this.altBusy = true;
    try {
      const cfg = getPolicy();
      const pol = input.policy!;
      const alts: ReturnType<typeof judgeAlternative>[] = [];
      // (a) cost-only dispatch: security and reliability stay, then pure cost (reserve / imbalance no longer outrank it)
      const costFirst = ['security', 'reliability', 'cost', 'reserve', 'imbalance', 're', 'bess', 'tie'] as typeof pol.order;
      const a = await solvePlan({ ...input, policy: { ...pol, order: costFirst, timeSec: 3 } }, 'background');
      if (a.ok) alts.push(judgeAlternative('Cost-only dispatch', 'Minimises cost right after security and reliability; reserve and imbalance rank below it.', metricsOfPlan('Cost-only dispatch', a, view, this.P, this.S, W), sel));
      // (b) conservative dispatch: planned for adverse forecasts (less renewable, more demand), judged against the nominal forecast
      const rf = cfg.evaluation.conservativeRenewableFactor, df = cfg.evaluation.conservativeDemandFactor;
      const scale = (arr: Record<string, number>[], k: number) => arr.map((o) => Object.fromEntries(Object.entries(o).map(([key, v]) => [key, v * k])));
      const adverse = { ...input, view: { ...input.view, solar: scale(input.view.solar, rf), wind: scale(input.view.wind, rf), demand: scale(input.view.demand, df) } };
      const c = await solvePlan({ ...adverse, policy: { ...pol, timeSec: 3 } }, 'background');
      if (c.ok) alts.push(judgeAlternative('Conservative dispatch', `Planned for ${Math.round((1 - rf) * 100)}% less renewable output and ${Math.round((df - 1) * 100)}% more demand than forecast.`, metricsOfPlan('Conservative dispatch', c, view, this.P, this.S, W), sel));
      auditLog.patch(id, { alternatives: alts });
    } catch (e: any) { this.addLog('warn', 'planning', `Alternative action clusters could not be evaluated: ${e?.message ?? e}`); } finally { this.altBusy = false; }
  }

  /** After a restart the committed schedule may be missing from memory: rebuild it (without re-committing any bids). */
  async ensureBaseline(day: number) {
    const slot0 = slotOf(day, 0);
    if (this.baseline.has(slot0 + BLOCKS - 1)) return;
    const st = day === dayOf(this.cursor) + 1 ? this.projectedTomorrow() : initFleetState(this.P);
    const { input, view } = this.buildInput('DAM', slot0, BLOCKS, { fleet: st });
    const out = await solvePlan(input);
    if (out.ok) { this.storeBaseline(out, view); this.addLog('info', 'planning', `Day-ahead schedule for ${dateStr(day)} reconstructed as the reference plan.`); }
  }

  async planAndCommitDam(day: number, source: string): Promise<PlanOutput> {
    const slot0 = slotOf(day, 0);
    let st: FleetState;
    if (day === dayOf(this.cursor) && this.status === 'backfilling') st = initFleetState(this.P);
    else if (day === dayOf(this.cursor) + 1) st = this.projectedTomorrow();
    else st = this.projectedState(slot0).fleet;
    const { input, view, situation } = this.buildInput('DAM', slot0, BLOCKS, { fleet: st });
    const out = await solvePlan(input);
    if (!out.ok) { this.addLog('critical', 'planning', `DAM plan for ${dateStr(day)} failed: ${out.status}${out.note ? ' – ' + out.note : ''}`); return out; }
    this.recordRun('DAM', input, view, out, situation, []);
    this.storeBaseline(out, view);
    const buy = out.blocks.map((b) => b.flows.damBuy), sell = out.blocks.map((b) => b.flows.damSell);
    this.damPos.set(day, { buy, sell, committedSlot: this.cursor, objective: out.objective, source });
    const rows = this.ensureDay(day);
    out.blocks.forEach((pb, i) => {
      const r = rows[i];
      if (r.status === 'future') { r.plan = this.planFlows(pb); r.damPrice = this.twin.damTruth(r.slot); r.smc = pb.smc; r.shadowPrice = pb.socValue; this.fillPlanMeta(r, pb); }
    });
    this.addLog('action', 'dam', `DAM schedule for ${dateStr(day)} committed (${source}): ${round(sum(buy), 0)} MW·blocks buy, ${round(sum(sell), 0)} sell, objective ₹${round(out.objective, 0)}k, solved in ${out.solveMs} ms.`);
    return out;
  }

  projectedTomorrow(): FleetState {
    const today = this.ensureDay(dayOf(this.cursor));
    const st = cloneState(this.fleet);
    const last = today[BLOCKS - 1];
    if (last.plan) {
      for (const b of this.P.bess) if (last.plan.by['soc:' + b.id] != null) st.socMWh[b.id] = last.plan.by['soc:' + b.id];
      for (const u of this.P.thermal) {
        if (last.plan.by['on:' + u.id] != null) st.thermalOn[u.id] = last.plan.by['on:' + u.id] > 0.5;
        st.thermalP[u.id] = last.plan.by[u.id] ?? st.thermalP[u.id];
        st.thermalSince[u.id] = 99;
      }
    }
    return st;
  }

  fillPlanMeta(r: BlockRow, pb: PlanBlock) {
    r.reserveUpReq = pb.reserveUpReq; r.reserveUpAvail = pb.reserveUpAvail; r.reserveDnReq = pb.reserveDnReq; r.reserveDnAvail = pb.reserveDnAvail;
    r.soc = (pb.socMWh / Math.max(1, this.totalBessMWh())) * 100; r.socMWh = pb.socMWh;
  }

  // ------------------------------------------------------------------ execution of the current block
  executeCurrent(slot: number, quiet = false) {
    const row = this.rowAt(slot);
    const truth = this.twin.truthAt(slot);
    const pl = row.plan;
    const planOn: Record<string, boolean> = {};
    if (pl) for (const u of this.P.thermal) if (pl.by['on:' + u.id] != null) planOn[u.id] = pl.by['on:' + u.id] > 0.5;
    const rc = this.rtmCommit.get(slot);
    const planForExec = pl ? { ...pl, rtmBuy: rc ? rc.buy : pl.rtmBuy, rtmSell: rc ? rc.sell : pl.rtmSell } : null;
    const px = { dam: this.priceFor(slot), rtm: truth.rtmPrice };
    this.fleetPrev = cloneState(this.fleet);
    const res = executeBlock({ slot, plan: planForExec, planOn, truth, st: this.fleet, P: this.P, S: this.S, freq: truth.freq, px });
    const acc = accountFlows(res.act, this.P, this.S, px, res.st, res.started, res.dsm.cost);
    this.fleet = acc.st;
    // fill row
    const fcRow = { demand: row.demandFc, solar: row.solarAvailFc, wind: row.windAvailFc };
    row.act = res.act; row.demand = res.act.demand;
    row.solarAvail = sum(Object.values(truth.solar)); row.windAvail = sum(Object.values(truth.wind));
    row.damPrice = px.dam; row.rtmPrice = px.rtm; row.freq = clamp(50 - res.act.dsmDraw / FRC_MW_PER_HZ, 49.5, 50.5);
    row.cost = acc.cost; row.costPerUnit = acc.cpu; row.emissionsT = acc.emissions;
    row.dsmRate = res.dsm.rate; row.dsmCost = res.dsm.cost; row.dsmMW = res.dsm.mw; row.scheduledNet = res.scheduledNet;
    row.socMWh = sum(Object.values(this.fleet.socMWh)); row.soc = (row.socMWh / Math.max(1, this.totalBessMWh())) * 100;
    row.status = 'current';
    const prevRow = this.days.get(dayOf(slot - 1))?.[blockOf(slot - 1)];
    if (prevRow && prevRow.status === 'current') prevRow.status = 'past';
    // observation for the agent's persistence forecast
    const base = this.twin.forecastOnly(slot);
    const rat = (a: number, f: number) => (f > 8 ? clamp(a / f, 0.2, 1.6) : 1);
    for (const f of this.P.solar) this.persistFc.solar[f.id] = rat(truth.solar[f.id], base.solar[f.id]);
    for (const f of this.P.wind) this.persistFc.wind[f.id] = rat(truth.wind[f.id], base.wind[f.id]);
    this.persistFc.demand = rat(sum(Object.values(truth.demand)), sum(Object.values(base.demand)));
    this.persistFc.rtmSpread = clamp((px.rtm - px.dam) / Math.max(px.dam, 1), -0.3, 0.6);
    const band = (this.S.dsm.bandPct / 100) * Math.max(Math.abs(res.scheduledNet), 200);
    this.lastBlockStats = {
      dsmMW: res.dsm.mw, dsmBand: band, dsmRate: res.dsm.rate,
      ratioSolar: rat(row.solarAvail, fcRow.solar), ratioWind: rat(row.windAvail, fcRow.wind), ratioLoad: rat(row.demand, fcRow.demand),
    };
    this.lastNotes = res.notes;
    // anomaly watch: farm persistently below forecast although weather is fine
    for (const f of [...this.P.solar]) {
      const r = rat(truth.solar[f.id], base.solar[f.id]);
      const h = (this.ratioHist[f.id] ??= []);
      h.push(r); if (h.length > 4) h.shift();
    }
    if (!quiet) this.logBlock(row, res.notes, res.started);
  }

  logBlock(row: BlockRow, notes: string[], started: string[]) {
    const a = row.act!;
    const t = `${row.time}`;
    for (const n of notes) this.addLog('warn', 'realtime', `[${t}] ${n}`);
    for (const id of started) this.addLog('action', 'thermal', `[${t}] Unit start: ${this.P.thermal.find((u) => u.id === id)?.name}`);
    if (row.freq != null && (row.freq < 49.9 || row.freq > 50.1)) this.addLog('warn', 'frequency', `[${t}] Frequency excursion ${row.freq.toFixed(3)} Hz`);
    if (a.curtailSolar + a.curtailWind > 5) this.addLog('warn', 'curtailment', `[${t}] Curtailed ${(a.curtailSolar + a.curtailWind).toFixed(0)} MW renewables`);
    if (row.dsmCost != null && row.dsmCost > 25) this.addLog('warn', 'dsm', `[${t}] DSM charge ₹${row.dsmCost.toFixed(0)}k (deviation ${row.dsmMW?.toFixed(1)} MW @ ₹${row.dsmRate?.toFixed(2)}/kWh)`);
    for (const b of this.P.bess.filter((x) => x.enabled)) {
      const net = a.by[b.id] ?? 0;
      const mode = net > 5 ? 1 : net < -5 ? -1 : 0;
      if (mode !== (this.prevBessMode[b.id] ?? 0)) {
        this.addLog('action', 'bess', `[${t}] ${b.name}: ${mode === 1 ? `discharging ${net.toFixed(0)} MW` : mode === -1 ? `charging ${(-net).toFixed(0)} MW` : 'idle'} (SOC ${((this.fleet.socMWh[b.id] / b.energyMWh) * 100).toFixed(0)}%)`);
        this.prevBessMode[b.id] = mode;
      }
    }
  }

  // ------------------------------------------------------------------ tick / loop
  async loop() {
    if (this.status !== 'running' || this.ticking) return;
    const now = Date.now();
    const m = this.S.sim.mode;
    if (m === 'paused') return;
    if (m === 'accelerated') {
      if (this.planInFlight) return; // never run ahead of the optimiser: each block starts only after the previous re-plan has landed
      if (now - this.lastTickWall >= this.S.sim.secondsPerBlock * 1000) await this.tick();
    } else if (m === 'live') {
      const real = slotNow();
      if (this.cursor > real) await this.resyncToReal();
      else if (real > this.cursor) await this.tick();
    }
    this.broadcastTelemetry();
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.lastTickWall = Date.now();
      this.instantAct = null;
      // commit RTM bids that enter the gate-closure window
      this.commitRtmWindow(this.cursor);
      this.cursor += 1;
      this.ensureDay(dayOf(this.cursor)); this.ensureDay(dayOf(this.cursor) + 1);
      this.expireEvents();
      this.maintenanceTransitions();
      this.executeCurrent(this.cursor);
      this.tickCount++;
      this.pruneDays();
      // 10:00 – DAM bidding window for tomorrow
      if (blockOf(this.cursor) === 40 && !this.damPos.has(dayOf(this.cursor) + 1)) void this.autoDam();
      if (blockOf(this.cursor) === 0) this.addLog('info', 'system', `New day ${dateStr(dayOf(this.cursor))} – day-ahead schedule ${this.damPos.has(dayOf(this.cursor)) ? 'in force' : 'MISSING (RTM-only)'}`);
      this.broadcast();
      void this.replan('tick');
      if (this.tickCount % 10 === 0) this.scheduleSave();
    } finally {
      this.ticking = false;
    }
  }

  async autoDam() {
    const d = dayOf(this.cursor) + 1;
    await refreshWeather(this.allLocations());
    this.twin.invalidate();
    this.ensureDay(d);
    const out = await this.planAndCommitDam(d, 'auto 10:00 bid window');
    if (out.ok) this.broadcast();
  }

  pruneDays() {
    const keep = dayOf(this.cursor) - 2;
    for (const d of [...this.days.keys()]) if (d < keep) this.days.delete(d);
    for (const d of [...this.damPos.keys()]) if (d < keep) this.damPos.delete(d);
    for (const k of [...this.baseline.keys()]) if (k < keep * BLOCKS) this.baseline.delete(k);
    for (const s of [...this.rtmCommit.keys()]) if (s < this.cursor - BLOCKS) this.rtmCommit.delete(s);
    for (const s of [...this.vetoes.keys()]) if (s < this.cursor) this.vetoes.delete(s);
  }

  expireEvents() {
    const before = this.events.length;
    this.events = this.events.filter((e) => e.endSlot + BLOCKS > this.cursor);
    for (const e of this.events) {
      if (e.startSlot === this.cursor) this.addLog('warn', 'scenario', `Scenario started: ${e.label}`);
      if (e.endSlot === this.cursor) this.addLog('info', 'scenario', `Scenario ended: ${e.label}`);
    }
    void before;
  }

  maintenanceTransitions() {
    for (const m of this.maint) {
      if (m.status === 'deferred') continue;
      if (m.startSlot === this.cursor) { m.status = 'active'; this.addLog('warn', 'maintenance', `Maintenance started: ${m.assetName} – ${m.description}${m.derateMW == null ? ' (full outage)' : ` (−${m.derateMW} MW)`}`); }
      if (m.endSlot === this.cursor) { m.status = 'completed'; this.addLog('info', 'maintenance', `Maintenance completed: ${m.assetName}`); }
    }
  }

  /** Bids for blocks entering the gate-closure window become binding. */
  commitRtmWindow(fromCursor: number) {
    const lead = this.S.market.rtmLeadBlocks;
    for (let k = 1; k <= lead; k++) {
      const slot = fromCursor + k;
      if (!this.rtmCommit.has(slot)) {
        const r = this.rowAt(slot);
        if (r.plan) this.rtmCommit.set(slot, { buy: r.plan.rtmBuy, sell: r.plan.rtmSell });
      }
    }
  }

  // ------------------------------------------------------------------ rolling re-optimisation
  async replan(reason: string, quiet = false): Promise<void> {
    if (this.planInFlight) { this.planDirty = true; return; }
    this.planInFlight = true;
    try {
      do {
        this.planDirty = false;
        const slot0 = this.cursor + 1;
        this.optState = { ...this.optState, busy: true, stale: false, forTime: hhmm(blockOf(slot0)) };
        const { input, view, situation, hysteresis } = this.buildInput('INTRADAY', slot0, BLOCKS);
        const out = await solvePlan(input);
        this.optState = { ...this.optState, busy: false, ms: out.solveMs ?? 0, ok: !!out.ok, approximate: !!out.approximate, finishedAt: Date.now() };
        if (out.status === 'solver timeout') { try { fs.writeFileSync(path.join(DATA_DIR, 'solver-timeout-input.json'), JSON.stringify(input)); } catch { /* diagnostics only */ } }
        if (!out.ok) { this.addLog('critical', 'planning', `Re-optimisation failed (${out.status}) – holding last plan`); continue; }
        if (this.cursor + 1 !== slot0) { this.planDirty = true; continue; } // clock moved on; redo quickly
        this.situation = situation; this.hyst = hysteresis;
        this.applyPlan(out, view, slot0, reason, quiet, input);
        this.optState.version = this.planVersion;
      } while (this.planDirty);
    } finally {
      this.planInFlight = false;
      this.optState.busy = false;
    }
  }

  applyPlan(out: PlanOutput, view: ReturnType<Twin['agentView']>, slot0: number, reason: string, quiet = false, input?: PlanInput) {
    this.planVersion++;
    this.lastPlan = out;
    let st = cloneState(this.fleet);
    out.blocks.forEach((pb, i) => {
      const r = this.rowAt(pb.slot);
      if (pb.slot <= this.cursor) return;
      r.plan = this.planFlows(pb);
      r.act = null; r.status = 'future';
      r.demandFc = pb.flows.demand; r.solarAvailFc = sum(Object.values(view.solar[i])); r.windAvailFc = sum(Object.values(view.wind[i]));
      r.demand = r.demandFc; r.solarAvail = r.solarAvailFc; r.windAvail = r.windAvailFc;
      r.damPrice = view.damFc[i]; r.rtmPrice = view.rtmFc[i];
      r.shadowPrice = pb.socValue; r.smc = pb.smc; r.planVersion = this.planVersion; r.freq = null;
      this.fillPlanMeta(r, pb);
      // plan-cost estimate for the table
      const acc = accountFlows(r.plan, this.P, this.S, { dam: r.damPrice, rtm: r.rtmPrice }, st, Object.entries(pb.started).filter(([, v]) => v).map(([k]) => k), 0);
      r.cost = acc.cost; r.costPerUnit = acc.cpu; r.emissionsT = acc.emissions; st = acc.st;
      r.dsmCost = null; r.dsmMW = null; r.dsmRate = null;
    });
    if (quiet) return;
    // agent outputs
    const ctx = this.agentCtx(out, view);
    const actions = buildActions(ctx);
    const lookahead = buildLookahead(ctx);
    const criteria = buildCriteria(ctx);
    const reasoning = buildReasoning(ctx, criteria, actions);
    const alerts = buildAlerts(ctx);
    // supervised mode: queue approvals
    if (this.S.autonomy === 'supervised') {
      for (const a of actions.filter((x) => x.requiresApproval)) {
        a.status = 'pending';
        if (!this.pendingApprovals.some((p) => p.type === a.type && p.slot === a.slot)) this.pendingApprovals.push(a);
      }
      this.pendingApprovals = this.pendingApprovals.filter((p) => p.slot > this.cursor);
    }
    const sit = this.situation;
    const cfgP = getPolicy();
    this.agent = {
      actions, lookahead, criteria, reasoning, alerts, slot: slot0,
      situation: sit ? {
        profileId: sit.profileId, label: sit.label, objectives: sit.objectives.map((o) => ({ id: o, name: cfgP.objectives[o] })),
        events: sit.events.map((e) => ({ kind: e.kind, label: cfgP.profiles[cfgP.events[e.kind].profile].label, severity: e.severity, confidence: e.confidence, active: e.active, window: [e.startBlock, e.endBlock] as [number, number], evidence: e.evidence, note: e.note })),
        interactions: sit.interactions, rationale: sit.rationale, frequencyNote: sit.frequencyNote,
        stages: (out.stages ?? []).map((st2) => ({ objective: (st2.group === 'tie' ? TIE_LABEL : cfgP.objectives[GROUP_OBJECTIVE[st2.group]]), status: st2.status, metric: st2.metric, ms: st2.ms, note: st2.note })),
      } : null,
    };
    if (input && sit) this.recordRun('INTRADAY', input, view, out, sit, actions);
    for (const al of alerts) if (!this.alertIds.has(al.id + ':' + al.title)) { this.alertIds.add(al.id + ':' + al.title); this.addLog(al.level === 'critical' ? 'critical' : 'warn', 'alert', `${al.title} – ${al.detail}`); }
    if (alerts.length === 0) this.alertIds.clear();
    const sig = new Set(actions.map((a) => `${a.type}:${a.target}`));
    for (const a of actions.slice(0, 4)) {
      const key = `${a.type}:${a.target}`;
      if (!this.lastActionSig.has(key)) this.addLog('action', 'decision', `[${hhmm(blockOf(a.slot))}] ${a.title}${a.mw ? ` (${a.mw.toFixed(0)} MW)` : ''} – ${a.criterion}`);
    }
    this.lastActionSig = sig;
    this.checkMaintenance(ctx, view);
    if (reason !== 'tick' || this.planVersion % 12 === 0) this.addLog('info', 'planning', `Re-optimised (${reason}) v${this.planVersion}: ${out.mip ? 'MILP' : 'LP'} ${out.status}, ₹${round(out.objective, 0)}k over 96 blocks, ${out.solveMs} ms`);
    this.broadcast();
  }

  agentCtx(out: PlanOutput, view: ReturnType<Twin['agentView']>): AgentCtx {
    const rows = [...(this.days.get(dayOf(this.cursor)) ?? [])].filter((r) => r.status === 'past' || r.status === 'current');
    const reAvail = sum(rows.map((r) => r.solarAvail + r.windAvail)), reUsed = sum(rows.map((r) => (r.act?.solar ?? 0) + (r.act?.wind ?? 0)));
    const cost = sum(rows.map((r) => r.cost?.total ?? 0)), served = sum(rows.map((r) => (r.act?.load ?? 0) * DT));
    const dis = sum(rows.map((r) => (r.act?.bessDis ?? 0) * DT));
    const wac = this.fleet.invMWh > 1e-6 ? this.fleet.invCost / this.fleet.invMWh : 3.6;
    const cur = this.rowAt(this.cursor);
    return {
      cursor: this.cursor, P: this.P, S: this.S, plan: out.blocks, view,
      prev: { thermalP: this.fleet.thermalP, socMWh: this.fleet.socMWh },
      thermalHold: thermalHold(this.P, this.fleet),
      recentDsmCostK: sum(Array.from({ length: 4 }, (_, k) => this.days.get(dayOf(this.cursor - k))?.[blockOf(this.cursor - k)]?.dsmCost ?? 0)),
      freq: cur.freq ?? 50, wac,
      today: {
        reUtil: reAvail > 0 ? reUsed / reAvail : 1, dsmCost: sum(rows.map((r) => r.dsmCost ?? 0)), cpu: served > 0 ? cost / served : 0,
        cycles: dis / Math.max(1, this.totalBessMWh()), bessCost: sum(rows.map((r) => r.cost?.bess ?? 0)), reAvail, reUsed, curtailMWh: (reAvail - reUsed) * DT,
      },
      lastBlock: { ...this.lastBlockStats, notes: this.lastNotes }, situation: this.situation, stages: out.stages ?? [], objectiveNames: getPolicy().objectives,
      rtmPrice: view.rtmFc, damPrice: view.damFc,
      securityMode: (cur.freq ?? 50) < 49.9 ? 'low-freq' : (cur.freq ?? 50) > 50.1 ? 'high-freq' : 'normal',
      eventsActive: this.events.filter((e) => this.cursor >= e.startSlot && this.cursor < e.endSlot).map((e) => e.label),
      baseline: this.baseline.get(out.blocks[0]?.slot ?? -1) ?? null,
      custToday: this.customerToday(rows),
      underperforming: this.underperformers(),
      nextId: () => `a${this.actionSeq++}`,
    };
  }

  /** Energy each customer has already deferred (-) / pulled forward (+) and cut, from the executed blocks of today. */
  customerToday(rows: BlockRow[]) {
    const out: Record<string, { shiftMWh: number; drMWh: number }> = {};
    for (const r of rows) {
      if (!r.act) continue;
      for (const cu of this.P.customers) {
        const o = (out[cu.id] ??= { shiftMWh: 0, drMWh: 0 });
        o.shiftMWh += (r.act.by['shift:' + cu.id] ?? 0) * DT;
        o.drMWh += (r.act.by['dr:' + cu.id] ?? 0) * DT;
      }
    }
    return out;
  }

  /** Solar farms below 80 % of forecast for the last hour while the others are on plan (so it is not the weather). */
  underperformers() {
    const last = (id: string) => this.ratioHist[id] ?? [];
    const farms = this.P.solar.filter((f) => f.enabled && last(f.id).length >= 4);
    const out: { id: string; name: string; ratio: number; mw: number }[] = [];
    for (const f of farms) {
      const h = last(f.id);
      if (!h.every((r) => r < 0.8)) continue;
      const peers = farms.filter((x) => x.id !== f.id).map((x) => last(x.id)[last(x.id).length - 1]);
      if (peers.length === 0 || peers.some((r) => r < 0.9)) continue;
      const ratio = h[h.length - 1];
      out.push({ id: f.id, name: f.name, ratio, mw: Math.max(0, (this.rowAt(this.cursor).solarAvailFc / Math.max(1, this.P.solar.length)) * (1 - ratio)) });
    }
    return out;
  }

  checkMaintenance(ctx: AgentCtx, view: ReturnType<Twin['agentView']>) {
    const forecastMW = (id: string, off: number) => (view.solar[off]?.[id] ?? view.wind[off]?.[id] ?? 0);
    const props = proposeMaintenance(this.maint, ctx, forecastMW, (off) => ctx.plan[off]?.smc ?? null);
    for (const p of props) {
      const existing = this.maintProposals.find((x) => x.itemId === p.item.id && x.status === 'pending');
      if (existing) continue;
      if (this.maintProposals.some((x) => x.itemId === p.item.id && (x.status === 'rejected' || x.status === 'auto-applied'))) continue;
      const entry = { id: `mp${this.actionSeq++}`, itemId: p.item.id, newStart: p.newStart, newEnd: p.newEnd, saving: p.saving, reason: p.reason, status: 'pending' as const };
      this.maintProposals.push(entry);
      if (this.S.autonomy === 'autonomous') this.resolveMaintProposal(entry.id, true, true);
      else this.addLog('action', 'maintenance', `Proposal: reschedule "${p.item.description}" (${p.item.assetName}) – saves ≈₹${p.saving.toFixed(0)}k. Awaiting approval.`);
    }
  }

  resolveMaintProposal(id: string, approve: boolean, auto = false) {
    const p = this.maintProposals.find((x) => x.id === id);
    if (!p || p.status !== 'pending') return false;
    const it = this.maint.find((m) => m.id === p.itemId);
    if (!it) return false;
    if (approve) {
      const oldS = slotLabel(it.startSlot);
      it.endSlot = p.newEnd; it.startSlot = p.newStart; it.note = `Rescheduled by GridPilot from ${oldS} (saves ≈₹${p.saving.toFixed(0)}k)`;
      p.status = auto ? 'auto-applied' : 'approved';
      this.addLog('action', 'maintenance', `${auto ? 'Auto-rescheduled' : 'Approved & rescheduled'}: "${it.description}" (${it.assetName}) → ${slotLabel(it.startSlot)}. ${p.reason}`);
      this.twin.invalidate(); this.refreshFutureForecasts();
      void this.replan('maintenance change');
    } else { p.status = 'rejected'; this.addLog('info', 'maintenance', `Rejected rescheduling of "${it.description}" – schedule kept.`); }
    return true;
  }

  resolveAction(id: string, approve: boolean) {
    const a = this.pendingApprovals.find((x) => x.id === id);
    if (!a) return false;
    a.status = approve ? 'approved' : 'rejected';
    this.pendingApprovals = this.pendingApprovals.filter((x) => x.id !== id);
    if (!approve) {
      const key = a.type === 'dr' ? 'dr' : a.type === 'curtail_solar' || a.type === 'curtail_wind' ? 'curtail' : null;
      if (key) { for (let s = a.slot; s < a.slot + 8; s++) this.vetoes.set(s, { ...this.vetoes.get(s), [key]: true }); }
      this.addLog('action', 'approval', `Operator rejected "${a.title}" – action vetoed for the next 2 hours; re-optimising.`);
      void this.replan('operator veto');
    } else this.addLog('action', 'approval', `Operator approved "${a.title}".`);
    return true;
  }

  // ------------------------------------------------------------------ mutations from the UI
  refreshFutureForecasts() {
    for (const rows of this.days.values()) for (const r of rows) {
      if (r.slot > this.cursor && r.status === 'future') {
        const b = this.blankRow(r.slot);
        r.demandFc = b.demandFc; r.demand = b.demand; r.solarAvailFc = b.solarAvailFc; r.solarAvail = b.solarAvail; r.windAvailFc = b.windAvailFc; r.windAvail = b.windAvail;
      }
    }
  }

  async portfolioChanged(reason: string) {
    for (const b of this.P.bess) if (this.fleet.socMWh[b.id] == null) { this.fleet.socMWh[b.id] = (b.initialSocPct / 100) * b.energyMWh; this.fleet.invMWh += this.fleet.socMWh[b.id]; this.fleet.invCost += this.fleet.socMWh[b.id] * 3.6; }
    for (const id of Object.keys(this.fleet.socMWh)) if (!this.P.bess.find((b) => b.id === id)) { const v = this.fleet.socMWh[id]; this.fleet.invMWh = Math.max(0, this.fleet.invMWh - v); this.fleet.invCost = Math.max(0, this.fleet.invCost - v * 3.6); delete this.fleet.socMWh[id]; }
    for (const u of this.P.thermal) if (this.fleet.thermalOn[u.id] == null) { this.fleet.thermalOn[u.id] = false; this.fleet.thermalP[u.id] = 0; this.fleet.thermalSince[u.id] = 99; this.fleet.cumStarts[u.id] = 0; }
    this.statusMsg = 'Fetching weather for new locations…';
    await refreshWeather(this.allLocations());
    this.twin.invalidate();
    this.refreshFutureForecasts();
    this.addLog('action', 'portfolio', reason);
    void this.replan('portfolio change');
    this.scheduleSave();
    this.broadcast();
  }

  async updateSettings(patch: Partial<Settings>) {
    const prevMode = this.S.sim.mode;
    this.S = { ...this.S, ...patch, weights: { ...this.S.weights, ...patch.weights }, market: { ...this.S.market, ...patch.market }, dsm: { ...this.S.dsm, ...patch.dsm }, reserve: { ...this.S.reserve, ...patch.reserve }, sim: { ...this.S.sim, ...patch.sim }, llm: { ...this.S.llm, ...patch.llm } };
    if (patch.sim && prevMode !== this.S.sim.mode) {
      // moving between the Live and Simulate clocks starts the Scenario Lab afresh: events belong to the run they were injected in
      if (((prevMode === 'live' && this.S.sim.mode === 'accelerated') || (prevMode === 'accelerated' && this.S.sim.mode === 'live')) && this.events.length) {
        this.events = []; this.hyst = {}; this.instantAct = null;
        this.twin.invalidate(); this.refreshFutureForecasts();
        if (this.S.sim.mode === 'accelerated') { this.reflectEventChange(); void this.replan('scenarios cleared'); }
        this.addLog('info', 'scenario', 'Scenarios cleared (the clock mode changed)');
      }
      this.addLog('info', 'system', `Simulation clock → ${this.S.sim.mode}${this.S.sim.mode === 'accelerated' ? ` (${this.S.sim.secondsPerBlock}s per block)` : ''}`);
      if (this.S.sim.mode === 'live') {
        if (this.cursor > slotNow()) await this.resyncToReal();
        else if (this.cursor < slotNow() - 1) { this.ticking = true; try { await this.fastForward(slotNow()); } finally { this.ticking = false; } }
      }
    }
    if (patch.weights || patch.market || patch.reserve || patch.dsm || patch.autonomy) { this.twin.invalidate(); this.refreshFutureForecasts(); void this.replan('settings change'); }
    this.scheduleSave(); this.broadcast();
  }

  /**
   * An event began, or was cleared, inside the block already in progress. The part of the block that has passed stays as it was; from now on the plant
   * and the load behave as they now would. The post-change operating point is worked out for the whole block, then blended with the original by the
   * share of the block still to run, so no elapsed time is rewritten. The live cards switch to the new values at once.
   */
  reflectEventChange() {
    if (this.status !== 'running' || this.ticking || this.rowAt(this.cursor).status !== 'current') return;
    const row = this.rowAt(this.cursor);
    const keep = { act: row.act, cost: row.cost, costPerUnit: row.costPerUnit, emissionsT: row.emissionsT, dsmCost: row.dsmCost, dsmMW: row.dsmMW, socMWh: row.socMWh, soc: row.soc, demand: row.demand };
    const oldFleet = this.fleet;
    const frac = this.blockElapsedFraction();
    this.fleet = cloneState(this.fleetPrev);
    this.executeCurrent(this.cursor, true);
    this.instantAct = row.act ? JSON.parse(JSON.stringify(row.act)) : null; // what the plant does from this moment (shown by the live cards)
    if (frac > 0) {
      const w = 1 - frac;
      const mix = (x: any, y: any): any => (typeof x === 'number' && typeof y === 'number' ? x + w * (y - x) : x && y && typeof x === 'object' && typeof y === 'object' ? Object.fromEntries(Object.keys(y).map((k) => [k, mix(x[k], y[k])])) : y);
      for (const k of Object.keys(keep) as (keyof typeof keep)[]) (row as any)[k] = mix(keep[k], (row as any)[k]);
      const now = this.fleet;
      this.fleet = mix(oldFleet, now);
      // equipment state is not an average: a unit is either running or it has tripped, so it takes the post-event state (an averaged output of a tripped unit
      // would otherwise look like a ramp-down the plant cannot make)
      this.fleet.thermalOn = now.thermalOn; this.fleet.thermalP = now.thermalP; this.fleet.thermalSince = now.thermalSince; this.fleet.cumStarts = now.cumStarts;
    }
    this.telSmooth = null; // show the new values immediately, not through the smoothing filter
    this.broadcastTelemetry();
  }

  addEvent(type: EventType, opts: { durationBlocks?: number; targetId?: string; magnitude?: number; delayBlocks?: number }) {
    const clampN = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
    const dur = Math.round(clampN(opts.durationBlocks, 1, 96, 8));
    const delay = Math.round(clampN(opts.delayBlocks, 0, 96, 0)); // 0 = the current block (the default: the event happens now)
    const defaults: Record<EventType, [number, string]> = {
      cloud_cover: [0.6, 'Cloud burst over solar'], wind_surge: [0.5, 'Wind surge'], wind_drop: [0.6, 'Wind lull'], price_spike: [0.8, 'Electricity price spike'],
      bess_outage: [1, 'Battery unavailable'], line_limit: [0.45, 'Transmission line capacity reduced'], demand_surge: [0.2, 'Unexpected industrial demand increase'],
      freq_dip: [0.18, 'Grid frequency dip'], freq_high: [0.18, 'Grid frequency rise'], forecast_update: [0, 'Weather forecast updated'], storm_alert: [1, 'Storm alert'], thermal_trip: [1, 'Thermal unit trip'],
    };
    const [mag, base] = defaults[type];
    const start = type === 'storm_alert' ? this.cursor + (opts.delayBlocks != null ? delay : 9) : this.cursor + delay;
    const target = opts.targetId ? [...this.P.solar, ...this.P.wind, ...this.P.thermal, ...this.P.bess, ...this.P.corridors, ...this.P.customers].find((x: any) => x.id === opts.targetId) : undefined;
    const ev: ScenarioEvent = {
      id: `ev${this.actionSeq++}`, type, startSlot: start, endSlot: start + (type === 'forecast_update' ? BLOCKS : dur), targetId: opts.targetId,
      magnitude: opts.magnitude != null ? clampN(opts.magnitude, 0, 2, mag) : mag, announceSlot: type === 'storm_alert' ? this.cursor + 1 : start,
      label: `${base}${target ? ` – ${(target as any).name}` : ''}${type !== 'forecast_update' ? ` (${dur * 15} min)` : ''}`,
    };
    this.events.push(ev);
    this.twin.invalidate();
    this.refreshFutureForecasts();
    // An event that begins in the block already in progress changes the plant from now on (see reflectEventChange).
    if (ev.startSlot <= this.cursor) {
      if (type === 'thermal_trip' || type === 'bess_outage') this.addLog('critical', 'alert', `${base}${target ? ' – ' + (target as any).name : ''}: out of service now`);
      this.reflectEventChange();
    }
    this.addLog('warn', 'scenario', `Scenario injected: ${ev.label} – starts ${hhmm(blockOf(ev.startSlot))}`);
    // The physical effect is immediate. The plan is out of date from this moment, so the agent re-optimises at once; the new plan starts with the NEXT
    // interval (the current one is already running). An unannounced event that begins later is not visible to the agent until it starts.
    const announced = type === 'storm_alert' || type === 'forecast_update';
    this.optState.stale = ev.startSlot > this.cursor && !announced;
    void this.replan('scenario ' + type);
    this.scheduleSave(); this.broadcast();
    return ev;
  }
  clearEvents() { this.events = []; this.hyst = {}; // a cleared scenario is over: no event is held on for stability
    this.twin.invalidate(); this.refreshFutureForecasts();
    this.reflectEventChange(); // the plant and the load return to normal from now on, and the agent sees it in what it observes
    this.addLog('info', 'scenario', 'All scenarios cleared'); void this.replan('scenarios cleared'); this.broadcast(); }

  setMaintenance(items: MaintenanceItem[], source: string) {
    this.maint = items;
    this.uploadsMeta.maintenance = source;
    this.twin.invalidate(); this.refreshFutureForecasts();
    this.addLog('action', 'maintenance', `Maintenance schedule loaded (${source}): ${items.length} items`);
    this.maintProposals = [];
    // work that is already under way takes effect now (like an event); the agent re-plans around it
    for (const m of this.maint) if (m.status !== 'deferred' && this.cursor >= m.startSlot && this.cursor < m.endSlot) { m.status = 'active'; this.addLog('warn', 'maintenance', `Maintenance in progress: ${m.assetName} – ${m.description}${m.derateMW == null ? ' (full outage)' : ` (−${m.derateMW} MW)`}`); }
    this.reflectEventChange();
    void this.replan('maintenance upload');
    this.scheduleSave(); this.broadcast();
  }

  setDamUpload(day: number, prices: number[], source: string) {
    this.damUploads.set(day, prices);
    this.uploadsMeta.dam = source;
    this.twin.invalidate(); this.refreshFutureForecasts();
    this.addLog('action', 'market', `DAM price file loaded for ${dateStr(day)} (${source})`);
    void this.replan('price upload');
    this.scheduleSave(); this.broadcast();
  }

  // ------------------------------------------------------------------ telemetry, KPIs, snapshots
  /** Equipment that is out of service right now. This is observed, not planned, so it is shown at once and does not wait for the next re-plan. */
  withLiveAlerts(planned: Alert[]): Alert[] {
    if (this.status !== 'running') return planned;
    const truth = this.twin.truthAt(this.cursor);
    const out: Alert[] = [];
    for (const u of this.P.thermal.filter((x) => x.enabled)) {
      if ((truth.thermalCap[u.id] ?? u.capacityMW) < (u.minLoadPct / 100) * u.capacityMW - 1e-6) out.push({ id: 'th-out-' + u.id, level: 'critical', title: `${u.name} unavailable`, detail: `${u.name} (${u.capacityMW} MW) is out of service now. The real-time response is covering the gap; the agent re-plans at the next interval.`, slot: this.cursor });
    }
    // a tripped unit whose fault has cleared is available but still has to be restarted: say when it can be back
    {
      const hold = thermalHold(this.P, this.fleet);
      for (const u of this.P.thermal.filter((x) => x.enabled)) {
        const clear = (truth.thermalCap[u.id] ?? u.capacityMW) >= (u.minLoadPct / 100) * u.capacityMW - 1e-6;
        if (clear && !this.fleet.thermalOn[u.id] && this.fleet.thermalTripped?.[u.id] && (hold[u.id] ?? 0) > 0) {
          const h = hold[u.id], at = hhmm(blockOf(this.cursor + 1 + h)), mins = (h + 1) * 15, span = mins >= 60 ? `${+(mins / 60).toFixed(2)} h` : `${mins} min`;
          out.push({ id: 'th-restart-' + u.id, level: 'warn', title: `${u.name} available – restart pending`, detail: `The fault has cleared but the unit has to be restarted after the trip. It can be back on line from ${at} (in ${span}); the agent plans its start then.`, slot: this.cursor });
        }
      }
    }
    for (const b of this.P.bess.filter((x) => x.enabled)) {
      if ((truth.bessPower[b.id] ?? b.powerMW) <= 0) out.push({ id: 'bess-out-' + b.id, level: 'critical', title: `${b.name} unavailable`, detail: `${b.name} is out of service now. The agent re-plans at the next interval.`, slot: this.cursor });
    }
    // deviation from schedule: about now, not about the whole day (the day's total stays on the DSM card and would keep an alert on until midnight)
    {
      const row = this.rowAt(this.cursor); // read from the block itself so it also holds right after a restart
      const lb = { dsmMW: row.dsmMW ?? 0, dsmBand: (this.S.dsm.bandPct / 100) * Math.max(Math.abs(row.scheduledNet ?? 0), 200) }, dev = Math.abs(lb.dsmMW);
      const recent = sum(Array.from({ length: 4 }, (_, k) => this.days.get(dayOf(this.cursor - k))?.[blockOf(this.cursor - k)]?.dsmCost ?? 0));
      if (dev > lb.dsmBand) out.push({ id: 'dsm', level: 'critical', title: 'Deviation outside the allowed band', detail: `Drawal is ${lb.dsmMW >= 0 ? 'over' : 'under'} schedule by ${dev.toFixed(1)} MW (band ±${lb.dsmBand.toFixed(0)}). Deviation charge in the last hour: ₹${recent.toFixed(0)}k.`, slot: this.cursor });
      else if (dev > 0.8 * lb.dsmBand || recent > 100) out.push({ id: 'dsm', level: 'warn', title: 'DSM exposure rising', detail: `Deviation ${lb.dsmMW.toFixed(1)} MW (band ±${lb.dsmBand.toFixed(0)}); deviation charge in the last hour ₹${recent.toFixed(0)}k.`, slot: this.cursor });
    }
    // planned work that is in progress now, or about to start within two hours
    for (const m of this.maint) {
      if (m.status === 'deferred' || m.status === 'completed') continue;
      const until = hhmm(blockOf(m.endSlot));
      const what = `${m.description || 'planned work'} · ${m.derateMW == null ? 'full outage' : `−${m.derateMW} MW`}`;
      if (this.cursor >= m.startSlot && this.cursor < m.endSlot) out.push({ id: 'maint-' + m.id, level: 'warn', title: `${m.assetName} under maintenance`, detail: `${what}, until ${until}. Its output is reduced in the plan.`, slot: this.cursor });
      else if (m.startSlot > this.cursor && m.startSlot - this.cursor <= 8) out.push({ id: 'maint-' + m.id, level: 'info', title: `${m.assetName}: maintenance starts ${hhmm(blockOf(m.startSlot))}`, detail: `${what}, until ${until}.`, slot: this.cursor });
    }
    const ids = new Set(out.map((a) => a.id));
    return [...out, ...planned.filter((a) => !ids.has(a.id))].slice(0, 10);
  }
  /** Displayed telemetry: the block's numbers plus small, slow, intra-block fluctuations, low-pass filtered so nothing jumps between seconds. */
  private telSmooth: Telemetry | null = null;
  private telTarget(): Telemetry {
    const r = this.rowAt(this.cursor);
    const a = this.instantAct ?? r.act ?? r.plan ?? emptyFlows();
    const rng = mulberry32((Date.now() ^ (this.cursor * 2654435761)) & 0xffffffff);
    // small, slow wander of the size seen in a normal day: demand ~±0.4 %, renewables ~±1.5 %, frequency ~±0.013 Hz
    this.jitter.d = 0.95 * this.jitter.d + 0.0012 * gauss(rng);
    this.jitter.re = 0.95 * this.jitter.re + 0.004 * gauss(rng);
    const dm = a.load * (1 + this.jitter.d), reJ = 1 + this.jitter.re;
    const reMW = (a.solar + a.wind) * reJ;
    const gen = reMW + a.thermal + a.bessDis;
    // whatever own generation / demand wander leaves uncovered is drawn from (or pushed into) the grid, i.e. it is the deviation
    const dev = a.dsmDraw + (dm - a.load) - (reMW - (a.solar + a.wind));
    const imports = a.damBuy + a.rtmBuy + a.grid + Math.max(0, dev);
    const sinks = a.bessCh + a.damSell + a.rtmSell + Math.max(0, -dev);
    // Frequency follows the interconnected grid's supply-demand balance: shortfall -> below 50 Hz, surplus -> above 50 Hz.
    // frequency is 50 Hz and moves only with the DISCOM's own balance: over-drawal (demand above supply) pulls it down, under-drawal pushes it up
    const gridBal = -dev;
    return {
      slot: this.cursor, freq: 50 + gridBal / FRC_MW_PER_HZ, gridBalanceMW: gridBal,
      demand: dm, requested: a.demand * (1 + this.jitter.d), notServed: a.unserved + a.dr, generation: gen, imports, sinks, buy: a.damBuy + a.rtmBuy, sell: a.damSell + a.rtmSell, deviation: dev,
      solar: a.solar * reJ, wind: a.wind * reJ, thermal: a.thermal,
      bessNet: a.bessDis - a.bessCh, market: a.damBuy - a.damSell + a.rtmBuy - a.rtmSell, grid: a.grid, rtmPrice: r.rtmPrice, damPrice: r.damPrice,
      socPct: r.soc,
    };
  }
  /** Advance the filter one step (called once per second). */
  stepTelemetry() {
    const raw = this.telTarget();
    const s = this.telSmooth;
    if (!s || Math.abs(raw.slot - s.slot) > 1) { this.telSmooth = raw; return; }
    // same linear filter on every field keeps generation + imports = demand + sinks exact; in a compressed (Simulate) clock the filter is
    // faster so a change made in one block is visible within that block (about 0.4 of a block, at most the 5 s used on the real clock)
    const spb = this.S.sim.mode === 'accelerated' ? this.S.sim.secondsPerBlock : 900;
    const A = 1 - Math.exp(-1 / Math.max(0.3, Math.min(5, 0.4 * spb)));
    const keep = ['slot', 'rtmPrice', 'damPrice'];
    for (const k of Object.keys(raw) as (keyof Telemetry)[]) (s as any)[k] = keep.includes(k) ? raw[k] : (s[k] as number) + A * ((raw[k] as number) - (s[k] as number));
    s.freq = 50 + s.gridBalanceMW / FRC_MW_PER_HZ;
  }
  telemetry(): Telemetry {
    if (!this.telSmooth) this.stepTelemetry();
    const s = this.telSmooth!;
    const o: any = {};
    for (const k of Object.keys(s) as (keyof Telemetry)[]) o[k] = k === 'slot' ? s[k] : round(s[k] as number, k === 'freq' ? 3 : k === 'rtmPrice' || k === 'damPrice' ? 2 : k === 'gridBalanceMW' ? 0 : 1);
    o.freq = round(clamp(s.freq, 49.5, 50.5), 3);
    o.opt = { ...this.optState, nextAt: hhmm(blockOf(this.cursor + 1)) };
    return o;
  }

  kpis() {
    const rows = (this.days.get(dayOf(this.cursor)) ?? []).filter((r) => r.act);
    const served = sum(rows.map((r) => r.act!.load * DT));
    const cost = sum(rows.map((r) => r.cost?.total ?? 0));
    const dsm = sum(rows.map((r) => r.dsmCost ?? 0));
    const reAvail = sum(rows.map((r) => r.solarAvail + r.windAvail)), reUsed = sum(rows.map((r) => r.act!.solar + r.act!.wind));
    const curtail = (reAvail - reUsed) * DT;
    const em = sum(rows.map((r) => r.emissionsT ?? 0));
    const dis = sum(rows.map((r) => r.act!.bessDis * DT));
    const tariffW = sum(this.P.customers.filter((c) => c.enabled).map((c) => c.tariff * c.peakMW)) / Math.max(1, sum(this.P.customers.filter((c) => c.enabled).map((c) => c.peakMW)));
    const mape = (a: number[], f: number[]) => { const d = sum(f); return d > 0 ? (sum(a.map((x, i) => Math.abs(x - f[i]))) / d) * 100 : 0; };
    const dsmDev = sum(rows.map((r) => Math.abs(r.dsmMW ?? 0) * DT));
    const reqRows = rows.filter((r) => r.reserveUpReq > 0);
    return {
      energyServedMWh: served, costK: cost, cpu: served > 0 ? cost / served : 0, dsmCostK: dsm, dsmDevMWh: dsmDev,
      reUtilPct: reAvail > 0 ? (reUsed / reAvail) * 100 : 100, curtailMWh: curtail, emissionsT: em, intensity: served > 0 ? (em / served) : 0,
      bessCycles: dis / Math.max(1, this.totalBessMWh()), bessBenefitK: sum(rows.map((r) => (r.act!.bessDis - r.act!.bessCh) * DT * r.rtmPrice - r.act!.bessDis * DT * 0.8)),
      peakMarketMW: Math.max(0, ...rows.map((r) => r.act!.damBuy + r.act!.rtmBuy)),
      reSharePct: served > 0 ? (reUsed * DT / served) * 100 : 0,
      avgTariff: tariffW, marginPerUnit: tariffW - (served > 0 ? cost / served : 0),
      loadMape: mape(rows.map((r) => r.demand), rows.map((r) => r.demandFc)),
      solarMape: mape(rows.map((r) => r.solarAvail), rows.map((r) => r.solarAvailFc)),
      windMape: mape(rows.map((r) => r.windAvail), rows.map((r) => r.windAvailFc)),
      reserveAdequacyPct: reqRows.length ? (reqRows.filter((r) => r.reserveUpAvail >= r.reserveUpReq - 0.5).length / reqRows.length) * 100 : 100,
      thermalStarts: sum(Object.values(this.fleet.cumStarts)),
      blocksDone: rows.length,
    };
  }

  mix() {
    const r = this.rowAt(this.cursor);
    const a = r.act ?? r.plan;
    if (!a) return [];
    const px = { dam: r.damPrice, rtm: r.rtmPrice };
    const m = this.S.market;
    const marketMW = a.damBuy + a.rtmBuy;
    const marketCost = marketMW > 0 ? (a.damBuy * (px.dam + m.exchangeFee + m.buyAdder) + a.rtmBuy * (px.rtm + m.exchangeFee + m.buyAdder)) / marketMW : 0;
    const solarCost = a.solar > 0 ? sum(this.P.solar.map((f) => (a.by[f.id] ?? 0) * f.tariff)) / a.solar : 0;
    const windCost = a.wind > 0 ? sum(this.P.wind.map((f) => (a.by[f.id] ?? 0) * f.tariff)) / a.wind : 0;
    const thermalCost = a.thermal > 0 ? sum(this.P.thermal.map((u) => (a.by[u.id] ?? 0) * u.varCost + (this.fleet.thermalOn[u.id] ? u.noLoadCost * 1 : 0) * 0)) / a.thermal : 0;
    const wac = this.fleet.invMWh > 1e-6 ? this.fleet.invCost / this.fleet.invMWh : 3.6;
    const deg = this.P.bess.length ? sum(this.P.bess.map((b) => b.degradationCost)) / this.P.bess.length * this.S.weights.degradationScale : 0.8;
    const dsmOver = Math.max(0, a.dsmDraw);
    const items = [
      { key: 'solar', label: 'Solar', mw: a.solar, cost: solarCost },
      { key: 'wind', label: 'Wind', mw: a.wind, cost: windCost },
      { key: 'thermal', label: 'Thermal', mw: a.thermal, cost: thermalCost },
      { key: 'bess', label: 'BESS discharge', mw: a.bessDis, cost: wac / 0.94 + deg },
      { key: 'market', label: 'Market (DAM/RTM)', mw: marketMW, cost: marketCost },
      { key: 'grid', label: 'Contract / grid import', mw: a.grid, cost: this.P.interconnect.gridContractPrice },
      { key: 'dsm', label: 'DSM over-drawal', mw: dsmOver, cost: r.dsmRate && r.dsmRate > 0 ? r.dsmRate : 0 },
    ];
    const tot = sum(items.map((i) => i.mw));
    return items.map((i) => ({ ...i, share: tot > 0 ? (i.mw / tot) * 100 : 0 }));
  }

  compactRow(r: BlockRow) {
    const strip = (f: Flows | null) => (f ? { ...f, by: undefined } : null);
    return { ...r, plan: strip(r.plan), act: strip(r.act) };
  }

  dayRows(day: number) {
    const rows = this.days.get(day);
    return rows ? rows.map((r) => this.compactRow(r)) : null;
  }

  /** Per-customer load this block: requested demand, minus any curtailed (DR), plus/minus shifted energy. */
  customerLoad() {
    const truth = this.twin.truthAt(this.cursor);
    const by = (this.rowAt(this.cursor).act ?? this.rowAt(this.cursor).plan)?.by ?? {};
    return this.P.customers.map((c) => {
      const demand = truth.demand[c.id] ?? 0;
      const dr = by['dr:' + c.id] ?? 0, shift = by['shift:' + c.id] ?? 0, shed = (by['shed:' + c.id] ?? 0) + (by['disrupt:' + c.id] ?? 0), disrupted = by['disrupt:' + c.id] ?? 0;
      return { id: c.id, name: c.name, segment: c.segment, criticality: c.criticality, enabled: c.enabled, peakMW: c.peakMW, demandMW: demand, curtailedMW: dr, disruptedMW: disrupted, shedMW: shed, shiftedMW: shift, servedMW: Math.max(0, demand - dr + shift - shed) };
    });
  }

  snapshot() {
    const cur = this.rowAt(this.cursor);
    const nat = getNational();
    const day = dayOf(this.cursor);
    const nextRow = this.rowAt(this.cursor + 1);
    return {
      v: VERSION,
      status: this.status, statusMsg: this.statusMsg,
      clock: { ...this.clockInfo, realMs: nowMs(), simulated: this.S.sim.mode !== 'live' && this.cursor !== slotNow() },
      now: { slot: this.cursor, day, date: dateStr(day), b: blockOf(this.cursor), time: hhmm(blockOf(this.cursor)), endTime: hhmm((blockOf(this.cursor) + 1) % BLOCKS), mode: this.S.sim.mode, secondsPerBlock: this.S.sim.secondsPerBlock, realSlot: slotNow() },
      telemetry: this.telemetry(),
      rows: (this.days.get(day) ?? []).map((r) => this.compactRow(r)),
      detail: { current: cur.act ? { ...(this.instantAct ?? cur.act).by, ...Object.fromEntries(this.P.bess.map((b) => ['soc:' + b.id, this.fleet.socMWh[b.id] ?? 0])) } : null, planned: cur.plan?.by ?? null, next: nextRow.plan?.by ?? null },
      mix: this.mix(), kpis: this.kpis(), customers: this.customerLoad(),
      agent: { ...this.agent, alerts: this.withLiveAlerts(this.agent.alerts), pending: this.pendingApprovals, maintProposals: this.maintProposals.filter((p) => p.status === 'pending').map((p) => ({ ...p, item: this.maint.find((m) => m.id === p.itemId) })) },
      log: this.log.slice(-80),
      events: this.events.filter((e) => e.endSlot > this.cursor).map((e) => ({ ...e, active: this.cursor >= e.startSlot })),
      plan: this.lastPlan ? { version: this.planVersion, objective: this.lastPlan.objective, solveMs: this.lastPlan.solveMs, status: this.lastPlan.status, mip: this.lastPlan.mip, inFlight: this.planInFlight } : null,
      national: nat, weather: weatherStatus,
      sources: { prices: this.damUploads.size ? 'uploaded + model' : 'calibrated model (IEX shape)', maintenance: this.uploadsMeta.maintenance ?? 'sample schedule', damUpload: this.uploadsMeta.dam },
      autonomy: this.S.autonomy,
      damCommitted: [...this.damPos.keys()],
      nextCommitted: (() => { const b = this.baseline.get(this.cursor + 1); return b ? { thermal: this.P.thermal.reduce((a, u) => a + (b.by[u.id] ?? 0), 0), damBuy: b.damBuy, damSell: b.damSell, rtmBuy: b.rtmBuy, rtmSell: b.rtmSell, grid: b.grid } : null; })(),
    };
  }

  // ------------------------------------------------------------------ pub/sub
  subscribe(fn: (ev: string, data: any) => void) { this.subscribers.add(fn); return () => this.subscribers.delete(fn); }
  broadcast() { if (this.subscribers.size === 0) return; const s = this.snapshot(); for (const f of this.subscribers) f('state', s); }
  broadcastTelemetry() { if (this.status !== 'running') return; this.stepTelemetry(); if (this.subscribers.size === 0) return; const t = this.telemetry(); for (const f of this.subscribers) f('telemetry', t); }

  addLog(level: LogEntry['level'], category: string, message: string, quiet = false) {
    this.log.push({ id: this.logSeq++, slot: this.cursor, wall: Date.now(), level, category, message });
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
    void quiet;
  }

  // ------------------------------------------------------------------ persistence
  scheduleSave() { if (this.saveTimer) return; this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 3000); }
  saveNow() {
    try {
      const blob = {
        v: VERSION, P: this.P, S: this.S, maint: this.maint, events: this.events, damUploads: [...this.damUploads], damPos: [...this.damPos], baseline: [...this.baseline],
        rtmCommit: [...this.rtmCommit], days: [...this.days], cursor: this.cursor, fleet: this.fleet, fleetPrev: this.fleetPrev, persistFc: this.persistFc,
        log: this.log.slice(-200), planVersion: this.planVersion, uploadsMeta: this.uploadsMeta, maintProposals: this.maintProposals,
      };
      fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(blob));
      fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch (e) { console.error('save failed', e); }
  }
  load(): boolean {
    try {
      if (!fs.existsSync(STATE_FILE)) return false;
      const b = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (b.v !== VERSION) return false;
      this.P = b.P; this.S = b.S; this.maint = b.maint; this.events = b.events; this.damUploads = new Map(b.damUploads); this.damPos = new Map(b.damPos); this.baseline = new Map(b.baseline ?? []);
      this.rtmCommit = new Map(b.rtmCommit); this.days = new Map(b.days); this.cursor = b.cursor; this.fleet = b.fleet; this.fleetPrev = b.fleetPrev; this.persistFc = b.persistFc;
      this.log = b.log; this.planVersion = b.planVersion; this.uploadsMeta = b.uploadsMeta; this.maintProposals = b.maintProposals ?? [];
      this.logSeq = (this.log[this.log.length - 1]?.id ?? 0) + 1;
      return true;
    } catch { return false; }
  }

  async resetAll() {
    try { fs.unlinkSync(STATE_FILE); } catch { /* none */ }
    this.P = defaultPortfolio(); this.S = defaultSettings(); this.damUploads.clear(); this.uploadsMeta = { maintenance: null, dam: null }; this.maintProposals = [];
    this.pendingApprovals = []; this.persistFc = { solar: {}, wind: {}, demand: 1, rtmSpread: 0 };
    this.twin.invalidate();
    this.status = 'backfilling';
    await refreshWeather(this.allLocations());
    await this.freshStart(slotNow());
    this.broadcast();
  }
}

export interface Overrides {
  solarPct?: number; windPct?: number; loadPct?: number; priceShiftPct?: number; bessAvailPct?: number; thermalOutId?: string; corridorDeratePct?: number; terminalSocPct?: number;
  carbonPrice?: number;
}

export const engine = new Engine();
export { nationalStress };
