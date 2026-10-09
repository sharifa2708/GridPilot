// 96-block Security-Constrained Unit Commitment + Economic Dispatch + BESS + DAM/RTM optimiser (MILP via HiGHS) solved in
// LEXICOGRAPHIC STAGES.
//
// Every term of the objective belongs to one objective group (security, reliability, reserve, imbalance, cost, renewable
// utilisation, battery life). The active policy profile ranks the groups. The solver minimises the first group, freezes its
// result (plus a documented tolerance) as a constraint, minimises the next, and so on. No weights trade one group against
// another, so a higher-ranked objective can never be bought off by a lower-ranked one. A stage whose metric is already at
// its lower bound (0) in the previous solution is skipped. Which actions are allowed (demand response, load shift, sales,
// purchases) and how much reserve is required in each block come from the policy (see server/policy).
import type { Portfolio, Settings } from '../types.js';
import { GROUPS, type Group } from '../policy/types.js';

export interface PolicyInput {
  order: Group[]; // stage order; every group appears exactly once
  tol: Record<Group, { rel: number; abs: number }>; // stage tolerance: metric <= optimum + max(abs, rel*|optimum|)
  gap: Record<Group, number>; // MIP relative gap used when solving the stage
  timeSec: number; // total solver budget for the run
  stageMinSec: number;
  costStageShare: number; // share of the budget reserved for the cost stage
  critW: number; // weight of critical-load unserved energy inside the reliability stage
  skipAtBound: boolean;
  reserve: { baseUpDemandShare: number; baseDownSigmaShare: number; stormSigmaMultiplier: number };
  perBlock: {
    reserveUpMult: number[]; reserveDnMult: number[];
    allowSales: boolean[]; allowBuy: boolean[]; allowDR: boolean[]; allowShiftOut: boolean[]; allowShiftIn: boolean[];
    socLift: number[]; // extra battery energy (share of capacity) to hold in this block
  };
  assumptions: { lastResortDR: boolean; lastResortShift: boolean; drDisruptionRs: number; shiftOutRs: number; shiftInRs: number; drExcludeCritical: boolean; bessExclusive: 'penalty' | 'binary' };
  relax?: string[]; // constraint families to relax (infeasibility diagnosis only)
  softFloor?: boolean; // shortage ladder, step 3: the battery may go below its reserve floor (down to its physical minimum) to keep customers supplied
  softSells?: boolean; // shortage ladder, step 4: committed exchange sales may be under-delivered (settled as a deviation) to keep customers supplied
}

export interface PlanInput {
  mode: 'DAM' | 'INTRADAY';
  slot0: number;
  H: number;
  portfolio: Portfolio;
  settings: Settings;
  view: {
    solar: Record<string, number>[];
    wind: Record<string, number>[];
    demand: Record<string, number>[];
    damPrice: number[];
    rtmPrice: number[];
    thermalCap: Record<string, number>[];
    bessPower: Record<string, number>[];
    ttc: Record<string, number>[];
    sigmaUp: number[];
    stormRisk: number[];
  };
  state: {
    socMWh: Record<string, number>;
    thermalOn: Record<string, boolean>;
    thermalP: Record<string, number>;
    thermalHold: Record<string, number>; // blocks the present state must be kept (min up/down)
  };
  locked: { damBuy: (number | null)[]; damSell: (number | null)[]; rtmBuy: (number | null)[]; rtmSell: (number | null)[] };
  vetoes: { dr: boolean[]; curtail: boolean[] };
  terminalSocPct: number;
  policy?: PolicyInput;
  timeLimitSec?: number; // legacy override of the solver budget
  gap?: number; // legacy override of the cost-stage gap
}

export interface PlanBlock {
  slot: number;
  flows: {
    solar: number; wind: number; thermal: number; bessDis: number; bessCh: number;
    damBuy: number; damSell: number; rtmBuy: number; rtmSell: number; grid: number;
    curtailSolar: number; curtailWind: number; dr: number; shiftNet: number; unserved: number; dump: number;
    load: number; demand: number; by: Record<string, number>;
  };
  socMWh: number;
  socByBess: Record<string, number>;
  thermalOn: Record<string, boolean>;
  started: Record<string, boolean>;
  smc: number | null; // system marginal cost ₹/kWh (dual of the balance row in the cost stage)
  socValue: number | null; // value of stored energy ₹/kWh (dual of SOC row in the cost stage)
  reserveUpReq: number; reserveUpAvail: number; reserveDnReq: number; reserveDnAvail: number;
  reserveSlackUp: number; reserveSlackDn: number;
  imbalanceMW: number; // committed market volume this block that cannot be delivered (settles as deviation)
}

export interface StageResult {
  group: Group;
  unit: string;
  status: string; // Optimal | Time limit reached | Skipped
  metric: number | null; // value achieved by this stage (physical units)
  bound: number | null; // rhs applied to later stages (metric + tolerance)
  gap: number | null; // relative MIP gap reported by the solver (null when skipped)
  ms: number;
  note?: string;
}

export interface BindingItem { family: string; label: string; blocks: number; firstBlocks: number[]; maxShadow: number; unit: string }

export interface PlanOutput {
  ok: boolean;
  status: string; // solver status of the last stage
  feasibility: 'ok' | 'shortfall' | 'infeasible'; // shortfall: demand cannot be fully served within the limits
  objective: number; // total delivered cost, ₹ thousand over the horizon
  solveMs: number;
  mip: boolean;
  blocks: PlanBlock[];
  stages?: StageResult[];
  binding?: BindingItem[];
  conflicts?: string[]; // constraint families whose relaxation restores feasibility / limits reached in a shortfall
  costBreakdown?: Record<string, number>; // ₹ thousand
  dsmExposureMWh?: number; // committed energy that cannot be delivered
  unservedMWh?: number;
  floorSlackMWh?: number; // energy below the battery reserve floor, summed over blocks and batteries (part of the reserve metric)
  exclusivityViolations?: number; // blocks with simultaneous charge and discharge of one battery
  approximate?: boolean; // any stage ended on the time limit
  demandFlex?: { permitted: boolean; needed: boolean; reason: string }; // demand response / load shifting: allowed by the policy, and did the higher-ranked objectives require it?
  note?: string;
}

const DT = 0.25;
const f = (x: number) => (Math.abs(x) < 1e-9 ? '0' : x.toFixed(6));

class LP {
  rows: string[] = [];
  bounds = new Map<string, [number, number]>();
  bin: string[] = [];
  terms: Record<Group, { c: number; v: string }[]> = { security: [], reliability: [], reserve: [], imbalance: [], cost: [], re: [], bess: [], tie: [] };
  cost(coef: number, v: string, g: Group = 'cost') { if (coef !== 0) this.terms[g].push({ c: coef, v }); }
  bound(v: string, lo: number, hi: number) {
    if (hi < lo) hi = lo;
    this.bounds.set(v, [lo, hi]);
  }
  row(name: string, terms: [number, string][], op: '<=' | '>=' | '=', rhs: number) {
    const merged = new Map<string, number>();
    for (const [c, v] of terms) merged.set(v, (merged.get(v) ?? 0) + c);
    const parts: string[] = [];
    for (const [v, c] of merged) if (Math.abs(c) > 1e-12) parts.push(`${c >= 0 ? '+' : '-'} ${f(Math.abs(c))} ${v}`);
    if (parts.length === 0) return;
    this.rows.push(`${name}: ${parts.join(' ')} ${op} ${f(rhs)}`);
  }
  expr(g: Group): string { return this.terms[g].map(({ c, v }) => `${c >= 0 ? '+' : '-'} ${f(Math.abs(c))} ${v}`).join(' '); }
  metric(g: Group, col: (n: string) => number): number { return this.terms[g].reduce((a, { c, v }) => a + c * col(v), 0); }
  /** LP text minimising one group's terms, with optional extra stage rows; `fixed` fixes the binaries (for duals). */
  text(fixed: Record<string, number> | null, g: Group, extra: string[]): string {
    const bm = new Map(this.bounds);
    let bin = this.bin;
    if (fixed) { for (const v of this.bin) bm.set(v, [fixed[v] ?? 0, fixed[v] ?? 0]); bin = []; }
    const b: string[] = [];
    for (const [v, [lo, hi]] of bm) b.push(lo === hi ? `${v} = ${f(lo)}` : `${f(lo)} <= ${v} <= ${f(hi)}`);
    const obj = this.expr(g);
    return `Minimize\n obj: ${obj.length ? obj : '0 dummy'}\nSubject To\n${[...this.rows, ...extra].join('\n')}\nBounds\n${b.join('\n')}\n${bin.length ? 'Binary\n' + bin.join('\n') + '\n' : ''}End\n`;
  }
}

