// Modular action generators. Each category reports what the optimiser MAY do (feasible range, constraints that bound it,
// blocks affected, cost components, uncertainty, and whether the action is advisory / simulated / approved for execution) and
// what it may NOT do (with the reason). The optimiser then chooses within these sets; nothing here invents dispatch numbers.
import type { PlanInput } from '../opt/model.js';
import type { PolicyConfig, Situation } from './types.js';

export type CandidateMode = 'approved' | 'simulated' | 'advisory' | 'excluded';
export interface Candidate {
  category: 'renewables' | 'thermal' | 'bess' | 'market' | 'grid' | 'demand_response' | 'load_shift' | 'reserve' | 'maintenance' | 'emergency';
  action: string;
  asset: string;
  range: { min: number; max: number; unit: string } | null;
  constraints: string[];
  blocks: [number, number]; // first / last planned block (relative) the action can affect
  impact: string;
  cost: Record<string, string>;
  uncertainty: string;
  mode: CandidateMode;
  reason?: string; // why it is excluded / what limits it
}

export interface CandidateCtx {
  input: PlanInput;
  cfg: PolicyConfig;
  situation: Situation;
  sigma: number; // forecast uncertainty of the first block (MW, 1σ)
  maint: { id: string; assetId: string; assetName: string; type: string; startSlot: number; endSlot: number; deferrable: boolean; description: string; status: string }[];
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const rs = (x: number) => `₹${x.toFixed(2)}/kWh`;

export function generateCandidates(c: CandidateCtx): Candidate[] {
  const { input: inp, cfg } = c;
  const P = inp.portfolio, S = inp.settings, v = inp.view, H = inp.H;
  const pol = inp.policy;
  const out: Candidate[] = [];
  const mode = (cat: keyof typeof cfg.actions.autoExecute, fallback: CandidateMode = 'approved'): CandidateMode => {
    const m = cfg.actions.autoExecute[cat as string];
    return m === true ? fallback : m === false ? 'advisory' : 'simulated';
  };
  const last = Math.max(0, H - 1);

  // ---- renewable generation
  for (const f of [...P.solar, ...P.wind].filter((x) => x.enabled)) {
    const avail = v.solar[0][f.id] ?? v.wind[0][f.id] ?? 0;
    out.push({ category: 'renewables', action: 'Dispatch available output (curtail only if required)', asset: f.id, range: { min: 0, max: r1(avail), unit: 'MW' },
      constraints: [`corridor ${f.corridorId} transfer limit`, 'available power from the forecast', 'curtailment compensation (deemed generation)'], blocks: [0, last],
      impact: 'Supplies demand at PPA tariff; curtailment loses clean energy and pays compensation', cost: { 'PPA tariff': rs(f.tariff), 'curtailment compensation': rs(0.5 * f.tariff) },
      uncertainty: `forecast error ±${r1(c.sigma)} MW (1σ, fleet)`, mode: mode('renewables') });
  }
  // ---- thermal
  for (const u of P.thermal.filter((x) => x.enabled)) {
    const cap = v.thermalCap[0][u.id] ?? 0, pmin = (u.minLoadPct / 100) * u.capacityMW, hold = inp.state.thermalHold[u.id] ?? 0;
    if (cap < pmin - 1e-6 || cap <= 0) { out.push({ category: 'thermal', action: 'Adjust output / commit', asset: u.id, range: null, constraints: ['outage or derating below minimum load'], blocks: [0, last], impact: '-', cost: {}, uncertainty: '-', mode: 'excluded', reason: `unavailable: capacity ${r1(cap)} MW is below its ${r1(pmin)} MW technical minimum` }); continue; }
    out.push({ category: 'thermal', action: inp.state.thermalOn[u.id] ? (hold > 0 ? `Adjust output (state held for ${hold} more blocks)` : 'Adjust output or decommit') : (hold > 0 ? `Stay off for ${hold} more blocks` : 'Commit and adjust output'),
      asset: u.id, range: { min: r1(pmin), max: r1(cap), unit: 'MW (or off)' },
      constraints: [`ramp ${r1((u.rampPctPerMin / 100) * u.capacityMW * 15)} MW per block`, `minimum up ${u.minUpBlocks} / down ${u.minDownBlocks} blocks`, u.mustRun ? 'must-run' : 'dispatchable'], blocks: [0, last],
      impact: 'Residual-demand balancing and ramping capability', cost: { 'variable': rs(u.varCost), 'no-load': `₹${u.noLoadCost}k/h`, 'start-up': `₹${u.startupCost}k` }, uncertainty: 'availability assumed as forecast', mode: mode('thermal') });
  }
  // ---- battery
  for (const b of P.bess.filter((x) => x.enabled)) {
    const pav = v.bessPower[0][b.id] ?? 0, arb = pav * (1 - b.gridSupportReservePct / 200);
    const soc = inp.state.socMWh[b.id] ?? b.energyMWh * 0.5;
    const floor = (b.socMinPct + b.gridSupportReservePct) / 100 * b.energyMWh;
    out.push({ category: 'bess', action: 'Charge, discharge or hold SOC; reserve power and energy', asset: b.id, range: { min: -r1(arb), max: r1(arb), unit: 'MW (− charge, + discharge)' },
      constraints: [`SOC ${r1(soc)} MWh within ${r1((b.socMinPct / 100) * b.energyMWh)}–${r1((b.socMaxPct / 100) * b.energyMWh)} MWh`, `reserve floor ${r1(floor)} MWh`, `round-trip efficiency ${(b.etaCharge * b.etaDischarge * 100).toFixed(0)}%`, 'no simultaneous charge and discharge'], blocks: [0, last],
      impact: 'Shifts energy in time and provides fast reserve', cost: { degradation: rs(b.degradationCost * S.weights.degradationScale), 'opportunity cost': 'shadow price of stored energy from the cost stage' }, uncertainty: 'future prices and renewable output', mode: mode('bess') });
  }
  // ---- market
  const lockedNow = inp.locked.rtmBuy[0] != null || inp.locked.rtmSell[0] != null;
  out.push({ category: 'market', action: 'RTM buy / sell for short-term correction', asset: 'RTM', range: { min: -S.market.maxSellMW, max: S.market.maxBuyMW, unit: 'MW (− sell, + buy)' },
    constraints: [`gate closure ${S.market.rtmLeadBlocks} blocks ahead (${lockedNow ? 'the next block is already locked' : 'next block still open'})`, 'sales only from renewable / battery energy', `price cap ${rs(S.market.priceCap)}`], blocks: [Math.min(S.market.rtmLeadBlocks, last), last],
    impact: 'Corrects deviations before settlement', cost: { 'price + fees': `RTM ${rs(v.rtmPrice[0])} + ${rs(S.market.exchangeFee + S.market.buyAdder)}` }, uncertainty: 'RTM price forecast error ≈ 8%', mode: mode('market') });
  out.push({ category: 'market', action: 'DAM procurement schedule for the next day', asset: 'DAM', range: { min: -S.market.maxSellMW, max: S.market.maxBuyMW, unit: 'MW per block' },
    constraints: ['bid window closes at 10:00 the day before', 'committed positions are fixed once cleared'], blocks: [0, last], impact: 'Baseline energy at the day-ahead price', cost: { 'price + fees': `DAM ${rs(v.damPrice[0])} + ${rs(S.market.exchangeFee + S.market.buyAdder)}` }, uncertainty: 'DAM clearing price forecast error ≈ 4–6%', mode: mode('market') });
  // ---- grid connections
  out.push({ category: 'grid', action: 'Adjust contract import / exchange export', asset: 'interconnection', range: { min: -P.interconnect.exportLimitMW, max: P.interconnect.importLimitMW, unit: 'MW (− export, + import)' },
    constraints: [`contract ≤ ${P.interconnect.gridContractLimitMW} MW at ${rs(P.interconnect.gridContractPrice)}`, `total import ≤ ${P.interconnect.importLimitMW} MW`], blocks: [0, last], impact: 'Alternative supply', cost: { contract: rs(P.interconnect.gridContractPrice) }, uncertainty: 'availability assumed', mode: mode('market') });
  // ---- demand response and load shifting (permission is a policy decision per block)
  const drOn = pol?.perBlock.allowDR[0] ?? false, drAny = pol?.perBlock.allowDR.some(Boolean) ?? false;
  const shOn = pol?.perBlock.allowShiftOut[0] ?? false, shAny = pol?.perBlock.allowShiftOut.some(Boolean) ?? false;
  for (const cu of P.customers.filter((x) => x.enabled)) {
    const d = v.demand[0][cu.id] ?? 0;
    if (cu.drFlexPct > 0) {
      const crit = cu.criticality === 'critical' && cfg.actions.demandResponse.excludeCritical;
      out.push({ category: 'demand_response', action: 'Curtail eligible load', asset: cu.id, range: crit ? null : { min: 0, max: r1((cu.drFlexPct / 100) * d), unit: 'MW' },
        constraints: [`${cu.drFlexPct}% flexible`, `${cu.criticality} customer`, `notice ${cfg.actions.demandResponse.noticeBlocks} blocks`], blocks: [0, last], impact: 'Reduces demand during scarcity',
        cost: { 'lost sales + incentive + disruption': rs(cu.tariff + cu.drIncentive + cfg.actions.demandResponse.disruptionRsPerKwh) }, uncertainty: 'customer response assumed full', mode: crit ? 'excluded' : drOn ? mode('demandResponse', 'approved') : (drAny ? 'advisory' : 'excluded'),
        reason: crit ? 'critical load is protected' : drOn ? undefined : drAny ? 'not permitted in the first block; permitted later in the horizon when an event enables it' : 'not permitted by the active profile: demand response needs an event that enables it (scarcity, price spike, failure, demand spike, low frequency)' });
    }
    if (cu.shiftablePct > 0) {
      out.push({ category: 'load_shift', action: 'Defer / pull forward flexible load (energy-neutral)', asset: cu.id, range: { min: 0, max: r1((cu.shiftablePct / 100) * d), unit: 'MW' },
        constraints: [`${cu.shiftablePct}% shiftable`, 'energy neutral over the horizon'], blocks: [0, last], impact: 'Moves energy out of scarce / dear blocks', cost: { 'out / in': `${rs(cfg.actions.loadShift.shiftOutRsPerKwh)} / ${rs(cfg.actions.loadShift.shiftInRsPerKwh)}` }, uncertainty: 'customer acceptance',
        mode: shOn ? 'approved' : shAny ? 'advisory' : 'excluded', reason: shOn ? undefined : shAny ? 'not permitted in the first block' : 'not permitted by the active profile: load shifting needs a price spike or renewable surplus' });
    }
  }
  // ---- reserve management (capability, not a decision variable)
  {
    const th = P.thermal.filter((u) => u.enabled).reduce((a, u) => a + Math.min((u.rampPctPerMin / 100) * u.capacityMW * 15, Math.max(0, (v.thermalCap[0][u.id] ?? 0) - (inp.state.thermalP[u.id] ?? 0))), 0);
    const bs = P.bess.filter((b) => b.enabled).reduce((a, b) => a + Math.min(v.bessPower[0][b.id] ?? 0, (Math.max(0, (inp.state.socMWh[b.id] ?? 0) - (b.socMinPct / 100) * b.energyMWh) * b.etaDischarge) / 0.5), 0);
    out.push({ category: 'reserve', action: 'Allocate upward / downward reserve across thermal units and batteries', asset: 'fleet', range: { min: 0, max: r1(th + bs), unit: 'MW upward capability now' },
      constraints: [`thermal ramp-limited headroom ${r1(th)} MW`, `battery energy-limited (30 min sustain) ${r1(bs)} MW`, `requirement sized from forecast error ${r1(c.sigma)} MW (1σ)`], blocks: [0, last], impact: 'Protects against forecast error', cost: { 'opportunity': 'energy held back from the cost stage' }, uncertainty: 'reserve response time assumed ≤ 15 min', mode: 'simulated' });
  }
  // ---- maintenance: approved schedules are respected; only flexible, deferrable items can be proposed for rescheduling
  for (const m of c.maint.filter((x) => x.status !== 'completed' && x.startSlot < inp.slot0 + H && x.endSlot > inp.slot0)) {
    out.push({ category: 'maintenance', action: m.deferrable ? 'Propose rescheduling (needs approval)' : 'Respect approved outage', asset: m.assetId, range: null,
      constraints: [`${m.description}`, m.deferrable ? 'marked flexible' : 'not marked flexible'], blocks: [Math.max(0, m.startSlot - inp.slot0), Math.min(last, m.endSlot - inp.slot0)], impact: m.deferrable ? 'May avoid a costly or risky outage window' : 'Fixed', cost: {}, uncertainty: '-',
      mode: m.deferrable ? 'advisory' : 'excluded', reason: m.deferrable ? 'requires operator approval' : 'outage is approved and not marked flexible, so it is never moved' });
  }
  // ---- emergency actions: only when their trigger is modelled and met
  const em = cfg.actions.emergencyProcurement;
  out.push({ category: 'emergency', action: 'Emergency procurement / demand curtailment', asset: 'control area', range: null, constraints: ['trigger: unserved energy or reserve shortfall that no other action closes', 'operator recommendation, not auto-executed'], blocks: [0, last], impact: 'Last-resort supply', cost: { 'unserved energy': 'reliability stage metric' }, uncertainty: '-',
    mode: em.enabled ? em.mode : 'excluded', reason: em.enabled ? 'available only after the reliability stage reports a shortfall' : 'disabled in the policy' });
  return out;
}

export function summariseCandidates(cs: Candidate[]) {
  const cats = [...new Set(cs.map((x) => x.category))];
  return {
    considered: Object.fromEntries(cats.map((k) => [k, cs.filter((x) => x.category === k && x.mode !== 'excluded').length])),
    excluded: cs.filter((x) => x.mode === 'excluded').map((x) => ({ category: x.category, asset: x.asset, action: x.action, reason: x.reason ?? '' })),
    advisoryOnly: cs.filter((x) => x.mode === 'advisory').map((x) => ({ category: x.category, asset: x.asset, action: x.action, reason: x.reason ?? '' })),
  };
}
