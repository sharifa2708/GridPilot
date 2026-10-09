import { useRef, useState } from 'react';
import Papa from 'papaparse';
import { Download, RefreshCw, Upload } from 'lucide-react';
import { api } from '../api';
import { Card, Pill } from '../components/ui';
import { n0, rs } from '../format';

export async function readTable(file: File): Promise<any[]> {
  if (/\.xlsx?$/i.test(file.name)) {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
  }
  return new Promise((res, rej) => Papa.parse(file, { header: true, skipEmptyLines: true, complete: (r) => res(r.data as any[]), error: rej }));
}

export default function DataSources({ s }: { s: any }) {
  const nat = s.national, w = s.weather;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [date, setDate] = useState(new Date(Date.parse(s.now.date) + 86400000).toISOString().slice(0, 10));
  const file = useRef<HTMLInputElement>(null);
  const refresh = async () => { setBusy(true); try { await api('/refresh-data', { body: {} }); } finally { setBusy(false); } };
  const upload = async (f: File) => {
    try {
      const rows = await readTable(f);
      const r = await api('/market/dam-upload', { body: { rows, date, filename: f.name } });
      setMsg({ ok: true, t: `Loaded ${r.blocks} blocks for ${r.date}. Agent is re-planning.` });
    } catch (e: any) { setMsg({ ok: false, t: e.message }); }
  };
  const Row = ({ name, kind, status, detail, what }: { name: string; kind: 'live' | 'model' | 'warn' | 'off'; status: string; detail: string; what: string }) => (
    <tr><td className="l"><b>{name}</b><div className="muted">{what}</div></td><td className="l"><Pill kind={kind}>{status}</Pill></td><td className="l dim" style={{ whiteSpace: 'normal' }}>{detail}</td></tr>
  );
  return (
    <div className="grid" style={{ gap: 14 }}>
      <Card title="Feeds & provenance" right={<button className="btn sm" onClick={refresh} disabled={busy}><RefreshCw size={13} />Refresh now</button>} bodyClass="">
        <table className="t" style={{ margin: '8px 0 0' }}>
          <thead><tr><th className="l">Feed</th><th className="l">Status</th><th className="l">Used for</th></tr></thead>
          <tbody>
            <Row name="Open-Meteo weather API" what="open-meteo.com · no key" kind={w.source === 'open-meteo' ? 'live' : 'warn'} status={w.source === 'open-meteo' ? 'LIVE' : 'FALLBACK'}
              detail={`${w.locations} asset/customer locations; irradiance → solar MW (PR, DC/AC clipping, cell-temp derate), 100 m wind → power curve, temperature → cooling load, gusts/WMO codes → storm risk. ${w.lastOk ? 'Last fetch ' + new Date(w.lastOk).toLocaleTimeString() : ''} ${w.lastError ?? ''}`} />
            <Row name="MeritIndia – all-India position" what="meritindia.in (public dashboard endpoint)" kind={nat.demandMetMW ? 'live' : 'off'} status={nat.demandMetMW ? 'LIVE' : 'UNAVAILABLE'}
              detail={nat.demandMetMW ? `Demand met ${n0(nat.demandMetMW)} MW · thermal ${n0(nat.thermalMW)} · hydro ${n0(nat.hydroMW)} · renewable ${n0(nat.renewableMW)}. Used as a national stress index that scales the price level.` : (nat.error ?? 'No data')} />
            <Row name="Vidyut Pravah – frequency / IEX UMCP" what="vidyutpravah.in (public dashboard endpoint)" kind={nat.frequencyHz || nat.umcpRs ? 'live' : 'off'} status={nat.frequencyHz || nat.umcpRs ? 'LIVE' : 'NOT PUBLISHED NOW'}
              detail={`Frequency ${nat.frequencyHz ? nat.frequencyHz.toFixed(3) + ' Hz' : '— (portal returns 0 outside publishing windows)'} · IEX UMCP ${nat.umcpRs ? rs(nat.umcpRs) : '—'}. When present, shown as a live reference next to the model price.`} />
            <Row name="DAM / RTM prices" what="IEX India market clearing prices" kind={s.sources.damUpload ? 'live' : 'model'} status={s.sources.damUpload ? 'UPLOADED' : 'MODEL'}
              detail="IEX has no open API. Default: October IEX shape (₹2–3 solar-hour trough, ₹8–10 evening peak, ₹10 cap) scaled by cloudiness and the live national stress index, with forecast error. Upload the exchange's DAM MCP file below to use real prices." />
            <Row name="Grid frequency" what="System frequency" kind="model" status="MODEL" detail="Modelled from the grid's supply-demand balance: shortfall (demand > supply) pulls it below 50 Hz, surplus lifts it above. Profile: evening dip, solar-hour rise, noise, our own over/under-drawal + scenario events." />
            <Row name="Maintenance schedule" what="Your outage plan" kind={s.sources.maintenance === 'sample schedule' ? 'model' : 'live'} status={s.sources.maintenance === 'sample schedule' ? 'SAMPLE' : 'UPLOADED'} detail={`Source: ${s.sources.maintenance}. Upload on the Maintenance page.`} />
            <Row name="Grid-India reports (PSP, RTM, transmission)" what="grid-india.in daily PDFs/XLSX" kind="off" status="UPLOAD" detail="Not scraped (published as documents). Load transmission limits via Portfolio → Grid, and prices via the uploader below." />
          </tbody>
        </table>
      </Card>
      <Card title="Upload day-ahead market prices (IEX DAM MCP)">
        <div className="grid" style={{ gridTemplateColumns: '220px 1fr', alignItems: 'center' }}>
          <label className="f"><span>Delivery date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <div className="drop" onClick={() => file.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) upload(f); }}>
            <Upload size={20} /><div style={{ marginTop: 6 }}><b>Drop CSV / XLSX</b> or click to browse</div>
            <div className="muted">Columns: time block (1–96 or HH:MM) and MCP (₹/MWh or ₹/kWh)</div>
            <input ref={file} type="file" accept=".csv,.xlsx,.xls" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <a className="btn sm" href={`/api/market/dam-template?date=${date}`}><Download size={13} />Download template</a>
          <span className="muted" style={{ fontSize: 11.5 }}>96 rows (block, time, MCP in ₹/MWh) for the delivery date above, pre-filled with the model's forecast; overwrite the MCP column with the real prices.</span>
        </div>
        {msg && <div className={'pill ' + (msg.ok ? 'live' : 'crit')} style={{ marginTop: 10 }}>{msg.t}</div>}
      </Card>
    </div>
  );
}
