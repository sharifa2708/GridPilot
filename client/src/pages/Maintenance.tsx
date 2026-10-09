import { useEffect, useRef, useState } from 'react';
import { Check, Download, Upload, X } from 'lucide-react';
import { api } from '../api';
import { Card, Pill } from '../components/ui';
import { money } from '../format';
import { readTable } from './DataSources';

export default function Maintenance({ s }: { s: any }) {
  const [data, setData] = useState<any>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const load = () => api('/maintenance').then(setData);
  useEffect(() => { load(); }, [s.log.length, s.agent.maintProposals.length]);
  const upload = async (f: File) => {
    try {
      const rows = await readTable(f);
      const r = await api('/maintenance/upload', { body: { rows, filename: f.name } });
      setMsg({ ok: true, t: `Imported ${r.imported} items.${r.errors.length ? ' Skipped: ' + r.errors.slice(0, 3).join(' | ') : ''}` });
      load();
    } catch (e: any) { setMsg({ ok: false, t: e.message }); }
  };
  if (!data) return null;
  const items: any[] = data.items;
  const dayStart = Math.floor(s.now.slot / 96) * 96;
  const span = 96 * 3;
  const pct = (slot: number) => Math.max(0, Math.min(100, ((slot - dayStart) / span) * 100));
  const rowsOrder = [...new Set(items.map((i) => i.assetName))];
  const colour = (it: any) => (it.status === 'active' ? '#f5b942' : it.status === 'completed' ? '#4b5b78' : it.type === 'forced' ? '#f0605d' : '#3b82f6');
  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Card title="Upload maintenance schedule">
          <div className="drop" onClick={() => file.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) upload(f); }}>
            <Upload size={20} /><div style={{ marginTop: 6 }}><b>Drop CSV / XLSX</b> or click to browse</div>
            <div className="muted">asset, start, end, type, derate_mw, deferrable, description · times in IST</div>
            <input ref={file} type="file" accept=".csv,.xlsx,.xls" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <a className="btn sm" href="/api/maintenance/template"><Download size={13} />Download template</a>
            <Pill kind={data.source === 'sample schedule' ? 'model' : 'live'}>Source: {data.source}</Pill>
          </div>
          {msg && <div className={'pill ' + (msg.ok ? 'live' : 'crit')} style={{ marginTop: 10, whiteSpace: 'normal' }}>{msg.t}</div>}
          <div className="muted" style={{ marginTop: 10, lineHeight: 1.55 }}>Empty <b className="dim">derate_mw</b> = full outage. <b className="dim">deferrable = yes</b> lets the agent propose a cheaper window (it weighs the energy-value lost in each candidate window using the live marginal-cost forecast).</div>
        </Card>
        <Card title="Agent proposals">
          {data.proposals.filter((p: any) => p.status !== 'rejected').length === 0 && <div className="muted">No re-scheduling proposals right now.</div>}
          <div className="agent-list">
            {data.proposals.map((p: any) => (
              <div key={p.id} className="act">
                <div className="act-h"><div style={{ flex: 1 }}><b>{p.item?.assetName}</b> · {p.item?.description}<div className="muted">saves ≈ {money(p.saving)}</div></div><Pill kind={p.status === 'pending' ? 'warn' : p.status === 'rejected' ? 'off' : 'live'}>{p.status}</Pill></div>
                <p>{p.reason}</p>
                {p.status === 'pending' && <div className="row" style={{ marginTop: 8 }}><button className="btn sm good" onClick={() => api(`/maintenance/${p.id}/approve`, { body: {} }).then(load)}><Check size={13} />Approve</button><button className="btn sm danger" onClick={() => api(`/maintenance/${p.id}/reject`, { body: {} }).then(load)}><X size={13} />Keep</button></div>}
              </div>
            ))}
          </div>
        </Card>
      </div>
      <Card title="Timeline · today + 2 days">
        <div className="gantt" style={{ height: rowsOrder.length * 30 + 28 }}>
          {[0, 1, 2].map((d) => <div key={d} style={{ position: 'absolute', left: `${(d / 3) * 100}%`, top: 0, bottom: 0, borderLeft: '1px solid var(--line)', paddingLeft: 6, color: 'var(--text-3)', fontSize: 11 }}>{new Date(Date.parse(s.now.date) + d * 86400000).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })}</div>)}
          <div style={{ position: 'absolute', left: `${pct(s.now.slot)}%`, top: 18, bottom: 0, borderLeft: '2px solid #34d399' }} title="Now" />
          {rowsOrder.map((name, ri) => (
            <div key={name} style={{ position: 'absolute', top: 24 + ri * 30, left: 0, right: 0, height: 24 }}>
              {items.filter((i) => i.assetName === name).map((it) => (
                <div key={it.id} className="gbar" style={{ left: `${pct(it.startSlot)}%`, width: `${Math.max(1.2, pct(it.endSlot) - pct(it.startSlot))}%`, background: colour(it), opacity: it.status === 'deferred' ? 0.4 : 1 }} title={`${it.assetName}\n${it.description}\n${it.start} → ${it.end}`}>{name}</div>
              ))}
            </div>
          ))}
        </div>
        <div className="legend" style={{ marginTop: 8 }}><span><i className="sw" style={{ background: '#3b82f6' }} />Planned</span><span><i className="sw" style={{ background: '#f5b942' }} />Active</span><span><i className="sw" style={{ background: '#4b5b78' }} />Completed</span><span><i className="sw" style={{ background: '#f0605d' }} />Forced</span></div>
      </Card>
      <Card title="Schedule" bodyClass="">
        <table className="t" style={{ margin: '8px 0 0' }}>
          <thead><tr><th className="l">Asset</th><th className="l">Work</th><th className="l">Start</th><th className="l">End</th><th>Derate</th><th className="l">Type</th><th className="l">Deferrable</th><th className="l">Status</th></tr></thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.id}><td className="l">{m.assetName}</td><td className="l dim" style={{ whiteSpace: 'normal', maxWidth: 320 }}>{m.description}{m.note && <div className="muted">{m.note}</div>}</td><td className="l num">{m.start}</td><td className="l num">{m.end}</td><td className="num">{m.derateMW == null ? 'full outage' : `−${m.derateMW} MW`}</td><td className="l">{m.type}</td><td className="l">{m.deferrable ? 'yes' : 'no'}</td><td className="l"><Pill kind={m.status === 'active' ? 'warn' : m.status === 'completed' ? 'off' : 'model'}>{m.status}</Pill></td></tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
