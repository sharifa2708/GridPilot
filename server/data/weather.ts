// Weather ingestion: Open-Meteo (free, no key). One batched request covers every asset location.
// Falls back to a deterministic clear-sky/seasonal model when the API is unreachable, and tags the source.
import fs from 'node:fs';
import path from 'node:path';
import { ar1, clamp, dayFromDate, sinElevation, BLOCKS, dayOf, hashStr, mulberry32 } from '../util.js';

export interface WeatherSeries {
  key: string;
  source: 'open-meteo' | 'synthetic';
  fetchedAt: number;
  startDay: number; // IST day number of first hourly sample
  ghi: number[]; // W/m2, average of preceding hour
  cloud: number[];
  temp: number[];
  wind100: number[]; // m/s
  gust: number[]; // m/s
  precip: number[];
  code: number[];
}

const CACHE_DIR = path.resolve('data', 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'weather.json');
const TTL_MS = 45 * 60 * 1000;

const store = new Map<string, WeatherSeries>();
export let weatherStatus: { source: string; lastOk: number | null; lastError: string | null; locations: number } = {
  source: 'init',
  lastOk: null,
  lastError: null,
  locations: 0,
};

export const wkey = (lat: number, lon: number) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

try {
  if (fs.existsSync(CACHE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as WeatherSeries[];
    for (const w of raw) store.set(w.key, w);
  }
} catch {
  /* ignore corrupt cache */
}

function persist() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify([...store.values()]));
  } catch {
    /* non-fatal */
  }
}

