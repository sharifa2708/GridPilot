// Situation assessment: detects what is going on (from actual data, forecasts, asset status, market conditions and the
// maintenance schedule), estimates severity / duration / confidence, applies hysteresis and a persistence rule so that
// noise does not flip the objective profile, and merges the profiles of all active events into ONE ranked objective list.
// Every number comes from the data and from policy.config.json; nothing here is tied to a particular scenario.
import type { MaintenanceItem, Portfolio, ScenarioEvent, Settings } from '../types.js';
import type { AgentView } from '../twin.js';
import type { DetectedEvent, EventKind, HysteresisState, ObjectiveId, PolicyConfig, Situation } from './types.js';

export interface SituationCtx {
  cfg: PolicyConfig;
  P: Portfolio;
  S: Settings;
  view: AgentView;
  H: number;
  slot0: number; // first planned block
  socMWh: Record<string, number>;
  freq: number;
  events: ScenarioEvent[]; // announced scenario events
  maint: MaintenanceItem[];
  last: { dsmMW: number; dsmBand: number; ratioSolar: number; ratioWind: number; ratioLoad: number };
  committedBuy: number[]; // MW already bought per planned block (cannot be undone)
  baseline: { demand: number; solar: number; wind: number } | null; // forecasts the committed schedule was built on, first block
  hysteresis: HysteresisState;
  stateless?: boolean; // planning what-ifs: events count immediately (no persistence / hold)
}

const OBJ_ORDER: ObjectiveId[] = ['security', 'reliability', 'reserve', 'imbalance', 'cost', 're_utilisation', 'bess_flex'];
const sumv = (o: Record<string, number> | undefined) => (o ? Object.values(o).reduce((a, b) => a + b, 0) : 0);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const f0 = (x: number) => x.toFixed(0);

interface Raw { raw: number; start: number; end: number; assets: string[]; evidence: string; meta?: Record<string, any> }

