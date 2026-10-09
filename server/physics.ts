// Real-time execution of a block: control-room balancing, DSM settlement and cost accounting.
import type { CostBreakdown, Flows, Portfolio, Settings } from './types.js';
import type { Truth } from './twin.js';
import { DT, clamp } from './util.js';
import { GRID_EF } from './opt/model.js';

export interface FleetState {
  socMWh: Record<string, number>;
  thermalOn: Record<string, boolean>;
  thermalP: Record<string, number>;
  thermalSince: Record<string, number>; // blocks in current on/off state
  thermalTripped?: Record<string, boolean>; // off because of a trip / forced outage (restart waits only the unit's hot-restart time), cleared when it runs again
  invMWh: number; // stored-energy inventory (MWh in battery terms)
  invCost: number; // ₹ '000 capitalised in the inventory
  cumStarts: Record<string, number>;
  startAmort: Record<string, { perBlock: number; left: number }>; // start-up cost spread over the minimum run
}

export const emptyFlows = (): Flows => ({
  solar: 0, wind: 0, thermal: 0, bessDis: 0, bessCh: 0, damBuy: 0, damSell: 0, rtmBuy: 0, rtmSell: 0, grid: 0,
  curtailSolar: 0, curtailWind: 0, dr: 0, shiftNet: 0, unserved: 0, dsmDraw: 0, load: 0, demand: 0, by: {},
});

export function initFleetState(P: Portfolio): FleetState {
  const st: FleetState = { socMWh: {}, thermalOn: {}, thermalP: {}, thermalSince: {}, invMWh: 0, invCost: 0, cumStarts: {}, startAmort: {} };
  for (const b of P.bess) {
    st.socMWh[b.id] = (b.initialSocPct / 100) * b.energyMWh;
    st.invMWh += st.socMWh[b.id];
  }
  st.invCost = st.invMWh * 3.6; // opening inventory valued at ₹3.6/kWh
  for (const u of P.thermal) {
    const on = u.enabled && (u.mustRun || u.group === 'B');
    st.thermalOn[u.id] = on;
    st.thermalP[u.id] = on ? u.capacityMW * (u.group === 'A' ? 0.75 : 0.55) : 0;
    st.thermalSince[u.id] = 99;
    st.cumStarts[u.id] = 0;
  }
  return st;
}

export const cloneState = (s: FleetState): FleetState => JSON.parse(JSON.stringify(s));

/** Blocks a unit needs to be back on line after a trip (hot restart); never longer than its minimum down-time. */
export const restartBlocks = (u: { tripRestartBlocks?: number; minDownBlocks: number }) => Math.max(1, Math.min(u.minDownBlocks, u.tripRestartBlocks ?? 8));

export function thermalHold(P: Portfolio, st: FleetState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of P.thermal) {
    const need = st.thermalOn[u.id] ? u.minUpBlocks : u.minDownBlocks;
    out[u.id] = Math.max(0, need - (st.thermalSince[u.id] ?? 99));
  }
  return out;
}

// ------------------------------------------------------------------ DSM
export interface DsmResult { mw: number; rate: number; cost: number; band: number }

/** CERC-DSM-2024-inspired deviation settlement (parameterised, see Settings.dsm). Cost in ₹'000 per block; +ve = payable. */
export function dsmSettle(devMW: number, schedMW: number, freq: number, acp: number, S: Settings): DsmResult {
  const d = S.dsm;
  const base = Math.max(acp, 1);
  const band = (d.bandPct / 100) * Math.max(Math.abs(schedMW), 200);
  const abs = Math.abs(devMW);
  if (abs < 0.5) return { mw: devMW, rate: 0, cost: 0, band };
  if (devMW > 0) {
    // over-drawal / under-injection: pay more when frequency is low
    const fF = clamp(1 + 6 * (50.0 - freq), 0.5, 3.0);
    let rate = Math.min(base * fF, d.capRate);
    const inBand = Math.min(abs, band), excess = Math.max(0, abs - band);
    const mid = Math.min(excess, band * 0.5), high = Math.max(0, excess - band * 0.5);
    const energyCost = rate * (inBand + mid * d.surchargeMid + high * d.surchargeHigh) * DT;
    rate = (energyCost / (abs * DT)) || rate;
    return { mw: devMW, rate, cost: energyCost, band };
  }
  // under-drawal / over-injection: credited at a frequency-linked fraction; no credit beyond the band
  const fU = clamp(0.9 - 4 * (freq - 50.0), 0.1, 1.2);
  const rate = Math.min(base * fU, d.capRate);
  const credited = Math.min(abs, band);
  return { mw: devMW, rate: -rate, cost: -rate * credited * DT, band };
}

