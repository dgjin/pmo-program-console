'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 5197;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-test-'));
const DB = path.join(TMP, 'test.db');

let server;

async function waitForHealth(tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务未在预期时间内启动');
}

async function req(method, p, { body, cookie, headers: extraHeaders = {} } = {}) {
  const headers = { ...extraHeaders };
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

async function login(username, password) {
  const r = await req('POST', '/api/auth/login', { body: { username, password } });
  const raw = r.headers.get('set-cookie') || '';
  return { status: r.status, cookie: raw.split(';')[0], user: r.json?.user };
}

function mondayShift(weeks) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + weeks * 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let pmo;
let pm;
let projectId;
let gateId;
let reportId;

before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PMO_PORT: String(PORT), PMO_DB: DB, PMO_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await waitForHealth();
});

after(async () => {
  if (server) server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 250));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('健康检查与安全响应头', async () => {
  const r = await req('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(r.headers.get('referrer-policy'), 'same-origin');
});

test('未登录接口返回 401', async () => {
  const r = await req('GET', '/api/bootstrap');
  assert.equal(r.status, 401);
});

test('登录：错误密码失败，正确密码返回会话', async () => {
  const bad = await login('pmo', 'wrong-password');
  assert.equal(bad.status, 401);
  pmo = await login('pmo', 'pmo123456');
  assert.equal(pmo.status, 200);
  assert.ok(pmo.cookie.startsWith('pmo_sid='));
  assert.equal(pmo.user.role, 'pmo');
  pm = await login('zhangwei', 'pm123456');
  assert.equal(pm.user.role, 'pm');
});

test('bootstrap 返回角色、待办与治理关口', async () => {
  const r = await req('GET', '/api/bootstrap', { cookie: pmo.cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.me.name, '宋岩');
  assert.ok(r.json.workflow.pendingReviews >= 1);
  assert.ok(Array.isArray(r.json.gates));
  assert.ok(r.json.gates.length >= 20);
  assert.ok(r.json.stats.pendingGates >= 10);
});

test('项目：PM 不能新建，PMO 可以，日期倒置被拒', async () => {
  const denied = await req('POST', '/api/projects', {
    cookie: pm.cookie,
    body: { code: 'P-T1', name: '测试项目' },
  });
  assert.equal(denied.status, 400);

  const badDates = await req('POST', '/api/projects', {
    cookie: pmo.cookie,
    body: { code: 'P-T1', name: '日期校验', plan_start: '2027-02-01', plan_end: '2027-01-01' },
  });
  assert.equal(badDates.status, 400);
  assert.match(badDates.json.error, /结束日期/);

  const ok = await req('POST', '/api/projects', {
    cookie: pmo.cookie,
    body: {
      code: 'P-T1', name: '测试项目', pm: '张伟', stage: '执行中', priority: 'P2',
      plan_start: mondayShift(0), plan_end: '2027-06-30', budget: 100, spent: 10, team_size: 3,
    },
  });
  assert.equal(ok.status, 201);
  projectId = ok.json.id;
});

test('填报：PM 只能维护自己的项目', async () => {
  const other = await req('POST', '/api/deliverables', {
    cookie: pm.cookie,
    body: {
      kind: 'weekly', project_id: 7, period: mondayShift(1),
      content: { progress: 10, summary: '越权' },
    },
  });
  assert.equal(other.status, 400);
  assert.match(other.json.error, /权限/);

  const own = await req('POST', '/api/deliverables', {
    cookie: pm.cookie,
    body: {
      kind: 'weekly', project_id: 1, period: mondayShift(1),
      content: { progress: 55, summary: '完成灰度扩容', achievements: '30% 流量稳定', next: '压测', issues: '', support: '' },
    },
  });
  assert.equal(own.status, 201);
  reportId = own.json.item.id;
});

test('审核：提交后 PM 不能改，PMO 通过并同步进度', async () => {
  const submit = await req('POST', `/api/deliverables/weekly/${reportId}/submit`, { cookie: pm.cookie });
  assert.equal(submit.status, 200);
  assert.equal(submit.json.item.status, 'submitted');

  const edit = await req('PATCH', `/api/deliverables/weekly/${reportId}`, {
    cookie: pm.cookie,
    body: { content: { summary: '提交后修改' } },
  });
  assert.equal(edit.status, 400);

  const pmReview = await req('POST', `/api/deliverables/weekly/${reportId}/review`, {
    cookie: pm.cookie,
    body: { decision: 'approve' },
  });
  assert.equal(pmReview.status, 400);

  const approve = await req('POST', `/api/deliverables/weekly/${reportId}/review`, {
    cookie: pmo.cookie,
    body: { decision: 'approve', comment: '同意' },
  });
  assert.equal(approve.status, 200);
  assert.equal(approve.json.item.status, 'approved');
  assert.equal(approve.json.item.reviewer_name, '宋岩');

  const projects = await req('GET', '/api/projects', { cookie: pmo.cookie });
  const plan = await req('GET', '/api/projects/1/plan', { cookie: pmo.cookie });
  assert.equal(projects.json.find((p) => p.id === 1).progress, plan.json.summary.progress);
});

test('填报列表包含审核时效字段', async () => {
  const r = await req('GET', `/api/deliverables?kind=weekly&period=${mondayShift(0)}`, { cookie: pmo.cookie });
  assert.equal(r.status, 200);
  const submitted = r.json.projects.filter((p) => p.item && p.item.status === 'submitted');
  assert.ok(submitted.length >= 1);
  for (const row of submitted) {
    assert.equal(typeof row.item.reviewAgeHours, 'number');
    assert.equal(typeof row.item.slaOverdue, 'boolean');
  }
  assert.equal(typeof r.json.stats.slaOverdue, 'number');
});

test('编辑器：按项目读取填报数据，版本与截止时间齐全；越权被拒', async () => {
  const denied = await req('GET', `/api/deliverables/weekly/by-project/7?period=${mondayShift(0)}`, { cookie: pm.cookie });
  assert.equal(denied.status, 400);

  const own = await req('GET', `/api/deliverables/weekly/by-project/1?period=${mondayShift(0)}`, { cookie: pm.cookie });
  assert.equal(own.status, 200);
  assert.equal(own.json.project.id, 1);
  assert.match(own.json.dueAt, /T23:59:00$/);
  assert.ok(Array.isArray(own.json.versions));
  assert.ok(Array.isArray(own.json.comments));
});

test('工作流：退回后修改重提生成第二版，评论进入沟通记录', async () => {
  const period = mondayShift(2);
  const created = await req('POST', '/api/deliverables', {
    cookie: pm.cookie,
    body: { kind: 'weekly', project_id: 1, period, content: { progress: 60, summary: '初版提交' } },
  });
  assert.equal(created.status, 201);
  const id = created.json.item.id;

  await req('POST', `/api/deliverables/weekly/${id}/submit`, { cookie: pm.cookie });
  const rejected = await req('POST', `/api/deliverables/weekly/${id}/review`, {
    cookie: pmo.cookie,
    body: { decision: 'reject', comment: '请补充具体时间点' },
  });
  assert.equal(rejected.json.item.status, 'rejected');

  const patched = await req('PATCH', `/api/deliverables/weekly/${id}`, {
    cookie: pm.cookie,
    body: { content: { progress: 62, summary: '已补充 11 月 20 日的时间点' } },
  });
  assert.equal(patched.json.item.status, 'draft');

  const resubmitted = await req('POST', `/api/deliverables/weekly/${id}/submit`, { cookie: pm.cookie });
  assert.equal(resubmitted.json.item.status, 'submitted');

  const detail = await req('GET', `/api/deliverables/weekly/${id}`, { cookie: pm.cookie });
  assert.equal(detail.json.versions.length, 2);
  assert.equal(detail.json.versions[0].version, 2);
  assert.ok(detail.json.comments.some((c) => c.role === 'pmo' && c.body.includes('时间点')));

  const comment = await req('POST', `/api/deliverables/weekly/${id}/comments`, {
    cookie: pm.cookie,
    body: { body: '已按意见补充，请复核。' },
  });
  assert.equal(comment.status, 201);
  assert.ok(comment.json.comments.some((c) => c.body.includes('请复核')));
});

test('PMP 过程：章程、变更控制、经验教训与过程矩阵', async () => {
  const matrix = await req('GET', '/api/process-matrix', { cookie: pm.cookie });
  assert.equal(matrix.status, 200);
  assert.ok(matrix.json.projects.length >= 9);
  assert.equal(matrix.json.projects[0].groups.length, 5);
  assert.ok(matrix.json.summary.avgOverall > 0);

  const saved = await req('POST', '/api/projects/1/charter', {
    cookie: pmo.cookie,
    body: { content: { purpose: '测试章程目的', objectives: '测试目标', scope: '测试范围', keyStakeholders: '张伟' } },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.charter.status, 'draft');

  const submitted = await req('POST', '/api/projects/1/charter/submit', { cookie: pmo.cookie, body: {} });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.json.charter.status, 'submitted');

  const denied = await req('POST', '/api/projects/1/charter/review', {
    cookie: pm.cookie,
    body: { decision: 'approve' },
  });
  assert.equal(denied.status, 400);

  const approved = await req('POST', '/api/projects/1/charter/review', {
    cookie: pmo.cookie,
    body: { decision: 'approve', comment: '同意' },
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.charter.status, 'approved');

  const cr = await req('POST', '/api/projects/1/changes', {
    cookie: pm.cookie,
    body: { title: '测试变更', cr_type: '范围', description: '测试', cost_impact: 1, schedule_impact: 2 },
  });
  assert.equal(cr.status, 201);

  const crDenied = await req('PATCH', `/api/changes/${cr.json.id}`, {
    cookie: pm.cookie,
    body: { status: '已批准' },
  });
  assert.equal(crDenied.status, 400);

  const crApproved = await req('PATCH', `/api/changes/${cr.json.id}`, {
    cookie: pmo.cookie,
    body: { status: '已批准', decision: '同意' },
  });
  assert.equal(crApproved.status, 200);

  const lesson = await req('POST', '/api/projects/1/lessons', {
    cookie: pm.cookie,
    body: { category: '质量', title: '测试经验', context: '测试', lesson: '测试', recommendation: '测试' },
  });
  assert.equal(lesson.status, 201);

  const ws = await req('GET', '/api/projects/1/workspace', { cookie: pm.cookie });
  assert.equal(ws.json.charter.status, 'approved');
  assert.ok(ws.json.changes.some((c) => c.title === '测试变更'));
  assert.ok(ws.json.lessons.some((l) => l.title === '测试经验'));
  assert.equal(ws.json.process.groups.length, 5);
  assert.ok(ws.json.process.evm.spi > 0);
});

test('项目工作台：按项目返回周报、计划、关口与依赖', async () => {
  const r = await req('GET', '/api/projects/1/workspace', { cookie: pm.cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.project.id, 1);
  assert.ok(Array.isArray(r.json.reports));
  assert.ok(r.json.reports.length >= 1);
  assert.equal(typeof r.json.reports[0].version_count, 'number');
  assert.ok(r.json.plans.length >= 1);
  assert.ok(r.json.gates.length >= 3);
  assert.ok(r.json.dependencies.length >= 1);
  assert.match(r.json.due.weekly, /T23:59:00$/);
  assert.match(r.json.due.plan, /T18:00:00$/);

  const missing = await req('GET', '/api/projects/99999/workspace', { cookie: pm.cookie });
  assert.equal(missing.status, 404);
});

test('周期截止：遗漏的计划按截止时间标记逾期', async () => {
  const me = await req('GET', '/api/me', { cookie: pmo.cookie });
  const quarter = me.json.workflow.quarter;
  const list = await req('GET', `/api/deliverables?kind=plan&period=${quarter}`, { cookie: pmo.cookie });
  assert.equal(list.status, 200);
  const missing = list.json.projects.filter((p) => !p.item);
  assert.ok(missing.length >= 5);
  assert.equal(list.json.stats.overdueSubmission, missing.length);
  assert.equal(missing[0].submissionOverdue, true);
  assert.match(missing[0].dueAt, /T18:00:00$/);
});

test('阶段关口：PM 只读，PMO 评审且结论必填', async () => {
  const denied = await req('POST', '/api/gates', {
    cookie: pm.cookie,
    body: { project_id: 1, name: '越权关口', planned_date: mondayShift(1) },
  });
  assert.equal(denied.status, 400);

  const noDecision = await req('POST', '/api/gates', {
    cookie: pmo.cookie,
    body: { project_id: 1, name: '测试关口', planned_date: mondayShift(1), status: '已通过', decision: '' },
  });
  assert.equal(noDecision.status, 400);

  const created = await req('POST', '/api/gates', {
    cookie: pmo.cookie,
    body: { project_id: 1, name: '测试关口', planned_date: mondayShift(1), status: '待评审' },
  });
  assert.equal(created.status, 201);
  gateId = created.json.id;

  const createdChecks = await req('GET', `/api/gates/${gateId}/checks`, { cookie: pmo.cookie });
  assert.equal(createdChecks.json.checks.length, 3);
  for (const c of createdChecks.json.checks) {
    const r = await req('PATCH', `/api/gates/checks/${c.id}`, {
      cookie: pmo.cookie,
      body: { status: '已完成' },
    });
    assert.equal(r.status, 200);
  }

  const reviewed = await req('PATCH', `/api/gates/${gateId}`, {
    cookie: pmo.cookie,
    body: { status: '有条件通过', decision: '同意，须补齐压测报告', conditions: '两周内补齐' },
  });
  assert.equal(reviewed.status, 200);

  const list = await req('GET', '/api/gates', { cookie: pmo.cookie });
  const gate = list.json.gates.find((g) => g.id === gateId);
  assert.equal(gate.status, '有条件通过');
  assert.ok(gate.actual_date);
  assert.equal(gate.reviewer, '宋岩');
});

test('报表：周报包含已审核项目摘要', async () => {
  const r = await req('GET', '/api/report', { cookie: pmo.cookie });
  assert.equal(r.status, 200);
  const section = r.json.sections.find((s) => s.heading.includes('项目进展摘要'));
  assert.ok(section);
  assert.ok(section.bullets.length >= 1);
  assert.ok(section.bullets.every((b) => /（已审核|待审核）：/.test(b)));
  assert.ok(r.json.coverage.approved >= 1);
});

test('报表：项目群计划只取已通过的计划', async () => {
  const r = await req('GET', '/api/program-plan?period=2026-Q4', { cookie: pmo.cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.sections.length, 6);
  assert.ok(r.json.coverage.approved >= 1);
  assert.match(r.json.markdown, /工作计划/);
});

test('跨项目依赖：PM 只读，PMO 维护，导出包含依赖', async () => {
  const list = await req('GET', '/api/dependencies', { cookie: pmo.cookie });
  assert.equal(list.status, 200);
  assert.ok(list.json.dependencies.length >= 5);
  assert.ok(list.json.dependencies[0].from.code);
  assert.ok(list.json.dependencies[0].to.code);

  const denied = await req('POST', '/api/dependencies', {
    cookie: pm.cookie,
    body: { from_project_id: 1, to_project_id: 2, title: '越权依赖' },
  });
  assert.equal(denied.status, 400);

  const same = await req('POST', '/api/dependencies', {
    cookie: pmo.cookie,
    body: { from_project_id: 1, to_project_id: 1, title: '自己依赖自己' },
  });
  assert.equal(same.status, 400);

  const created = await req('POST', '/api/dependencies', {
    cookie: pmo.cookie,
    body: { from_project_id: 1, to_project_id: 2, title: '测试依赖', status: '受阻', due_date: mondayShift(1) },
  });
  assert.equal(created.status, 201);

  const patched = await req('PATCH', `/api/dependencies/${created.json.id}`, {
    cookie: pmo.cookie,
    body: { status: '已解除' },
  });
  assert.equal(patched.status, 200);

  const removed = await req('DELETE', `/api/dependencies/${created.json.id}`, { cookie: pmo.cookie });
  assert.equal(removed.status, 200);
});

test('备份：导出包含治理数据，导入后数量一致', async () => {
  const dump = await req('GET', '/api/export', { cookie: pmo.cookie });
  assert.equal(dump.status, 200);
  assert.ok(Array.isArray(dump.json.gates));
  assert.ok(dump.json.gates.length >= 20);
  assert.ok(Array.isArray(dump.json.dependencies));
  assert.ok(dump.json.dependencies.length >= 5);
  assert.ok(Array.isArray(dump.json.charters));
  assert.ok(dump.json.charters.length >= 7);
  assert.ok(Array.isArray(dump.json.changeRequests));
  assert.ok(Array.isArray(dump.json.lessons));
  assert.ok(Array.isArray(dump.json.planTasks));
  assert.ok(dump.json.planTasks.length >= 50);
  assert.ok(Array.isArray(dump.json.taskDeps));
  assert.ok(Array.isArray(dump.json.benefits));
  assert.ok(dump.json.benefits.length >= 5);
  assert.ok(Array.isArray(dump.json.actions));
  assert.ok(dump.json.actions.length >= 5);
  assert.ok(Array.isArray(dump.json.acceptances));
  assert.ok(Array.isArray(dump.json.vendors));
  assert.ok(dump.json.vendors.length >= 5);
  assert.ok(Array.isArray(dump.json.templates));
  assert.ok(dump.json.templates.length >= 5);
  assert.ok(Array.isArray(dump.json.calendarDays));
  assert.ok(dump.json.calendarDays.length >= 10);
  assert.ok(Array.isArray(dump.json.gateChecks));
  assert.ok(dump.json.gateChecks.length >= 30);
  assert.ok(Array.isArray(dump.json.weeklyReports));

  const imported = await req('POST', '/api/import', { cookie: pmo.cookie, body: dump.json });
  assert.equal(imported.status, 200);
  const after = await req('GET', '/api/gates', { cookie: pmo.cookie });
  assert.equal(after.json.gates.length, dump.json.gates.length);
});

test('账号：PMO 新建账号并授权，停用后立即失效', async () => {
  const created = await req('POST', '/api/admin/users', {
    cookie: pmo.cookie,
    body: { username: 'testpm', name: '测试经理', role: 'pm', password: 'test123456', project_ids: [7, 8] },
  });
  assert.equal(created.status, 201);

  const session = await login('testpm', 'test123456');
  const me = await req('GET', '/api/me', { cookie: session.cookie });
  assert.deepEqual(me.json.user.projects.sort((a, b) => a - b), [7, 8]);

  const off = await req('PATCH', `/api/admin/users/${created.json.id}`, {
    cookie: pmo.cookie,
    body: { active: false },
  });
  assert.equal(off.status, 200);
  const expired = await req('GET', '/api/me', { cookie: session.cookie });
  assert.equal(expired.status, 401);
});

test('密码：错误旧密码被拒，修改后可登录并恢复', async () => {
  const wrong = await req('POST', '/api/auth/password', {
    cookie: pmo.cookie,
    body: { current: 'bad-password', next: 'newpass123' },
  });
  assert.equal(wrong.status, 400);

  const changed = await req('POST', '/api/auth/password', {
    cookie: pmo.cookie,
    body: { current: 'pmo123456', next: 'newpass123' },
  });
  assert.equal(changed.status, 200);
  const newCookie = (changed.headers.get('set-cookie') || '').split(';')[0];

  const relogin = await login('pmo', 'newpass123');
  assert.equal(relogin.status, 200);

  const restore = await req('POST', '/api/auth/password', {
    cookie: newCookie,
    body: { current: 'newpass123', next: 'pmo123456' },
  });
  assert.equal(restore.status, 200);
});

test('静态资源：CSP 生效，路径穿越不可读源码', async () => {
  const page = await req('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') || '', /default-src 'self'/);
  const traversal = await req('GET', '/../server.js');
  assert.equal(traversal.status, 404);
});


test('整体计划：任务、前置排期、缩进、基线与权限', async () => {
  const admin = await login('pmo', 'pmo123456');
  assert.equal(admin.status, 200);
  const plan0 = await req('GET', '/api/projects/1/plan', { cookie: admin.cookie });
  assert.equal(plan0.status, 200);
  assert.ok(plan0.json.tasks.length >= 10);
  const firstLeaf = plan0.json.tasks.find((t) => !t.isSummary && t.kind === 'task');
  assert.ok(firstLeaf);

  const created = await req('POST', '/api/projects/1/plan/tasks', {
    cookie: admin.cookie,
    body: { name: '测试计划任务A', duration: 2, start_date: '2026-08-10' },
  });
  assert.equal(created.status, 201);
  const taskA = created.json.tasks.find((t) => t.name === '测试计划任务A');
  assert.ok(taskA);

  const withDep = await req('PATCH', `/api/plan/tasks/${taskA.id}`, {
    cookie: admin.cookie,
    body: { predecessor_ids: [firstLeaf.id] },
  });
  assert.equal(withDep.status, 200);
  const depTask = withDep.json.tasks.find((t) => t.id === taskA.id);
  assert.ok(depTask.start_date > firstLeaf.end_date);
  assert.notEqual(depTask.start_date, '2026-08-10');

  const indented = await req('POST', `/api/plan/tasks/${taskA.id}/indent`, { cookie: admin.cookie });
  assert.equal(indented.status, 200);
  assert.equal(indented.json.tasks.find((t) => t.id === taskA.id).level, 1);
  const outdented = await req('POST', `/api/plan/tasks/${taskA.id}/outdent`, { cookie: admin.cookie });
  assert.equal(outdented.status, 200);
  assert.equal(outdented.json.tasks.find((t) => t.id === taskA.id).level, 0);

  const createdB = await req('POST', '/api/projects/1/plan/tasks', {
    cookie: admin.cookie,
    body: { name: '测试计划任务B', duration: 2, start_date: '2026-08-12' },
  });
  const taskB = createdB.json.tasks.find((t) => t.name === '测试计划任务B');
  const cycleA = await req('PATCH', `/api/plan/tasks/${taskA.id}`, {
    cookie: admin.cookie,
    body: { predecessor_ids: [taskB.id] },
  });
  assert.equal(cycleA.status, 200);
  const cycleB = await req('PATCH', `/api/plan/tasks/${taskB.id}`, {
    cookie: admin.cookie,
    body: { predecessor_ids: [taskA.id] },
  });
  assert.equal(cycleB.status, 400);
  assert.match(cycleB.json.error, /循环/);

  const baseline = await req('POST', '/api/projects/1/plan/baseline', { cookie: admin.cookie });
  assert.equal(baseline.status, 200);
  assert.ok(baseline.json.summary.baselineAt);

  const removed = await req('DELETE', `/api/plan/tasks/${taskA.id}`, { cookie: admin.cookie });
  assert.equal(removed.status, 200);
  const removedB = await req('DELETE', `/api/plan/tasks/${taskB.id}`, { cookie: admin.cookie });
  assert.equal(removedB.status, 200);

  const client = await login('hejing', 'pm123456');
  const denied = await req('POST', '/api/projects/1/plan/tasks', {
    cookie: client.cookie,
    body: { name: '甲方不能建任务' },
  });
  assert.equal(denied.status, 400);
});

test('账号维护：重置密码、强制下线、删除保护', async () => {
  const admin = await login('pmo', 'pmo123456');
  assert.equal(admin.status, 200);

  const created = await req('POST', '/api/admin/users', {
    cookie: admin.cookie,
    body: { username: 'maintuser', name: '维护测试', role: 'pm', party: '乙方', password: 'oldpass123', project_ids: [] },
  });
  assert.equal(created.status, 201);
  const uid = created.json.id;

  const session = await login('maintuser', 'oldpass123');
  assert.equal(session.status, 200);
  const me = await req('GET', '/api/me', { cookie: session.cookie });
  assert.equal(me.status, 200);

  const users = await req('GET', '/api/admin/users', { cookie: admin.cookie });
  const row = users.json.users.find((u) => u.id === uid);
  assert.ok(row);
  assert.equal(row.sessions >= 1, true);
  assert.ok(row.last_login_at);

  const reset = await req('POST', `/api/admin/users/${uid}/reset-password`, {
    cookie: admin.cookie,
    body: { password: 'newpass123' },
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.password, 'newpass123');

  const oldSession = await req('GET', '/api/me', { cookie: session.cookie });
  assert.equal(oldSession.status, 401);
  const oldLogin = await login('maintuser', 'oldpass123');
  assert.equal(oldLogin.status, 401);
  const newLogin = await login('maintuser', 'newpass123');
  assert.equal(newLogin.status, 200);

  const logout = await req('POST', `/api/admin/users/${uid}/logout`, { cookie: admin.cookie });
  assert.equal(logout.status, 200);
  assert.ok(logout.json.count >= 1);
  const kicked = await req('GET', '/api/me', { cookie: newLogin.cookie });
  assert.equal(kicked.status, 401);

  const project = await req('POST', '/api/projects', {
    cookie: admin.cookie,
    body: { code: 'MAINT-01', name: '维护测试项目', vendor_pm_id: uid },
  });
  assert.equal(project.status, 201);
  const blocked = await req('DELETE', `/api/admin/users/${uid}`, { cookie: admin.cookie });
  assert.equal(blocked.status, 400);
  assert.match(blocked.json.error, /项目经理/);

  const unassign = await req('PATCH', `/api/projects/${project.json.id}`, {
    cookie: admin.cookie,
    body: { vendor_pm_id: '' },
  });
  assert.equal(unassign.status, 200);
  const removed = await req('DELETE', `/api/admin/users/${uid}`, { cookie: admin.cookie });
  assert.equal(removed.status, 200);

  const selfDelete = await req('DELETE', `/api/admin/users/${admin.user.id}`, { cookie: admin.cookie });
  assert.equal(selfDelete.status, 400);
});

test('双项目经理：甲方只读，乙方维护，PMO 指定归属', async () => {
  const admin = await login('pmo', 'pmo123456');
  assert.equal(admin.status, 200);
  const client = await login('hejing', 'pm123456');
  assert.equal(client.status, 200);
  assert.equal(client.user.party, '甲方');
  assert.deepEqual(client.user.clientProjects, [1]);
  assert.deepEqual(client.user.vendorProjects, []);
  assert.equal(client.user.roleLabel, '甲方项目经理');

  const vendorId = pmo.user.id;
  const meVendor = await req('GET', '/api/me', { cookie: pm.cookie });
  assert.equal(meVendor.json.user.party, '乙方');
  assert.deepEqual(meVendor.json.user.vendorProjects, [1]);

  const clientView = await req('GET', '/api/deliverables/weekly/by-project/1', { cookie: client.cookie });
  assert.equal(clientView.status, 200);
  assert.equal(clientView.json.canEdit, false);

  const nextWeek = mondayShift(5);
  const vendorView = await req('GET', `/api/deliverables/weekly/by-project/1?period=${nextWeek}`, { cookie: pm.cookie });
  assert.equal(vendorView.status, 200);
  assert.equal(vendorView.json.canEdit, true);

  const clientNext = await req('GET', `/api/deliverables/weekly/by-project/1?period=${nextWeek}`, { cookie: client.cookie });
  assert.equal(clientNext.status, 200);
  assert.equal(clientNext.json.canEdit, false);

  const item = clientView.json.item;
  assert.ok(item && item.id);
  const comment = await req('POST', `/api/deliverables/weekly/${item.id}/comments`, {
    cookie: client.cookie,
    body: { body: '甲方确认收到，请补充验收口径。' },
  });
  assert.equal(comment.status, 201);

  const week = (await req('GET', '/api/me', { cookie: client.cookie })).json.workflow.week;
  const clientSave = await req('POST', '/api/deliverables', {
    cookie: client.cookie,
    body: { kind: 'weekly', project_id: 1, period: week, content: { summary: '越权修改' } },
  });
  assert.equal(clientSave.status, 400);

  const createdUser = await req('POST', '/api/admin/users', {
    cookie: admin.cookie,
    body: { username: 'clientpmtest', name: '甲方测试', role: 'pm', party: '甲方', password: 'test123456', project_ids: [] },
  });
  assert.equal(createdUser.status, 201);
  const users = await req('GET', '/api/admin/users', { cookie: admin.cookie });
  assert.equal(users.json.users.find((u) => u.username === 'clientpmtest').party, '甲方');

  const created = await req('POST', '/api/projects', {
    cookie: admin.cookie,
    body: {
      code: 'DUAL-01', name: '双 PM 测试项目',
      vendor_pm_id: meVendor.json.user.id, client_pm_id: client.user.id,
    },
  });
  assert.equal(created.status, 201);

  const vendorEdit = await req('PATCH', `/api/projects/${created.json.id}`, {
    cookie: pm.cookie,
    body: { name: '双 PM 测试项目（乙方改名）' },
  });
  assert.equal(vendorEdit.status, 200);
  const afterVendor = await req('GET', `/api/projects/${created.json.id}`, { cookie: pm.cookie });
  assert.equal(afterVendor.json.project.name, '双 PM 测试项目（乙方改名）');

  const clientEdit = await req('PATCH', `/api/projects/${created.json.id}`, {
    cookie: client.cookie,
    body: { name: '甲方尝试改名' },
  });
  assert.equal(clientEdit.status, 400);

  const vendorChangePm = await req('PATCH', `/api/projects/${created.json.id}`, {
    cookie: pm.cookie,
    body: { client_pm_id: '' },
  });
  assert.equal(vendorChangePm.status, 400);
});

test('P0 数据同源：项目进度来自任务、EVM 用基线、周报带计划', async () => {
  const admin = await login('pmo', 'pmo123456');
  assert.equal(admin.status, 200);

  const plan1 = await req('GET', '/api/projects/1/plan', { cookie: admin.cookie });
  assert.equal(plan1.status, 200);
  const stamp = plan1.json.tasks[0].updated_at;
  await new Promise((r) => setTimeout(r, 20));
  const plan2 = await req('GET', '/api/projects/1/plan', { cookie: admin.cookie });
  assert.equal(plan2.json.tasks[0].updated_at, stamp, 'GET 计划不应写库');

  const detail = await req('GET', '/api/projects/1', { cookie: admin.cookie });
  assert.equal(detail.json.project.progress, plan2.json.summary.progress);
  assert.equal(detail.json.project.hasPlan, true);

  const leaf = plan2.json.tasks.find((t) => !t.isSummary && t.kind === 'task');
  const original = leaf.progress;
  const changed = await req('PATCH', `/api/plan/tasks/${leaf.id}`, {
    cookie: admin.cookie,
    body: { progress: original === 40 ? 60 : 40 },
  });
  assert.equal(changed.status, 200);
  const after = await req('GET', '/api/projects/1', { cookie: admin.cookie });
  assert.equal(after.json.project.progress, changed.json.summary.progress);
  assert.notEqual(after.json.project.progress, detail.json.project.progress);
  await req('PATCH', `/api/plan/tasks/${leaf.id}`, { cookie: admin.cookie, body: { progress: original } });

  const workspace = await req('GET', '/api/projects/1/workspace', { cookie: admin.cookie });
  assert.equal(workspace.json.process.evm.pvBasis, 'baseline');
  assert.equal(typeof workspace.json.process.evm.plannedPct, 'number');

  const byProject = await req('GET', '/api/deliverables/weekly/by-project/1', { cookie: admin.cookie });
  assert.equal(byProject.status, 200);
  assert.equal(byProject.json.planContext.hasPlan, true);
  assert.equal(byProject.json.planContext.locked, true);
  assert.equal(byProject.json.planContext.projectProgress, detail.json.project.progress);

  const p5 = await req('GET', '/api/deliverables/weekly/by-project/5', { cookie: admin.cookie });
  assert.equal(p5.status, 200);
  assert.equal(p5.json.canEdit, true);
  const p5Project = await req('GET', '/api/projects/5', { cookie: admin.cookie });
  const forced = await req('PATCH', `/api/deliverables/weekly/${p5.json.item.id}`, {
    cookie: admin.cookie,
    body: { content: { progress: 1, summary: '测试计划进度锁定' } },
  });
  assert.equal(forced.status, 200);
  assert.equal(forced.json.item.content.progress, p5Project.json.project.progress);

  const secureLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ username: 'pmo', password: 'pmo123456' }),
  });
  const setCookie = secureLogin.headers.get('set-cookie') || '';
  assert.match(setCookie, /Secure/);
  assert.match(secureLogin.headers.get('strict-transport-security') || '', /max-age/);

  const csv = await req('GET', '/api/admin/audit.csv', { cookie: admin.cookie });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type') || '', /text\/csv/);
  assert.match(String(csv.json), /操作人/);

  const client = await login('hejing', 'pm123456');
  const denied = await req('GET', '/api/admin/audit.csv', { cookie: client.cookie });
  assert.equal(denied.status, 400);
});

test('收益与行动项：CRUD、完成状态与甲方权限', async () => {
  const admin = await login('pmo', 'pmo123456');
  assert.equal(admin.status, 200);
  const ws = await req('GET', '/api/projects/1/workspace', { cookie: admin.cookie });
  assert.ok(ws.json.benefits.length >= 2);
  assert.ok(ws.json.actions.length >= 1);

  const client = await login('hejing', 'pm123456');
  const denied = await req('POST', '/api/projects/1/benefits', {
    cookie: client.cookie,
    body: { name: '甲方不能登记' },
  });
  assert.equal(denied.status, 400);

  const benefit = await req('POST', '/api/projects/1/benefits', {
    cookie: admin.cookie,
    body: { name: '测试收益', baseline_value: 0, target_value: 10, current_value: 5, unit: '个', owner: '张伟' },
  });
  assert.equal(benefit.status, 201);
  const benefit2 = await req('PATCH', `/api/benefits/${benefit.json.id}`, {
    cookie: admin.cookie,
    body: { current_value: 10, status: '已达成' },
  });
  assert.equal(benefit2.status, 200);

  const action = await req('POST', '/api/projects/1/actions', {
    cookie: admin.cookie,
    body: { title: '测试行动', owner: '张伟', priority: '高', due_date: '2026-11-10' },
  });
  assert.equal(action.status, 201);
  const done = await req('PATCH', `/api/actions/${action.json.id}`, {
    cookie: admin.cookie,
    body: { status: '已完成' },
  });
  assert.equal(done.status, 200);
  const after = await req('GET', '/api/projects/1/workspace', { cookie: admin.cookie });
  const doneAction = after.json.actions.find((a) => a.id === action.json.id);
  assert.equal(doneAction.status, '已完成');
  assert.ok(doneAction.completed_at);

  const removedBenefit = await req('DELETE', `/api/benefits/${benefit.json.id}`, { cookie: admin.cookie });
  assert.equal(removedBenefit.status, 200);
  const removedAction = await req('DELETE', `/api/actions/${action.json.id}`, { cookie: admin.cookie });
  assert.equal(removedAction.status, 200);
});

test('甲方验收与变更后基线更新', async () => {
  const admin = await login('pmo', 'pmo123456');
  const client = await login('hejing', 'pm123456');
  const vendor = await login('zhangwei', 'pm123456');
  assert.equal(admin.status, 200);

  const plan = await req('GET', '/api/deliverables/plan/by-project/1', { cookie: admin.cookie });
  assert.equal(plan.status, 200);
  assert.equal(plan.json.item.status, 'approved');
  const accepted = await req('POST', '/api/projects/1/acceptances', {
    cookie: client.cookie,
    body: { scope: 'deliverable', ref_type: 'plan', ref_id: plan.json.item.id, conclusion: '通过', notes: '同意按此计划执行' },
  });
  assert.equal(accepted.status, 201);
  const duplicate = await req('POST', '/api/projects/1/acceptances', {
    cookie: client.cookie,
    body: { scope: 'deliverable', ref_type: 'plan', ref_id: plan.json.item.id, conclusion: '通过' },
  });
  assert.equal(duplicate.status, 400);
  const vendorDenied = await req('POST', '/api/projects/1/acceptances', {
    cookie: vendor.cookie,
    body: { scope: 'project', conclusion: '通过' },
  });
  assert.equal(vendorDenied.status, 400);
  const projectAccept = await req('POST', '/api/projects/1/acceptances', {
    cookie: client.cookie,
    body: { scope: 'project', conclusion: '有条件通过', notes: '待补齐两项材料' },
  });
  assert.equal(projectAccept.status, 201);
  const ws = await req('GET', '/api/projects/1/workspace', { cookie: admin.cookie });
  assert.ok(ws.json.acceptances.length >= 2);

  const p7 = await req('GET', '/api/projects/7/workspace', { cookie: admin.cookie });
  const pending = p7.json.changes.find((c) => c.status === '待审批');
  assert.ok(pending);
  const before = await req('GET', '/api/projects/7/plan', { cookie: admin.cookie });
  assert.ok(before.json.tasks.length > 0);
  const approved = await req('PATCH', `/api/changes/${pending.id}`, {
    cookie: admin.cookie,
    body: { status: '已批准', decision: '同意，按当前计划重设基线', rebaseline: true },
  });
  assert.equal(approved.status, 200);
  const after = await req('GET', '/api/projects/7/plan', { cookie: admin.cookie });
  assert.equal(after.json.summary.baselineAt, new Date().toISOString().slice(0, 10));
  for (const t of after.json.tasks) {
    if (t.start_date) assert.equal(t.baseline_start, t.start_date);
  }
});

test('关口检查清单：必检项未完成不能通过', async () => {
  const admin = await login('pmo', 'pmo123456');
  assert.equal(admin.status, 200);
  const gates = await req('GET', '/api/gates', { cookie: admin.cookie });
  const gate = gates.json.gates.find((g) => g.status === '待评审');
  assert.ok(gate);
  assert.ok(gate.checkTotal >= 3, '关口应带默认检查项');

  const checks = await req('GET', `/api/gates/${gate.id}/checks`, { cookie: admin.cookie });
  assert.equal(checks.status, 200);
  assert.equal(checks.json.checks.length, gate.checkTotal);

  const blocked = await req('PATCH', `/api/gates/${gate.id}`, {
    cookie: admin.cookie,
    body: { status: '已通过', decision: '材料已齐' },
  });
  assert.equal(blocked.status, 400);

  const client = await login('hejing', 'pm123456');
  const denied = await req('PATCH', `/api/gates/checks/${checks.json.checks[0].id}`, {
    cookie: client.cookie,
    body: { status: '已完成' },
  });
  assert.equal(denied.status, 400);

  for (const c of checks.json.checks) {
    const r = await req('PATCH', `/api/gates/checks/${c.id}`, {
      cookie: admin.cookie,
      body: { status: '已完成' },
    });
    assert.equal(r.status, 200);
  }
  const passed = await req('PATCH', `/api/gates/${gate.id}`, {
    cookie: admin.cookie,
    body: { status: '已通过', decision: '检查项已完成，同意通过' },
  });
  assert.equal(passed.status, 200);
});

test('乙方供应商：主数据、账号挂接与项目成员选择', async () => {
  const admin = await login('pmo', 'pmo123456');
  const client = await login('hejing', 'pm123456');
  assert.equal(admin.status, 200);

  const seeded = await req('GET', '/api/vendors', { cookie: admin.cookie });
  assert.equal(seeded.status, 200);
  assert.ok(seeded.json.vendors.length >= 5);

  const denied = await req('POST', '/api/vendors', {
    cookie: client.cookie,
    body: { code: 'V-99', name: '甲方不能建供应商' },
  });
  assert.equal(denied.status, 400);

  const created = await req('POST', '/api/vendors', {
    cookie: admin.cookie,
    body: { code: 'V-99', name: '测试供应商', contact: '测试联系人', phone: '13900000000', status: '合作中' },
  });
  assert.equal(created.status, 201);
  const vendorId = created.json.id;

  const changed = await req('PATCH', `/api/vendors/${vendorId}`, {
    cookie: admin.cookie,
    body: { name: '测试供应商（更名）', status: '暂停合作' },
  });
  assert.equal(changed.status, 200);

  const user = await req('POST', '/api/admin/users', {
    cookie: admin.cookie,
    body: { username: 'vendoruser', name: '供应商成员', role: 'pm', party: '乙方', password: 'vendor123456', vendor_id: vendorId, project_ids: [1] },
  });
  assert.equal(user.status, 201);
  const users = await req('GET', '/api/admin/users', { cookie: admin.cookie });
  const createdUser = users.json.users.find((u) => u.id === user.json.id);
  assert.equal(createdUser.vendor_id, vendorId);
  assert.equal(createdUser.vendor_name, '测试供应商（更名）');

  const alloc = await req('POST', '/api/allocations', {
    cookie: admin.cookie,
    body: { project_id: 1, person: '供应商成员', role: '实施', pct: 40, vendor_id: vendorId },
  });
  assert.equal(alloc.status, 201);
  const ws = await req('GET', '/api/projects/1/workspace', { cookie: admin.cookie });
  const a = ws.json.allocations.find((x) => x.id === alloc.json.id);
  assert.equal(a.vendor_id, vendorId);
  assert.equal(a.vendor_name, '测试供应商（更名）');

  const blocked = await req('DELETE', `/api/vendors/${vendorId}`, { cookie: admin.cookie });
  assert.equal(blocked.status, 400);
  await req('DELETE', `/api/allocations/${alloc.json.id}`, { cookie: admin.cookie });
  await req('DELETE', `/api/admin/users/${user.json.id}`, { cookie: admin.cookie });
  const removed = await req('DELETE', `/api/vendors/${vendorId}`, { cookie: admin.cookie });
  assert.equal(removed.status, 200);
});

test('模板库与 Markdown 周报', async () => {
  const admin = await login('pmo', 'pmo123456');
  assert.equal(admin.status, 200);
  const seeded = await req('GET', '/api/templates?category=weekly', { cookie: admin.cookie });
  assert.equal(seeded.status, 200);
  assert.ok(seeded.json.templates.length >= 1);
  assert.equal(seeded.json.templates[0].is_default, 1);

  const created = await req('POST', '/api/templates', {
    cookie: admin.cookie,
    body: { code: 'TPL-TEST', name: '测试周报模板', category: 'weekly', content_md: '# 测试\n\n- 一\n- 二', is_default: true, active: true },
  });
  assert.equal(created.status, 201);
  const after = await req('GET', '/api/templates?category=weekly', { cookie: admin.cookie });
  const testTpl = after.json.templates.find((t) => t.id === created.json.id);
  assert.equal(testTpl.is_default, 1);
  assert.equal(after.json.templates.filter((t) => t.is_default).length, 1);

  const updated = await req('PATCH', `/api/templates/${created.json.id}`, {
    cookie: admin.cookie,
    body: { content_md: '# 测试（更新）' },
  });
  assert.equal(updated.status, 200);

  const blocked = await req('DELETE', `/api/templates/${created.json.id}`, { cookie: admin.cookie });
  assert.equal(blocked.status, 400);
  await req('PATCH', `/api/templates/${created.json.id}`, { cookie: admin.cookie, body: { is_default: false } });
  const removed = await req('DELETE', `/api/templates/${created.json.id}`, { cookie: admin.cookie });
  assert.equal(removed.status, 200);

  const p5 = await req('GET', '/api/deliverables/weekly/by-project/5', { cookie: admin.cookie });
  assert.ok(p5.json.template?.content_md);
  const saved = await req('PATCH', `/api/deliverables/weekly/${p5.json.item.id}`, {
    cookie: admin.cookie,
    body: { content: { progress: 1, summary: '测试 Markdown', markdown: '# 周报\n\n## 进展\n- 完成 A\n- 完成 B' } },
  });
  assert.equal(saved.status, 200);
  assert.match(saved.json.item.content.markdown, /完成 A/);
});

test('工作日历：节假日与调休会影响排期', async () => {
  const admin = await login('pmo', 'pmo123456');
  assert.equal(admin.status, 200);
  const beforeCal = await req('GET', '/api/calendar', { cookie: admin.cookie });
  assert.ok(beforeCal.json.days.length >= 10);
  const beforePlan = await req('GET', '/api/projects/1/plan', { cookie: admin.cookie });
  const beforeEnd = beforePlan.json.summary.end;

  const added = await req('POST', '/api/calendar', {
    cookie: admin.cookie,
    body: { date: '2026-11-04', name: '测试假日', kind: 'holiday' },
  });
  assert.equal(added.status, 200);
  const afterPlan = await req('GET', '/api/projects/1/plan', { cookie: admin.cookie });
  assert.ok(afterPlan.json.summary.end >= beforeEnd, '加入假日后计划结束不应提前');
  assert.notEqual(afterPlan.json.summary.end, beforeEnd);

  const removed = await req('DELETE', '/api/calendar/2026-11-04', { cookie: admin.cookie });
  assert.equal(removed.status, 200);
  const restored = await req('GET', '/api/projects/1/plan', { cookie: admin.cookie });
  assert.equal(restored.json.summary.end, beforeEnd);
});

test('任务实际起止与供应商挂接', async () => {
  const admin = await login('pmo', 'pmo123456');
  const vendors = await req('GET', '/api/vendors', { cookie: admin.cookie });
  const vendorId = vendors.json.vendors[0].id;
  const plan = await req('GET', '/api/projects/1/plan', { cookie: admin.cookie });
  const task = plan.json.tasks.find((t) => !t.isSummary && t.kind === 'task');
  const updated = await req('PATCH', `/api/plan/tasks/${task.id}`, {
    cookie: admin.cookie,
    body: { actual_start: '2026-11-01', actual_end: '2026-11-03', vendor_id: vendorId },
  });
  assert.equal(updated.status, 200);
  const after = await req('GET', '/api/projects/1/plan', { cookie: admin.cookie });
  const t = after.json.tasks.find((x) => x.id === task.id);
  assert.equal(t.actual_start, '2026-11-01');
  assert.equal(t.actual_end, '2026-11-03');
  assert.equal(t.vendor_id, vendorId);
  assert.ok(t.vendor_name);
  await req('PATCH', `/api/plan/tasks/${task.id}`, {
    cookie: admin.cookie,
    body: { actual_start: null, actual_end: null, vendor_id: null },
  });
});

test('组合优先级：PMO 评分与排序', async () => {
  const admin = await login('pmo', 'pmo123456');
  const client = await login('hejing', 'pm123456');
  const projects = await req('GET', '/api/projects', { cookie: admin.cookie });
  const p1 = projects.json.find((p) => p.id === 1);
  assert.ok(p1.score);
  assert.equal(typeof p1.scoreRank, 'number');

  const denied = await req('PATCH', '/api/projects/1/score', {
    cookie: client.cookie,
    body: { strategic: 5, benefit: 5, feasibility: 5, risk: 1, effort: 1 },
  });
  assert.equal(denied.status, 400);

  const updated = await req('PATCH', '/api/projects/1/score', {
    cookie: admin.cookie,
    body: { strategic: 5, benefit: 5, feasibility: 5, risk: 1, effort: 1, notes: '测试评分' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.score, 100);
  const after = await req('GET', '/api/projects', { cookie: admin.cookie });
  const top = after.json.find((p) => p.id === 1);
  assert.equal(top.score.score, 100);
  assert.equal(top.scoreRank, 1);
});

test('指标周快照：趋势数据与手动记录', async () => {
  const admin = await login('pmo', 'pmo123456');
  const client = await login('hejing', 'pm123456');
  const list = await req('GET', '/api/snapshots', { cookie: admin.cookie });
  assert.equal(list.status, 200);
  assert.ok(list.json.snapshots.length >= 6);
  const latest = list.json.snapshots[list.json.snapshots.length - 1];
  assert.equal(typeof latest.progress, 'number');
  assert.equal(typeof latest.healthAvg, 'number');

  const denied = await req('POST', '/api/admin/snapshot', { cookie: client.cookie });
  assert.equal(denied.status, 400);
  const saved = await req('POST', '/api/admin/snapshot', { cookie: admin.cookie });
  assert.equal(saved.status, 201);
  const after = await req('GET', '/api/snapshots', { cookie: admin.cookie });
  const current = after.json.snapshots[after.json.snapshots.length - 1];
  assert.equal(current.source, 'live');
});

test('资源需求：未来 6 个月 FTE 与产能对比', async () => {
  const admin = await login('pmo', 'pmo123456');
  const r = await req('GET', '/api/resources', { cookie: admin.cookie });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.capacity.months));
  assert.equal(r.json.capacity.months.length, 6);
  assert.equal(r.json.capacity.capacity, 100);
  assert.ok(Array.isArray(r.json.capacity.people));
  assert.ok(r.json.capacity.people.length >= 1);
  const p = r.json.capacity.people[0];
  assert.equal(typeof p.peak, 'number');
  assert.equal(typeof p.over, 'number');
  for (const m of r.json.capacity.months) assert.equal(typeof p.months[m.key], 'number');
});

test('计划 CSV：Excel 兼容导出与追加/替换导入', async () => {
  const admin = await login('pmo', 'pmo123456');
  const client = await login('hejing', 'pm123456');
  const exp = await req('GET', '/api/projects/1/plan/export.csv', { cookie: admin.cookie });
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-type') || '', /text\/csv/);
  assert.match(String(exp.json), /wbs,parent_wbs,name/);
  assert.match(String(exp.json), /阶段A|需求与现状梳理/);

  const denied = await req('POST', '/api/projects/1/plan/import', {
    cookie: client.cookie,
    body: { csv: 'name\n客户端不能导入\n', mode: 'append' },
  });
  assert.equal(denied.status, 400);

  const before = await req('GET', '/api/projects/1/plan', { cookie: admin.cookie });
  const appendCsv = 'wbs,parent_wbs,name,kind,duration,start_date,progress,owner,vendor_code,actual_start,actual_end,predecessors,notes\n'
    + 'T1,,导入追加任务,任务,3,2026-11-10,0,张伟,,,,,测试\n';
  const appended = await req('POST', '/api/projects/1/plan/import', {
    cookie: admin.cookie,
    body: { csv: appendCsv, mode: 'append' },
  });
  assert.equal(appended.status, 200);
  assert.equal(appended.json.tasks.length, before.json.tasks.length + 1);
  assert.ok(appended.json.tasks.some((t) => t.name === '导入追加任务'));

  const replaceCsv = 'wbs,parent_wbs,name,kind,duration,start_date,progress,owner,vendor_code,actual_start,actual_end,predecessors,notes\n'
    + '1,,阶段A,任务,1,2026-11-10,0,张伟,,,,,\n'
    + '1.1,1,任务A,任务,3,2026-11-10,0,张伟,,,,,\n'
    + '1.2,1,任务B,任务,2,2026-11-13,0,张伟,,,,1.1,\n';
  const replaced = await req('POST', '/api/projects/1/plan/import', {
    cookie: admin.cookie,
    body: { csv: replaceCsv, mode: 'replace' },
  });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.json.tasks.filter((t) => !t.isSummary).length, 2);
  assert.equal(replaced.json.tasks.some((t) => t.name === '需求与现状梳理'), false);
});

