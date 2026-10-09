// Acceptance and regression tests of the optimisation-policy engine.
// Run:  npm test            (UPDATE_GOLDEN=1 npm test  rewrites the regression baseline after a deliberate change)
// Every case is deterministic: synthetic inputs built from the default portfolio, no network, no random numbers.
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cloneDeep, getPolicy, recommend, runScenario, stageOrder, sumBlocks, toBaseline, type Run } from './harness.js';
import { validatePolicy } from '../policy/config.js';
import { metricsOfPlan } from '../policy/evaluate.js';
import { summariseCandidates } from '../policy/candidates.js';
import { GROUP_OBJECTIVE } from '../policy/types.js';

const DT = 0.25;
const sum = (r: Run, f: (b: Run['out']['blocks'][number], t: number) => number) => sumBlocks(r, f);
const curtailMWh = (r: Run) => sum(r, (b) => (b.flows.curtailSolar + b.flows.curtailWind) * DT);
const drMWh = (r: Run) => sum(r, (b) => b.flows.dr * DT);
const shiftMWh = (r: Run) => sum(r, (b) => Math.abs(b.flows.shiftNet) * DT);
const resShort = (r: Run) => sum(r, (b) => b.reserveSlackUp * DT);
const rtmBuyMWh = (r: Run) => sum(r, (b) => b.flows.rtmBuy * DT);
const kinds = (r: Run) => r.situation.activeKinds;
const lockFrom = (r: Run) => ({ buy: r.out.blocks.map((b) => b.flows.damBuy), sell: r.out.blocks.map((b) => b.flows.damSell) });

/** Hard-constraint compliance, solver status and structural policy checks that every case must pass. */
function assertSound(r: Run, name: string) {
  assert.equal(r.out.ok, true, `${name}: solver returned ${r.out.status}`);
  assert.deepEqual(r.verification.violations, [], `${name}: hard constraints violated: ${JSON.stringify(r.verification.violations.slice(0, 3))}`);
  const order = stageOrder(r);
  assert.equal(order[0], 'security', `${name}: grid security (hard constraint) is always the first stage`);
  assert.equal(new Set(order).size, order.length, `${name}: every objective group is optimised exactly once`);
  assert.equal(r.out.exclusivityViolations, 0, `${name}: no simultaneous battery charge and discharge`);
  assert.ok((r.out.costBreakdown?.total ?? 0) > 0, `${name}: cost is computed`);
}

const cases = {} as Record<string, Run>;
let dam1: Run, dam7: Run, dam8: Run;

