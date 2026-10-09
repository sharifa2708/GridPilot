// The agent's "decide & explain" layer. The optimiser decides; this module turns a plan into structured actions,
// states which optimality criterion drove each one, quantifies the rejected alternative, and raises alerts.
// Every sentence is generated from the plan's numbers (shadow prices, SOC, prices) so nothing is hallucinated.
import { ACTION_BUCKET, type AgentAction, type Alert, Criterion, MaintenanceItem, Portfolio, Settings } from './types.js';
import type { PlanBlock } from './opt/model.js';
import type { AgentView } from './twin.js';
import type { ObjectiveId, Situation } from './policy/types.js';
import type { StageResult } from './opt/model.js';
import { BLOCKS, DT, blockOf, hhmm, slotLabel } from './util.js';

/** The schedule that was committed for a block (day-ahead plan). The agent only reports where the live plan departs from it. */
export interface BaselineBlock {
  slot: number;
  by: Record<string, number>; // per-asset MW (thermal, BESS net, curtailment, DR, shift)
  thermalOn: Record<string, boolean>;
  socByBess: Record<string, number>; // MWh at the end of the block
  damBuy: number; damSell: number; rtmBuy: number; rtmSell: number; grid: number;
  curtailSolar: number; curtailWind: number; dr: number; shiftNet: number;
  demand: number; solar: number; wind: number; // forecasts the schedule was built on (MW)
}

export interface AgentCtx {
  recentDsmCostK?: number; // deviation charge over the last hour (4 blocks), ₹'000
  thermalHold?: Record<string, number>; // blocks a unit must stay in its present on/off state (minimum up / down time)
  cursor: number; // current (executing) slot
  P: Portfolio;
  S: Settings;
  plan: PlanBlock[]; // starts at cursor+1
  view: AgentView; // same alignment as plan
  prev: { thermalP: Record<string, number>; socMWh: Record<string, number> };
  freq: number;
  wac: number; // BESS inventory cost ₹/kWh
  today: { reUtil: number; dsmCost: number; cpu: number; cycles: number; bessCost: number; reAvail: number; reUsed: number; curtailMWh: number };
  lastBlock: { dsmMW: number; dsmBand: number; dsmRate: number; notes: string[]; ratioSolar: number; ratioWind: number; ratioLoad: number };
  rtmPrice: number[]; // forecast aligned with plan
  damPrice: number[];
  securityMode: 'normal' | 'low-freq' | 'high-freq';
  eventsActive: string[];
  situation: Situation | null; // detected situation and the ranked objectives it implies
  stages: StageResult[]; // result of every lexicographic stage of the run
  objectiveNames: Record<ObjectiveId, string>;
  baseline: BaselineBlock | null; // committed schedule for the next block
  custToday: Record<string, { shiftMWh: number; drMWh: number }>; // energy each customer has already deferred (-) / pulled forward (+) and cut today
  underperforming: { id: string; name: string; ratio: number; mw: number }[]; // farms producing far below forecast while their peers are on plan
  nextId: () => string;
}

const f1 = (x: number) => x.toFixed(1);
const f0 = (x: number) => x.toFixed(0);
const f2 = (x: number) => x.toFixed(2);
const rs = (x: number) => `₹${x.toFixed(2)}`;

function confidence(lead: number, storm: number, S: Settings): number {
  const base = 0.96 - 0.008 * Math.min(lead, 24) - (storm > 0.5 ? 0.12 : 0) - (S.reserve.solarErrPct > 15 ? 0.03 : 0);
  return Math.max(0.5, Math.min(0.98, base));
}

