// Digital twin: what physically happens (truth) vs. what the agent can forecast.
//  - weather comes from Open-Meteo (real) via data/weather.ts
//  - forecast error is applied as a day-level bias + AR(1) intra-day noise (seeded -> reproducible)
//  - scenario events perturb truth and, once announced, the agent's view
import type { Bess, Customer, LoadProfile, MaintenanceItem, Portfolio, ScenarioEvent, Settings, SolarFarm, ThermalUnit, WindFarm } from './types.js';
import { BLOCKS, ar1, blockOf, clamp, dayOf, dowOf, gauss, hashStr, hourly24To96, mulberry32, slotOf } from './util.js';
import { getWeather, sample } from './data/weather.js';
import { nationalStress } from './data/national.js';

const SHAPES: Record<LoadProfile, number[]> = {
  residential: [0.5, 0.46, 0.43, 0.41, 0.41, 0.46, 0.6, 0.68, 0.6, 0.5, 0.44, 0.42, 0.42, 0.42, 0.42, 0.45, 0.52, 0.68, 0.9, 1.0, 0.98, 0.9, 0.76, 0.6],
  commercial: [0.26, 0.24, 0.23, 0.23, 0.24, 0.28, 0.38, 0.56, 0.78, 0.92, 0.98, 1.0, 0.98, 0.96, 0.97, 0.96, 0.92, 0.85, 0.76, 0.66, 0.54, 0.42, 0.33, 0.29],
  'industrial-continuous': [0.93, 0.93, 0.92, 0.92, 0.92, 0.93, 0.95, 0.97, 0.99, 1.0, 1.0, 1.0, 0.99, 0.99, 1.0, 1.0, 1.0, 0.99, 0.98, 0.97, 0.96, 0.95, 0.94, 0.93],
  'industrial-twoshift': [0.5, 0.46, 0.44, 0.44, 0.46, 0.58, 0.82, 0.97, 1.0, 1.0, 0.99, 0.96, 0.9, 0.95, 1.0, 0.99, 0.95, 0.88, 0.74, 0.62, 0.56, 0.54, 0.52, 0.5],
  datacenter: [0.9, 0.89, 0.88, 0.88, 0.88, 0.89, 0.91, 0.94, 0.97, 0.99, 1.0, 1.0, 1.0, 1.0, 1.0, 0.99, 0.98, 0.97, 0.96, 0.95, 0.94, 0.93, 0.92, 0.91],
  agri: [0.85, 0.9, 0.92, 0.85, 0.7, 0.4, 0.25, 0.25, 0.3, 0.35, 0.35, 0.3, 0.28, 0.28, 0.3, 0.3, 0.28, 0.3, 0.4, 0.55, 0.75, 0.9, 0.95, 0.9],
  'mixed-feeder': [],
};
SHAPES['mixed-feeder'] = SHAPES.residential.map((v, i) => 0.6 * v + 0.4 * SHAPES.commercial[i]);
export const SHAPE96 = Object.fromEntries(Object.entries(SHAPES).map(([k, v]) => [k, hourly24To96(v)])) as Record<LoadProfile, number[]>;

// Typical IEX DAM MCP shape for October (₹/kWh), hourly anchors: night plateau, solar-hour trough, evening peak.
export const DAM_SHAPE = hourly24To96([4.6, 4.4, 4.3, 4.3, 4.5, 4.9, 5.2, 5.0, 4.2, 3.4, 2.9, 2.6, 2.5, 2.5, 2.6, 3.0, 3.6, 4.9, 7.0, 8.8, 9.3, 8.4, 6.9, 5.4]);
const FREQ_BASE = hourly24To96([0.0, 0.0, 0.005, 0.01, 0.0, -0.01, -0.025, -0.02, 0.0, 0.02, 0.035, 0.04, 0.04, 0.035, 0.03, 0.02, 0.0, -0.02, -0.04, -0.045, -0.03, -0.015, 0.0, 0.0]);

export interface Truth {
  solar: Record<string, number>;
  wind: Record<string, number>;
  demand: Record<string, number>;
  damPrice: number;
  rtmPrice: number;
  freq: number;
  thermalCap: Record<string, number>;
  bessPower: Record<string, number>;
  ttc: Record<string, number>;
  stormRisk: number;
}