test('MS Project XML：导出与常用子集导入', async () => {
  const admin = await login('pmo', 'pmo123456');
  const client = await login('hejing', 'pm123456');
  const exp = await req('GET', '/api/projects/1/plan/export.xml', { cookie: admin.cookie });
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-type') || '', /xml/);
  assert.match(String(exp.json), /<Project/);
  assert.match(String(exp.json), /阶段A|需求与现状梳理/);

  const denied = await req('POST', '/api/projects/1/plan/import.xml', {
    cookie: client.cookie,
    body: { xml: '<Project><Tasks></Tasks></Project>', mode: 'replace' },
  });
  assert.equal(denied.status, 400);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Project xmlns="http://schemas.microsoft.com/project"><Tasks>
<Task><UID>1</UID><Name>阶段A</Name><OutlineLevel>1</OutlineLevel><Start>2026-11-10T08:00:00</Start><Duration>PT8H0M0S</Duration><Milestone>0</Milestone><PercentComplete>0</PercentComplete></Task>
<Task><UID>2</UID><Name>任务B</Name><OutlineLevel>2</OutlineLevel><Start>2026-11-10T08:00:00</Start><Duration>PT24H0M0S</Duration><Milestone>0</Milestone><PercentComplete>0</PercentComplete><PredecessorLink><PredecessorUID>1</PredecessorUID></PredecessorLink></Task>
<Task><UID>3</UID><Name>任务C</Name><OutlineLevel>2</OutlineLevel><Start>2026-11-13T08:00:00</Start><Duration>PT16H0M0S</Duration><Milestone>0</Milestone><PercentComplete>0</PercentComplete><PredecessorLink><PredecessorUID>2</PredecessorUID></PredecessorLink></Task>
</Tasks></Project>`;
  const imported = await req('POST', '/api/projects/1/plan/import.xml', {
    cookie: admin.cookie,
    body: { xml, mode: 'replace' },
  });
  assert.equal(imported.status, 200);
  const leaves = imported.json.tasks.filter((t) => !t.isSummary);
  assert.equal(leaves.length, 2);
  assert.ok(leaves.some((t) => t.name === '任务B'));
  assert.ok(leaves.some((t) => t.name === '任务C'));
  assert.equal(imported.json.tasks.some((t) => t.name === '需求与现状梳理'), false);
});

test('多项目群：维护、项目归属与筛选', async () => {
  const admin = await login('pmo', 'pmo123456');
  const before = await req('GET', '/api/programs', { cookie: admin.cookie });
  assert.equal(before.status, 200);
  assert.ok(before.json.programs.length >= 1);

  const created = await req('POST', '/api/programs', {
    cookie: admin.cookie,
    body: { code: 'PGM-TEST', name: '测试项目群', owner: '宋岩', objective: '验证多项目群' },
  });
  assert.equal(created.status, 201);
  const programId = created.json.id;

  const renamed = await req('PATCH', `/api/programs/${programId}`, {
    cookie: admin.cookie,
    body: { name: '测试项目群（更名）' },
  });
  assert.equal(renamed.status, 200);

  const project = await req('POST', '/api/projects', {
    cookie: admin.cookie,
    body: { program_id: programId, code: 'P-TEST', name: '测试群项目', plan_start: '2026-11-03', plan_end: '2027-02-01' },
  });
  assert.equal(project.status, 201);

  const scoped = await req('GET', '/api/bootstrap', {
    cookie: admin.cookie,
    headers: { 'X-PMO-Program': String(programId) },
  });
  assert.equal(scoped.status, 200);
  assert.equal(scoped.json.currentProgramId, programId);
  assert.equal(scoped.json.program.id, programId);
  assert.equal(scoped.json.projects.length, 1);
  assert.equal(scoped.json.projects[0].code, 'P-TEST');

  const list = await req('GET', '/api/projects', {
    cookie: admin.cookie,
    headers: { 'X-PMO-Program': String(programId) },
  });
  assert.equal(list.json.length, 1);

  const blocked = await req('DELETE', `/api/programs/${programId}`, { cookie: admin.cookie });
  assert.equal(blocked.status, 400);
});

test('项目知识库：自动索引、检索、笔记与 AI 引用', async () => {
  const admin = await login('pmo', 'pmo123456');
  const client = await login('hejing', 'pm123456');

  const kb = await req('GET', '/api/projects/1/kb?limit=300', { cookie: admin.cookie });
  assert.equal(kb.status, 200);
  assert.ok(kb.json.total >= 15);
  assert.ok(kb.json.counts.plan_task >= 1);
  assert.ok(kb.json.counts.weekly >= 1);
  assert.ok(kb.json.counts.milestone >= 1);
  assert.ok(kb.json.entries.some((e) => e.kind === 'gate' && e.content.includes('检查项')));

  const search = await req('GET', '/api/projects/1/kb?q=周报', { cookie: admin.cookie });
  assert.ok(search.json.entries.some((e) => e.kind === 'weekly'));

  const clientRead = await req('GET', '/api/projects/1/kb', { cookie: client.cookie });
  assert.equal(clientRead.status, 200);
  const denied = await req('POST', '/api/projects/1/kb/notes', {
    cookie: client.cookie,
    body: { title: '甲方笔记', content_md: '只读' },
  });
  assert.equal(denied.status, 400);

  const note = await req('POST', '/api/projects/1/kb/notes', {
    cookie: admin.cookie,
    body: { title: '切换注意事项', category: '实施', content_md: '# 切换\n\n先停批处理，再切流量。' },
  });
  assert.equal(note.status, 201);
  const withNote = await req('GET', '/api/projects/1/kb?q=切换注意事项', { cookie: admin.cookie });
  assert.ok(withNote.json.entries.some((e) => e.kind === 'note' && e.editable));

  const updated = await req('PATCH', `/api/projects/1/kb/notes/${note.json.id}`, {
    cookie: admin.cookie,
    body: { content_md: '更新后的切换步骤。' },
  });
  assert.equal(updated.status, 200);

  const ai = await req('POST', '/api/projects/1/ai', {
    cookie: admin.cookie,
    body: { mode: 'ask', question: '切换注意事项是什么？' },
  });
  assert.equal(ai.status, 200);
  assert.ok(ai.json.sources.length >= 1);
  assert.ok(ai.json.sources.some((s) => s.kind === 'note'));

  const removed = await req('DELETE', `/api/projects/1/kb/notes/${note.json.id}`, { cookie: admin.cookie });
  assert.equal(removed.status, 200);
});

test('项目 AI 行动清单：按现状生成待办并支持行动建议', async () => {
  const admin = await login('pmo', 'pmo123456');
  const brief = await req('GET', '/api/projects/1/ai/brief', { cookie: admin.cookie });
  assert.equal(brief.status, 200);
  assert.ok(brief.json.items.length >= 1);
  assert.ok(brief.json.counts.total >= 1);
  assert.ok(brief.json.items.some((x) => ['P0', 'P1', 'P2'].includes(x.priority)));
  assert.ok(brief.json.items.every((x) => x.tab && x.category && x.title));

  const pm = await login('zhangwei', 'pm123456');
  const pmBrief = await req('GET', '/api/projects/1/ai/brief', { cookie: pm.cookie });
  assert.equal(pmBrief.status, 200);
  assert.ok(pmBrief.json.items.every((x) => x.audience.includes('项目经理') || x.audience.includes('双方')));
  const client = await login('hejing', 'pm123456');
  const clientBrief = await req('GET', '/api/projects/1/ai/brief', { cookie: client.cookie });
  assert.equal(clientBrief.status, 200);
  assert.ok(clientBrief.json.items.every((x) => x.audience.includes('甲方') || x.audience.includes('双方')));

  await new Promise((r) => setTimeout(r, 1600));
  const action = await req('POST', '/api/projects/1/ai', {
    cookie: admin.cookie,
    body: { mode: 'actions' },
  });
  assert.equal(action.status, 200);
  assert.equal(action.json.fallback, true);
  assert.match(action.json.answer, /当前要处理/);
  assert.match(action.json.answer, /今天先处理/);
});

test('帮助中心、知识库与项目 AI 降级', async () => {
  const admin = await login('pmo', 'pmo123456');
  const help = await req('GET', '/api/help', { cookie: admin.cookie });
  assert.equal(help.status, 200);
  assert.ok(help.json.articles.length >= 10);
  const search = await req('GET', '/api/help?q=周报', { cookie: admin.cookie });
  assert.equal(search.status, 200);
  assert.ok(search.json.articles.some((a) => a.slug === 'weekly-report'));

  const flow = await req('GET', '/api/help?q=完整操作流程', { cookie: admin.cookie });
  assert.ok(flow.json.articles.some((a) => a.slug === 'project-full-flow'));
  const flowHtml = await req('GET', '/help/project-workflow.html');
  assert.equal(flowHtml.status, 200);
  assert.match(String(flowHtml.json), /PMO/);

  const ask = await req('POST', '/api/help/ask', {
    cookie: admin.cookie,
    body: { question: '周报被退回了怎么改？' },
  });
  assert.equal(ask.status, 200);
  assert.equal(ask.json.fallback, true);
  assert.ok(ask.json.answer.length > 20);
  assert.ok(ask.json.sources.length >= 1);

  const aiConfig = await req('GET', '/api/ai/config', { cookie: admin.cookie });
  assert.equal(aiConfig.status, 200);
  assert.equal(aiConfig.json.enabled, false);
  await new Promise((r) => setTimeout(r, 1600));
  const answer = await req('POST', '/api/projects/1/ai', {
    cookie: admin.cookie,
    body: { mode: 'summary' },
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.json.fallback, true);
  assert.match(answer.json.answer, /核心业务中台重构/);

  const article = await req('POST', '/api/admin/help', {
    cookie: admin.cookie,
    body: { slug: 'test-article', title: '测试文章', category: '测试', summary: '测试摘要', content_md: '# 测试\n\n正文' },
  });
  assert.equal(article.status, 201);
  const published = await req('GET', '/api/help?q=测试文章', { cookie: admin.cookie });
  assert.ok(published.json.articles.some((a) => a.slug === 'test-article'));
  const patched = await req('PATCH', `/api/admin/help/${article.json.id}`, {
    cookie: admin.cookie,
    body: { title: '测试文章（更新）', published: false },
  });
  assert.equal(patched.status, 200);
  const hidden = await req('GET', '/api/help?q=测试文章', { cookie: admin.cookie });
  assert.ok(!hidden.json.articles.some((a) => a.slug === 'test-article'));
  const removed = await req('DELETE', `/api/admin/help/${article.json.id}`, { cookie: admin.cookie });
  assert.equal(removed.status, 200);
});

test('管理员前端配置 AI：加密保存、不回显、可清除', async () => {
  const admin = await login('pmo', 'pmo123456');
  const client = await login('hejing', 'pm123456');
  const initial = await req('GET', '/api/admin/ai', { cookie: admin.cookie });
  assert.equal(initial.status, 200);
  assert.equal(initial.json.hasKey, false);

  const denied = await req('PUT', '/api/admin/ai', {
    cookie: client.cookie,
    body: { base_url: 'http://127.0.0.1:9/v1', model: 'x' },
  });
  assert.equal(denied.status, 400);

  const saved = await req('PUT', '/api/admin/ai', {
    cookie: admin.cookie,
    body: { base_url: 'http://127.0.0.1:9/v1', model: 'test-model', api_key: 'test-secret-key' },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.hasKey, true);
  assert.equal(saved.json.model, 'test-model');
  assert.equal(JSON.stringify(saved.json).includes('test-secret-key'), false);

  const pub = await req('GET', '/api/ai/config', { cookie: admin.cookie });
  assert.equal(pub.json.enabled, true);
  assert.equal(pub.json.baseUrl, '');
  assert.equal(JSON.stringify(pub.json).includes('test-secret-key'), false);

  const cleared = await req('PUT', '/api/admin/ai', {
    cookie: admin.cookie,
    body: { base_url: '', model: 'gpt-4o-mini', clear_key: true },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.hasKey, false);
  assert.equal(cleared.json.enabled, false);

  const noBase = await req('POST', '/api/admin/ai/test', { cookie: admin.cookie, body: { base_url: '' } });
  assert.equal(noBase.status, 400);
});

test('全局 AI：跨项目范围、单项目收窄与权限', async () => {
  const admin = await login('pmo', 'pmo123456');
  const client = await login('hejing', 'pm123456');

  const all = await req('POST', '/api/ai/assistant', {
    cookie: admin.cookie,
    body: { mode: 'portfolio' },
  });
  assert.equal(all.status, 200);
  assert.equal(all.json.fallback, true);
  assert.equal(all.json.scope.project_count >= 5, true);
  assert.ok(all.json.sources.length >= 1);
  assert.match(all.json.answer, /项目/);

  await new Promise((r) => setTimeout(r, 1600));
  const one = await req('POST', '/api/ai/assistant', {
    cookie: admin.cookie,
    body: { mode: 'portfolio', project_id: 1 },
  });
  assert.equal(one.status, 200);
  assert.equal(one.json.scope.project_code, 'P-01');
  assert.equal(one.json.scope.project_count, 1);

  await new Promise((r) => setTimeout(r, 1600));
  const clientAll = await req('POST', '/api/ai/assistant', {
    cookie: client.cookie,
    body: { mode: 'portfolio' },
  });
  assert.equal(clientAll.status, 200);
  assert.ok(clientAll.json.scope.project_count >= 1);
  const allowedProjects = new Set(client.user.projects);
  assert.ok(clientAll.json.sources.every((s) => allowedProjects.has(s.project_id)));

  const forbidden = await req('POST', '/api/ai/assistant', {
    cookie: client.cookie,
    body: { mode: 'portfolio', project_id: 3 },
  });
  assert.equal(forbidden.status, 400);
});

test('周报纯 Markdown：字段自动提取，空标题不能提交', async () => {
  const admin = await login('pmo', 'pmo123456');
  const markdown = `# 周报\n\n## 本周进展\n\n完成核心接口联调，成功率 99.9%。\n\n## 关键成果\n\n- 完成接口联调\n\n## 下周计划\n\n- 开始灰度\n\n## 风险与问题\n\n- 数据口径未冻结\n\n## 需协调事项\n\n- 请 PMO 协调数据组`;
  const created = await req('POST', '/api/deliverables', {
    cookie: admin.cookie,
    body: { kind: 'weekly', project_id: 5, period: '2026-12-07', content: { markdown } },
  });
  assert.equal(created.status, 201);
  assert.match(created.json.item.content.summary, /核心接口联调/);
  assert.equal(created.json.item.content.support, '请 PMO 协调数据组');
  assert.equal(created.json.item.content.issues, '数据口径未冻结');
  const submitted = await req('POST', `/api/deliverables/weekly/${created.json.item.id}/submit`, { cookie: admin.cookie });
  assert.equal(submitted.status, 200);

  const empty = await req('POST', '/api/deliverables', {
    cookie: admin.cookie,
    body: { kind: 'weekly', project_id: 5, period: '2026-12-14', content: { markdown: '# 标题\n\n## 本周进展' } },
  });
  assert.equal(empty.status, 201);
  const blocked = await req('POST', `/api/deliverables/weekly/${empty.json.item.id}/submit`, { cookie: admin.cookie });
  assert.equal(blocked.status, 400);
});

