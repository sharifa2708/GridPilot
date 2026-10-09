import { useEffect, useState } from 'react';
import { api } from '../api';
import { Pill } from './ui';
import { money, n0, n1, n2 } from '../format';

/* ------------------------------------------------------------------ active profile (shared by the Control Room and the Planning page) */
export interface PolicyView {
  label: string;
  objectives: string[]; // ranked names
  events: { kind: string; label: string; severity: number; confidence?: number; active: boolean; evidence: string; note?: string }[];
  interactions: string[];
  rationale: string[];
  stages: { objective: string; status: string; metric: number | null; ms: number; note?: string }[];
  feasibility?: string;
  conflicts?: string[];
  frequencyNote?: string;
}

export function PolicyPanel({ p }: { p: PolicyView }) {
  const active = p.events.filter((e) => e.active), pending = p.events.filter((e) => !e.active);
  return (
    <div className="act" style={{ borderColor: 'rgba(59,130,246,.4)', background: 'rgba(59,130,246,.06)' }}>
      <div className="muted" style={{ fontSize: 10.5, letterSpacing: '.06em' }}>ACTIVE PROFILE</div>
      <b style={{ display: 'block', marginTop: 3 }}>{p.label}</b>
      <ol style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.55 }}>
        {p.objectives.map((o, i) => <li key={i} style={{ color: i === 0 ? '#e8eef8' : '#a9b8d0' }}>{o}</li>)}
      </ol>
      {active.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 10.5, letterSpacing: '.06em' }}>WHAT WAS DETECTED</div>
          {active.map((e, i) => <div key={i} style={{ fontSize: 12, lineHeight: 1.5, marginTop: 3 }}><b>{e.label}</b> <span className="muted">· severity {Math.round(e.severity * 100)}%</span><div className="muted" style={{ fontSize: 11.5 }}>{e.evidence}</div></div>)}
        </div>
      )}
      {pending.filter((e) => e.note).map((e, i) => <div key={i} className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>Watching: {e.label}. {e.note}</div>)}
      {p.interactions.map((t, i) => <div key={i} style={{ fontSize: 12, marginTop: 6, color: '#f5b942' }}>{t}</div>)}
      {p.frequencyNote && <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>{p.frequencyNote}</div>}
      {p.feasibility && p.feasibility !== 'ok' && (
        <div style={{ marginTop: 8 }}><Pill kind="crit">{p.feasibility === 'shortfall' ? 'Demand cannot be fully served' : 'No feasible schedule'}</Pill>{(p.conflicts ?? []).map((c, i) => <div key={i} className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>• {c}</div>)}</div>
      )}
      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer', fontSize: 11.5, color: '#71829f' }}>Why this order</summary>
        {p.rationale.map((t, i) => <p key={i} className="muted" style={{ margin: '5px 0 0', fontSize: 11.5, lineHeight: 1.5 }}>{t}</p>)}
      </details>
      <details style={{ marginTop: 6 }}>
        <summary style={{ cursor: 'pointer', fontSize: 11.5, color: '#71829f' }}>Optimisation stages ({p.stages.length})</summary>
        <table className="t" style={{ marginTop: 6 }}>
          <thead><tr><th className="l">Stage</th><th>Result</th><th>Status</th><th>ms</th></tr></thead>
          <tbody>{p.stages.map((s, i) => <tr key={i}><td className="l">{i + 1}. {s.objective}</td><td className="num">{s.metric == null ? '–' : n2(s.metric)}</td><td className="l muted" title={s.note}>{s.status}</td><td className="num">{s.ms}</td></tr>)}</tbody>
        </table>
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Each stage minimises one objective, then freezes its result (plus a small tolerance) before the next. A stage marked Skipped was already at its lower bound.</div>
      </details>
    </div>
  );
}

