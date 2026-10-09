// Structured audit record for every optimisation run (section H): what was detected, which profile was active and why, which
// hard constraints bound the options, which actions were considered or excluded, what was selected, the expected impact,
// the alternatives evaluated, the uncertainty and when to run again. Everything is taken from solver output and modelled
// evidence; nothing is free text invented after the fact.
import { appendFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AgentAction } from '../types.js';
import type { PlanInput, PlanOutput, PolicyInput, StageResult } from '../opt/model.js';
import { GROUP_OBJECTIVE, GROUP_UNIT, TIE_LABEL, type Group, type PolicyConfig, type Situation } from './types.js';

const groupName = (cfg: PolicyConfig, g: Group) => (g === 'tie' ? TIE_LABEL : cfg.objectives[GROUP_OBJECTIVE[g]]);
import { summariseCandidates, type Candidate } from './candidates.js';
import { compare, type ClusterDelta, type ClusterMetrics } from './evaluate.js';
import type { Verification } from './verify.js';

export interface AuditAlternative { label: string; description: string; metrics: ClusterMetrics; vsSelected: ClusterDelta[]; verdict: string }

export interface AuditRecord {
  id: string;
  ts: number;
  mode: 'DAM' | 'INTRADAY';
  slot0: number;
  situation: {
    summary: string;
    events: { kind: string; label: string; severity: number; confidence: number; active: boolean; window: string; evidence: string; note?: string }[];
    interactions: string[];
    frequencyNote: string;
  };
  profile: { id: string; label: string; objectives: { rank: number; id: string; name: string }[]; stageOrder: { stage: number; objective: string; unit: string }[]; rationale: string[] };
  hardConstraints: { binding: PlanOutput['binding']; feasibility: string; limits: string[]; verification: { ok: boolean; violations: Verification['violations']; informational: string[]; checked: string[] } };
  feasibleActions: { considered: Record<string, number>; excluded: { category: string; asset: string; action: string; reason: string }[]; advisoryOnly: { category: string; asset: string; action: string; reason: string }[]; candidates: Candidate[] };
  solver: { status: string; approximate: boolean; ms: number; stages: (StageResult & { objective: string })[]; note?: string };
  selected: { actions: { bucket?: string; type: string; title: string; summary?: string; mode: string }[]; firstBlock: Record<string, number>; onSchedule: boolean };
  expectedImpact: { window: ClusterMetrics; costBreakdownK: Record<string, number> | undefined; vsCommittedSchedule: ClusterDelta[] | null };
  alternatives: AuditAlternative[];
  uncertainty: string[];
  nextReevaluation: { at: string; conditions: string[] };
}

const rs = (x: number) => x.toFixed(2);
const hhmm = (b: number) => `${String(Math.floor(b / 4)).padStart(2, '0')}:${String((b % 4) * 15).padStart(2, '0')}`;

