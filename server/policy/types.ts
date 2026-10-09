// Shared types of the optimisation-policy engine (situation assessment -> objective profile -> staged optimisation -> audit).

export type ObjectiveId = 'security' | 'reliability' | 'reserve' | 'imbalance' | 'cost' | 're_utilisation' | 'bess_flex';
/** Groups of objective-function terms; each objective maps to exactly one group (one lexicographic stage). */
export type Group = 'security' | 'reliability' | 'reserve' | 'imbalance' | 'cost' | 're' | 'bess' | 'tie';
export const GROUPS: Group[] = ['security', 'reliability', 'reserve', 'imbalance', 'cost', 're', 'bess', 'tie'];
/** Objective groups a profile can rank (the final tie-break stage is always last and is not an objective). */
export const RANKABLE: Group[] = ['security', 'reliability', 'reserve', 'imbalance', 'cost', 're', 'bess'];
export const OBJECTIVE_GROUP: Record<ObjectiveId, Exclude<Group, 'tie'>> = {
  security: 'security', reliability: 'reliability', reserve: 'reserve', imbalance: 'imbalance', cost: 'cost', re_utilisation: 're', bess_flex: 'bess',
};
export const GROUP_OBJECTIVE: Record<Exclude<Group, 'tie'>, ObjectiveId> = {
  security: 'security', reliability: 'reliability', reserve: 'reserve', imbalance: 'imbalance', cost: 'cost', re: 're_utilisation', bess: 'bess_flex',
};
export const TIE_LABEL = 'Tie-break: smooth, stable dispatch';
/** Physical unit of each stage metric (what the optimiser minimises in that stage). */
export const GROUP_UNIT: Record<Group, string> = {
  security: 'MWh of corridor/interconnection limit violation + unabsorbable surplus',
  reliability: 'MWh unserved (critical load counted with the configured weight)',
  reserve: 'MW·h of reserve shortfall (down-reserve shortfall counted at 0.7)',
  imbalance: 'MWh of committed market energy that cannot be delivered (settled as deviation)',
  cost: '₹ thousand over the horizon',
  re: 'MWh of renewable energy curtailed',
  bess: 'MWh of battery throughput',
  tie: 'MW of block-to-block movement of thermal output and market purchases',
};

export type EventKind =
  | 'frequency_deterioration' | 'renewable_surplus' | 'evening_ramp' | 'price_spike' | 'bess_outage_or_low_soc'
  | 'transmission_constraint' | 'demand_spike' | 'renewable_forecast_error' | 'thermal_unit_failure';

export interface EventRule {
  profile: string; weight: number; persistBlocks: number; holdBlocks: number; enter: number; exit: number; unit: string; scale: number; windowBlocks: number;
  restrictMerchantSales: boolean; enablesDemandResponse: boolean; enablesLoadShift: boolean; prepositionBessPct: number;
  [k: string]: any;
}

export interface PolicyConfig {
  version: number;
  objectives: Record<ObjectiveId, string>;
  profiles: Record<string, { label: string; objectives: ObjectiveId[] }>;
  events: Record<EventKind, EventRule>;
  combine: { normalWeight: number; interactions: { events: EventKind[]; boost: number; note: string }[] };
  reserve: { baseUpDemandShare: number; baseDownSigmaShare: number; stormSigmaMultiplier: number };
  stages: {
    totalSolveSec: { intraday: number; dam: number }; stageMinSec: number; costStageShare: number;
    mipGap: Record<Group, number>; tolerance: Record<Group, { rel: number; abs: number }>; criticalLoadWeight: number; skipStagesAtLowerBound: boolean;
  };
  actions: {
    demandResponse: { enabled: boolean; requiresActiveEvent: boolean; useOnlyWhenNeeded: boolean; disruptionRsPerKwh: number; noticeBlocks: number; excludeCritical: boolean };
    loadShift: { enabled: boolean; requiresActiveEvent: boolean; useOnlyWhenNeeded: boolean; shiftOutRsPerKwh: number; shiftInRsPerKwh: number; noticeBlocks: number };
    bessExclusive: 'penalty' | 'binary';
    emergencyProcurement: { enabled: boolean; mode: 'advisory' | 'simulated' | 'approved' };
    autoExecute: Record<string, boolean | string>;
  };
  evaluation: { windowBlocks: number; conservativeRenewableFactor: number; conservativeDemandFactor: number; alternativesWhenNonNormal: boolean };
}

export interface DetectedEvent {
  kind: EventKind;
  severity: number; // 0..1
  confidence: number; // 0..1
  raw: number; // measured value in the rule's unit
  startBlock: number; // relative to the first planned block
  endBlock: number; // inclusive
  assets: string[];
  evidence: string; // data behind the detection
  active: boolean; // after hysteresis / persistence
  note?: string; // e.g. "suppressed: below persistence threshold"
  meta?: Record<string, any>;
}

export interface Situation {
  profileId: string; // e.g. "evening_ramp+bess_outage_or_low_soc" or "normal"
  label: string;
  objectives: ObjectiveId[]; // combined, ranked
  events: DetectedEvent[]; // all detections, active or not
  activeKinds: EventKind[];
  interactions: string[];
  scores: Record<string, number>; // objective -> combined score
  rationale: string[];
  perBlock: { kinds: EventKind[] }[]; // active event kinds covering each planned block
  frequencyNote: string; // system-level condition vs the DISCOM's own response
}

export interface HysteresisEntry { active: boolean; above: number; below: number }
export type HysteresisState = Partial<Record<EventKind, HysteresisEntry>>;