interface DayInputs {
  day: number;
  solarFc: Record<string, number[]>;
  windFc: Record<string, number[]>;
  demandFc: Record<string, number[]>;
  solarT: Record<string, number[]>;
  windT: Record<string, number[]>;
  demandT: Record<string, number[]>;
  damFc: number[];
  damT: number[];
  rtmT: number[];
  freqT: number[];
  cloudMean: number;
  stormFlag: number[]; // 0..1 per block from weather
  stormWhy: string[];
}

export interface TwinCtx {
  portfolio: () => Portfolio;
  settings: () => Settings;
  events: () => ScenarioEvent[];
  maintenance: () => MaintenanceItem[];
  damUpload: () => Map<number, number[]>; // dayNo -> 96 prices (₹/kWh) from file upload
}

const PC_V = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
const PC_P = [0, 0.04, 0.11, 0.2, 0.31, 0.44, 0.59, 0.74, 0.88, 0.97, 1.0];
function curve(v: number): number {
  if (v < 3 || v >= 25) return 0;
  if (v >= 13) return 1;
  const i = Math.min(PC_V.length - 2, Math.floor(v - 3));
  return PC_P[i] + (PC_P[i + 1] - PC_P[i]) * (v - PC_V[i]);
}
export function windPower(v: number, tempC: number): number {
  // farm-level power curve (smoothed over turbine spread) with 0.9 availability/wake loss
  const dens = clamp((273.15 + 15) / (273.15 + tempC), 0.9, 1.1);
  return clamp(0.25 * curve(v - 1.2) + 0.5 * curve(v) + 0.25 * curve(v + 1.2), 0, 1) * 0.92 * dens;
}

