// "Ask GridPilot": a grounded Q&A over the live state. The LLM (Claude) is OPTIONAL: it only receives a JSON of the app's own numbers, the rules the
// app runs on and a short glossary, and is told to answer exclusively from them. Without an API key (or when the call fails) a deterministic responder
// answers the common questions from the same data, so the feature never fails.
import type { Engine } from './engine.js';
import { restartBlocks, thermalHold } from './physics.js';
import { blockOf, hhmm, slotLabel, sum } from './util.js';

const r1 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

const GLOSSARY = [
  'All times are IST. One block = 15 minutes; a day has 96 blocks. Power is in MW, energy in MWh, prices in ₹/kWh unless stated; "₹k" = thousand rupees, "L" = lakh.',
  'Demand = what customers ask for now. Own gen = solar + wind + thermal + battery discharge. Grid = long-term contract import. Buy/Sell = purchases/sales on the power exchange (day-ahead DAM and real-time RTM).',
  'gap = demand - own gen - grid - buy + sell (battery charging is not counted). Positive gap = deficit (supply short of demand); negative = surplus. This is the "deficit/surplus" shown beside the demand figure on the Demand·Generation card.',
  'Δsched (deviation) = actual net drawal minus scheduled net drawal. Positive = over-drawal (more taken from the grid than scheduled), negative = under-drawal. Over-drawal is physically supplied by the grid and settled as a deviation charge (DSM); it is not unserved load.',
  'DSM cost sign: a positive rupee figure is payable; a NEGATIVE figure is a net CREDIT. Under-drawal inside the allowed band earns a credit, so a negative DSM total means the deviations so far have earned money, not cost it.',
  'In a shortage the agent uses, in order: thermal ramp-up, contract import and market purchases, demand response (cut or defer flexible and non-critical load), reserves and the battery, curbing committed exchange sales, and only last a disruption across all customers. Critical customers are not cut by demand response.',
  'Inside the current block only physical responses happen (plant follows its schedule, a tripped unit is lost, battery charging stops if the block is short, flexible load is cut in an emergency); economic re-dispatch (buying, selling, starting units, changing the battery plan) happens in the NEXT interval plan.',
  'A thermal unit that trips needs its restart time before it can be on line again (shown as restart pending); it also has minimum up and down times. Day-ahead bids close at 10:00 on the day before delivery; real-time bids close 4 blocks ahead.',
  'The plan is re-optimised every block over a rolling 96-block horizon. Objective order: grid security, reliability and critical-load protection, reserve adequacy, DSM exposure, delivered cost, renewable use, battery wear.',
  'Grid frequency is modelled at 50 Hz and moves only with the DISCOM own over/under-drawal (10,000 MW per Hz).',
];

function dsmRules(e: Engine) {
  const d = e.S.dsm;
  return {
    bandPct: d.bandPct, bandRule: `allowed band = ${d.bandPct}% of the scheduled net drawal (at least ${d.bandPct}% of 200 MW)`, capRateRsPerKwh: d.capRate,
    overDrawal: `paid at the reference price (area clearing price, at least ₹1) adjusted for frequency, capped at ₹${d.capRate}/kWh; the part above the band is multiplied by ${d.surchargeMid} (first half band over) and ${d.surchargeHigh} (beyond that)`,
    underDrawal: 'credited at about 90% of the reference price (at 50 Hz) for the part inside the band; nothing is credited beyond the band',
    deadband: 'deviations below 0.5 MW are not settled',
  };
}

