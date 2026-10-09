import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { cls } from '../format';

export function Card({ title, right, children, className, bodyClass, style }: { title?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string; bodyClass?: string; style?: React.CSSProperties }) {
  return (
    <section className={cls('card', className)} style={style}>
      {(title || right) && (
        <div className="card-h">
          <h3>{title}</h3>
          <div className="spacer" />
          {right}
        </div>
      )}
      <div className={cls('card-b', bodyClass)}>{children}</div>
    </section>
  );
}

export function Pill({ kind, children, title }: { kind?: 'live' | 'model' | 'warn' | 'crit' | 'off'; children: React.ReactNode; title?: string }) {
  return <span className={cls('pill', kind)} title={title}>{children}</span>;
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={wide ? { width: 'min(980px,100%)' } : undefined}>
        <div className="modal-h"><h2>{title}</h2><div className="spacer" /><button className="btn ghost sm" onClick={onClose}><X size={16} /></button></div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children, span }: { label: string; hint?: string; children: React.ReactNode; span?: 2 | 3 }) {
  return (
    <label className={cls('f', span === 2 && 'span2', span === 3 && 'span3')}>
      <span>{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: React.ReactNode }[]; onChange: (v: T) => void }) {
  return <div className="seg">{options.map((o) => <button key={o.v} className={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)}>{o.label}</button>)}</div>;
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: React.ReactNode }[]; onChange: (v: T) => void }) {
  return <div className="tabs">{options.map((o) => <button key={o.v} className={cls('tab', value === o.v && 'active')} onClick={() => onChange(o.v)}>{o.label}</button>)}</div>;
}

export function Tip({ active, payload, label, fmt }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tt">
      <b>{fmt?.title ? fmt.title(label, payload) : label}</b>
      {payload.filter((p: any) => p.value != null && p.name && !String(p.name).startsWith('_')).map((p: any, i: number) => (
        <div key={i}><span><i className="sw" style={{ background: p.color || p.stroke || p.fill }} />{p.name}</span><span className="num">{fmt?.value ? fmt.value(p.value, p.name) : Number(p.value).toFixed(1)}</span></div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; dash?: boolean }[] }) {
  return <div className="legend">{items.map((i) => <span key={i.label}><i className="sw" style={{ background: i.dash ? 'transparent' : i.color, border: i.dash ? `1.5px dashed ${i.color}` : 'none' }} />{i.label}</span>)}</div>;
}

export function Spinner({ text }: { text: string }) {
  return <div className="splash"><div><div className="spin" /><div>{text}</div></div></div>;
}
