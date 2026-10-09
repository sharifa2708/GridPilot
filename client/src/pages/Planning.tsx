import { useEffect, useMemo, useState } from 'react';
import { Area, AreaChart, Bar, Cell, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CheckCircle2, Play, RotateCcw } from 'lucide-react';
import { api } from '../api';
import { Card, Field, Legend, Pill, Seg, Tip } from '../components/ui';
import { SRC, money, n0, n1, n2, rs } from '../format';
import { PolicyPanel } from '../components/PolicyPanel';

const hh = (b: number) => `${String(Math.floor(b / 4)).padStart(2, '0')}:${String((b % 4) * 15).padStart(2, '0')}`;
const TICKS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88];
const axis = { tickLine: false, axisLine: false, tick: { fill: '#71829f', fontSize: 10.5 } } as const;
const BASE = { solarPct: 0, windPct: 0, loadPct: 0, priceShiftPct: 0, bessAvailPct: 100, corridorDeratePct: 0, thermalOutId: '', carbonPrice: undefined as number | undefined };

export default function Planning({ s }: { s: any }) {
  const [kind, setKind] = useState<'DAM' | 'RTM'>('DAM');
  const [dayOff, setDayOff] = useState(1);
  const [ov, setOv] = useState<any>(BASE);
  const [mc, setMc] = useState(30);
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [thermal, setThermal] = useState<any[]>([]);
  useEffect(() => { api('/portfolio').then((r) => setThermal(r.portfolio.thermal)); }, []);
  const date = (off: number) => new Date(Date.parse(s.now.date) + off * 86400000).toISOString().slice(0, 10);
  const dirty = JSON.stringify(ov) !== JSON.stringify(BASE);
  // day-ahead bids for a delivery day close at 10:00 on the day before (block 40); after that the clearing prices are out and the position is fixed
  const damClosed = kind === 'DAM' && s.now.slot >= (s.now.day + dayOff - 1) * 96 + 40;

  const run = async () => {
    setBusy(true); setErr(''); setMsg('');
    const overrides: any = {};
    if (ov.solarPct) overrides.solarPct = ov.solarPct;
    if (ov.windPct) overrides.windPct = ov.windPct;
    if (ov.loadPct) overrides.loadPct = ov.loadPct;
    if (ov.priceShiftPct) overrides.priceShiftPct = ov.priceShiftPct;
    if (ov.bessAvailPct !== 100) overrides.bessAvailPct = ov.bessAvailPct;
    if (ov.corridorDeratePct) overrides.corridorDeratePct = ov.corridorDeratePct;
    if (ov.thermalOutId) overrides.thermalOutId = ov.thermalOutId;
    if (ov.carbonPrice != null && ov.carbonPrice !== '') overrides.carbonPrice = Number(ov.carbonPrice);
    try {
      const r = await api('/plan', { body: { kind, day: kind === 'DAM' ? s.now.day + dayOff : undefined, overrides, mc } });
      if (r.ok === false) throw new Error(r.error);
      setRes(r);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const commit = async () => {
    const r = await api('/plan/commit', { body: { draftId: res.draftId } });
    setMsg(r.message);
  };
  const slider = (k: string, label: string, min: number, max: number, unit = '%') => (
    <label className="f"><span className="row"><span>{label}</span><span className="spacer" /><b className="num" style={{ color: ov[k] === BASE[k as keyof typeof BASE] ? 'var(--text-3)' : '#8fb8ff' }}>{ov[k] > 0 && k !== 'bessAvailPct' ? '+' : ''}{ov[k]}{unit}</b></span>
      <input type="range" min={min} max={max} value={ov[k]} onChange={(e) => setOv({ ...ov, [k]: Number(e.target.value) })} /></label>
  );
  return (
    <div className="grid" style={{ gridTemplateColumns: '320px minmax(0,1fr)', alignItems: 'start' }}>
      <div className="grid" style={{ position: 'sticky', top: 0 }}>
        <Card title="Market segment">
          <div className="col" style={{ gap: 12 }}>
            <Seg value={kind} onChange={(v) => { setKind(v); setRes(null); }} options={[{ v: 'DAM', label: 'Day-ahead (DAM)' }, { v: 'RTM', label: 'Real-time (RTM)' }]} />
            {kind === 'DAM' ? (
              <Field label="Delivery day" hint="Bids close 10:00 on D-1; MCP published ~13:00">
                <select value={dayOff} onChange={(e) => setDayOff(Number(e.target.value))}>{[1, 2].map((o) => <option key={o} value={o}>{date(o)}{s.damCommitted.includes(s.now.day + o) ? ' · committed' : ''}</option>)}</select>
              </Field>
            ) : <div className="muted" style={{ lineHeight: 1.5 }}>Re-optimises the next 24 h from block <b className="dim">{s.now.endTime}</b> with the cleared DAM position fixed. Blocks inside the {4}-block gate-closure window are locked; the rest are RTM bids you can pre-commit.</div>}
          </div>
        </Card>
        <Card title="What-if levers" right={dirty ? <button className="btn ghost sm" onClick={() => setOv(BASE)}><RotateCcw size={12} />Reset</button> : undefined}>
          <div className="col" style={{ gap: 12 }}>
            {slider('solarPct', 'Solar forecast', -40, 40)}
            {slider('windPct', 'Wind forecast', -50, 50)}
            {slider('loadPct', 'Demand', -15, 20)}
            {slider('priceShiftPct', 'Market price level', -40, 60)}
            {slider('bessAvailPct', 'BESS availability', 0, 100)}
            {slider('corridorDeratePct', 'Corridor derate', 0, 60)}
            <Field label="Thermal unit outage"><select value={ov.thermalOutId} onChange={(e) => setOv({ ...ov, thermalOutId: e.target.value })}><option value="">None</option>{thermal.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
            <Field label="Carbon price ₹/tCO₂" hint="blank = system setting"><input type="number" value={ov.carbonPrice ?? ''} placeholder="1000" onChange={(e) => setOv({ ...ov, carbonPrice: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
            <label className="f"><span className="row"><span>Monte-Carlo scenarios</span><span className="spacer" /><b className="num">{mc}</b></span><input type="range" min={0} max={60} step={10} value={mc} onChange={(e) => setMc(Number(e.target.value))} /></label>
          </div>
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 14 }} disabled={busy} onClick={run}><Play size={14} />{busy ? 'Optimising…' : dirty ? 'Run what-if' : 'Optimise & simulate'}</button>
          {err && <div className="pill crit" style={{ marginTop: 10, whiteSpace: 'normal' }}>{err}</div>}
        </Card>
      </div>
      <div className="grid" style={{ minWidth: 0 }}>
        {!res && !busy && kind === 'DAM' && (s.damCommitted ?? []).includes(s.now.day + dayOff) && <Committed date={date(dayOff)} />}
        {!res && !busy && kind === 'RTM' && <RtmCurrent s={s} />}
        {!res && !busy && <Card><div className="empty"><b style={{ color: 'var(--text-2)' }}>No plan yet.</b><br />Choose a segment, optionally move the what-if levers, and run the optimiser. The schedule is stress-tested against forecast-error scenarios before you commit it.</div></Card>}
        {busy && <Card><div className="empty"><div className="spin" />Solving 96-block MILP and running {mc} Monte-Carlo scenarios…</div></Card>}
        {res && !busy && <Results res={res} kind={kind} commit={commit} msg={msg} closed={damClosed} />}
      </div>
    </div>
  );
}

function Delta({ v, base, fmt, lowerBetter = true }: { v: number; base?: number; fmt: (x: number) => string; lowerBetter?: boolean }) {
  if (base == null) return null;
  const d = v - base;
  if (Math.abs(d) < 1e-6) return <span className="muted">= baseline</span>;
  const good = lowerBetter ? d < 0 : d > 0;
  return <span className={good ? 'pos' : 'bad'}>{d > 0 ? '▲' : '▼'} {fmt(Math.abs(d))} vs baseline</span>;
}

function Results({ res, kind, commit, msg, closed }: { res: any; kind: 'DAM' | 'RTM'; commit: () => void; msg: string; closed?: boolean }) {
  const t = res.totals, b = res.baseline?.totals, mc = res.mc;
  const rows = res.rows;
  const plan = useMemo(() => rows.map((r: any) => ({
    b: r.b, i: rows.indexOf(r), wind: r.wind, thermal: r.thermal, market: r.damBuy + r.rtmBuy, solar: r.solar, grid: r.grid, bess: Math.max(0, r.bessNet),
    charging: Math.min(0, r.bessNet), export: -(r.damSell + r.rtmSell), curtail: -r.curtail, demand: r.demand, damBuy: r.damBuy, damSell: -r.damSell, rtmBuy: r.rtmBuy, rtmSell: -r.rtmSell,
    dam: r.damPrice, rtm: r.rtmPrice, smc: r.smc, soc: r.soc, locked: kind === 'RTM' && rows.indexOf(r) < res.rtmLeadBlocks,
  })), [rows]);
  const xKey = 'i';
  const lab = (i: number) => hh(rows[Math.min(rows.length - 1, Math.max(0, Math.round(i)))]?.b ?? 0);
  const ticks = rows.map((_: any, i: number) => i).filter((i: number) => rows[i].b % 8 === 0);
  const xAx = <XAxis dataKey={xKey} ticks={ticks} tickFormatter={lab} {...axis} />;
  const hist = useMemo(() => {
    if (!mc) return [];
    const a = mc.costSamples as number[]; const lo = Math.min(...a), hi = Math.max(...a); const nb = 10; const w = (hi - lo) / nb || 1;
    const bins = Array.from({ length: nb }, (_, i) => ({ x: lo + w * (i + 0.5), n: 0 }));
    a.forEach((v) => { bins[Math.min(nb - 1, Math.floor((v - lo) / w))].n++; });
    return bins;
  }, [mc]);
  const band = mc ? mc.devBand.map((d: any, i: number) => ({ i, lo: d.p10, span: Math.max(0, d.p90 - d.p10), med: d.p50 })) : [];
  const Tile = ({ label, value, d }: { label: string; value: string; d?: React.ReactNode }) => (<div className="card kpi"><div className="lab">{label}</div><div className="val num" style={{ fontSize: 20 }}>{value}</div><div className="ft">{d}</div></div>);
  return (
    <>
      <Card>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Pill kind="live"><CheckCircle2 size={12} />{res.solve.mip ? 'MILP' : 'LP'} {res.solve.status} · {res.solve.ms} ms</Pill>
          <span className="dim">{kind === 'DAM' ? `Day-ahead schedule for ${res.date}` : `Intraday re-optimisation from ${hh(rows[0].b)}`}</span>
          {res.committed && <Pill kind="model">Currently committed: {res.committed.source}</Pill>}
          <div className="spacer" />
          {closed ? <Pill kind="warn" title="Bids closed at 10:00 on the day before delivery and the market clearing prices are published, so the day-ahead position can no longer be changed. This run is for analysis only.">Bids closed · analysis only</Pill> : <button className="btn good" onClick={commit}>{kind === 'DAM' ? 'Commit DAM schedule' : 'Place RTM bids'}</button>}
        </div>
        {msg && <div className="pill live" style={{ marginTop: 10 }}>{msg}</div>}
      </Card>
      {res.policy && <PolicyPanel p={{ label: res.policy.label, objectives: res.policy.objectives, events: res.policy.events.map((e: any) => ({ ...e, label: e.kind.replace(/_/g, ' '), active: true })), interactions: res.policy.interactions, rationale: res.policy.rationale, stages: res.stages.map((st: any) => ({ ...st, objective: st.objective ?? st.group })), feasibility: res.feasibility, conflicts: res.conflicts }} />}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
        <Tile label="Expected total cost" value={money(t.totalCostK)} d={<Delta v={t.totalCostK} base={b?.totalCostK} fmt={money} />} />
        <Tile label="Cost per unit" value={`${rs(t.cpu)}/kWh`} d={<Delta v={t.cpu} base={b?.cpu} fmt={(x) => '₹' + x.toFixed(2)} />} />
        <Tile label="RE utilisation" value={`${n1(t.reUtilPct)}%`} d={<Delta v={t.reUtilPct} base={b?.reUtilPct} fmt={(x) => x.toFixed(1) + ' pt'} lowerBetter={false} />} />
        <Tile label="RE curtailed" value={`${n1(t.curtailMWh)} MWh`} d={<Delta v={t.curtailMWh} base={b?.curtailMWh} fmt={(x) => x.toFixed(1) + ' MWh'} />} />
        <Tile label="Market bought / sold" value={`${n0(t.buyMWh)} / ${n0(t.sellMWh)} MWh`} d={<span>peak buy {n0(t.peakBuyMW)} MW</span>} />
        <Tile label="BESS cycles" value={n2(t.bessCycles)} d={<Delta v={t.bessCycles} base={b?.bessCycles} fmt={(x) => x.toFixed(2)} />} />
        <Tile label="CO₂ emitted" value={`${n0(t.emissionsT)} t`} d={<Delta v={t.emissionsT} base={b?.emissionsT} fmt={(x) => n0(x) + ' t'} />} />
        <Tile label="Unserved energy" value={`${n1(t.unservedMWh)} MWh`} d={<span>DR {n1(t.drMWh)} MWh</span>} />
      </div>
      <Card title="Optimised dispatch">
        <div style={{ height: 260 }}>
          <ResponsiveContainer>
            <AreaChart data={plan} stackOffset="sign" margin={{ top: 8, right: 8, left: -14, bottom: 0 }} syncId="p">
              <CartesianGrid stroke="#1f2c42" strokeOpacity={0.6} vertical={false} />{xAx}<YAxis {...axis} width={44} />
              <Tooltip content={<Tip fmt={{ title: (i: number) => lab(i), value: (v: number) => `${Math.abs(v).toFixed(0)} MW` }} />} />
              {(['wind', 'thermal', 'market', 'solar', 'grid', 'bess'] as const).map((k) => <Area key={k} dataKey={k} name={SRC[k].label} stackId="s" stroke={SRC[k].color} fill={SRC[k].color} fillOpacity={0.88} strokeWidth={0} isAnimationActive={false} type="monotone" />)}
              <Area dataKey="charging" name="BESS charging" stackId="s" stroke="#9085e9" fill="#9085e9" fillOpacity={0.4} strokeWidth={0} isAnimationActive={false} type="monotone" />
              <Area dataKey="export" name="Export / sale" stackId="s" stroke="#199e70" fill="#199e70" fillOpacity={0.35} strokeWidth={0} isAnimationActive={false} type="monotone" />
              <Area dataKey="curtail" name="RE curtailed" stackId="s" stroke="#8a9bb3" fill="#8a9bb3" fillOpacity={0.45} strokeWidth={0} isAnimationActive={false} type="monotone" />
              <Line dataKey="demand" name="Demand" stroke="#fff" strokeWidth={2} dot={false} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <Legend items={[...(['wind', 'thermal', 'market', 'solar', 'grid', 'bess'] as const).map((k) => ({ label: SRC[k].label, color: SRC[k].color })), { label: 'Demand', color: '#fff' }]} />
      </Card>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Card title={kind === 'DAM' ? 'DAM bids · MW per block' : 'Market positions · MW per block'}>
          <div style={{ height: 190 }}>
            <ResponsiveContainer>
              <BarChart data={plan} stackOffset="sign" margin={{ top: 6, right: 8, left: -14, bottom: 0 }} barCategoryGap={0}>
                <CartesianGrid stroke="#1f2c42" strokeOpacity={0.6} vertical={false} />{xAx}<YAxis {...axis} width={44} />
                <Tooltip content={<Tip fmt={{ title: (i: number) => lab(i), value: (v: number) => `${Math.abs(v).toFixed(0)} MW` }} />} />
                <ReferenceLine y={0} stroke="#2a3a56" />
                <Bar dataKey="damBuy" name="DAM buy" stackId="m" fill="#199e70" isAnimationActive={false} />
                <Bar dataKey="rtmBuy" name="RTM buy" stackId="m" fill="#3987e5" isAnimationActive={false} />
                <Bar dataKey="damSell" name="DAM sell" stackId="m" fill="#c98500" isAnimationActive={false} />
                <Bar dataKey="rtmSell" name="RTM sell" stackId="m" fill="#d55181" isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <Legend items={[{ label: 'DAM buy', color: '#199e70' }, { label: 'RTM buy', color: '#3987e5' }, { label: 'DAM sell', color: '#c98500' }, { label: 'RTM sell', color: '#d55181' }]} />
        </Card>
        <Card title="Price ₹/kWh · and BESS state of charge">
          <div style={{ height: 190 }}>
            <ResponsiveContainer>
              <LineChart data={plan} margin={{ top: 6, right: 8, left: -14, bottom: 0 }}>
                <CartesianGrid stroke="#1f2c42" strokeOpacity={0.6} vertical={false} />{xAx}<YAxis {...axis} width={44} domain={[0, 'auto']} />
                <Tooltip content={<Tip fmt={{ title: (i: number) => lab(i), value: (v: number) => `₹${v.toFixed(2)}` }} />} />
                <Line dataKey="dam" name="DAM forecast" stroke="#3987e5" strokeWidth={1.8} dot={false} type="stepAfter" isAnimationActive={false} />
                <Line dataKey="rtm" name="RTM forecast" stroke="#c98500" strokeWidth={1.8} dot={false} type="stepAfter" isAnimationActive={false} />
                <Line dataKey="smc" name="Marginal cost" stroke="#d55181" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div style={{ height: 80 }}>
            <ResponsiveContainer>
              <AreaChart data={plan} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
                <XAxis dataKey="i" hide /><YAxis {...axis} width={44} domain={[0, 100]} ticks={[0, 50, 100]} />
                <Tooltip content={<Tip fmt={{ title: (i: number) => lab(i), value: (v: number) => `${v.toFixed(0)}%` }} />} />
                <Area dataKey="soc" name="BESS SOC" stroke="#9085e9" fill="#9085e9" fillOpacity={0.3} strokeWidth={2} isAnimationActive={false} type="monotone" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <Legend items={[{ label: 'DAM', color: '#3987e5' }, { label: 'RTM', color: '#c98500' }, { label: 'Marginal cost', color: '#d55181', dash: true }, { label: 'BESS SOC', color: '#9085e9' }]} />
        </Card>
      </div>
      {mc && (
        <Card title={`Risk — ${mc.n} Monte-Carlo scenarios of forecast error (solar, wind, load, price)`} right={<span className="muted">same real-time balancing + DSM logic as live operation</span>}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))', marginBottom: 12 }}>
            {[['Cost P10 – P90', `${money(mc.cost.p10)} – ${money(mc.cost.p90)}`, `median ${money(mc.cost.p50)}`], ['Cost/unit P50 · P90', `${rs(mc.cpu.p50)} · ${rs(mc.cpu.p90)}`, ''], ['Expected DSM', money(mc.dsm.mean), `P90 ${money(mc.dsm.p90)}`], ['Min BESS SOC (P10)', `${n0(mc.minSoc.p10)}%`, `unserved P90 ${n1(mc.unserved.p90)} MWh`]].map(([l, v, f]) => <div key={l} className="act"><div className="muted">{l}</div><div className="num" style={{ fontSize: 17, fontWeight: 650, marginTop: 3 }}>{v}</div><div className="muted">{f}</div></div>)}
          </div>
          <div className="grid" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
            <div>
              <div className="muted">Schedule deviation after real-time balancing (MW) — P10–P90 band</div>
              <div style={{ height: 170 }}>
                <ResponsiveContainer>
                  <AreaChart data={band} margin={{ top: 6, right: 8, left: -14, bottom: 0 }}>
                    <CartesianGrid stroke="#1f2c42" strokeOpacity={0.6} vertical={false} />{xAx}<YAxis {...axis} width={44} />
                    <Tooltip content={<Tip fmt={{ title: (i: number) => lab(i), value: (v: number) => `${v.toFixed(1)} MW` }} />} />
                    <ReferenceLine y={0} stroke="#2a3a56" />
                    <Area dataKey="lo" name="_lo" stackId="b" stroke="none" fill="transparent" isAnimationActive={false} />
                    <Area dataKey="span" name="P10–P90 spread" stackId="b" stroke="none" fill="#3b82f6" fillOpacity={0.3} isAnimationActive={false} />
                    <Line dataKey="med" name="Median" stroke="#8fb8ff" strokeWidth={1.6} dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div>
              <div className="muted">Distribution of total cost</div>
              <div style={{ height: 170 }}>
                <ResponsiveContainer>
                  <BarChart data={hist} margin={{ top: 6, right: 8, left: -14, bottom: 0 }} barCategoryGap={2}>
                    <XAxis dataKey="x" tickFormatter={(v) => money(v)} {...axis} interval={2} /><YAxis {...axis} width={30} allowDecimals={false} />
                    <Tooltip content={<Tip fmt={{ title: (v: number) => money(v), value: (v: number) => `${v} scenarios` }} />} />
                    <Bar dataKey="n" name="Scenarios" fill="#9085e9" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </Card>
      )}
      <Card title="Block-wise schedule & bids" bodyClass="">
        <div className="sched" style={{ margin: '10px -16px -16px', maxHeight: 360 }}>
          <table className="t"><thead><tr><th className="l">Time</th><th>Demand</th><th>Solar</th><th>Wind</th><th>Thermal</th><th>BESS ±</th><th>DAM ±</th><th>RTM ±</th><th>Grid</th><th>Curtail</th><th>SOC %</th><th>DAM ₹</th><th>RTM ₹</th><th>SMC ₹</th><th>₹/kWh</th></tr></thead>
            <tbody>{rows.map((r: any, i: number) => (
              <tr key={i} className={kind === 'RTM' && i < res.rtmLeadBlocks ? 'past' : ''}>
                <td className="l num">{r.time}{kind === 'RTM' && i < res.rtmLeadBlocks ? ' 🔒' : ''}</td><td className="num">{n0(r.demand)}</td><td className="num">{n0(r.solar)}</td><td className="num">{n0(r.wind)}</td><td className="num">{n0(r.thermal)}</td>
                <td className={'num ' + (r.bessNet > 1 ? 'pos' : r.bessNet < -1 ? 'neg' : '')}>{n0(r.bessNet)}</td><td className="num">{n0(r.damBuy - r.damSell)}</td><td className="num">{n0(r.rtmBuy - r.rtmSell)}</td><td className="num">{n0(r.grid)}</td><td className="num">{n0(r.curtail)}</td>
                <td className="num">{n0(r.soc)}</td><td className="num">{n2(r.damPrice)}</td><td className="num">{n2(r.rtmPrice)}</td><td className="num">{r.smc == null ? '—' : n2(r.smc)}</td><td className="num">{n2(r.cpu)}</td>
              </tr>))}</tbody></table>
        </div>
      </Card>
    </>
  );
}

/* ------------------------------------------------------------------ the schedule already committed for the selected delivery day */
function Committed({ date }: { date: string }) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => { setRows(null); api('/day/' + date).then((r) => setRows(r.rows)).catch(() => setRows([])); }, [date]);
  if (!rows) return <Card title="Committed day-ahead schedule"><div className="empty"><div className="spin" /></div></Card>;
  const pl = rows.filter((r) => r.plan || r.act);
  if (!pl.length) return null;
  const fl = (r: any) => r.act ?? r.plan;
  const buy = pl.reduce((a, r) => a + fl(r).damBuy, 0) * 0.25, sell = pl.reduce((a, r) => a + fl(r).damSell, 0) * 0.25;
  const dem = pl.reduce((a, r) => a + r.demand, 0) * 0.25;
  const avgDam = pl.reduce((a, r) => a + r.damPrice, 0) / pl.length;
  const data = rows.map((r, i) => ({ t: hh(i), buy: r.plan ? r.plan.damBuy : 0, sell: r.plan ? -r.plan.damSell : 0 }));
  return (
    <Card title={'Committed day-ahead schedule · ' + date} right={<Pill kind="live">committed</Pill>}>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))', marginBottom: 12 }}>
        <div><div className="muted">Day-ahead bought</div><b className="num">{n0(buy)} MWh</b></div>
        <div><div className="muted">Day-ahead sold</div><b className="num">{n0(sell)} MWh</b></div>
        <div><div className="muted">Expected demand</div><b className="num">{n0(dem)} MWh</b></div>
        <div><div className="muted">Average DAM price</div><b className="num">{rs(avgDam)}/kWh</b></div>
      </div>
      <div style={{ height: 180 }}>
        <ResponsiveContainer>
          <BarChart data={data} stackOffset="sign" margin={{ left: -10, right: 4 }}>
            <CartesianGrid vertical={false} stroke="rgba(120,150,200,.12)" />
            <XAxis dataKey="t" ticks={TICKS.map(hh)} {...axis} /><YAxis {...axis} />
            <Tooltip contentStyle={{ background: '#0f1624', border: '1px solid #26324a', fontSize: 12 }} formatter={(v: any) => n0(Math.abs(v)) + ' MW'} />
            <Bar dataKey="buy" name="Buy" stackId="a" fill="#60a5fa" /><Bar dataKey="sell" name="Sell" stackId="a" fill="#34d399" />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="muted" style={{ marginTop: 8, lineHeight: 1.5 }}>This is the schedule currently in force for the day. Run the optimiser to test a different plan; the committed schedule changes only when you press Commit.</div>
      <div style={{ maxHeight: 280, overflow: 'auto', marginTop: 8 }}>
        <table className="t">
          <thead><tr><th className="l">Time</th><th>Demand</th><th>Solar</th><th>Wind</th><th>Thermal</th><th>BESS ±</th><th>DAM buy</th><th>DAM sell</th><th>DAM ₹</th></tr></thead>
          <tbody>{rows.map((r, i) => { const a = fl(r); return a ? (<tr key={i}><td className="l num">{hh(i)}</td><td className="num">{n0(r.demand)}</td><td className="num">{n0(a.solar)}</td><td className="num">{n0(a.wind)}</td><td className="num">{n0(a.thermal)}</td><td className="num">{n0(a.bessDis - a.bessCh)}</td><td className="num">{n0(a.damBuy)}</td><td className="num">{n0(a.damSell)}</td><td className="num">{n2(r.damPrice)}</td></tr>) : null; })}</tbody>
        </table>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ the live plan for the next 24 h, with the gate-closure window locked */
