import { useEffect, useState } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import { api } from '../api';
import { Card, Field, Seg } from '../components/ui';

export default function Settings({ s }: { s: any }) {
  const [d, setD] = useState<any>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { api('/settings').then((r) => setD(r.settings)); }, []);
  if (!d) return null;
  const set = (grp: string, k: string, v: any) => setD({ ...d, [grp]: { ...d[grp], [k]: v } });
  const num = (grp: string, k: string, step = 1) => <input type="number" step={step} value={d[grp][k]} onChange={(e) => set(grp, k, Number(e.target.value))} />;
  const save = async () => { await api('/settings', { method: 'PUT', body: { autonomy: d.autonomy, weights: d.weights, market: d.market, dsm: d.dsm, reserve: d.reserve, llm: d.llm } }); setSaved(true); setTimeout(() => setSaved(false), 2200); };
  const reset = async () => { if (confirm('Reset the whole simulation (portfolio, schedules, history) to defaults?')) { await api('/sim/reset', { body: {} }); location.reload(); } };
  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0,1fr))', alignItems: 'start' }}>
      <Card title="Agent autonomy">
        <div className="col" style={{ gap: 12 }}>
          <Seg value={d.autonomy} onChange={(v) => setD({ ...d, autonomy: v })} options={[{ v: 'autonomous', label: 'Autonomous' }, { v: 'supervised', label: 'Supervised (human approval)' }]} />
          <div className="muted" style={{ lineHeight: 1.55 }}><b className="dim">Autonomous:</b> the agent executes its plan, including curtailment, demand response and maintenance re-scheduling, and logs its reasoning.<br /><b className="dim">Supervised:</b> high-impact actions (curtailment &gt; 40 MW, demand response, maintenance changes) wait for operator approval; a rejection vetoes the action and triggers an immediate re-optimisation.</div>
          <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={d.llm.enabled} onChange={(e) => setD({ ...d, llm: { enabled: e.target.checked } })} />Allow LLM explanations (needs ANTHROPIC_API_KEY on the server; grounded in optimiser output only)</label>
        </div>
      </Card>
      <Card title="Optimality criteria — weights inside the cost layer">
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Field label="Carbon shadow price ₹/tCO₂" hint="Internal price added to thermal & imported energy. 0 = ignore carbon.">{num('weights', 'carbonPrice', 50)}</Field>
          <Field label="BESS degradation multiplier" hint="Scales ₹/kWh degradation cost per asset.">{num('weights', 'degradationScale', 0.1)}</Field>
        </div>
        <div className="muted" style={{ marginTop: 10, lineHeight: 1.55 }}>The order in which objectives are optimised changes with the operating situation (normal, evening ramp, price spike, outage, frequency event …). It is set in <code>server/policy/policy.config.json</code>, with the thresholds and which actions are allowed. These two weights tune the trade-offs <i>within</i> the cost objective.</div>
      </Card>
      <Card title="Market rules (CERC / IEX)">
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Field label="Price cap ₹/kWh">{num('market', 'priceCap', 0.5)}</Field>
          <Field label="Exchange fee ₹/kWh (each side)">{num('market', 'exchangeFee', 0.01)}</Field>
          <Field label="Buy adder ₹/kWh" hint="Transmission + wheeling + losses">{num('market', 'buyAdder', 0.05)}</Field>
          <Field label="Sell deduction ₹/kWh" hint="Open-access charges on sales">{num('market', 'sellDeduction', 0.05)}</Field>
          <Field label="Max buy MW">{num('market', 'maxBuyMW', 10)}</Field>
          <Field label="Max sell MW">{num('market', 'maxSellMW', 10)}</Field>
          <Field label="RTM gate-closure lead (blocks)" hint="Positions within this window are locked">{num('market', 'rtmLeadBlocks')}</Field>
        </div>
      </Card>
      <Card title="DSM model (CERC DSM-2024 inspired)">
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Field label="Deviation band %" hint="of scheduled drawal (min base 200 MW)">{num('dsm', 'bandPct')}</Field>
          <Field label="Cap rate ₹/kWh">{num('dsm', 'capRate', 0.5)}</Field>
          <Field label="Surcharge: 1–1.5× band">{num('dsm', 'surchargeMid', 0.1)}</Field>
          <Field label="Surcharge: beyond 1.5× band">{num('dsm', 'surchargeHigh', 0.1)}</Field>
        </div>
        <div className="hr" />
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          <Field label="Solar forecast σ %">{num('reserve', 'solarErrPct')}</Field>
          <Field label="Wind forecast σ %">{num('reserve', 'windErrPct')}</Field>
          <Field label="Load forecast σ %">{num('reserve', 'loadErrPct', 0.5)}</Field>
        </div>
        <div className="muted" style={{ marginTop: 8 }}>Deviation rate = ACP-linked, scaled by frequency (low f → dearer over-drawal), with tiered surcharges beyond the band. Parameters are editable; actual CERC bands should be loaded for settlement.</div>
      </Card>
      <div className="row" style={{ gridColumn: '1 / -1' }}>
        <button className="btn primary" onClick={save}><Save size={14} />Apply & re-optimise</button>
        {saved && <span className="pill live">Saved — agent is re-planning</span>}
        <div className="spacer" />
        <button className="btn danger" onClick={reset}><RotateCcw size={14} />Reset simulation to defaults</button>
      </div>
      <span style={{ display: 'none' }}>{s.now.time}</span>
    </div>
  );
}
