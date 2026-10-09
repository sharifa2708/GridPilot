import type { MaintenanceItem, Portfolio, Settings } from './types.js';
import { BLOCKS } from './util.js';

const loc = (name: string, state: string, lat: number, lon: number) => ({ name, state, lat, lon });

export function defaultPortfolio(): Portfolio {
  return {
    utilityName: 'Western Grid Distribution Co. (demo DISCOM)',
    corridors: [
      { id: 'RJ', name: 'Rajasthan–WR 765kV evacuation', ttcMW: 300 },
      { id: 'SR', name: 'Southern Region ISTS corridor', ttcMW: 340 },
      { id: 'WR', name: 'Gujarat 400kV evacuation', ttcMW: 190 },
      { id: 'CR', name: 'Central Region 400kV evacuation', ttcMW: 110 },
    ],
    interconnect: {
      importLimitMW: 450,
      exportLimitMW: 350,
      gridContractLimitMW: 150,
      gridContractPrice: 4.7,
    },
    solar: [
      { id: 'sol-bhadla', kind: 'solar', name: 'Bhadla Solar Park', location: loc('Bhadla', 'Rajasthan', 27.54, 71.92), corridorId: 'RJ', capacityMW: 200, dcAcRatio: 1.35, performanceRatio: 0.82, tariff: 2.45, enabled: true },
      { id: 'sol-pavagada', kind: 'solar', name: 'Pavagada Solar Park', location: loc('Pavagada', 'Karnataka', 14.1, 77.28), corridorId: 'SR', capacityMW: 120, dcAcRatio: 1.3, performanceRatio: 0.81, tariff: 2.62, enabled: true },
      { id: 'sol-kurnool', kind: 'solar', name: 'Kurnool Ultra Mega Solar', location: loc('Kurnool', 'Andhra Pradesh', 15.68, 78.28), corridorId: 'SR', capacityMW: 100, dcAcRatio: 1.3, performanceRatio: 0.8, tariff: 2.7, enabled: true },
      { id: 'sol-rewa', kind: 'solar', name: 'Rewa Ultra Mega Solar', location: loc('Rewa', 'Madhya Pradesh', 24.53, 81.3), corridorId: 'CR', capacityMW: 90, dcAcRatio: 1.3, performanceRatio: 0.81, tariff: 2.97, enabled: true },
      { id: 'sol-charanka', kind: 'solar', name: 'Charanka Solar Park', location: loc('Charanka', 'Gujarat', 23.9, 71.2), corridorId: 'WR', capacityMW: 90, dcAcRatio: 1.3, performanceRatio: 0.81, tariff: 2.8, enabled: true },
    ],
    wind: [
      { id: 'wnd-jaisalmer', kind: 'wind', name: 'Jaisalmer Wind Cluster', location: loc('Jaisalmer', 'Rajasthan', 26.92, 70.9), corridorId: 'RJ', capacityMW: 120, hubHeightM: 100, tariff: 3.05, enabled: true },
      { id: 'wnd-muppandal', kind: 'wind', name: 'Muppandal Wind Farm', location: loc('Muppandal', 'Tamil Nadu', 8.25, 77.55), corridorId: 'SR', capacityMW: 110, hubHeightM: 100, tariff: 3.2, enabled: true },
      { id: 'wnd-kutch', kind: 'wind', name: 'Kutch Wind Farm', location: loc('Kutch', 'Gujarat', 23.3, 69.7), corridorId: 'WR', capacityMW: 100, hubHeightM: 110, tariff: 2.95, enabled: true },
    ],
    thermal: [
      { id: 'th-base', kind: 'thermal', name: 'Korba Unit-1 (base)', location: loc('Korba', 'Chhattisgarh', 22.36, 82.68), corridorId: 'CR', capacityMW: 400, minLoadPct: 55, rampPctPerMin: 1.0, varCost: 3.65, noLoadCost: 95, startupCost: 2400, capacityCharge: 1.7, minUpBlocks: 32, minDownBlocks: 24, tripRestartBlocks: 8, emissionFactor: 0.96, group: 'A', mustRun: true, enabled: true },
      { id: 'th-flex', kind: 'thermal', name: 'Sipat Unit-2 (flexible)', location: loc('Sipat', 'Chhattisgarh', 22.09, 82.15), corridorId: 'CR', capacityMW: 300, minLoadPct: 40, rampPctPerMin: 2.0, varCost: 4.7, noLoadCost: 70, startupCost: 1500, capacityCharge: 1.6, minUpBlocks: 16, minDownBlocks: 12, tripRestartBlocks: 6, emissionFactor: 0.93, group: 'B', mustRun: true, enabled: true },
      { id: 'th-peaker', kind: 'thermal', name: 'Dahej Gas Peaker', location: loc('Dahej', 'Gujarat', 21.7, 72.6), corridorId: 'WR', capacityMW: 150, minLoadPct: 30, rampPctPerMin: 5.0, varCost: 10.2, noLoadCost: 25, startupCost: 150, capacityCharge: 0.9, minUpBlocks: 4, minDownBlocks: 4, tripRestartBlocks: 2, emissionFactor: 0.45, group: 'C', mustRun: false, enabled: true },
    ],
    bess: [
      { id: 'bess-bhadla', kind: 'bess', name: 'BESS-1 Bhadla (4h)', location: loc('Bhadla', 'Rajasthan', 27.54, 71.92), corridorId: 'RJ', powerMW: 120, energyMWh: 480, etaCharge: 0.94, etaDischarge: 0.94, socMinPct: 10, socMaxPct: 95, initialSocPct: 50, degradationCost: 0.8, gridSupportReservePct: 20, enabled: true },
      { id: 'bess-pavagada', kind: 'bess', name: 'BESS-2 Pavagada (4h)', location: loc('Pavagada', 'Karnataka', 14.1, 77.28), corridorId: 'SR', powerMW: 80, energyMWh: 320, etaCharge: 0.94, etaDischarge: 0.94, socMinPct: 10, socMaxPct: 95, initialSocPct: 50, degradationCost: 0.8, gridSupportReservePct: 20, enabled: true },
    ],
    customers: [
      { id: 'c-steel', name: 'Rourkela Steel Works', segment: 'Industrial', location: loc('Rourkela', 'Odisha', 22.23, 84.86), peakMW: 210, profile: 'industrial-continuous', criticality: 'essential', drFlexPct: 12, shiftablePct: 0, tariff: 6.6, drIncentive: 2.0, coolingSensitivity: 0.004, enabled: true },
      { id: 'c-petchem', name: 'Jamnagar Petrochemical Complex', segment: 'Industrial', location: loc('Jamnagar', 'Gujarat', 22.47, 70.07), peakMW: 190, profile: 'industrial-continuous', criticality: 'essential', drFlexPct: 8, shiftablePct: 0, tariff: 6.9, drIncentive: 2.0, coolingSensitivity: 0.004, enabled: true },
      { id: 'c-cement', name: 'Nagpur Cement Works', segment: 'Industrial', location: loc('Nagpur', 'Maharashtra', 21.15, 79.09), peakMW: 70, profile: 'industrial-twoshift', criticality: 'flexible', drFlexPct: 30, shiftablePct: 25, tariff: 6.4, drIncentive: 1.8, coolingSensitivity: 0.006, enabled: true },
      { id: 'c-auto', name: 'Pune Auto Cluster', segment: 'Industrial', location: loc('Pune', 'Maharashtra', 18.52, 73.86), peakMW: 100, profile: 'industrial-twoshift', criticality: 'essential', drFlexPct: 20, shiftablePct: 15, tariff: 7.1, drIncentive: 2.0, coolingSensitivity: 0.006, enabled: true },
      { id: 'c-dc', name: 'Hyderabad Data Centre Campus', segment: 'Critical infra', location: loc('Hyderabad', 'Telangana', 17.38, 78.48), peakMW: 60, profile: 'datacenter', criticality: 'critical', drFlexPct: 0, shiftablePct: 0, tariff: 8.2, drIncentive: 0, coolingSensitivity: 0.01, enabled: true },
      { id: 'c-textile', name: 'Surat Textile Park', segment: 'Industrial', location: loc('Surat', 'Gujarat', 21.17, 72.83), peakMW: 60, profile: 'industrial-twoshift', criticality: 'flexible', drFlexPct: 30, shiftablePct: 30, tariff: 6.8, drIncentive: 1.8, coolingSensitivity: 0.005, enabled: true },
      { id: 'c-metro', name: 'Ahmedabad Commercial Feeders', segment: 'Commercial', location: loc('Ahmedabad', 'Gujarat', 23.02, 72.57), peakMW: 120, profile: 'commercial', criticality: 'essential', drFlexPct: 8, shiftablePct: 0, tariff: 8.0, drIncentive: 2.5, coolingSensitivity: 0.015, enabled: true },
      { id: 'c-resi', name: 'Vadodara Urban Residential', segment: 'Residential', location: loc('Vadodara', 'Gujarat', 22.31, 73.19), peakMW: 340, profile: 'residential', criticality: 'essential', drFlexPct: 5, shiftablePct: 0, tariff: 6.3, drIncentive: 2.5, coolingSensitivity: 0.02, enabled: true },
      { id: 'c-agri', name: 'Mehsana Agricultural Feeders', segment: 'Agriculture', location: loc('Mehsana', 'Gujarat', 23.6, 72.4), peakMW: 90, profile: 'agri', criticality: 'flexible', drFlexPct: 40, shiftablePct: 55, tariff: 2.6, drIncentive: 0.5, coolingSensitivity: 0.0, enabled: true },
    ],
  };
}