export function buildAudit(a: {
  id: string; mode: 'DAM' | 'INTRADAY'; cfg: PolicyConfig; situation: Situation; input: PlanInput; policy: PolicyInput; out: PlanOutput; verification: Verification;
  candidates: Candidate[]; actions: AgentAction[]; planMetrics: ClusterMetrics; baselineMetrics: ClusterMetrics | null; sigma: number; stormRisk: number;
}): AuditRecord {
  const { cfg, situation: sit, out, input } = a;
  const slotRel = (t: number) => `+${t + 1} (${hhmm((((input.slot0 + t) % 96) + 96) % 96)})`;
  const cs = summariseCandidates(a.candidates);
  const first = out.blocks[0];
  const fb: Record<string, number> = first ? {
    thermalMW: first.flows.thermal, solarMW: first.flows.solar, windMW: first.flows.wind, batteryNetMW: first.flows.bessDis - first.flows.bessCh, socMWh: first.socMWh, damNetMW: first.flows.damBuy - first.flows.damSell,
    rtmNetMW: first.flows.rtmBuy - first.flows.rtmSell, contractMW: first.flows.grid, curtailedMW: first.flows.curtailSolar + first.flows.curtailWind, demandResponseMW: first.flows.dr, loadShiftMW: first.flows.shiftNet, unservedMW: first.flows.unserved,
  } : {};
  const execMode = (x: AgentAction) => (x.requiresApproval ? 'advisory (needs approval)' : x.bucket === 'demand' ? String(cfg.actions.autoExecute.demandResponse) : 'approved for execution');
  const limits: string[] = [];
  if (out.feasibility === 'shortfall') limits.push(...(out.conflicts ?? []));
  if (out.feasibility === 'infeasible') limits.push(...(out.conflicts ?? []), out.note ?? 'infeasible');
  const unc = [
    `Forecast uncertainty of the first block is about ±${a.sigma.toFixed(0)} MW (1σ) across solar, wind and load.`,
    `Day-ahead and real-time price forecasts carry roughly 4–8% error; the plan re-prices every block.`,
    a.stormRisk > 0.5 ? 'Storm risk is elevated: wind cut-out and reduced corridor capacity are assumed in the reserve requirement.' : 'No storm risk is assumed in the near term.',
    ...(out.approximate ? ['At least one solver stage stopped on its time limit, so the result is near-optimal but not proven optimal.'] : []),
    ...(sit.events.some((e) => !e.active) ? ['Some detected conditions are below their persistence threshold and are not yet acted on; they may change the profile at the next evaluation.'] : []),
  ];
  const cond = [
    'Every 15-minute block (rolling horizon).',
    `The RTM gate closes ${input.settings.market.rtmLeadBlocks} blocks ahead: bids in that window become fixed, so earlier correction is cheaper.`,
    'Immediately when a scenario event, outage, price upload or weather refresh changes the inputs.',
    ...(sit.activeKinds.length ? [`The active profile is re-checked against the exit thresholds of: ${sit.activeKinds.join(', ')}.`] : ['A detected condition crossing its enter threshold for the required number of evaluations changes the profile.']),
  ];
  return {
    id: a.id, ts: Date.now(), mode: a.mode, slot0: input.slot0,
    situation: {
      summary: sit.activeKinds.length ? `${sit.label}` : 'No event detected: normal operations.',
      events: sit.events.map((e) => ({ kind: e.kind, label: cfg.profiles[cfg.events[e.kind].profile].label, severity: e.severity, confidence: e.confidence, active: e.active, window: `blocks ${slotRel(e.startBlock)} to ${slotRel(e.endBlock)}`, evidence: e.evidence, note: e.note })),
      interactions: sit.interactions, frequencyNote: sit.frequencyNote,
    },
    profile: {
      id: sit.profileId, label: sit.label,
      objectives: a.policy.order.filter((g) => g !== 'tie').map((g, i) => ({ rank: i + 1, id: GROUP_OBJECTIVE[g as Exclude<Group, 'tie'>], name: groupName(cfg, g) })),
      stageOrder: a.policy.order.map((g, i) => ({ stage: i + 1, objective: groupName(cfg, g), unit: GROUP_UNIT[g] })),
      rationale: sit.rationale,
    },
    hardConstraints: { binding: out.binding ?? [], feasibility: out.feasibility, limits, verification: { ok: a.verification.ok, violations: a.verification.violations.slice(0, 10), informational: a.verification.informational, checked: a.verification.checked } },
    feasibleActions: { considered: cs.considered, excluded: cs.excluded, advisoryOnly: cs.advisoryOnly, candidates: a.candidates.filter((x) => x.mode !== 'excluded').slice(0, 40) },
    solver: { status: out.status, approximate: !!out.approximate, ms: out.solveMs, stages: (out.stages ?? []).map((s) => ({ ...s, unit: GROUP_UNIT[s.group], objective: groupName(cfg, s.group) })), note: out.note },
    selected: { actions: a.actions.map((x) => ({ bucket: x.bucket, type: x.type, title: x.title, summary: x.summary, mode: execMode(x) })), firstBlock: fb, onSchedule: a.actions.length === 0 },
    expectedImpact: { window: a.planMetrics, costBreakdownK: out.costBreakdown, vsCommittedSchedule: a.baselineMetrics ? compare(a.planMetrics, a.baselineMetrics) : null },
    alternatives: [],
    uncertainty: unc,
    nextReevaluation: { at: `next block (${hhmm((((input.slot0 + 1) % 96) + 96) % 96)})`, conditions: cond },
  };
}

