import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { Battery, Factory, Flame, MapPin, Pencil, Plus, Search, Sun, Trash2, Wind } from 'lucide-react';
import { api } from '../api';
import { Card, Field, Modal, Pill, Tabs } from '../components/ui';
import { n0 } from '../format';

type Kind = 'solar' | 'wind' | 'thermal' | 'bess' | 'customers';
type FieldDef = { k: string; label: string; type?: 'number' | 'text' | 'select'; step?: number; hint?: string; options?: string[]; span?: 2 | 3 };
const COMMON_ASSET: FieldDef[] = [{ k: 'name', label: 'Name', type: 'text', span: 2 }, { k: 'corridorId', label: 'Evacuation corridor', type: 'select' }];
const FIELDS: Record<Kind, FieldDef[]> = {
  solar: [...COMMON_ASSET, { k: 'capacityMW', label: 'AC capacity (MW)', type: 'number' }, { k: 'dcAcRatio', label: 'DC/AC ratio', type: 'number', step: 0.05 }, { k: 'performanceRatio', label: 'Performance ratio', type: 'number', step: 0.01 }, { k: 'tariff', label: 'PPA tariff (₹/kWh)', type: 'number', step: 0.05 }],
  wind: [...COMMON_ASSET, { k: 'capacityMW', label: 'Capacity (MW)', type: 'number' }, { k: 'hubHeightM', label: 'Hub height (m)', type: 'number' }, { k: 'tariff', label: 'PPA tariff (₹/kWh)', type: 'number', step: 0.05 }],
  thermal: [...COMMON_ASSET, { k: 'capacityMW', label: 'Capacity (MW)', type: 'number' }, { k: 'minLoadPct', label: 'Technical minimum (%)', type: 'number' }, { k: 'rampPctPerMin', label: 'Ramp (%/min)', type: 'number', step: 0.1 }, { k: 'varCost', label: 'Energy charge (₹/kWh)', type: 'number', step: 0.05 }, { k: 'capacityCharge', label: 'Capacity charge (₹ lakh/MW-mo)', type: 'number', step: 0.1 }, { k: 'noLoadCost', label: 'No-load cost (₹k/h)', type: 'number' }, { k: 'startupCost', label: 'Start-up cost (₹k)', type: 'number' }, { k: 'minUpBlocks', label: 'Min up (blocks)', type: 'number' }, { k: 'minDownBlocks', label: 'Min down (blocks)', type: 'number' }, { k: 'tripRestartBlocks', label: 'Restart after a trip (blocks)', type: 'number', hint: 'time to be back on line after a trip; 8 blocks = 2 h' }, { k: 'emissionFactor', label: 'Emission factor (tCO₂/MWh)', type: 'number', step: 0.01 }, { k: 'group', label: 'Group', type: 'select', options: ['A', 'B', 'C'], hint: 'A base · B flexible · C expensive' }],
  bess: [...COMMON_ASSET, { k: 'powerMW', label: 'Power (MW)', type: 'number' }, { k: 'energyMWh', label: 'Energy (MWh)', type: 'number' }, { k: 'etaCharge', label: 'Charge efficiency', type: 'number', step: 0.01 }, { k: 'etaDischarge', label: 'Discharge efficiency', type: 'number', step: 0.01 }, { k: 'socMinPct', label: 'Min SOC (%)', type: 'number' }, { k: 'socMaxPct', label: 'Max SOC (%)', type: 'number' }, { k: 'initialSocPct', label: 'Initial SOC (%)', type: 'number' }, { k: 'degradationCost', label: 'Degradation (₹/kWh)', type: 'number', step: 0.05 }, { k: 'gridSupportReservePct', label: 'Grid-support reserve (%)', type: 'number', hint: 'power held back from arbitrage' }],
  customers: [{ k: 'name', label: 'Name', type: 'text', span: 2 }, { k: 'segment', label: 'Segment', type: 'select', options: ['Industrial', 'Commercial', 'Residential', 'Critical infra', 'Agriculture'] }, { k: 'peakMW', label: 'Peak demand (MW)', type: 'number' }, { k: 'profile', label: 'Load profile', type: 'select', options: ['industrial-continuous', 'industrial-twoshift', 'commercial', 'residential', 'datacenter', 'agri', 'mixed-feeder'] }, { k: 'criticality', label: 'Criticality', type: 'select', options: ['critical', 'essential', 'flexible'] }, { k: 'tariff', label: 'Tariff (₹/kWh)', type: 'number', step: 0.1 }, { k: 'drFlexPct', label: 'DR flexible (%)', type: 'number' }, { k: 'shiftablePct', label: 'Shiftable (%)', type: 'number' }, { k: 'drIncentive', label: 'DR incentive (₹/kWh)', type: 'number', step: 0.1 }, { k: 'coolingSensitivity', label: 'Cooling sensitivity /°C', type: 'number', step: 0.001 }],
};
const DEFAULTS: Record<Kind, any> = {
  solar: { corridorId: 'WR', capacityMW: 100, dcAcRatio: 1.3, performanceRatio: 0.81, tariff: 2.7 },
  wind: { corridorId: 'WR', capacityMW: 100, hubHeightM: 100, tariff: 3.1 },
  thermal: { corridorId: 'CR', capacityMW: 200, minLoadPct: 45, rampPctPerMin: 1.5, varCost: 4.2, capacityCharge: 1.5, noLoadCost: 50, startupCost: 1000, minUpBlocks: 16, minDownBlocks: 12, tripRestartBlocks: 6, emissionFactor: 0.92, group: 'B' },
  bess: { corridorId: 'WR', powerMW: 50, energyMWh: 200, etaCharge: 0.94, etaDischarge: 0.94, socMinPct: 10, socMaxPct: 95, initialSocPct: 50, degradationCost: 0.8, gridSupportReservePct: 20 },
  customers: { segment: 'Industrial', peakMW: 50, profile: 'industrial-continuous', criticality: 'essential', tariff: 6.5, drFlexPct: 10, shiftablePct: 0, drIncentive: 2, coolingSensitivity: 0.005 },
};
const ICON: Record<Kind, any> = { solar: Sun, wind: Wind, thermal: Flame, bess: Battery, customers: Factory };
const COLOR: Record<Kind, string> = { solar: '#c98500', wind: '#3987e5', thermal: '#d95926', bess: '#9085e9', customers: '#8a9bb3' };

