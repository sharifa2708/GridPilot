// Day-ahead (DAM) and real-time (RTM) planning workbench: optimise under what-if overrides, then stress the schedule
// against Monte-Carlo forecast errors using the same real-time execution + DSM logic the live engine uses.
import type { Flows, Settings } from './types.js';
import type { Engine, Overrides } from './engine.js';
import { BLOCKS, DT, ar1, blockOf, clamp, dateStr, dayOf, gauss, hashStr, hhmm, mulberry32, round, slotOf, sum } from './util.js';
import { solvePlan } from './opt/optimizer.js';
import { getPolicy } from './policy/config.js';
import { GROUP_OBJECTIVE, TIE_LABEL } from './policy/types.js';
import type { PlanOutput } from './opt/model.js';
import { accountFlows, cloneState, executeBlock, initFleetState, type FleetState } from './physics.js';
import type { Truth } from './twin.js';

export interface PlanRequest { kind: 'DAM' | 'RTM'; day?: number; overrides?: Overrides; mc?: number; baseline?: boolean }

interface Draft { id: string; kind: 'DAM' | 'RTM'; day: number; slot0: number; out: PlanOutput; overrides: Overrides; created: number }
const drafts = new Map<string, Draft>();
let draftSeq = 1;

const pct = (a: number[], q: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const dist = (a: number[]) => ({ p10: pct(a, 0.1), p50: pct(a, 0.5), p90: pct(a, 0.9), mean: a.length ? sum(a) / a.length : 0, min: Math.min(...a), max: Math.max(...a) });

function series(e: Engine, out: PlanOutput, view: any, st0: FleetState, S: Settings) {
  let st = cloneState(st0);
  const rows: any[] = [];
  const kpi = { costK: 0, servedMWh: 0, reAvail: 0, reUsed: 0, curtailMWh: 0, emissions: 0, peakBuy: 0, buyMWh: 0, sellMWh: 0, dis: 0, startK: 0, unserved: 0, thermalMWh: 0, drMWh: 0 };
  out.blocks.forEach((pb, i) => {
    const fl = e.planFlows(pb);
    const px = { dam: view.damFc[i], rtm: view.rtmFc[i] };
    const acc = accountFlows(fl, e.P, S, px, st, Object.entries(pb.started).filter(([, v]) => v).map(([k]) => k), 0);
    st = acc.st;
    const reAvail = sum(Object.values(view.solar[i]) as number[]) + sum(Object.values(view.wind[i]) as number[]);
    kpi.costK += acc.cost.total; kpi.servedMWh += fl.load * DT; kpi.reAvail += reAvail * DT; kpi.reUsed += (fl.solar + fl.wind) * DT;
    kpi.curtailMWh += (fl.curtailSolar + fl.curtailWind) * DT; kpi.emissions += acc.emissions; kpi.peakBuy = Math.max(kpi.peakBuy, fl.damBuy + fl.rtmBuy);
    kpi.buyMWh += (fl.damBuy + fl.rtmBuy) * DT; kpi.sellMWh += (fl.damSell + fl.rtmSell) * DT; kpi.dis += fl.bessDis * DT; kpi.startK += acc.cost.startup;
    kpi.unserved += fl.unserved * DT; kpi.thermalMWh += fl.thermal * DT; kpi.drMWh += fl.dr * DT;
    rows.push({
      slot: pb.slot, b: blockOf(pb.slot), time: hhmm(blockOf(pb.slot)),
      demand: fl.demand, solar: fl.solar, wind: fl.wind, thermal: fl.thermal, bessNet: fl.bessDis - fl.bessCh, damBuy: fl.damBuy, damSell: fl.damSell,
      rtmBuy: fl.rtmBuy, rtmSell: fl.rtmSell, grid: fl.grid, curtail: fl.curtailSolar + fl.curtailWind, dr: fl.dr, shift: fl.shiftNet, unserved: fl.unserved,
      soc: (pb.socMWh / Math.max(1, e.totalBessMWh())) * 100, damPrice: px.dam, rtmPrice: px.rtm, smc: pb.smc, socValue: pb.socValue,
      cpu: acc.cpu, reserveUpReq: pb.reserveUpReq, reserveUpAvail: pb.reserveUpAvail, solarAvail: sum(Object.values(view.solar[i]) as number[]), windAvail: sum(Object.values(view.wind[i]) as number[]),
      thermalOn: Object.values(pb.thermalOn).filter(Boolean).length,
    });
  });
  const totals = {
    totalCostK: kpi.costK, energyMWh: kpi.servedMWh, cpu: kpi.servedMWh > 0 ? kpi.costK / kpi.servedMWh : 0,
    reUtilPct: kpi.reAvail > 0 ? (kpi.reUsed / kpi.reAvail) * 100 : 100, curtailMWh: kpi.curtailMWh, emissionsT: kpi.emissions,
    peakBuyMW: kpi.peakBuy, buyMWh: kpi.buyMWh, sellMWh: kpi.sellMWh, bessCycles: kpi.dis / Math.max(1, e.totalBessMWh()), startupK: kpi.startK,
    unservedMWh: kpi.unserved, thermalMWh: kpi.thermalMWh, drMWh: kpi.drMWh,
  };
  return { rows, totals };
}

function monteCarlo(e: Engine, out: PlanOutput, view: any, st0: FleetState, S: Settings, n: number, seedKey: string) {
  const costs: number[] = [], cpus: number[] = [], dsms: number[] = [], curt: number[] = [], reu: number[] = [], uns: number[] = [], minSoc: number[] = [];
  const devByBlock: number[][] = Array.from({ length: BLOCKS }, () => []);
  const cumCost: number[][] = Array.from({ length: BLOCKS }, () => []);
  const H = out.blocks.length;
  for (let i = 0; i < n; i++) {
    const rng = mulberry32(hashStr(`${seedKey}-${i}`));
    const bS = 1 + (S.reserve.solarErrPct / 100) * 0.5 * gauss(rng), bW = 1 + (S.reserve.windErrPct / 100) * 0.6 * gauss(rng), bL = 1 + (S.reserve.loadErrPct / 100) * 0.8 * gauss(rng);
    const nS = ar1(`${seedKey}-s${i}`, H, 0.85), nW = ar1(`${seedKey}-w${i}`, H, 0.93), nL = ar1(`${seedKey}-l${i}`, H, 0.9), nP = ar1(`${seedKey}-p${i}`, H, 0.8), nF = ar1(`${seedKey}-f${i}`, H, 0.88);
    let st = cloneState(st0);
    let c = 0, served = 0, dsm = 0, cu = 0, reA = 0, reU = 0, un = 0, ms = 100;
    for (let t = 0; t < H; t++) {
      const pb = out.blocks[t];
      const fl = e.planFlows(pb);
      const b = blockOf(pb.slot);
      const solar: Record<string, number> = {}, wind: Record<string, number> = {}, demand: Record<string, number> = {};
      for (const [k, v] of Object.entries(view.solar[t]) as [string, number][]) solar[k] = v < 1 ? v : clamp(v * clamp(bS * (1 + (S.reserve.solarErrPct / 100) * 0.7 * nS[t]), 0.15, 1.25), 0, v * 1.25);
      for (const [k, v] of Object.entries(view.wind[t]) as [string, number][]) wind[k] = clamp(v * clamp(bW * (1 + (S.reserve.windErrPct / 100) * 0.8 * nW[t]), 0.1, 1.8), 0, e.P.wind.find((w) => w.id === k)?.capacityMW ?? 1e9);
      for (const [k, v] of Object.entries(view.demand[t]) as [string, number][]) demand[k] = v * bL * (1 + 0.012 * nL[t]);
      const dam = clamp(view.damFc[t] * (1 + 0.06 * nP[t]), 1, S.market.priceCap);
      const rtm = clamp(dam * (1 + 0.08 * nP[(t + 7) % H]), 1, S.market.priceCap);
      const truth: Truth = { solar, wind, demand, damPrice: dam, rtmPrice: rtm, freq: clamp(e.twin.freqBase(b) + 0.03 * nF[t], 49.7, 50.3), thermalCap: view.thermalCap[t], bessPower: view.bessPower[t], ttc: view.ttc[t], stormRisk: 0 };
      const on: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(pb.thermalOn)) on[k] = v;
      const res = executeBlock({ slot: pb.slot, plan: fl, planOn: on, truth, st, P: e.P, S, freq: truth.freq, px: { dam, rtm } });
      const acc = accountFlows(res.act, e.P, S, { dam, rtm }, res.st, res.started, res.dsm.cost);
      st = acc.st; c += acc.cost.total; served += res.act.load * DT; dsm += res.dsm.cost; cu += (res.act.curtailSolar + res.act.curtailWind) * DT;
      reA += (sum(Object.values(solar)) + sum(Object.values(wind))) * DT; reU += (res.act.solar + res.act.wind) * DT; un += res.act.unserved * DT;
      ms = Math.min(ms, (sum(Object.values(st.socMWh)) / Math.max(1, e.totalBessMWh())) * 100);
      devByBlock[t].push(res.dsm.mw); cumCost[t].push(c);
    }
    costs.push(c); cpus.push(served > 0 ? c / served : 0); dsms.push(dsm); curt.push(cu); reu.push(reA > 0 ? (reU / reA) * 100 : 100); uns.push(un); minSoc.push(ms);
  }
  return {
    n, cost: dist(costs), cpu: dist(cpus), dsm: dist(dsms), curtail: dist(curt), reUtil: dist(reu), unserved: dist(uns), minSoc: dist(minSoc),
    costSamples: [...costs].sort((a, b) => a - b).map((x) => round(x, 1)),
    devBand: devByBlock.map((a, t) => ({ b: blockOf(out.blocks[t]?.slot ?? t), p10: pct(a, 0.1), p50: pct(a, 0.5), p90: pct(a, 0.9) })).slice(0, H),
    cumCostBand: cumCost.map((a, t) => ({ p10: pct(a, 0.1), p50: pct(a, 0.5), p90: pct(a, 0.9), t })).slice(0, H),
  };
}

