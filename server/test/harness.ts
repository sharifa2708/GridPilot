// Deterministic scenario harness for the policy engine: builds a synthetic but realistic operating day from the default portfolio
// (no network, no random numbers), runs the SAME pipeline the live control tower and the planning workbench use
// (situation -> policy -> staged optimisation -> verification -> candidates), and exposes the result for assertions.
import highsLoader from 'highs';
import { defaultPortfolio, defaultSettings } from '../defaults.js';
import { DAM_SHAPE, SHAPE96 } from '../twin.js';
import { buildAndSolve, type PlanInput, type PlanOutput } from '../opt/model.js';
import type { MaintenanceItem, Portfolio, ScenarioEvent, Settings } from '../types.js';
import { assessSituation } from '../policy/situation.js';
import { buildPolicyInput } from '../policy/build.js';
import { cloneDeep, getPolicy, setPolicy } from '../policy/config.js';
import { verifyPlan, type Verification } from '../policy/verify.js';
import { generateCandidates, type Candidate } from '../policy/candidates.js';
import type { HysteresisState, PolicyConfig, Situation } from '../policy/types.js';
import type { AgentView } from '../twin.js';
import { buildActions, type BaselineBlock } from '../agent.js';
import type { AgentAction } from '../types.js';

let highsP: Promise<any> | null = null;
export const highs = () => (highsP ??= highsLoader());

export interface Mods {
  H?: number;
  startBlock?: number; // block of the day of the first planned block (default 64 = 16:00)
  loadMult?: number | ((t: number, b: number) => number);
  solarMult?: number; windMult?: number;
  priceMult?: number | ((t: number, b: number) => number);
  bessAvail?: number | ((t: number) => number); // 0..1 of nominal power
  socPct?: number;
  thermalCap?: Record<string, number | ((t: number) => number)>; // multiplier of capacity per unit
  ttcMult?: Record<string, number>;
  last?: Partial<{ dsmMW: number; dsmBand: number; ratioSolar: number; ratioWind: number; ratioLoad: number }>;
  freq?: number;
  events?: ScenarioEvent[];
  maint?: MaintenanceItem[];
  damLocks?: { buy: number[]; sell: number[] }; // committed day-ahead volumes
  hysteresis?: HysteresisState;
  stateless?: boolean; // default true: events count immediately
  portfolio?: (p: Portfolio) => void;
  settings?: (s: Settings) => void;
  policy?: (c: PolicyConfig) => void; // edits a copy of the policy for this run
  baseline?: BaselineBlock[] | null;
  timeSec?: number;
  mode?: 'DAM' | 'INTRADAY'; // DAM = the day-ahead schedule (becomes the committed baseline of later runs)
}

export interface Run {
  input: PlanInput; view: AgentView; out: PlanOutput; situation: Situation; hysteresis: HysteresisState; verification: Verification; candidates: Candidate[]; cfg: PolicyConfig; ms: number;
}

const bell = (b: number) => Math.max(0, Math.sin(Math.PI * (b / 4 - 6) / 12)); // daylight 06:00-18:00

export function makeView(P: Portfolio, S: Settings, m: Mods): AgentView {
  const H = m.H ?? 48, b0 = m.startBlock ?? 64;
  const v: AgentView = { slots: [], solar: [], wind: [], demand: [], damFc: [], rtmFc: [], thermalCap: [], bessPower: [], ttc: [], stormRisk: [], stormWhy: [], sigmaUp: [] } as any;
  for (let t = 0; t < H; t++) {
    const b = (b0 + t) % 96;
    const lm = typeof m.loadMult === 'function' ? m.loadMult(t, b) : m.loadMult ?? 1;
    const pm = typeof m.priceMult === 'function' ? m.priceMult(t, b) : m.priceMult ?? 1;
    const dem: Record<string, number> = {}; let load = 0;
    for (const c of P.customers) { dem[c.id] = c.enabled ? c.peakMW * SHAPE96[c.profile][b] * 0.93 * lm : 0; load += dem[c.id]; }
    const sol: Record<string, number> = {}, win: Record<string, number> = {}; let re = 0;
    for (const f of P.solar) { sol[f.id] = f.capacityMW * 0.78 * bell(b) * (m.solarMult ?? 1); re += sol[f.id]; }
    for (const f of P.wind) { win[f.id] = f.capacityMW * (0.3 + 0.12 * Math.sin((b / 96) * 2 * Math.PI)) * (m.windMult ?? 1); re += win[f.id]; }
    const th: Record<string, number> = {};
    for (const u of P.thermal) { const k = m.thermalCap?.[u.id]; th[u.id] = u.capacityMW * (typeof k === 'function' ? k(t) : k ?? 1); }
    const bs: Record<string, number> = {};
    const av = typeof m.bessAvail === 'function' ? m.bessAvail(t) : m.bessAvail ?? 1;
    for (const x of P.bess) bs[x.id] = x.powerMW * av;
    const tt: Record<string, number> = {};
    for (const c of P.corridors) tt[c.id] = c.ttcMW * (m.ttcMult?.[c.id] ?? 1);
    const dam = DAM_SHAPE[b] * pm;
    v.slots.push(1_000_000 + t); v.solar.push(sol); v.wind.push(win); v.demand.push(dem); v.damFc.push(dam); v.rtmFc.push(dam * 1.02);
    v.thermalCap.push(th); v.bessPower.push(bs); v.ttc.push(tt); v.stormRisk.push(0); v.stormWhy.push(''); v.sigmaUp.push(0.04 * load + 0.1 * re);
  }
  void S;
  return v;
}