export function createTwin(ctx: TwinCtx) {
  const cache = new Map<number, DayInputs>();
  let version = 0;

  const solarBlock = (f: SolarFarm, day: number, b: number) => {
    const w = getWeather(f.location.lat, f.location.lon, day);
    const ghi = sample(w, 'ghi', day, b);
    const t = sample(w, 'temp', day, b);
    const tcell = t + 0.03 * ghi;
    const derate = 1 - 0.0035 * Math.max(0, tcell - 25);
    return f.capacityMW * Math.min(1, ((f.dcAcRatio * ghi) / 1000) * f.performanceRatio * derate);
  };
  const windBlock = (f: WindFarm, day: number, b: number) => {
    const w = getWeather(f.location.lat, f.location.lon, day);
    const v100 = sample(w, 'wind100', day, b);
    const v = v100 * Math.pow(f.hubHeightM / 100, 0.14);
    return f.capacityMW * windPower(v, sample(w, 'temp', day, b));
  };
  const demandBlock = (c: Customer, day: number, b: number) => {
    const w = getWeather(c.location.lat, c.location.lon, day);
    const t = sample(w, 'temp', day, b);
    const dow = dowOf(day);
    const dowF = c.profile === 'residential' || c.profile === 'agri' ? 1 : dow === 0 ? 0.9 : dow === 6 ? 0.96 : 1;
    return c.peakMW * SHAPE96[c.profile][b] * (1 + c.coolingSensitivity * Math.max(0, t - 27)) * dowF * 0.93;
  };

  function build(day: number): DayInputs {
    const p = ctx.portfolio();
    const s = ctx.settings();
    const inp: DayInputs = {
      day, solarFc: {}, windFc: {}, demandFc: {}, solarT: {}, windT: {}, demandT: {},
      damFc: [], damT: [], rtmT: [], freqT: [], cloudMean: 0, stormFlag: [], stormWhy: [],
    };
    const commonS = ar1(`sc-${day}`, BLOCKS, 0.85);
    const commonW = ar1(`wc-${day}`, BLOCKS, 0.93);
    const biasRng = mulberry32(hashStr(`bias-${day}`));
    const dayBiasS = 1 + 0.06 * gauss(biasRng);
    const dayBiasW = 1 + 0.09 * gauss(biasRng);
    const dayBiasL = 1 + 0.025 * gauss(biasRng);
    let cloudSum = 0, cloudN = 0;

    for (const f of p.solar) {
      const w = getWeather(f.location.lat, f.location.lon, day);
      const idio = ar1(`si-${f.id}-${day}`, BLOCKS, 0.75);
      const fc: number[] = [], tr: number[] = [];
      for (let b = 0; b < BLOCKS; b++) {
        const base = solarBlock(f, day, b);
        const cloud = sample(w, 'cloud', day, b) / 100;
        cloudSum += cloud; cloudN++;
        const sigma = 0.03 + 0.5 * cloud * (1 - cloud);
        const z = 0.55 * commonS[b] + 0.835 * idio[b];
        const mult = base < 1 ? 1 : clamp(dayBiasS * (1 + sigma * z), 0.15, 1.18);
        fc.push(base);
        tr.push(Math.min(f.capacityMW, base * mult));
      }
      inp.solarFc[f.id] = fc; inp.solarT[f.id] = tr;
    }
    for (const f of p.wind) {
      const idio = ar1(`wi-${f.id}-${day}`, BLOCKS, 0.92);
      const w = getWeather(f.location.lat, f.location.lon, day);
      const fc: number[] = [], tr: number[] = [];
      for (let b = 0; b < BLOCKS; b++) {
        const base = windBlock(f, day, b);
        const v100 = sample(w, 'wind100', day, b);
        const z = 0.4 * commonW[b] + 0.917 * idio[b];
        const vAct = Math.max(0, v100 * dayBiasW * (1 + 0.06 * z)) * Math.pow(f.hubHeightM / 100, 0.14);
        fc.push(base);
        tr.push(f.capacityMW * windPower(vAct, sample(w, 'temp', day, b)));
      }
      inp.windFc[f.id] = fc; inp.windT[f.id] = tr;
    }
    for (const c of p.customers) {
      const n = ar1(`ld-${c.id}-${day}`, BLOCKS, 0.9);
      const fc: number[] = [], tr: number[] = [];
      for (let b = 0; b < BLOCKS; b++) {
        const base = demandBlock(c, day, b);
        fc.push(base);
        tr.push(base * dayBiasL * (1 + 0.012 * n[b]));
      }
      inp.demandFc[c.id] = fc; inp.demandT[c.id] = tr;
    }
    inp.cloudMean = cloudN ? cloudSum / cloudN : 0.3;

    // ----- prices -----
    const up = ctx.damUpload().get(day);
    const rng = mulberry32(hashStr(`px-${day}`));
    const stress = nationalStress(40); // live national stress as a day-level driver (neutral when feed is down)
    const level = clamp(1 + 0.1 * gauss(rng) + 0.8 * (stress - 1) + 0.15 * (inp.cloudMean - 0.3), 0.72, 1.35);
    const dayBiasP = 1 + 0.05 * gauss(rng);
    const nz = ar1(`pn-${day}`, BLOCKS, 0.8);
    const rz = ar1(`pr-${day}`, BLOCKS, 0.7);
    for (let b = 0; b < BLOCKS; b++) {
      const solarHour = b >= 40 && b <= 64 ? 1 : 0;
      const sunny = (0.5 - inp.cloudMean) * 0.3 * solarHour;
      let dam = up ? up[b] : DAM_SHAPE[b] * level * (1 + 0.04 * nz[b] - sunny);
      dam = clamp(dam, 1.0, s.market.priceCap);
      const rtm = clamp(dam * (1 + 0.07 * rz[b] + 0.35 * (stress - 1)), 0.8, s.market.priceCap);
      inp.damT.push(dam);
      inp.rtmT.push(rtm);
      inp.damFc.push(clamp(dam * dayBiasP * (1 + 0.04 * gauss(rng)), 1.0, s.market.priceCap));
    }
    // ----- frequency -----
    const fz = ar1(`fq-${day}`, BLOCKS, 0.88);
    for (let b = 0; b < BLOCKS; b++) inp.freqT.push(clamp(50 + FREQ_BASE[b] + 0.028 * fz[b], 49.8, 50.2));
    // ----- storm flags from the weather feed -----
    const firstWind = p.wind[0] ?? p.solar[0];
    for (let b = 0; b < BLOCKS; b++) {
      let risk = 0, why = '';
      if (firstWind) {
        const w = getWeather(firstWind.location.lat, firstWind.location.lon, day);
        const i = clamp((day - w.startDay) * 24 + Math.floor(b / 4), 0, w.code.length - 1);
        if (w.code[i] >= 95) { risk = 1; why = `thunderstorm forecast near ${firstWind.location.name}`; }
        else if (w.gust[i] >= 24) { risk = 0.8; why = `gusts ${(w.gust[i] * 3.6).toFixed(0)} km/h near ${firstWind.location.name}`; }
      }
      inp.stormFlag.push(risk); inp.stormWhy.push(why);
    }
    return inp;
  }

  const di = (day: number) => {
    let d = cache.get(day);
    if (!d) { d = build(day); cache.set(day, d); }
    return d;
  };

  const evActive = (slot: number, fn: (e: ScenarioEvent) => void, announcedOnly = false, nowSlot = slot) => {
    for (const e of ctx.events()) {
      if (slot < e.startSlot || slot >= e.endSlot) continue;
      if (announcedOnly && nowSlot < e.announceSlot) continue;
      fn(e);
    }
  };

  function maintCapMW(assetId: string, cap: number, slot: number): number {
    let c = cap;
    for (const m of ctx.maintenance()) {
      if (m.assetId !== assetId || m.status === 'deferred' || m.status === 'completed' && slot >= m.endSlot) continue;
      if (slot >= m.startSlot && slot < m.endSlot) c = Math.min(c, m.derateMW == null ? 0 : Math.max(0, cap - m.derateMW));
    }
    return c;
  }

  /** Apply event multipliers. `view`='truth' includes surprises; 'agent' includes only announced events. */
  function eventMults(slot: number, nowSlot: number, view: 'truth' | 'agent') {
    const out = {
      solar: {} as Record<string, number>, wind: {} as Record<string, number>, demand: {} as Record<string, number>,
      thermalOut: {} as Record<string, boolean>, bessOut: {} as Record<string, boolean>, ttc: {} as Record<string, number>,
      rtmMult: 1, freqDelta: 0, storm: false, refresh: false,
    };
    const p = ctx.portfolio();
    evActive(slot, (e) => {
      const m = e.magnitude;
      switch (e.type) {
        case 'cloud_cover':
          if (view === 'agent') break; // surprise: only visible after the fact through persistence
          for (const f of p.solar) if (!e.targetId || e.targetId === f.id) out.solar[f.id] = (out.solar[f.id] ?? 1) * (1 - m);
          break;
        case 'wind_surge':
          if (view === 'agent') break;
          for (const f of p.wind) if (!e.targetId || e.targetId === f.id) out.wind[f.id] = (out.wind[f.id] ?? 1) * (1 + m);
          break;
        case 'wind_drop':
          if (view === 'agent') break;
          for (const f of p.wind) if (!e.targetId || e.targetId === f.id) out.wind[f.id] = (out.wind[f.id] ?? 1) * (1 - m);
          break;
        case 'price_spike': if (view === 'truth') out.rtmMult *= 1 + m; break;
        case 'bess_outage': for (const b of p.bess) if (!e.targetId || e.targetId === b.id) out.bessOut[b.id] = true; break;
        case 'thermal_trip': for (const t of p.thermal) if (!e.targetId || e.targetId === t.id) out.thermalOut[t.id] = true; break;
        case 'line_limit': for (const c of p.corridors) if (!e.targetId || e.targetId === c.id) out.ttc[c.id] = (out.ttc[c.id] ?? 1) * (1 - m); break;
        case 'demand_surge':
          if (view === 'agent') break;
          for (const c of p.customers) if (!e.targetId || e.targetId === c.id) out.demand[c.id] = (out.demand[c.id] ?? 1) * (1 + m);
          break;
        case 'freq_dip': if (view === 'truth') out.freqDelta -= m; break;
        case 'freq_high': if (view === 'truth') out.freqDelta += m; break;
        case 'storm_alert':
          out.storm = true;
          for (const f of p.wind) out.wind[f.id] = (out.wind[f.id] ?? 1) * 0.05; // cut-out
          for (const f of p.solar) out.solar[f.id] = (out.solar[f.id] ?? 1) * 0.5;
          for (const c of p.corridors) out.ttc[c.id] = (out.ttc[c.id] ?? 1) * 0.8;
          break;
        case 'forecast_update': out.refresh = true; break;
      }
    }, view === 'agent', nowSlot);
    return out;
  }

  function truthAt(slot: number): Truth {
    const day = dayOf(slot), b = blockOf(slot);
    const d = di(day), p = ctx.portfolio();
    const ev = eventMults(slot, slot, 'truth');
    const t: Truth = { solar: {}, wind: {}, demand: {}, damPrice: d.damT[b], rtmPrice: 0, freq: 0, thermalCap: {}, bessPower: {}, ttc: {}, stormRisk: d.stormFlag[b] };
    for (const f of p.solar) {
      const v = d.solarT[f.id]?.[b] ?? 0;
      t.solar[f.id] = f.enabled ? Math.min(maintCapMW(f.id, f.capacityMW, slot), v * (ev.solar[f.id] ?? 1)) : 0;
    }
    for (const f of p.wind) {
      const v = d.windT[f.id]?.[b] ?? 0;
      t.wind[f.id] = f.enabled ? Math.min(maintCapMW(f.id, f.capacityMW, slot), f.capacityMW, v * (ev.wind[f.id] ?? 1)) : 0;
    }
    for (const c of p.customers) t.demand[c.id] = c.enabled ? (d.demandT[c.id]?.[b] ?? 0) * (ev.demand[c.id] ?? 1) : 0;
    for (const u of p.thermal) t.thermalCap[u.id] = !u.enabled || ev.thermalOut[u.id] ? 0 : maintCapMW(u.id, u.capacityMW, slot);
    for (const x of p.bess) t.bessPower[x.id] = !x.enabled || ev.bessOut[x.id] ? 0 : maintCapMW(x.id, x.powerMW, slot);
    for (const c of p.corridors) t.ttc[c.id] = c.ttcMW * (ev.ttc[c.id] ?? 1);
    t.rtmPrice = clamp(d.rtmT[b] * ev.rtmMult, 0.8, ctx.settings().market.priceCap);
    t.freq = 50; // simplification: the grid is at 50 Hz; the DISCOM's own balance moves it (see the engine)
    return t;
  }

  /** Persistence ratios observed in the last executed block, per farm (actual / forecast). */
  interface Persist { solar: Record<string, number>; wind: Record<string, number>; demand: number; rtmSpread: number }

  interface AgentView {
    slots: number[];
    solar: Record<string, number>[]; wind: Record<string, number>[]; demand: Record<string, number>[];
    damFc: number[]; rtmFc: number[];
    thermalCap: Record<string, number>[]; bessPower: Record<string, number>[]; ttc: Record<string, number>[];
    stormRisk: number[]; stormWhy: string[];
    sigmaUp: number[]; // forecast uncertainty (MW) used for reserve sizing
  }

  /** What the agent believes about the next H blocks starting at slot0, given what it has observed. */
  function agentView(slot0: number, H: number, nowSlot: number, ps: Persist, clearedDam: (slot: number) => number | null): AgentView {
    const p = ctx.portfolio();
    const s = ctx.settings();
    const v: AgentView = { slots: [], solar: [], wind: [], demand: [], damFc: [], rtmFc: [], thermalCap: [], bessPower: [], ttc: [], stormRisk: [], stormWhy: [], sigmaUp: [] };
    for (let k = 0; k < H; k++) {
      const slot = slot0 + k;
      const day = dayOf(slot), b = blockOf(slot);
      const d = di(day);
      const ev = eventMults(slot, nowSlot, 'agent');
      const lead = Math.max(0, slot - nowSlot);
      const decay = Math.pow(0.82, lead);
      const decayW = Math.pow(0.92, lead);
      const truthMode = ev.refresh; // an announced forecast refresh gives the agent near-truth for these blocks
      const tru = truthMode ? truthAt(slot) : null;
      const sol: Record<string, number> = {}, wnd: Record<string, number> = {}, dem: Record<string, number> = {};
      let solSum = 0, windSum = 0, demSum = 0;
      for (const f of p.solar) {
        let x = tru ? tru.solar[f.id] * (1 + 0.02 * (gauss(mulberry32(hashStr(f.id + slot))) )) : (d.solarFc[f.id]?.[b] ?? 0) * (1 + ((ps.solar[f.id] ?? 1) - 1) * decay);
        x = f.enabled ? clamp(x, 0, maintCapMW(f.id, f.capacityMW, slot)) * (ev.solar[f.id] ?? 1) : 0;
        sol[f.id] = x; solSum += x;
      }
      for (const f of p.wind) {
        let x = tru ? tru.wind[f.id] : (d.windFc[f.id]?.[b] ?? 0) * (1 + ((ps.wind[f.id] ?? 1) - 1) * decayW);
        x = f.enabled ? clamp(x, 0, maintCapMW(f.id, f.capacityMW, slot)) * (ev.wind[f.id] ?? 1) : 0;
        wnd[f.id] = x; windSum += x;
      }
      for (const c of p.customers) {
        let x = tru ? tru.demand[c.id] : (d.demandFc[c.id]?.[b] ?? 0) * (1 + (ps.demand - 1) * Math.pow(0.9, lead));
        x = c.enabled ? x * (ev.demand[c.id] ?? 1) : 0;
        dem[c.id] = x; demSum += x;
      }
      v.slots.push(slot); v.solar.push(sol); v.wind.push(wnd); v.demand.push(dem);
      const cleared = clearedDam(slot);
      const dam = cleared ?? d.damFc[b];
      v.damFc.push(dam);
      const spread = ps.rtmSpread * Math.pow(0.85, lead);
      v.rtmFc.push(clamp(dam * (1 + spread), 0.8, s.market.priceCap));
      const tc: Record<string, number> = {}, bp: Record<string, number> = {}, tt: Record<string, number> = {};
      for (const u of p.thermal) tc[u.id] = !u.enabled || ev.thermalOut[u.id] ? 0 : maintCapMW(u.id, u.capacityMW, slot);
      for (const x of p.bess) bp[x.id] = !x.enabled || ev.bessOut[x.id] ? 0 : maintCapMW(x.id, x.powerMW, slot);
      for (const c of p.corridors) tt[c.id] = c.ttcMW * (ev.ttc[c.id] ?? 1);
      v.thermalCap.push(tc); v.bessPower.push(bp); v.ttc.push(tt);
      v.stormRisk.push(ev.storm ? 1 : d.stormFlag[b]); v.stormWhy.push(ev.storm ? 'announced storm alert' : d.stormWhy[b]);
      const lf = 1 + 0.015 * Math.min(lead, 24);
      const r = s.reserve;
      v.sigmaUp.push((r.solarErrPct / 100) * solSum * lf + (r.windErrPct / 100) * windSum * lf + (r.loadErrPct / 100) * demSum);
    }
    return v;
  }

  return {
    invalidate() { cache.clear(); version++; },
    version: () => version,
    dayInputs: di,
    truthAt,
    agentView,
    maintCapMW,
    eventMults,
    freqBase: (b: number) => 50 + FREQ_BASE[b],
    damTruth: (slot: number) => di(dayOf(slot)).damT[blockOf(slot)],
    damForecast: (slot: number) => di(dayOf(slot)).damFc[blockOf(slot)],
    forecastOnly: (slot: number) => {
      const p = ctx.portfolio(); const d = di(dayOf(slot)); const b = blockOf(slot);
      const solar: Record<string, number> = {}, wind: Record<string, number> = {}, demand: Record<string, number> = {};
      for (const f of p.solar) solar[f.id] = f.enabled ? Math.min(d.solarFc[f.id]?.[b] ?? 0, maintCapMW(f.id, f.capacityMW, slot)) : 0;
      for (const f of p.wind) wind[f.id] = f.enabled ? Math.min(d.windFc[f.id]?.[b] ?? 0, maintCapMW(f.id, f.capacityMW, slot)) : 0;
      for (const c of p.customers) demand[c.id] = c.enabled ? d.demandFc[c.id]?.[b] ?? 0 : 0;
      return { solar, wind, demand };
    },
    _slotOf: slotOf,
  };
}

export type Twin = ReturnType<typeof createTwin>;
export type AgentView = ReturnType<Twin['agentView']>;
export interface Persistence { solar: Record<string, number>; wind: Record<string, number>; demand: number; rtmSpread: number }
export type { Bess, ThermalUnit };