export function detectRaw(c: SituationCtx): Partial<Record<EventKind, Raw>> {
  const { cfg, P, S, view, H } = c;
  const out: Partial<Record<EventKind, Raw>> = {};
  const win = (k: EventKind) => Math.min(H, cfg.events[k].windowBlocks);
  const bess = P.bess.filter((b) => b.enabled);
  const thermal = P.thermal.filter((u) => u.enabled);
  const custs = P.customers.filter((x) => x.enabled);
  const load = (t: number) => sumv(view.demand[t]);
  const re = (t: number) => sumv(view.solar[t]) + sumv(view.wind[t]);
  const net = (t: number) => load(t) - re(t);
  const bessP = (t: number) => bess.reduce((a, b) => a + (view.bessPower[t][b.id] ?? 0), 0);
  const bessNominal = bess.reduce((a, b) => a + b.powerMW, 0);

  // ---- 1. frequency deterioration (system-level condition; the DISCOM can only respond with its own resources)
  {
    const w = win('frequency_deterioration');
    let dev = Math.abs(c.freq - 50), dir: 'low' | 'high' = c.freq < 50 ? 'low' : 'high', ev = '';
    for (const e of c.events) {
      if ((e.type === 'freq_dip' || e.type === 'freq_high') && e.startSlot < c.slot0 + w && e.endSlot > c.slot0 && e.magnitude > dev) { dev = e.magnitude; dir = e.type === 'freq_dip' ? 'low' : 'high'; ev = ` (${e.label})`; }
    }
    if (dev > 0) out.frequency_deterioration = { raw: dev, start: 0, end: w - 1, assets: ['control area'], evidence: `frequency ${c.freq.toFixed(3)} Hz${ev}; ${dir === 'low' ? 'under-frequency: demand exceeds supply on the interconnected grid' : 'over-frequency: supply exceeds demand on the interconnected grid'}`, meta: { dir } };
  }

  // ---- 2. renewable surplus: more must-take energy than demand, storage and export can absorb
  {
    const w = win('renewable_surplus');
    const mustRunMin = thermal.filter((u) => u.mustRun).reduce((a, u) => a + (u.minLoadPct / 100) * u.capacityMW, 0);
    const room = bess.reduce((a, b) => a + Math.max(0, (b.socMaxPct / 100) * b.energyMWh - (c.socMWh[b.id] ?? 0)) / b.etaCharge, 0);
    let best = 0, bs = -1, be = -1;
    for (let t = 0; t < w; t++) {
      const s = re(t) + mustRunMin + (c.committedBuy[t] ?? 0) - load(t) - Math.min(bessP(t), room) - P.interconnect.exportLimitMW;
      if (s > best) best = s;
      if (s > cfg.events.renewable_surplus.exit) { if (bs < 0) bs = t; be = t; }
    }
    if (best > 0) out.renewable_surplus = { raw: best, start: Math.max(0, bs), end: Math.max(0, be), assets: [...P.solar, ...P.wind].filter((f) => f.enabled).map((f) => f.id), evidence: `forecast surplus of ${f0(best)} MW beyond what demand, battery charging and export can take (must-run thermal ${f0(mustRunMin)} MW)` };
  }

  // ---- 3. evening ramp: steep rise of the net load (demand minus renewables)
  {
    const w = win('evening_ramp'), L = cfg.events.evening_ramp.rampLookBlocks ?? 8;
    let best = 0, at = 0;
    for (let t = 0; t + L < Math.min(H, w + L); t++) {
      const r = net(t + L) - net(t);
      if (r > best) { best = r; at = t; }
    }
    if (best > 0) out.evening_ramp = { raw: best, start: at, end: Math.min(H - 1, at + L), assets: thermal.map((u) => u.id), evidence: `net load rises ${f0(best)} MW over ${(L * 15) / 60} h (${f0(net(at))} → ${f0(net(Math.min(H - 1, at + L)))} MW)` };
  }

  // ---- 4. market price spike
  {
    const w = win('price_spike');
    let mx = 0, at = 0, first = -1, last = -1;
    for (let t = 0; t < w; t++) {
      const px = Math.max(view.damFc[t], view.rtmFc[t]);
      if (px > mx) { mx = px; at = t; }
      if (px >= cfg.events.price_spike.exit) { if (first < 0) first = t; last = t; }
    }
    if (mx > 0) out.price_spike = { raw: mx, start: Math.max(0, first), end: Math.max(0, last), assets: ['exchange'], evidence: `forecast price peaks at ₹${mx.toFixed(2)}/kWh in block +${at + 1}` };
  }

  // ---- 5. BESS outage or low SOC ahead of a stressed window
  if (bess.length) {
    const w = win('bess_outage_or_low_soc');
    let avail = 1, at = 0;
    for (let t = 0; t < w; t++) { const a = bessNominal > 0 ? bessP(t) / bessNominal : 1; if (a < avail) { avail = a; at = t; } }
    const E = bess.reduce((a, b) => a + b.energyMWh, 0);
    const socPct = (bess.reduce((a, b) => a + (c.socMWh[b.id] ?? 0), 0) / Math.max(1, E)) * 100;
    const lowPct = cfg.events.bess_outage_or_low_soc.lowSocPct ?? 30;
    const stressAhead = (out.evening_ramp?.raw ?? 0) >= cfg.events.evening_ramp.exit || (out.price_spike?.raw ?? 0) >= cfg.events.price_spike.exit;
    const lowShare = socPct < lowPct && stressAhead ? (lowPct - socPct) / lowPct : 0;
    const raw = Math.max(1 - avail, lowShare);
    if (raw > 0) out.bess_outage_or_low_soc = { raw, start: 0, end: w - 1, assets: bess.filter((b) => (view.bessPower[at][b.id] ?? 0) < b.powerMW * 0.99).map((b) => b.id).concat(lowShare > 0 ? ['SOC'] : []), evidence: 1 - avail >= lowShare ? `battery power available drops to ${f0(avail * 100)}% of nominal in block +${at + 1}` : `battery at ${f0(socPct)}% SOC (below ${f0(lowPct)}%) with a stressed window ahead` };
  }

  // ---- 6. transmission constraint
  {
    const w = win('transmission_constraint');
    let best = 0, at = 0, cid = '';
    for (const k of P.corridors) for (let t = 0; t < w; t++) {
      const ttc = view.ttc[t][k.id] ?? k.ttcMW;
      const derate = 1 - ttc / Math.max(1, k.ttcMW);
      const flow = [...P.solar, ...P.wind].filter((f) => f.corridorId === k.id && f.enabled).reduce((a, f) => a + (view.solar[t][f.id] ?? 0) + (view.wind[t][f.id] ?? 0), 0);
      const over = flow / Math.max(1, ttc) - 1;
      const r = Math.max(derate, over);
      if (r > best) { best = r; at = t; cid = k.id; }
    }
    if (best > 0) out.transmission_constraint = { raw: best, start: 0, end: w - 1, assets: [cid], evidence: `corridor ${cid} transfer limit reduced / exceeded by ${(best * 100).toFixed(0)}% in block +${at + 1}` };
  }

  // ---- 7. unexpected demand spike
  {
    const w = win('demand_spike');
    let raw = Math.max(0, c.last.ratioLoad - 1), ev = raw > 0 ? `last block demand was ${(raw * 100).toFixed(1)}% above forecast` : '';
    if (c.baseline && c.baseline.demand > 1) {
      const up = (load(0) - c.baseline.demand) / c.baseline.demand;
      if (up > raw) { raw = up; ev = `demand forecast is ${(up * 100).toFixed(1)}% above the committed schedule`; }
    }
    if (raw > 0) out.demand_spike = { raw, start: 0, end: w - 1, assets: custs.map((x) => x.id), evidence: ev };
  }

  // ---- 8. renewable forecast error
  {
    const w = win('renewable_forecast_error');
    const wf = cfg.events.renewable_forecast_error.windFactor ?? 1.7;
    const eS = Math.abs(c.last.ratioSolar - 1), eW = Math.abs(c.last.ratioWind - 1) / wf;
    const raw = Math.max(eS, eW);
    if (raw > 0) out.renewable_forecast_error = { raw, start: 0, end: w - 1, assets: eS >= eW ? P.solar.map((f) => f.id) : P.wind.map((f) => f.id), evidence: `last block ${eS >= eW ? 'solar' : 'wind'} output was ${((eS >= eW ? c.last.ratioSolar : c.last.ratioWind) * 100 - 100).toFixed(0)}% from forecast` };
  }

  // ---- 9. thermal unit failure (unplanned loss of capacity; approved maintenance is reported separately)
  {
    const w = win('thermal_unit_failure');
    const lost: { id: string; mw: number }[] = [];
    for (const u of thermal) {
      let cap0 = Infinity;
      for (let t = 0; t < Math.min(H, 4); t++) cap0 = Math.min(cap0, view.thermalCap[t][u.id] ?? 0);
      if (cap0 < u.capacityMW * 0.99) {
        const planned = c.maint.some((m) => m.assetId === u.id && m.type === 'planned' && m.status !== 'deferred' && m.startSlot <= c.slot0 && m.endSlot > c.slot0);
        if (!planned) lost.push({ id: u.id, mw: u.capacityMW - cap0 });
      }
    }
    const lostMW = lost.reduce((a, l) => a + l.mw, 0);
    if (lostMW > 0) out.thermal_unit_failure = { raw: lostMW / Math.max(1, load(0)), start: 0, end: w - 1, assets: lost.map((l) => l.id), evidence: `${f0(lostMW)} MW of thermal capacity unavailable (${lost.map((l) => l.id).join(', ')})` };
  }
  void S;
  return out;
}

