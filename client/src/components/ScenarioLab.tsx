import { useEffect, useState } from 'react';
import { CloudRain, Wind, BatteryWarning, Cable, Factory, Activity, RefreshCcw, CloudLightning, Flame, TrendingUp, X } from 'lucide-react';
import { api } from '../api';
import { Pill } from './ui';

const EVENTS: { type: string; label: string; icon: any; desc: string; target?: 'solar' | 'wind' | 'bess' | 'corridor' | 'thermal' | 'customer'; dur?: number; mag?: { label: string; min: number; max: number; step: number; def: number; unit: '%' | 'Hz' } }[] = [
  { type: 'cloud_cover', label: 'Cloud burst', icon: CloudRain, desc: 'Solar output drops 60% (surprise)', target: 'solar', dur: 8, mag: { label: 'Solar drop', min: 10, max: 90, step: 5, def: 60, unit: '%' } },
  { type: 'wind_surge', label: 'Wind surge', icon: Wind, desc: 'Wind output +50% above forecast', target: 'wind', dur: 8, mag: { label: 'Wind rise', min: 10, max: 100, step: 5, def: 50, unit: '%' } },
  { type: 'wind_drop', label: 'Wind lull', icon: Wind, desc: 'Wind output −60% vs forecast', target: 'wind', dur: 8, mag: { label: 'Wind drop', min: 10, max: 90, step: 5, def: 60, unit: '%' } },
  { type: 'price_spike', label: 'Price spike', icon: TrendingUp, desc: 'RTM price +80%', dur: 6, mag: { label: 'Price rise', min: 10, max: 200, step: 10, def: 80, unit: '%' } },
  { type: 'bess_outage', label: 'Battery trips', icon: BatteryWarning, desc: 'A BESS becomes unavailable', target: 'bess', dur: 16 },
  { type: 'line_limit', label: 'Line capacity cut', icon: Cable, desc: 'Corridor TTC reduced 45%', target: 'corridor', dur: 12, mag: { label: 'Capacity cut', min: 10, max: 90, step: 5, def: 45, unit: '%' } },
  { type: 'demand_surge', label: 'Demand surge', icon: Factory, desc: 'Industrial demand +20%', target: 'customer', dur: 8, mag: { label: 'Demand rise', min: 5, max: 50, step: 5, def: 20, unit: '%' } },
  { type: 'thermal_trip', label: 'Thermal unit trip', icon: Flame, desc: 'A thermal unit trips offline', target: 'thermal', dur: 20 },
  { type: 'storm_alert', label: 'Storm alert', icon: CloudLightning, desc: 'Announced 2 h ahead: wind cut-out, solar −50%', dur: 6 },
  { type: 'forecast_update', label: 'Forecast update', icon: RefreshCcw, desc: 'Agent receives refreshed forecasts', dur: 96 },
];