function context(e: Engine, history: { q: string; a: string }[] = []) {
  const s = e.snapshot();
  const t = s.telemetry;
  const row: any = s.rows[s.now.b] ?? {};
  const truth = e.twin.truthAt(e.cursor);
  const hold = thermalHold(e.P, e.fleet);
  const asked = t.requested ?? t.demand;
  const gap = asked - t.generation - t.grid - t.buy + t.sell;
  const band = (e.S.dsm.bandPct / 100) * Math.max(Math.abs(row.scheduledNet ?? 0), 200);
  const last4 = sum(Array.from({ length: 4 }, (_, k) => e.rowAt(e.cursor - k)?.dsmCost ?? 0));
  const plan = e.lastPlan;

  const horizon: any[] = [];
  if (plan) for (let i = 0; i < Math.min(plan.blocks.length, 24); i += 2) {
    const b = plan.blocks[i]; const f = b.flows;
    horizon.push({ time: hhmm(blockOf(b.slot)), demand: Math.round(f.demand), solar: Math.round(f.solar), wind: Math.round(f.wind), thermal: Math.round(f.thermal), bessNet: Math.round(f.bessDis - f.bessCh), marketNet: Math.round(f.damBuy - f.damSell + f.rtmBuy - f.rtmSell), grid: Math.round(f.grid), curtail: Math.round(f.curtailSolar + f.curtailWind), unserved: Math.round(f.unserved), socPct: Math.round((b.socMWh / Math.max(1, e.totalBessMWh())) * 100), smc: r2(b.smc) });
  }
  const sit = e.agent.situation;
  return {
    now: { time: s.now.time, date: s.now.date, mode: s.now.mode },
    balance: {
      demandAskedMW: r1(asked), demandServedMW: r1(t.demand), notServedMW: r1(t.notServed), ownGenMW: r1(t.generation), solarMW: r1(t.solar), windMW: r1(t.wind), thermalMW: r1(t.thermal), batteryNetMW: r1(t.bessNet), '(batteryNet positive = discharging, negative = charging)': true,
      contractGridMW: r1(t.grid), exchangeBuyMW: r1(t.buy), exchangeSellMW: r1(t.sell),
      gapMW: r1(gap), gapMeaning: gap > 5 ? 'deficit' : gap < -5 ? 'surplus' : 'balanced',
      scheduledNetDrawalMW: r1(row.scheduledNet), deviationMW: r1(t.deviation), deviationMeaning: (t.deviation ?? 0) > 0.5 ? 'over-drawal (more from the grid than scheduled)' : (t.deviation ?? 0) < -0.5 ? 'under-drawal' : 'on schedule', frequencyHz: r2(t.freq),
    },
    dsm: { allowedBandMW: r1(band), currentDeviationMW: r1(t.deviation), currentRateRsPerKwh: r2(row.dsmRate), thisBlockCostRsK: r1(row.dsmCost), lastHourCostRsK: r1(last4), dayCostRsK: r1(s.kpis.dsmCostK), '(negative cost = net credit)': true, rules: dsmRules(e) },
    prices: { damRsPerKwh: r2(t.damPrice), rtmRsPerKwh: r2(t.rtmPrice), marginalCostRsPerKwh: r2(row.smc), costPerUnitThisBlock: r2(row.costPerUnit), costPerUnitDayAvg: r2(s.kpis.cpu) },
    limits: { importLimitMW: e.P.interconnect.importLimitMW, exportLimitMW: e.P.interconnect.exportLimitMW, contractLimitMW: e.P.interconnect.gridContractLimitMW, contractPriceRsPerKwh: e.P.interconnect.gridContractPrice, maxExchangeBuyMW: e.S.market.maxBuyMW, maxExchangeSellMW: e.S.market.maxSellMW },
    thermal: e.P.thermal.filter((u) => u.enabled).map((u) => {
      const cap = truth.thermalCap[u.id] ?? u.capacityMW;
      const on = !!e.fleet.thermalOn[u.id];
      // when a unit that is out can next be on line: the end of the trip event or maintenance on it, then its restart time (or the remaining hold when only the restart is pending)
      const ends = [...e.events.filter((x: any) => x.type === 'thermal_trip' && (!x.targetId || x.targetId === u.id) && x.endSlot > e.cursor).map((x: any) => x.endSlot), ...e.maint.filter((m) => m.assetId === u.id && m.status !== 'completed' && m.status !== 'deferred' && m.startSlot <= e.cursor && m.endSlot > e.cursor).map((m) => m.endSlot)];
      const outNow = !on && cap < (u.minLoadPct / 100) * u.capacityMW;
      const earliest = outNow ? (ends.length ? Math.max(...ends) + restartBlocks(u) : null) : !on && (hold[u.id] ?? 0) > 0 ? e.cursor + 1 + (hold[u.id] ?? 0) : null;
      return { name: u.name, earliestOnLineAt: earliest == null ? null : slotLabel(earliest), restartTimeBlocksAfterATrip: restartBlocks(u), capacityMW: u.capacityMW, technicalMinMW: Math.round((u.minLoadPct / 100) * u.capacityMW), outputMW: r1(e.fleet.thermalP[u.id] ?? 0), availableMW: r1(cap), state: on ? 'running' : cap < (u.minLoadPct / 100) * u.capacityMW ? 'out of service (tripped/maintenance)' : e.fleet.thermalTripped?.[u.id] && (hold[u.id] ?? 0) > 0 ? 'available, restart pending' : 'off', blocksUntilStateCanChange: hold[u.id] ?? 0, energyChargeRsPerKwh: u.varCost, startupCostRsK: u.startupCost, mustRun: u.mustRun };
    }),
    battery: { socPct: r1(t.socPct), totalEnergyMWh: Math.round(e.totalBessMWh()), units: e.P.bess.filter((b) => b.enabled).map((b) => ({ name: b.name, powerMW: b.powerMW, energyMWh: b.energyMWh, availablePowerMW: r1(truth.bessPower[b.id] ?? b.powerMW), socPct: r1(((e.fleet.socMWh[b.id] ?? 0) / b.energyMWh) * 100) })) },
    customers: s.customers.map((c: any) => ({ name: c.name, criticality: c.criticality, demandMW: r1(c.demandMW), cutMW: r1(c.curtailedMW), deferredOrPulledMW: r1(c.shiftedMW), disruptedMW: r1(c.disruptedMW), servedMW: r1(c.servedMW) })),
    scenarioEvents: e.events.map((x: any) => ({ event: x.label, from: slotLabel(x.startSlot), until: slotLabel(x.endSlot), state: x.startSlot <= e.cursor ? 'active' : 'scheduled' })),
    maintenance: e.maint.filter((m) => m.status !== 'completed' && m.status !== 'deferred' && m.startSlot < e.cursor + 48).slice(0, 8).map((m) => ({ asset: m.assetName, from: slotLabel(m.startSlot), to: slotLabel(m.endSlot), derateMW: m.derateMW ?? 'full outage', status: m.status })),
    alerts: e.agent.alerts.slice(0, 8).map((a) => ({ title: a.title, detail: a.detail })),
    situation: sit ? { label: sit.label, activeEvents: sit.events.filter((x: any) => x.active).map((x: any) => `${x.label}: ${x.evidence}`) } : null,
    actionsForNextSlot: e.agent.actions.slice(0, 8).map((a) => ({ bucket: a.bucket, title: a.title, mw: r1(a.mw), criterion: a.criterion, why: a.reasoning || a.summary, alternative: a.alternative })),
    planNote: plan?.note ?? null, planFeasibility: plan?.feasibility ?? null,
    kpisToday: { energyServedMWh: Math.round(s.kpis.energyServedMWh), cpuRsPerKwh: r2(s.kpis.cpu), reUtilPct: r1(s.kpis.reUtilPct), reSharePct: r1(s.kpis.reSharePct), curtailMWh: r1(s.kpis.curtailMWh), emissionsT: Math.round(s.kpis.emissionsT) },
    horizonEvery30min: horizon,
    recentLog: (s.log as any[]).slice(-8).map((l) => l.message),
    previousQuestions: history.slice(-2).map((h) => ({ q: h.q.slice(0, 200), a: h.a.slice(0, 400) })),
    glossaryAndRules: GLOSSARY,
  };
}

