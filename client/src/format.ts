export const n0 = (x: number | null | undefined) => (x == null || !isFinite(x) ? '—' : Math.round(x).toLocaleString('en-IN'));
export const n1 = (x: number | null | undefined) => (x == null || !isFinite(x) ? '—' : x.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
export const n2 = (x: number | null | undefined) => (x == null || !isFinite(x) ? '—' : x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const rs = (x: number | null | undefined) => (x == null || !isFinite(x) ? '—' : '₹' + n2(x));
/** ₹ '000 -> compact lakh / crore string */
export function money(k: number | null | undefined) {
  if (k == null || !isFinite(k)) return '—';
  const rupees = k * 1000, a = Math.abs(rupees);
  if (a >= 1e7) return `₹${(rupees / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `₹${(rupees / 1e5).toFixed(2)} L`;
  return `₹${Math.round(rupees).toLocaleString('en-IN')}`;
}
export const sign = (x: number, d = 0) => (x > 0 ? '+' : '') + x.toFixed(d);
export const cls = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');

// Energy-source palette – fixed order, validated for the dark surface (CVD ΔE ≥ 8, contrast ≥ 3:1).
export const SRC = {
  wind: { label: 'Wind', color: '#3987e5' },
  thermal: { label: 'Thermal', color: '#d95926' },
  market: { label: 'Market (DAM/RTM)', color: '#199e70' },
  solar: { label: 'Solar', color: '#c98500' },
  grid: { label: 'Contract / grid', color: '#d55181' },
  bess: { label: 'BESS discharge', color: '#9085e9' },
  dsm: { label: 'DSM over-drawal', color: '#e66767' },
} as const;
export type SrcKey = keyof typeof SRC;
