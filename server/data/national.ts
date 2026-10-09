// National power portals. MeritIndia (all-India position) and Vidyut Pravah (frequency / IEX UMCP) expose
// unauthenticated JSON/HTML fragments that their own dashboards poll. We treat every field as optional.
import { hourly24To96 } from '../util.js';

export interface NationalSnapshot {
  fetchedAt: number;
  source: 'live' | 'unavailable';
  demandMetMW: number | null;
  thermalMW: number | null;
  gasMW: number | null;
  nuclearMW: number | null;
  hydroMW: number | null;
  renewableMW: number | null;
  frequencyHz: number | null;
  umcpRs: number | null; // IEX unconstrained market clearing price, ₹/kWh
  uiRate: number | null;
  error: string | null;
}

let snap: NationalSnapshot = {
  fetchedAt: 0,
  source: 'unavailable',
  demandMetMW: null,
  thermalMW: null,
  gasMW: null,
  nuclearMW: null,
  hydroMW: null,
  renewableMW: null,
  frequencyHz: null,
  umcpRs: null,
  uiRate: null,
  error: 'not fetched yet',
};
export const getNational = () => snap;

const UA = { 'User-Agent': 'Mozilla/5.0 (GridPilot research prototype)' };
const num = (s: string | undefined) => {
  if (!s) return null;
  const v = Number(s.replace(/[,\s]/g, ''));
  return Number.isFinite(v) ? v : null;
};
const strip = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

async function post(url: string): Promise<string> {
  const r = await fetch(url, { method: 'POST', headers: { ...UA, 'Content-Length': '0' }, body: '', signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.text();
}

export async function refreshNational(): Promise<NationalSnapshot> {
  const next: NationalSnapshot = { ...snap, fetchedAt: Date.now(), error: null };
  let ok = false;
  const errs: string[] = [];
  try {
    const t = strip(await post('https://meritindia.in/Dashboard/BindAllIndiaMap'));
    const grab = (label: string) => {
      const m = t.match(new RegExp(label + '\\s*([\\-\\d,]+)\\s*MW', 'i'));
      return m ? num(m[1]) : null;
    };
    next.demandMetMW = grab('DEMAND MET');
    next.thermalMW = grab('THERMAL GENERATION');
    next.gasMW = grab('GAS GENERATION');
    next.nuclearMW = grab('NUCLEAR GENERATION');
    next.hydroMW = grab('HYDRO GENERATION');
    next.renewableMW = grab('RENEWABLE GENERATION');
    ok = next.demandMetMW != null;
  } catch (e: any) {
    errs.push('MeritIndia: ' + (e?.message ?? e));
  }
  try {
    const j = JSON.parse(await post('https://vidyutpravah.in/PXDashboard/BindTopStatisticsFromJS'));
    const r = Array.isArray(j) ? j[0] : j;
    const f = Number(r?.frequency);
    next.frequencyHz = Number.isFinite(f) && f > 49 && f < 51 ? f : null;
    const ui = Number(r?.ui_rate);
    next.uiRate = Number.isFinite(ui) && ui > 0 ? ui : null;
    const um = Number(String(r?.UMCP ?? '').replace(/[^\d.]/g, ''));
    next.umcpRs = Number.isFinite(um) && um > 0 ? um : null;
    if (next.demandMetMW == null) {
      const d = Number(String(r?.demand ?? '').replace(/<[^>]+>/g, '').replace(/[^\d.]/g, ''));
      if (Number.isFinite(d) && d > 0) {
        next.demandMetMW = d * 1000;
        ok = true;
      }
    }
  } catch (e: any) {
    errs.push('VidyutPravah: ' + (e?.message ?? e));
  }
  next.source = ok ? 'live' : 'unavailable';
  next.error = errs.length ? errs.join('; ') : null;
  snap = next;
  return snap;
}

/** Typical all-India demand shape (normalised, October weekday) used to read the live value as a stress index. */
const NAT_H = [0.86, 0.84, 0.83, 0.83, 0.84, 0.86, 0.88, 0.91, 0.95, 0.97, 0.98, 0.98, 0.97, 0.96, 0.95, 0.94, 0.94, 0.95, 0.99, 1.0, 0.98, 0.95, 0.92, 0.89];
export const NAT_SHAPE = hourly24To96(NAT_H);
export const NAT_PEAK_MW = 237000;

/** >1 means all-India demand is running hotter than the typical profile for this block. */
export function nationalStress(b: number): number {
  if (snap.demandMetMW == null || Date.now() - snap.fetchedAt > 20 * 60 * 1000) return 1;
  const expected = NAT_SHAPE[b] * NAT_PEAK_MW;
  return Math.min(1.12, Math.max(0.9, snap.demandMetMW / expected));
}
