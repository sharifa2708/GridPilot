import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { engine } from './engine.js';
import { auditLog } from './policy/audit.js';
import { getPolicy, policyError } from './policy/config.js';
import { runPlanning, commitDraft } from './planning.js';
import { ask } from './llm.js';
import { refreshWeather } from './data/weather.js';
import { getNational, refreshNational } from './data/national.js';
import { BLOCKS, dateStr, dayFromDate, hhmm, parseIstToSlot, blockOf, dayOf } from './util.js';
import type { Asset, Customer, EventType, MaintenanceItem } from './types.js';

const app = express();
app.use(express.json({ limit: '8mb' }));
const PORT = Number(process.env.PORT ?? 8787);
const ok = (res: express.Response, data: any = {}) => res.json({ ok: true, ...data });
const bad = (res: express.Response, msg: string, code = 400) => res.status(code).json({ ok: false, error: msg });

// ---------------------------------------------------------------- live stream
app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (ev: string, data: any) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  if (engine.status === 'running') send('state', engine.snapshot());
  else send('boot', { status: engine.status, msg: engine.statusMsg });
  const un = engine.subscribe(send);
  const hb = setInterval(() => res.write(': hb\n\n'), 15000);
  req.on('close', () => { un(); clearInterval(hb); });
});
app.get('/api/state', (_req, res) => res.json(engine.status === 'running' ? engine.snapshot() : { status: engine.status, statusMsg: engine.statusMsg }));
app.get('/api/boot', (_req, res) => res.json({ status: engine.status, msg: engine.statusMsg }));

app.get('/api/day/:date', (req, res) => {
  const d = dayFromDate(req.params.date);
  const rows = engine.dayRows(d);
  if (!rows) return bad(res, 'No data for that day', 404);
  ok(res, { date: req.params.date, rows, damCommitted: engine.damPos.has(d) });
});
app.get('/api/block/:slot', (req, res) => {
  const slot = Number(req.params.slot);
  const r = engine.rowAt(slot);
  ok(res, { row: r });
});

// ---------------------------------------------------------------- portfolio
app.get('/api/portfolio', (_req, res) => ok(res, { portfolio: engine.P, templates: templates() }));