/* ------------------------------------------------------------------ audit record of the latest run */
const sec = { fontWeight: 600, letterSpacing: 0.6, fontSize: 10.5, color: '#71829f', marginTop: 12 } as const;
export function AuditPanel({ version }: { version: number }) {
  const [r, setR] = useState<any>(null);
  useEffect(() => { api('/audit/latest').then((x) => setR(x.run)).catch(() => {}); }, [version]);
  if (!r) return <div className="muted">No optimisation run recorded yet.</div>;
  const imp = r.expectedImpact;
  const m = imp.window;
  return (
    <div className="col" style={{ gap: 4, fontSize: 12, lineHeight: 1.5 }}>
      <div className="muted" style={{ fontSize: 11 }}>Run {r.id} · {r.mode === 'DAM' ? 'day-ahead' : 'intraday'} · {r.solver.ms} ms · {r.solver.status}{r.solver.approximate ? ' (time limit: near-optimal, not proven)' : ''}</div>

      <div style={sec}>SITUATION DETECTED</div>
      <div>{r.situation.summary}</div>
      {r.situation.events.filter((e: any) => e.active).map((e: any, i: number) => <div key={i} className="muted">• {e.label} ({e.window}): {e.evidence}</div>)}
      {r.situation.interactions.map((t: string, i: number) => <div key={i} style={{ color: '#f5b942' }}>{t}</div>)}

      <div style={sec}>ACTIVE PRIORITY PROFILE</div>
      <div>{r.profile.label}</div>
      <div className="muted">{r.profile.objectives.map((o: any) => `${o.rank}. ${o.name}`).join('  →  ')}</div>
      <details><summary style={{ cursor: 'pointer', color: '#71829f' }}>Why</summary>{r.profile.rationale.map((t: string, i: number) => <p key={i} className="muted" style={{ margin: '4px 0 0' }}>{t}</p>)}</details>

      <div style={sec}>HARD CONSTRAINTS THAT LIMIT THE OPTIONS</div>
      {r.hardConstraints.binding?.length ? (
        <table className="t"><thead><tr><th className="l">Constraint</th><th>Blocks</th><th>Shadow price</th></tr></thead>
          <tbody>{r.hardConstraints.binding.slice(0, 6).map((b: any, i: number) => <tr key={i}><td className="l">{b.label}</td><td className="num">{b.blocks}</td><td className="num">{n2(b.maxShadow)} {b.unit}</td></tr>)}</tbody></table>
      ) : <div className="muted">None binding.</div>}
      {r.hardConstraints.limits.map((t: string, i: number) => <div key={i} style={{ color: '#ff9a97' }}>• {t}</div>)}
      <div className="muted">Independent check of {r.hardConstraints.verification.checked.length} constraint families: {r.hardConstraints.verification.ok ? 'all satisfied' : `${r.hardConstraints.verification.violations.length} violation(s)`}.</div>
      {r.hardConstraints.verification.violations.slice(0, 3).map((v: any, i: number) => <div key={i} style={{ color: '#ff9a97' }}>• {v.constraint}: {v.detail}</div>)}

      <div style={sec}>FEASIBLE ACTIONS</div>
      <div className="muted">Considered: {Object.entries(r.feasibleActions.considered).map(([k, v]) => `${k.replace('_', ' ')} ${v}`).join(' · ')}</div>
      <details><summary style={{ cursor: 'pointer', color: '#71829f' }}>Excluded or advisory only ({r.feasibleActions.excluded.length + r.feasibleActions.advisoryOnly.length})</summary>
        {[...r.feasibleActions.excluded, ...r.feasibleActions.advisoryOnly].map((x: any, i: number) => <div key={i} className="muted">• {x.category.replace('_', ' ')} · {x.asset}: {x.reason}</div>)}
      </details>

      <div style={sec}>SELECTED ACTION CLUSTER</div>
      {r.selected.onSchedule ? <div>No change to the committed schedule.</div> : r.selected.actions.map((a: any, i: number) => <div key={i}><b>{a.title}</b> <span className="muted">· {a.mode}</span><div className="muted">{a.summary}</div></div>)}

      <div style={sec}>EXPECTED IMPACT · NEXT {m.windowBlocks / 4} H</div>
      <div className="muted">Cost {money(m.costK)} · unserved {n1(m.unservedMWh)} MWh · reserve shortfall {n1(m.reserveShortMWh)} MW·h · deviation {n1(m.dsmExposureMWh)} MWh (≈{money(m.dsmCostK)}) · renewables used {n1(m.reUtilPct)}% · battery throughput {n0(m.bessThroughputMWh)} MWh, SOC {n0(m.socEndPct)}% at the end · market buy {n0(m.marketBuyMWh)} MWh</div>
      {imp.vsCommittedSchedule && (
        <details><summary style={{ cursor: 'pointer', color: '#71829f' }}>Against the committed schedule left untouched</summary>
          <table className="t"><thead><tr><th className="l">Measure</th><th>Selected</th><th>Untouched</th></tr></thead>
            <tbody>{imp.vsCommittedSchedule.map((d: any, i: number) => <tr key={i}><td className="l">{d.metric}</td><td className="num">{n1(d.selected)}</td><td className="num">{n1(d.reference)} <span className="muted">{d.unit}</span></td></tr>)}</tbody></table>
        </details>
      )}

      <div style={sec}>ALTERNATIVES EVALUATED</div>
      {r.alternatives.length === 0 && <div className="muted">Evaluated when the situation is not normal; none for this run.</div>}
      {r.alternatives.map((a: any, i: number) => <div key={i}><b>{a.label}</b><div className="muted">{a.description}</div><div>{a.verdict}</div></div>)}

      <div style={sec}>UNCERTAINTY</div>
      {r.uncertainty.map((t: string, i: number) => <div key={i} className="muted">• {t}</div>)}

      <div style={sec}>NEXT RE-EVALUATION</div>
      <div>{r.nextReevaluation.at}</div>
      {r.nextReevaluation.conditions.map((t: string, i: number) => <div key={i} className="muted">• {t}</div>)}

      <details style={{ marginTop: 10 }}><summary style={{ cursor: 'pointer', color: '#71829f' }}>Solver stages</summary>
        <table className="t"><thead><tr><th className="l">Objective</th><th>Result</th><th>Status</th><th>ms</th></tr></thead>
          <tbody>{r.solver.stages.map((s: any, i: number) => <tr key={i}><td className="l">{i + 1}. {s.objective}</td><td className="num">{s.metric == null ? '–' : n2(s.metric)}</td><td className="l muted" title={s.note}>{s.status}</td><td className="num">{s.ms}</td></tr>)}</tbody></table>
      </details>
    </div>
  );
}
