// Action-cluster evaluation: the selected set of actions is judged over the whole look-ahead window (not action by action) and
// compared with (a) the committed schedule left untouched, (b) a cost-only dispatch and (c) a conservative dispatch planned for
// adverse forecasts. All figures are computed from solver flows with one common cost function, so the comparison is like for like.
import type { PlanBlock, PlanOutput } from '../opt/model.js';
import type { BaselineBlock } from '../agent.js';
import type { Portfolio, Settings } from '../types.js';
import type { AgentView } from '../twin.js';
import { dsmSettle } from '../physics.js';

const DT = 0.25;

export interface ClusterMetrics {
  label: string;
  windowBlocks: number;
  costK: number; // ₹ thousand: energy, fuel, start-up, market, degradation, demand response
  unservedMWh: number;
  reserveShortMWh: number; // upward reserve shortfall, MW·h
  dsmExposureMWh: number; // energy that settles as deviation
  dsmCostK: number; // expected cost of that deviation (₹ thousand)
  reUtilPct: number;
  curtailMWh: number;
  bessThroughputMWh: number;
  socEndPct: number;
  marketBuyMWh: number;
  marketSellMWh: number;
  peakBuyMW: number;
  flexibilityMWh: number; // battery energy above its reserve floor at the end of the window + ramp headroom of running units (30 min)
  status?: string;
  notes: string[];
}

interface BlockLike {
  by: Record<string, number>; thermalOn: Record<string, boolean>; started?: Record<string, boolean>;
  damBuy: number; damSell: number; rtmBuy: number; rtmSell: number; grid: number;
}

function blockCostK(b: BlockLike, P: Portfolio, S: Settings, dam: number, rtm: number): number {
  let c = 0;
  for (const f of [...P.solar, ...P.wind]) c += ((b.by[f.id] ?? 0) * f.tariff + (b.by['curt:' + f.id] ?? 0) * 0.5 * f.tariff) * DT;
  for (const u of P.thermal) {
    const p = b.by[u.id] ?? 0;
    c += p * u.varCost * DT + (b.thermalOn[u.id] ? u.noLoadCost * DT : 0) + (b.started?.[u.id] ? u.startupCost : 0);
  }
  const m = S.market;
  c += ((b.damBuy * (dam + m.exchangeFee + m.buyAdder) - b.damSell * (dam - m.exchangeFee - m.sellDeduction)) + (b.rtmBuy * (rtm + m.exchangeFee + m.buyAdder) - b.rtmSell * (rtm - m.exchangeFee - m.sellDeduction))) * DT;
  c += b.grid * P.interconnect.gridContractPrice * DT;
  for (const k of P.bess) c += (b.by['dis:' + k.id] ?? Math.max(0, b.by[k.id] ?? 0)) * k.degradationCost * S.weights.degradationScale * DT;
  for (const cu of P.customers) c += (b.by['dr:' + cu.id] ?? 0) * (cu.tariff + cu.drIncentive) * DT;
  return c;
}

const sumv = (o: Record<string, number> | undefined) => (o ? Object.values(o).reduce((a, b) => a + b, 0) : 0);