test('会议室：预订冲突、审批、日历可见性与房间维护', async () => {
  const admin = await login('pmo', 'pmo123456');
  const pm = await login('zhangwei', 'pm123456');

  const rooms = await req('GET', '/api/meeting-rooms', { cookie: pm.cookie });
  assert.equal(rooms.status, 200);
  assert.ok(rooms.json.rooms.length >= 3);
  const roomId = rooms.json.rooms[0].id;

  const booked = await req('POST', '/api/meeting-bookings', {
    cookie: pm.cookie,
    body: { room_id: roomId, title: '测试评审会', project_id: 1, start_at: '2027-02-01T10:00', end_at: '2027-02-01T11:00', attendees: 6 },
  });
  assert.equal(booked.status, 201);
  assert.equal(booked.json.status, '待审批');

  const conflict = await req('POST', '/api/meeting-bookings', {
    cookie: pm.cookie,
    body: { room_id: roomId, title: '冲突会议', start_at: '2027-02-01T10:30', end_at: '2027-02-01T11:30', attendees: 2 },
  });
  assert.equal(conflict.status, 400);

  const denied = await req('POST', `/api/meeting-bookings/${booked.json.id}/approve`, { cookie: pm.cookie });
  assert.equal(denied.status, 400);
  const pending = await req('GET', '/api/meeting-bookings?from=2027-02-01&to=2027-02-01&scope=pending', { cookie: admin.cookie });
  assert.ok(pending.json.bookings.some((b) => b.id === booked.json.id));
  const approved = await req('POST', `/api/meeting-bookings/${booked.json.id}/approve`, {
    cookie: admin.cookie, body: { comment: '通过' },
  });
  assert.equal(approved.status, 200);
  const calendar = await req('GET', '/api/meeting-bookings?from=2027-02-01&to=2027-02-01', { cookie: pm.cookie });
  const row = calendar.json.bookings.find((b) => b.id === booked.json.id);
  assert.equal(row.status, '已批准');
  assert.equal(row.project_code, 'P-01');

  const newRoom = await req('POST', '/api/meeting-rooms', {
    cookie: admin.cookie,
    body: { code: 'MR-TEST', name: '测试会议室', location: '测试楼', capacity: 5, features: '白板' },
  });
  assert.equal(newRoom.status, 201);
  const patched = await req('PATCH', `/api/meeting-rooms/${newRoom.json.id}`, {
    cookie: admin.cookie, body: { name: '测试会议室（改）', status: '停用' },
  });
  assert.equal(patched.status, 200);
  const removed = await req('DELETE', `/api/meeting-rooms/${newRoom.json.id}`, { cookie: admin.cookie });
  assert.equal(removed.status, 200);

  const cancelled = await req('POST', `/api/meeting-bookings/${booked.json.id}/cancel`, {
    cookie: pm.cookie, body: { comment: '测试结束' },
  });
  assert.equal(cancelled.status, 200);
});