function stepHysteresis(state: HysteresisState, kind: EventKind, raw: number, rule: { enter: number; exit: number; persistBlocks: number; holdBlocks: number }) {
  const e = { ...(state[kind] ?? { active: false, above: 0, below: 0 }) };
  let note: string | undefined;
  if (!e.active) {
    if (raw >= rule.enter) { e.above++; e.below = 0; if (e.above >= rule.persistBlocks) { e.active = true; e.above = 0; } else note = `waiting: above threshold for ${e.above} of ${rule.persistBlocks} required evaluations`; }
    else { e.above = 0; }
  } else {
    if (raw <= rule.exit) { e.below++; if (e.below >= rule.holdBlocks) { e.active = false; e.below = 0; } else note = `clearing: below the exit threshold for ${e.below} of ${rule.holdBlocks} required evaluations (still treated as active)`; }
    else e.below = 0;
  }
  state[kind] = e;
  return { active: e.active, note };
}

export function assessSituation(c: SituationCtx): { situation: Situation; hysteresis: HysteresisState } {
  const { cfg } = c;
  const state: HysteresisState = JSON.parse(JSON.stringify(c.hysteresis ?? {}));
  const raws = detectRaw(c);
  const events: DetectedEvent[] = [];
  const kinds = Object.keys(cfg.events) as EventKind[];
  for (const kind of kinds) {
    const rule = cfg.events[kind];
    const r = raws[kind] ?? { raw: 0, start: 0, end: 0, assets: [], evidence: '' };
    const h = stepHysteresis(state, kind, r.raw, c.stateless ? { ...rule, persistBlocks: 1, holdBlocks: 1 } : rule);
    if (!h.active && r.raw <= rule.exit && !(state[kind]?.above)) continue; // nothing to report
    const lead = r.start;
    const conf = clamp(0.97 - 0.01 * lead - (c.view.stormRisk[Math.min(lead, c.view.stormRisk.length - 1)] > 0.5 ? 0.1 : 0), 0.5, 0.98);
    events.push({
      kind, severity: h.active ? clamp(r.raw / rule.scale, 0.15, 1) : clamp(r.raw / rule.scale, 0, 1), confidence: conf, raw: r.raw,
      startBlock: r.start, endBlock: r.end, assets: r.assets, evidence: r.evidence, active: h.active, note: h.note, ...(r.meta ? { meta: r.meta } : {}),
    } as DetectedEvent);
  }
  const active = events.filter((e) => e.active);
  const activeKinds = active.map((e) => e.kind);

  // ---- interactions: events that happen together change the picture
  const interactions: string[] = [];
  const boost: Partial<Record<EventKind, number>> = {};
  for (const it of cfg.combine.interactions) {
    if (it.events.every((k) => activeKinds.includes(k))) {
      interactions.push(it.note);
      for (const k of it.events) boost[k] = Math.max(boost[k] ?? 1, it.boost);
    }
  }
  // planned maintenance that overlaps a stressed window is reported (it is approved, so it is not a "failure")
  for (const m of c.maint) {
    if (m.type === 'planned' && m.status !== 'deferred' && m.startSlot < c.slot0 + 12 && m.endSlot > c.slot0 && active.length > 0)
      interactions.push(`Approved maintenance on ${m.assetName} (${m.description}) overlaps the current stressed period${m.deferrable ? '; it is marked deferrable, so a reschedule can be proposed for approval' : '; it is not deferrable'}.`);
  }

  // ---- combine the profiles of all active events into one ranking (severity- and confidence-weighted rank aggregation)
  const N = OBJ_ORDER.length;
  const scores: Record<string, number> = Object.fromEntries(OBJ_ORDER.map((o) => [o, 0]));
  const pts = (list: ObjectiveId[], w: number) => list.forEach((o, i) => { scores[o] += w * (N - i); });
  const rationale: string[] = [];
  pts(cfg.profiles.normal.objectives, cfg.combine.normalWeight);
  rationale.push(`Normal-operations profile counts with weight ${cfg.combine.normalWeight} as the baseline.`);
  for (const e of active) {
    const rule = cfg.events[e.kind];
    const w = rule.weight * e.severity * e.confidence * (boost[e.kind] ?? 1);
    pts(cfg.profiles[rule.profile].objectives, w);
    rationale.push(`${cfg.profiles[rule.profile].label}: severity ${(e.severity * 100).toFixed(0)}%, confidence ${(e.confidence * 100).toFixed(0)}%${boost[e.kind] ? `, boosted ×${boost[e.kind]} by an interaction` : ''} → weight ${w.toFixed(2)}. ${e.evidence}.`);
  }
  for (const e of events.filter((x) => !x.active && x.note)) rationale.push(`${cfg.profiles[cfg.events[e.kind].profile].label} detected but not acted on: ${e.note}.`);
  // ties are broken by the profile of the most severe active event, then by the default order
  const lead = [...active].sort((a, b) => b.severity * b.confidence - a.severity * a.confidence)[0];
  const tieOrder = lead ? cfg.profiles[cfg.events[lead.kind].profile].objectives : cfg.profiles.normal.objectives;
  const rank = (o: ObjectiveId) => { const i = tieOrder.indexOf(o); return i < 0 ? 99 : i; };
  const objectives = [...OBJ_ORDER].sort((a, b) => scores[b] - scores[a] || rank(a) - rank(b) || OBJ_ORDER.indexOf(a) - OBJ_ORDER.indexOf(b));
  // grid security is a hard constraint in every profile: its stage always comes first, so it is always shown first
  const shown: ObjectiveId[] = ['security', ...objectives.filter((o) => scores[o] > 0 && o !== 'security')];

  const perBlock: { kinds: EventKind[] }[] = [];
  for (let t = 0; t < c.H; t++) perBlock.push({ kinds: active.filter((e) => t >= e.startBlock && t <= e.endBlock).map((e) => e.kind) });

  const profileId = activeKinds.length ? activeKinds.join('+') : 'normal';
  const label = activeKinds.length ? activeKinds.map((k) => cfg.profiles[cfg.events[k].profile].label).join(' + ') : cfg.profiles.normal.label;
  const freq = active.find((e) => e.kind === 'frequency_deterioration');
  const frequencyNote = freq
    ? 'System frequency is a grid-wide condition that the DISCOM cannot set. Its own response is limited to: holding more reserve, avoiding over-drawal / extra purchases (low frequency) or extra injection (high frequency), and using the battery and thermal units for fast support.'
    : '';
  return {
    hysteresis: state,
    situation: { profileId, label, objectives: shown, events, activeKinds, interactions, scores, rationale, perBlock, frequencyNote },
  };
}