describe('optimisation policy engine', { concurrency: false }, () => {
  before(async () => {
    // committed day-ahead schedules (references for "what changes")
    dam1 = await runScenario({ mode: 'DAM', startBlock: 40, H: 36 });
    cases.c1 = await runScenario({ startBlock: 40, H: 36, damLocks: lockFrom(dam1), baseline: toBaseline(dam1) });
    cases.c2 = await runScenario({ startBlock: 36, H: 36, loadMult: 0.55, solarMult: 1.4, socPct: 90 });
    cases.c3 = await runScenario({ startBlock: 62, H: 36, priceMult: (_t, b) => (b >= 70 && b <= 90 ? 2 : 1) });
    cases.c3ref = await runScenario({ startBlock: 62, H: 36 });
    cases.c4 = await runScenario({ startBlock: 60, H: 30, bessAvail: (t) => (t >= 3 ? 0 : 1) });
    cases.c4ref = await runScenario({ startBlock: 60, H: 30 });
    cases.c5 = await runScenario({ startBlock: 64, H: 24, loadMult: 1.2, last: { ratioLoad: 1.12 }, thermalCap: { 'th-flex': 0.5, 'th-peaker': 0 } });
    cases.cLadder = await runScenario({ startBlock: 64, H: 24, loadMult: 1.9, last: { ratioLoad: 1.5 }, thermalCap: { 'th-flex': 0.5, 'th-peaker': 0 }, socPct: 60 });
    cases.c5mild = await runScenario({ startBlock: 64, H: 24, loadMult: 1.15, last: { ratioLoad: 1.12 }, thermalCap: { 'th-flex': 0.5, 'th-peaker': 0 } });
    cases.c6 = await runScenario({ startBlock: 36, H: 24, loadMult: 0.6, solarMult: 1.1, ttcMult: { RJ: 0.4, WR: 0.5, SR: 0.5, CR: 1 } });
    dam7 = await runScenario({ mode: 'DAM', startBlock: 36, H: 36 });
    cases.c7 = await runScenario({ startBlock: 36, H: 36, solarMult: 0.65, last: { ratioSolar: 0.65 }, damLocks: lockFrom(dam7), baseline: toBaseline(dam7) });
    dam8 = await runScenario({ mode: 'DAM', startBlock: 64, H: 24 });
    cases.c8 = await runScenario({ startBlock: 64, H: 24, thermalCap: { 'th-base': 0 }, damLocks: lockFrom(dam8), baseline: toBaseline(dam8) });
    cases.c9 = await runScenario({ startBlock: 60, H: 36, freq: 49.82, bessAvail: (t) => (t >= 3 ? 0.4 : 1), socPct: 22, priceMult: (_t, b) => (b >= 72 && b <= 88 ? 1.7 : 1) });
    cases.c10 = await runScenario({ startBlock: 64, H: 12, loadMult: 2.6, thermalCap: { 'th-base': 0.5 } });
  });

  // ------------------------------------------------------------------ 1
  it('1. normal demand, adequate renewables and reserve: normal profile, no demand flexibility, schedule followed', () => {
    const r = cases.c1;
    assertSound(r, 'c1');
    assert.equal(r.situation.profileId, 'normal');
    assert.deepEqual(r.situation.objectives, ['security', 'reliability', 'reserve', 'imbalance', 'cost', 're_utilisation', 'bess_flex']);
    assert.equal(r.out.unservedMWh! < 0.05, true);
    assert.ok(resShort(r) < 1, 'reserve is adequate');
    assert.equal(drMWh(r), 0, 'no demand response on a normal day');
    assert.equal(shiftMWh(r), 0, 'no load shifting on a normal day');
    assert.equal(r.out.feasibility, 'ok');
    // cost calculation: the optimiser's breakdown agrees with an independent evaluation of the same flows (carbon price excluded)
    const m = metricsOfPlan('x', r.out, r.view, r.input.portfolio, r.input.settings, r.out.blocks.length);
    const optimiserCost = r.out.costBreakdown!.total - r.out.costBreakdown!.carbon;
    assert.ok(Math.abs(m.costK - optimiserCost) / optimiserCost < 0.02, `cost ${m.costK.toFixed(0)} vs ${optimiserCost.toFixed(0)}`);
    // recommendation: with the day-ahead schedule already in force and unchanged forecasts, nothing needs to change
    assert.deepEqual(recommend(r, toBaseline(dam1)).map((a) => a.title), []);
  });

  // ------------------------------------------------------------------ 2
  it('2. solar surplus with limited battery room: renewable-surplus profile, renewables ranked above cost, curtailment only when sinks are exhausted', () => {
    const r = cases.c2;
    assertSound(r, 'c2');
    assert.deepEqual(kinds(r), ['renewable_surplus']);
    const order = stageOrder(r);
    assert.ok(order.indexOf('re') < order.indexOf('cost'), 'renewable utilisation is ranked above cost in this profile');
    for (const u of r.input.portfolio.thermal.filter((x) => x.mustRun)) r.out.blocks.forEach((b, t) => assert.ok(b.thermalOn[u.id], `block ${t}: must-run unit ${u.name} is never stopped, even in a surplus`));
    const E = r.input.portfolio.bess.reduce((a, b) => a + b.energyMWh, 0);
    r.out.blocks.forEach((b, t) => {
      if (b.flows.curtailSolar + b.flows.curtailWind > 1) {
        const full = r.input.portfolio.bess.every((x) => (b.socByBess[x.id] ?? 0) >= (x.socMaxPct / 100) * x.energyMWh - 1 || (b.flows.by['ch:' + x.id] ?? 0) >= 0.9 * (r.input.view.bessPower[t][x.id] ?? 0));
        const sellsMax = b.flows.damSell + b.flows.rtmSell >= Math.min(r.input.settings.market.maxSellMW, r.input.portfolio.interconnect.exportLimitMW) - 1;
        assert.ok(full || sellsMax, `block ${t}: curtailing while the battery and the export route still have room (E=${E})`);
      }
    });
    assert.equal(drMWh(r), 0);
  });

  // ------------------------------------------------------------------ 3
  it('3. evening ramp with a high RTM price: reliability and reserve first, battery pre-positioned and used in the peak, demand untouched', () => {
    const r = cases.c3;
    assertSound(r, 'c3');
    assert.ok(kinds(r).includes('evening_ramp') && kinds(r).includes('price_spike'), `active: ${kinds(r)}`);
    assert.deepEqual(r.situation.objectives.slice(0, 3), ['security', 'reliability', 'reserve']);
    assert.equal(r.out.unservedMWh! < 0.05, true);
    assert.equal(drMWh(r), 0, 'demand response is not needed: other levers cover the ramp');
    // battery energy is held back before the spike and discharged into the dearest blocks
    const prices = r.view.rtmFc;
    const peak = prices.indexOf(Math.max(...prices));
    const dischargeAtPeak = r.out.blocks[peak].flows.bessDis;
    const dischargeAvg = sum(r, (b) => b.flows.bessDis) / r.out.blocks.length;
    assert.ok(dischargeAtPeak > dischargeAvg, 'battery discharges most in the dearest block');
    // inside the dear blocks the agent buys no more than it would without the spike: it substitutes battery and thermal energy
    const ref = cases.c3ref;
    const dear = (x: Run) => sum(x, (b, t) => (r.view.rtmFc[t] >= 9 ? (b.flows.damBuy + b.flows.rtmBuy) * DT : 0));
    assert.ok(dear(r) <= dear(ref) + 1, 'a price spike does not increase purchases in the spike blocks');
  });

  // ------------------------------------------------------------------ 4
  it('4. battery outage during the evening ramp: combined profile, interaction recorded, no battery dispatch, demand still served', () => {
    const r = cases.c4;
    assertSound(r, 'c4');
    assert.ok(kinds(r).includes('evening_ramp') && kinds(r).includes('bess_outage_or_low_soc'), `active: ${kinds(r)}`);
    assert.ok(r.situation.interactions.some((s) => s.includes('battery')), 'the ramp/battery interaction is reported');
    assert.ok(r.situation.profileId.includes('+'), 'a combined profile, not a single event');
    r.out.blocks.forEach((b, t) => { if (t >= 3) assert.ok(b.flows.bessDis < 0.5, `block ${t}: battery unavailable but discharging`); });
    assert.equal(r.out.unservedMWh! < 0.05, true);
    // the lost flexibility is replaced elsewhere: more thermal or imports than the reference
    const net = (x: Run) => sum(x, (b, t) => (t >= 3 ? (b.flows.thermal + b.flows.damBuy + b.flows.rtmBuy + b.flows.grid - b.flows.bessCh) * DT : 0));
    const repl = net(r), refRepl = net(cases.c4ref);
    assert.ok(repl >= refRepl, 'generation / procurement reallocated to replace the battery');
  });

  // ------------------------------------------------------------------ shortage ladder
  it('shortage ladder: thermal and imports first, then demand response, then the battery below its floor; sales are curbed only if customers are still short', () => {
    const r = cases.cLadder;
    assertSound(r, 'cLadder');
    assert.match(r.out.note ?? '', /Shortage ladder used/);
    assert.match(r.out.note ?? '', /demand response/);
    assert.match(r.out.note ?? '', /reserves/);
    assert.ok(drMWh(r) > 0, 'demand response is part of the ladder');
    // thermal is used as far as it can go (units ramp at a limited rate, so look once it has had time to reach its available maximum)
    r.out.blocks.forEach((b, i) => { if (i >= 8 && b.flows.unserved > 1) assert.ok(b.flows.thermal >= 0.95 * (Object.values(r.input.view.thermalCap[i]) as number[]).reduce((a, x) => a + x, 0) - 1, `block ${i}: thermal is at its available maximum while customers are short`); });
    // the battery is drawn down to its physical minimum before the shortfall is accepted
    const E = r.input.portfolio.bess.reduce((a, x) => a + x.energyMWh, 0), minE = r.input.portfolio.bess.reduce((a, x) => a + (x.socMinPct / 100) * x.energyMWh, 0);
    const lowest = Math.min(...r.out.blocks.map((b) => Object.values(b.socByBess).reduce((a, x) => a + x, 0)));
    assert.ok(lowest <= minE + 0.02 * E, 'the battery reaches its physical minimum');
    // no committed sale existed here, so nothing was curbed
    assert.doesNotMatch(r.out.note ?? '', /curbing committed exchange sales/);
  });

  // ------------------------------------------------------------------ 5
  it('5. sudden demand increase with limited thermal headroom: demand response is used only when higher-ranked objectives need it', () => {
    const r = cases.c5, mild = cases.c5mild;
    assertSound(r, 'c5');
    assert.ok(kinds(r).includes('demand_spike'));
    assert.equal(r.out.unservedMWh! < 0.05, true, 'load is not shed: demand response and procurement cover it');
    // shortage ladder: demand response comes before the battery's reserve floor is touched
    assert.equal(r.out.demandFlex?.needed, true);
    assert.ok(drMWh(r) > 0, 'demand response is used when the shortfall cannot be closed otherwise');
    // a smaller increase is absorbed by generation, the battery and procurement: demand response stays unused although permitted
    assertSound(mild, 'c5mild');
    assert.equal(mild.out.demandFlex?.needed, false);
    assert.equal(drMWh(mild), 0, 'permitted but not needed: not used');
    // critical load is never curtailed
    r.out.blocks.forEach((b) => { for (const c of r.input.portfolio.customers) if (c.criticality === 'critical') assert.equal(b.flows.by['dr:' + c.id] ?? 0, 0); });
  });

  // ------------------------------------------------------------------ 6
  it('6. transmission constraint with local surplus: security first, corridor limits respected, no merchant sales while it lasts', () => {
    const r = cases.c6;
    assertSound(r, 'c6');
    assert.ok(kinds(r).includes('transmission_constraint'));
    assert.equal(stageOrder(r)[0], 'security');
    assert.ok(curtailMWh(r) > 0, 'part of the local surplus cannot be evacuated');
    // every curtailed block has a corridor at its limit or is otherwise exhausted
    r.out.blocks.forEach((b, t) => {
      if (b.flows.curtailSolar + b.flows.curtailWind > 1) {
        const atLimit = r.input.portfolio.corridors.some((c) => {
          const members = [...r.input.portfolio.solar, ...r.input.portfolio.wind].filter((f) => f.corridorId === c.id && f.enabled);
          const flow = members.reduce((a, f) => a + (b.flows.by[f.id] ?? 0), 0) + r.input.portfolio.bess.filter((x) => x.corridorId === c.id).reduce((a, x) => a + (b.flows.by[x.id] ?? 0), 0);
          return flow >= (r.input.view.ttc[t][c.id] ?? c.ttcMW) - 1;
        });
        assert.ok(atLimit, `block ${t}: curtailment without a binding corridor`);
      }
      const ev = r.situation.events.find((e) => e.kind === 'transmission_constraint')!;
      if (t >= ev.startBlock && t <= ev.endBlock) assert.ok(b.flows.damSell + b.flows.rtmSell < 1, `block ${t}: merchant sales are suspended during a transmission constraint`);
    });
  });

  // ------------------------------------------------------------------ 7
  it('7. renewable forecast error: RTM correction on top of the committed day-ahead position, small deviation exposure', () => {
    const r = cases.c7;
    assertSound(r, 'c7');
    assert.ok(kinds(r).includes('renewable_forecast_error'));
    assert.ok(rtmBuyMWh(r) > 10, 'the missing solar energy is bought in the real-time market');
    const acts = recommend(r, toBaseline(dam7));
    assert.ok(acts.some((a) => a.bucket === 'market' || a.bucket === 'thermal'), `recommendation: ${acts.map((a) => a.title)}`);
    assert.ok((r.out.dsmExposureMWh ?? 0) < 5, 'deviation exposure is controlled');
    assert.equal(r.out.unservedMWh! < 0.05, true);
  });

  // ------------------------------------------------------------------ 8
  it('8. thermal unit failure: reliability and reserve first, lost energy replaced, binding limits reported', () => {
    const r = cases.c8;
    assertSound(r, 'c8');
    assert.ok(kinds(r).includes('thermal_unit_failure'));
    assert.equal(r.out.unservedMWh! < 0.05, true);
    const lost = sum(dam8, (b) => (b.flows.by['th-base'] ?? 0) * DT);
    assert.ok(sum(r, (b) => (b.flows.by['th-base'] ?? 0)) === 0 && lost > 0, 'the failed unit produces nothing');
    const repl = sum(r, (b) => (b.flows.thermal - (b.flows.by['th-base'] ?? 0) + b.flows.damBuy + b.flows.rtmBuy + b.flows.grid + b.flows.bessDis) * DT) - sum(dam8, (b) => (b.flows.thermal - (b.flows.by['th-base'] ?? 0) + b.flows.damBuy + b.flows.rtmBuy + b.flows.grid + b.flows.bessDis) * DT);
    assert.ok(repl > 0.5 * lost, `replacement ${repl.toFixed(0)} MWh vs lost ${lost.toFixed(0)} MWh`);
    assert.ok((r.out.binding ?? []).length > 0, 'binding constraints with shadow prices are reported');
    assert.ok(r.out.stages!.some((s) => s.group === 'reserve'), 'reserve stage ran');
    const acts = recommend(r, toBaseline(dam8));
    assert.ok(acts.some((a) => a.bucket === 'thermal' || a.bucket === 'market' || a.bucket === 'demand'), `recommendation: ${acts.map((a) => a.title)}`);
  });

  // ------------------------------------------------------------------ 9
  it('9. several events at once: one combined profile, security first, reserve raised for low frequency, objectives ranked by weighted evidence', () => {
    const r = cases.c9;
    assertSound(r, 'c9');
    assert.ok(kinds(r).includes('frequency_deterioration') && kinds(r).includes('bess_outage_or_low_soc'), `active: ${kinds(r)}`);
    assert.ok(r.situation.profileId.includes('frequency_deterioration') && r.situation.profileId.includes('bess_outage_or_low_soc'));
    assert.deepEqual(r.situation.objectives.slice(0, 2), ['security', 'reliability']);
    // reserve requirement is raised by the low-frequency rule (x1.6) compared with a calm reference
    const calm = cases.c4ref.out.blocks[0].reserveUpReq / 1;
    assert.ok(r.out.blocks[0].reserveUpReq > calm * 1.2, 'upward reserve requirement raised under low frequency');
    assert.ok(r.situation.rationale.some((s) => s.toLowerCase().includes('frequency')), 'the audit explains which events drove the profile');
    assert.ok(r.situation.frequencyNote.includes('cannot'), 'system-level frequency is distinguished from the DISCOM response');
    assert.equal(r.out.unservedMWh! < 0.05, true);
  });

  // ------------------------------------------------------------------ 10
  it('10. infeasible case: demand cannot be met, reported as a shortfall with the limits that bind, no hard constraint broken', () => {
    const r = cases.c10;
    assertSound(r, 'c10');
    assert.equal(r.out.feasibility, 'shortfall');
    assert.ok(r.out.unservedMWh! > 100, 'unserved energy is reported, not hidden');
    assert.ok((r.out.conflicts ?? []).length > 0, `limits named: ${r.out.conflicts}`);
    assert.ok((r.out.conflicts ?? []).some((c) => /import|thermal|battery/i.test(c)));
    // critical customers are protected: unserved energy never exceeds the non-critical demand
    const crit = r.input.portfolio.customers.filter((c) => c.criticality === 'critical').reduce((a, c) => a + (r.input.view.demand[0][c.id] ?? 0), 0);
    r.out.blocks.forEach((b) => assert.ok(b.flows.unserved <= b.flows.demand - crit + 0.5, 'critical load is served first'));
    // every other objective is still reported
    assert.ok(r.out.stages!.some((s) => s.group === 'reliability' && (s.metric ?? 0) > 0));
  });

  // ------------------------------------------------------------------ properties of the method
  it('lexicographic ordering: a higher-ranked objective is never traded against a lower one', async () => {
    const base = cases.c1;
    // cost ranked above reserve in the normal profile: cost cannot get worse, reserve shortfall cannot get better
    const costFirst = await runScenario({ startBlock: 40, H: 36, damLocks: lockFrom(dam1), baseline: toBaseline(dam1), policy: (c) => { c.profiles.normal.objectives = ['reliability', 'cost', 'reserve', 'imbalance', 're_utilisation', 'bess_flex']; } });
    assertSound(costFirst, 'costFirst');
    const o = stageOrder(costFirst);
    assert.ok(o.indexOf('cost') < o.indexOf('reserve'));
    assert.ok(costFirst.out.costBreakdown!.total <= base.out.costBreakdown!.total * 1.004, 'ranking cost higher cannot raise cost');
    assert.ok(resShort(costFirst) >= resShort(base) - 0.05, 'ranking reserve lower cannot improve reserve');
    // reliability above cost: unserved energy is minimised even when that is expensive
    const r = cases.c10;
    const rel = r.out.stages!.find((s) => s.group === 'reliability')!;
    assert.ok(rel.metric! >= 0 && rel.status !== 'Skipped');
    const unservedIfCostFirst = await runScenario({ startBlock: 64, H: 12, loadMult: 2.6, thermalCap: { 'th-base': 0.5 }, policy: (c) => { c.profiles.evening_ramp.objectives = ['cost', 'reliability', 'reserve', 'imbalance', 'bess_flex']; c.profiles.thermal_unit_failure.objectives = ['cost', 'reliability', 'reserve', 'imbalance']; } });
    assert.ok(r.out.unservedMWh! <= unservedIfCostFirst.out.unservedMWh! + 0.5, 'ranking reliability first gives the least unserved energy');
  });

  it('the same inputs always give the same decision', async () => {
    const again = await runScenario({ startBlock: 40, H: 36, damLocks: lockFrom(dam1), baseline: toBaseline(dam1) });
    assert.equal(again.situation.profileId, cases.c1.situation.profileId);
    assert.ok(Math.abs(again.out.costBreakdown!.total - cases.c1.out.costBreakdown!.total) < 1, 'identical cost');
  });

  it('hysteresis and persistence: a condition must persist before it changes the profile, and lingers until it clears', async () => {
    const spike = { startBlock: 64, H: 24, priceMult: (_t: number, b: number) => (b >= 74 ? 1.8 : 1), stateless: false, timeSec: 1 };
    const first = await runScenario({ ...spike, hysteresis: {} });
    const e1 = first.situation.events.find((e) => e.kind === 'price_spike')!;
    assert.equal(e1.active, false, 'first evaluation above the threshold is only a candidate');
    assert.ok((e1.note ?? '').includes('waiting'));
    const second = await runScenario({ ...spike, hysteresis: first.hysteresis });
    assert.equal(second.situation.events.find((e) => e.kind === 'price_spike')!.active, true, 'second consecutive evaluation confirms it');
    // prices fall back: still active for the hold period, then released
    const calm = { startBlock: 40, H: 24, stateless: false, timeSec: 1 };
    const c1 = await runScenario({ ...calm, hysteresis: second.hysteresis });
    const ev1 = c1.situation.events.find((e) => e.kind === 'price_spike');
    assert.equal(ev1?.active, true, 'held for the minimum period');
    const c2 = await runScenario({ ...calm, hysteresis: c1.hysteresis });
    const c3 = await runScenario({ ...calm, hysteresis: c2.hysteresis });
    assert.equal(c3.situation.events.find((e) => e.kind === 'price_spike')?.active ?? false, false, 'released after the hold period');
  });

  it('policy file validation rejects inconsistent edits', () => {
    const cfg = cloneDeep(getPolicy());
    assert.deepEqual(validatePolicy(cfg), []);
    const a = cloneDeep(cfg); (a.profiles.normal.objectives as string[]).push('nonsense');
    assert.ok(validatePolicy(a).some((e) => e.includes('unknown objective')));
    const b = cloneDeep(cfg); b.events.price_spike.exit = b.events.price_spike.enter + 1;
    assert.ok(validatePolicy(b).some((e) => e.includes('hysteresis')));
    const c = cloneDeep(cfg); c.events.evening_ramp.profile = 'does_not_exist';
    assert.ok(validatePolicy(c).some((e) => e.includes('not a defined profile')));
  });

  it('the action sets state what is allowed and what is excluded, and why', () => {
    const r = cases.c1;
    const s = summariseCandidates(r.candidates);
    assert.ok(s.considered.thermal > 0 && s.considered.bess > 0 && s.considered.renewables > 0 && s.considered.market > 0);
    assert.ok(s.excluded.some((x) => x.category === 'demand_response' && x.reason.includes('not permitted')), 'demand response is excluded on a normal day, with the reason');
    const stress = summariseCandidates(cases.c5.candidates);
    assert.ok(!stress.excluded.some((x) => x.category === 'demand_response' && x.asset === 'c-cement'), 'demand response is a candidate during a demand spike');
    for (const c of r.candidates) assert.ok(c.constraints.length > 0 || c.mode === 'excluded');
  });

  // ------------------------------------------------------------------ regression: validated results must not drift silently
  it('regression: key results of the ten validated cases are unchanged', () => {
    const file = fileURLToPath(new URL('./golden.json', import.meta.url));
    const snap: Record<string, any> = {};
    for (const [k, r] of Object.entries(cases)) {
      snap[k] = {
        profile: r.situation.profileId,
        stages: stageOrder(r).map((g) => (g === 'tie' ? 'tie_break' : GROUP_OBJECTIVE[g])),
        feasibility: r.out.feasibility,
        costK: Math.round(r.out.costBreakdown!.total),
        unservedMWh: Math.round((r.out.unservedMWh ?? 0) * 10) / 10,
        curtailMWh: Math.round(curtailMWh(r)),
        drMWh: Math.round(drMWh(r)),
        thermalMWh: Math.round(sum(r, (b) => b.flows.thermal * DT)),
      };
    }
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) { writeFileSync(file, JSON.stringify(snap, null, 2) + '\n'); return; }
    const gold = JSON.parse(readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(snap)) {
      const g = gold[k];
      assert.ok(g, `${k}: no golden entry (run UPDATE_GOLDEN=1 npm test after a deliberate change)`);
      assert.equal(v.profile, g.profile, `${k}: active profile changed`);
      assert.deepEqual(v.stages, g.stages, `${k}: objective order changed`);
      assert.equal(v.feasibility, g.feasibility, `${k}: feasibility changed`);
      assert.ok(Math.abs(v.costK - g.costK) <= Math.max(25, 0.01 * g.costK), `${k}: cost ${v.costK} vs ${g.costK}`);
      assert.ok(Math.abs(v.unservedMWh - g.unservedMWh) <= 1, `${k}: unserved ${v.unservedMWh} vs ${g.unservedMWh}`);
      assert.ok(Math.abs(v.curtailMWh - g.curtailMWh) <= 10, `${k}: curtailment ${v.curtailMWh} vs ${g.curtailMWh}`);
      assert.ok(Math.abs(v.drMWh - g.drMWh) <= 10, `${k}: demand response ${v.drMWh} vs ${g.drMWh}`);
      assert.ok(Math.abs(v.thermalMWh - g.thermalMWh) <= Math.max(25, 0.02 * g.thermalMWh), `${k}: thermal ${v.thermalMWh} vs ${g.thermalMWh}`);
    }
  });
});