export function buildActions(c: AgentCtx): AgentAction[] {
  // Actions are CHANGES to the committed schedule. If the live plan matches it, there is nothing to report.
  const out: AgentAction[] = [];
  const { P, S } = c;
  const b0 = c.plan[0];
  const base = c.baseline;
  if (!b0 || !base) return out;
  const slot = b0.slot;
  const fl = b0.flows;
  const px = c.damPrice[0], rtm = c.rtmPrice[0];
  const smc = b0.smc ?? Math.max(px, 4);
  const sv = b0.socValue ?? smc;
  const conf = confidence(1, c.view.stormRisk[0], S);
  const topObj = c.situation?.objectives[0];
  const topRank = topObj === 'security' ? 1 : topObj === 'reliability' ? 2 : topObj === 'reserve' ? 3 : topObj === 'imbalance' ? 4 : 9;
  const mk = (a: Omit<AgentAction, 'id' | 'slot' | 'confidence' | 'status' | 'requiresApproval' | 'reasoning' | 'alternative' | 'impactRs'> & Partial<AgentAction>): AgentAction => ({
    id: c.nextId(), slot, confidence: conf, status: 'planned', requiresApproval: false, reasoning: a.summary ?? '', alternative: '', impactRs: null,
    bucket: ACTION_BUCKET[a.type as keyof typeof ACTION_BUCKET], ...a,
    ...(topRank <= 4 && a.priority > topRank ? { criterion: `${c.objectiveNames[topObj as ObjectiveId]} is the top objective now – ${a.criterion}` } : {}),
  } as AgentAction);
  const sumv = (o: Record<string, number> | undefined) => (o ? Object.values(o).reduce((x, y) => x + y, 0) : 0);
  const sg = (x: number) => (x >= 0 ? '+' : '−') + f0(Math.abs(x));

  // ---- what moved since the schedule was made: demand, solar, wind -> residual (net) demand
  const dD = sumv(c.view.demand[0]) - base.demand, dS = sumv(c.view.solar[0]) - base.solar, dW = sumv(c.view.wind[0]) - base.wind;
  const dNet = dD - dS - dW; // + = more residual demand than scheduled
  const parts: string[] = [];
  if (Math.abs(dD) >= 10) parts.push(`demand ${sg(dD)} MW`);
  if (Math.abs(dS) >= 10) parts.push(`solar ${sg(dS)} MW`);
  if (Math.abs(dW) >= 10) parts.push(`wind ${sg(dW)} MW`);
  const cause = Math.abs(dNet) >= 10 ? `residual demand is ${f0(Math.abs(dNet))} MW ${dNet > 0 ? 'higher' : 'lower'} than scheduled (${parts.join(', ')})` : '';

  const Cause = cause ? cause[0].toUpperCase() + cause.slice(1) : '';
  const fmtShift = (v: number) => (v < -0.5 ? `${f0(-v)} MW deferred` : v > 0.5 ? `${f0(v)} MW pulled forward` : 'none');
  const buyAll = rtm + S.market.exchangeFee + S.market.buyAdder;
  const eta = P.bess.length ? P.bess.reduce((a, b) => a + b.etaCharge * b.etaDischarge, 0) / P.bess.length : 0.88;
  const deg = P.bess.length ? P.bess.reduce((a, b) => a + b.degradationCost, 0) / P.bess.length * S.weights.degradationScale : 0.8;
  const dischCost = c.wac / (eta > 0 ? Math.sqrt(eta) : 0.94) + deg;
  const netMkt = (x: { damBuy: number; damSell: number; rtmBuy: number; rtmSell: number; grid: number }) => x.damBuy + x.rtmBuy + x.grid - x.damSell - x.rtmSell;
  const dMkt = netMkt(fl) - netMkt(base); // + = buying more than scheduled

  // ---------------- thermal
  for (const u of P.thermal.filter((x) => x.enabled)) {
    const p = fl.by[u.id] ?? 0, pb = base.by[u.id] ?? 0;
    const on = b0.thermalOn[u.id], onB = base.thermalOn[u.id] ?? pb > 1;
    const d = p - pb;
    // a tripped, derated or maintenance-limited unit is an event, not a decision: the agent reacts by re-dispatching the others
    const unavailable = (c.view.thermalCap[0]?.[u.id] ?? u.capacityMW) < (u.minLoadPct / 100) * u.capacityMW - 1e-6;
    if (unavailable) continue;
    if (on && !onB) {
      out.push(mk({ type: 'thermal_start', title: `Start ${u.name} at ${f0(p)} MW`, target: u.id, mw: p, priority: 5, criterion: 'Minimum variable cost (unit commitment)',
        summary: `Not in the schedule. ${Cause ? Cause + ', and' : 'It is now cheaper:'} running it costs ${rs(u.varCost)}/kWh vs ${rs(buyAll)}/kWh all-in from the market.` }));
    } else if (!on && onB && (c.thermalHold?.[u.id] ?? 0) <= 0) { // a unit kept off by its minimum down-time (after a trip) is not a stop decision
      out.push(mk({ type: 'thermal_stop', title: `Stop ${u.name} (scheduled at ${f0(pb)} MW)`, target: u.id, mw: pb, priority: 5, criterion: 'Minimum variable cost (unit commitment)',
        summary: `${Cause || 'Market and renewable energy are now cheaper'}, so the unit is not needed (${rs(u.varCost)}/kWh vs ${rs(Math.min(buyAll, smc))}/kWh).` }));
    } else if (on && Math.abs(d) >= 1) {
      const up = d > 0;
      const atMin = !up && Math.abs(p - (u.minLoadPct / 100) * u.capacityMW) < 2;
      const lostUnit = up ? P.thermal.find((x) => x.id !== u.id && (base.by[x.id] ?? 0) - (fl.by[x.id] ?? 0) >= 15) : undefined;
      out.push(mk({ type: up ? 'thermal_ramp' : 'thermal_backdown', title: `${up ? 'Ramp up' : 'Ramp down'} ${u.name}: ${f0(pb)} → ${f0(p)} MW`, target: u.id, mw: Math.abs(d), priority: up ? 5 : 6,
        criterion: up ? 'Minimum variable cost' : 'RE utilisation (thermal yields first)',
        summary: up
          ? (dNet >= 10 ? `${Cause}, so output rises to match it.` : lostUnit ? `${lostUnit.name} is producing ${f0((base.by[lostUnit.id] ?? 0) - (fl.by[lostUnit.id] ?? 0))} MW less than scheduled, so this unit picks up the difference.` : `Cheaper than the alternatives: ${rs(u.varCost)}/kWh here vs ${rs(buyAll)}/kWh all-in from the market.`)
          : `${Cause ? Cause + ', so output falls to match it' : 'Cheaper renewable and market energy is available'}${atMin ? '; the unit is now at its technical minimum' : ''}.` }));
    }
  }

  // ---------------- battery
  for (const b of P.bess.filter((x) => x.enabled)) {
    const n = fl.by[b.id] ?? 0, nb = base.by[b.id] ?? 0;
    const soc = ((b0.socByBess[b.id] ?? 0) / b.energyMWh) * 100, socB = ((base.socByBess[b.id] ?? 0) / b.energyMWh) * 100;
    if (Math.abs(n - nb) < 1 && Math.abs(soc - socB) < 1) continue;
    const short = b.name.split(' ')[0];
    const mode = n > 1 ? `discharge ${f0(n)} MW` : n < -1 ? `charge ${f0(-n)} MW` : `hold SOC at ${f0(soc)}%`;
    const was = nb > 1 ? `discharge ${f0(nb)} MW` : nb < -1 ? `charge ${f0(-nb)} MW` : 'idle';
    const dn = n - nb;
    const diff = dischCost - buyAll;
    let summary: string, priority: AgentAction['priority'] = 5, criterion = 'Minimum variable cost';
    if (dn < 0 && dMkt >= 10) {
      summary = `Keeping ${short} at ${f0(soc)}% SOC for reserve and buying ${f0(dMkt)} MW from the market instead: ${rs(buyAll)}/kWh all-in vs ${rs(dischCost)}/kWh to discharge (${diff >= 0 ? rs(diff) + ' cheaper' : rs(-diff) + ' dearer, accepted to keep the reserve'}).`;
      priority = diff >= 0 ? 5 : 3; criterion = diff >= 0 ? 'Minimum variable cost' : 'Reserve adequacy';
    } else if (dn > 0 && dMkt <= -10) {
      summary = `Discharging ${f0(dn)} MW more and buying ${f0(-dMkt)} MW less from the market: battery energy costs ${rs(dischCost)}/kWh vs ${rs(buyAll)}/kWh all-in.`;
    } else if (dn < 0) {
      const still = n > 1; // still discharging, only less than scheduled
      if (dNet < 0) summary = still ? `${Cause}, so ${short} needs to cover ${f0(-dn)} MW less than scheduled.` : n < -1 ? `${Cause}, so the surplus is stored.` : `${Cause}, so ${short} is not needed.`;
      else summary = still ? `Discharging ${f0(-dn)} MW less than scheduled keeps ${short} energy for later: stored energy is worth ${rs(sv)}/kWh against ${rs(dischCost)}/kWh to discharge now.` : `Storing energy that is worth ${rs(sv)}/kWh later vs ${rs(buyAll / eta + deg)}/kWh to store it.`;
      criterion = dNet < 0 && n < -1 ? 'RE utilisation' : 'Minimum variable cost';
    } else {
      summary = dNet > 0 ? `${Cause}, so the battery covers part of it.` : `Discharging now saves ${rs(Math.max(0, smc - dischCost))}/kWh against the marginal supply of ${rs(smc)}/kWh.`;
    }
    out.push(mk({ type: n > 1 ? 'bess_discharge' : n < -1 ? 'bess_charge' : 'bess_hold', title: `${short}: ${mode} (scheduled: ${was})`, target: b.id, mw: Math.abs(n), priority, criterion, summary,
      impactRs: null }));
  }

  // ---------------- market (exchange and contract)
  const dRtm = fl.rtmBuy - fl.rtmSell - (base.rtmBuy - base.rtmSell);
  if (Math.abs(dRtm) >= 1) {
    const buy = dRtm > 0;
    out.push(mk({ type: buy ? 'market_buy' : 'market_sell', title: `${buy ? 'Buy' : 'Sell'} ${f0(Math.abs(dRtm))} MW more on RTM at ${rs(rtm)}/kWh`, target: 'RTM', mw: Math.abs(dRtm), priority: 5, criterion: 'Minimum variable cost + DSM avoidance',
      summary: buy
        ? `${cause ? cause[0].toUpperCase() + cause.slice(1) + '. ' : ''}RTM at ${rs(buyAll)}/kWh all-in is the cheapest way to cover it.`
        : `${cause ? cause[0].toUpperCase() + cause.slice(1) + '. ' : ''}Selling own surplus at ${rs(rtm - S.market.exchangeFee - S.market.sellDeduction)}/kWh net beats curtailing it.` }));
  }
  const dGrid = fl.grid - base.grid;
  if (Math.abs(dGrid) >= 1) {
    const contract = P.interconnect.gridContractPrice;
    out.push(mk({ type: 'grid_import', title: `${dGrid > 0 ? 'Draw' : 'Cut'} contract import: ${f0(base.grid)} → ${f0(fl.grid)} MW`, target: 'GRID', mw: Math.abs(dGrid), priority: 5, criterion: 'Minimum variable cost',
      summary: dGrid > 0 ? `Contract power at ${rs(contract)}/kWh is cheaper than the market (${rs(buyAll)}/kWh all-in)${cause ? ' for the ' + cause : ''}.` : `Contract power is no longer needed${cause ? ': ' + cause : ''}.` }));
  }
  {
    // energy stored now to be sold later at a higher price
    const charging = P.bess.filter((x) => x.enabled).reduce((a, b) => a + Math.max(0, -(fl.by[b.id] ?? 0)), 0);
    const chargingB = P.bess.filter((x) => x.enabled).reduce((a, b) => a + Math.max(0, -(base.by[b.id] ?? 0)), 0);
    if (charging - chargingB >= 10 && fl.damBuy + fl.rtmBuy + fl.grid < 0.5 * charging) {
      let best = -1, bestPx = 0;
      for (let i = 1; i < Math.min(c.plan.length, 24); i++) {
        const sold = c.plan[i].flows.damSell + c.plan[i].flows.rtmSell;
        const pxI = Math.max(c.damPrice[i] ?? 0, c.rtmPrice[i] ?? 0);
        if (sold > 5 && pxI > Math.max(px, rtm) + 0.5 && pxI > bestPx) { best = i; bestPx = pxI; }
      }
      if (best > 0) {
        out.push(mk({ type: 'market_defer', title: `Delay selling ${f0(charging - chargingB)} MW until ${hhmm(blockOf(c.plan[best].slot))}`, target: 'DAM/RTM', mw: charging - chargingB, priority: 5, criterion: 'Minimum variable cost (sell later at a higher price)',
          summary: `Price now is ${rs(Math.max(px, rtm))}/kWh; the energy is stored and sold at about ${rs(bestPx)}/kWh around ${hhmm(blockOf(c.plan[best].slot))}, after ${((1 - eta) * 100).toFixed(0)}% round-trip loss and ${rs(deg)}/kWh wear.`,
          impactRs: Math.max(0, bestPx * eta - Math.max(px, rtm) - deg) * (charging - chargingB) * DT }));
      }
    }
  }

  // ---------------- renewables
  const cor = P.corridors.find((k) => (c.view.ttc[0][k.id] ?? k.ttcMW) < k.ttcMW * 0.99);
  for (const kind of ['solar', 'wind'] as const) {
    const now = P[kind].reduce((a, f) => a + (fl.by['curt:' + f.id] ?? 0), 0), was = P[kind].reduce((a, f) => a + (base.by['curt:' + f.id] ?? 0), 0);
    if (Math.abs(now - was) < 1) continue;
    const more = now > was;
    out.push(mk({ type: kind === 'solar' ? 'curtail_solar' : 'curtail_wind', title: more ? `Curtail ${kind}: ${f0(was)} → ${f0(now)} MW` : `Curtail less ${kind}: ${f0(was)} → ${f0(now)} MW`,
      target: P[kind].filter((f) => (fl.by['curt:' + f.id] ?? 0) > 0.5).map((f) => `${f.name} ${f0(fl.by['curt:' + f.id])} MW`).join(', '), mw: Math.abs(now - was), priority: more && cor ? 1 : 6,
      requiresApproval: more && S.autonomy === 'supervised' && now > 40,
      criterion: more && cor ? 'Grid security (corridor limit)' : 'RE utilisation',
      summary: more
        ? (cor ? `Corridor ${cor.id} is limited to ${f0(c.view.ttc[0][cor.id])} MW, so the evacuation has to be cut.` : `${cause ? cause[0].toUpperCase() + cause.slice(1) + '. ' : ''}Thermal is at its minimum and the battery, export and flexible load are full, so this is the last resort.`)
        : `More of the ${kind} output can now be used${cause ? ': ' + cause : ''}.` }));
  }

  // ---------------- demand management: say WHICH customers, and why them
  const custs = P.customers.filter((cu) => cu.enabled);
  const dem = (cu: { id: string }) => c.view.demand[0][cu.id] ?? 0;
  const own = (id: string) => c.custToday[id] ?? { shiftMWh: 0, drMWh: 0 };
  const critLabel = (k: string) => (k === 'critical' ? 'critical load' : k === 'essential' ? 'essential load' : 'flexible load');
  const notUsed = (used: Set<string>, canFlex: (cu: (typeof custs)[number]) => boolean) => {
    const idle = custs.filter((cu) => canFlex(cu) && !used.has(cu.id)).map((cu) => cu.name);
    const fixed = custs.filter((cu) => !canFlex(cu)).map((cu) => cu.name);
    const lines: string[] = [];
    if (idle.length) lines.push(`Available but not needed: ${idle.join(', ')}.`);
    if (fixed.length) lines.push(`Cannot flex (critical or no flexibility): ${fixed.join(', ')}.`);
    return lines;
  };
  // ---- is every cheaper, higher-priority lever already used up? (demand management is the last resort)
  const exhausted: string[] = [];
  {
    const thCap = P.thermal.filter((u) => u.enabled).reduce((a2, u) => a2 + (c.view.thermalCap[0][u.id] ?? 0), 0);
    if (thCap > 0 && fl.thermal >= thCap - 5) exhausted.push(`thermal is at its maximum (${f0(fl.thermal)} of ${f0(thCap)} MW)`);
    const bessAll = P.bess.filter((x) => x.enabled);
    const atLimit = bessAll.length > 0 && bessAll.every((b) => {
      const pav = c.view.bessPower[0][b.id] ?? 0, n2 = fl.by[b.id] ?? 0;
      const socP = ((b0.socByBess[b.id] ?? 0) / b.energyMWh) * 100;
      return n2 >= 0.9 * pav || socP <= b.socMinPct + b.gridSupportReservePct + 3;
    });
    if (atLimit) exhausted.push('the battery is at its power or reserve-charge limit');
    if (fl.damBuy + fl.rtmBuy >= S.market.maxBuyMW - 5) exhausted.push(`exchange purchases are at the ${f0(S.market.maxBuyMW)} MW limit`);
    if (fl.grid >= P.interconnect.gridContractLimitMW - 5) exhausted.push('contract import is at its limit');
    if (fl.damBuy + fl.rtmBuy + fl.grid >= P.interconnect.importLimitMW - 5) exhausted.push('total imports are at the connection limit');
  }
  const lastResort = exhausted.length ? `Used only after cheaper options ran out: ${exhausted.join('; ')}.` : 'Price-driven, not a shortage: the saving is larger than the cost of disrupting customers.';
  const dDr = fl.dr - base.dr;
  if (dDr >= 1) {
    const who = custs.filter((cu) => (fl.by['dr:' + cu.id] ?? 0) > 0.5);
    const unitCost = (cu: (typeof custs)[number]) => Math.max(cu.tariff, 4) + cu.drIncentive + 6;
    const tot = who.reduce((a2, cu) => a2 + (fl.by['dr:' + cu.id] ?? 0), 0);
    const cost = who.length ? who.reduce((a2, cu) => a2 + unitCost(cu) * (fl.by['dr:' + cu.id] ?? 0), 0) / Math.max(1, tot) : 6.5;
    const detail = who.map((cu) => {
      const v = fl.by['dr:' + cu.id] ?? 0, cap = (cu.drFlexPct / 100) * dem(cu);
      return `${cu.name}: cut ${f0(v)} MW. ${critLabel(cu.criticality)}, ${cu.drFlexPct}% of its ${f0(dem(cu))} MW can be cut (${f0(cap)} MW)${v >= cap - 0.5 ? ', now at its limit' : `, ${f0(cap - v)} MW left`}${own(cu.id).drMWh > 0.05 ? `; already cut ${f1(own(cu.id).drMWh)} MWh today` : ''}; ${rs(unitCost(cu))}/kWh to cut.`;
    });
    detail.push(...notUsed(new Set(who.map((cu) => cu.id)), (cu) => cu.drFlexPct > 0 && cu.criticality !== 'critical'));
    out.push(mk({ type: 'dr', title: `Cut flexible load: ${f0(base.dr)} → ${f0(fl.dr)} MW`, target: who.map((cu) => cu.name).join(', '), mw: dDr, priority: 3, requiresApproval: S.autonomy === 'supervised',
      criterion: 'Reserve adequacy / reliability',
      summary: (Math.max(smc, buyAll) > S.market.priceCap * 2
        ? `Supply cannot cover demand${cause ? ': ' + cause : ''}, so ${f0(fl.dr)} MW of flexible load is cut (about ${rs(cost)}/kWh to the customers).`
        : `Cutting ${f0(fl.dr)} MW at about ${rs(cost)}/kWh is cheaper than supplying it at ${rs(Math.max(smc, buyAll))}/kWh${cause ? ' (' + cause + ')' : ''}.`) + ` ${lastResort} The most flexible, least critical customers go first; critical loads are not cut by demand response.`, detail }));
  }
  // worst case: what the plan still cannot supply after every step is disrupted across all customers
  if (fl.unserved >= 1) {
    const served = custs.map((cu) => ({ cu, mw: Math.max(0, dem(cu) - (fl.by['dr:' + cu.id] ?? 0)) }));
    const tot = served.reduce((a2, x) => a2 + x.mw, 0) || 1;
    const detail = served.filter((x) => x.mw > 0.5).map((x) => `${x.cu.name}: ${f0((x.mw / tot) * fl.unserved)} MW disrupted (${critLabel(x.cu.criticality)}).`);
    out.push(mk({ type: 'load_disrupt', title: `Supply disrupted at all customers: ${f0(fl.unserved)} MW`, target: 'all customers', mw: fl.unserved, priority: 1, criterion: 'Grid security',
      summary: `Even with thermal, contract import, market purchases, demand response and the battery used, ${f0(fl.unserved)} MW cannot be supplied. To keep the grid in balance, supply is disrupted at all customers in proportion to their load (the worst case).`, detail }));
  }
  const dShift = fl.shiftNet - base.shiftNet;
  if (Math.abs(dShift) >= 1) {
    const moved = custs.filter((cu) => Math.abs(fl.by['shift:' + cu.id] ?? 0) > 0.5);
    const detail = moved.map((cu) => {
      const v = fl.by['shift:' + cu.id] ?? 0, cap = (cu.shiftablePct / 100) * dem(cu);
      const o = own(cu.id).shiftMWh;
      return `${cu.name}: ${v < 0 ? 'deferred' : 'pulled forward'} ${f0(Math.abs(v))} MW. ${cu.shiftablePct}% of its ${f0(dem(cu))} MW is shiftable (${f0(cap)} MW)${Math.abs(v) >= cap - 0.5 ? ', now at its limit' : `, ${f0(cap - Math.abs(v))} MW left`}${Math.abs(o) > 0.05 ? `; already ${o < 0 ? 'deferred' : 'pulled forward'} ${f1(Math.abs(o))} MWh today` : ''}.`;
    });
    detail.push(...notUsed(new Set(moved.map((cu) => cu.id)), (cu) => cu.shiftablePct > 0));
    out.push(mk({ type: 'load_shift', title: `${dShift > 0 ? 'Pull forward' : 'Defer'} flexible load: ${fmtShift(base.shiftNet)} → ${fmtShift(fl.shiftNet)}`, target: moved.map((cu) => cu.name).join(', '), mw: Math.abs(dShift), priority: 6,
      criterion: dShift > 0 ? 'RE utilisation (increase flexible demand in surplus)' : 'Minimum variable cost (avoid peak energy)',
      summary: dShift > 0
        ? `Surplus energy is available (${rs(smc)}/kWh marginal), so flexible customers take their load now. This costs about ₹0.10/kWh and avoids curtailing renewables.`
        : `Energy costs ${rs(smc)}/kWh in this block, so flexible customers move part of their load to a cheaper block (disruption cost ₹9/kWh, recovered later). ${lastResort}`, detail }));
  }

  // ---------------- maintenance: a farm that is far below forecast while its peers are on plan
  for (const u of c.underperforming) {
    out.push(mk({ type: 'maintenance_inspect', title: `Dispatch inspection team: ${u.name}`, target: u.id, mw: u.mw, priority: 4, criterion: 'DSM / deviation control (farm fault suspected)',
      summary: `${u.name} has produced ${Math.round(u.ratio * 100)}% of forecast for the last hour while the other farms are on plan: soiling, inverter or tracker fault suspected.` }));
  }
  return out.sort((a, b) => a.priority - b.priority).slice(0, 14);
}

