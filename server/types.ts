// Shared domain types for GridPilot (server + client import the same shapes via /api JSON).

export type AssetKind = 'solar' | 'wind' | 'thermal' | 'bess';

export interface Location {
  name: string;
  state: string;
  lat: number;
  lon: number;
}

interface AssetBase {
  id: string;
  name: string;
  location: Location;
  corridorId: string; // evacuation corridor the asset injects into
  enabled: boolean;
}

export interface SolarFarm extends AssetBase {
  kind: 'solar';
  capacityMW: number; // AC export capacity
  dcAcRatio: number;
  performanceRatio: number;
  tariff: number; // PPA ₹/kWh
}

export interface WindFarm extends AssetBase {
  kind: 'wind';
  capacityMW: number;
  hubHeightM: number;
  tariff: number;
}

export interface ThermalUnit extends AssetBase {
  kind: 'thermal';
  capacityMW: number;
  minLoadPct: number; // technical minimum
  rampPctPerMin: number;
  varCost: number; // ₹/kWh energy charge
  noLoadCost: number; // ₹ '000 per hour while committed
  startupCost: number; // ₹ '000 per start
  capacityCharge: number; // ₹ lakh per MW-month (fixed PPA charge, reported but sunk for dispatch)
  minUpBlocks: number;
  minDownBlocks: number;
  tripRestartBlocks?: number; // blocks to be back on line after a trip (hot restart); default 8 (2 h)
  emissionFactor: number; // tCO2/MWh
  group: 'A' | 'B' | 'C'; // A base, B flexible, C expensive
  mustRun: boolean;
}

export interface Bess extends AssetBase {
  kind: 'bess';
  powerMW: number;
  energyMWh: number;
  etaCharge: number;
  etaDischarge: number;
  socMinPct: number;
  socMaxPct: number;
  initialSocPct: number;
  degradationCost: number; // ₹/kWh throughput
  gridSupportReservePct: number; // share of power held for fast grid support
}

export type Asset = SolarFarm | WindFarm | ThermalUnit | Bess;

export type LoadProfile =
  | 'residential'
  | 'commercial'
  | 'industrial-continuous'
  | 'industrial-twoshift'
  | 'datacenter'
  | 'agri'
  | 'mixed-feeder';

export interface Customer {
  id: string;
  name: string;
  segment: 'Industrial' | 'Commercial' | 'Residential' | 'Critical infra' | 'Agriculture';
  location: Location;
  peakMW: number;
  profile: LoadProfile;
  criticality: 'critical' | 'essential' | 'flexible';
  drFlexPct: number; // share of load curtailable under demand response
  shiftablePct: number; // share of load that can be time-shifted within the day
  tariff: number; // realisation ₹/kWh
  drIncentive: number; // ₹/kWh paid on curtailed energy
  coolingSensitivity: number; // load uplift per °C above 28
  enabled: boolean;
}

export interface Corridor {
  id: string;
  name: string;
  ttcMW: number; // total transfer capability
}

export interface Portfolio {
  utilityName: string;
  solar: SolarFarm[];
  wind: WindFarm[];
  thermal: ThermalUnit[];
  bess: Bess[];
  customers: Customer[];
  corridors: Corridor[];
  interconnect: {
    importLimitMW: number;
    exportLimitMW: number;
    gridContractLimitMW: number; // bilateral / ISGS import
    gridContractPrice: number; // ₹/kWh
  };
}

export interface Settings {
  autonomy: 'autonomous' | 'supervised';
  weights: {
    carbonPrice: number; // ₹ per tCO2 internal shadow price
    reCurtailmentPenalty: number; // ₹/kWh extra penalty over PPA tariff
    degradationScale: number; // multiplier on BESS degradation cost
    reserveStrictness: number; // multiplier on reserve requirement
  };
  market: {
    priceCap: number; // ₹/kWh
    exchangeFee: number; // ₹/kWh each side
    buyAdder: number; // transmission + wheeling + losses ₹/kWh
    sellDeduction: number; // OA charges on sales ₹/kWh
    maxBuyMW: number;
    maxSellMW: number;
    rtmLeadBlocks: number; // gate closure lead
  };
  dsm: {
    bandPct: number; // permissible deviation band as % of scheduled net drawal (min base 100 MW)
    surchargeMid: number;
    surchargeHigh: number;
    capRate: number; // ₹/kWh
  };
  reserve: {
    solarErrPct: number;
    windErrPct: number;
    loadErrPct: number;
  };
  sim: {
    mode: 'live' | 'accelerated' | 'paused';
    secondsPerBlock: number; // when accelerated
  };
  llm: { enabled: boolean };
}

export interface MaintenanceItem {
  id: string;
  assetId: string;
  assetName: string;
  type: 'planned' | 'forced';
  startSlot: number;
  endSlot: number; // exclusive
  derateMW: number | null; // capacity lost, null => full outage
  deferrable: boolean;
  description: string;
  status: 'scheduled' | 'active' | 'completed' | 'deferred';
  note?: string;
}

export type EventType =
  | 'cloud_cover'
  | 'wind_surge'
  | 'wind_drop'
  | 'price_spike'
  | 'bess_outage'
  | 'line_limit'
  | 'demand_surge'
  | 'freq_dip'
  | 'freq_high'
  | 'forecast_update'
  | 'storm_alert'
  | 'thermal_trip';

export interface ScenarioEvent {
  id: string;
  type: EventType;
  startSlot: number;
  endSlot: number;
  targetId?: string; // asset / corridor / customer id; undefined => all relevant
  magnitude: number; // meaning depends on type (see twin.ts)
  announceSlot: number; // when the agent learns about it
  label: string;
}

