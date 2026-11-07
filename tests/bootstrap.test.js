'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');

function launch(port, db, env = {}) {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PMO_PORT: String(port),
      PMO_HOST: '127.0.0.1',
      PMO_DB: db,
      PMO_DEMO_MODE: '0',
      PMO_ADMIN_PASSWORD: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForHealth(port) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return res;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('服务未在预期时间内启动');
}

async function login(port, username, password) {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return { status: res.status, json: await res.json() };
}

function waitForExit(server, timeout = 4000) {
  if (server.exitCode !== null || server.signalCode !== null) {
    return Promise.resolve({ code: server.exitCode, signal: server.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务未在预期时间内退出')), timeout);
    server.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function cleanup(t, server, tmp) {
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      await waitForExit(server);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
}

async function waitForOutput(readOutput, predicate) {
  for (let i = 0; i < 50; i += 1) {
    const lines = readOutput().split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    if (predicate(lines)) return lines;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`未等到预期结构化日志：${readOutput()}`);
}

test('生产空库：只初始化环境变量指定的管理员，不创建固定演示账号', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-bootstrap-'));
  const server = launch(5198, path.join(tmp, 'prod.db'), {
    PMO_ADMIN_USERNAME: 'owner',
    PMO_ADMIN_NAME: '平台负责人',
    PMO_ADMIN_PASSWORD: 'a-strong-bootstrap-password',
  });
  cleanup(t, server, tmp);
  const health = await waitForHealth(5198);
  assert.equal((await health.json()).demoMode, false);

  const demo = await login(5198, 'pmo', 'pmo123456');
  assert.equal(demo.status, 401);
  const admin = await login(5198, 'owner', 'a-strong-bootstrap-password');
  assert.equal(admin.status, 200);
  assert.equal(admin.json.user.role, 'pmo');
  assert.equal(admin.json.user.name, '平台负责人');
});

test('生产空库：缺少或过短的管理员初始密码时拒绝启动', async (t) => {
  for (const [port, password] of [[5199, ''], [5200, 'short']]) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-bootstrap-'));
    const server = launch(port, path.join(tmp, 'prod.db'), { PMO_ADMIN_PASSWORD: password });
    cleanup(t, server, tmp);
    let output = '';
    server.stderr.on('data', (chunk) => { output += chunk.toString(); });
    server.stdout.on('data', (chunk) => { output += chunk.toString(); });
    const exited = await Promise.race([
      new Promise((resolve) => server.once('exit', (code) => resolve(code))),
      new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    assert.notEqual(exited, null, '服务不应在缺少安全管理员口令时保持运行');
    assert.notEqual(exited, 0);
    assert.match(output, /PMO_ADMIN_PASSWORD/);
    const failure = output.split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).find((line) => line.event === 'startup' && line.status === 'failed');
    assert.equal(failure.level, 'error');
  }
});

test('生产治理：绝对数据库路径、探针、请求日志和优雅停机', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-bootstrap-'));
  const dbFile = path.join(tmp, 'relative.db');
  const server = launch(5201, path.relative(ROOT, dbFile), {
    PMO_ADMIN_USERNAME: 'owner',
    PMO_ADMIN_PASSWORD: 'a-strong-bootstrap-password',
  });
  cleanup(t, server, tmp);
  let output = '';
  const readOutput = () => output;
  server.stderr.on('data', (chunk) => { output += chunk.toString(); });
  server.stdout.on('data', (chunk) => { output += chunk.toString(); });

  const health = await waitForHealth(5201);
  const requestId = health.headers.get('x-request-id');
  assert.match(requestId || '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.demoMode, false);
  assert.equal('db' in healthBody, false, '存活探针不得泄露数据库路径');

  const ready = await fetch('http://127.0.0.1:5201/api/ready?token=do-not-log');
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ok: true, schemaVersion: 21 });
  const requestLogs = await waitForOutput(readOutput, (lines) => lines.some((line) =>
    line.event === 'request' && line.requestId === requestId && line.path === '/api/health'));
  const startup = requestLogs.find((line) => line.event === 'startup');
  assert.equal(startup.dbPath, dbFile, '相对 PMO_DB 应规范化为绝对路径');
  const requestLog = requestLogs.find((line) => line.event === 'request' && line.requestId === requestId);
  assert.equal(requestLog.method, 'GET');
  assert.equal(requestLog.status, 200);
  assert.equal(typeof requestLog.durationMs, 'number');
  assert.equal(output.includes('do-not-log'), false, '请求日志不得记录查询参数');

  const external = new DatabaseSync(dbFile);
  external.exec('PRAGMA user_version = 999;');
  external.close();
  const notReady = await fetch('http://127.0.0.1:5201/api/ready');
  assert.equal(notReady.status, 503);
  assert.equal((await notReady.json()).ok, false);

  server.kill('SIGTERM');
  assert.deepEqual(await waitForExit(server), { code: 0, signal: null });
  const shutdownLogs = await waitForOutput(readOutput, (lines) => lines.some((line) =>
    line.event === 'shutdown' && line.status === 'complete'));
  assert.equal(shutdownLogs.some((line) => line.event === 'shutdown' && line.status === 'start'), true);
});