export default function ScenarioLab({ state, onClose }: { state: any; onClose: () => void }) {
  const [portfolio, setPortfolio] = useState<any>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [mags, setMags] = useState<Record<string, number>>({});
  const [delays, setDelays] = useState<Record<string, number>>({});
  const [durs, setDurs] = useState<Record<string, number>>({});
  const b0: number = state.now?.b ?? 0;
  const clock = (k: number) => { const m = ((b0 + k) % 96) * 15; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
  const span = (blocks: number) => { const m = blocks * 15; return m < 60 ? `${m} min` : `${(m / 60).toFixed(m % 60 ? 2 : 0).replace(/.?0+$/, '')} h`; };
  useEffect(() => { api('/portfolio').then((r) => setPortfolio(r.portfolio)); }, []);
  const opts = (k?: string) => {
    if (!portfolio) return [];
    switch (k) {
      case 'solar': return portfolio.solar; case 'wind': return portfolio.wind; case 'bess': return portfolio.bess; case 'thermal': return portfolio.thermal;
      case 'corridor': return portfolio.corridors; case 'customer': return portfolio.customers; default: return [];
    }
  };
  const fire = async (e: (typeof EVENTS)[number]) => {
    setBusy(e.type);
    try { await api('/events', { body: { type: e.type, targetId: targets[e.type] || undefined, durationBlocks: durs[e.type] ?? e.dur, delayBlocks: delays[e.type] ?? (e.type === 'storm_alert' ? 9 : 0), magnitude: e.mag ? (mags[e.type] ?? e.mag.def) / (e.mag.unit === '%' ? 100 : 1) : undefined } }); } finally { setBusy(''); }
  };
  return (
    <div className="drawer">
      <div className="row" style={{ padding: '16px 18px', borderBottom: '1px solid var(--line)' }}>
        <div><b style={{ fontSize: 15 }}>Scenario Lab</b><div className="muted">Inject real-world disturbances – the agent must re-plan</div></div>
        <div className="spacer" /><button className="btn ghost sm" onClick={onClose}><X size={16} /></button>
      </div>
      <div style={{ overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {EVENTS.map((e) => (
          <div key={e.type} className="act" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <e.icon size={18} color="#8fb8ff" style={{ flex: 'none' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <b style={{ fontSize: 12.5 }}>{e.label}</b>
              <div className="muted" style={{ fontSize: 11 }}>{e.desc}</div>
              {e.target && (
                <select style={{ marginTop: 6, padding: '4px 8px' }} value={targets[e.type] ?? ''} onChange={(ev) => setTargets({ ...targets, [e.type]: ev.target.value })}>
                  <option value="">All / any</option>
                  {opts(e.target).map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 10px', alignItems: 'center', marginTop: 8, fontSize: 11.5 }}>
                {e.mag && (<>
                  <span className="muted">{e.mag.label}</span>
                  <span className="row" style={{ gap: 8 }}><input type="range" min={e.mag.min} max={e.mag.max} step={e.mag.step} value={mags[e.type] ?? e.mag.def} onChange={(ev) => setMags({ ...mags, [e.type]: Number(ev.target.value) })} style={{ flex: 1 }} /><b className="num" style={{ minWidth: 52, textAlign: 'right' }}>{e.mag.unit === 'Hz' ? (mags[e.type] ?? e.mag.def).toFixed(2) + ' Hz' : (mags[e.type] ?? e.mag.def) + '%'}</b></span>
                </>)}
                <span className="muted">Starts</span>
                <select style={{ padding: '3px 6px' }} value={delays[e.type] ?? (e.type === 'storm_alert' ? 9 : 0)} onChange={(ev) => setDelays({ ...delays, [e.type]: Number(ev.target.value) })}>
                  {Array.from({ length: 49 }, (_, i) => i).map((k) => <option key={k} value={k}>{clock(k)} · {k === 0 ? 'current block (now)' : k === 1 ? 'next block' : 'in ' + span(k)}</option>)}
                </select>
                {e.type !== 'forecast_update' && (<>
                  <span className="muted">Lasts</span>
                  <span className="row" style={{ gap: 8 }}><input type="range" min={1} max={32} step={1} value={durs[e.type] ?? e.dur ?? 8} onChange={(ev) => setDurs({ ...durs, [e.type]: Number(ev.target.value) })} style={{ flex: 1 }} /><b className="num" style={{ minWidth: 52, textAlign: 'right' }}>{span(durs[e.type] ?? e.dur ?? 8)}</b></span>
                </>)}
              </div>
            </div>
            <button className="btn sm primary" disabled={busy === e.type} onClick={() => fire(e)}>Inject</button>
          </div>
        ))}
        <div className="hr" />
        <div className="row"><b>Active & upcoming</b><div className="spacer" /><button className="btn sm danger" onClick={() => api('/events', { method: 'DELETE' })}>Clear all</button></div>
        {state.events.length === 0 && <div className="muted">None.</div>}
        {state.events.map((e: any) => (
          <div key={e.id} className="row" style={{ justifyContent: 'space-between' }}>
            <span className="dim">{e.label}</span><Pill kind={e.active ? 'warn' : 'model'}>{e.active ? 'active' : 'scheduled'}</Pill>
          </div>
        ))}
      </div>
    </div>
  );
}