function RtmCurrent({ s }: { s: any }) {
  const lead: number = s.settings?.market?.rtmLeadBlocks ?? 4;
  const [rows, setRows] = useState<any[] | null>(null);
  const d0 = s.now.date, d1 = new Date(Date.parse(d0) + 86400000).toISOString().slice(0, 10);
  useEffect(() => {
    let live = true;
    Promise.all([api('/day/' + d0), api('/day/' + d1).catch(() => ({ rows: [] }))]).then(([a, b]) => {
      if (!live) return;
      const all = [...a.rows, ...(b.rows ?? [])];
      setRows(all.slice(s.now.b + 1, s.now.b + 97));
    }).catch(() => live && setRows([]));
    return () => { live = false; };
  }, [d0, d1, s.now.b, s.plan?.version]);
  if (!rows) return <Card title="Current real-time plan"><div className="empty"><div className="spin" /></div></Card>;
  const pl = rows.filter((r) => r.plan);
  if (!pl.length) return null;
  const buy = pl.reduce((a, r) => a + r.plan.rtmBuy, 0) * 0.25, sell = pl.reduce((a, r) => a + r.plan.rtmSell, 0) * 0.25;
  const lockedBuy = pl.slice(0, lead).reduce((a, r) => a + r.plan.rtmBuy, 0) * 0.25, lockedSell = pl.slice(0, lead).reduce((a, r) => a + r.plan.rtmSell, 0) * 0.25;
  const data = rows.map((r, i) => ({ t: r.time, buy: r.plan ? r.plan.rtmBuy : 0, sell: r.plan ? -r.plan.rtmSell : 0, locked: i < lead }));
  return (
    <Card title={'Current real-time plan · from ' + (rows[0]?.time ?? '')} right={<Pill kind="live">live plan</Pill>}>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))', marginBottom: 12 }}>
        <div><div className="muted">RTM bought (24 h)</div><b className="num">{n0(buy)} MWh</b></div>
        <div><div className="muted">RTM sold (24 h)</div><b className="num">{n0(sell)} MWh</b></div>
        <div><div className="muted">Locked, next {lead} blocks</div><b className="num">{n0(lockedBuy)} buy · {n0(lockedSell)} sell MWh</b></div>
        <div><div className="muted">Average RTM price</div><b className="num">{rs(pl.reduce((a, r) => a + r.rtmPrice, 0) / pl.length)}/kWh</b></div>
      </div>
      <div style={{ height: 180 }}>
        <ResponsiveContainer>
          <BarChart data={data} stackOffset="sign" margin={{ left: -10, right: 4 }}>
            <CartesianGrid vertical={false} stroke="rgba(120,150,200,.12)" />
            <XAxis dataKey="t" interval={11} {...axis} /><YAxis {...axis} />
            <Tooltip contentStyle={{ background: '#0f1624', border: '1px solid #26324a', fontSize: 12 }} formatter={(v: any) => n0(Math.abs(v)) + ' MW'} />
            <Bar dataKey="buy" name="Buy" stackId="a">{data.map((d, i) => <Cell key={i} fill={d.locked ? '#3b5b8f' : '#60a5fa'} />)}</Bar>
            <Bar dataKey="sell" name="Sell" stackId="a">{data.map((d, i) => <Cell key={i} fill={d.locked ? '#2a7a5f' : '#34d399'} />)}</Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="muted" style={{ marginTop: 8, lineHeight: 1.5 }}>The first {lead} blocks (darker bars, 🔒) are inside the gate-closure window and can no longer change. The rest is the agent's current plan and is refreshed every block; pre-commit it from a draft below if you want it fixed.</div>
      <div style={{ maxHeight: 280, overflow: 'auto', marginTop: 8 }}>
        <table className="t">
          <thead><tr><th className="l">Time</th><th>Demand</th><th>Solar</th><th>Wind</th><th>Thermal</th><th>BESS ±</th><th>RTM buy</th><th>RTM sell</th><th>RTM ₹</th></tr></thead>
          <tbody>{rows.map((r, i) => r.plan ? (<tr key={i} className={i < lead ? 'past' : ''}><td className="l num">{r.time}{i < lead ? ' 🔒' : ''}</td><td className="num">{n0(r.demand)}</td><td className="num">{n0(r.plan.solar)}</td><td className="num">{n0(r.plan.wind)}</td><td className="num">{n0(r.plan.thermal)}</td><td className="num">{n0(r.plan.bessDis - r.plan.bessCh)}</td><td className="num">{n0(r.plan.rtmBuy)}</td><td className="num">{n0(r.plan.rtmSell)}</td><td className="num">{n2(r.rtmPrice)}</td></tr>) : null)}</tbody>
        </table>
      </div>
    </Card>
  );
}