/** Look-ahead items: when will the strategy change next? */
export function buildLookahead(c: AgentCtx): AgentAction[] {
  const out: AgentAction[] = [];
  const { P } = c;
  const seen = new Set<string>();
  for (let i = 1; i < Math.min(c.plan.length, 48); i++) {
    const a = c.plan[i], p = c.plan[i - 1];
    for (const b of P.bess.filter((x) => x.enabled)) {
      const n = a.flows.by[b.id] ?? 0, n0 = p.flows.by[b.id] ?? 0;
      if (n > 20 && n0 <= 20 && !seen.has('d' + b.id)) {
        seen.add('d' + b.id);
        out.push({ id: c.nextId(), slot: a.slot, type: 'bess_discharge', title: `${b.name.split(' ')[0]} starts discharging at ${hhmm(blockOf(a.slot))}`, target: b.id, mw: n, priority: 5, criterion: 'Minimum variable cost', reasoning: `Net load / price rises (SMC ${rs(a.smc ?? 0)}/kWh); SOC target ${((a.socByBess[b.id] / b.energyMWh) * 100).toFixed(0)}% after the move.`, alternative: '', impactRs: null, confidence: confidence(i, c.view.stormRisk[i], c.S), requiresApproval: false, status: 'planned' });
      }
      if (n < -20 && n0 >= -20 && !seen.has('c' + b.id)) {
        seen.add('c' + b.id);
        out.push({ id: c.nextId(), slot: a.slot, type: 'bess_charge', title: `${b.name.split(' ')[0]} starts charging at ${hhmm(blockOf(a.slot))}`, target: b.id, mw: -n, priority: 6, criterion: 'RE utilisation / price arbitrage', reasoning: `Low-price/solar-surplus window opens (SMC ${rs(a.smc ?? 0)}/kWh).`, alternative: '', impactRs: null, confidence: confidence(i, c.view.stormRisk[i], c.S), requiresApproval: false, status: 'planned' });
      }
    }
    for (const u of P.thermal.filter((x) => x.enabled)) {
      if (a.started[u.id] && !seen.has('s' + u.id)) {
        seen.add('s' + u.id);
        out.push({ id: c.nextId(), slot: a.slot, type: 'thermal_start', title: `${u.name} start planned ${hhmm(blockOf(a.slot))}`, target: u.id, mw: a.flows.by[u.id] ?? 0, priority: 5, criterion: 'Reserve adequacy / least-cost', reasoning: 'Evening ramp requires this unit online before solar collapses.', alternative: '', impactRs: null, confidence: confidence(i, 0, c.S), requiresApproval: false, status: 'planned' });
      }
    }
    if (a.flows.curtailSolar + a.flows.curtailWind > 5 && !seen.has('cur')) {
      seen.add('cur');
      out.push({ id: c.nextId(), slot: a.slot, type: (a.flows.curtailSolar >= a.flows.curtailWind ? 'curtail_solar' : 'curtail_wind') as 'curtail_solar', title: `Expected RE curtailment ${(a.flows.curtailSolar + a.flows.curtailWind).toFixed(0)} MW at ${hhmm(blockOf(a.slot))}`, target: 'Renewables', mw: a.flows.curtailSolar + a.flows.curtailWind, priority: 6, criterion: 'RE utilisation', reasoning: 'Surplus exceeds BESS, export and flexible-load sinks.', alternative: '', impactRs: null, confidence: confidence(i, 0, c.S), requiresApproval: false, status: 'planned' });
    }
    if (a.flows.dr > 5 && !seen.has('dr')) {
      seen.add('dr');
      out.push({ id: c.nextId(), slot: a.slot, type: 'dr', title: `Demand response likely at ${hhmm(blockOf(a.slot))} (${a.flows.dr.toFixed(0)} MW)`, target: 'Flexible customers', mw: a.flows.dr, priority: 3, criterion: 'Reserve adequacy', reasoning: 'Supply tightness / price spike in forecast.', alternative: '', impactRs: null, confidence: confidence(i, 0, c.S), requiresApproval: false, status: 'planned' });
    }
  }
  return out.slice(0, 5).map((x) => ({ ...x, bucket: ACTION_BUCKET[x.type] }));
}

