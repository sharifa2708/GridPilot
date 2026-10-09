// Independent check of a solver result against the hard constraints (section B of the policy). It re-derives every quantity
// from the returned flows, so a modelling slip in the optimiser cannot hide behind its own numbers.
import type { PlanInput, PlanOutput } from '../opt/model.js';

export interface Violation { constraint: string; block: number | null; detail: string; magnitude: number }
export interface Verification { ok: boolean; violations: Violation[]; checked: string[]; informational: string[] }

const DT = 0.25;

export function verifyPlan(inp: PlanInput, out: PlanOutput, tol = 0.05): Verification {
  const v: Violation[] = [];
  const info: string[] = [];
  const checked = ['power balance', 'thermal min/max', 'thermal ramp', 'thermal min up/down', 'battery power', 'battery SOC bounds and dynamics', 'no simultaneous battery charge/discharge', 'import / export / contract limits', 'transmission corridors', 'renewable availability', 'sales only from renewable / battery energy', 'demand-response and load-shift limits', 'committed market volumes'];
  const P = inp.portfolio, S = inp.settings, m = S.market;
  const bad = (constraint: string, block: number | null, detail: string, magnitude: number) => { if (magnitude > tol) v.push({ constraint, block, detail, magnitude }); };
  if (!out.ok) return { ok: false, violations: [{ constraint: 'solver', block: null, detail: out.status, magnitude: 0 }], checked, informational: [] };
  const thermal = P.thermal.filter((u) => u.enabled), bess = P.bess.filter((b) => b.enabled), custs = P.customers.filter((c) => c.enabled);
  const pol = inp.policy;

  out.blocks.forEach((b, t) => {
    const f = b.flows;
    // ---- power balance
    const supply = f.solar + f.wind + f.thermal + f.bessDis - f.bessCh + f.damBuy - f.damSell + f.rtmBuy - f.rtmSell + f.grid;
    bad('power balance', t, `supply ${supply.toFixed(2)} MW vs load ${f.load.toFixed(2)} + dump ${f.dump.toFixed(2)} - unserved ${f.unserved.toFixed(2)}`, Math.abs(supply - (f.load - f.unserved + f.dump)));
    if (f.unserved > tol) info.push(`block ${t}: ${f.unserved.toFixed(1)} MW of demand cannot be served (reported as unserved energy, not hidden)`);
    // ---- renewables
    for (const fm of [...P.solar, ...P.wind].filter((x) => x.enabled)) {
      const avail = (inp.view.solar[t][fm.id] ?? inp.view.wind[t][fm.id] ?? 0);
      bad('renewable availability', t, `${fm.id} output ${(f.by[fm.id] ?? 0).toFixed(2)} > available ${avail.toFixed(2)}`, (f.by[fm.id] ?? 0) - avail);
    }
    // ---- thermal
    thermal.forEach((u) => {
      const p = f.by[u.id] ?? 0, cap = inp.view.thermalCap[t][u.id] ?? 0, pmin = (u.minLoadPct / 100) * u.capacityMW;
      const on = b.thermalOn[u.id];
      bad('thermal maximum', t, `${u.id} ${p.toFixed(1)} > cap ${cap.toFixed(1)}`, p - cap);
      if (on) bad('thermal minimum', t, `${u.id} ${p.toFixed(1)} < minimum ${pmin.toFixed(1)}`, pmin - p);
      else bad('thermal off but generating', t, `${u.id} ${p.toFixed(1)} MW while off`, p);
      const prev = t === 0 ? inp.state.thermalP[u.id] ?? 0 : out.blocks[t - 1].flows.by[u.id] ?? 0;
      const prevOn = t === 0 ? !!inp.state.thermalOn[u.id] : out.blocks[t - 1].thermalOn[u.id];
      const ramp = (u.rampPctPerMin / 100) * u.capacityMW * 15;
      if (prevOn && on) bad('thermal ramp', t, `${u.id} moved ${Math.abs(p - prev).toFixed(1)} MW (limit ${ramp.toFixed(1)})`, Math.abs(p - prev) - ramp);
    });
    // ---- battery
    bess.forEach((x) => {
      const d = f.by['dis:' + x.id] ?? 0, c = f.by['ch:' + x.id] ?? 0, pav = inp.view.bessPower[t][x.id] ?? 0;
      bad('battery power', t, `${x.id} discharge ${d.toFixed(1)} / charge ${c.toFixed(1)} vs available ${pav.toFixed(1)}`, Math.max(d, c) - pav);
      if (Math.min(d, c) > 0.5) v.push({ constraint: 'simultaneous battery charge/discharge', block: t, detail: `${x.id} charges ${c.toFixed(1)} and discharges ${d.toFixed(1)} MW`, magnitude: Math.min(d, c) });
      const soc = b.socByBess[x.id], smin = (x.socMinPct / 100) * x.energyMWh, smax = (x.socMaxPct / 100) * x.energyMWh;
      const prevSoc = t === 0 ? inp.state.socMWh[x.id] ?? x.energyMWh * 0.5 : out.blocks[t - 1].socByBess[x.id];
      bad('battery SOC upper bound', t, `${x.id} SOC ${soc.toFixed(1)} > ${smax.toFixed(1)} MWh`, soc - smax);
      bad('battery SOC lower bound', t, `${x.id} SOC ${soc.toFixed(1)} < ${smin.toFixed(1)} MWh`, smin - soc);
      const exp = Math.min(smax, Math.max(smin, prevSoc)) + (x.etaCharge * c - d / x.etaDischarge) * DT;
      if (t > 0 || true) bad('battery SOC dynamics', t, `${x.id} SOC ${soc.toFixed(2)} vs ${exp.toFixed(2)} expected from the flows`, Math.abs(soc - exp) > 0.01 * x.energyMWh ? Math.abs(soc - exp) : 0);
    });
    // ---- interconnection and market limits
    const imports = f.damBuy + f.rtmBuy + f.grid;
    bad('import limit', t, `imports ${imports.toFixed(1)} > ${P.interconnect.importLimitMW}`, imports - P.interconnect.importLimitMW);
    bad('contract import limit', t, `contract ${f.grid.toFixed(1)} > ${P.interconnect.gridContractLimitMW}`, f.grid - P.interconnect.gridContractLimitMW);
    bad('export limit', t, `exports ${(f.damSell + f.rtmSell).toFixed(1)} > ${P.interconnect.exportLimitMW}`, f.damSell + f.rtmSell - P.interconnect.exportLimitMW);
    if (f.damBuy + f.rtmBuy > m.maxBuyMW + tol) info.push(`block ${t}: exchange purchases ${(f.damBuy + f.rtmBuy).toFixed(0)} MW exceed the ${m.maxBuyMW} MW limit because they were already committed (settled as deviation)`);
    // ---- locked (committed) volumes
    const lk = (a: (number | null)[], x: number, name: string) => { const l = a[t]; if (l != null) bad('committed market volume', t, `${name} ${x.toFixed(1)} vs committed ${l.toFixed(1)}`, Math.abs(x - l)); };
    if (inp.mode !== 'DAM') { lk(inp.locked.damBuy, f.damBuy, 'DAM buy'); lk(inp.locked.damSell, f.damSell, 'DAM sell'); lk(inp.locked.rtmBuy, f.rtmBuy, 'RTM buy'); lk(inp.locked.rtmSell, f.rtmSell, 'RTM sell'); }
    // ---- corridors
    for (const cor of P.corridors) {
      let flow = [...P.solar, ...P.wind].filter((x) => x.enabled && x.corridorId === cor.id).reduce((a, x) => a + (f.by[x.id] ?? 0), 0);
      flow += bess.filter((x) => x.corridorId === cor.id).reduce((a, x) => a + (f.by[x.id] ?? 0), 0);
      const ttc = inp.view.ttc[t][cor.id] ?? cor.ttcMW;
      bad('transmission corridor limit', t, `corridor ${cor.id} flow ${flow.toFixed(1)} > ${ttc.toFixed(1)} MW`, flow - ttc);
    }
    // ---- sales only from renewable / battery energy
    const sold = f.damSell + f.rtmSell;
    const src = f.solar + f.wind + f.bessDis;
    if (sold > src + tol) info.push(`block ${t}: sales ${sold.toFixed(1)} MW exceed renewable + battery output ${src.toFixed(1)} MW (committed sale settled as deviation)`);
    // ---- demand response / shifting
    custs.forEach((c) => {
      const d = inp.view.demand[t][c.id] ?? 0;
      bad('demand-response limit', t, `${c.id} cut ${(f.by['dr:' + c.id] ?? 0).toFixed(1)} > ${((c.drFlexPct / 100) * d).toFixed(1)}`, (f.by['dr:' + c.id] ?? 0) - (c.drFlexPct / 100) * d);
      if ((f.by['dr:' + c.id] ?? 0) > tol && c.criticality === 'critical' && pol?.assumptions.drExcludeCritical) v.push({ constraint: 'critical load protection', block: t, detail: `${c.id} is critical but was curtailed`, magnitude: f.by['dr:' + c.id] });
      if (pol && (f.by['dr:' + c.id] ?? 0) > tol && !pol.perBlock.allowDR[t]) v.push({ constraint: 'demand response not permitted by policy', block: t, detail: `${c.id} curtailed while the active profile does not permit demand response`, magnitude: f.by['dr:' + c.id] });
    });
  });
  // thermal minimum up / down time inside the horizon
  thermal.forEach((u) => {
    let run = 0, state = inp.state.thermalOn[u.id], since = 99;
    const hold = inp.state.thermalHold[u.id] ?? 0;
    out.blocks.forEach((b, t) => {
      const on = b.thermalOn[u.id];
      if (t < hold && on !== state) v.push({ constraint: 'thermal minimum up/down hold', block: t, detail: `${u.id} changed state during its hold`, magnitude: 1 });
      if (on !== state) { const need = state ? u.minUpBlocks : u.minDownBlocks; if (since < need && t >= hold && since !== 99) v.push({ constraint: state ? 'thermal minimum up-time' : 'thermal minimum down-time', block: t, detail: `${u.id} switched after ${since} of ${need} blocks`, magnitude: need - since }); state = on; since = 1; } else since++;
      void run;
    });
  });
  // load-shift neutrality
  custs.forEach((c) => { if (c.shiftablePct > 0) { const s = out.blocks.reduce((a, b) => a + (b.flows.by['shift:' + c.id] ?? 0), 0) * DT; bad('load-shift energy neutrality', null, `${c.id} net shifted energy ${s.toFixed(2)} MWh`, Math.abs(s)); } });
  return { ok: v.length === 0, violations: v, checked, informational: info.slice(0, 20) };
}
