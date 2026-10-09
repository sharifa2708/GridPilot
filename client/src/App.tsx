import { useEffect, useRef, useState } from 'react';
import { Activity, CalendarClock, Database, FlaskConical, Gauge, LayoutDashboard, Network, Pause, Play, SkipForward, Settings as Cog, Wrench, Zap } from 'lucide-react';
import { api, useLive } from './api';
import { Pill, Seg, Spinner } from './components/ui';
import ScenarioLab from './components/ScenarioLab';
import Dashboard from './pages/Dashboard';
import Planning from './pages/Planning';
import Portfolio from './pages/Portfolio';
import Maintenance from './pages/Maintenance';
import DataSources from './pages/DataSources';
import Settings from './pages/Settings';
import Performance from './pages/Performance';

const PAGES = [
  { id: 'control', label: 'Control Room', icon: LayoutDashboard, title: 'Control Room', sub: 'Real-time orchestration across 96 settlement blocks' },
  { id: 'planning', label: 'DAM / RTM Planning', icon: CalendarClock, title: 'Market Planning Workbench', sub: 'Optimise, stress-test and commit day-ahead and real-time schedules' },
  { id: 'performance', label: 'Performance', icon: Gauge, title: 'Performance Scorecard', sub: 'Month-end KPIs for the scheduling cell' },
  { id: 'portfolio', label: 'Portfolio', icon: Network, title: 'Portfolio Manager', sub: 'Generation, storage, customers and grid interconnection' },
  { id: 'maintenance', label: 'Maintenance', icon: Wrench, title: 'Maintenance Schedule', sub: 'Upload outages, review agent re-scheduling proposals' },
  { id: 'data', label: 'Data Sources', icon: Database, title: 'Data Sources & Provenance', sub: 'What is live, what is uploaded, what is modelled' },
  { id: 'settings', label: 'Settings', icon: Cog, title: 'Objectives & Settings', sub: 'Optimality weights, market rules, autonomy and simulation clock' },
] as const;
type PageId = (typeof PAGES)[number]['id'];

function OptimiserPill({ opt }: { opt?: { busy: boolean; forTime: string; version: number; ms: number; ok: boolean; approximate: boolean; stale?: boolean; nextAt?: string } }) {
  if (!opt || !opt.forTime) return null;
  if (opt.busy) return <Pill kind="warn" title="The optimiser is solving the plan for the next block"><span className="spin" style={{ width: 10, height: 10, marginRight: 6, display: 'inline-block' }} />Optimising {opt.forTime}…</Pill>;
  if (opt.stale) return <Pill kind="warn" title="A scenario was injected after the last plan. The agent has not seen it yet and will re-plan at the next interval">Plan {opt.forTime} is out of date · re-plans at {opt.nextAt}</Pill>;
  if (!opt.ok) return <Pill kind="crit" title="The last re-optimisation failed; the previous plan is held">Plan {opt.forTime} failed</Pill>;
  return <Pill kind="live" title={`Plan v${opt.version} for the block starting ${opt.forTime}, solved in ${(opt.ms / 1000).toFixed(1)} s${opt.approximate ? ' (time limit reached: near-optimal, not proven)' : ''}`}><span className="dot live" />Plan {opt.forTime} ready · {(opt.ms / 1000).toFixed(1)} s{opt.approximate ? ' ≈' : ''}</Pill>;
}

function RealClock({ clock }: { clock: any }) {
  const base = useRef({ server: clock.realMs, local: Date.now() });
  useEffect(() => { base.current = { server: clock.realMs, local: Date.now() }; }, [clock.realMs]);
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(i); }, []);
  const d = new Date(base.current.server + (Date.now() - base.current.local));
  const t = d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  const dt = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
  return (
    <div title={`Real time in India (IST), from ${clock.source}${clock.offsetMs ? ` (system clock corrected by ${(clock.offsetMs / 1000).toFixed(0)} s)` : ''}`} style={{ textAlign: 'right', lineHeight: 1.2 }}>
      <div className="num" style={{ fontWeight: 650, fontSize: 14 }}>{t} <span className="muted" style={{ fontSize: 10.5 }}>IST</span></div>
      <div className="muted" style={{ fontSize: 10.5 }}>{dt} · {clock.source}</div>
    </div>
  );
}

