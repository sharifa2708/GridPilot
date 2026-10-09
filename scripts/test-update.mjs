// Rewrites server/test/golden.json after a deliberate change to the policy or the optimiser.
import { spawnSync } from 'node:child_process';
const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', 'server/test/policy.test.ts'], { stdio: 'inherit', env: { ...process.env, UPDATE_GOLDEN: '1' } });
process.exit(r.status ?? 1);
