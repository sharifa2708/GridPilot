import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, Legend, Tip } from '../components/ui';
import { SRC, money, n0, n1, n2, rs } from '../format';

export default function Performance({ s }: { s: any }) {
  const k = s.kpis;
  const rows = s.rows.filter((r: any) => r.cost);
  const hh = (b: number) => `${String(Math.floor(b / 4)).padStart(2, '0')}:${String((b % 4) * 15).padStart(2, '0')}`;
  const data = rows.map((r: any) => ({ b: r.b, thermal: Math.max(0, r.cost.thermal + r.cost.fixed + r.cost.startup), solar: r.cost.solar, wind: r.cost.wind, market: Math.max(0, r.cost.market), grid: r.cost.grid, bess: Math.max(0, r.cost.bess), dsm: Math.max(0, r.cost.dsm), future: r.status === 'future' }));
  const tiles = [
    { t: 'RE utilisation', v: `${n1(k.reUtilPct)}%`, g: 'Maximise', ok: k.reUtilPct > 97 },
    { t: 'RE curtailment', v: `${n1(k.curtailMWh)} MWh`, g: 'Minimise', ok: k.curtailMWh < 50 },
    { t: 'DSM cost', v: money(k.dsmCostK), g: 'Minimise', ok: k.dsmCostK < 150 },
    { t: 'BESS cycles', v: n2(k.bessCycles), g: 'Optimise (≤1.5/day)', ok: k.bessCycles <= 1.5 },
    { t: 'BESS arbitrage benefit', v: money(k.bessBenefitK), g: 'Maximise', ok: k.bessBenefitK > 0 },
    { t: 'Peak market purchase', v: `${n0(k.peakMarketMW)} MW`, g: 'Minimise at peak', ok: true },
    { t: 'Thermal starts', v: `${n0(k.thermalStarts)}`, g: 'Optimise', ok: k.thermalStarts < 4 },
    { t: 'Forecast error (load / solar / wind)', v: `${n1(k.loadMape)} / ${n1(k.solarMape)} / ${n1(k.windMape)} %`, g: 'Minimise', ok: k.solarMape < 15 },
    { t: 'Reserve adequacy', v: `${n1(k.reserveAdequacyPct)}% blocks`, g: 'Maintain 100%', ok: k.reserveAdequacyPct > 99 },
    { t: 'Average power cost (incl. DSM)', v: `${rs(k.cpu)}/kWh`, g: 'Minimise', ok: true },
    { t: 'Margin vs avg tariff', v: `${rs(k.marginPerUnit)}/kWh`, g: 'Maximise', ok: k.marginPerUnit > 0 },
    { t: 'Carbon intensity', v: `${n2(k.intensity)} t/MWh`, g: 'Minimise', ok: k.intensity < 0.7 },
  ];
  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
        {tiles.map((x) => (
          <div key={x.t} className="card kpi">
            <div className="lab"><span className={'dot ' + (x.ok ? 'live' : 'warn')} />{x.t}</div>
            <div className="val num" style={{ fontSize: 20 }}>{x.v}</div>
            <div className="ft"><span>Target: {x.g}</span></div>
          </div>
        ))}
      </div>
      <Card title={`Cost composition by block · ${n0(k.blocksDone)} blocks executed · ${money(k.costK)} total · ${n0(k.energyServedMWh)} MWh served`}>
        <div style={{ height: 280 }}>
          <ResponsiveContainer>
            <BarChart data={data} margin={{ top: 10, right: 8, left: -6, bottom: 0 }} barCategoryGap={1}>
              <CartesianGrid stroke="#1f2c42" strokeOpacity={0.6} vertical={false} />
              <XAxis dataKey="b" tickFormatter={hh} interval={7} tickLine={false} axisLine={false} tick={{ fill: '#71829f', fontSize: 10.5 }} />
              <YAxis tickLine={false} axisLine={false} tick={{ fill: '#71829f', fontSize: 10.5 }} width={50} />
              <Tooltip content={<Tip fmt={{ title: (b: number) => hh(b), value: (v: number) => money(v) }} />} />
              {(['wind', 'thermal', 'market', 'solar', 'grid', 'bess', 'dsm'] as const).map((key) => <Bar key={key} dataKey={key} name={SRC[key].label} stackId="c" fill={SRC[key].color} isAnimationActive={false} />)}
            </BarChart>
          </ResponsiveContainer>
        </div>
        <Legend items={(['wind', 'thermal', 'market', 'solar', 'grid', 'bess', 'dsm'] as const).map((k2) => ({ label: SRC[k2].label, color: SRC[k2].color }))} />
        <div className="muted" style={{ marginTop: 8 }}>Thermal includes fixed capacity charges and amortised start-up cost; BESS shows net inventory expense + degradation; ₹ '000 per block.</div>
      </Card>
    </div>
  );
}