test('办公用品：分类库存、领用发放与权限', async () => {
  const admin = await login('pmo', 'pmo123456');
  const pm = await login('zhangwei', 'pm123456');

  const stock = await req('GET', '/api/supplies', { cookie: pm.cookie });
  assert.equal(stock.status, 200);
  assert.ok(stock.json.categories.length >= 3);
  const item = stock.json.items.find((x) => x.stock > 5);
  assert.ok(item);
  const before = item.stock;

  const requested = await req('POST', '/api/supply-requests', {
    cookie: pm.cookie,
    body: { item_id: item.id, quantity: 2, project_id: 1, purpose: '测试领用' },
  });
  assert.equal(requested.status, 201);
  assert.equal(requested.json.status, '待发放');

  const denied = await req('POST', `/api/supply-requests/${requested.json.id}/issue`, { cookie: pm.cookie });
  assert.equal(denied.status, 400);
  const pending = await req('GET', '/api/supply-requests?scope=pending', { cookie: admin.cookie });
  assert.ok(pending.json.requests.some((x) => x.id === requested.json.id));
  const issued = await req('POST', `/api/supply-requests/${requested.json.id}/issue`, {
    cookie: admin.cookie, body: { comment: '已发' },
  });
  assert.equal(issued.status, 200);
  const afterStock = await req('GET', '/api/supplies', { cookie: pm.cookie });
  assert.equal(afterStock.json.items.find((x) => x.id === item.id).stock, before - 2);

  const tooMany = await req('POST', '/api/supply-requests', {
    cookie: pm.cookie, body: { item_id: item.id, quantity: 9999 },
  });
  assert.equal(tooMany.status, 400);

  const category = await req('POST', '/api/supply-categories', {
    cookie: admin.cookie, body: { name: '测试分类', sort_order: 9 },
  });
  assert.equal(category.status, 201);
  const newItem = await req('POST', '/api/supply-items', {
    cookie: admin.cookie,
    body: { code: 'SUP-TEST', name: '测试物品', category_id: category.json.id, unit: '件', stock: 2, safety_stock: 1 },
  });
  assert.equal(newItem.status, 201);
  const blockedCategory = await req('DELETE', `/api/supply-categories/${category.json.id}`, { cookie: admin.cookie });
  assert.equal(blockedCategory.status, 400);
  const blockedItem = await req('DELETE', `/api/supply-items/${item.id}`, { cookie: admin.cookie });
  assert.equal(blockedItem.status, 400);
  const removedItem = await req('DELETE', `/api/supply-items/${newItem.json.id}`, { cookie: admin.cookie });
  assert.equal(removedItem.status, 200);
  const removedCategory = await req('DELETE', `/api/supply-categories/${category.json.id}`, { cookie: admin.cookie });
  assert.equal(removedCategory.status, 200);
});