export function defaultSettings(): Settings {
  return {
    autonomy: 'autonomous',
    weights: { carbonPrice: 1000, reCurtailmentPenalty: 1.5, degradationScale: 1, reserveStrictness: 1 },
    market: { priceCap: 10, exchangeFee: 0.02, buyAdder: 0.42, sellDeduction: 0.28, maxBuyMW: 400, maxSellMW: 300, rtmLeadBlocks: 4 },
    dsm: { bandPct: 10, surchargeMid: 1.2, surchargeHigh: 1.5, capRate: 12 },
    reserve: { solarErrPct: 12, windErrPct: 20, loadErrPct: 2.5 },
    sim: { mode: 'live', secondsPerBlock: 5 },
    llm: { enabled: true },
  };
}

/** Sample maintenance schedule relative to the given IST day number. */
export function defaultMaintenance(day: number): MaintenanceItem[] {
  const s = (d: number, h: number, m = 0) => (day + d) * BLOCKS + Math.round((h * 60 + m) / 15);
  return [
    { id: 'm-1', assetId: 'sol-pavagada', assetName: 'Pavagada Solar Park', type: 'planned', startSlot: s(0, 11, 30), endSlot: s(0, 14, 0), derateMW: 30, deferrable: true, description: 'Inverter-station string cleaning & thermography (zone 3)', status: 'scheduled' },
    { id: 'm-2', assetId: 'th-flex', assetName: 'Sipat Unit-2 (flexible)', type: 'planned', startSlot: s(1, 9, 0), endSlot: s(1, 15, 0), derateMW: 90, deferrable: true, description: 'ID fan bearing inspection (partial derate)', status: 'scheduled' },
    { id: 'm-3', assetId: 'wnd-muppandal', assetName: 'Muppandal Wind Farm', type: 'planned', startSlot: s(1, 10, 0), endSlot: s(1, 14, 0), derateMW: 35, deferrable: true, description: 'Gearbox oil sampling on 7 WTGs', status: 'scheduled' },
    { id: 'm-4', assetId: 'bess-pavagada', assetName: 'BESS-2 Pavagada (4h)', type: 'planned', startSlot: s(2, 8, 0), endSlot: s(2, 11, 0), derateMW: null, deferrable: true, description: 'PCS firmware update & fire-suppression test', status: 'scheduled' },
    { id: 'm-5', assetId: 'sol-rewa', assetName: 'Rewa Ultra Mega Solar', type: 'planned', startSlot: s(2, 12, 0), endSlot: s(2, 16, 0), derateMW: 20, deferrable: false, description: 'Transformer oil filtration (regulatory deadline)', status: 'scheduled' },
  ];
}