export const GRID_EF = 0.71; // tCO2/MWh, CEA all-India weighted average (approx.)

const FAMILY_LABEL: Record<string, [string, string]> = {
  imp: ['Import limit (exchange + contract)', '₹/kWh per MW'], exp: ['Export limit', '₹/kWh per MW'], mb: ['Exchange purchase limit', '₹/kWh per MW'], ms: ['Exchange sale limit', '₹/kWh per MW'],
  cor: ['Transmission corridor limit', '₹/kWh per MW'], rsu: ['Upward reserve requirement', 'per MW'], rsd: ['Downward reserve requirement', 'per MW'],
  pmn: ['Thermal minimum load', '₹/kWh per MW'], pmx: ['Thermal maximum output', '₹/kWh per MW'], ru: ['Thermal ramp-up limit', '₹/kWh per MW'], rd: ['Thermal ramp-down limit', '₹/kWh per MW'],
  mu: ['Thermal minimum up-time', '₹ per unit'], md: ['Thermal minimum down-time', '₹ per unit'], term: ['End-of-horizon battery energy target', '₹/kWh'],
  sl: ['Sales only from renewable / battery energy', '₹/kWh per MW'], shn: ['Load-shift energy neutrality', '₹/kWh'], so: ['Battery energy limits', '₹/kWh'], ds: ['Battery discharge power', '₹/kWh per MW'], ch: ['Battery charge power', '₹/kWh per MW'],
  g: ['Contract import limit', '₹/kWh per MW'], su: ['Solar availability', '₹/kWh per MW'], wu: ['Wind availability', '₹/kWh per MW'], p: ['Thermal capacity', '₹/kWh per MW'], dr: ['Demand-response capacity', '₹/kWh per MW'],
};

function families(rows: any[] | undefined, cols: Record<string, any> | undefined): BindingItem[] {
  const acc = new Map<string, { blocks: Set<number>; max: number }>();
  const add = (name: string, dual: number) => {
    if (Math.abs(dual) < 1e-6) return;
    const m = name.match(/^([a-zA-Z]+?)(?:[A-Za-z0-9]*?)_(\d+)$/) ?? name.match(/^([a-zA-Z]+)\d*_(\d+)$/);
    if (!m) return;
    let fam = m[1].replace(/\d+$/, '');
    if (name.startsWith('cor')) fam = 'cor';
    if (!FAMILY_LABEL[fam]) return;
    const e = acc.get(fam) ?? { blocks: new Set<number>(), max: 0 };
    e.blocks.add(Number(m[2])); e.max = Math.max(e.max, Math.abs(dual));
    acc.set(fam, e);
  };
  for (const r of rows ?? []) if (!/^(bal|soc|yy|zz|stg|tuh|tdh|bu|bd)/.test(r.Name)) add(r.Name, r.Dual ?? 0);
  if (cols) for (const [n, c] of Object.entries(cols)) if (/^(ds\d+|ch\d+|g|su\d+|wu\d+)_\d+$/.test(n)) add(n, (c as any).Dual ?? 0);
  return [...acc.entries()].map(([fam, e]) => ({
    family: fam, label: FAMILY_LABEL[fam][0], blocks: e.blocks.size, firstBlocks: [...e.blocks].sort((a, b) => a - b).slice(0, 6), maxShadow: e.max, unit: FAMILY_LABEL[fam][1],
  })).sort((a, b) => b.maxShadow - a.maxShadow).slice(0, 10);
}

const NEUTRAL = (H: number): PolicyInput['perBlock'] => ({
  reserveUpMult: new Array(H).fill(1), reserveDnMult: new Array(H).fill(1), allowSales: new Array(H).fill(true), allowBuy: new Array(H).fill(true),
  allowDR: new Array(H).fill(false), allowShiftOut: new Array(H).fill(false), allowShiftIn: new Array(H).fill(false), socLift: new Array(H).fill(0),
});

export function defaultPolicyInput(H: number): PolicyInput {
  const tol = {} as PolicyInput['tol']; const gap = {} as PolicyInput['gap'];
  for (const g of GROUPS) { tol[g] = { rel: g === 'cost' ? 0.003 : 0.02, abs: g === 'cost' ? 1 : 0.05 }; gap[g] = g === 'cost' ? 0.01 : 0.02; }
  tol.security = { rel: 0, abs: 0.01 }; tol.reliability = { rel: 0, abs: 0.01 };
  return {
    order: ['security', 'reliability', 'reserve', 'imbalance', 'cost', 're', 'bess'], tol, gap, timeSec: 6, stageMinSec: 0.6, costStageShare: 0.45, critW: 10, skipAtBound: true,
    reserve: { baseUpDemandShare: 0.03, baseDownSigmaShare: 0.7, stormSigmaMultiplier: 1.5 }, perBlock: NEUTRAL(H),
    assumptions: { lastResortDR: false, lastResortShift: false, drDisruptionRs: 2, shiftOutRs: 1.5, shiftInRs: 0.1, drExcludeCritical: true, bessExclusive: 'penalty' },
  };
}

/**
 * Demand response and load shifting are used only if the objectives ranked above cost cannot be met without them (when the
 * policy says so): first solve without them; only if reliability / reserve / imbalance / security still show a shortfall is the
 * model solved again with them permitted.
 */
// One planning run can need several solves (demand response on/off, battery exclusivity on/off). They share one wall-clock allowance so a hard
// situation cannot multiply the per-solve budget: each solve gets at most half of what is left.
let runDepth = 0, runDeadline = 0;
export function buildAndSolve(highs: any, inp: PlanInput): PlanOutput {
  if (runDepth === 0) runDeadline = Date.now() + 2.2 * (inp.timeLimitSec ?? inp.policy?.timeSec ?? 6) * 1000;
  runDepth++;
  try { return buildAndSolveInner(highs, inp); } finally { runDepth--; }
}
function buildAndSolveInner(highs: any, inp: PlanInput): PlanOutput {
  const pol = inp.policy;
  if (!pol) return solveEx(highs, inp);
  const pb = pol.perBlock;
  const gateDR = pol.assumptions.lastResortDR && pb.allowDR.some(Boolean);
  const gateSh = pol.assumptions.lastResortShift && (pb.allowShiftOut.some(Boolean) || pb.allowShiftIn.some(Boolean));
  const off = (a: boolean[]) => a.map(() => false);
  const costAt = pol.order.indexOf('cost');
  const unservedOf = (o: PlanOutput) => (o.stages ?? []).find((st) => st.group === 'reliability')?.metric ?? 0;
  const bigEnough = (m: number, g: Group) => m > Math.max(pol.tol[g].abs, 0.1);

  // Shortage ladder. Each step is tried only if the previous one left customers short:
  //   1. thermal up to what is needed, contract import and market purchases (the cheapest first: the cost stage chooses among them)
  //   2. demand response and load deferral (flexible and non-critical customers)
  //   3. reserves: the battery below its reserve floor
  //   4. curbing committed exchange sales
  let out = solveEx(highs, { ...inp, policy: { ...pol, perBlock: { ...pb, allowDR: gateDR ? off(pb.allowDR) : pb.allowDR, allowShiftOut: gateSh ? off(pb.allowShiftOut) : pb.allowShiftOut, allowShiftIn: gateSh ? off(pb.allowShiftIn) : pb.allowShiftIn } } });
  if (!out.ok) return out;
  let ms = out.solveMs;
  const short1 = (out.stages ?? []).filter((st) => pol.order.indexOf(st.group) < costAt && bigEnough((st.metric ?? 0) - (st.group === 'reserve' ? out.floorSlackMWh ?? 0 : 0), st.group)).map((st) => st.group);
  if (short1.length === 0) {
    if (gateDR || gateSh) out.demandFlex = { permitted: true, needed: false, reason: 'Demand response / load shifting are permitted but were not needed: the objectives ranked above cost are met without them.' };
    return out;
  }
  const notes: string[] = [];
  // step 2
  if (gateDR || gateSh) {
    out = solveEx(highs, inp); ms += out.solveMs;
    if (!out.ok) { out.solveMs = ms; return out; }
    out.demandFlex = { permitted: true, needed: true, reason: `Without demand response / load shifting the ${short1.join(', ')} objective(s) ranked above cost are not met, so they were allowed.` };
    notes.push('demand response / deferral');
  }
  // step 3
  if (bigEnough(unservedOf(out), 'reliability')) {
    const flex = out.demandFlex;
    out = solveEx(highs, { ...inp, policy: { ...pol, softFloor: true } }); ms += out.solveMs;
    if (!out.ok) { out.solveMs = ms; return out; }
    out.demandFlex = flex;
    notes.push('reserves (the battery below its reserve floor)');
    // step 4
    if (bigEnough(unservedOf(out), 'reliability') && inp.locked.damSell.concat(inp.locked.rtmSell).some((x) => (x ?? 0) > 0.01)) {
      out = solveEx(highs, { ...inp, policy: { ...pol, softFloor: true, softSells: true } }); ms += out.solveMs;
      if (!out.ok) { out.solveMs = ms; return out; }
      out.demandFlex = flex;
      notes.push('curbing committed exchange sales');
    }
  }
  out.solveMs = ms;
  if (notes.length) out.note = [out.note, `Shortage ladder used, in order: thermal, contract import and market purchases; then ${notes.join('; then ')}.`].filter(Boolean).join(' ');
  return out;
}