export function metricsOfPlan(label: string, out: PlanOutput, view: AgentView, P: Portfolio, S: Settings, W: number): ClusterMetrics {
  const bl: PlanBlock[] = out.blocks.slice(0, W);
  const bess = P.bess.filter((b) => b.enabled);
  let cost = 0, un = 0, rs = 0, dsm = 0, reA = 0, reU = 0, cur = 0, thr = 0, buy = 0, sell = 0, peak = 0;
  bl.forEach((b, t) => {
    cost += blockCostK({ by: b.flows.by, thermalOn: b.thermalOn, started: b.started, damBuy: b.flows.damBuy, damSell: b.flows.damSell, rtmBuy: b.flows.rtmBuy, rtmSell: b.flows.rtmSell, grid: b.flows.grid }, P, S, view.damFc[t], view.rtmFc[t]);
    un += b.flows.unserved * DT; rs += b.reserveSlackUp * DT; dsm += b.imbalanceMW * DT;
    reA += (sumv(view.solar[t]) + sumv(view.wind[t])) * DT; reU += (b.flows.solar + b.flows.wind) * DT; cur += (b.flows.curtailSolar + b.flows.curtailWind) * DT;
    thr += (b.flows.bessDis + b.flows.bessCh) * DT; buy += (b.flows.damBuy + b.flows.rtmBuy) * DT; sell += (b.flows.damSell + b.flows.rtmSell) * DT; peak = Math.max(peak, b.flows.damBuy + b.flows.rtmBuy);
  });
  const end = bl[bl.length - 1];
  const E = bess.reduce((a, b) => a + b.energyMWh, 0);
  const floor = bess.reduce((a, b) => a + ((b.socMinPct + b.gridSupportReservePct) / 100) * b.energyMWh, 0);
  const soc = end ? end.socMWh : 0;
  const head = end ? P.thermal.filter((u) => u.enabled && end.thermalOn[u.id]).reduce((a, u) => a + Math.min((u.rampPctPerMin / 100) * u.capacityMW * 15, Math.max(0, (view.thermalCap[Math.min(W - 1, view.thermalCap.length - 1)][u.id] ?? 0) - (end.flows.by[u.id] ?? 0))), 0) * 0.5 : 0;
  const rt = bl.reduce((a, b, t) => a + b.imbalanceMW * (view.rtmFc[t] ?? 5) * DT, 0);
  return {
    label, windowBlocks: bl.length, costK: cost, unservedMWh: un, reserveShortMWh: rs, dsmExposureMWh: dsm, dsmCostK: rt * 1.4,
    reUtilPct: reA > 0 ? (reU / reA) * 100 : 100, curtailMWh: cur, bessThroughputMWh: thr, socEndPct: E > 0 ? (soc / E) * 100 : 0, marketBuyMWh: buy, marketSellMWh: sell, peakBuyMW: peak,
    flexibilityMWh: Math.max(0, soc - floor) + head, status: out.status, notes: out.approximate ? ['solver stopped on a time limit: near-optimal, not proven'] : [],
  };
}