export default function App() {
  const live = useLive();
  const [page, setPage] = useState<PageId>('control');
  const [lab, setLab] = useState(false);
  const s = live.state;

  if (!s) return <Spinner text={live.boot ? `${live.boot.msg}` : live.connected ? 'Loading…' : 'Connecting to GridPilot engine…'} />;
  const cur = PAGES.find((p) => p.id === page)!;
  const mode = s.now.mode as 'live' | 'accelerated' | 'paused';
  const setSim = (sim: any) => api('/settings', { method: 'PUT', body: { sim } });
  const nat = s.national;
  const pendingCount = (s.agent.pending?.length ?? 0) + (s.agent.maintProposals?.length ?? 0);

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <svg width="34" height="34" viewBox="0 0 32 32"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#34d399" /><stop offset="1" stopColor="#3b82f6" /></linearGradient></defs><rect width="32" height="32" rx="9" fill="#0d1626" stroke="#22324d" /><path d="M6 21c3-9 6-9 9-3s6 6 11-8" fill="none" stroke="url(#lg)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <div><b>GridPilot</b><small>Energy orchestrator</small></div>
        </div>
        <div className="nav-sec">Operate</div>
        {PAGES.slice(0, 3).map((p) => (
          <button key={p.id} className={'nav' + (page === p.id ? ' active' : '')} onClick={() => setPage(p.id)}>
            <p.icon size={17} /><span>{p.label}</span>
            {p.id === 'control' && pendingCount > 0 && <span className="badge pill warn">{pendingCount}</span>}
          </button>
        ))}
        <div className="nav-sec">Configure</div>
        {PAGES.slice(3).map((p) => (
          <button key={p.id} className={'nav' + (page === p.id ? ' active' : '')} onClick={() => setPage(p.id)}><p.icon size={17} /><span>{p.label}</span></button>
        ))}
        <div className="side-foot">
          <div className="row" style={{ marginBottom: 6 }}><Zap size={13} color="#34d399" /><b style={{ fontSize: 12 }}>{s.autonomy === 'autonomous' ? 'Autonomous' : 'Supervised'} agent</b></div>
          <div className="muted" style={{ lineHeight: 1.5 }}>Priority: security → reliability → reserve → DSM → cost → RE use → degradation</div>
        </div>
      </aside>
      <div className="main">
        <header className="top">
          <div>
            <h1>{cur.title}</h1>
            <div className="sub">{cur.sub}</div>
          </div>
          <div className="spacer" />
          <RealClock clock={s.clock} />
          <div className="row" style={{ gap: 8 }}>
            <OptimiserPill opt={live.telemetry?.opt} />
            <Pill kind={s.weather.source === 'open-meteo' ? 'live' : 'warn'} title={s.weather.lastError ?? 'Open-Meteo hourly weather per asset location'}><span className={'dot ' + (s.weather.source === 'open-meteo' ? 'live' : 'warn')} />Weather {s.weather.source === 'open-meteo' ? 'live' : 'model'}</Pill>
            <Pill kind={nat.source === 'live' ? 'live' : 'off'} title="MeritIndia / Vidyut Pravah"><span className={'dot ' + (nat.source === 'live' ? 'live' : '')} />All-India {nat.source === 'live' ? `${(nat.demandMetMW / 1000).toFixed(0)} GW` : 'n/a'}</Pill>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Seg value={mode} onChange={(v) => setSim(v === 'live' ? { mode: 'live' } : v === 'paused' ? { mode: 'paused' } : { mode: 'accelerated', secondsPerBlock: s.now.secondsPerBlock })}
              options={[{ v: 'live', label: 'Live' }, { v: 'accelerated', label: 'Simulate' }, { v: 'paused', label: <Pause size={12} /> }]} />
            {mode === 'accelerated' && (
              <select style={{ width: 92, padding: '5px 8px' }} value={s.now.secondsPerBlock} onChange={(e) => setSim({ mode: 'accelerated', secondsPerBlock: Number(e.target.value) })}>
                <option value={15}>15 s / block</option><option value={8}>8 s / block</option><option value={5}>5 s / block</option>
              </select>
            )}
            {mode === 'paused' && <button className="btn sm" onClick={() => api('/sim/step', { method: 'POST', body: {} })}><SkipForward size={13} />Step</button>}
            {mode === 'paused' && <button className="btn sm" onClick={() => setSim({ mode: 'accelerated' })}><Play size={13} /></button>}
          </div>
          <button className="btn" onClick={() => setLab(true)}><FlaskConical size={15} />Scenario Lab{s.events.length ? <span className="pill warn">{s.events.length}</span> : null}</button>
        </header>
        <div className="page">
          {page === 'control' && <Dashboard s={s} tel={live.telemetry} />}
          {page === 'planning' && <Planning s={s} />}
          {page === 'performance' && <Performance s={s} />}
          {page === 'portfolio' && <Portfolio s={s} />}
          {page === 'maintenance' && <Maintenance s={s} />}
          {page === 'data' && <DataSources s={s} />}
          {page === 'settings' && <Settings s={s} />}
        </div>
      </div>
      {lab && <ScenarioLab state={s} onClose={() => setLab(false)} />}
    </div>
  );
}

export { Activity };