const num = (v: any, lo: number, hi: number, name: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be a number between ${lo} and ${hi}`);
  return n;
};
function validateLocation(l: any) {
  if (!l || typeof l.name !== 'string' || !l.name.trim()) throw new Error('Location name is required');
  return { name: l.name.trim(), state: String(l.state ?? '').trim() || '—', lat: num(l.lat, 6, 38, 'Latitude'), lon: num(l.lon, 67, 98, 'Longitude') };
}
function normaliseAsset(kind: Asset['kind'], b: any): Asset {
  const base = { id: String(b.id ?? '').trim() || `${kind.slice(0, 3)}-${Math.random().toString(36).slice(2, 7)}`, name: String(b.name ?? '').trim(), location: validateLocation(b.location), corridorId: String(b.corridorId ?? 'WR'), enabled: b.enabled !== false };
  if (!base.name) throw new Error('Name is required');
  if (!engine.P.corridors.find((c) => c.id === base.corridorId)) throw new Error(`Unknown corridor ${base.corridorId}`);
  switch (kind) {
    case 'solar': return { ...base, kind, capacityMW: num(b.capacityMW, 1, 2000, 'Capacity MW'), dcAcRatio: num(b.dcAcRatio ?? 1.3, 1, 2, 'DC/AC ratio'), performanceRatio: num(b.performanceRatio ?? 0.81, 0.6, 0.95, 'Performance ratio'), tariff: num(b.tariff ?? 2.7, 0.5, 15, 'Tariff') };
    case 'wind': return { ...base, kind, capacityMW: num(b.capacityMW, 1, 2000, 'Capacity MW'), hubHeightM: num(b.hubHeightM ?? 100, 50, 160, 'Hub height'), tariff: num(b.tariff ?? 3.1, 0.5, 15, 'Tariff') };
    case 'thermal': return { ...base, kind, capacityMW: num(b.capacityMW, 5, 2000, 'Capacity MW'), minLoadPct: num(b.minLoadPct ?? 40, 10, 90, 'Min load %'), rampPctPerMin: num(b.rampPctPerMin ?? 1.5, 0.2, 10, 'Ramp %/min'), varCost: num(b.varCost ?? 4, 1, 20, 'Variable cost'), noLoadCost: num(b.noLoadCost ?? 50, 0, 1000, 'No-load cost'), startupCost: num(b.startupCost ?? 1000, 0, 20000, 'Start-up cost'), capacityCharge: num(b.capacityCharge ?? 1.5, 0, 10, 'Capacity charge'), minUpBlocks: num(b.minUpBlocks ?? 16, 1, 96, 'Min up blocks'), minDownBlocks: num(b.minDownBlocks ?? 12, 1, 96, 'Min down blocks'), emissionFactor: num(b.emissionFactor ?? 0.9, 0.2, 1.3, 'Emission factor'), group: (['A', 'B', 'C'].includes(b.group) ? b.group : 'B') as 'A' | 'B' | 'C', mustRun: !!b.mustRun };
    case 'bess': {
      const smin = num(b.socMinPct ?? 10, 0, 50, 'Min SOC %'), smax = num(b.socMaxPct ?? 95, 50, 100, 'Max SOC %');
      return { ...base, kind, powerMW: num(b.powerMW, 1, 1000, 'Power MW'), energyMWh: num(b.energyMWh, 1, 5000, 'Energy MWh'), etaCharge: num(b.etaCharge ?? 0.94, 0.7, 1, 'Charge efficiency'), etaDischarge: num(b.etaDischarge ?? 0.94, 0.7, 1, 'Discharge efficiency'), socMinPct: smin, socMaxPct: smax, initialSocPct: num(b.initialSocPct ?? 50, smin, smax, 'Initial SOC %'), degradationCost: num(b.degradationCost ?? 0.8, 0, 5, 'Degradation ₹/kWh'), gridSupportReservePct: num(b.gridSupportReservePct ?? 20, 0, 60, 'Grid-support reserve %') };
    }
  }
}
app.post('/api/assets/:kind', async (req, res) => {
  try {
    const kind = req.params.kind as Asset['kind'];
    if (!['solar', 'wind', 'thermal', 'bess'].includes(kind)) return bad(res, 'Unknown asset kind');
    const a = normaliseAsset(kind, req.body);
    const list = (engine.P as any)[kind] as Asset[];
    const i = list.findIndex((x) => x.id === a.id);
    if (i >= 0) list[i] = a; else list.push(a);
    await engine.portfolioChanged(`${i >= 0 ? 'Updated' : 'Added'} ${kind} asset "${a.name}" (${a.location.name}, ${a.location.state})`);
    ok(res, { asset: a });
  } catch (e: any) { bad(res, e.message); }
});
app.delete('/api/assets/:kind/:id', async (req, res) => {
  const kind = req.params.kind;
  const list = (engine.P as any)[kind] as Asset[] | undefined;
  if (!list) return bad(res, 'Unknown asset kind');
  const i = list.findIndex((x) => x.id === req.params.id);
  if (i < 0) return bad(res, 'Not found', 404);
  const [gone] = list.splice(i, 1);
  await engine.portfolioChanged(`Removed ${kind} asset "${gone.name}"`);
  ok(res);
});
app.post('/api/customers', async (req, res) => {
  try {
    const b = req.body;
    const c: Customer = {
      id: String(b.id ?? '').trim() || `c-${Math.random().toString(36).slice(2, 7)}`, name: String(b.name ?? '').trim(),
      segment: (['Industrial', 'Commercial', 'Residential', 'Critical infra', 'Agriculture'].includes(b.segment) ? b.segment : 'Industrial'), location: validateLocation(b.location),
      peakMW: num(b.peakMW, 0.1, 2000, 'Peak MW'), profile: ['residential', 'commercial', 'industrial-continuous', 'industrial-twoshift', 'datacenter', 'agri', 'mixed-feeder'].includes(b.profile) ? b.profile : 'industrial-continuous',
      criticality: (['critical', 'essential', 'flexible'].includes(b.criticality) ? b.criticality : 'essential'), drFlexPct: num(b.drFlexPct ?? 0, 0, 100, 'DR flexible %'), shiftablePct: num(b.shiftablePct ?? 0, 0, 100, 'Shiftable %'),
      tariff: num(b.tariff ?? 6.5, 0.5, 20, 'Tariff'), drIncentive: num(b.drIncentive ?? 2, 0, 10, 'DR incentive'), coolingSensitivity: num(b.coolingSensitivity ?? 0.005, 0, 0.05, 'Cooling sensitivity'), enabled: b.enabled !== false,
    };
    if (!c.name) throw new Error('Name is required');
    const i = engine.P.customers.findIndex((x) => x.id === c.id);
    if (i >= 0) engine.P.customers[i] = c; else engine.P.customers.push(c);
    await engine.portfolioChanged(`${i >= 0 ? 'Updated' : 'Added'} customer "${c.name}" (${c.peakMW} MW, ${c.location.name})`);
    ok(res, { customer: c });
  } catch (e: any) { bad(res, e.message); }
});
app.delete('/api/customers/:id', async (req, res) => {
  const i = engine.P.customers.findIndex((x) => x.id === req.params.id);
  if (i < 0) return bad(res, 'Not found', 404);
  const [gone] = engine.P.customers.splice(i, 1);
  await engine.portfolioChanged(`Removed customer "${gone.name}"`);
  ok(res);
});
app.put('/api/corridors/:id', async (req, res) => {
  const c = engine.P.corridors.find((x) => x.id === req.params.id);
  if (!c) return bad(res, 'Not found', 404);
  try { c.ttcMW = num(req.body.ttcMW, 10, 5000, 'TTC MW'); } catch (e: any) { return bad(res, e.message); }
  await engine.portfolioChanged(`Corridor ${c.id} TTC set to ${c.ttcMW} MW`);
  ok(res);
});
app.put('/api/interconnect', async (req, res) => {
  try {
    const b = req.body, ic = engine.P.interconnect;
    ic.importLimitMW = num(b.importLimitMW ?? ic.importLimitMW, 0, 5000, 'Import limit');
    ic.exportLimitMW = num(b.exportLimitMW ?? ic.exportLimitMW, 0, 5000, 'Export limit');
    ic.gridContractLimitMW = num(b.gridContractLimitMW ?? ic.gridContractLimitMW, 0, 2000, 'Contract limit');
    ic.gridContractPrice = num(b.gridContractPrice ?? ic.gridContractPrice, 0.5, 20, 'Contract price');
  } catch (e: any) { return bad(res, e.message); }
  await engine.portfolioChanged('Grid interconnection limits updated');
  ok(res);
});

// geocoding via Open-Meteo (no key) so users can add assets by place name
app.get('/api/geocode', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return ok(res, { results: [] });
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=en&format=json&countryCode=IN`, { signal: AbortSignal.timeout(10000) });
    const j: any = await r.json();
    ok(res, { results: (j.results ?? []).map((x: any) => ({ name: x.name, state: x.admin1 ?? '', lat: x.latitude, lon: x.longitude })) });
  } catch (e: any) { ok(res, { results: [], error: String(e?.message ?? e) }); }
});