export function buildCriteria(c: AgentCtx): Criterion[] {
  // The ladder shown to the operator is the RANKED objective list of the active profile, each with the value its lexicographic stage reached.
  const { P } = c;
  const next = c.plan.slice(0, 12);
  const unserved = Math.max(0, ...next.map((b) => b.flows.unserved));
  const resShort = Math.max(0, ...c.plan.slice(0, 8).map((b) => b.reserveSlackUp));
  const minMargin = Math.min(...c.plan.slice(0, 8).map((b) => (b.reserveUpReq > 0 ? b.reserveUpAvail / b.reserveUpReq : 1)));
  const curtailNext = Math.max(0, ...next.map((b) => b.flows.curtailSolar + b.flows.curtailWind));
  const imbalance = next.reduce((a2, b) => a2 + b.imbalanceMW * DT, 0);
  const corLoad = Math.max(...P.corridors.map((k) => {
    const members = [...P.solar, ...P.wind].filter((f) => f.corridorId === k.id);
    const flow = members.reduce((a2, f) => a2 + (c.plan[0]?.flows.by[f.id] ?? 0), 0);
    return flow / Math.max(1, c.view.ttc[0]?.[k.id] ?? k.ttcMW);
  }));
  const stage = (g: string) => c.stages.find((x) => x.group === g);
  const secViol = stage('security')?.metric ?? 0;
  const all: Record<ObjectiveId, Omit<Criterion, 'rank' | 'name'>> = {
    security: { status: secViol > 0.05 || corLoad > 0.98 ? 'binding' : Math.abs(c.freq - 50) > 0.05 || corLoad > 0.9 ? 'watch' : 'ok', value: `${f2(c.freq)} Hz · corridor ${f0(corLoad * 100)}%`, detail: 'Frequency response, transmission and interconnection limits. Hard constraints are always enforced; this objective ranks how hard the optimiser protects the margin.' },
    reliability: { status: unserved > 0.5 ? 'binding' : 'ok', value: unserved > 0.5 ? `${f0(unserved)} MW unserved` : 'All demand served', detail: 'Demand must be served; critical customers are protected before any other load is touched.' },
    reserve: { status: resShort > 1 ? 'binding' : minMargin < 1.15 ? 'watch' : 'ok', value: resShort > 1 ? `short ${f0(resShort)} MW` : `margin ×${f2(isFinite(minMargin) ? minMargin : 1)}`, detail: 'Upward and downward headroom sized from solar, wind and load forecast error, from actual ramp rates and battery energy.' },
    imbalance: { status: imbalance > 0.1 ? 'binding' : Math.abs(c.lastBlock.dsmMW) > c.lastBlock.dsmBand * 0.8 ? 'watch' : 'ok', value: `${c.lastBlock.dsmMW >= 0 ? '+' : ''}${f1(c.lastBlock.dsmMW)} MW · day ₹${f0(c.today.dsmCost)}k`, detail: 'Keep actual drawal close to the schedule; deviation (DSM) is priced as a real cost.' },
    cost: { status: 'ok', value: `₹${f2(c.today.cpu)}/kWh day avg`, detail: 'Energy, fuel, start-up, market, wear and carbon price, optimised over the full look-ahead.' },
    re_utilisation: { status: curtailNext > 1 ? 'binding' : c.today.reUtil < 0.97 ? 'watch' : 'ok', value: `${f1(c.today.reUtil * 100)}% used${curtailNext > 1 ? ` · ${f0(curtailNext)} MW curtail ahead` : ''}`, detail: 'Renewable energy is used before it is curtailed; curtailment is a last resort.' },
    bess_flex: { status: c.today.cycles > 1.6 ? 'watch' : 'ok', value: `${f2(c.today.cycles)} cycles · ₹${f0(c.today.bessCost)}k`, detail: 'Cycling only when it pays for wear and losses; flexibility is kept for the stressed blocks.' },
  };
  const order: ObjectiveId[] = [...(c.situation?.objectives ?? [])];
  for (const o of ['security', 'reliability', 'reserve', 'imbalance', 'cost', 're_utilisation', 'bess_flex'] as ObjectiveId[]) if (!order.includes(o)) order.push(o);
  return order.map((o, i) => ({ rank: i + 1, name: c.objectiveNames[o], ...all[o], status: all[o].status === 'ok' && i === 0 ? 'active' : all[o].status })) as Criterion[];
}