// ---------------------------------------------------------------- deterministic fallback
function ruleBased(e: Engine, q: string): string {
  const c = context(e);
  const t = q.toLowerCase();
  const a = e.agent.actions;
  const b = c.balance, d = c.dsm;
  if (/dsm|deviation|drawal|penalt|schedule/.test(t)) {
    const sign = (d.dayCostRsK ?? 0) < 0 ? 'a net credit' : 'a net charge';
    return `Deviation now is ${b.deviationMW} MW (${b.deviationMeaning}) against an allowed band of ±${d.allowedBandMW} MW. DSM today is ₹${d.dayCostRsK}k (${sign}) and ₹${d.lastHourCostRsK}k in the last hour; a negative figure is a credit. Over-drawal is charged at about the reference price (higher beyond the band); under-drawal is credited inside the band only.`;
  }
  if (/deficit|surplus|short|gap|balance/.test(t)) return `Demand ${b.demandAskedMW} MW, own generation ${b.ownGenMW} MW, contract grid ${b.contractGridMW} MW, buy ${b.exchangeBuyMW} MW, sell ${b.exchangeSellMW} MW. Gap = demand - own gen - grid - buy + sell = ${b.gapMW} MW (${b.gapMeaning}). Not served: ${b.notServedMW} MW.`;
  if (/why|reason|explain/.test(t) && /(charg|batter|bess|soc)/.test(t)) {
    const x = a.find((y) => y.type === 'bess_charge' || y.type === 'bess_discharge' || y.type === 'bess_hold');
    return x ? `${x.title}: ${x.reasoning} Rejected alternative: ${x.alternative}` : 'The battery is idle this block: neither charging nor discharging beats holding charge against the look-ahead price.';
  }
  if (/curtail/.test(t)) {
    const x = a.find((y) => y.type.startsWith('curtail'));
    return x ? `${x.title}. ${x.reasoning}` : 'No curtailment is planned for the next block; thermal back-down, battery charging, export and flexible load absorb a surplus first.';
  }
  if (/cost|₹|rs\b|price|tariff/.test(t)) return `Cost per unit this block is ₹${c.prices.costPerUnitThisBlock}/kWh including DSM; day average ₹${c.prices.costPerUnitDayAvg}/kWh. DAM ₹${c.prices.damRsPerKwh}, RTM ₹${c.prices.rtmRsPerKwh}/kWh.`;
  if (/frequency|freq/.test(t)) return `Frequency is ${b.frequencyHz} Hz. It is modelled at 50 Hz and moves only with this DISCOM's own over- or under-drawal.`;
  if (/korba|sipat|dahej|thermal|unit|trip/.test(t)) return c.thermal.map((u) => `${u.name}: ${u.state}, ${u.outputMW} MW of ${u.availableMW} MW available${u.blocksUntilStateCanChange ? `, can change state in ${u.blocksUntilStateCanChange} blocks` : ''}`).join('. ') + '.';
  if (/next|plan|ahead|evening|peak/.test(t)) return `${e.agent.reasoning.headline}. ${e.agent.reasoning.bullets.slice(0, 3).join(' ')}`;
  return `${e.agent.reasoning.headline}. ${e.agent.reasoning.tradeoff} (Free-form questions need the Claude connection; it is not available right now.)`;
}

