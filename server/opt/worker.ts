import { parentPort } from 'node:worker_threads';
import highsLoader from 'highs';
import { buildAndSolve, type PlanInput } from './model.js';

let highsP: Promise<any> | null = null;
parentPort!.on('message', async (msg: { id: number; input: PlanInput }) => {
  try {
    highsP ??= highsLoader();
    const highs = await highsP;
    const out = buildAndSolve(highs, msg.input);
    parentPort!.postMessage({ id: msg.id, out });
  } catch (e: any) {
    parentPort!.postMessage({ id: msg.id, out: { ok: false, status: 'worker error: ' + (e?.message ?? e), feasibility: 'infeasible', objective: 0, solveMs: 0, mip: false, blocks: [] } });
  }
});