export function buildReasoning(c: AgentCtx, criteria: Criterion[], actions: AgentAction[]): { headline: string; bullets: string[]; tradeoff: string } {
  const b0 = c.plan[0];
  if (!b0) return { headline: 'Awaiting first plan…', bullets: [], tradeoff: '' };
  const fl = b0.flows;
  const bind = criteria.filter((x) => x.status === 'binding');
  const peakIdx = c.plan.slice(0, 48).reduce((bi, p, i, arr) => ((p.smc ?? 0) > (arr[bi].smc ?? 0) ? i : bi), 0);
  const peak = c.plan[peakIdx];
  const bullets: string[] = [];
  if (c.situation) {
    const sit = c.situation;
    const act = sit.events.filter((e) => e.active);
    bullets.push(`Active profile: ${sit.label}. Objective order: ${sit.objectives.map((o, i) => `${i + 1} ${c.objectiveNames[o]}`).join(' → ')}.` + (act.length ? ` Detected: ${act.map((e) => e.evidence).join('; ')}.` : ' No event is active.'));
    if (sit.interactions[0]) bullets.push(sit.interactions[0]);
  }
  const netLoad = fl.demand - fl.solar - fl.wind;
  bullets.push(`Next block ${hhmm(blockOf(b0.slot))}: demand ${f0(fl.demand)} MW, RE ${f0(fl.solar + fl.wind)} MW → net load ${f0(netLoad)} MW. Thermal ${f0(fl.thermal)} MW, BESS ${fl.bessDis - fl.bessCh >= 0 ? '+' : ''}${f0(fl.bessDis - fl.bessCh)} MW, market ${f0(fl.damBuy - fl.damSell + fl.rtmBuy - fl.rtmSell)} MW, contract import ${f0(fl.grid)} MW.`);
  bullets.push(`System marginal cost ${rs(b0.smc ?? 0)}/kWh now; the look-ahead peaks at ${rs(peak.smc ?? 0)}/kWh around ${hhmm(blockOf(peak.slot))}. Stored energy is valued at ${rs(b0.socValue ?? 0)}/kWh (LP shadow price), so BESS ${(fl.bessDis - fl.bessCh) > 1 ? 'discharges only because avoided cost exceeds' : 'is positioned against'} its ${rs(c.wac + 0.8)}/kWh effective cost.`);
  const th = Math.max(...c.plan.slice(0, 16).map((p) => p.flows.thermal)), tl = Math.min(...c.plan.slice(0, 16).map((p) => p.flows.thermal));
  bullets.push(`Next 4 h: thermal ${f0(tl)}–${f0(th)} MW; ${c.plan.slice(0, 16).some((p) => p.flows.curtailSolar + p.flows.curtailWind > 1) ? 'RE curtailment expected' : 'no RE curtailment expected'}; ${c.plan.slice(0, 16).some((p) => p.flows.dr > 1) ? 'demand response may be needed' : 'no demand response needed'}.`);
  if (c.lastBlock.notes.length) bullets.push('Real-time notes: ' + c.lastBlock.notes.join('; ') + '.');
  if (c.eventsActive.length) bullets.push('Active scenarios: ' + c.eventsActive.join(', ') + '.');
  const trade = bind.length === 0
    ? 'No criterion is binding – the schedule is cost-optimal inside all security, reliability and reserve limits.'
    : `Binding: ${bind.map((b) => b.name).join(', ')}. ${bind[0].rank <= 3 ? `${bind[0].name} (priority ${bind[0].rank}) takes precedence over cost – the optimiser pays up to ${rs(1.4 * Math.max(c.rtmPrice[0], 4))}/kWh (expected DSM rate) to relieve it.` : 'Lower-ranked criteria were relaxed only after higher-ranked ones were satisfied.'}`;
  const head = actions.length ? `${actions[0].title} – ${actions[0].criterion}` : 'Hold current dispatch';
  return { headline: head, bullets, tradeoff: trade };
}