/** The committed schedule, left untouched, judged against the CURRENT forecasts (what happens if the agent does nothing). */
export function metricsOfBaseline(label: string, base: BaselineBlock[], view: AgentView, P: Portfolio, S: Settings, W: number, freq: number): ClusterMetrics {
  const bl = base.slice(0, W);
  let cost = 0, dsmMWh = 0, dsmCost = 0, reA = 0, reU = 0, cur = 0, thr = 0, buy = 0, sell = 0, peak = 0, rs = 0, un = 0;
  const bess = P.bess.filter((b) => b.enabled);
  bl.forEach((b, t) => {
    const dam = view.damFc[t] ?? 5, rtm = view.rtmFc[t] ?? 5;
    cost += blockCostK({ by: b.by, thermalOn: b.thermalOn, damBuy: b.damBuy, damSell: b.damSell, rtmBuy: b.rtmBuy, rtmSell: b.rtmSell, grid: b.grid }, P, S, dam, rtm);
    const reNow = sumv(view.solar[t]) + sumv(view.wind[t]);
    const dev = (sumv(view.demand[t]) - b.demand) - (reNow - (b.solar + b.wind)); // MW: + = more residual demand than scheduled
    dsmMWh += Math.abs(dev) * DT;
    const sched = b.damBuy - b.damSell + b.rtmBuy - b.rtmSell + b.grid;
    dsmCost += dsmSettle(dev, sched, freq, rtm, S).cost;
    const usedSched = [...P.solar, ...P.wind].reduce((x, f) => x + (b.by[f.id] ?? 0), 0);
    reA += reNow * DT; reU += Math.min(reNow, usedSched) * DT;
    cur += (b.curtailSolar + b.curtailWind) * DT;
    for (const k of bess) thr += Math.abs(b.by[k.id] ?? 0) * DT;
    buy += (b.damBuy + b.rtmBuy) * DT; sell += (b.damSell + b.rtmSell) * DT; peak = Math.max(peak, b.damBuy + b.rtmBuy);
    // reserve: ramp headroom of running units + battery power not used, against the forecast-error requirement
    const sigma = view.sigmaUp[t] ?? 0;
    const req = Math.max(S.weights.reserveStrictness * Math.max(0.03 * sumv(view.demand[t]), sigma), 0);
    const th = P.thermal.filter((u) => u.enabled && b.thermalOn[u.id]).reduce((a, u) => a + Math.min((u.rampPctPerMin / 100) * u.capacityMW * 15, Math.max(0, (view.thermalCap[t][u.id] ?? 0) - (b.by[u.id] ?? 0))), 0);
    const bs = bess.reduce((a, k) => a + Math.max(0, (view.bessPower[t][k.id] ?? 0) - Math.max(0, b.by[k.id] ?? 0)), 0);
    rs += Math.max(0, req - th - bs) * DT;
  });
  const end = bl[bl.length - 1];
  const E = bess.reduce((a, b) => a + b.energyMWh, 0);
  const soc = end ? Object.values(end.socByBess).reduce((a, b) => a + b, 0) : 0;
  const floor = bess.reduce((a, b) => a + ((b.socMinPct + b.gridSupportReservePct) / 100) * b.energyMWh, 0);
  return {
    label, windowBlocks: bl.length, costK: cost + dsmCost, unservedMWh: un, reserveShortMWh: rs, dsmExposureMWh: dsmMWh, dsmCostK: dsmCost,
    reUtilPct: reA > 0 ? Math.min(100, (reU / reA) * 100) : 100, curtailMWh: cur, bessThroughputMWh: thr, socEndPct: E > 0 ? (soc / E) * 100 : 0, marketBuyMWh: buy, marketSellMWh: sell, peakBuyMW: peak,
    flexibilityMWh: Math.max(0, soc - floor), notes: ['the day-ahead schedule is kept as is; forecast differences settle as deviation (DSM)'],
  };
}

export interface ClusterDelta { metric: string; selected: number; reference: number; delta: number; unit: string; better: boolean | null }
export function compare(sel: ClusterMetrics, ref: ClusterMetrics): ClusterDelta[] {
  const row = (metric: string, a: number, b: number, unit: string, lowerIsBetter: boolean | null): ClusterDelta => ({ metric, selected: a, reference: b, delta: a - b, unit, better: lowerIsBetter == null || Math.abs(a - b) < 1e-6 ? null : lowerIsBetter ? a < b : a > b });
  return [
    row('Total cost incl. expected deviation cost', sel.costK, ref.costK, '₹ thousand', true),
    row('Unserved energy', sel.unservedMWh, ref.unservedMWh, 'MWh', true),
    row('Upward reserve shortfall', sel.reserveShortMWh, ref.reserveShortMWh, 'MW·h', true),
    row('Deviation (DSM) exposure', sel.dsmExposureMWh, ref.dsmExposureMWh, 'MWh', true),
    row('Renewable utilisation', sel.reUtilPct, ref.reUtilPct, '%', false),
    row('Renewable curtailment', sel.curtailMWh, ref.curtailMWh, 'MWh', true),
    row('Battery throughput (wear)', sel.bessThroughputMWh, ref.bessThroughputMWh, 'MWh', true),
    row('Battery SOC at end of window', sel.socEndPct, ref.socEndPct, '%', null),
    row('Exchange purchases', sel.marketBuyMWh, ref.marketBuyMWh, 'MWh', null),
    row('Future flexibility', sel.flexibilityMWh, ref.flexibilityMWh, 'MWh', false),
  ];
}