// ------------------------------------------------------------------ cost accounting
export interface Prices { dam: number; rtm: number }

export function accountFlows(
  fl: Flows, P: Portfolio, S: Settings, px: Prices, st: FleetState, startedUnits: string[], dsmCost: number,
): { cost: CostBreakdown; cpu: number; emissions: number; st: FleetState } {
  const out = cloneState(st);
  const m = S.market;
  const by = fl.by;
  let solar = 0, wind = 0, thermal = 0, curtail = 0, dr = 0, startup = 0, emissions = 0, fixed = 0;
  for (const f of P.solar) { solar += (by[f.id] ?? 0) * f.tariff * DT; curtail += (by['curt:' + f.id] ?? 0) * 0.5 * f.tariff * DT; }
  for (const f of P.wind) { wind += (by[f.id] ?? 0) * f.tariff * DT; curtail += (by['curt:' + f.id] ?? 0) * 0.5 * f.tariff * DT; }
  for (const u of P.thermal) {
    const p = by[u.id] ?? 0;
    thermal += p * u.varCost * DT + (out.thermalOn[u.id] ? u.noLoadCost * DT : 0);
    emissions += p * DT * u.emissionFactor;
    if (u.enabled) fixed += (u.capacityMW * u.capacityCharge * 100) / 30 / 96; // ₹ lakh/MW-month -> ₹ '000 per block
  }
  out.startAmort ??= {};
  for (const id of startedUnits) {
    const u = P.thermal.find((x) => x.id === id);
    if (u) out.startAmort[id] = { perBlock: u.startupCost / Math.max(1, u.minUpBlocks), left: Math.max(1, u.minUpBlocks) };
  }
  for (const [id, a] of Object.entries(out.startAmort)) {
    if (a.left > 0) { startup += a.perBlock; a.left--; }
    if (a.left <= 0) delete out.startAmort[id];
    void id;
  }
  for (const c of P.customers) {
    const v = by['dr:' + c.id] ?? 0;
    dr += v * (c.tariff + c.drIncentive) * DT;
  }
  const buyD = (px.dam + m.exchangeFee + m.buyAdder), sellD = (px.dam - m.exchangeFee - m.sellDeduction);
  const buyR = (px.rtm + m.exchangeFee + m.buyAdder), sellR = (px.rtm - m.exchangeFee - m.sellDeduction);
  const market = (fl.damBuy * buyD - fl.damSell * sellD + fl.rtmBuy * buyR - fl.rtmSell * sellR) * DT;
  const grid = fl.grid * P.interconnect.gridContractPrice * DT;
  emissions += (fl.damBuy + fl.rtmBuy) * DT * GRID_EF + fl.grid * DT * 0.8 + Math.max(0, fl.dsmDraw) * DT * GRID_EF;

  // BESS: charging energy is capitalised into the inventory at the block's average source cost; discharge expenses it at WAC.
  const srcMWh = (fl.solar + fl.wind + fl.thermal + fl.damBuy + fl.rtmBuy + fl.grid + Math.max(0, fl.dsmDraw)) * DT;
  const procExcl = solar + wind + thermal + market + grid;
  const avgSrc = srcMWh > 1e-6 ? Math.max(0, procExcl) / srcMWh : 0;
  let bessCost = 0;
  const etaC = P.bess.length ? P.bess.reduce((a, b) => a + b.etaCharge, 0) / P.bess.length : 0.94;
  const etaD = P.bess.length ? P.bess.reduce((a, b) => a + b.etaDischarge, 0) / P.bess.length : 0.94;
  const deg = P.bess.length ? P.bess.reduce((a, b) => a + b.degradationCost, 0) / P.bess.length * S.weights.degradationScale : 0;
  const chargeValue = fl.bessCh * DT * avgSrc;
  out.invMWh += fl.bessCh * DT * etaC;
  out.invCost += chargeValue;
  const drawn = (fl.bessDis * DT) / etaD;
  const wac = out.invMWh > 1e-6 ? out.invCost / out.invMWh : 0;
  const take = Math.min(drawn, out.invMWh);
  const dischargeExpense = take * wac;
  out.invMWh -= take; out.invCost -= dischargeExpense;
  bessCost = dischargeExpense - chargeValue + fl.bessDis * DT * deg;

  const total = solar + wind + thermal + market + grid + dr + curtail + startup + fixed + dsmCost + bessCost;
  const served = fl.load * DT;
  return {
    cost: { solar, wind, thermal, market, grid, bess: bessCost, dsm: dsmCost, curtail, dr, startup, fixed, total },
    cpu: served > 1e-6 ? total / served : 0,
    emissions,
    st: out,
  };
}