export interface Flows {
  solar: number;
  wind: number;
  thermal: number;
  bessDis: number;
  bessCh: number;
  damBuy: number;
  damSell: number;
  rtmBuy: number;
  rtmSell: number;
  grid: number;
  curtailSolar: number;
  curtailWind: number;
  dr: number;
  shiftNet: number; // +ve = load added (shift-in), -ve = load deferred
  unserved: number;
  dsmDraw: number; // +ve over-drawal, -ve under-drawal (actual-scheduled)
  load: number; // load actually served (after DR/shift)
  demand: number; // underlying demand before DR/shift
  // per-asset signed values for drill-down
  by: Record<string, number>;
}

export interface CostBreakdown {
  solar: number;
  wind: number;
  thermal: number;
  market: number;
  grid: number;
  bess: number;
  dsm: number;
  curtail: number;
  dr: number;
  startup: number;
  fixed: number;
  total: number;
}

export interface BlockRow {
  slot: number;
  b: number;
  time: string;
  status: 'past' | 'current' | 'future';
  demandFc: number;
  demand: number;
  solarAvailFc: number;
  solarAvail: number;
  windAvailFc: number;
  windAvail: number;
  damPrice: number;
  rtmPrice: number;
  freq: number | null;
  plan: Flows | null;
  act: Flows | null;
  soc: number; // % pooled, end of block
  socMWh: number;
  shadowPrice: number | null; // ₹/kWh value of stored energy at this block (LP dual)
  smc: number | null; // system marginal cost ₹/kWh (LP dual of the balance row)
  scheduledNet: number | null; // scheduled external interchange MW (+import)
  dsmMW: number | null;
  cost: CostBreakdown | null;
  costPerUnit: number | null; // ₹/kWh incl. DSM
  dsmRate: number | null;
  dsmCost: number | null;
  reserveUpReq: number;
  reserveUpAvail: number;
  reserveDnReq: number;
  reserveDnAvail: number;
  emissionsT: number | null;
  planVersion: number;
}

/**
 * Every action the agent can take belongs to exactly ONE bucket (mutually exclusive) and the buckets cover every lever the
 * optimiser has (collectively exhaustive). Reserve shortfalls and the frequency protocols are not actions: they are states,
 * reported as alerts and as the criterion in force.
 */
export type ActionBucket = 'battery' | 'market' | 'renewables' | 'thermal' | 'demand' | 'maintenance';
export type ActionType =
  | 'bess_charge' | 'bess_discharge' | 'bess_hold' // battery
  | 'market_buy' | 'market_sell' | 'market_defer' | 'grid_import' // market (exchange + contract)
  | 'curtail_solar' | 'curtail_wind' // renewables
  | 'thermal_start' | 'thermal_ramp' | 'thermal_backdown' | 'thermal_stop' // thermal
  | 'dr' | 'load_shift' | 'load_disrupt' // demand management
  | 'maintenance_inspect'; // maintenance (reschedules are proposals, see MaintProposal)

export const ACTION_BUCKET: Record<ActionType, ActionBucket> = {
  bess_charge: 'battery', bess_discharge: 'battery', bess_hold: 'battery',
  market_buy: 'market', market_sell: 'market', market_defer: 'market', grid_import: 'market',
  curtail_solar: 'renewables', curtail_wind: 'renewables',
  thermal_start: 'thermal', thermal_ramp: 'thermal', thermal_backdown: 'thermal', thermal_stop: 'thermal',
  dr: 'demand', load_shift: 'demand', load_disrupt: 'demand',
  maintenance_inspect: 'maintenance',
};

export interface AgentAction {
  id: string;
  slot: number; // block the action applies to
  type: ActionType;
  bucket?: ActionBucket;
  title: string;
  summary?: string; // one-line plain-language description
  detail?: string[]; // short supporting lines (e.g. one per customer)
  target: string;
  mw: number | null;
  priority: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  criterion: string; // the optimality criterion that drove it
  reasoning: string;
  alternative: string; // best rejected alternative and why
  impactRs: number | null; // ₹ '000 expected benefit vs. alternative
  confidence: number; // 0..1
  requiresApproval: boolean;
  status: 'executed' | 'planned' | 'pending' | 'approved' | 'rejected';
}

export interface LogEntry {
  id: number;
  slot: number;
  wall: number;
  level: 'info' | 'warn' | 'critical' | 'action';
  category: string;
  message: string;
}

export interface Alert {
  id: string;
  level: 'info' | 'warn' | 'critical';
  title: string;
  detail: string;
  slot: number;
}

export interface Criterion {
  rank: number;
  name: string;
  status: 'ok' | 'watch' | 'binding' | 'active';
  detail: string;
  value: string;
}

export interface Telemetry {
  opt?: { busy: boolean; forTime: string; version: number; ms: number; ok: boolean; approximate: boolean; finishedAt: number; stale?: boolean; nextAt?: string };
  slot: number;
  freq: number;
  gridBalanceMW: number; // interconnected-grid supply minus demand; +ve = surplus (frequency rising), -ve = shortfall (falling)
  demand: number; // load actually served
  requested: number; // load customers asked for before any cut or shedding
  notServed: number; // demand response + unserved energy (MW)
  generation: number; // own generation incl. BESS discharge
  imports: number; // market + contract + deviation drawal
  sinks: number; // BESS charging + exports
  buy: number; // exchange purchases (day-ahead + real-time)
  sell: number; // exchange sales (day-ahead + real-time)
  deviation: number; // actual - scheduled drawal
  solar: number;
  wind: number;
  thermal: number;
  bessNet: number;
  market: number;
  grid: number;
  rtmPrice: number;
  damPrice: number;
  socPct: number;
}
