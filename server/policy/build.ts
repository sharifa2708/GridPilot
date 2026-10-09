// Turns a Situation + the policy file into the numeric inputs of the optimiser: the stage order, the stage tolerances,
// and, block by block, how much reserve is required and which actions are permitted.
import type { PolicyInput } from '../opt/model.js';
import { OBJECTIVE_GROUP, RANKABLE, type DetectedEvent, type Group, type PolicyConfig, type Situation } from './types.js';

export function buildPolicyInput(cfg: PolicyConfig, sit: Situation, H: number, mode: 'DAM' | 'INTRADAY'): PolicyInput {
  // stage order: the ranked objectives of the combined profile; grid security is a hard constraint, so its (slack) stage always
  // comes first even when the profile does not rank it; objectives no active profile mentions follow in the default order
  const ranked: Group[] = sit.objectives.map((o) => OBJECTIVE_GROUP[o]);
  const order: Group[] = ['security'];
  for (const g of ranked) if (!order.includes(g)) order.push(g);
  for (const g of RANKABLE) if (!order.includes(g)) order.push(g);
  order.push('tie'); // always last: among equally good solutions prefer the smooth, stable one

  const byKind = new Map<string, DetectedEvent>(sit.events.filter((e) => e.active).map((e) => [e.kind, e]));
  const pb = {
    reserveUpMult: new Array(H).fill(1), reserveDnMult: new Array(H).fill(1),
    allowSales: new Array(H).fill(true), allowBuy: new Array(H).fill(true),
    allowDR: new Array(H).fill(false), allowShiftOut: new Array(H).fill(false), allowShiftIn: new Array(H).fill(false),
    socLift: new Array(H).fill(0),
  } as PolicyInput['perBlock'];
  const dr = cfg.actions.demandResponse, ls = cfg.actions.loadShift;
  for (let t = 0; t < H; t++) {
    const kinds = sit.perBlock[t]?.kinds ?? [];
    for (const k of kinds) {
      const rule = cfg.events[k];
      const e = byKind.get(k)!;
      if (k === 'frequency_deterioration') {
        const dir = (e as any).meta?.dir ?? (e.evidence.includes('over-frequency') ? 'high' : 'low');
        if (dir === 'low') pb.reserveUpMult[t] = Math.max(pb.reserveUpMult[t], rule.reserveUpMultiplierLow ?? 1);
        else { pb.reserveDnMult[t] = Math.max(pb.reserveDnMult[t], rule.reserveDownMultiplierHigh ?? 1); if (rule.blockPurchasesWhenHigh) pb.allowBuy[t] = false; }
      }
      if (rule.restrictMerchantSales) pb.allowSales[t] = false;
      if (rule.enablesDemandResponse) pb.allowDR[t] = true;
      if (rule.enablesLoadShift) { pb.allowShiftOut[t] = true; pb.allowShiftIn[t] = true; }
    }
    if (!dr.enabled) pb.allowDR[t] = false;
    else if (!dr.requiresActiveEvent) pb.allowDR[t] = true;
    if (!ls.enabled) { pb.allowShiftOut[t] = false; pb.allowShiftIn[t] = false; }
    else if (!ls.requiresActiveEvent) { pb.allowShiftOut[t] = true; pb.allowShiftIn[t] = true; }
  }
  // pre-position the battery in the blocks before an event whose rule asks for it
  for (const e of sit.events.filter((x) => x.active)) {
    const pct = cfg.events[e.kind].prepositionBessPct;
    if (pct > 0 && e.startBlock > 0) for (let t = Math.max(0, e.startBlock - 12); t < e.startBlock && t < H; t++) pb.socLift[t] = Math.max(pb.socLift[t], pct);
  }
  return {
    order,
    tol: cfg.stages.tolerance, gap: cfg.stages.mipGap,
    timeSec: mode === 'DAM' ? cfg.stages.totalSolveSec.dam : cfg.stages.totalSolveSec.intraday,
    stageMinSec: cfg.stages.stageMinSec, costStageShare: cfg.stages.costStageShare, critW: cfg.stages.criticalLoadWeight, skipAtBound: cfg.stages.skipStagesAtLowerBound,
    reserve: cfg.reserve, perBlock: pb,
    assumptions: { lastResortDR: dr.useOnlyWhenNeeded, lastResortShift: ls.useOnlyWhenNeeded, drDisruptionRs: dr.disruptionRsPerKwh, shiftOutRs: ls.shiftOutRsPerKwh, shiftInRs: ls.shiftInRsPerKwh, drExcludeCritical: dr.excludeCritical, bessExclusive: cfg.actions.bessExclusive },
  };
}