test('审批角色：禁止自批，可配置独立审批员', async () => {
  const admin = await login('pmo', 'pmo123456');
  const room = (await req('GET', '/api/meeting-rooms', { cookie: admin.cookie })).json.rooms[0];

  const pmoBooking = await req('POST', '/api/meeting-bookings', {
    cookie: admin.cookie,
    body: { room_id: room.id, title: 'PMO 自测预订', start_at: '2027-04-05T10:00', end_at: '2027-04-05T11:00', attendees: 3 },
  });
  assert.equal(pmoBooking.status, 201);
  assert.equal(pmoBooking.json.status, '待审批');
  const selfApprove = await req('POST', `/api/meeting-bookings/${pmoBooking.json.id}/approve`, { cookie: admin.cookie });
  assert.equal(selfApprove.status, 400);

  const approverUser = await req('POST', '/api/admin/users', {
    cookie: admin.cookie,
    body: { username: 'approver1', name: '审批测试', role: 'approver', password: 'approve123', project_ids: [] },
  });
  assert.equal(approverUser.status, 201);
  const approver = await login('approver1', 'approve123');
  assert.equal(approver.status, 200);
  const settings = await req('PUT', '/api/admin/approval-settings', {
    cookie: admin.cookie,
    body: { meeting_role: 'approver', supply_role: 'approver' },
  });
  assert.equal(settings.status, 200);
  const meApprover = await req('GET', '/api/me', { cookie: approver.cookie });
  assert.equal(meApprover.json.user.canApprove.meeting, true);
  assert.equal(meApprover.json.user.canApprove.supply, true);
  const approved = await req('POST', `/api/meeting-bookings/${pmoBooking.json.id}/approve`, {
    cookie: approver.cookie, body: { comment: 'PMO 自测预订，由审批员处理' },
  });
  assert.equal(approved.status, 200);

  const supply = await req('POST', '/api/supply-requests', {
    cookie: admin.cookie, body: { item_id: 1, quantity: 1, purpose: 'PMO 自测领用' },
  });
  assert.equal(supply.status, 201);
  const selfIssue = await req('POST', `/api/supply-requests/${supply.json.id}/issue`, { cookie: admin.cookie });
  assert.equal(selfIssue.status, 400);
  const issued = await req('POST', `/api/supply-requests/${supply.json.id}/issue`, {
    cookie: approver.cookie, body: { comment: '审批员发放' },
  });
  assert.equal(issued.status, 200);
});

