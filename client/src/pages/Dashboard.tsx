import { useEffect, useMemo, useRef, useState } from 'react';
import { Area, AreaChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, ArrowLeftRight, Battery, Check, CheckCircle2, Circle, Clock, Flame, Lock, Send, ShieldAlert, Sparkles, Sun, Users, Wrench, X } from 'lucide-react';
import { api } from '../api';
import { Card, Legend, Pill, Tabs, Tip } from '../components/ui';
import { PolicyPanel } from '../components/PolicyPanel';
import { SRC, cls, money, n0, n1, n2, rs, sign } from '../format';

const hh = (b: number) => `${String(Math.floor(b / 4)).padStart(2, '0')}:${String((b % 4) * 15).padStart(2, '0')}`;
const TICKS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88];

export default function Dashboard({ s, tel }: { s: any; tel: any }) {
  const [portfolio, setPortfolio] = useState<any>(null);
  useEffect(() => { api('/portfolio').then((r) => setPortfolio(r.portfolio)).catch(() => {}); }, [s.plan?.version === 1]);
  const cur = s.rows[s.now.b];
  return (
    <div className="grid" style={{ gap: 14 }}>
      <KpiRibbon s={s} tel={tel} cur={cur} />
      {s.agent.alerts?.length > 0 && <Alerts alerts={s.agent.alerts} />}
      <div className="dash-split">
        <div className="grid" style={{ minWidth: 0 }}>
          <DispatchCard s={s} />
          <CustomerCard s={s} tel={tel} />
          <ScheduleCard s={s} />
        </div>
        <div className="dash-side"><div className="dash-side-in">
          <MixCard s={s} cur={cur} />
          <AgentCard s={s} portfolio={portfolio} />
        </div></div>
      </div>
      <HealthCard s={s} portfolio={portfolio} />
    </div>
  );
}