export function buildAlerts(c: AgentCtx): Alert[] {
  const out: Alert[] = [];
  const { P, S } = c;
  const lb = c.lastBlock;
  const push = (level: Alert['level'], id: string, title: string, detail: string) => out.push({ id, level, title, detail, slot: c.cursor });
  if (lb.ratioSolar && Math.abs(lb.ratioSolar - 1) > 0.15) push(lb.ratioSolar < 0.7 ? 'critical' : 'warn', 'solar-err', `Solar forecast error ${((lb.ratioSolar - 1) * 100).toFixed(0)}%`, 'Actual solar is deviating from the schedule beyond the alert threshold; intraday forecast re-based.');
  if (lb.ratioWind && Math.abs(lb.ratioWind - 1) > 0.25) push('warn', 'wind-err', `Wind forecast error ${((lb.ratioWind - 1) * 100).toFixed(0)}%`, 'Wind output deviating – reserve margin recalculated.');
  const eveningIdx = c.plan.findIndex((p) => (p.smc ?? 0) > 7);
  const bessSoc = c.plan[0] ? c.plan[0].socMWh / Math.max(1, P.bess.filter((b) => b.enabled).reduce((a, b) => a + b.energyMWh, 0)) : 0.5;
  if (eveningIdx > 0 && eveningIdx < 24 && bessSoc < 0.4) push('warn', 'soc-low', 'BESS SOC below evening requirement', `SOC ${(bessSoc * 100).toFixed(0)}% with a high-value window in ${(eveningIdx * 15 / 60).toFixed(1)} h.`);
  for (const u of P.thermal.filter((x) => x.enabled)) {
    const p = c.plan[0]?.flows.by[u.id] ?? 0;
    if (c.plan[0]?.thermalOn[u.id] && p <= (u.minLoadPct / 100) * u.capacityMW + 2) push('info', 'th-min-' + u.id, `${u.name} at technical minimum`, 'Cannot back down further without shutdown – surplus must be absorbed by BESS/export or curtailed.');
  }
  const bessCost = c.wac / 0.94 + 0.8;
  if (c.rtmPrice[0] > bessCost + 0.5 && c.plan[0] && (c.plan[0].flows.bessDis < 1)) push('info', 'rtm-gt-bess', 'RTM price exceeds BESS discharge cost', `RTM ${rs(c.rtmPrice[0])}/kWh vs BESS ${rs(bessCost)}/kWh – discharge limited by SOC/reserve policy.`);
  for (const k of P.corridors) {
    const members = [...P.solar, ...P.wind].filter((f) => f.corridorId === k.id);
    const flow = members.reduce((a, f) => a + (c.plan[0]?.flows.by[f.id] ?? 0), 0);
    const ttc = c.view.ttc[0]?.[k.id] ?? k.ttcMW;
    if (flow > 0.92 * ttc) push(flow > 0.99 * ttc ? 'critical' : 'warn', 'cor-' + k.id, `Corridor ${k.id} at ${((flow / ttc) * 100).toFixed(0)}% of TTC`, `${flow.toFixed(0)} / ${ttc.toFixed(0)} MW.`);
  }
  for (const u of P.thermal.filter((x) => x.enabled)) {
    const cap = c.view.thermalCap[0]?.[u.id] ?? u.capacityMW;
    if (cap < (u.minLoadPct / 100) * u.capacityMW - 1e-6) push('critical', 'th-out-' + u.id, `${u.name} unavailable`, `${u.name} (${u.capacityMW} MW) is out of service; the remaining units, the battery and the market cover its share.`);
  }
  const def = c.plan.slice(0, 8).findIndex((p) => p.flows.unserved > 1 || p.reserveSlackUp > 10);
  if (def >= 0) push('critical', 'deficit', 'Expected deficit / reserve shortfall', `Within ${(def + 1) * 15} min: ${c.plan[def].flows.unserved > 1 ? `${c.plan[def].flows.unserved.toFixed(0)} MW unserved` : `${c.plan[def].reserveSlackUp.toFixed(0)} MW reserve short`}.`);
  const cur = c.plan.slice(0, 8).findIndex((p) => p.flows.curtailSolar + p.flows.curtailWind > 5);
  if (cur >= 0) push('warn', 'curtail', 'Expected renewable curtailment', `~${(c.plan[cur].flows.curtailSolar + c.plan[cur].flows.curtailWind).toFixed(0)} MW in ${(cur + 1) * 15} min.`);
  // (the deviation alert is built from live figures in the engine, so it follows the present block and not the last plan)
  if (c.securityMode === 'low-freq') push('critical', 'f-low', 'Frequency below 49.90 Hz', `${c.freq.toFixed(3)} Hz – low-frequency protocol active.`);
  if (c.securityMode === 'high-freq') push('warn', 'f-high', 'Frequency above 50.10 Hz', `${c.freq.toFixed(3)} Hz – high-frequency protocol active.`);
  for (let i = 0; i < Math.min(16, c.view.stormRisk.length); i++) if (c.view.stormRisk[i] > 0.5) { push('warn', 'storm', 'Storm risk ahead', `${c.view.stormWhy[i] || 'severe weather'} at ${hhmm(blockOf(c.cursor + 1 + i))} – reserve ×1.5 and wind cut-out assumed.`); break; }
  void S;
  return out.slice(0, 10);
}

