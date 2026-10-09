// Loads and validates the editable policy file. A broken file never crashes the server: the error is reported and the
// last good (or built-in) policy stays in force.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GROUPS, type EventKind, type ObjectiveId, type PolicyConfig } from './types.js';

const DEFAULT_PATH = fileURLToPath(new URL('./policy.config.json', import.meta.url));
const OBJECTIVES: ObjectiveId[] = ['security', 'reliability', 'reserve', 'imbalance', 'cost', 're_utilisation', 'bess_flex'];
const EVENTS: EventKind[] = ['frequency_deterioration', 'renewable_surplus', 'evening_ramp', 'price_spike', 'bess_outage_or_low_soc', 'transmission_constraint', 'demand_spike', 'renewable_forecast_error', 'thermal_unit_failure'];

export function validatePolicy(c: any): string[] {
  const errs: string[] = [];
  if (!c || typeof c !== 'object') return ['policy is not an object'];
  for (const o of OBJECTIVES) if (typeof c.objectives?.[o] !== 'string') errs.push(`objectives.${o} missing`);
  if (!c.profiles?.normal) errs.push('profiles.normal is required');
  for (const [id, p] of Object.entries<any>(c.profiles ?? {})) {
    if (!Array.isArray(p?.objectives) || p.objectives.length === 0) errs.push(`profiles.${id}.objectives must be a non-empty list`);
    else for (const o of p.objectives) if (!OBJECTIVES.includes(o)) errs.push(`profiles.${id} references unknown objective "${o}"`);
    if (Array.isArray(p?.objectives) && new Set(p.objectives).size !== p.objectives.length) errs.push(`profiles.${id} lists an objective twice`);
  }
  for (const k of EVENTS) {
    const e = c.events?.[k];
    if (!e) { errs.push(`events.${k} missing`); continue; }
    if (!c.profiles?.[e.profile]) errs.push(`events.${k}.profile "${e.profile}" is not a defined profile`);
    for (const f of ['weight', 'enter', 'exit', 'scale', 'persistBlocks', 'holdBlocks', 'windowBlocks']) if (typeof e[f] !== 'number' || !Number.isFinite(e[f])) errs.push(`events.${k}.${f} must be a number`);
    if (e.persistBlocks < 1) errs.push(`events.${k}.persistBlocks must be >= 1`);
    if (e.exit > e.enter) errs.push(`events.${k}: exit threshold must not exceed the enter threshold (hysteresis)`);
  }
  for (const g of GROUPS) {
    const t = c.stages?.tolerance?.[g];
    if (!t || typeof t.rel !== 'number' || typeof t.abs !== 'number' || t.rel < 0 || t.abs < 0) errs.push(`stages.tolerance.${g} needs non-negative rel and abs`);
    if (typeof c.stages?.mipGap?.[g] !== 'number') errs.push(`stages.mipGap.${g} missing`);
  }
  if (typeof c.stages?.criticalLoadWeight !== 'number' || c.stages.criticalLoadWeight < 1) errs.push('stages.criticalLoadWeight must be >= 1');
  for (const it of c.combine?.interactions ?? []) for (const k of it.events ?? []) if (!EVENTS.includes(k)) errs.push(`combine.interactions references unknown event "${k}"`);
  return errs;
}

let current: PolicyConfig | null = null;
let lastError: string | null = null;

export function loadPolicy(path = process.env.POLICY_CONFIG || DEFAULT_PATH): PolicyConfig {
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    const errs = validatePolicy(cfg);
    if (errs.length) throw new Error(errs.join('; '));
    current = cfg as PolicyConfig;
    lastError = null;
  } catch (e: any) {
    lastError = `Policy file ${path} rejected: ${e?.message ?? e}`;
    if (!current) {
      current = JSON.parse(readFileSync(DEFAULT_PATH, 'utf8')) as PolicyConfig; // built-in default
    }
  }
  return current!;
}

export function getPolicy(): PolicyConfig { return current ?? loadPolicy(); }
export function policyError(): string | null { return lastError; }
/** For tests: replace the active policy (validated). */
export function setPolicy(c: PolicyConfig) {
  const errs = validatePolicy(c);
  if (errs.length) throw new Error(errs.join('; '));
  current = c; lastError = null;
}
export const cloneDeep = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
