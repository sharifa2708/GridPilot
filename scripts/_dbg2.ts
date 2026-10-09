import { runScenario, highs } from '../server/test/harness.js';
import { buildAndSolve } from '../server/opt/model.js';
const r = await runScenario({ startBlock: 62, H: 36, priceMult: (_t, b) => (b >= 70 && b <= 90 ? 2 : 1) });
console.log(r.out.status, r.out.feasibility, (r.out.stages ?? []).map((s) => `${s.group}:${s.status}:${s.metric?.toFixed(2)}:${s.ms}`).join(' '));
console.log('block0 thermal', r.out.blocks[0].flows.thermal, 'load', r.out.blocks[0].flows.load);
// raw solver output keys for a time-limited MIP
const h = await highs();
const sol = h.solve('Minimize\n obj: + 1 x\nSubject To\n c: + 1 x >= 0.5\nBounds\n0 <= x <= 1\nEnd\n', { time_limit: 0.0001 });
console.log(Object.keys(sol), sol.Status, sol.PrimalSolutionStatus);