export default function Portfolio({ s }: { s: any }) {
  const [p, setP] = useState<any>(null);
  const [tab, setTab] = useState<'map' | Kind | 'grid'>('map');
  const [edit, setEdit] = useState<{ kind: Kind; item: any; isNew: boolean } | null>(null);
  const load = () => api('/portfolio').then((r) => setP(r.portfolio));
  useEffect(() => { load(); }, []);
  if (!p) return null;
  const counts = { solar: p.solar.length, wind: p.wind.length, thermal: p.thermal.length, bess: p.bess.length, customers: p.customers.length };
  const cap = (a: any[], k = 'capacityMW') => a.reduce((x, y) => x + y[k], 0);
  const remove = async (kind: Kind, id: string) => { if (!confirm('Remove this item from the portfolio?')) return; await api(kind === 'customers' ? `/customers/${id}` : `/assets/${kind}/${id}`, { method: 'DELETE' }); load(); };
  const flows = s.detail.current ?? s.detail.planned ?? {};
  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(5, minmax(0,1fr))' }}>
        {(['solar', 'wind', 'thermal', 'bess', 'customers'] as Kind[]).map((k) => { const I = ICON[k]; return (
          <div key={k} className="card kpi" style={{ cursor: 'pointer', ['--glow' as any]: COLOR[k] + '33' }} onClick={() => setTab(k)}>
            <div className="lab"><I size={13} color={COLOR[k]} />{k === 'bess' ? 'Battery storage' : k === 'customers' ? 'Customers' : k}</div>
            <div className="val num">{counts[k]}<small>{k === 'customers' ? `· ${n0(cap(p.customers, 'peakMW'))} MW peak` : k === 'bess' ? `· ${n0(cap(p.bess, 'powerMW'))} MW / ${n0(cap(p.bess, 'energyMWh'))} MWh` : `· ${n0(cap((p as any)[k]))} MW`}</small></div>
          </div>); })}
      </div>
      <div className="row"><Tabs value={tab} onChange={setTab} options={[{ v: 'map', label: 'Map' }, { v: 'solar', label: 'Solar' }, { v: 'wind', label: 'Wind' }, { v: 'thermal', label: 'Thermal' }, { v: 'bess', label: 'Storage' }, { v: 'customers', label: 'Customers' }, { v: 'grid', label: 'Grid & corridors' }]} />
        <div className="spacer" />
        {tab !== 'map' && tab !== 'grid' && <button className="btn primary" onClick={() => setEdit({ kind: tab, item: { ...DEFAULTS[tab], location: { name: '', state: '', lat: 0, lon: 0 } }, isNew: true })}><Plus size={14} />Add {tab === 'bess' ? 'BESS' : tab === 'customers' ? 'customer' : tab + ' asset'}</button>}
      </div>
      {tab === 'map' && <MapCard p={p} flows={flows} />}
      {(['solar', 'wind', 'thermal', 'bess', 'customers'] as Kind[]).includes(tab as Kind) && (
        <Card title={tab === 'bess' ? 'Storage' : String(tab)} bodyClass="">
          <table className="t" style={{ margin: '8px 0 0' }}>
            <thead><tr><th className="l">Name</th><th className="l">Location</th>{tab === 'bess' ? <><th>MW</th><th>MWh</th><th>SOC now</th><th>Now MW</th><th>RT eff.</th></> : tab === 'customers' ? <><th className="l">Segment</th><th>Peak MW</th><th>DR %</th><th>Shift %</th><th>Tariff</th><th className="l">Priority</th></> : <><th>MW</th>{tab === 'thermal' ? <><th>Min %</th><th>₹/kWh</th><th className="l">Group</th></> : <th>Tariff</th>}<th>Now MW</th></>}<th className="l">Status</th><th /></tr></thead>
            <tbody>
              {(p[tab] as any[]).map((a) => (
                <tr key={a.id}>
                  <td className="l"><b>{a.name}</b></td><td className="l dim">{a.location.name}, {a.location.state}</td>
                  {tab === 'bess' ? <><td className="num">{a.powerMW}</td><td className="num">{a.energyMWh}</td><td className="num">{flows['soc:' + a.id] != null ? ((flows['soc:' + a.id] / a.energyMWh) * 100).toFixed(0) + '%' : '—'}</td><td className="num">{flows[a.id] == null ? '—' : Math.abs(flows[a.id]) < 0.5 ? 'idle' : flows[a.id] > 0 ? `+${n0(flows[a.id])} discharging` : `${n0(flows[a.id])} charging`}</td><td className="num">{(a.etaCharge * a.etaDischarge * 100).toFixed(0)}%</td></>
                    : tab === 'customers' ? <><td className="l">{a.segment}</td><td className="num">{a.peakMW}</td><td className="num">{a.drFlexPct}</td><td className="num">{a.shiftablePct}</td><td className="num">₹{a.tariff}</td><td className="l"><Pill kind={a.criticality === 'critical' ? 'crit' : a.criticality === 'essential' ? 'warn' : 'model'}>{a.criticality}</Pill></td></>
                      : <><td className="num">{a.capacityMW}</td>{tab === 'thermal' ? <><td className="num">{a.minLoadPct}</td><td className="num">{a.varCost}</td><td className="l">{a.group}{a.mustRun ? ' · must-run' : ''}</td></> : <td className="num">₹{a.tariff}</td>}<td className="num">{n0(flows[a.id] ?? 0)}</td></>}
                  <td className="l"><Pill kind={a.enabled ? 'live' : 'off'}>{a.enabled ? 'in service' : 'disabled'}</Pill></td>
                  <td className="l" style={{ textAlign: 'right' }}>
                    <button className="btn ghost sm" onClick={() => setEdit({ kind: tab as Kind, item: JSON.parse(JSON.stringify(a)), isNew: false })}><Pencil size={13} /></button>
                    <button className="btn ghost sm" onClick={() => remove(tab as Kind, a.id)}><Trash2 size={13} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {tab === 'grid' && <GridCard p={p} reload={load} />}
      {edit && <EditModal p={p} {...edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </div>
  );
}

function EditModal({ p, kind, item, isNew, onClose, onSaved }: { p: any; kind: Kind; item: any; isNew: boolean; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<any>(item);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<any[]>([]);
  const timer = useRef<any>(null);
  const search = (v: string) => {
    setQ(v); clearTimeout(timer.current);
    if (v.length < 2) return setHits([]);
    timer.current = setTimeout(() => api('/geocode?q=' + encodeURIComponent(v)).then((r) => setHits(r.results)).catch(() => {}), 350);
  };
  const save = async () => {
    setBusy(true); setErr('');
    try { await api(kind === 'customers' ? '/customers' : `/assets/${kind}`, { body: d }); onSaved(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const loc = d.location;
  return (
    <Modal title={`${isNew ? 'Add' : 'Edit'} ${kind === 'bess' ? 'battery storage' : kind === 'customers' ? 'customer' : kind + ' asset'}`} onClose={onClose}
      footer={<>{err && <span className="pill crit" style={{ marginRight: 'auto', whiteSpace: 'normal' }}>{err}</span>}<button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save & re-optimise'}</button></>}>
      <div className="form-grid">
        <Field label="Location search (India)" span={3} hint="Weather for this asset is fetched from its coordinates">
          <div style={{ position: 'relative' }}>
            <div className="row"><Search size={14} style={{ position: 'absolute', left: 10, color: '#71829f' }} /><input style={{ paddingLeft: 30 }} placeholder="e.g. Jaisalmer, Anantapur, Dhule…" value={q} onChange={(e) => search(e.target.value)} /></div>
            {hits.length > 0 && <div style={{ position: 'absolute', zIndex: 5, top: 38, left: 0, right: 0, background: 'var(--surface-2)', border: '1px solid var(--line-2)', borderRadius: 10, overflow: 'hidden' }}>
              {hits.map((h, i) => <div key={i} className="nav" style={{ borderRadius: 0 }} onClick={() => { setD({ ...d, location: { name: h.name, state: h.state, lat: Number(h.lat.toFixed(3)), lon: Number(h.lon.toFixed(3)) } }); setHits([]); setQ(''); }}><MapPin size={13} /><span>{h.name}, {h.state}</span><span className="muted num" style={{ marginLeft: 'auto' }}>{h.lat.toFixed(2)}, {h.lon.toFixed(2)}</span></div>)}
            </div>}
          </div>
        </Field>
        <Field label="Place name"><input value={loc.name} onChange={(e) => setD({ ...d, location: { ...loc, name: e.target.value } })} /></Field>
        <Field label="Latitude"><input type="number" step="0.01" value={loc.lat} onChange={(e) => setD({ ...d, location: { ...loc, lat: Number(e.target.value) } })} /></Field>
        <Field label="Longitude"><input type="number" step="0.01" value={loc.lon} onChange={(e) => setD({ ...d, location: { ...loc, lon: Number(e.target.value) } })} /></Field>
        {FIELDS[kind].map((f) => (
          <Field key={f.k} label={f.label} hint={f.hint} span={f.span}>
            {f.type === 'select' ? (
              <select value={d[f.k] ?? ''} onChange={(e) => setD({ ...d, [f.k]: e.target.value })}>
                {(f.k === 'corridorId' ? p.corridors.map((c: any) => c.id) : f.options!).map((o: string) => <option key={o} value={o}>{f.k === 'corridorId' ? `${o} – ${p.corridors.find((c: any) => c.id === o).name}` : o}</option>)}
              </select>
            ) : <input type={f.type === 'number' ? 'number' : 'text'} step={f.step} value={d[f.k] ?? ''} onChange={(e) => setD({ ...d, [f.k]: f.type === 'number' ? Number(e.target.value) : e.target.value })} />}
          </Field>
        ))}
        <Field label="In service"><select value={d.enabled === false ? 'no' : 'yes'} onChange={(e) => setD({ ...d, enabled: e.target.value === 'yes' })}><option value="yes">Yes</option><option value="no">Disabled</option></select></Field>
        {kind === 'thermal' && <Field label="Must-run"><select value={d.mustRun ? 'yes' : 'no'} onChange={(e) => setD({ ...d, mustRun: e.target.value === 'yes' })}><option value="no">No</option><option value="yes">Yes</option></select></Field>}
      </div>
    </Modal>
  );
}

function GridCard({ p, reload }: { p: any; reload: () => void }) {
  const [ic, setIc] = useState<any>(p.interconnect);
  const [cor, setCor] = useState<Record<string, number>>(Object.fromEntries(p.corridors.map((c: any) => [c.id, c.ttcMW])));
  const [ok, setOk] = useState('');
  const save = async () => {
    await api('/interconnect', { method: 'PUT', body: ic });
    for (const c of p.corridors) if (cor[c.id] !== c.ttcMW) await api(`/corridors/${c.id}`, { method: 'PUT', body: { ttcMW: cor[c.id] } });
    setOk('Saved — agent re-planning'); reload(); setTimeout(() => setOk(''), 2500);
  };
  return (
    <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
      <Card title="Grid interconnection">
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Field label="Max import (MW)"><input type="number" value={ic.importLimitMW} onChange={(e) => setIc({ ...ic, importLimitMW: Number(e.target.value) })} /></Field>
          <Field label="Max export (MW)"><input type="number" value={ic.exportLimitMW} onChange={(e) => setIc({ ...ic, exportLimitMW: Number(e.target.value) })} /></Field>
          <Field label="Contracted ISGS / bilateral (MW)"><input type="number" value={ic.gridContractLimitMW} onChange={(e) => setIc({ ...ic, gridContractLimitMW: Number(e.target.value) })} /></Field>
          <Field label="Contract price (₹/kWh)"><input type="number" step="0.05" value={ic.gridContractPrice} onChange={(e) => setIc({ ...ic, gridContractPrice: Number(e.target.value) })} /></Field>
        </div>
      </Card>
      <Card title="Evacuation corridors (TTC)">
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          {p.corridors.map((c: any) => <Field key={c.id} label={`${c.id} – ${c.name}`}><input type="number" value={cor[c.id]} onChange={(e) => setCor({ ...cor, [c.id]: Number(e.target.value) })} /></Field>)}
        </div>
      </Card>
      <div className="row" style={{ gridColumn: '1 / -1' }}><button className="btn primary" onClick={save}>Save & re-optimise</button>{ok && <span className="pill live">{ok}</span>}</div>
    </div>
  );
}

function MapCard({ p, flows }: { p: any; flows: Record<string, number> }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([21.5, 77.5], 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 12, className: 'dark-tiles' }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
  }, []);
  useEffect(() => {
    if (!layer.current) return;
    layer.current.clearLayers();
    const add = (kind: Kind, list: any[], sizeOf: (a: any) => number, extra: (a: any) => string) => list.forEach((a) => {
      const r = Math.max(6, Math.min(20, 5 + Math.sqrt(sizeOf(a)) * 0.9));
      L.circleMarker([a.location.lat, a.location.lon], { radius: r, color: COLOR[kind], weight: 2, fillColor: COLOR[kind], fillOpacity: a.enabled ? 0.45 : 0.1 })
        .bindPopup(`<b>${a.name}</b><br/>${a.location.name}, ${a.location.state}<br/>${extra(a)}`).addTo(layer.current!);
    });
    add('solar', p.solar, (a) => a.capacityMW, (a) => `${a.capacityMW} MW solar · now ${n0(flows[a.id] ?? 0)} MW`);
    add('wind', p.wind, (a) => a.capacityMW, (a) => `${a.capacityMW} MW wind · now ${n0(flows[a.id] ?? 0)} MW`);
    add('thermal', p.thermal, (a) => a.capacityMW, (a) => `${a.capacityMW} MW thermal (group ${a.group})`);
    add('bess', p.bess, (a) => a.powerMW, (a) => `${a.powerMW} MW / ${a.energyMWh} MWh`);
    add('customers', p.customers, (a) => a.peakMW, (a) => `${a.segment} · ${a.peakMW} MW peak`);
  }, [p, flows]);
  return (
    <Card title="Asset & customer map" right={<div className="legend">{(['solar', 'wind', 'thermal', 'bess', 'customers'] as Kind[]).map((k) => <span key={k}><i className="sw" style={{ background: COLOR[k] }} />{k === 'bess' ? 'storage' : k}</span>)}</div>}>
      <div ref={el} style={{ height: 460, borderRadius: 12 }} />
    </Card>
  );
}