/* ------------------------------------------------------------------ KPI ribbon */
function KpiRibbon({ s, tel, cur }: { s: any; tel: any; cur: any }) {
  const t = tel ?? s.telemetry;
  const f = t.freq;
  const fPct = Math.min(100, Math.max(0, ((f - 49.8) / 0.4) * 100));
  const fKind = f < 49.9 || f > 50.1 ? 'crit' : Math.abs(f - 50) > 0.05 ? 'warn' : 'live';
  const bal = t.deviation ?? 0;
  const cb = cur.cost;
  const comps = cb ? [
    { k: 'Thermal', v: cb.thermal + cb.fixed + cb.startup, c: SRC.thermal.color }, { k: 'Solar', v: cb.solar, c: SRC.solar.color }, { k: 'Wind', v: cb.wind, c: SRC.wind.color },
    { k: 'Market', v: Math.max(0, cb.market), c: SRC.market.color }, { k: 'Grid', v: cb.grid, c: SRC.grid.color }, { k: 'BESS', v: Math.max(0, cb.bess), c: SRC.bess.color }, { k: 'DSM', v: Math.max(0, cb.dsm), c: SRC.dsm.color },
  ].filter((x) => x.v > 0.01) : [];
  const compTot = comps.reduce((a, c) => a + c.v, 0) || 1;
  const reShare = s.mix.filter((m: any) => m.key === 'solar' || m.key === 'wind').reduce((a: number, m: any) => a + m.share, 0);
  const dayPct = ((s.now.b + 1) / 96) * 100;
  return (
    <div className="kpis">
      <div className="card kpi" style={{ ['--glow' as any]: fKind === 'live' ? 'rgba(52,211,153,.14)' : fKind === 'warn' ? 'rgba(245,185,66,.16)' : 'rgba(240,96,93,.2)' }}>
        <div className="lab"><span className={'dot ' + (fKind === 'live' ? 'live' : fKind)} />Grid frequency</div>
        <div className="val num">{f.toFixed(3)}<small>Hz</small></div>
        <div className="bar" style={{ marginTop: 10 }}>
          <i style={{ left: '25%', width: '50%', background: 'rgba(52,211,153,.22)', borderRadius: 0 }} />
          <i style={{ left: `calc(${fPct}% - 2px)`, width: 4, background: fKind === 'live' ? '#34d399' : fKind === 'warn' ? '#f5b942' : '#f0605d' }} />
        </div>
        <div className="ft"><span>49.80</span><span style={{ marginLeft: 'auto' }}>band 49.90–50.10</span><span>50.20</span></div>
      </div>
      <div className="card kpi" style={{ ['--glow' as any]: 'rgba(59,130,246,.16)' }}>
        <div className="lab">Demand · Generation</div>
        {(() => {
          // the big number is the demand; beside it the gap: deficit (red) = demand - own gen - grid - buy + sell when positive, surplus (green) when negative
          const asked = t.requested ?? t.demand;
          const gap = asked - t.generation - t.grid - t.buy + t.sell;
          const state = gap > 5 ? 'deficit' : gap < -5 ? 'surplus' : 'balanced';
          const color = state === 'deficit' ? '#ff9a97' : state === 'surplus' ? '#7be3b6' : '#9fb0c9';
          const tip = `Demand ${n0(asked)} MW less own generation ${n0(t.generation)}, grid ${n0(t.grid)} and purchases ${n0(t.buy)}, plus sales ${n0(t.sell)} = ${n0(gap)} MW`;
          return <div className="val num" title={tip} style={{ whiteSpace: 'nowrap' }}>{n0(asked)}<small style={{ color: '#71829f' }}>MW</small><span style={{ color, fontSize: 13, fontWeight: 700, marginLeft: 10, letterSpacing: 0 }}>{state === 'balanced' ? 'balanced' : `${n0(Math.abs(gap))} ${state}`}</span></div>;
        })()}
        <div className="ft"><span title="Solar, wind, thermal and battery discharge">Own gen <b className="num" style={{ color: '#e8eef8' }}>{n0(t.generation)}</b></span></div>
        <div className="ft">{(() => {
          // Grid = the contract draw plus any over-drawal beyond the schedule (power taken from the grid in the block), red when there is over-drawal
          const over = Math.max(0, t.demand + Math.max(0, -t.bessNet) - (t.generation + t.grid + t.buy - t.sell));
          return <span title={over > 5 ? `Contract import ${n0(t.grid)} MW plus ${n0(over)} MW drawn from the grid beyond the schedule` : 'Contract power drawn from the grid (long-term PPA)'}>Grid <b className="num" style={{ color: over > 5 ? '#ff9a97' : '#e8eef8' }}>{n0(t.grid + (over > 5 ? over : 0))}</b></span>;
        })()}<span title="Bought on the exchange (day-ahead and real-time)">Buy <b className="num" style={{ color: '#e8eef8' }}>{n0(t.buy)}</b></span><span title="Sold on the exchange (day-ahead and real-time)">Sell <b className="num" style={{ color: '#e8eef8' }}>{n0(t.sell)}</b></span></div>
        <div className="ft"><span>☀ {n0(t.solar)}</span><span>🌬 {n0(t.wind)}</span><span>🔥 {n0(t.thermal)}</span><span>🔋 {sign(t.bessNet, 0)}</span><span className={cls('num', Math.abs(bal) > 20 ? 'bad' : 'pos')}>Δsched {sign(bal, 1)}</span></div>
      </div>
      <div className="card kpi" style={{ ['--glow' as any]: 'rgba(201,133,0,.14)' }}>
        <div className="lab">Market price</div>
        <div className="val num">{rs(t.rtmPrice)}<small>RTM /kWh</small></div>
        <div className="ft"><span>DAM <b className="num" style={{ color: '#e8eef8' }}>{rs(t.damPrice)}</b></span><span>SMC <b className="num" style={{ color: '#e8eef8' }}>{rs(cur.smc ?? t.rtmPrice)}</b></span></div>
        <div className="ft"><span>{s.national.umcpRs ? <>IEX live UMCP {rs(s.national.umcpRs)}</> : <>IEX shape-calibrated model</>}</span></div>
      </div>
      <div className="card kpi" style={{ ['--glow' as any]: 'rgba(144,133,233,.16)' }}>
        <div className="lab"><Clock size={12} />{s.clock.simulated ? 'Simulated time of day' : 'Time of day · IST'}{s.clock.simulated && <span className="pill warn" style={{ padding: '0 6px' }}>SIM</span>}</div>
        <div className="val num">{s.now.time}<small>→ {s.now.endTime}</small></div>
        <div className="ft"><span>Block <b className="num" style={{ color: '#e8eef8' }}>{s.now.b + 1}</b> / 96</span><span>{new Date(s.now.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span></div>
        <div className="bar" style={{ marginTop: 8 }}><i style={{ left: 0, width: `${dayPct}%`, background: 'linear-gradient(90deg,#3b82f6,#9085e9)' }} /></div>
      </div>
      <div className="card kpi" style={{ ['--glow' as any]: 'rgba(52,211,153,.16)' }}>
        <div className="lab">Cost per unit · incl. DSM</div>
        <div className="val num" style={{ color: '#7be3b6' }}>{rs(cur.costPerUnit)}<small>/kWh</small></div>
        <div className="ft"><span>Day avg <b className="num" style={{ color: '#e8eef8' }}>{rs(s.kpis.cpu)}</b></span><span>Tariff {rs(s.kpis.avgTariff)}</span></div>
        <div className="stackbar" title="Cost components of this block">{comps.map((c) => <i key={c.k} style={{ width: `${(c.v / compTot) * 100}%`, background: c.c }} title={`${c.k}: ${money(c.v)}`} />)}</div>
      </div>
      <div className="card kpi" style={{ ['--glow' as any]: 'rgba(52,211,153,.12)' }}>
        <div className="lab">Clean energy share</div>
        <div className="val num">{n1(s.kpis.reSharePct)}<small>% today</small></div>
        <div className="ft"><span>Now {n1(reShare)}%</span><span>CO₂ <b className="num" style={{ color: '#e8eef8' }}>{n2(s.kpis.intensity)}</b> t/MWh</span><span>RE used {n1(s.kpis.reUtilPct)}%</span></div>
        <div className="ft"><span>DSM today <b className={cls('num', s.kpis.dsmCostK > 100 ? 'bad' : '')}>{money(s.kpis.dsmCostK)}</b></span></div>
      </div>
    </div>
  );
}

function Alerts({ alerts }: { alerts: any[] }) {
  return (
    <div className="alerts">
      {alerts.map((a) => (
        <div key={a.id + a.title} className={cls('alert', a.level)}>
          {a.level === 'critical' ? <ShieldAlert size={16} color="#f0605d" /> : <AlertTriangle size={16} color={a.level === 'warn' ? '#f5b942' : '#5aa2ff'} />}
          <div><b>{a.title}</b><span>{a.detail}</span></div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ dispatch chart */
function DispatchCard({ s }: { s: any }) {
  const data = useMemo(() => s.rows.map((r: any) => {
    const a = r.act ?? r.plan;
    const g = (k: string) => (a ? a[k] : 0) || 0;
    return {
      b: r.b, wind: g('wind'), thermal: g('thermal'), market: g('damBuy') + g('rtmBuy'), solar: g('solar'), grid: g('grid'), bess: g('bessDis'), dsm: Math.max(0, g('dsmDraw')),
      charging: -g('bessCh'), export: -(g('damSell') + g('rtmSell')), curtail: -(g('curtailSolar') + g('curtailWind')),
      demand: r.demand, netload: r.demand - g('solar') - g('wind'),
      dam: r.damPrice, rtm: r.rtmPrice, smc: r.smc, soc: r.soc, future: r.status === 'future',
    };
  }), [s.rows]);
  const cb = s.now.b;
  const axis = { stroke: 'transparent', tick: { fill: '#71829f', fontSize: 10.5 }, tickLine: false, axisLine: false } as const;
  const xAx = <XAxis dataKey="b" ticks={TICKS} tickFormatter={hh} {...axis} />;
  const marks = (<>
    <ReferenceArea x1={cb + 0.5} x2={95} fill="#ffffff" fillOpacity={0.025} />
    <ReferenceLine x={cb} stroke="#ffffff" strokeOpacity={0.55} strokeDasharray="3 3" label={{ value: 'NOW', fill: '#e8eef8', fontSize: 10, position: 'top' }} />
  </>);
  const src = [
    ['wind', SRC.wind], ['thermal', SRC.thermal], ['market', SRC.market], ['solar', SRC.solar], ['grid', SRC.grid], ['bess', SRC.bess], ['dsm', SRC.dsm],
  ] as const;
  return (
    <Card title="Generation · demand · price — 96 blocks" right={<span className="muted">solid = actual · shaded region = agent plan</span>} bodyClass="" >
      <div style={{ height: 270 }}>
        <ResponsiveContainer>
          <AreaChart data={data} syncId="d" stackOffset="sign" margin={{ top: 14, right: 8, left: -14, bottom: 0 }}>
            <CartesianGrid stroke="#1f2c42" strokeOpacity={0.6} vertical={false} />
            {xAx}<YAxis {...axis} tickFormatter={(v) => `${v}`} width={44} />
            <Tooltip content={<Tip fmt={{ title: (b: number) => `${hh(b)} – ${hh((b + 1) % 96)}`, value: (v: number) => `${Math.abs(v).toFixed(0)} MW` }} />} />
            {src.map(([k, m]) => <Area key={k} type="monotone" dataKey={k} name={m.label} stackId="s" stroke={m.color} fill={m.color} fillOpacity={0.88} strokeWidth={0} isAnimationActive={false} />)}
            <Area type="monotone" dataKey="charging" name="BESS charging" stackId="s" stroke="#9085e9" fill="#9085e9" fillOpacity={0.4} strokeWidth={0} isAnimationActive={false} />
            <Area type="monotone" dataKey="export" name="Export / sale" stackId="s" stroke="#199e70" fill="#199e70" fillOpacity={0.35} strokeWidth={0} isAnimationActive={false} />
            <Area type="monotone" dataKey="curtail" name="RE curtailed" stackId="s" stroke="#8a9bb3" fill="#8a9bb3" fillOpacity={0.45} strokeWidth={0} isAnimationActive={false} />
            <Line type="monotone" dataKey="demand" name="Demand" stroke="#ffffff" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="netload" name="Net load (demand − RE)" stroke="#ffffff" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
            {marks}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <Legend items={[...src.map(([, m]) => ({ label: m.label, color: m.color })), { label: 'Demand', color: '#fff' }, { label: 'Net load', color: '#fff', dash: true }, { label: 'Below axis: charging · export · curtailed', color: '#8a9bb3' }]} />
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', marginTop: 12, gap: 14 }}>
        <div>
          <div className="muted" style={{ marginBottom: 2 }}>Price ₹/kWh — DAM · RTM · system marginal cost</div>
          <div style={{ height: 130 }}>
            <ResponsiveContainer>
              <LineChart data={data} syncId="d" margin={{ top: 6, right: 8, left: -14, bottom: 0 }}>
                <CartesianGrid stroke="#1f2c42" strokeOpacity={0.6} vertical={false} />
                {xAx}<YAxis {...axis} width={44} domain={[0, 'auto']} />
                <Tooltip content={<Tip fmt={{ title: (b: number) => hh(b), value: (v: number) => `₹${v.toFixed(2)}` }} />} />
                <Line type="stepAfter" dataKey="dam" name="DAM MCP" stroke="#3987e5" strokeWidth={1.8} dot={false} isAnimationActive={false} />
                <Line type="stepAfter" dataKey="rtm" name="RTM" stroke="#c98500" strokeWidth={1.8} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="smc" name="System marginal cost" stroke="#d55181" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                {marks}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <Legend items={[{ label: 'DAM', color: '#3987e5' }, { label: 'RTM', color: '#c98500' }, { label: 'SMC (plan)', color: '#d55181', dash: true }]} />
        </div>
        <div>
          <div className="muted" style={{ marginBottom: 2 }}>BESS state of charge %</div>
          <div style={{ height: 130 }}>
            <ResponsiveContainer>
              <AreaChart data={data} syncId="d" margin={{ top: 6, right: 8, left: -14, bottom: 0 }}>
                <CartesianGrid stroke="#1f2c42" strokeOpacity={0.6} vertical={false} />
                {xAx}<YAxis {...axis} width={44} domain={[0, 100]} />
                <Tooltip content={<Tip fmt={{ title: (b: number) => hh(b), value: (v: number) => `${v.toFixed(0)}%` }} />} />
                <Area type="monotone" dataKey="soc" name="Pooled SOC" stroke="#9085e9" fill="#9085e9" fillOpacity={0.3} strokeWidth={2} isAnimationActive={false} />
                {marks}
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <Legend items={[{ label: 'Pooled SOC (800 MWh)', color: '#9085e9' }]} />
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ energy mix */
/* ------------------------------------------------------------------ customers */
function CustomerCard({ s, tel }: { s: any; tel: any }) {
  const list: any[] = (s.customers ?? []).filter((c: any) => c.enabled);
  const base = list.reduce((a, c) => a + c.servedMW, 0);
  const total = (tel ?? s.telemetry).demand;
  const k = base > 0 ? total / base : 1; // keep the table summing to the Demand figure on the ribbon
  const rows = list.map((c) => ({ ...c, now: c.servedMW * k })).sort((a, b) => b.now - a.now);
  return (
    <Card title="Demand by customer · now" right={<span className="muted num">{n0(total)} MW total</span>}>
      <table className="t">
        <thead><tr><th className="l">Customer</th><th className="l">Segment</th><th>Now MW</th><th>Share</th><th className="l" style={{ width: '32%' }}>Load vs peak</th><th className="l">Agent</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const pct = (r.now / r.peakMW) * 100;
            const notes: string[] = [];
            const cutMW = r.curtailedMW ?? 0;
            if (cutMW > 0.5) notes.push(`cut ${n0(cutMW)} MW`);
            if ((r.disruptedMW ?? 0) > 0.5) notes.push(`disrupted ${n0(r.disruptedMW)} MW`);
            if (r.shiftedMW < -0.5) notes.push(`deferred ${n0(-r.shiftedMW)} MW`);
            else if (r.shiftedMW > 0.5) notes.push(`pulled forward ${n0(r.shiftedMW)} MW`);
            return (
              <tr key={r.id}>
                <td className="l">{r.name}</td>
                <td className="l muted">{r.segment}</td>
                <td className="num">{n0(r.now)}</td>
                <td className="num">{total > 0 ? n1((r.now / total) * 100) : '0.0'}%</td>
                <td className="l"><div className="bar" title={`${n0(r.now)} of ${n0(r.peakMW)} MW peak`}><i style={{ left: 0, width: `${Math.min(100, pct)}%`, background: '#3b82f6' }} /></div></td>
                <td className="l">{notes.length ? <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>{notes.map((n, i) => <Pill key={i} kind={/^disrupted/.test(n) ? 'crit' : 'warn'}>{n}</Pill>)}</span> : <span className="muted">normal</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function MixCard({ s, cur }: { s: any; cur: any }) {
  const items = s.mix.filter((m: any) => m.mw > 0.5);
  const total = items.reduce((a: number, m: any) => a + m.mw, 0);
  const color = (k: string) => (SRC as any)[k]?.color ?? '#888';
  const wavg = items.reduce((a: number, m: any) => a + m.mw * m.cost, 0) / (total || 1);
  return (
    <Card title="Energy mix · this block" right={<Pill kind="model">{cur.status === 'future' ? 'plan' : 'actual'}</Pill>}>
      <div className="row" style={{ alignItems: 'center' }}>
        <div style={{ width: 118, height: 118, position: 'relative', flex: 'none' }}>
          <ResponsiveContainer>
            <PieChart>
              <Pie data={items} dataKey="mw" nameKey="label" innerRadius={38} outerRadius={56} paddingAngle={2} stroke="none" isAnimationActive={false}>
                {items.map((m: any) => <Cell key={m.key} fill={color(m.key)} />)}
              </Pie>
              <Tooltip content={<Tip fmt={{ value: (v: number) => `${v.toFixed(0)} MW` }} />} />
            </PieChart>
          </ResponsiveContainer>
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none', textAlign: 'center' }}>
            <div><div className="num" style={{ fontSize: 17, fontWeight: 650 }}>{n0(total)}</div><div className="muted" style={{ fontSize: 10.5 }}>MW supplied</div></div>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <table className="t mixt">
            <thead><tr><th className="l">Source</th><th>Share</th><th>₹/kWh</th></tr></thead>
            <tbody>
              {items.map((m: any) => (
                <tr key={m.key}>
                  <td className="l"><span className="row" style={{ gap: 7 }}><i className="sw" style={{ background: color(m.key) }} />{m.label.replace(' (DAM/RTM)', '').replace('Contract / grid import', 'Grid contract').replace(' over-drawal', '').replace('BESS discharge', 'BESS')}</span></td>
                  <td className="num">{n1(m.share)}%</td><td className="num">{n2(m.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="hr" style={{ margin: '12px 0 8px' }} />
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="muted">Weighted supply cost</span><b className="num">{rs(wavg)}/kWh</b>
      </div>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
        <span className="muted">All-in cost to serve (incl. fixed, BESS, DSM)</span><b className="num" style={{ color: '#7be3b6' }}>{rs(cur.costPerUnit)}/kWh</b>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ 96-row schedule */
function ScheduleCard({ s }: { s: any }) {
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (!follow || !box.current) return;
    const row = box.current.querySelector('tr.current') as HTMLElement | null;
    if (row) box.current.scrollTop = Math.max(0, row.offsetTop - 150);
  }, [s.now.b, follow]);
  const f = (x: number | undefined, d = 0) => (x == null ? '—' : x.toFixed(d));
  return (
    <Card title="96-block schedule" bodyClass="" right={
      <div className="row"><span className="muted">history locked · future = live agent plan v{s.plan?.version ?? 0}</span><label className="row" style={{ gap: 6, cursor: 'pointer' }}><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />Follow now</label></div>
    }>
      <div className="sched" ref={box} style={{ margin: '10px -16px -16px' }}>
        <table className="t">
          <thead><tr>
            <th>#</th><th className="l">Time</th><th>Demand</th><th>Solar</th><th>Wind</th><th>Thermal</th><th>BESS ±</th><th>Market ±</th><th>Grid</th><th>Curtail</th><th>SOC %</th><th>DAM ₹</th><th>RTM ₹</th><th>₹/kWh</th><th>DSM ₹k</th>
          </tr></thead>
          <tbody>
            {s.rows.map((r: any) => {
              const a = r.act ?? r.plan;
              const bess = a ? a.bessDis - a.bessCh : 0;
              const mk = a ? a.damBuy - a.damSell + a.rtmBuy - a.rtmSell : 0;
              return (
                <tr key={r.slot} className={r.status}>
                  <td className="num" style={{ width: 36 }}>{r.status === 'past' ? <Lock size={10} style={{ opacity: 0.5 }} /> : r.status === 'current' ? <Circle size={10} fill="#3b82f6" color="#3b82f6" /> : r.b + 1}</td>
                  <td className="l num">{r.time}</td>
                  <td className="num">{f(r.demand)}</td><td className="num">{f(a?.solar)}</td><td className="num">{f(a?.wind)}</td><td className="num">{f(a?.thermal)}</td>
                  <td className={cls('num', bess > 1 ? 'pos' : bess < -1 ? 'neg' : '')}>{a ? sign(bess, 0) : '—'}</td>
                  <td className={cls('num', mk > 1 ? '' : mk < -1 ? 'neg' : '')}>{a ? sign(mk, 0) : '—'}</td>
                  <td className="num">{f(a?.grid)}</td>
                  <td className={cls('num', a && a.curtailSolar + a.curtailWind > 1 ? 'bad' : '')}>{a ? f(a.curtailSolar + a.curtailWind) : '—'}</td>
                  <td className="num">{f(r.soc)}</td><td className="num">{n2(r.damPrice)}</td><td className="num">{n2(r.rtmPrice)}</td>
                  <td className="num plan" style={{ fontWeight: 600 }}>{r.costPerUnit == null ? '—' : n2(r.costPerUnit)}</td>
                  <td className={cls('num', (r.dsmCost ?? 0) > 25 ? 'bad' : '')}>{r.dsmCost == null ? '—' : f(r.dsmCost, 1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}


/* ------------------------------------------------------------------ actions, grouped by what they act on */
type Flow = Record<string, number>;
const TAGS: Record<number, string> = { 1: 'Security', 2: 'Reliability', 3: 'Reserve', 4: 'DSM', 5: 'Cost', 6: 'RE use', 7: 'Battery wear' };
// The six buckets are mutually exclusive (every action type belongs to exactly one, see ACTION_BUCKET on the server) and together
// cover every lever of the optimiser. The line under each name lists the moves that bucket can contain.
const BUCKETS: { k: string; label: string; verbs: string; icon: any; val?: (f: Flow) => number; fmt?: (v: number) => string }[] = [
  { k: 'battery', label: 'Battery', verbs: 'Charge · Discharge · Hold charge in reserve', icon: Battery, val: (f) => f.bessDis - f.bessCh, fmt: (v) => (Math.abs(v) < 1 ? 'idle' : v > 0 ? `discharging ${n0(v)} MW` : `charging ${n0(-v)} MW`) },
  { k: 'market', label: 'Market & imports', verbs: 'Buy · Sell · Hold back for a later sale · Contract import', icon: ArrowLeftRight, val: (f) => f.damBuy + f.rtmBuy + f.grid - f.damSell - f.rtmSell, fmt: (v) => (Math.abs(v) < 1 ? 'none' : v > 0 ? `buying ${n0(v)} MW` : `selling ${n0(-v)} MW`) },
  { k: 'renewables', label: 'Renewables', verbs: 'Curtail solar · Curtail wind', icon: Sun, val: (f) => f.curtailSolar + f.curtailWind, fmt: (v) => (Math.abs(v) < 1 ? 'nothing curtailed' : `${n0(v)} MW curtailed`) },
  { k: 'thermal', label: 'Thermal units', verbs: 'Start · Ramp up · Back down for cleaner energy · Stop', icon: Flame, val: (f) => f.thermal, fmt: (v) => `${n0(v)} MW` },
  { k: 'demand', label: 'Demand management', verbs: 'Demand response (cut non-critical load) · Shift load', icon: Users, val: (f) => f.dr + Math.abs(f.shiftNet ?? 0), fmt: (v) => (Math.abs(v) < 1 ? 'none' : `${n0(v)} MW flexed`) },
  { k: 'maintenance', label: 'Maintenance', verbs: 'Delay · Bring forward · Dispatch inspection', icon: Wrench },
];
const brief = (t: string) => { const first = (t.split(/(?<=[.;])\s/)[0] ?? t).trim(); return first.length > 150 ? first.slice(0, 147).trimEnd() + '…' : first; };

function SituationCard({ ag, now, rows, next, portfolio, committed }: { ag: any; now: any; rows: any[]; next: any; portfolio: any; committed: any }) {
  const sit = ag.situation;
  if (!sit || !now) return null;
  const a = now.act ?? now.plan;
  const re = a ? a.solar + a.wind : 0;
  // Net position of the next slot against the day-ahead schedule: the renewables available now, plus the thermal and the exchange purchases that
  // were scheduled for that slot, against the demand now expected. A shortfall is what the real-time plan has to make up (thermal above schedule,
  // battery, contract, exchange, demand management); a surplus is what it has to store, sell or curtail.
  const p = next?.plan;
  const thermalMin = (portfolio?.thermal ?? []).filter((u: any) => u.enabled && u.mustRun).reduce((a: number, u: any) => a + (u.minLoadPct / 100) * u.capacityMW, 0);
  const reAvail = p ? p.solar + p.wind + p.curtailSolar + p.curtailWind : re;
  const schedThermal = committed ? committed.thermal : thermalMin;
  const bought = committed ? committed.damBuy + committed.rtmBuy + committed.grid - committed.damSell - committed.rtmSell : p ? p.damBuy + p.rtmBuy : 0;
  const demandNext = next?.demand ?? now.demand;
  const net = p ? reAvail + schedThermal + bought - demandNext : re - now.demand;
  const position = net > 10 ? 'surplus' : net < -10 ? 'shortfall' : 'balanced';
  const dam = rows.map((r: any) => r.damPrice).filter((x: any) => x > 0);
  const avg = dam.length ? dam.reduce((x: number, y: number) => x + y, 0) / dam.length : now.rtmPrice;
  const priceState = now.rtmPrice < avg * 0.8 ? 'cheap' : now.rtmPrice > avg * 1.25 ? 'expensive' : 'normal';
  const socState = now.soc >= 80 ? 'well charged' : now.soc <= 35 ? 'low' : 'moderate';
  const active = sit.events.filter((e: any) => e.active);
  const when = (e: any) => { const h = (e.window?.[0] ?? 0) * 0.25; return h < 0.5 ? 'now' : h < 1.25 ? 'in ~1 h' : `in ~${Math.round(h)} h`; };
  const ev = active.map((e: any) => ({ e, w: when(e) }));
  const title = [position === 'surplus' ? 'Surplus after committed supply' : position === 'shortfall' ? 'Shortfall after committed supply' : 'Balanced after committed supply', `${priceState} market`].join(' + ');
  // the strategy is read from the optimiser's plan for the next slot, so it can never contradict the actions listed below
  const strat = (() => {
    if (!p) return 'Waiting for the next plan.';
    const parts: string[] = [];
    const bn = p.bessDis - p.bessCh;
    if (bn > 1) parts.push(`discharge the batteries (${n0(bn)} MW in total)${next.smc != null ? `, because other supply costs about ₹${n2(next.smc)}/kWh at the margin` : ''}`);
    else if (bn < -1) parts.push(`charge the batteries (${n0(-bn)} MW in total)`);
    else parts.push('hold the battery');
    parts.push(`thermal at ${n0(p.thermal)} MW`);
    const buy = p.damBuy + p.rtmBuy, sell = p.damSell + p.rtmSell;
    if (buy > 1) parts.push(`buy ${n0(buy)} MW on the exchange`);
    if (sell > 1) parts.push(`sell ${n0(sell)} MW`);
    if (p.grid > 1) parts.push(`contract import ${n0(p.grid)} MW`);
    if (p.curtailSolar + p.curtailWind > 1) parts.push(`curtail ${n0(p.curtailSolar + p.curtailWind)} MW of renewables`);
    if (p.dr > 1) parts.push(`demand response ${n0(p.dr)} MW`);
    return 'Next slot: ' + parts.join('; ') + '.';
  })();
  const unusual = ev.length > 0 || position !== 'balanced' || priceState !== 'normal';
  return (
    <div className="act" style={{ borderColor: unusual ? 'rgba(245,185,66,.45)' : undefined, background: unusual ? 'rgba(245,185,66,.06)' : undefined }}>
      <div className="muted" style={{ fontSize: 10.5, letterSpacing: '.06em' }}>CURRENT SITUATION</div>
      <b style={{ display: 'block', marginTop: 3 }}>{title}</b>
      {ev.map((x: any, i: number) => <div key={i} style={{ marginTop: 3, color: '#f5b942', fontWeight: 600 }}>{x.e.label} {x.w}</div>)}
      <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5, marginTop: 6 }}>
        Demand {n0(now.demand)} MW · own renewables {n0(re)} MW ({n0((re / Math.max(1, now.demand)) * 100)}% of demand) · market ₹{n2(now.rtmPrice)}/kWh (day average ₹{n2(avg)}) · battery SOC {n0(now.soc)}% ({socState})
      </div>
      {p && <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5, marginTop: 3 }}>Next slot against the day-ahead schedule: renewables available {n0(reAvail)} + scheduled thermal {n0(schedThermal)} + scheduled net purchases {n0(bought)} − demand {n0(demandNext)} = <b style={{ color: position === 'surplus' ? '#34d399' : position === 'shortfall' ? '#ff9a97' : undefined }}>{net >= 0 ? '+' : '−'}{n0(Math.abs(net))} MW</b> {position === 'surplus' ? 'surplus' : position === 'shortfall' ? 'short' : ''}</div>}
      {ev.filter((x: any) => x.e.evidence).map((x: any, i: number) => <div key={i} className="muted" style={{ fontSize: 11.5, lineHeight: 1.5, marginTop: 3 }}>• {x.e.evidence}</div>)}
      <div style={{ fontSize: 12, lineHeight: 1.5, marginTop: 6 }}><span className="muted">Strategy: </span>{strat}</div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>Priority order: {sit.objectives.map((o: any) => o.name).join(' → ')}</div>
    </div>
  );
}

function ActionsPanel({ s, portfolio }: { s: any; portfolio: any }) {
  const ag = s.agent;
  const rows = s.rows;
  const nowRow = rows[s.now.b];
  const nextRow = rows[s.now.b + 1];
  const f0: Flow | null = nowRow ? (nowRow.act ?? nowRow.plan) : null;
  const f1: Flow | null = nextRow?.plan ?? null;
  const pend: any[] = ag.pending ?? [];
  const props: any[] = ag.maintProposals ?? [];
  const used = BUCKETS.map((bk) => {
    const acts = ag.actions.filter((a: any) => a.bucket === bk.k);
    const before = bk.val && f0 ? bk.val(f0) : null, after = bk.val && f1 ? bk.val(f1) : null;
    const changed = before != null && after != null && Math.abs(after - before) >= 1;
    const mp = bk.k === 'maintenance' ? props : [];
    return { bk, acts, mp, before, after, changed };
  });
  const active = used.filter((u) => u.acts.length > 0 || u.mp.length > 0);
  const quiet = used.filter((u) => !(u.acts.length > 0 || u.mp.length > 0)).map((u) => u.bk.label);
  const nApprove = ag.actions.filter((a: any) => a.status === 'pending').length + props.length;
  const approvalId = (a: any) => pend.find((p) => p.type === a.type && p.slot === a.slot)?.id ?? a.id;
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="muted" style={{ fontWeight: 600, letterSpacing: 0.6 }}>ACTIONS FOR THE NEXT SLOT · {s.now.endTime}–{hh(((s.now.b + 2) % 96))}</div>
        {nApprove > 0 && <span className="pill warn">{nApprove} need your approval</span>}
      </div>
      <SituationCard ag={ag} now={nowRow} rows={rows} next={nextRow} portfolio={portfolio} committed={s.nextCommitted} />
      {active.length === 0 && (
        <div className="act">
          <div className="row" style={{ gap: 8 }}><CheckCircle2 size={15} color="#34d399" /><b>On schedule</b></div>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.5, marginTop: 4 }}>Everything is as expected, so the day-ahead schedule is followed{f1 ? <>: thermal {n0(f1.thermal)} MW, battery {(f1.bessDis - f1.bessCh) >= 1 ? 'discharging ' + n0(f1.bessDis - f1.bessCh) : (f1.bessDis - f1.bessCh) <= -1 ? 'charging ' + n0(f1.bessCh - f1.bessDis) : 'idle'}{(f1.bessDis - f1.bessCh) !== 0 ? ' MW' : ''}, market {n0(f1.damBuy + f1.rtmBuy - f1.damSell - f1.rtmSell)} MW net, contract {n0(f1.grid)} MW.</> : '.'}</div>
        </div>
      )}
      {used.map(({ bk, acts, mp }) => (acts.length === 0 && mp.length === 0) ? (
        <div key={bk.k} className="act" style={{ opacity: 0.4, background: 'transparent', padding: '8px 12px' }}>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}><bk.icon size={14} color="#71829f" /><span className="muted" style={{ flex: 1 }}>{bk.label}</span></div>
        </div>
      ) : (
        <div key={bk.k} className="act">
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <bk.icon size={15} color="#8fb8ff" /><b style={{ flex: 1 }} title={bk.verbs}>{bk.label}</b>
          </div>
          <div className="muted" style={{ fontSize: 10.5, marginTop: 1 }}>{bk.verbs}</div>
          {acts.map((a: any) => (
            <div key={a.id} style={{ marginTop: 9, paddingTop: 9, borderTop: '1px solid rgba(255,255,255,.06)' }}>
              <div className="row" style={{ gap: 8 }}>
                <span style={{ flex: 1, fontWeight: 600 }}>{a.title}</span>
                <span className="chip" title={a.criterion}>{TAGS[a.priority] ?? ''}</span>
              </div>
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.45, marginTop: 2 }}>{a.summary ?? brief(a.reasoning)}</div>
              {a.detail?.length > 0 && (
                <details style={{ marginTop: 6 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 11.5, color: '#71829f' }}>Customer details ({a.detail.length})</summary>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 11.5, lineHeight: 1.5, color: '#9fb0c8' }}>{a.detail.map((d: string, i: number) => <li key={i}>{d}</li>)}</ul>
                </details>
              )}
              {a.status === 'pending' && (
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn sm good" onClick={() => api(`/actions/${approvalId(a)}/approve`, { body: {} })}><Check size={13} />Approve</button>
                  <button className="btn sm danger" onClick={() => api(`/actions/${approvalId(a)}/reject`, { body: {} })}><X size={13} />Reject</button>
                </div>
              )}
            </div>
          ))}
          {mp.map((p: any) => (
            <div key={p.id} style={{ marginTop: 9, paddingTop: 9, borderTop: '1px solid rgba(255,255,255,.06)' }}>
              <div className="row" style={{ gap: 8 }}><span style={{ flex: 1, fontWeight: 600 }}>{p.item && p.newStart > p.item.startSlot ? 'Delay' : 'Bring forward'} maintenance: {p.item?.assetName}</span><span className="chip">Cost</span></div>
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.45, marginTop: 2 }}>Saves about {money(p.saving)}. {brief(p.reason)}</div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn sm good" onClick={() => api(`/maintenance/${p.id}/approve`, { body: {} })}><Check size={13} />Approve</button>
                <button className="btn sm danger" onClick={() => api(`/maintenance/${p.id}/reject`, { body: {} })}><X size={13} />Keep schedule</button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ agent */
function AgentCard({ s, portfolio }: { s: any; portfolio: any }) {
  const [tab, setTab] = useState<'actions' | 'criteria' | 'reasoning' | 'log'>('actions');
  const [q, setQ] = useState('');
  const [chat, setChat] = useState<{ q: string; a: string; src: string; note?: string; unverified?: string[] }[]>([]);
  const [busy, setBusy] = useState(false);
  const ag = s.agent;
  const ask = async () => {
    if (!q.trim()) return;
    setBusy(true);
    const question = q; setQ('');
    try {
      const r = await api('/ask', { body: { question, history: chat.slice(-2).map((c) => ({ q: c.q, a: c.a })) } });
      setChat((c) => [...c, { q: question, a: r.answer, src: r.source, note: r.note, unverified: r.unverified }]);
    } catch (err: any) {
      setChat((c) => [...c, { q: question, a: 'The agent could not be reached. Please try again in a moment.', src: 'rules', note: String(err?.message ?? err).slice(0, 120) }]);
    } finally { setBusy(false); }
  };
  const lvl = (l: string) => (l === 'critical' ? 'crit' : l === 'warn' ? 'warn' : l === 'action' ? 'live' : 'info');
  const pend = ag.pending ?? [], mp = ag.maintProposals ?? [];
  return (
    <Card title="Agent" className="agent-fill" right={<Tabs value={tab} onChange={setTab} options={[{ v: 'actions', label: 'Actions' }, { v: 'criteria', label: 'Criteria' }, { v: 'reasoning', label: 'Reasoning' }, { v: 'log', label: 'Log' }]} />}>
      <div className="agent-scroll">
        {tab === 'actions' && (
          <div className="agent-list">
            <ActionsPanel s={s} portfolio={portfolio} />
          </div>
        )}
        {tab === 'criteria' && (
          <div className="ladder">
            {ag.situation && <PolicyPanel p={{ label: ag.situation.label, objectives: ag.situation.objectives.map((o: any) => o.name), events: ag.situation.events, interactions: ag.situation.interactions, rationale: ag.situation.rationale, stages: ag.situation.stages, frequencyNote: ag.situation.frequencyNote }} />}
            <div className="muted" style={{ lineHeight: 1.5, marginBottom: 4 }}>The ladder below follows the active profile: the optimiser works through the objectives in this order and never gives up a higher one for a lower one. <b style={{ color: '#ff9a97' }}>Binding</b> means that objective is limiting the plan right now.</div>
            {ag.criteria.map((c: any) => (
              <div key={c.rank} className={cls('rung', c.status)}>
                <span className={'prio ' + (c.rank <= 3 ? 'p' + c.rank : '')}>{c.rank}</span>
                <div><b style={{ fontSize: 12.5 }}>{c.name}</b><div className="muted" style={{ fontSize: 11 }}>{c.detail}</div></div>
                <div style={{ textAlign: 'right' }}><div className="num" style={{ fontSize: 12, fontWeight: 600 }}>{c.value}</div><Pill kind={c.status === 'binding' ? 'crit' : c.status === 'watch' ? 'warn' : c.status === 'active' ? 'model' : 'live'}>{c.status === 'active' ? 'in force' : c.status}</Pill></div>
              </div>
            ))}
          </div>
        )}
        {tab === 'reasoning' && (
          <div className="col" style={{ gap: 10 }}>
            <div className="act" style={{ borderColor: 'rgba(59,130,246,.4)', background: 'rgba(59,130,246,.06)' }}><div className="row"><Sparkles size={14} color="#8fb8ff" /><b>{ag.reasoning.headline || '—'}</b></div></div>
            {ag.reasoning.bullets.map((b: string, i: number) => <p key={i} className="dim" style={{ margin: 0, lineHeight: 1.55 }}>• {b}</p>)}
            <div className="act"><div className="muted" style={{ fontWeight: 600, letterSpacing: 0.6, marginBottom: 4 }}>TRADE-OFF</div><span className="dim">{ag.reasoning.tradeoff}</span></div>
            <div className="hr" />
            <div className="muted" style={{ fontWeight: 600, letterSpacing: 0.6 }}>ASK THE AGENT</div>
            {chat.map((c, i) => <div key={i} className="act"><b style={{ fontSize: 12 }}>{c.q}</b><p style={{ whiteSpace: 'pre-wrap' }}>{c.a}</p><div className="muted" style={{ fontSize: 10.5, marginTop: 4 }}>{c.src === 'claude' ? 'Claude, grounded in the optimiser output' : 'Rule-based answer from live plan'}{c.note && <div style={{ color: '#f5b942', marginTop: 3 }}>Claude unavailable: {c.note}</div>}{c.unverified?.length ? <div style={{ color: '#f5b942', marginTop: 3 }}>Figures not found in the live data (check before relying on them): {c.unverified.join(', ')}</div> : null}</div></div>)}
            <div className="row"><input placeholder="Why is BESS-1 charging now?" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask()} /><button className="btn primary" disabled={busy} onClick={ask}><Send size={14} /></button></div>
            {busy && <div className="muted" style={{ fontSize: 11 }}>Thinking…</div>}
          </div>
        )}
        {tab === 'log' && (
          <div className="log">
            {[...s.log].reverse().map((l: any) => (
              <div key={l.id}><span className={'dot ' + lvl(l.level)} style={{ marginTop: 5 }} /><span><span className="c">{l.category}</span> {l.message}</span></div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ system health */
function HealthCard({ s, portfolio }: { s: any; portfolio: any }) {
  const next = s.rows[Math.min(95, s.now.b + 1)];
  const ru = next.reserveUpReq ? Math.min(1.5, next.reserveUpAvail / next.reserveUpReq) : 1;
  const rd = next.reserveDnReq ? Math.min(1.5, next.reserveDnAvail / next.reserveDnReq) : 1;
  const flows = s.detail.current ?? s.detail.planned ?? {};
  const cors = (portfolio?.corridors ?? []).map((c: any) => {
    const members = [...portfolio.solar, ...portfolio.wind].filter((f: any) => f.corridorId === c.id);
    const flow = members.reduce((a: number, f: any) => a + (flows[f.id] ?? 0), 0);
    return { ...c, flow, pct: (flow / c.ttcMW) * 100 };
  });
  const k = s.kpis;
  const Meter = ({ label, pct, text, kind }: { label: string; pct: number; text: string; kind?: 'bad' | 'warn' }) => (
    <div style={{ marginBottom: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}><span className="dim">{label}</span><span className="num" style={{ fontWeight: 600 }}>{text}</span></div>
      <div className="bar"><i style={{ left: 0, width: `${Math.min(100, pct)}%`, background: kind === 'bad' ? '#f0605d' : kind === 'warn' ? '#f5b942' : '#3b82f6' }} /></div>
    </div>
  );
  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
      <Card title="Reserve adequacy · next block">
        <Meter label="Upward reserve" pct={(ru / 1.5) * 100} text={`${n0(next.reserveUpAvail)} / ${n0(next.reserveUpReq)} MW`} kind={ru < 1 ? 'bad' : ru < 1.1 ? 'warn' : undefined} />
        <Meter label="Downward reserve" pct={(rd / 1.5) * 100} text={`${n0(next.reserveDnAvail)} / ${n0(next.reserveDnReq)} MW`} kind={rd < 1 ? 'bad' : undefined} />
        <div className="muted" style={{ fontSize: 11 }}>Sized from solar / wind / load forecast error; BESS counted for 30 min sustain.</div>
      </Card>
      <Card title="Transmission corridors">
        {cors.length === 0 && <div className="muted">loading…</div>}
        {cors.map((c: any) => <Meter key={c.id} label={c.id + ' · ' + c.name.split(' ').slice(0, 2).join(' ')} pct={c.pct} text={`${n0(c.flow)} / ${n0(c.ttcMW)} MW`} kind={c.pct > 98 ? 'bad' : c.pct > 90 ? 'warn' : undefined} />)}
      </Card>
      <Card title="DSM exposure · today">
        <div className="val num" style={{ fontSize: 24, fontWeight: 650 }}>{money(k.dsmCostK)}</div>
        <div className="muted" style={{ marginBottom: 8 }}>{n1(k.dsmDevMWh)} MWh deviated · {n1(k.reserveAdequacyPct)}% blocks reserve-adequate</div>
        <Meter label="Current deviation" pct={Math.min(100, (Math.abs(s.rows[s.now.b].dsmMW ?? 0) / 100) * 100)} text={`${sign(s.rows[s.now.b].dsmMW ?? 0, 1)} MW`} kind={Math.abs(s.rows[s.now.b].dsmMW ?? 0) > 50 ? 'bad' : undefined} />
      </Card>
      <Card title="Forecast accuracy · MAPE today">
        <Meter label="Load" pct={k.loadMape * 5} text={`${n1(k.loadMape)}%`} />
        <Meter label="Solar" pct={k.solarMape * 5} text={`${n1(k.solarMape)}%`} />
        <Meter label="Wind" pct={k.windMape * 5} text={`${n1(k.windMape)}%`} />
        <div className="muted" style={{ fontSize: 11 }}><CheckCircle2 size={11} style={{ verticalAlign: -1 }} /> Intraday persistence correction re-bases forecasts each block.</div>
      </Card>
    </div>
  );
}