// ---------------------------------------------------------------- Claude
const SYSTEM = [
  'You are GridPilot, the explanation layer of an optimisation-based renewable energy orchestrator for an Indian DISCOM. The JSON context holds the app\'s real, current numbers, its rules and a glossary.',
  'Rules for answering:',
  '1. Answer ONLY from the context. Never invent a figure, rule or cause. If something the question needs is not in the context, say plainly which fact is missing, and still give whatever the context does show.',
  '2. Start with a direct answer to the question in the first sentence (yes / no / the reason), then the supporting numbers.',
  '3. Quote figures exactly as they appear in the context. Do arithmetic only when it is simple and show it (for example "853 - 675 - 150 = 28"). Mind the signs and the notes in the context: a negative DSM cost is a credit; gap > 0 is a deficit; deviation > 0 is over-drawal.',
  '4. Explain in plain language a control-room operator understands. Name the objective or rule in play (for example reliability, reserve, cost) when it explains a decision.',
  '5. Be concise: at most about 120 words, in 2 to 5 short sentences or a short list. Plain text only: no markdown, no asterisks, no headings. Always finish your last sentence.',
  '6. If the user\'s statement contains a wrong assumption, correct it politely using the context.',
].join('\n');

const clean = (s: string) => s
  .replace(/\*\*(.*?)\*\*/g, '$1').replace(/__(.*?)__/g, '$1').replace(/^#{1,6}\s*/gm, '').replace(/`/g, '')
  .replace(/^\s*[-*]\s+/gm, '• ').replace(/\n{3,}/g, '\n\n').trim();

/** The last complete sentence: used only if the reply was still cut off after a retry. */
const trimToSentence = (s: string) => { const i = Math.max(s.lastIndexOf('. '), s.lastIndexOf('.\n'), s.endsWith('.') ? s.length - 1 : -1); return i > 40 ? s.slice(0, i + 1) : s; };

/** Numbers in the answer that cannot be found in the data it was given (within rounding). */
function unverifiedFigures(answer: string, ctx: unknown): string[] {
  const have: number[] = [];
  const walk = (x: any) => { if (typeof x === 'number') have.push(x); else if (typeof x === 'string') for (const m of x.matchAll(/-?\d+(?:\.\d+)?/g)) have.push(Number(m[0])); else if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') Object.values(x).forEach(walk); };
  walk(ctx);
  const near = (v: number) => have.some((h) => Math.abs(Math.abs(h) - v) <= Math.max(0.6, 0.015 * v));
  // simple sums and differences the answer may have shown itself ("853 - 675 - 150 = 28") are accepted if the operands are known
  const out: string[] = [];
  const text = answer.replace(/\b(19|20)\d\d\b/g, '').replace(/\b\d{1,2}:\d{2}\b/g, '');
  const eqs = [...text.matchAll(/((?:\d+(?:\.\d+)?\s*[-+−×x*]\s*)+\d+(?:\.\d+)?)\s*=\s*(-?\d+(?:\.\d+)?)/g)];
  const skip = new Set<string>();
  for (const m of eqs) { const nums = m[1].match(/\d+(?:\.\d+)?/g)!.map(Number); if (nums.every(near)) skip.add(m[2]); }
  for (const m of text.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)) {
    const raw = m[0].replace(/,/g, ''); const v = Number(raw);
    if (!Number.isFinite(v) || v < 10 || skip.has(raw) || near(v)) continue;
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out.slice(0, 6);
}

async function callClaude(key: string, ctx: unknown, question: string, maxTokens: number, brief: boolean) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', ...(process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } : {}) },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      max_tokens: maxTokens,
      system: SYSTEM + (brief ? '\nThe previous reply was too long. Answer in at most 70 words.' : ''),
      messages: [{ role: 'user', content: `CONTEXT (JSON):\n${JSON.stringify(ctx)}\n\nQUESTION: ${question}` }],
    }),
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) { const body: any = await res.json().catch(() => ({})); const err: any = new Error(`Anthropic API ${res.status}: ${body?.error?.message ?? 'request failed'}`); err.status = res.status; throw err; }
  const j: any = await res.json();
  return { text: clean((j.content ?? []).map((c: any) => c.text ?? '').join('')), truncated: j.stop_reason === 'max_tokens' };
}

