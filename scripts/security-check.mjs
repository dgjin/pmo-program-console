import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'pmo-sec-'));
const PORT = 5393;
const BASE = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, label, detail = '') => {
  if (!ok) failures.push(`${label}${detail ? `：${detail}` : ''}`);
};

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PMO_PORT: String(PORT), PMO_HOST: '127.0.0.1', PMO_DB: path.join(TMP, 'pmo.db') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stderr.on('data', (d) => { log += d.toString(); });

async function main() {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* retry */ }
    await wait(250);
  }
  const home = await fetch(`${BASE}/`);
  const h = home.headers;
  check(home.ok, '首页可访问');
  check(/default-src 'self'/.test(h.get('content-security-policy') || ''), 'CSP default-src');
  check(!/script-src[^;]*unsafe-inline/.test(h.get('content-security-policy') || ''), 'CSP script-src 不含 unsafe-inline');
  check(h.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options');
  check(h.get('x-frame-options') === 'DENY', 'X-Frame-Options');
  check(h.get('referrer-policy') === 'same-origin', 'Referrer-Policy');
  check(Boolean(h.get('permissions-policy')), 'Permissions-Policy');
  check(Boolean(h.get('cross-origin-opener-policy')), 'COOP');

  const unauth = await fetch(`${BASE}/api/bootstrap`);
  check(unauth.status === 401, '未登录访问 bootstrap', `status ${unauth.status}`);

  const badOrigin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ username: 'pmo', password: 'pmo123456' }),
  });
  check(badOrigin.status === 403, '跨站 Origin 写入被拒绝', `status ${badOrigin.status}`);

  const secure = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ username: 'pmo', password: 'pmo123456' }),
  });
  const cookie = secure.headers.get('set-cookie') || '';
  check(secure.ok, 'HTTPS 代理登录');
  check(/HttpOnly/i.test(cookie), 'Cookie HttpOnly');
  check(/SameSite=Lax/i.test(cookie), 'Cookie SameSite=Lax');
  check(/Secure/i.test(cookie), 'HTTPS 代理 Cookie Secure');
  check(/max-age/i.test(secure.headers.get('strict-transport-security') || ''), 'HTTPS 代理 HSTS');

  const traversal = await fetch(`${BASE}/%2e%2e%2fserver.js`);
  const body = await traversal.text();
  check([400, 403, 404].includes(traversal.status), '静态路径穿越被拒绝', `status ${traversal.status}`);
  check(!body.includes("require('node:sqlite')") && !body.includes('SESSION_COOKIE'), '路径穿越不泄露源码');

  const sqli = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: "' OR 1=1 --", password: 'x' }),
  });
  check(sqli.status === 401, 'SQL 注入式登录被拒绝', `status ${sqli.status}`);

  const clientLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'hejing', password: 'pm123456' }),
  });
  const clientCookie = (clientLogin.headers.get('set-cookie') || '').split(';')[0];
  const idor = await fetch(`${BASE}/api/projects/3/workspace`, { headers: { Cookie: clientCookie } });
  check([400, 403, 404].includes(idor.status), '跨项目越权访问被拒绝', `status ${idor.status}`);
  const idorKb = await fetch(`${BASE}/api/projects/3/kb`, { headers: { Cookie: clientCookie } });
  check([400, 403, 404].includes(idorKb.status), '跨项目知识库访问被拒绝', `status ${idorKb.status}`);

  const badLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'pmo', password: 'wrong-password' }),
  });
  check(badLogin.status === 401, '错误密码被拒绝', `status ${badLogin.status}`);
  let throttled = false;
  for (let i = 0; i < 5; i += 1) {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'pmo', password: 'wrong-password' }),
    });
    if (r.status === 429) throttled = true;
  }
  check(throttled, '连续错误密码触发限流');
}

try {
  await main();
  if (failures.length) {
    console.error(`Security baseline failed (${failures.length}):`);
    for (const f of failures) console.error(`- ${f}`);
    process.exitCode = 1;
  } else {
    console.log('Security baseline OK: headers, auth, Origin, Secure cookie, HSTS, path traversal');
  }
} catch (err) {
  console.error(`Security baseline failed: ${err.message}`);
  if (log) console.error(log.slice(-1200));
  process.exitCode = 1;
} finally {
  try { server.kill('SIGTERM'); } catch { /* ignore */ }
  await wait(300);
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}