export async function refreshWeather(points: { lat: number; lon: number }[], force = false): Promise<void> {
  const uniq = new Map<string, { lat: number; lon: number }>();
  for (const p of points) uniq.set(wkey(p.lat, p.lon), p);
  const need = [...uniq.entries()].filter(([k]) => {
    const w = store.get(k);
    return force || !w || w.source !== 'open-meteo' || Date.now() - w.fetchedAt > TTL_MS;
  });
  weatherStatus.locations = uniq.size;
  if (need.length === 0) {
    const live = [...uniq.keys()].filter((k) => store.get(k)?.source === 'open-meteo');
    if (live.length === uniq.size) weatherStatus = { source: 'open-meteo', lastOk: Math.max(...live.map((k) => store.get(k)!.fetchedAt)), lastError: null, locations: uniq.size };
    return;
  }
  // chunk to keep URLs short
  for (let i = 0; i < need.length; i += 12) {
    const chunk = need.slice(i, i + 12);
    const lat = chunk.map(([, p]) => p.lat.toFixed(2)).join(',');
    const lon = chunk.map(([, p]) => p.lon.toFixed(2)).join(',');
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=shortwave_radiation,cloud_cover,temperature_2m,wind_speed_100m,wind_gusts_10m,precipitation,weather_code` +
      `&wind_speed_unit=ms&past_days=2&forecast_days=4&timezone=Asia%2FKolkata`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: any = await res.json();
      const arr = Array.isArray(json) ? json : [json];
      arr.forEach((r: any, idx: number) => {
        const h = r.hourly;
        const startDay = dayFromDate(String(h.time[0]).slice(0, 10));
        const nz = (a: any[]) => a.map((v) => (v == null ? 0 : v));
        const ws: WeatherSeries = {
          key: chunk[idx][0],
          source: 'open-meteo',
          fetchedAt: Date.now(),
          startDay,
          ghi: nz(h.shortwave_radiation),
          cloud: nz(h.cloud_cover),
          temp: nz(h.temperature_2m),
          wind100: nz(h.wind_speed_100m),
          gust: nz(h.wind_gusts_10m),
          precip: nz(h.precipitation),
          code: nz(h.weather_code),
        };
        store.set(ws.key, ws);
      });
      weatherStatus = { source: 'open-meteo', lastOk: Date.now(), lastError: null, locations: uniq.size };
    } catch (e: any) {
      weatherStatus = { ...weatherStatus, source: 'synthetic-fallback', lastError: String(e?.message ?? e) };
    }
  }
  persist();
}

/** Deterministic fallback so the app still runs offline. */
function synthetic(lat: number, lon: number, day: number): WeatherSeries {
  const startDay = day - 2;
  const n = 7 * 24;
  const cloudN = ar1(`cloud-${lat}-${lon}`, 7 * 6, 0.7);
  const windN = ar1(`wind-${lat}-${lon}`, n, 0.97);
  const ghi: number[] = [], cloud: number[] = [], temp: number[] = [], wind: number[] = [], gust: number[] = [], precip: number[] = [], code: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = startDay + Math.floor(i / 24);
    const h = i % 24;
    const c = clamp(25 + 25 * cloudN[Math.floor(i / 4)], 0, 100);
    const se = Math.max(0, sinElevation(d, h * 4 - 2, lat, lon));
    ghi.push(1000 * Math.pow(se, 1.15) * (1 - 0.7 * Math.pow(c / 100, 3)));
    cloud.push(c);
    temp.push(29 + 6 * Math.sin(((h - 9) / 24) * 2 * Math.PI) - (lat - 20) * 0.1);
    const w = clamp(6 + 3 * windN[i] + 1.5 * Math.sin(((h - 14) / 24) * 2 * Math.PI), 0.5, 18);
    wind.push(w);
    gust.push(w * 1.5);
    precip.push(0);
    code.push(c > 70 ? 3 : 1);
  }
  return { key: wkey(lat, lon), source: 'synthetic', fetchedAt: Date.now(), startDay, ghi, cloud, temp, wind100: wind, gust, precip, code };
}

export function getWeather(lat: number, lon: number, day: number): WeatherSeries {
  const k = wkey(lat, lon);
  const w = store.get(k);
  if (w && w.source === 'open-meteo') {
    const nDays = Math.floor(w.ghi.length / 24);
    if (day >= w.startDay && day < w.startDay + nDays) return w;
    // Accelerated simulations run past the real forecast window: replay the real weather window cyclically.
    const shift = Math.floor((day - w.startDay) / nDays) * nDays;
    return { ...w, startDay: w.startDay + shift, source: 'open-meteo' };
  }
  return synthetic(lat, lon, day);
}

export type WKey = 'ghi' | 'cloud' | 'temp' | 'wind100' | 'gust' | 'precip';

/** Linear interpolation of an hourly series to the midpoint of block b on `day`. */
export function sample(ws: WeatherSeries, key: WKey, day: number, b: number): number {
  const arr = ws[key];
  const pos = (day - ws.startDay) * 24 + (b + 0.5) / 4 + (key === 'ghi' ? 0.5 : 0);
  const i = Math.floor(pos);
  const f = pos - i;
  const a = arr[clamp(i, 0, arr.length - 1)] ?? 0;
  const c = arr[clamp(i + 1, 0, arr.length - 1)] ?? a;
  return a + (c - a) * f;
}

export function hasThunderRisk(ws: WeatherSeries, day: number, b: number): { risk: number; why: string } | null {
  const i = clamp((day - ws.startDay) * 24 + Math.floor(b / 4), 0, ws.code.length - 1);
  const code = ws.code[i];
  const gust = ws.gust[i];
  const pr = ws.precip[i];
  if (code >= 95) return { risk: 1, why: `thunderstorm (WMO code ${code})` };
  if (gust >= 22) return { risk: 0.8, why: `gusts ${(gust * 3.6).toFixed(0)} km/h` };
  if (pr >= 8) return { risk: 0.6, why: `heavy rain ${pr.toFixed(0)} mm/h` };
  return null;
}

export function weatherDayRange(): { from: number; to: number } | null {
  const first = [...store.values()][0];
  if (!first) return null;
  return { from: first.startDay, to: first.startDay + Math.floor(first.ghi.length / 24) - 1 };
}

// unused helper retained for deterministic jitter in telemetry
export const jitter = (seed: string) => mulberry32(hashStr(seed))();
export const _blocks = BLOCKS;
export const _dayOf = dayOf;