test('清空演示数据：只保留当前管理员和默认项目群', async () => {
  const fresh = await login('pmo', 'pmo123456');
  assert.equal(fresh.status, 200);
  const pmStillIn = await req('GET', '/api/me', { cookie: pm.cookie });
  assert.equal(pmStillIn.status, 200);

  const wrong = await req('POST', '/api/admin/clear-demo', { cookie: fresh.cookie, body: { confirm: 'no' } });
  assert.equal(wrong.status, 400);

  const pmTry = await req('POST', '/api/admin/clear-demo', { cookie: pm.cookie, body: { confirm: '清空' } });
  assert.equal(pmTry.status, 400);

  const cleared = await req('POST', '/api/admin/clear-demo', { cookie: fresh.cookie, body: { confirm: '清空' } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.keptUser.username, 'pmo');

  const boot = await req('GET', '/api/bootstrap', { cookie: fresh.cookie });
  assert.equal(boot.status, 200);
  assert.equal(boot.json.projects.length, 0);
  const planLeft = await req('GET', '/api/projects/1/plan', { cookie: fresh.cookie });
  assert.equal(planLeft.status, 404);
  assert.equal(boot.json.stats.total, 0);
  assert.equal(boot.json.program.code, 'PROGRAM');
  assert.equal(boot.json.program.name, '默认项目群');

  const users = await req('GET', '/api/admin/users', { cookie: fresh.cookie });
  assert.equal(users.status, 200);
  assert.equal(users.json.users.length, 1);
  assert.equal(users.json.users[0].username, 'pmo');

  const oldLogin = await req('POST', '/api/auth/login', { body: { username: 'zhangwei', password: 'pm123456' } });
  assert.equal(oldLogin.status, 401);

  const pmKicked = await req('GET', '/api/me', { cookie: pm.cookie });
  assert.equal(pmKicked.status, 401);
  const adminKept = await req('GET', '/api/me', { cookie: fresh.cookie });
  assert.equal(adminKept.status, 200);

  const created = await req('POST', '/api/projects', {
    cookie: fresh.cookie,
    body: { code: 'FIRST-01', name: '清空后的第一个项目' },
  });
  assert.equal(created.status, 201);

  const after = await req('GET', '/api/bootstrap', { cookie: fresh.cookie });
  assert.equal(after.json.projects.length, 1);
  assert.equal(after.json.projects[0].code, 'FIRST-01');
});
