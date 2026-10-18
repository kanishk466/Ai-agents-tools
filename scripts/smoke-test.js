/* eslint-disable no-console */
/**
 * Smoke test - boots the server in-process-free mode (offline actor, in-memory
 * storage), runs a couple of agent tasks, and asserts the pipeline works.
 *
 *   node scripts/smoke-test.js
 */
const { spawn } = require('node:child_process');

const PORT = process.env.SMOKE_PORT || '3199';
const BASE = `http://localhost:${PORT}`;

function startServer() {
  // Single clean node process (no npx shell nesting) so kill() is reliable.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: __dirname + '/..',
    env: {
      ...process.env,
      PORT,
      AGENT_MODE: 'local',
      LOG_LEVEL: 'error',
      DATABASE_URL: '',
      REDIS_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  return child;
}

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('server did not become healthy in time');
}

async function runAgent(query) {
  const res = await fetch(`${BASE}/api/agent/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const run = await res.json();
  if (!res.ok) throw new Error(`run rejected: ${run.error}`);

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const status = await (await fetch(`${BASE}/api/agent/status/${run.runId}`)).json();
    if (status.status === 'completed' || status.status === 'failed') return { run, status };
  }
  throw new Error('run timed out');
}

function assert(condition, label) {
  if (condition) console.log(`  ✔ ${label}`);
  else {
    console.error(`  ✘ ${label}`);
    process.exitCode = 1;
  }
}

async function main() {
  console.log('Starting server (offline mode, in-memory storage)…');
  const server = startServer();
  try {
    const health = await waitForHealth();
    assert(health.status === 'ok', 'health endpoint responds');
    assert(health.tools.length === 5, 'all 5 tools registered');

    console.log('Math query -> calculator tool…');
    const math = await runAgent('calculate 2 * (3 + 4) ^ 2');
    assert(math.status.status === 'completed', 'math run completed');
    assert(
      (math.status.result.answer || '').includes('98'),
      'calculator produced the correct result (98)',
    );
    assert(
      math.status.result.stats.toolsUsed.includes('calculator'),
      'calculator recorded in stats',
    );

    console.log('Simple query -> direct answer (no tools)…');
    const simple = await runAgent('hello there');
    assert(simple.status.status === 'completed', 'simple run completed');
    assert(
      (simple.status.result.stats.toolsUsed || []).length === 0,
      'simple query used no tools',
    );

    console.log('Report fetch…');
    const reportRes = await fetch(`${BASE}/api/reports/${math.run.runId}`);
    assert(reportRes.ok, 'report endpoint returns the generated markdown');

    console.log(process.exitCode ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST PASSED');
  } finally {
    server.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