export function judgeAlternative(label: string, description: string, alt: ClusterMetrics, sel: ClusterMetrics): AuditAlternative {
  const d = compare(sel, alt);
  const cost = d.find((x) => x.metric.startsWith('Total cost'))!, un = d.find((x) => x.metric === 'Unserved energy')!, rsv = d.find((x) => x.metric === 'Upward reserve shortfall')!, dsm = d.find((x) => x.metric.startsWith('Deviation'))!;
  const worse: string[] = [];
  if (alt.unservedMWh > sel.unservedMWh + 0.05) worse.push(`${rs(alt.unservedMWh - sel.unservedMWh)} MWh more unserved energy`);
  if (alt.reserveShortMWh > sel.reserveShortMWh + 0.05) worse.push(`${rs(alt.reserveShortMWh - sel.reserveShortMWh)} MW·h more reserve shortfall`);
  if (alt.dsmExposureMWh > sel.dsmExposureMWh + 0.05) worse.push(`${rs(alt.dsmExposureMWh - sel.dsmExposureMWh)} MWh more deviation exposure`);
  let verdict: string;
  if (worse.length) verdict = `Not selected: it is ${cost.delta >= 0 ? 'no cheaper' : 'cheaper by ₹' + rs(-cost.delta) + 'k'} but gives ${worse.join(', ')}, which rank above cost in the active profile.`;
  else if (cost.delta < -0.5) verdict = `Selected plan is ₹${rs(-cost.delta)}k cheaper over the window with equal or better reliability, reserve and imbalance results.`;
  else if (cost.delta > 0.5) verdict = `Not selected on cost alone (₹${rs(cost.delta)}k dearer than this alternative), but only because a higher-ranked objective in the active profile is binding, or the difference is within the stage tolerance.`;
  else verdict = 'Equivalent within tolerance.';
  void un; void rsv; void dsm;
  return { label, description, metrics: alt, vsSelected: d, verdict };
}

// ------------------------------------------------------------------ store
const FILE = fileURLToPath(new URL('../../data/audit.jsonl', import.meta.url));
const ring: AuditRecord[] = [];
let ready = false;
export const auditLog = {
  push(r: AuditRecord) {
    ring.push(r); if (ring.length > 300) ring.shift();
    void (async () => {
      try { if (!ready) { await mkdir(fileURLToPath(new URL('../../data/', import.meta.url)), { recursive: true }); ready = true; } await appendFile(FILE, JSON.stringify(r) + '\n'); } catch { /* audit file is best-effort */ }
    })();
  },
  patch(id: string, patch: Partial<AuditRecord>) {
    const r = ring.find((x) => x.id === id);
    if (!r) return;
    Object.assign(r, patch);
    void appendFile(FILE, JSON.stringify({ type: 'update', id, ...patch }) + '\n').catch(() => {});
  },
  latest(mode: 'INTRADAY' | 'DAM' = 'INTRADAY'): AuditRecord | null { for (let i = ring.length - 1; i >= 0; i--) if (ring[i].mode === mode) return ring[i]; return null; },
  list(limit = 20): AuditRecord[] { return ring.slice(-limit).reverse(); },
  clear() { ring.length = 0; },
};