export interface AskResult { answer: string; source: 'claude' | 'rules'; note?: string; unverified?: string[] }

export async function ask(e: Engine, question: string, history: { q: string; a: string }[] = []): Promise<AskResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!question.trim()) return { answer: 'Type a question about the plan, the market, a customer or a unit.', source: 'rules' };
  if (!key || !e.S.llm.enabled) return { answer: ruleBased(e, question), source: 'rules' };
  const ctx = context(e, history);
  let lastErr = '';
  // up to three attempts: a transient failure (overload, timeout, 5xx) or a reply that was cut off is retried, the second time asking for a shorter answer
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await callClaude(key, ctx, question, attempt === 0 ? 1500 : 3000, attempt > 0);
      if (!r.text) { lastErr = 'empty reply'; continue; }
      if (r.truncated && attempt < 2) { lastErr = 'reply was cut off'; continue; }
      const answer = r.truncated ? trimToSentence(r.text) : r.text;
      const unverified = unverifiedFigures(answer, ctx);
      return { answer, source: 'claude', ...(unverified.length ? { unverified } : {}) };
    } catch (err: any) {
      lastErr = String(err?.message ?? err).slice(0, 300);
      if (err?.status && err.status < 500 && err.status !== 429 && err.status !== 408) break; // a request error will not fix itself
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  return { answer: ruleBased(e, question), source: 'rules', note: lastErr };
}