/** Battery charge/discharge exclusivity is enforced lazily: binaries are added only if the relaxed solution would charge and discharge together. */
function solveEx(highs: any, inp: PlanInput): PlanOutput {
  const pol = inp.policy;
  if (!pol || pol.assumptions.bessExclusive !== 'binary') return solveOnce(highs, inp);
  const relaxed = solveOnce(highs, { ...inp, policy: { ...pol, assumptions: { ...pol.assumptions, bessExclusive: 'penalty' } } });
  if (!relaxed.ok || !(relaxed.exclusivityViolations && relaxed.exclusivityViolations > 0)) return relaxed;
  const exact = solveOnce(highs, inp);
  exact.solveMs += relaxed.solveMs;
  if (exact.ok) exact.note = [exact.note, 'Battery charge/discharge exclusivity was enforced with binary variables because the relaxed solution used both at once.'].filter(Boolean).join(' ');
  return exact;
}

function solveOnce(highs: any, inp: PlanInput): PlanOutput {
  const t0 = Date.now();
  const { portfolio: P, settings: S, H } = inp;
  const pol: PolicyInput = inp.policy ?? defaultPolicyInput(H);
  const pb = pol.perBlock;
  const relax = new Set(pol.relax ?? []);
  const lp = new LP();
  const carbonPerKwh = (ef: number) => (ef * S.weights.carbonPrice) / 1000; // ₹/kWh
  const m = S.market;
  const isDam = inp.mode === 'DAM';
  const solar = P.solar.filter((x) => x.enabled);
  const wind = P.wind.filter((x) => x.enabled);
  const thermal = P.thermal.filter((x) => x.enabled);
  const bess = P.bess.filter((x) => x.enabled);
  const custs = P.customers.filter((c) => c.enabled);
  const avgDam = inp.view.damPrice.reduce((a, c) => a + c, 0) / Math.max(1, H);
  const resMult = (isDam ? 1.25 : 1) * S.weights.reserveStrictness;

  const V = {
    su: (i: number, t: number) => `su${i}_${t}`,
    wu: (i: number, t: number) => `wu${i}_${t}`,
    p: (j: number, t: number) => `p${j}_${t}`,
    u: (j: number, t: number) => `u${j}_${t}`,
    y: (j: number, t: number) => `y${j}_${t}`,
    z: (j: number, t: number) => `z${j}_${t}`,
    tru: (j: number, t: number) => `tu${j}_${t}`,
    trd: (j: number, t: number) => `td${j}_${t}`,
    ch: (k: number, t: number) => `ch${k}_${t}`,
    dis: (k: number, t: number) => `ds${k}_${t}`,
    soc: (k: number, t: number) => `so${k}_${t}`,
    bru: (k: number, t: number) => `bu${k}_${t}`,
    brd: (k: number, t: number) => `bd${k}_${t}`,
    bm: (k: number, t: number) => `bm${k}_${t}`,
    db: (t: number) => `db_${t}`, ds: (t: number) => `dsl_${t}`, rb: (t: number) => `rb_${t}`, rs: (t: number) => `rs_${t}`,
    g: (t: number) => `g_${t}`,
    dr: (c: number, t: number) => `dr${c}_${t}`,
    sd: (c: number, t: number) => `sd${c}_${t}`,
    sp: (c: number, t: number) => `sp${c}_${t}`,
    unC: (t: number) => `unc_${t}`, unN: (t: number) => `unn_${t}`, dump: (t: number) => `dmp_${t}`,
    rsu: (t: number) => `rsu_${t}`, rsd: (t: number) => `rsd_${t}`,
    tslack: (k: number) => `tsl${k}`,
    cs: (id: string, t: number) => `cs${id}_${t}`,
  };

  const termDemand: number[] = [];
  const critDemand: number[] = [];
  for (let t = 0; t < H; t++) {
    let tot = 0, crit = 0;
    for (const c of custs) { const d = inp.view.demand[t][c.id] ?? 0; tot += d; if (c.criticality === 'critical') crit += d; }
    termDemand.push(tot); critDemand.push(crit);
  }

  // ---- thermal fixed states from min up/down holds ----
  const thermalForced: Record<string, (0 | 1 | null)[]> = {};
  thermal.forEach((u) => {
    const arr: (0 | 1 | null)[] = new Array(H).fill(null);
    const hold = relax.has('holds') ? 0 : inp.state.thermalHold[u.id] ?? 0;
    const on = inp.state.thermalOn[u.id];
    for (let t = 0; t < Math.min(H, hold); t++) arr[t] = on ? 1 : 0;
    thermalForced[u.id] = arr;
  });
  // consecutive blocks each unit has been able to run (a must-run unit is not forced on right after an outage, when its
  // minimum down-time still applies)
  const avRun: Record<string, number[]> = {};
  thermal.forEach((u) => {
    const pmin = (u.minLoadPct / 100) * u.capacityMW;
    let run = 99; const arr: number[] = []; // a unit available from the first block has been available for longer than any min down-time
    for (let t = 0; t < H; t++) { const cap = inp.view.thermalCap[t][u.id] ?? 0; run = cap >= pmin - 1e-6 && cap > 0 ? run + 1 : 0; arr.push(run); }
    avRun[u.id] = arr;
  });

  let reConst = 0; // Σ available renewable energy (MWh): physical curtailment = reConst - used
  for (let t = 0; t < H; t++) {
    const bal: [number, string][] = [];
    const dam = inp.view.damPrice[t], rtm = inp.view.rtmPrice[t];

    // ---- renewables ----
    const corridorTerms: Record<string, [number, string][]> = {};
    const reCost = (fm: { tariff: number }, v: string) => {
      const comp = 0.5 * fm.tariff; // deemed-generation compensation paid on curtailed energy
      // cost group: PPA energy for what is used and deemed compensation for what is not (constant part omitted),
      // minus the internal carbon price of the energy displaced, minus the configured internal curtailment price
      lp.cost((fm.tariff - comp - S.weights.reCurtailmentPenalty - carbonPerKwh(GRID_EF)) * DT, v, 'cost');
      lp.cost(-DT, v, 're'); // renewable-utilisation group: curtailed MWh = available - used
    };
    solar.forEach((fm, i) => {
      const avail = Math.max(0, inp.view.solar[t][fm.id] ?? 0);
      reConst += avail * DT;
      reCost(fm, V.su(i, t));
      lp.bound(V.su(i, t), 0, avail);
      bal.push([1, V.su(i, t)]);
      (corridorTerms[fm.corridorId] ??= []).push([1, V.su(i, t)]);
    });
    wind.forEach((fm, i) => {
      const avail = Math.max(0, inp.view.wind[t][fm.id] ?? 0);
      reConst += avail * DT;
      reCost(fm, V.wu(i, t));
      lp.bound(V.wu(i, t), 0, avail);
      bal.push([1, V.wu(i, t)]);
      (corridorTerms[fm.corridorId] ??= []).push([1, V.wu(i, t)]);
    });

    // ---- thermal ----
    const truTerms: [number, string][] = [], trdTerms: [number, string][] = [];
    thermal.forEach((u, j) => {
      const cap = inp.view.thermalCap[t][u.id] ?? 0;
      const pmin = (u.minLoadPct / 100) * u.capacityMW;
      const canRun = cap >= pmin - 1e-6 && cap > 0;
      const ramp = ((u.rampPctPerMin / 100) * u.capacityMW * 15);
      lp.cost((u.varCost + carbonPerKwh(u.emissionFactor)) * DT, V.p(j, t));
      lp.cost(u.noLoadCost * DT, V.u(j, t));
      lp.cost(u.startupCost, V.y(j, t));
      lp.bound(V.p(j, t), 0, canRun ? cap : 0);
      lp.bound(V.y(j, t), 0, 1); lp.bound(V.z(j, t), 0, 1);
      lp.bin.push(V.u(j, t));
      const forced = thermalForced[u.id][t];
      if (!canRun) lp.bound(V.u(j, t), 0, 0);
      else if (forced != null) lp.bound(V.u(j, t), forced, forced); // min up/down hold always wins
      else if (u.mustRun && avRun[u.id][t] > u.minDownBlocks) lp.bound(V.u(j, t), 1, 1);
      else lp.bound(V.u(j, t), 0, 1);
      if (canRun) {
        lp.row(`pmn${j}_${t}`, [[1, V.p(j, t)], [-pmin, V.u(j, t)]], '>=', 0);
        lp.row(`pmx${j}_${t}`, [[1, V.p(j, t)], [-cap, V.u(j, t)]], '<=', 0);
      }
      const uPrev: [number, string][] = t === 0 ? [] : [[1, V.u(j, t - 1)]];
      const u0 = inp.state.thermalOn[u.id] ? 1 : 0;
      lp.row(`yy${j}_${t}`, [[1, V.y(j, t)], [-1, V.u(j, t)], ...uPrev], '>=', t === 0 ? -u0 : 0);
      lp.row(`zz${j}_${t}`, [[1, V.z(j, t)], [1, V.u(j, t)], ...uPrev.map(([c, v]) => [-c, v] as [number, string])], '>=', t === 0 ? u0 : 0);
      // start / stop indicators are exactly the state transitions (not free to relax the ramp limits)
      lp.row(`yu${j}_${t}`, [[1, V.y(j, t)], [-1, V.u(j, t)]], '<=', 0);
      lp.row(`zu${j}_${t}`, [[1, V.z(j, t)], [1, V.u(j, t)]], '<=', 1);
      if (t === 0) { lp.row(`yp${j}_0`, [[1, V.y(j, 0)]], '<=', 1 - u0); lp.row(`zp${j}_0`, [[1, V.z(j, 0)]], '<=', u0); }
      else { lp.row(`yp${j}_${t}`, [[1, V.y(j, t)], [1, V.u(j, t - 1)]], '<=', 1); lp.row(`zp${j}_${t}`, [[1, V.z(j, t)], [-1, V.u(j, t - 1)]], '<=', 0); }
      const p0 = inp.state.thermalP[u.id] ?? 0;
      if (!relax.has('ramps')) {
        if (t === 0) {
          lp.row(`ru${j}_0`, [[1, V.p(j, 0)], [-u.capacityMW, V.y(j, 0)]], '<=', p0 + ramp);
          lp.row(`rd${j}_0`, [[-1, V.p(j, 0)], [-u.capacityMW, V.z(j, 0)]], '<=', -p0 + ramp); // big-M is the nameplate so a unit that has just tripped (cap = 0) can still shut down
        } else {
          lp.row(`ru${j}_${t}`, [[1, V.p(j, t)], [-1, V.p(j, t - 1)], [-u.capacityMW, V.y(j, t)]], '<=', ramp);
          lp.row(`rd${j}_${t}`, [[-1, V.p(j, t)], [1, V.p(j, t - 1)], [-u.capacityMW, V.z(j, t)]], '<=', ramp);
        }
      }
      if (u.minUpBlocks > 1 && !relax.has('updown')) {
        const terms: [number, string][] = [];
        for (let k = Math.max(0, t - u.minUpBlocks + 1); k <= t; k++) terms.push([1, V.y(j, k)]);
        terms.push([-1, V.u(j, t)]);
        lp.row(`mu${j}_${t}`, terms, '<=', 0);
      }
      if (u.minDownBlocks > 1 && !relax.has('updown')) {
        const terms: [number, string][] = [];
        for (let k = Math.max(0, t - u.minDownBlocks + 1); k <= t; k++) terms.push([1, V.z(j, k)]);
        terms.push([1, V.u(j, t)]);
        lp.row(`md${j}_${t}`, terms, '<=', 1);
      }
      lp.bound(V.tru(j, t), 0, Math.min(ramp, canRun ? cap : 0)); lp.bound(V.trd(j, t), 0, Math.min(ramp, canRun ? cap : 0));
      if (canRun) {
        lp.row(`tuh${j}_${t}`, [[1, V.tru(j, t)], [1, V.p(j, t)], [-cap, V.u(j, t)]], '<=', 0);
        lp.row(`tdh${j}_${t}`, [[1, V.trd(j, t)], [-1, V.p(j, t)], [pmin, V.u(j, t)]], '<=', 0);
      } else { lp.bound(V.tru(j, t), 0, 0); lp.bound(V.trd(j, t), 0, 0); }
      truTerms.push([1, V.tru(j, t)]); trdTerms.push([1, V.trd(j, t)]);
      bal.push([1, V.p(j, t)]);
    });

    // ---- BESS ----
    const bruTerms: [number, string][] = [], brdTerms: [number, string][] = [];
    bess.forEach((x, k) => {
      const pav = inp.view.bessPower[t][x.id] ?? 0;
      const arb = pav * (1 - x.gridSupportReservePct / 200); // half of the reserve share is withheld from arbitrage in each direction
      const E = x.energyMWh, smin = (x.socMinPct / 100) * E, smax = (x.socMaxPct / 100) * E;
      lp.bound(V.ch(k, t), 0, arb); lp.bound(V.dis(k, t), 0, arb);
      const floorArb = smin + (x.gridSupportReservePct / 100) * E;
      // Reserve floor. Normally hard: the battery is not discharged below it (and, if it is already below, not any further, but it is not forced to recharge either).
      // Only at step 3 of the shortage ladder (softFloor) may it be used below the floor, down to its physical minimum, and the floor is then restored as soon as customers are supplied.
      const lift = (pb.socLift[t] ?? 0) * E; // hold extra energy ahead of a risky window (policy)
      const soc0 = Math.max(smin, inp.state.socMWh[x.id] ?? E * 0.5);
      if (pol.softFloor && !relax.has('floors')) {
        lp.bound(V.soc(k, t), smin, smax);
        const sv = `sfl${k}_${t}`;
        lp.bound(sv, 0, E); lp.cost(1, sv, 'reserve');
        lp.row(`sfl${k}_${t}`, [[1, V.soc(k, t)], [1, sv]], '>=', Math.min(floorArb + lift, smax));
      } else {
        lp.bound(V.soc(k, t), relax.has('floors') ? smin : Math.min(Math.min(floorArb + lift, smax), soc0), smax);
      }
      lp.cost(x.degradationCost * S.weights.degradationScale * DT, V.dis(k, t)); // asset wear is a real cost
      lp.cost(DT, V.dis(k, t), 'bess'); lp.cost(DT, V.ch(k, t), 'bess'); // battery-life group: energy throughput
      lp.cost(0.02 * DT, V.ch(k, t)); // tiny cost keeps simultaneous charge/discharge off the table
      if (pol.assumptions.bessExclusive === 'binary') {
        lp.bin.push(V.bm(k, t)); lp.bound(V.bm(k, t), 0, 1);
        lp.row(`bx1${k}_${t}`, [[1, V.dis(k, t)], [-arb, V.bm(k, t)]], '<=', 0);
        lp.row(`bx2${k}_${t}`, [[1, V.ch(k, t)], [arb, V.bm(k, t)]], '<=', arb);
      }
      const s0 = Math.min(smax, Math.max(smin, inp.state.socMWh[x.id] ?? E * 0.5));
      const prev: [number, string][] = t === 0 ? [] : [[-1, V.soc(k, t - 1)]];
      lp.row(`soc${k}_${t}`, [[1, V.soc(k, t)], ...prev, [-x.etaCharge * DT, V.ch(k, t)], [DT / x.etaDischarge, V.dis(k, t)]], '=', t === 0 ? s0 : 0);
      lp.bound(V.bru(k, t), 0, pav); lp.bound(V.brd(k, t), 0, pav);
      lp.row(`bu1${k}_${t}`, [[1, V.bru(k, t)], [1, V.dis(k, t)], [-1, V.ch(k, t)]], '<=', pav);
      lp.row(`bd1${k}_${t}`, [[1, V.brd(k, t)], [1, V.ch(k, t)], [-1, V.dis(k, t)]], '<=', pav);
      if (t === 0) {
        lp.row(`bu2${k}_0`, [[1, V.bru(k, 0)]], '<=', Math.max(0, (s0 - smin) * x.etaDischarge / 0.5));
        lp.row(`bd2${k}_0`, [[1, V.brd(k, 0)]], '<=', Math.max(0, (smax - s0) / x.etaCharge / 0.5));
      } else {
        lp.row(`bu2${k}_${t}`, [[1, V.bru(k, t)], [-x.etaDischarge / 0.5, V.soc(k, t - 1)]], '<=', -(smin * x.etaDischarge) / 0.5);
        lp.row(`bd2${k}_${t}`, [[1, V.brd(k, t)], [1 / x.etaCharge / 0.5, V.soc(k, t - 1)]], '<=', smax / x.etaCharge / 0.5);
      }
      bal.push([1, V.dis(k, t)], [-1, V.ch(k, t)]);
      bruTerms.push([1, V.bru(k, t)]); brdTerms.push([1, V.brd(k, t)]);
      (corridorTerms[x.corridorId] ??= []).push([1, V.dis(k, t)], [-1, V.ch(k, t)]);
    });

    // ---- market ----
    const lk = (a: (number | null)[]) => (relax.has('locks') ? null : a[t]);
    const buyCost = (px: number) => (px + m.exchangeFee + m.buyAdder + carbonPerKwh(GRID_EF)) * DT;
    const sellRev = (px: number) => -(px - m.exchangeFee - m.sellDeduction) * DT;
    lp.cost(buyCost(dam), V.db(t)); lp.cost(sellRev(dam), V.ds(t));
    lp.cost(buyCost(rtm) + 0.001, V.rb(t)); lp.cost(sellRev(rtm) + 0.001, V.rs(t));
    const bnd = (v: string, lock: number | null, free: number) => {
      if (lock != null) lp.bound(v, lock, lock); else lp.bound(v, 0, free);
    };
    const sellFree = pb.allowSales[t] ? m.maxSellMW : 0;
    const buyFree = pb.allowBuy[t] ? m.maxBuyMW : 0;
    if (isDam) {
      bnd(V.db(t), null, m.maxBuyMW); bnd(V.ds(t), null, sellFree);
      lp.bound(V.rb(t), 0, 0); lp.bound(V.rs(t), 0, 0);
    } else {
      // Committed volumes are fixed. Only at step 4 of the shortage ladder (softSells) may a committed SALE be under-delivered: it is then settled as a deviation,
      // priced at the DSM cap in the cost group, and only the part that customers need is curbed.
      const bndSell = (v: string, lock: number | null, free: number, tag: string) => {
        if (lock == null || !pol.softSells) { bnd(v, lock, free); return; }
        if (lock <= 0.01) { lp.bound(v, 0, 0); return; }
        const sv = `${tag}_${t}`;
        lp.bound(v, 0, lock); lp.bound(sv, 0, lock);
        lp.row(`${tag}r_${t}`, [[1, v], [1, sv]], '=', lock);
        lp.cost(S.dsm.capRate * DT, sv);
      };
      bnd(V.db(t), lk(inp.locked.damBuy) ?? 0, buyFree); bndSell(V.ds(t), lk(inp.locked.damSell) ?? 0, sellFree, 'dsf');
      bnd(V.rb(t), lk(inp.locked.rtmBuy), buyFree);
      bndSell(V.rs(t), lk(inp.locked.rtmSell), sellFree, 'rsf');
    }
    // committed volumes beyond the exchange limits are not infeasible in reality: they are settled as deviation (imbalance group)
    lp.cost(DT, `slkb_${t}`, 'imbalance'); lp.bound(`slkb_${t}`, 0, 5000);
    lp.row(`mb_${t}`, [[1, V.db(t)], [1, V.rb(t)], [-1, `slkb_${t}`]], '<=', m.maxBuyMW);
    lp.cost(DT, `slkm_${t}`, 'imbalance'); lp.bound(`slkm_${t}`, 0, 5000);
    lp.row(`ms_${t}`, [[1, V.ds(t)], [1, V.rs(t)], [-1, `slkm_${t}`]], '<=', m.maxSellMW);
    // ---- bilateral / ISGS grid import ----
    lp.cost((P.interconnect.gridContractPrice + carbonPerKwh(0.8)) * DT, V.g(t));
    lp.bound(V.g(t), 0, P.interconnect.gridContractLimitMW);
    lp.cost(DT, `slki_${t}`, 'security'); lp.bound(`slki_${t}`, 0, 5000);
    lp.row(`imp_${t}`, [[1, V.db(t)], [1, V.rb(t)], [1, V.g(t)], [-1, `slki_${t}`]], '<=', P.interconnect.importLimitMW);
    lp.cost(DT, `slke_${t}`, 'security'); lp.bound(`slke_${t}`, 0, 5000);
    lp.row(`exp_${t}`, [[1, V.ds(t)], [1, V.rs(t)], [-1, `slke_${t}`]], '<=', P.interconnect.exportLimitMW);
    bal.push([1, V.db(t)], [-1, V.ds(t)], [1, V.rb(t)], [-1, V.rs(t)], [1, V.g(t)]);

    // ---- demand side (availability of each lever is a policy decision, per block) ----
    const drHead: [number, string][] = [];
    let drCapSum = 0;
    custs.forEach((c, ci) => {
      const d = inp.view.demand[t][c.id] ?? 0;
      if (c.drFlexPct > 0 && !(pol.assumptions.drExcludeCritical && c.criticality === 'critical')) {
        const cap = inp.vetoes.dr[t] || !pb.allowDR[t] ? 0 : (c.drFlexPct / 100) * d;
        lp.bound(V.dr(ci, t), 0, cap);
        // cost of curtailing a customer: lost sales + incentive paid + a configured disruption cost
        lp.cost((c.tariff + c.drIncentive + pol.assumptions.drDisruptionRs) * DT, V.dr(ci, t));
        bal.push([1, V.dr(ci, t)]); // curtailed load acts as supply to the balance
        if (cap > 0) drHead.push([-0.5, V.dr(ci, t)]);
        drCapSum += cap;
      }
      if (c.shiftablePct > 0) {
        const cap = (c.shiftablePct / 100) * d;
        lp.bound(V.sd(ci, t), 0, pb.allowShiftOut[t] ? cap : 0); lp.bound(V.sp(ci, t), 0, pb.allowShiftIn[t] ? cap : 0);
        lp.cost(pol.assumptions.shiftOutRs * DT, V.sd(ci, t)); lp.cost(pol.assumptions.shiftInRs * DT, V.sp(ci, t));
        bal.push([1, V.sd(ci, t)], [-1, V.sp(ci, t)]);
      }
    });
    // unserved energy: emergency slack that keeps the model solvable and is reported, never hidden (reliability group)
    // a shortfall in the near term counts slightly more than the same shortfall later (the forecast is firmer), so the battery and other reserves are
    // used as early as they help instead of being held back for a later block
    const near = 1 - (0.3 * t) / Math.max(1, H);
    lp.cost(near * pol.critW * DT, V.unC(t), 'reliability'); lp.cost(near * DT, V.unN(t), 'reliability');
    lp.cost(DT, V.dump(t), 'security'); // surplus that no sink can absorb (over-generation) is a security violation
    lp.bound(V.unC(t), 0, critDemand[t]); lp.bound(V.unN(t), 0, Math.max(0, termDemand[t] - critDemand[t]));
    lp.bound(V.dump(t), 0, 5000);
    bal.push([1, V.unC(t)], [1, V.unN(t)], [-1, V.dump(t)]);
    lp.row(`bal_${t}`, bal, '=', termDemand[t]);
    {
      // Exchange sales may only come from renewables / BESS energy; thermal is never run for merchant sales
      const sellRow: [number, string][] = [[1, V.ds(t)], [1, V.rs(t)]];
      solar.forEach((_, i) => sellRow.push([-1, V.su(i, t)]));
      wind.forEach((_, i) => sellRow.push([-1, V.wu(i, t)]));
      bess.forEach((_, k) => sellRow.push([-1, V.dis(k, t)]));
      sellRow.push([-1, `slks_${t}`]);
      lp.cost(DT, `slks_${t}`, 'imbalance'); lp.bound(`slks_${t}`, 0, 5000);
      lp.row(`sl_${t}`, sellRow, '<=', 0);
    }

    // ---- corridors (a violation is an explicit security slack) ----
    if (!relax.has('corridors')) for (const cor of P.corridors) {
      const terms = corridorTerms[cor.id];
      if (terms && terms.length) {
        lp.cost(DT, V.cs(cor.id, t), 'security'); lp.bound(V.cs(cor.id, t), 0, 5000);
        lp.row(`cor${cor.id}_${t}`, [...terms, [-1, V.cs(cor.id, t)]], '<=', inp.view.ttc[t][cor.id] ?? cor.ttcMW);
      }
    }

    // ---- reserves (soft: the shortfall is the reserve group's metric) ----
    const sigma = inp.view.sigmaUp[t] * (inp.view.stormRisk[t] > 0.5 ? pol.reserve.stormSigmaMultiplier : 1);
    const reqUp = resMult * pb.reserveUpMult[t] * Math.max(pol.reserve.baseUpDemandShare * termDemand[t], sigma);
    const reqDn = resMult * pb.reserveDnMult[t] * Math.max(pol.reserve.baseUpDemandShare * termDemand[t], pol.reserve.baseDownSigmaShare * sigma);
    lp.cost(DT, V.rsu(t), 'reserve'); lp.cost(0.7 * DT, V.rsd(t), 'reserve');
    lp.bound(V.rsu(t), 0, 5000); lp.bound(V.rsd(t), 0, 5000);
    lp.row(`rsu_${t}`, [...truTerms, ...bruTerms, ...drHead, [1, V.rsu(t)]], '>=', reqUp - 0.5 * drCapSum);
    const reTerms: [number, string][] = [];
    solar.forEach((_, i) => reTerms.push([0.4, V.su(i, t)]));
    wind.forEach((_, i) => reTerms.push([0.4, V.wu(i, t)]));
    lp.row(`rsd_${t}`, [...trdTerms, ...brdTerms, ...reTerms, [1, V.rsd(t)]], '>=', reqDn);
  }

  // ---- tie-break stage: among solutions of equal rank, prefer smooth thermal output and steady market purchases ----
  for (let t = 0; t < H; t++) {
    thermal.forEach((u, j) => {
      const v = `mt${j}_${t}`; lp.bound(v, 0, u.capacityMW); lp.cost(1, v, 'tie');
      if (t === 0) { const p0 = inp.state.thermalP[u.id] ?? 0; lp.row(`mta${j}_0`, [[1, v], [-1, V.p(j, 0)]], '>=', -p0); lp.row(`mtb${j}_0`, [[1, v], [1, V.p(j, 0)]], '>=', p0); }
      else { lp.row(`mta${j}_${t}`, [[1, v], [-1, V.p(j, t)], [1, V.p(j, t - 1)]], '>=', 0); lp.row(`mtb${j}_${t}`, [[1, v], [1, V.p(j, t)], [-1, V.p(j, t - 1)]], '>=', 0); }
    });
    if (t > 0) {
      const v = `mm_${t}`; lp.bound(v, 0, 5000); lp.cost(1, v, 'tie');
      const cur: [number, string][] = [[1, V.db(t)], [1, V.rb(t)], [1, V.g(t)]], prv: [number, string][] = [[1, V.db(t - 1)], [1, V.rb(t - 1)], [1, V.g(t - 1)]];
      lp.row(`mma_${t}`, [[1, v], ...cur.map(([c, x]) => [-c, x] as [number, string]), ...prv], '>=', 0);
      lp.row(`mmb_${t}`, [[1, v], ...cur, ...prv.map(([c, x]) => [-c, x] as [number, string])], '>=', 0);
    }
  }

  // ---- shift energy neutrality ----
  custs.forEach((c, ci) => {
    if (c.shiftablePct <= 0) return;
    const terms: [number, string][] = [];
    for (let t = 0; t < H; t++) terms.push([1, V.sd(ci, t)], [-1, V.sp(ci, t)]);
    lp.row(`shn${ci}`, terms, '=', 0);
  });
  // ---- terminal battery energy: a soft target valued at the replacement cost of energy (cost group) ----
  bess.forEach((x, k) => {
    const target = (inp.terminalSocPct / 100) * x.energyMWh;
    lp.cost(Math.max(avgDam, 3.5) * 1.15, V.tslack(k));
    lp.bound(V.tslack(k), 0, x.energyMWh);
    lp.row(`term${k}`, [[1, V.soc(k, H - 1)], [1, V.tslack(k)]], '>=', Math.min(target, (x.socMaxPct / 100) * x.energyMWh));
  });

  // ================================================================== staged solve
  const stages: StageResult[] = [];
  const extra: string[] = [];
  const budget = Math.min(inp.timeLimitSec ?? pol.timeSec, Math.max(1.5, ((runDeadline - Date.now()) / 1000) * 0.5));
  const order = pol.order;
  let sol: any = null;
  let approximate = false;
  let infeasibleFirst = false;
  const physical = (g: Group, col: (n: string) => number) => {
    const v = lp.metric(g, col);
    return g === 're' ? reConst + v : v;
  };
  // a time-limited solve may return no incumbent (all zeros): accept it only if every row is satisfied
  const rowsFeasible = (s: any) => {
    for (const r of (s.Rows ?? []) as any[]) {
      const x = r.Primal as number, lo = r.Lower as number, hi = r.Upper as number;
      if (Number.isFinite(lo) && x < lo - 1e-5 * (1 + Math.abs(lo))) return false;
      if (Number.isFinite(hi) && x > hi + 1e-5 * (1 + Math.abs(hi))) return false;
    }
    return true;
  };
  const isOpt = (s: any) => s && s.Columns && Object.keys(s.Columns).length > 0 && (s.Status === 'Optimal' || (/limit/i.test(s.Status ?? '') && rowsFeasible(s)));
  const mkRow = (g: Group, rhs: number) => {
    const e = lp.expr(g);
    return e ? `stg_${g}: ${e} <= ${f(rhs)}` : '';
  };
  let remaining = budget;
  // Shortcut that is exact: the slack metrics (security, reliability, reserve, imbalance) are all >= 0, so if the leading run of them
  // sums to 0 in ONE probe solve, every one of those stages has optimum 0 and no separate solve is needed.
  const SLACK: Group[] = ['security', 'reliability', 'reserve', 'imbalance'];
  let start = 0;
  {
    let n = 0; while (n < order.length && SLACK.includes(order[n])) n++;
    if (pol.skipAtBound && n >= 2) {
      const lead = order.slice(0, n).filter((g) => lp.terms[g].length > 0);
      const probeTerms = lead.flatMap((g) => lp.terms[g].map((t) => `${t.c >= 0 ? '+' : '-'} ${f(Math.abs(t.c))} ${t.v}`)).join(' ');
      if (probeTerms) {
        const ts = Date.now();
        const text = lp.text(null, lead[0], extra).split('\n').map((ln) => (ln.startsWith(' obj:') ? ` obj: ${probeTerms}` : ln)).join('\n');
        let s: any; try { s = highs.solve(text, { time_limit: Math.max(pol.stageMinSec, budget * 0.25), mip_rel_gap: 0, presolve: 'on' }); } catch { s = null; }
        const ms = Date.now() - ts; remaining -= ms / 1000;
        if (isOpt(s) && s.Status === 'Optimal') {
          const c2 = (nm: string) => s.Columns[nm]?.Primal ?? 0;
          const total = lead.reduce((a2, g) => a2 + lp.metric(g, c2), 0);
          if (total <= 1e-4) {
            sol = s;
            for (const g of order.slice(0, n)) {
              if (lp.terms[g].length === 0) { stages.push({ group: g, unit: '', status: 'Skipped', metric: null, bound: null, gap: null, ms: 0, note: 'no terms for this group in this model' }); continue; }
              const row = mkRow(g, pol.tol[g].abs); if (row) extra.push(row);
              stages.push({ group: g, unit: '', status: 'Skipped', metric: 0, bound: pol.tol[g].abs, gap: null, ms: g === lead[0] ? ms : 0, note: 'one probe solve shows the sum of the higher-priority slack metrics is 0, so each is 0' });
            }
            start = n;
          }
        }
      }
    }
  }
  for (let si = start; si < order.length; si++) {
    const g = order[si];
    if (lp.terms[g].length === 0) { stages.push({ group: g, unit: '', status: 'Skipped', metric: null, bound: null, gap: null, ms: 0, note: 'no terms for this group in this model' }); continue; }
    const col = sol ? (n: string) => sol.Columns[n]?.Primal ?? 0 : null;
    if (sol && col && pol.skipAtBound && g !== 'cost' && g !== 'tie') {
      const phys = physical(g, col);
      if (phys <= 1e-6) {
        const rhs = (g === 're' ? -reConst : 0) + pol.tol[g].abs;
        const row = mkRow(g, rhs); if (row) extra.push(row);
        stages.push({ group: g, unit: '', status: 'Skipped', metric: 0, bound: pol.tol[g].abs, gap: null, ms: 0, note: 'already at its lower bound (0) in the previous stage' });
        continue;
      }
    }
    const left = order.slice(si).filter((x) => x === 'cost' || lp.terms[x].length > 0).length;
    const tl = g === 'tie' ? Math.min(1, Math.max(0.3, remaining)) : g === 'cost' ? Math.max(pol.stageMinSec, budget * pol.costStageShare) : Math.max(pol.stageMinSec, Math.min(remaining / Math.max(1, left), budget * 0.3));
    const ts = Date.now();
    let s: any;
    try { s = highs.solve(lp.text(null, g, extra), { time_limit: tl, mip_rel_gap: pol.gap[g], presolve: 'on' }); } catch (e: any) { s = { Status: 'error: ' + (e?.message ?? e) }; }
    const ms = Date.now() - ts; remaining -= ms / 1000;
    if (!isOpt(s)) {
      if (si === 0 || !sol) { infeasibleFirst = true; stages.push({ group: g, unit: '', status: String(s?.Status ?? 'no solution'), metric: null, bound: null, gap: null, ms }); break; }
      // a later stage became infeasible with the earlier tolerances: keep the previous solution and say so
      stages.push({ group: g, unit: '', status: String(s?.Status ?? 'no solution'), metric: null, bound: null, gap: null, ms, note: 'could not improve on the previous stage within its constraints' });
      continue;
    }
    sol = s;
    const limit = /limit/i.test(s.Status ?? '');
    if (limit && g !== 'tie') approximate = true; // the final tie-break stage only chooses among equally ranked solutions
    const c2 = (n: string) => s.Columns[n]?.Primal ?? 0;
    const metric = physical(g, c2);
    const optRaw = lp.metric(g, c2);
    const tolV = Math.max(pol.tol[g].abs, pol.tol[g].rel * Math.abs(optRaw));
    const row = mkRow(g, optRaw + tolV); if (row) extra.push(row);
    const gap = typeof s.MipGap === 'number' ? s.MipGap : (typeof s.ObjectiveBound === 'number' && Math.abs(s.ObjectiveValue) > 1e-9 ? Math.abs((s.ObjectiveValue - s.ObjectiveBound) / s.ObjectiveValue) : null);
    stages.push({ group: g, unit: '', status: limit ? 'Time limit reached' : 'Optimal', metric, bound: metric + tolV, gap, ms });
  }

  if (infeasibleFirst || !sol) {
    const conflicts: string[] = [];
    const fam: [string, string][] = [['holds', 'Thermal minimum up/down-time holds'], ['locks', 'Committed day-ahead / RTM volumes'], ['ramps', 'Thermal ramp limits'], ['floors', 'Battery reserve-charge floors'], ['corridors', 'Transmission corridor limits'], ['updown', 'Thermal minimum up/down-time']];
    for (const [k, label] of fam) {
      if (pol.relax?.includes(k)) continue;
      try {
        const r = buildAndSolve(highs, { ...inp, policy: { ...pol, relax: [...(pol.relax ?? []), k], timeSec: 2, order: ['reliability', 'cost'] } });
        if (r.ok) conflicts.push(label);
      } catch { /* ignore */ }
    }
    return { ok: false, status: stages[stages.length - 1]?.status ?? 'no solution', feasibility: 'infeasible', objective: 0, solveMs: Date.now() - t0, mip: true, blocks: [], stages, conflicts, note: conflicts.length ? `Infeasible. Relaxing any of these restores feasibility: ${conflicts.join('; ')}.` : 'Infeasible: no single constraint family explains it.' };
  }

  const col = (n: string) => sol.Columns[n]?.Primal ?? 0;
  const fixed: Record<string, number> = {};
  for (const v of lp.bin) fixed[v] = Math.round(col(v));
  // marginal prices / binding constraints: LP with the binaries fixed, minimising cost under the constraints of the stages ranked above it
  let dual: any = null;
  try {
    const upto = order.indexOf('cost');
    const keep = extra.filter((r) => { const g = r.slice(4, r.indexOf(':')) as Group; return order.indexOf(g) < upto; });
    dual = highs.solve(lp.text(fixed, 'cost', keep), { presolve: 'off' });
    if (dual?.Status !== 'Optimal') dual = null;
  } catch { dual = null; }
  const rowDual = (name: string) => {
    if (!dual) return null;
    const r = (dual.Rows as any[]).find((x) => x.Name === name);
    return r ? (r.Dual as number) : null;
  };
  const binding = dual ? families(dual.Rows as any[], dual.Columns) : [];

  const blocks: PlanBlock[] = [];
  let unservedMWh = 0, dsmMWh = 0, exclusive = 0;
  const cb = { renewables: 0, thermalFuel: 0, thermalNoLoad: 0, thermalStartup: 0, market: 0, contract: 0, bessDegradation: 0, demandResponse: 0, loadShift: 0, carbon: 0 };
  for (let t = 0; t < H; t++) {
    const by: Record<string, number> = {};
    let sSum = 0, wSum = 0, tSum = 0, dis = 0, ch = 0, curS = 0, curW = 0, soc = 0;
    solar.forEach((fm, i) => { const v = col(V.su(i, t)); by[fm.id] = v; sSum += v; const cu = Math.max(0, (inp.view.solar[t][fm.id] ?? 0) - v); curS += cu; by['curt:' + fm.id] = cu; cb.renewables += (v * fm.tariff + cu * 0.5 * fm.tariff) * DT; });
    wind.forEach((fm, i) => { const v = col(V.wu(i, t)); by[fm.id] = v; wSum += v; const cu = Math.max(0, (inp.view.wind[t][fm.id] ?? 0) - v); curW += cu; by['curt:' + fm.id] = cu; cb.renewables += (v * fm.tariff + cu * 0.5 * fm.tariff) * DT; });
    const on: Record<string, boolean> = {}, st: Record<string, boolean> = {};
    thermal.forEach((u, j) => {
      const v = col(V.p(j, t)); by[u.id] = v; tSum += v; on[u.id] = Math.round(col(V.u(j, t))) === 1; st[u.id] = col(V.y(j, t)) > 0.5;
      cb.thermalFuel += v * u.varCost * DT; cb.thermalNoLoad += (on[u.id] ? u.noLoadCost * DT : 0); cb.thermalStartup += st[u.id] ? u.startupCost : 0; cb.carbon += v * carbonPerKwh(u.emissionFactor) * DT;
    });
    const socBy: Record<string, number> = {};
    bess.forEach((x, k) => {
      const d = col(V.dis(k, t)), c = col(V.ch(k, t));
      dis += d; ch += c; by[x.id] = d - c; by['dis:' + x.id] = d; by['ch:' + x.id] = c;
      if (Math.min(d, c) > 0.5) exclusive++;
      socBy[x.id] = col(V.soc(k, t)); soc += socBy[x.id];
      cb.bessDegradation += d * x.degradationCost * S.weights.degradationScale * DT;
    });
    let sdt = 0, spt = 0, drt = 0;
    custs.forEach((c, ci) => {
      if (c.drFlexPct > 0 && !(pol.assumptions.drExcludeCritical && c.criticality === 'critical')) { const v = col(V.dr(ci, t)); drt += v; if (v > 0.01) by['dr:' + c.id] = v; cb.demandResponse += v * (c.tariff + c.drIncentive) * DT; }
      if (c.shiftablePct > 0) { const a = col(V.sd(ci, t)), b = col(V.sp(ci, t)); sdt += a; spt += b; if (Math.abs(b - a) > 0.01) by['shift:' + c.id] = b - a; cb.loadShift += (a * pol.assumptions.shiftOutRs + b * pol.assumptions.shiftInRs) * DT; }
    });
    const dr = drt, shift = spt - sdt;
    const un = col(V.unC(t)) + col(V.unN(t));
    unservedMWh += un * DT;
    dsmMWh += (col(`slkb_${t}`) + col(`slkm_${t}`) + col(`slks_${t}`)) * DT;
    const dam = inp.view.damPrice[t], rtm = inp.view.rtmPrice[t];
    cb.market += ((col(V.db(t)) * (dam + m.exchangeFee + m.buyAdder) - col(V.ds(t)) * (dam - m.exchangeFee - m.sellDeduction)) + (col(V.rb(t)) * (rtm + m.exchangeFee + m.buyAdder) - col(V.rs(t)) * (rtm - m.exchangeFee - m.sellDeduction))) * DT;
    cb.contract += col(V.g(t)) * P.interconnect.gridContractPrice * DT;
    const slackUp = col(V.rsu(t)), slackDn = col(V.rsd(t));
    const sigma = inp.view.sigmaUp[t] * (inp.view.stormRisk[t] > 0.5 ? pol.reserve.stormSigmaMultiplier : 1);
    const reqUp = resMult * pb.reserveUpMult[t] * Math.max(pol.reserve.baseUpDemandShare * termDemand[t], sigma);
    const reqDn = resMult * pb.reserveDnMult[t] * Math.max(pol.reserve.baseUpDemandShare * termDemand[t], pol.reserve.baseDownSigmaShare * sigma);
    const dB = rowDual(`bal_${t}`);
    const socRowDual = bess.length ? rowDual(`soc0_${t}`) : null;
    blocks.push({
      slot: inp.slot0 + t,
      flows: {
        solar: sSum, wind: wSum, thermal: tSum, bessDis: dis, bessCh: ch,
        damBuy: col(V.db(t)), damSell: col(V.ds(t)), rtmBuy: col(V.rb(t)), rtmSell: col(V.rs(t)), grid: col(V.g(t)),
        curtailSolar: curS, curtailWind: curW, dr, shiftNet: shift, unserved: un, dump: col(V.dump(t)),
        load: termDemand[t] - dr - sdt + spt, demand: termDemand[t], by,
      },
      socMWh: soc, socByBess: socBy, thermalOn: on, started: st,
      smc: dB == null ? null : dB / DT,
      socValue: socRowDual == null ? null : Math.abs(socRowDual),
      reserveUpReq: reqUp, reserveUpAvail: Math.max(0, reqUp - slackUp), reserveDnReq: reqDn, reserveDnAvail: Math.max(0, reqDn - slackDn),
      reserveSlackUp: slackUp, reserveSlackDn: slackDn,
      imbalanceMW: col(`slkb_${t}`) + col(`slkm_${t}`) + col(`slks_${t}`),
    });
  }
  const total = Object.values(cb).reduce((a, b) => a + b, 0);
  const costBreakdown: Record<string, number> = { ...cb, total };

  // ---- adequacy report: which limits stand in the way when demand cannot be fully served ----
  let feasibility: PlanOutput['feasibility'] = 'ok';
  const conflicts: string[] = [];
  if (unservedMWh > 0.05) {
    feasibility = 'shortfall';
    const hit = (cond: (b: PlanBlock, t: number) => boolean) => blocks.filter((b, t) => b.flows.unserved > 0.5 && cond(b, t)).length;
    const n = blocks.filter((b) => b.flows.unserved > 0.5).length;
    const thCap = (t: number) => thermal.reduce((a, u) => a + (inp.view.thermalCap[t][u.id] ?? 0), 0);
    const items: [string, number][] = [
      [`Import limit (${P.interconnect.importLimitMW} MW) reached`, hit((b) => b.flows.damBuy + b.flows.rtmBuy + b.flows.grid >= P.interconnect.importLimitMW - 1)],
      [`Exchange purchase limit (${m.maxBuyMW} MW) reached`, hit((b) => b.flows.damBuy + b.flows.rtmBuy >= m.maxBuyMW - 1)],
      [`Contract import limit (${P.interconnect.gridContractLimitMW} MW) reached`, hit((b) => b.flows.grid >= P.interconnect.gridContractLimitMW - 1)],
      ['Thermal capacity fully used', hit((b, t) => b.flows.thermal >= thCap(t) - 1)],
      ['Battery at its power or energy limit', hit((b, t) => bess.every((x) => (b.flows.by['dis:' + x.id] ?? 0) >= 0.9 * (inp.view.bessPower[t][x.id] ?? 0) || b.socByBess[x.id] <= (x.socMinPct / 100) * x.energyMWh + 1))],
      ['Demand-response capacity used or not permitted', hit((b) => b.flows.dr >= 0 )],
    ];
    for (const [label, k] of items) if (k > 0 && k >= n * 0.5) conflicts.push(`${label} in ${k} of ${n} short blocks`);
  }

  const last = [...stages].reverse().find((st) => st.status !== 'Skipped');
  return {
    ok: true, status: last?.status ?? 'Optimal', feasibility, objective: total, solveMs: Date.now() - t0, mip: true, blocks, stages, binding, conflicts,
    costBreakdown, dsmExposureMWh: dsmMWh, unservedMWh, exclusivityViolations: exclusive, approximate,
    floorSlackMWh: Object.keys(sol.Columns).reduce((a, k) => a + (k.startsWith('sfl') ? sol.Columns[k]?.Primal ?? 0 : 0), 0),
    note: approximate ? 'At least one stage ended on its time limit: the result is feasible and near-optimal but not proven optimal.' : undefined,
  };
}