// ---------------------------------------------------------------- maintenance
app.get('/api/maintenance', (_req, res) => {
  const items = engine.maint.map((m) => ({ ...m, start: `${dateStr(dayOf(m.startSlot))} ${hhmm(blockOf(m.startSlot))}`, end: `${dateStr(dayOf(m.endSlot))} ${hhmm(blockOf(m.endSlot))}` }));
  ok(res, { items, source: engine.uploadsMeta.maintenance ?? 'sample schedule', proposals: engine.maintProposals.map((p) => ({ ...p, item: engine.maint.find((m) => m.id === p.itemId) })) });
});
app.get('/api/maintenance/template', (_req, res) => {
  const d = dateStr(dayOf(engine.cursor) + 1);
  const csv = ['asset,start,end,type,derate_mw,deferrable,description',
    `Pavagada Solar Park,${d} 11:00,${d} 13:30,planned,30,yes,Inverter string cleaning`,
    `Sipat Unit-2 (flexible),${d} 09:00,${d} 15:00,planned,90,yes,ID fan bearing inspection`,
    `BESS-2 Pavagada (4h),${d} 08:00,${d} 11:00,planned,,no,PCS firmware update (empty derate = full outage)`].join('\n');
  res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="gridpilot-maintenance-template.csv"' }).send(csv);
});
app.post('/api/maintenance/upload', (req, res) => {
  try {
    const rows: any[] = req.body.rows ?? [];
    if (!Array.isArray(rows) || rows.length === 0) return bad(res, 'No rows found in file');
    const all = [...engine.P.solar, ...engine.P.wind, ...engine.P.thermal, ...engine.P.bess];
    const items: MaintenanceItem[] = [];
    const errors: string[] = [];
    rows.forEach((r, i) => {
      const get = (...keys: string[]) => { for (const k of Object.keys(r)) if (keys.includes(k.trim().toLowerCase().replace(/[\s-]+/g, '_'))) return r[k]; return undefined; };
      const assetRaw = String(get('asset', 'asset_name', 'asset_id', 'unit') ?? '').trim();
      const asset = all.find((a) => a.id.toLowerCase() === assetRaw.toLowerCase() || a.name.toLowerCase() === assetRaw.toLowerCase()) ?? all.find((a) => assetRaw && a.name.toLowerCase().includes(assetRaw.toLowerCase()));
      const sRaw = get('start', 'start_time', 'from') ?? '', eRaw = get('end', 'end_time', 'to') ?? '';
      const s = parseIstToSlot(sRaw), e = parseIstToSlot(eRaw);
      if (!asset) { errors.push(`Row ${i + 2}: unknown asset "${assetRaw}"`); return; }
      if (s == null || e == null || e <= s) { errors.push(`Row ${i + 2}: invalid start/end (read "${String(sRaw)}" → "${String(eRaw)}"; use YYYY-MM-DD HH:MM, IST, and the end must be after the start)`); return; }
      const dr = get('derate_mw', 'derate', 'capacity_loss_mw');
      const derate = dr === undefined || String(dr).trim() === '' ? null : Number(dr);
      if (derate != null && !Number.isFinite(derate)) { errors.push(`Row ${i + 2}: derate_mw must be numeric`); return; }
      const df = String(get('deferrable', 'can_defer') ?? 'no').toLowerCase();
      const ty = String(get('type') ?? 'planned').toLowerCase();
      items.push({ id: `mu-${i + 1}`, assetId: asset.id, assetName: asset.name, type: ty === 'forced' ? 'forced' : 'planned', startSlot: s, endSlot: e, derateMW: derate, deferrable: ['yes', 'y', 'true', '1'].includes(df), description: String(get('description', 'desc', 'work') ?? 'Maintenance'), status: s <= engine.cursor && e > engine.cursor ? 'active' : e <= engine.cursor ? 'completed' : 'scheduled' });
    });
    if (items.length === 0) return bad(res, 'No valid rows. ' + errors.slice(0, 5).join(' | '));
    engine.setMaintenance(items, String(req.body.filename ?? 'uploaded file'));
    ok(res, { imported: items.length, errors });
  } catch (e: any) { bad(res, e.message); }
});
app.post('/api/maintenance/:id/approve', (req, res) => ok(res, { done: engine.resolveMaintProposal(req.params.id, true) }));
app.post('/api/maintenance/:id/reject', (req, res) => ok(res, { done: engine.resolveMaintProposal(req.params.id, false) }));