async function solveOne(e: Engine, req: PlanRequest, overrides: Overrides | undefined) {
  const S: Settings = overrides?.carbonPrice != null ? { ...e.S, weights: { ...e.S.weights, carbonPrice: overrides.carbonPrice } } : e.S;
  let slot0: number, day: number, st: FleetState, mode: 'DAM' | 'INTRADAY';
  if (req.kind === 'DAM') {
    day = req.day ?? dayOf(e.cursor) + 1;
    slot0 = slotOf(day, 0);
    mode = 'DAM';
    st = day === dayOf(e.cursor) + 1 ? e.projectedTomorrow() : e.projectedState(slot0).fleet;
  } else {
    slot0 = e.cursor + 1; day = dayOf(slot0); mode = 'INTRADAY';
    st = cloneState(e.fleet);
  }
  const { input, view, situation } = e.buildInput(mode, slot0, BLOCKS, { overrides, settings: S, fleet: st, stateless: true });
  const out = await solvePlan(input);
  return { out, input, view, st, S, day, slot0, situation };
}

export async function runPlanning(e: Engine, req: PlanRequest) {
  const ov = req.overrides && Object.keys(req.overrides).length ? req.overrides : undefined;
  const main = await solveOne(e, req, ov);
  if (!main.out.ok) return { ok: false, error: `Optimiser returned ${main.out.status}` };
  const s = series(e, main.out, main.view, main.st, main.S);
  const mc = monteCarlo(e, main.out, main.view, main.st, main.S, clamp(req.mc ?? 30, 0, 60), `${req.kind}-${main.day}-${JSON.stringify(ov ?? {})}`);
  let baseline: any = null;
  if (ov && req.baseline !== false) {
    const b = await solveOne(e, req, undefined);
    if (b.out.ok) baseline = { totals: series(e, b.out, b.view, b.st, b.S).totals, objective: b.out.objective };
  }
  const id = `d${draftSeq++}`;
  drafts.set(id, { id, kind: req.kind, day: main.day, slot0: main.slot0, out: main.out, overrides: ov ?? {}, created: Date.now() });
  if (drafts.size > 12) drafts.delete(drafts.keys().next().value as string);
  // bid table: contiguous summary of MW bought/sold per block
  const committed = e.damPos.get(main.day);
  return {
    ok: true, draftId: id, kind: req.kind, day: main.day, date: dateStr(main.day), slot0: main.slot0,
    solve: { ms: main.out.solveMs, status: main.out.status, mip: main.out.mip, objectiveK: main.out.objective },
    rows: s.rows, totals: s.totals, baseline, mc: mc.n ? mc : null,
    committed: committed ? { slot: committed.committedSlot, source: committed.source } : null,
    rtmLeadBlocks: e.S.market.rtmLeadBlocks,
    overrides: ov ?? {},
    policy: { profile: main.situation.profileId, label: main.situation.label, objectives: (main.input.policy?.order ?? []).filter((g) => g !== 'tie').map((g) => getPolicy().objectives[GROUP_OBJECTIVE[g as Exclude<typeof g, 'tie'>]]), events: main.situation.events.filter((e) => e.active).map((e) => ({ kind: e.kind, severity: e.severity, evidence: e.evidence })), interactions: main.situation.interactions, rationale: main.situation.rationale },
    demandFlex: main.out.demandFlex ?? null,
    stages: (main.out.stages ?? []).map((st) => ({ ...st, objective: st.group === 'tie' ? TIE_LABEL : getPolicy().objectives[GROUP_OBJECTIVE[st.group]] })), binding: main.out.binding ?? [], feasibility: main.out.feasibility, conflicts: main.out.conflicts ?? [], costBreakdown: main.out.costBreakdown ?? null, approximate: !!main.out.approximate,
  };
}