export async function runScenario(m: Mods = {}): Promise<Run> {
  const P = defaultPortfolio(), S = defaultSettings();
  m.portfolio?.(P); m.settings?.(S);
  const H = m.H ?? 48;
  const cfg = cloneDeep(getPolicy());
  m.policy?.(cfg);
  const view = makeView(P, S, m);
  const state = {
    socMWh: Object.fromEntries(P.bess.map((b) => [b.id, (b.energyMWh * (m.socPct ?? 55)) / 100])),
    thermalOn: Object.fromEntries(P.thermal.map((u) => [u.id, u.mustRun || u.group === 'B'])),
    thermalP: Object.fromEntries(P.thermal.map((u) => [u.id, u.mustRun || u.group === 'B' ? (u.minLoadPct / 100) * u.capacityMW * 1.3 : 0])),
    thermalHold: Object.fromEntries(P.thermal.map((u) => [u.id, 0])),
  };
  const locks = m.damLocks;
  const slot0 = 2_000_000 + (m.startBlock ?? 64);
  const committedBuy = Array.from({ length: H }, (_, t) => locks?.buy[t] ?? 0);
  const sit = assessSituation({
    cfg, P, S, view, H, slot0, socMWh: state.socMWh, freq: m.freq ?? 50, events: m.events ?? [], maint: m.maint ?? [],
    last: { dsmMW: 0, dsmBand: 100, ratioSolar: 1, ratioWind: 1, ratioLoad: 1, ...(m.last ?? {}) }, committedBuy,
    baseline: m.baseline?.[0] ? { demand: m.baseline[0].demand, solar: m.baseline[0].solar, wind: m.baseline[0].wind } : null,
    hysteresis: m.hysteresis ?? {}, stateless: m.stateless ?? true,
  });
  const policy = buildPolicyInput(cfg, sit.situation, H, m.mode ?? 'INTRADAY');
  if (m.timeSec) policy.timeSec = m.timeSec;
  const input: PlanInput = {
    mode: m.mode ?? 'INTRADAY', slot0, H, portfolio: P, settings: S,
    view: { solar: view.solar, wind: view.wind, demand: view.demand, damPrice: view.damFc, rtmPrice: view.rtmFc, thermalCap: view.thermalCap, bessPower: view.bessPower, ttc: view.ttc, sigmaUp: view.sigmaUp, stormRisk: view.stormRisk },
    state, locked: { damBuy: Array.from({ length: H }, (_, t) => locks?.buy[t] ?? 0), damSell: Array.from({ length: H }, (_, t) => locks?.sell[t] ?? 0), rtmBuy: new Array(H).fill(null), rtmSell: new Array(H).fill(null) },
    vetoes: { dr: new Array(H).fill(false), curtail: new Array(H).fill(false) }, terminalSocPct: 45, policy,
  };
  const t0 = Date.now();
  const out = buildAndSolve(await highs(), input);
  const ms = Date.now() - t0;
  const verification = verifyPlan(input, out);
  const candidates = generateCandidates({ input, cfg, situation: sit.situation, sigma: view.sigmaUp[0], maint: m.maint ?? [] as any });
  return { input, view, out, situation: sit.situation, hysteresis: sit.hysteresis, verification, candidates, cfg, ms };
}

/** The committed schedule of a reference run (what the agent would compare the live plan with). */
export function toBaseline(run: Run): BaselineBlock[] {
  const sv = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  return run.out.blocks.map((pb, i) => {
    const f = pb.flows;
    return { slot: pb.slot, by: { ...f.by }, thermalOn: { ...pb.thermalOn }, socByBess: { ...pb.socByBess }, damBuy: f.damBuy + f.rtmBuy, damSell: f.damSell + f.rtmSell, rtmBuy: 0, rtmSell: 0, grid: f.grid, curtailSolar: f.curtailSolar, curtailWind: f.curtailWind, dr: f.dr, shiftNet: f.shiftNet, demand: sv(run.view.demand[i]), solar: sv(run.view.solar[i]), wind: sv(run.view.wind[i]) };
  });
}

/** Actions the agent would recommend for the first block, relative to a committed baseline. */
export function recommend(run: Run, baseline: BaselineBlock[]): AgentAction[] {
  let n = 0;
  const b0 = baseline[0];
  return buildActions({
    cursor: run.input.slot0 - 1, P: run.input.portfolio, S: run.input.settings, plan: run.out.blocks, view: run.view,
    prev: { thermalP: run.input.state.thermalP, socMWh: run.input.state.socMWh }, freq: 50, wac: 3.6,
    today: { reUtil: 1, dsmCost: 0, cpu: 4, cycles: 0, bessCost: 0, reAvail: 0, reUsed: 0, curtailMWh: 0 },
    lastBlock: { dsmMW: 0, dsmBand: 100, dsmRate: 0, notes: [], ratioSolar: 1, ratioWind: 1, ratioLoad: 1 },
    rtmPrice: run.view.rtmFc, damPrice: run.view.damFc, securityMode: 'normal', eventsActive: [], situation: run.situation, stages: run.out.stages ?? [], objectiveNames: run.cfg.objectives,
    baseline: b0 ?? null, custToday: {}, underperforming: [], nextId: () => `t${n++}`,
  } as any);
}

export const sumBlocks = (run: Run, f: (b: Run['out']['blocks'][number], t: number) => number) => run.out.blocks.reduce((a, b, t) => a + f(b, t), 0);
export const stageOrder = (run: Run) => (run.out.stages ?? []).map((s) => s.group);
export { getPolicy, setPolicy, cloneDeep };
