import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'pmo-load-'));
const PORT = 5392;
const BASE = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PMO_PORT: String(PORT), PMO_HOST: '127.0.0.1', PMO_DB: path.join(TMP, 'pmo.db') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stderr.on('data', (d) => { serverLog += d.toString(); });

async function waitServer() {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* retry */ }
    await wait(250);
  }
  throw new Error(`服务没有启动：${serverLog.slice(-800)}`);
}

async function main() {
  await waitServer();
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'pmo', password: 'pmo123456' }),
  });
  if (!login.ok) throw new Error(`登录失败：${login.status}`);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const endpoints = [
    '/api/bootstrap',
    '/api/projects',
    '/api/projects/1/plan',
    '/api/projects/1/workspace',
    '/api/resources',
    '/api/gates',
    '/api/deliverables?kind=weekly&period=2026-11-02',
  ];
  const total = 84;
  const concurrency = 7;
  const times = [];
  let errors = 0;
  let next = 0;
  const worker = async () => {
    while (next < total) {
      const i = next++;
      const url = endpoints[i % endpoints.length];
      const t0 = performance.now();
      try {
        const r = await fetch(`${BASE}${url}`, { headers: { Cookie: cookie } });
        if (!r.ok) errors += 1;
        await r.arrayBuffer();
      } catch {
        errors += 1;
      }
      times.push(performance.now() - t0);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  times.sort((a, b) => a - b);
  const p50 = Math.round(times[Math.floor(times.length * 0.5)]);
  const p95 = Math.round(times[Math.floor(times.length * 0.95)]);
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  console.log(`Load test: ${total} requests, concurrency ${concurrency}, errors ${errors}, avg ${avg}ms, p50 ${p50}ms, p95 ${p95}ms`);
  if (errors) throw new Error(`压测出现 ${errors} 个错误`);
  if (p95 > 2000) throw new Error(`p95 ${p95}ms 超过 2000ms`);
}

try {
  await main();
} catch (err) {
  console.error(`Load test failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  try { server.kill('SIGTERM'); } catch { /* ignore */ }
  await wait(300);
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}