export function commitDraft(e: Engine, id: string): { ok: boolean; message: string } {
  const d = drafts.get(id);
  if (!d) return { ok: false, message: 'Draft expired – run the optimisation again.' };
  if (d.kind === 'DAM') {
    // bids for a delivery day close at 10:00 (block 40) on the day before; after that the day-ahead position is fixed
    if (e.cursor >= (d.day - 1) * BLOCKS + 40) return { ok: false, message: `Day-ahead bidding for ${dateStr(d.day)} closed at 10:00 on ${dateStr(d.day - 1)}; the clearing prices are published and the position can no longer be changed.` };
    const buy = d.out.blocks.map((b) => b.flows.damBuy), sell = d.out.blocks.map((b) => b.flows.damSell);
    e.damPos.set(d.day, { buy, sell, committedSlot: e.cursor, objective: d.out.objective, source: 'operator (Planning workbench)' });
    const rows = e.ensureDay(d.day);
    d.out.blocks.forEach((pb, i) => { const r = rows[i]; if (r.slot > e.cursor && r.status === 'future') { r.plan = e.planFlows(pb); r.damPrice = e.twin.damTruth(r.slot); e.fillPlanMeta(r, pb); } });
    e.addLog('action', 'dam', `Operator committed DAM schedule for ${dateStr(d.day)}: buy ${round(sum(buy) * DT, 0)} MWh / sell ${round(sum(sell) * DT, 0)} MWh.`);
    void e.replan('DAM commit');
    e.scheduleSave(); e.broadcast();
    return { ok: true, message: `DAM schedule for ${dateStr(d.day)} committed.` };
  }
  const lead = e.S.market.rtmLeadBlocks;
  let n = 0;
  d.out.blocks.forEach((pb, i) => {
    if (i < lead) return; // inside gate closure
    if (pb.flows.rtmBuy > 0.5 || pb.flows.rtmSell > 0.5) { e.rtmCommit.set(pb.slot, { buy: pb.flows.rtmBuy, sell: pb.flows.rtmSell }); n++; }
  });
  e.addLog('action', 'rtm', `Operator pre-committed RTM bids for ${n} blocks beyond gate closure.`);
  void e.replan('RTM commit');
  e.scheduleSave(); e.broadcast();
  return { ok: true, message: `RTM bids placed for ${n} blocks.` };
}

export { initFleetState };
export type { Flows };
