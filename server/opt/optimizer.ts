// Runs the MILP in a worker thread so the API / SSE stream stays responsive while HiGHS is solving.
import { Worker } from 'node:worker_threads';
import highsLoader from 'highs';
import { buildAndSolve, type PlanInput, type PlanOutput } from './model.js';

// Two lanes, each in its own thread: the plan the clock is waiting for never queues behind background evaluation (alternative action sets).
export type Lane = 'plan' | 'background';
const workers: Record<Lane, Worker | null> = { plan: null, background: null };
let seq = 0;
const WATCHDOG_MS = 45000;
const pending = new Map<number, (o: PlanOutput) => void>();
let fallbackHighs: Promise<any> | null = null;
let workerBroken = false;

function ensureWorker(lane: Lane): Worker | null {
  if (workerBroken) return null;
  if (workers[lane]) return workers[lane];
  try {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { execArgv: ['--import', 'tsx'] });
    worker.on('message', (m: { id: number; out: PlanOutput }) => {
      const cb = pending.get(m.id);
      if (cb) { pending.delete(m.id); cb(m.out); }
    });
    workers[lane] = worker;
    worker.on('error', () => { workerBroken = true; workers[lane] = null; for (const [, cb] of pending) cb({ ok: false, status: 'worker crashed', feasibility: 'infeasible', objective: 0, solveMs: 0, mip: false, blocks: [] }); pending.clear(); });
    worker.on('exit', () => { if (workers[lane] === worker) workers[lane] = null; });
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

export async function solvePlan(input: PlanInput, lane: Lane = 'plan'): Promise<PlanOutput> {
  const w = ensureWorker(lane);
  if (w) {
    const id = ++seq;
    // watchdog: HiGHS can occasionally run far past its own time limit; a stuck solve must not stall the clock
    const res = await new Promise<PlanOutput>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        try { void workers[lane]?.terminate(); } catch { /* already gone */ }
        workers[lane] = null;
        resolve({ ok: false, status: 'solver timeout', feasibility: 'infeasible', objective: 0, solveMs: WATCHDOG_MS, mip: false, blocks: [] } as PlanOutput);
      }, WATCHDOG_MS);
      pending.set(id, (o) => { clearTimeout(timer); resolve(o); });
      w.postMessage({ id, input });
    });
    if (res.ok || !workerBroken) return res;
  }
  fallbackHighs ??= highsLoader();
  return buildAndSolve(await fallbackHighs, input);
}
