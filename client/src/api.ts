import { useEffect, useRef, useState } from 'react';

export async function api<T = any>(path: string, opts?: { method?: string; body?: any }): Promise<T> {
  const r = await fetch('/api' + path, {
    method: opts?.method ?? (opts?.body ? 'POST' : 'GET'),
    headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error ?? `Request failed (${r.status})`);
  return j;
}

export interface Live {
  state: any | null;
  telemetry: any | null;
  boot: { status: string; msg: string } | null;
  connected: boolean;
}

/** Subscribes to the server's SSE stream; `state` arrives per block / per re-plan, `telemetry` every second. */
export function useLive(): Live {
  const [state, setState] = useState<any>(null);
  const [telemetry, setTelemetry] = useState<any>(null);
  const [boot, setBoot] = useState<any>(null);
  const [connected, setConnected] = useState(false);
  const ref = useRef<EventSource | null>(null);
  useEffect(() => {
    let closed = false;
    const open = () => {
      const es = new EventSource('/api/stream');
      ref.current = es;
      es.onopen = () => setConnected(true);
      es.addEventListener('state', (e) => { const s = JSON.parse((e as MessageEvent).data); setState(s); setTelemetry(s.telemetry); setBoot(null); });
      es.addEventListener('telemetry', (e) => setTelemetry(JSON.parse((e as MessageEvent).data)));
      es.addEventListener('boot', (e) => setBoot(JSON.parse((e as MessageEvent).data)));
      es.onerror = () => { setConnected(false); es.close(); if (!closed) setTimeout(open, 2000); };
    };
    open();
    // while booting the server only sends one event; poll for completion
    const poll = setInterval(async () => {
      try { const b = await fetch('/api/boot').then((r) => r.json()); setBoot((cur: any) => (cur ? b : cur)); if (b.status === 'running') { const s = await fetch('/api/state').then((r) => r.json()); if (s.rows) { setState(s); setTelemetry(s.telemetry); setBoot(null); } } } catch { /* offline */ }
    }, 2500);
    return () => { closed = true; ref.current?.close(); clearInterval(poll); };
  }, []);
  return { state, telemetry, boot, connected };
}