// ---------------------------------------------------------------- market data upload
app.get('/api/market/dam-template', (req, res) => {
  const date = String(req.query.date ?? dateStr(dayOf(engine.cursor) + 1));
  const day = dayFromDate(date);
  if (!Number.isFinite(day)) return bad(res, 'Invalid date');
  engine.ensureDay(day);
  // the same layout the upload reads: block number, time, MCP in ₹/MWh; pre-filled with the model's day-ahead forecast so it can be overwritten with the real prices
  const lines = ['Time Block,Time,MCP (Rs/MWh)'];
  for (let b = 0; b < BLOCKS; b++) lines.push(`${b + 1},${hhmm(b)}-${hhmm((b + 1) % BLOCKS)},${Math.round(engine.twin.damForecast(day * BLOCKS + b) * 1000)}`);
  res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="gridpilot-dam-prices-${date}.csv"` }).send(lines.join('\r\n'));
});
app.post('/api/market/dam-upload', (req, res) => {
  try {
    const rows: any[] = req.body.rows ?? [];
    const date = String(req.body.date ?? dateStr(dayOf(engine.cursor) + 1));
    const day = dayFromDate(date);
    if (!Number.isFinite(day)) return bad(res, 'Invalid date');
    const prices: number[] = new Array(BLOCKS).fill(NaN);
    for (const r of rows) {
      const keys = Object.keys(r);
      const kb = keys.find((k) => /block|time|slot/i.test(k)), kp = keys.find((k) => /mcp|price|rate|clear/i.test(k));
      if (!kb || !kp) continue;
      const bl = String(r[kb]);
      let b = NaN;
      const m = bl.match(/^(\d{1,2}):(\d{2})/);
      if (m) b = Number(m[1]) * 4 + Math.floor(Number(m[2]) / 15); else if (/^\d+$/.test(bl.trim())) b = Number(bl) - 1;
      let p = Number(String(r[kp]).replace(/,/g, ''));
      if (p > 100) p /= 1000; // ₹/MWh -> ₹/kWh
      if (Number.isFinite(b) && b >= 0 && b < BLOCKS && Number.isFinite(p)) prices[b] = p;
    }
    const got = prices.filter((x) => Number.isFinite(x)).length;
    if (got < 48) return bad(res, `Only ${got} of 96 blocks recognised. Expected columns like "Time Block"/"Block" and "MCP (Rs/MWh)" or "Price".`);
    for (let b = 0; b < BLOCKS; b++) if (!Number.isFinite(prices[b])) prices[b] = prices[Math.max(0, b - 1)] ?? 4;
    engine.setDamUpload(day, prices, String(req.body.filename ?? 'file'));
    ok(res, { blocks: got, date });
  } catch (e: any) { bad(res, e.message); }
});

// ---------------------------------------------------------------- planning
app.post('/api/plan', async (req, res) => {
  try { res.json(await runPlanning(engine, req.body)); } catch (e: any) { bad(res, e.message, 500); }
});
app.post('/api/plan/commit', (req, res) => res.json(commitDraft(engine, String(req.body.draftId))));

// ---------------------------------------------------------------- controls
app.get('/api/settings', (_req, res) => ok(res, { settings: engine.S }));
// optimisation policy (read-only here; edit server/policy/policy.config.json) and the audit trail of every optimisation run
app.get('/api/policy', (_req, res) => ok(res, { policy: getPolicy(), error: policyError() }));
app.get('/api/audit', (req, res) => ok(res, { runs: auditLog.list(Math.min(100, Number(req.query.limit ?? 20))) }));
app.get('/api/audit/latest', (req, res) => ok(res, { run: auditLog.latest(req.query.mode === 'DAM' ? 'DAM' : 'INTRADAY') }));
app.put('/api/settings', async (req, res) => { await engine.updateSettings(req.body); ok(res, { settings: engine.S }); });
app.post('/api/events', (req, res) => {
  const t = req.body.type as EventType;
  if (!t) return bad(res, 'type required');
  ok(res, { event: engine.addEvent(t, req.body) });
});
app.delete('/api/events', (_req, res) => { engine.clearEvents(); ok(res); });
app.post('/api/actions/:id/approve', (req, res) => ok(res, { done: engine.resolveAction(req.params.id, true) }));
app.post('/api/actions/:id/reject', (req, res) => ok(res, { done: engine.resolveAction(req.params.id, false) }));
app.post('/api/sim/step', async (_req, res) => { await engine.tick(); ok(res); });
app.post('/api/sim/reset', async (_req, res) => { await engine.resetAll(); ok(res); });
app.post('/api/ask', async (req, res) => {
  try {
    const hist = Array.isArray(req.body.history) ? req.body.history.slice(-3).map((h: any) => ({ q: String(h?.q ?? ''), a: String(h?.a ?? '') })) : [];
    ok(res, await ask(engine, String(req.body.question ?? '').slice(0, 600), hist));
  } catch (e: any) { ok(res, { answer: 'The agent could not answer just now. Please try again.', source: 'rules', note: String(e?.message ?? e).slice(0, 200) }); }
});
app.post('/api/refresh-data', async (_req, res) => { await Promise.allSettled([refreshWeather(engine.allLocations(), true), refreshNational()]); engine.twin.invalidate(); ok(res, { national: getNational() }); });

function templates() {
  return {
    corridors: engine.P.corridors.map((c) => ({ id: c.id, name: c.name })),
    states: ['Rajasthan', 'Gujarat', 'Maharashtra', 'Karnataka', 'Tamil Nadu', 'Andhra Pradesh', 'Telangana', 'Madhya Pradesh', 'Chhattisgarh', 'Odisha', 'Uttar Pradesh', 'Punjab', 'Haryana', 'Kerala', 'West Bengal'],
  };
}

// ---------------------------------------------------------------- static client (production)
const dist = path.resolve('client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, () => console.log(`GridPilot API on http://localhost:${PORT}`));
engine.boot().then(() => console.log('Engine running')).catch((e) => { console.error('Boot failed', e); });
