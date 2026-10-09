// Time, RNG and small numeric helpers. All times are IST; a "slot" is an absolute 15-minute index.

export const BLOCKS = 96;
export const DT = 0.25; // hours per block
/** Frequency response of the interconnected grid: MW of supply-demand imbalance per 1 Hz of frequency deviation (modelled). */
/** Simplification: the grid is 50 Hz and moves only with the DISCOM's own over- or under-drawal, 10,000 MW per Hz (a 1,000 MW deviation moves it 0.1 Hz). */
export const FRC_MW_PER_HZ = 10000;
const IST_MS = 19800000;
const SLOT_MS = 900000;

let clockOffsetMs = 0; // correction of the system clock against an internet time source
export const setClockOffset = (ms: number) => { clockOffsetMs = ms; };
export const getClockOffset = () => clockOffsetMs;
export const nowMs = () => Date.now() + clockOffsetMs;
export function slotNow(): number {
  return Math.floor((nowMs() + IST_MS) / SLOT_MS);
}
export const dayOf = (slot: number) => Math.floor(slot / BLOCKS);
export const blockOf = (slot: number) => ((slot % BLOCKS) + BLOCKS) % BLOCKS;
export const slotOf = (day: number, b: number) => day * BLOCKS + b;

export function dateStr(day: number): string {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}
export function dayFromDate(s: string): number {
  return Math.floor(Date.parse(s + 'T00:00:00Z') / 86400000);
}
export function hhmm(b: number): string {
  const m = b * 15;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
export function slotLabel(slot: number): string {
  return `${dateStr(dayOf(slot))} ${hhmm(blockOf(slot))}`;
}
/**
 * A date-time typed in IST -> slot (floor to the 15-minute block). Accepts what a spreadsheet tends to turn "YYYY-MM-DD HH:MM" into:
 * ISO (2026-10-08 11:00), day-first (08-10-2026 11:00, 8/10/26 11:00, 08.10.2026), optional seconds and AM/PM, a date alone (00:00),
 * and an Excel serial number (46303.4583). Day-first is assumed unless the second number can only be a day (then month-first).
 */
export function parseIstToSlot(input: string | number): number | null {
  const mk = (y: number, mo: number, d: number, h = 0, mi = 0): number | null => {
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h >= 0 && h <= 24 && mi >= 0 && mi < 60)) return null;
    const day = dayFromDate(`${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    return Number.isFinite(day) ? day * BLOCKS + Math.floor((h * 60 + mi) / 15) : null;
  };
  if (typeof input === 'number' || /^\d{4,6}(\.\d+)?$/.test(String(input).trim())) { // Excel serial date (days since 1899-12-30)
    const n = Number(input);
    if (!(n > 20000 && n < 80000)) return null;
    const day = Math.floor(n) - 25569;
    return day * BLOCKS + Math.floor(Math.round((n - Math.floor(n)) * 1440) / 15);
  }
  const s = String(input).trim();
  const time = (rest: string): [number, number] | null => {
    const m = rest.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/);
    if (!rest.trim()) return [0, 0];
    if (!m) return null;
    let h = Number(m[1]);
    if (m[3]) { const pm = m[3].toLowerCase() === 'pm'; h = (h % 12) + (pm ? 12 : 0); }
    return [h, Number(m[2])];
  };
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(.*))?$/); // year first
  if (m) { const tm = time(m[4] ?? ''); return tm ? mk(Number(m[1]), Number(m[2]), Number(m[3]), tm[0], tm[1]) : null; }
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:[T\s]+(.*))?$/); // day first (or month first when only that can be right)
  if (m) {
    let d = Number(m[1]), mo = Number(m[2]);
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const tm = time(m[4] ?? '');
    return tm ? mk(y, mo, d, tm[0], tm[1]) : null;
  }
  m = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3,9})[-\s/,]+(\d{2}|\d{4})(?:[T\s]+(.*))?$/); // 08-Oct-26 11:00, 8 October 2026 11:00
  if (m) {
    const mo = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const tm = time(m[4] ?? '');
    return mo > 0 && tm ? mk(y, mo, Number(m[1]), tm[0], tm[1]) : null;
  }
  return null;
}
export function dayOfYear(day: number): number {
  const d = new Date(day * 86400000);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((d.getTime() - start) / 86400000);
}
export function dowOf(day: number): number {
  return new Date(day * 86400000).getUTCDay(); // 0=Sun
}

// ---- deterministic RNG ----
export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gauss(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/** AR(1) series of length n, unit variance, correlation rho. */
export function ar1(seed: string, n: number, rho: number): number[] {
  const rng = mulberry32(hashStr(seed));
  const out: number[] = [];
  let x = gauss(rng);
  const s = Math.sqrt(1 - rho * rho);
  for (let i = 0; i < n; i++) {
    x = rho * x + s * gauss(rng);
    out.push(x);
  }
  return out;
}

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const sum = (a: number[]) => a.reduce((p, c) => p + c, 0);
export const round = (x: number, d = 2) => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};
export function lerpArr(a: number[], pos: number): number {
  if (a.length === 0) return 0;
  const i = Math.floor(pos);
  const f = pos - i;
  const x = a[clamp(i, 0, a.length - 1)];
  const y = a[clamp(i + 1, 0, a.length - 1)];
  return x + (y - x) * f;
}
/** Expand 24 hourly anchor values (hour centres) to 96 blocks with wrap-around smoothing. */
export function hourly24To96(h: number[]): number[] {
  const out: number[] = [];
  for (let b = 0; b < BLOCKS; b++) {
    const hpos = (b + 0.5) / 4 - 0.5; // position in hour-centre coordinates
    const i0 = Math.floor(hpos);
    const f = hpos - i0;
    const a = h[((i0 % 24) + 24) % 24];
    const c = h[(((i0 + 1) % 24) + 24) % 24];
    out.push(a + (c - a) * f);
  }
  return out;
}

/** Solar elevation sine for clear-sky fallback (IST local time, approx). */
export function sinElevation(day: number, b: number, lat: number, lon: number): number {
  const n = dayOfYear(day);
  const decl = (23.45 * Math.PI) / 180 * Math.sin(((2 * Math.PI) / 365) * (284 + n));
  const hourIst = (b + 0.5) / 4;
  const solarTime = hourIst + (lon - 82.5) / 15; // longitude correction vs IST meridian
  const ha = ((solarTime - 12) * 15 * Math.PI) / 180;
  const latR = (lat * Math.PI) / 180;
  return Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha);
}