/** Opportunity cost of a maintenance window vs. alternatives; returns proposals for deferrable items. */
export function proposeMaintenance(
  items: MaintenanceItem[], c: AgentCtx, forecastMW: (assetId: string, slotOffset: number) => number, smcAt: (offset: number) => number | null,
): { item: MaintenanceItem; newStart: number; newEnd: number; saving: number; reason: string }[] {
  const res: { item: MaintenanceItem; newStart: number; newEnd: number; saving: number; reason: string }[] = [];
  const horizon = c.plan.length;
  for (const it of items) {
    if (!it.deferrable || it.status !== 'scheduled') continue;
    const dur = it.endSlot - it.startSlot;
    const off0 = it.startSlot - c.plan[0].slot;
    if (off0 < 2 || off0 + dur > horizon) continue; // only reason about windows fully inside the plan horizon
    const asset = [...c.P.solar, ...c.P.wind, ...c.P.thermal, ...c.P.bess].find((a) => a.id === it.assetId);
    if (!asset) continue;
    const cost = (startOff: number) => {
      let v = 0;
      for (let k = 0; k < dur; k++) {
        const smc = smcAt(startOff + k);
        if (smc == null) return Infinity;
        const lost = it.derateMW ?? ('capacityMW' in asset ? (asset as any).capacityMW : (asset as any).powerMW);
        if (asset.kind === 'solar' || asset.kind === 'wind') {
          const mw = Math.min(lost, forecastMW(it.assetId, startOff + k));
          v += mw * Math.max(0, smc - (asset as any).tariff) * DT;
        } else if (asset.kind === 'thermal') v += lost * Math.max(0, smc - asset.varCost) * DT * 0.6;
        else v += lost * Math.max(0, smc - 4.5) * DT * 0.5;
      }
      return v;
    };
    const cur = cost(off0);
    let best = { off: off0, v: cur };
    for (let off = 0; off + dur <= horizon; off++) {
      if (Math.abs(off - off0) < 2) continue;
      const v = cost(off);
      if (v < best.v) best = { off, v };
    }
    const saving = cur - best.v;
    if (saving > 8 && best.off !== off0) {
      const ns = c.plan[0].slot + best.off;
      res.push({ item: it, newStart: ns, newEnd: ns + dur, saving, reason: `Window ${hhmm(blockOf(it.startSlot))}–${hhmm(blockOf(it.endSlot))} overlaps high-value energy (est. loss ₹${cur.toFixed(0)}k). Shifting to ${hhmm(blockOf(ns))}–${hhmm(blockOf(ns + dur))} (${slotLabel(ns).slice(5, 10)}) reduces the opportunity cost to ₹${best.v.toFixed(0)}k.` });
    }
  }
  return res;
}

export const _b = BLOCKS;