// ------------------------------------------------------------------ real-time execution
export interface StepInput {
  slot: number;
  plan: Flows | null;
  planOn: Record<string, boolean>;
  truth: Truth;
  st: FleetState;
  P: Portfolio;
  S: Settings;
  freq: number;
  px: Prices;
}
export interface StepOutput {
  act: Flows;
  st: FleetState;
  started: string[];
  dsm: DsmResult;
  notes: string[];
  scheduledNet: number;
}

export function executeBlock(inp: StepInput): StepOutput {
  const { P, S, truth, plan } = inp;
  const st = cloneState(inp.st);
  const fl = emptyFlows();
  const notes: string[] = [];
  const by = fl.by;
  const pl = plan ?? emptyFlows();

  // --- scheduled external interchange (what the control area promised the grid)
  let schedNet = pl.damBuy - pl.damSell + pl.rtmBuy - pl.rtmSell + pl.grid;
  fl.damBuy = pl.damBuy; fl.damSell = pl.damSell; fl.rtmBuy = pl.rtmBuy; fl.rtmSell = pl.rtmSell; fl.grid = pl.grid;

  // --- renewables: take everything available, minus pre-planned curtailment
  let solar = 0, wind = 0, curS = 0, curW = 0;
  for (const f of P.solar) {
    const avail = truth.solar[f.id] ?? 0;
    const pc = pl.by['curt:' + f.id] ?? 0;
    const used = Math.max(0, avail - Math.min(avail, pc));
    by[f.id] = used; by['curt:' + f.id] = avail - used; solar += used; curS += avail - used;
  }
  for (const f of P.wind) {
    const avail = truth.wind[f.id] ?? 0;
    const pc = pl.by['curt:' + f.id] ?? 0;
    const used = Math.max(0, avail - Math.min(avail, pc));
    by[f.id] = used; by['curt:' + f.id] = avail - used; wind += used; curW += avail - used;
  }

  // --- demand actually served after planned demand response / shifting
  let demand = 0, dr = 0, shift = 0;
  for (const c of P.customers) {
    const d = truth.demand[c.id] ?? 0;
    demand += d;
    const drPlan = pl.by['dr:' + c.id] ?? 0;
    const drAct = Math.min(drPlan, (c.drFlexPct / 100) * d);
    if (drAct > 0.01) { by['dr:' + c.id] = drAct; dr += drAct; }
    const sh = pl.by['shift:' + c.id] ?? 0; // + added, - deferred
    const shAct = clamp(sh, -(c.shiftablePct / 100) * d, (c.shiftablePct / 100) * d);
    if (Math.abs(shAct) > 0.01) { by['shift:' + c.id] = shAct; shift += shAct; }
  }
  let loadServed = demand - dr + shift;

  // --- thermal at planned set-points, bounded by what the units can physically do now
  const started: string[] = [];
  let thermal = 0;
  const units = P.thermal.filter((u) => u.enabled);
  for (const u of units) {
    const cap = truth.thermalCap[u.id] ?? 0;
    const pmin = (u.minLoadPct / 100) * u.capacityMW;
    const ramp = (u.rampPctPerMin / 100) * u.capacityMW * 15;
    const wasOn = st.thermalOn[u.id];
    // a unit that tripped cannot be started before its hot-restart time has passed, whatever the plan says (the plan may predate the trip)
    const restarting = !wasOn && !!st.thermalTripped?.[u.id] && (st.thermalSince[u.id] ?? 99) < u.minDownBlocks;
    const wantOn = (inp.planOn[u.id] ?? wasOn) && cap >= pmin && !restarting;
    let p = 0;
    if (wantOn) {
      const prev = wasOn ? st.thermalP[u.id] : 0;
      const target = pl.by[u.id] ?? pmin;
      p = wasOn ? clamp(target, Math.max(pmin, prev - ramp), Math.min(cap, prev + ramp)) : clamp(target, pmin, cap);
      if (!wasOn) started.push(u.id);
    } else if (wasOn && cap < pmin) notes.push(`${u.name} tripped / derated below minimum load – unit offline`);
    by[u.id] = p; thermal += p;
    const nowOn = p > 0;
    st.thermalSince[u.id] = nowOn === wasOn ? (st.thermalSince[u.id] ?? 0) + 1 : 1;
    if (!st.thermalTripped) st.thermalTripped = {};
    if (nowOn) st.thermalTripped[u.id] = false;
    else if (wasOn && cap < pmin) { // a trip: the unit can be back after its hot-restart time, which is shorter than the planned-shutdown minimum down-time
      st.thermalTripped[u.id] = true;
      st.thermalSince[u.id] = Math.max(1, u.minDownBlocks - restartBlocks(u));
    }
    st.thermalOn[u.id] = nowOn;
    st.thermalP[u.id] = p;
  }
  if (started.length) st.cumStarts = Object.fromEntries(units.map((u) => [u.id, (st.cumStarts[u.id] ?? 0) + (started.includes(u.id) ? 1 : 0)]));

  // --- BESS planned set-points (bounded by physical availability and SOC)
  let net = 0;
  const bessAct: Record<string, { ch: number; dis: number }> = {};
  for (const b of P.bess.filter((x) => x.enabled)) {
    const pav = truth.bessPower[b.id] ?? 0;
    const plannedNet = pl.by[b.id] ?? 0;
    const smin = (b.socMinPct / 100) * b.energyMWh, smax = (b.socMaxPct / 100) * b.energyMWh;
    const soc = st.socMWh[b.id];
    let dis = Math.max(0, plannedNet), ch = Math.max(0, -plannedNet);
    dis = Math.min(dis, pav, ((soc - smin) * b.etaDischarge) / DT);
    ch = Math.min(ch, pav, (smax - soc) / b.etaCharge / DT);
    bessAct[b.id] = { ch: Math.max(0, ch), dis: Math.max(0, dis) };
    net += bessAct[b.id].dis - bessAct[b.id].ch;
  }

  // --- in-interval balancing
  // The plant runs to its schedule (thermal and battery set-points above, limited only by what the equipment can physically do now: a trip, a derate,
  // the state of charge) and renewables and demand are what they actually are. Nothing is re-dispatched to chase the imbalance, and the exchange
  // volumes and contract drawal stay as scheduled: moving thermal or the battery, buying, selling or drawing more contract power is a decision for the
  // NEXT interval's plan. Whatever does not balance is settled as a deviation (DSM), up or down. The only things applied inside the block are protection
  // against a physical limit (an evacuation corridor over its capability, below) and the import limit on over-drawal (load that cannot be served is shed).
  const supply = () => solar + wind + thermal + net + schedNet;
  let imb = loadServed - supply(); // +ve deficit (over-drawal), -ve surplus (under-drawal / injection)

  // --- corridor security: curtail if an evacuation corridor is over its (possibly derated) limit
  for (const cor of P.corridors) {
    const ttc = truth.ttc[cor.id] ?? cor.ttcMW;
    const members = [...P.solar, ...P.wind].filter((f) => f.corridorId === cor.id);
    let flow = members.reduce((a, f) => a + (by[f.id] ?? 0), 0) + P.bess.filter((b) => b.corridorId === cor.id && b.enabled).reduce((a, b) => a + (bessAct[b.id].dis - bessAct[b.id].ch), 0);
    if (flow > ttc + 0.5) {
      notes.push(`Corridor ${cor.id} over limit by ${(flow - ttc).toFixed(0)} MW – security curtailment`);
      for (const f of members) {
        if (flow <= ttc) break;
        const cut = Math.min(flow - ttc, by[f.id] ?? 0);
        by[f.id] -= cut; by['curt:' + f.id] += cut; flow -= cut;
        if (f.kind === 'solar') { solar -= cut; curS += cut; } else { wind -= cut; curW += cut; }
        imb += cut;
      }
    }
  }

  // --- settle residual as deviation against the schedule (DSM); cap by interconnect headroom, rest is load shedding
  // Shortage inside the block: only the part that would exceed what the interconnect can bring in is handled here (the rest is simply over-drawal, settled as a
  // deviation). Order: stop battery charging, thermal headroom (ramp-limited), cut flexible customers, the battery (reserve), curb committed exchange sales and,
  // only if the grid still cannot be kept in balance, a disruption across ALL customers (the worst case). Economic re-dispatch still waits for the next plan.
  let disrupted = 0, curbed = 0;
  // a battery planned to charge never does so on over-drawn grid power: any shortfall stops the charging first (a physical response, not a re-dispatch)
  if (imb > 0.5) for (const b of P.bess.filter((x) => x.enabled)) {
    const a = bessAct[b.id];
    const stop = Math.min(a.ch, Math.max(0, imb));
    if (stop > 0.1) { a.ch -= stop; net += stop; imb -= stop; notes.push(`Battery charging stopped (${stop.toFixed(0)} MW): the block is short, so charging would only add over-drawal`); }
  }
  {
    let need = imb - Math.max(0, P.interconnect.importLimitMW - Math.max(0, schedNet));
    if (need > 0.5) {
      const used0 = need;
      // 1. a battery that was planned to charge stops charging: while customers are short, charging only takes supply away from them
      for (const b of P.bess.filter((x) => x.enabled)) {
        const a = bessAct[b.id];
        const stop = Math.min(a.ch, Math.max(0, need));
        if (stop > 0.1) { a.ch -= stop; net += stop; imb -= stop; need -= stop; }
      }
      // 2. thermal headroom, cheapest first
      for (const u of [...units].sort((a, b) => a.varCost - b.varCost)) {
        if (need <= 0.5 || !st.thermalOn[u.id]) continue;
        const cap = truth.thermalCap[u.id] ?? 0;
        const ramp = (u.rampPctPerMin / 100) * u.capacityMW * 15;
        const room = Math.min(cap - by[u.id], ramp - Math.max(0, by[u.id] - (inp.st.thermalP[u.id] ?? 0)));
        const add = clamp(Math.min(need, room), 0, 1e9);
        if (add > 0.1) { by[u.id] += add; thermal += add; st.thermalP[u.id] = by[u.id]; need -= add; imb -= add; }
      }
      // 3. cut flexible customers (essential and critical customers are not cut here)
      for (const c of [...P.customers].filter((x) => x.enabled && x.criticality === 'flexible').sort((a, b) => b.peakMW - a.peakMW)) {
        if (need <= 0.5) break;
        const served = Math.max(0, (truth.demand[c.id] ?? 0) - (by['dr:' + c.id] ?? 0) + (by['shift:' + c.id] ?? 0));
        const take = Math.min(need, served);
        if (take > 0.1) { by['dr:' + c.id] = (by['dr:' + c.id] ?? 0) + take; dr += take; loadServed -= take; imb -= take; need -= take; notes.push(`Flexible load cut: ${c.name} −${take.toFixed(0)} MW`); }
      }
      // 4. the battery (reserve), down to just above its physical minimum
      for (const b of P.bess.filter((x) => x.enabled)) {
        if (need <= 0.5) break;
        const a = bessAct[b.id]; const pav = truth.bessPower[b.id] ?? 0;
        const smin = ((b.socMinPct + 2) / 100) * b.energyMWh;
        const soc = st.socMWh[b.id] + (a.ch * b.etaCharge - a.dis / b.etaDischarge) * DT;
        const add = clamp(Math.min(need, pav - a.dis + a.ch, ((soc - smin) * b.etaDischarge) / DT), 0, 1e9);
        if (add > 0.1) { const fromCh = Math.min(add, a.ch); a.ch -= fromCh; a.dis += add - fromCh; net += add; imb -= add; need -= add; }
      }
      // 5. committed exchange sales are curbed: the delivery is dropped and settled as a deviation. This is bookkeeping, not extra supply: the net import the grid
      //    connection must carry is the same either way, so it does not reduce the shortage (it only stops the plant exporting while customers are short)
      for (const key of ['damSell', 'rtmSell'] as const) {
        const cur = Math.min(fl[key], Math.max(0, imb));
        if (cur > 0.1) { fl[key] -= cur; schedNet += cur; curbed += cur; imb -= cur; notes.push(`Committed sale curbed by ${cur.toFixed(0)} MW while customers are short`); }
      }
      // 6. worst case: the grid cannot be kept in balance, so supply is disrupted across ALL customers in proportion to their load
      if (need > 0.5) {
        const live = P.customers.filter((x) => x.enabled).map((c) => ({ c, served: Math.max(0, (truth.demand[c.id] ?? 0) - (by['dr:' + c.id] ?? 0) + (by['shift:' + c.id] ?? 0)) }));
        const totalServed = live.reduce((s, x) => s + x.served, 0);
        const take = Math.min(need, totalServed);
        if (totalServed > 0.1) for (const { c, served } of live) {
          const d = (served / totalServed) * take;
          if (d > 0.01) { by['disrupt:' + c.id] = d; loadServed -= d; }
        }
        disrupted = take; imb -= take; need -= take;
        notes.push(`Supply disrupted at all customers: ${take.toFixed(0)} MW cannot be supplied`);
      }
      if (used0 - need - disrupted > 0.5) notes.push(`Reserve protection used in the block: ${(used0 - need - disrupted).toFixed(0)} MW`);
    }
  }
  let unserved = disrupted;
  let dev = imb; // +ve over-drawal
  const maxOver = Math.max(0, P.interconnect.importLimitMW - Math.max(0, schedNet));
  if (dev > maxOver) { const over = dev - maxOver; unserved += over; dev = maxOver; notes.push(`ICT drawal limit reached – ${over.toFixed(0)} MW load shed`); }
  const maxUnder = P.interconnect.exportLimitMW + Math.max(0, schedNet);
  if (-dev > maxUnder) {
    // power that cannot physically leave through the interconnect: renewables are curtailed by that amount (a physical limit, not a re-dispatch)
    let excess = -dev - maxUnder;
    const total = excess;
    for (const f of [...P.solar, ...P.wind].sort((a, b) => b.tariff - a.tariff)) {
      if (excess <= 0.1) break;
      const cut = Math.min(excess, by[f.id] ?? 0);
      if (cut <= 0.1) continue;
      by[f.id] -= cut; by['curt:' + f.id] = (by['curt:' + f.id] ?? 0) + cut; excess -= cut;
      if (f.kind === 'solar') { solar -= cut; curS += cut; } else { wind -= cut; curW += cut; }
    }
    if (total - excess > 0.5) notes.push(`Export limit reached – ${(total - excess).toFixed(0)} MW of renewables curtailed (the surplus cannot leave through the interconnect)`);
    dev = -maxUnder;
  }

  // --- finalise BESS state and flows
  let dis = 0, ch = 0;
  for (const b of P.bess.filter((x) => x.enabled)) {
    const a = bessAct[b.id];
    st.socMWh[b.id] = clamp(st.socMWh[b.id] + (a.ch * b.etaCharge - a.dis / b.etaDischarge) * DT, 0, b.energyMWh);
    by[b.id] = a.dis - a.ch; dis += a.dis; ch += a.ch;
  }
  fl.solar = solar; fl.wind = wind; fl.thermal = thermal; fl.bessDis = dis; fl.bessCh = ch;
  fl.curtailSolar = curS; fl.curtailWind = curW; fl.dr = dr; fl.shiftNet = shift; fl.unserved = unserved;
  fl.dsmDraw = dev + curbed; fl.demand = demand; fl.load = loadServed - (unserved - disrupted); // disrupted load is already out of loadServed

  const dsm = dsmSettle(dev + curbed, schedNet - curbed, inp.freq, inp.px.rtm, S); // against the schedule as committed, before any sale was curbed
  return { act: fl, st, started, dsm, notes, scheduledNet: schedNet };
}
