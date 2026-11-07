import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'pmo-ui-'));
const PORT = 5391;
const DEBUG = 9333;
const BASE = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sleep = wait;

let server;
let chrome;
let ws;

async function waitFor(fn, timeout = 15000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch { /* retry */ }
    await wait(250);
  }
  throw new Error(`等待超时：${label}`);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PMO_PORT: String(PORT), PMO_HOST: '127.0.0.1', PMO_DB: path.join(TMP, 'pmo.db'), PMO_DEMO_MODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stderr.on('data', (d) => { log += d.toString(); });
  server.on('exit', (code) => {
    if (code && code !== 0) console.error(log.slice(-2000));
  });
}

function startChrome(bin) {
  chrome = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${path.join(TMP, 'chrome')}`,
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });
}

async function main() {
  const chromeBin = findChrome();
  if (!chromeBin) {
    if (process.env.SKIP_UI === '1') {
      console.log('UI smoke skipped: CHROME_BIN not found');
      return;
    }
    throw new Error('找不到 Chrome，请设置 CHROME_BIN，或设置 SKIP_UI=1 跳过');
  }

  startServer();
  await waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, 20000, 'server health');
  startChrome(chromeBin);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${DEBUG}/json/version`)).ok, 20000, 'chrome debug');

  const targets = await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的浏览器页面');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'page exception');
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text || 'evaluate failed');
    return r.result?.result?.value;
  };

  const auditPage = async (label) => {
    const violations = await ev(`(() => {
      const out = [];
      const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.textContent || '').trim();
      if (document.documentElement.lang !== 'zh-CN') out.push('html lang 不是 zh-CN');
      if (!document.querySelector('main')) out.push('缺少 main 地标');
      if (!document.querySelector('nav')) out.push('缺少 nav 地标');
      if (!document.querySelector('h1')) out.push('缺少 h1');
      for (const el of document.querySelectorAll('button')) {
        if (visible(el) && !name(el)) out.push('按钮没有可访问名称：' + el.outerHTML.slice(0, 80));
      }
      for (const el of document.querySelectorAll('a[href]')) {
        if (visible(el) && !name(el)) out.push('链接没有可访问名称：' + el.outerHTML.slice(0, 80));
      }
      for (const el of document.querySelectorAll('input:not([type="hidden"]), select, textarea')) {
        if (!visible(el)) continue;
        const id = el.id;
        const hasLabel = (id && document.querySelector('label[for="' + id.replace(/"/g, '') + '"]')) || el.closest('label') || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
        if (!hasLabel) out.push('表单控件没有标签：' + el.outerHTML.slice(0, 80));
      }
      for (const el of document.querySelectorAll('img')) {
        if (visible(el) && !el.hasAttribute('alt')) out.push('图片缺少 alt');
      }
      const seen = new Set();
      for (const el of document.querySelectorAll('[id]')) {
        if (seen.has(el.id)) out.push('重复 id：' + el.id);
        seen.add(el.id);
      }
      return out;
    })()`);
    if (violations.length) throw new Error(`${label} 可访问性问题：${violations.slice(0, 5).join(' | ')}`);
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/?smoke=1` });
  await wait(1200);
  if (await ev(`Boolean(document.querySelector('#login-form'))`)) {
    await ev(`(() => { const f = document.querySelector('#login-form'); f.username.value = 'pmo'; f.password.value = 'pmo123456'; f.requestSubmit(); return true; })()`);
    await wait(2200);
  }

  const navCount = await ev(`document.querySelectorAll('#rail-nav .nav-item').length`);
  if (navCount < 16) throw new Error(`导航项数量不对：${navCount}`);
  if (!(await ev(`Boolean(document.querySelector('#rail-toggle'))`))) throw new Error('没有侧栏收起按钮');
  if ((await ev(`document.querySelector('.rail').scrollHeight`)) > (await ev(`document.querySelector('.rail').clientHeight`)) + 1) throw new Error('侧栏出现上下滚动');
  if ((await ev(`Math.round(document.querySelectorAll('.nav-item')[document.querySelectorAll('.nav-item').length - 1].getBoundingClientRect().bottom)`)) > (await ev(`Math.round(document.querySelector('.rail').getBoundingClientRect().bottom)`))) throw new Error('侧栏最后一个菜单没有显示完整');
  if ((await ev(`getComputedStyle(document.querySelector('.nav-item .lbl')).fontSize`)) !== '14px') throw new Error('侧栏菜单字号不是 14px');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 800, deviceScaleFactor: 1, mobile: false });
  await wait(350);
  if ((await ev(`document.querySelector('.rail').scrollHeight`)) > (await ev(`document.querySelector('.rail').clientHeight`)) + 1) throw new Error('800px 高度下侧栏出现滚动');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 768, deviceScaleFactor: 1, mobile: false });
  await wait(350);
  if ((await ev(`document.querySelector('.rail').scrollHeight`)) > (await ev(`document.querySelector('.rail').clientHeight`)) + 1) throw new Error('768px 高度下侧栏出现滚动');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await wait(250);
  if ((await ev(`getComputedStyle(document.querySelector('.mark')).transform`)) !== 'none') throw new Error('侧栏 Logo 仍是 3D 透视');
  if ((await ev(`getComputedStyle(document.querySelector('.btn')).borderRadius`)) === '0px') throw new Error('按钮没有统一圆角');
  if ((await ev(`getComputedStyle(document.querySelector('.nav-item')).borderRadius`)) === '0px') throw new Error('导航没有统一圆角');
  await ev(`document.querySelector('#rail-toggle').click()`);
  await wait(400);
  if (!(await ev(`document.body.classList.contains('is-rail-collapsed')`))) throw new Error('侧栏没有收起');
  await ev(`document.querySelector('#rail-toggle').click()`);

  await send('Page.navigate', { url: `${BASE}/?smoke=2#/projects/1/plan` });
  await wait(1600);
  if (!(await ev(`Boolean(document.querySelector('.plan-toolbar'))`))) throw new Error('计划页没有渲染');
  if (!(await ev(`Boolean(document.querySelector('.plan-grid'))`))) throw new Error('计划表没有渲染');
  await auditPage('计划页');

  const escapedTask = await ev(`fetch('/api/projects/1/plan/tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PMO-Program': '1' },
    body: JSON.stringify({ name: '转义任务" data-smoke-escaped="yes', start_date: '2026-11-05', duration: 1 })
  }).then(async r => ({ ok: r.ok, body: await r.json() }))`);
  if (!escapedTask.ok) throw new Error(`无法建立属性转义测试任务：${JSON.stringify(escapedTask.body)}`);
  await send('Page.navigate', { url: `${BASE}/?smoke=2-escaped#/projects/1/plan` });
  await wait(1200);
  if (await ev(`Boolean(document.querySelector('[data-smoke-escaped]'))`)) throw new Error('任务名称把属性注入到了计划条');
  if (!(await ev(`[...document.querySelectorAll('.plan-bar, .plan-ms')].some(el => el.title.includes('转义任务" data-smoke-escaped="yes'))`))) throw new Error('转义后的任务提示没有保留原始名称');

  await send('Page.navigate', { url: `${BASE}/?smoke=3#/overview` });
  await wait(1400);
  if (!(await ev(`Boolean(document.querySelector('.score-list'))`))) throw new Error('总览组合优先级没有渲染');
  if (!(await ev(`Boolean(document.querySelector('.overview-ai'))`))) throw new Error('总览 AI 助手没有渲染');
  if ((await ev(`document.querySelectorAll('.overview-ai-item').length`)) < 1) throw new Error('总览 AI 没有聚合待办');
  if (!(await ev(`document.querySelector('.overview-ai-project')?.textContent.trim()`))) throw new Error('总览 AI 待办没有显示项目名称');
  await ev(`document.querySelector('[data-action="overview-ai-run"][data-mode="summary"]')?.click()`);
  await wait(900);
  if (!/项目摘要|核心业务|客户咨询/.test(await ev(`document.querySelector('#overview-ai-result')?.innerText || ''`))) throw new Error('总览 AI 摘要没有返回');
  await auditPage('总览');

  await send('Page.navigate', { url: `${BASE}/?smoke=4#/projects/1/value` });
  await wait(1400);
  if (!(await ev(`Boolean(document.querySelector('.pulse'))`))) throw new Error('项目收益与行动页没有渲染');
  await auditPage('项目收益页');

  await send('Page.navigate', { url: `${BASE}/?smoke=5#/projects/1/ai` });
  await wait(1500);
  if ((await ev(`document.querySelectorAll('.ai-brief-item').length`)) < 1) throw new Error('项目 AI 当前要处理没有渲染');
  if (!(await ev(`document.querySelector('.ai-brief-item')?.getAttribute('href') || ''`)).startsWith('#/projects/')) throw new Error('项目 AI 待办链接不对');
  await auditPage('项目 AI 助手页');
  await ev(`document.querySelector('[data-action="ai-run"][data-mode="actions"]')?.click()`);
  await wait(900);
  if (!/当前要处理|今天先处理/.test(await ev(`document.querySelector('#ai-result')?.innerText || ''`))) throw new Error('项目 AI 行动建议没有返回');

  await send('Page.navigate', { url: `${BASE}/?smoke=6#/projects/1/kb` });
  await wait(1200);
  if ((await ev(`document.querySelectorAll('.kb-entry').length`)) < 5) throw new Error('项目知识库没有渲染');
  await auditPage('项目知识库页');
  await ev(`(() => { const i=document.querySelector('#kb-search'); i.value='周报'; i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  await wait(800);
  if ((await ev(`document.querySelectorAll('.kb-entry').length`)) < 1) throw new Error('项目知识库实时搜索没有结果');
  if (!/找到/.test(await ev(`document.querySelector('.help-search-meta')?.innerText || ''`))) throw new Error('项目知识库搜索没有显示结果数');
  await ev(`(() => { const i=document.querySelector('#kb-search'); i.value='周报'; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true; })()`);
  await wait(700);
  if ((await ev(`document.querySelectorAll('.kb-entry').length`)) < 1) throw new Error('项目知识库 Enter 搜索没有结果');
  await ev(`document.querySelector('[data-action="kb-search-clear"]')?.click()`);
  await wait(600);
  if ((await ev(`document.querySelectorAll('.kb-entry').length`)) < 5) throw new Error('项目知识库清空搜索后没有恢复');

  await send('Page.navigate', { url: `${BASE}/?smoke=7#/write/weekly/1/2026-11-02` });
  await wait(1200);
  if (!(await ev(`Boolean(document.querySelector('.md-editor'))`))) throw new Error('周报 Markdown 编辑器没有渲染');
  if ((await ev(`document.querySelectorAll('.editor-main textarea[data-editor-field]').length`)) !== 1) throw new Error('周报编辑器出现了重复输入区');
  if ((await ev(`document.querySelectorAll('.md-tool').length`)) < 10) throw new Error('Markdown 工具栏不完整');
  await auditPage('周报 Markdown 编辑页');

  await send('Page.navigate', { url: `${BASE}/?smoke=7-save#/write/weekly/5/2026-11-02` });
  await wait(1200);
  if (!(await ev(`Boolean(document.querySelector('[data-action="editor-save"]'))`))) throw new Error('保存回归需要一份可编辑草稿');
  await ev(`(() => {
    window.__smokeOriginalFetch = window.fetch;
    window.__smokeCommentPosts = 0;
    window.fetch = (input, opts = {}) => {
      const url = String(input);
      if (opts.method === 'PATCH' && url.includes('/api/deliverables/')) {
        return Promise.resolve(new Response(JSON.stringify({ error: '模拟保存失败' }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
      }
      if (opts.method === 'POST' && url.includes('/comments')) window.__smokeCommentPosts += 1;
      return window.__smokeOriginalFetch(input, opts);
    };
    const ta = document.querySelector('#ef-markdown');
    ta.value += '\\n\\n保存失败保护回归';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-action="dlv-back"]').click();
    return true;
  })()`);
  await wait(450);
  if (!(await ev(`location.hash.startsWith('#/write/')`))) throw new Error('保存失败后仍然离开了编辑页');
  if (!(await ev(`document.querySelector('#ef-markdown')?.value.includes('保存失败保护回归')`))) throw new Error('保存失败后丢失了脏草稿');
  if (!(await ev(`document.querySelector('#save-status')?.textContent.includes('保存失败')`))) throw new Error('保存失败状态没有显示');
  await ev(`(() => {
    document.querySelector('#editor-comment').value = '保存失败时不应发送';
    document.querySelector('[data-action="editor-comment"]').click();
    return true;
  })()`);
  await wait(400);
  if ((await ev(`window.__smokeCommentPosts`)) !== 0) throw new Error('草稿保存失败后仍然发送了评论');

  await ev(`(() => {
    window.fetch = window.__smokeOriginalFetch;
    document.querySelector('[data-action="editor-save"]').click();
    return true;
  })()`);
  await waitFor(async () => (await ev(`document.querySelector('#save-status')?.textContent || ''`)).includes('已保存'), 5000, '恢复后保存草稿');
  await ev(`(() => {
    document.querySelector('#toasts').innerHTML = '';
    window.__smokePatchBodies = [];
    window.__smokeReleaseFirstPatch = null;
    window.fetch = async (input, opts = {}) => {
      const url = String(input);
      if (opts.method === 'PATCH' && url.includes('/api/deliverables/')) {
        window.__smokePatchBodies.push(JSON.parse(opts.body).content.markdown);
        if (window.__smokePatchBodies.length === 1) {
          await new Promise(resolve => { window.__smokeReleaseFirstPatch = resolve; });
        }
      }
      return window.__smokeOriginalFetch(input, opts);
    };
    const ta = document.querySelector('#ef-markdown');
    ta.value += '\\n\\n保存期间第一版';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-action="editor-save"]').click();
    return true;
  })()`);
  await waitFor(async () => (await ev(`window.__smokePatchBodies.length`)) === 1, 5000, '第一个保存请求');
  await ev(`(() => {
    const ta = document.querySelector('#ef-markdown');
    ta.value += '\\n\\n保存期间第二版';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-action="editor-save"]').click();
    return true;
  })()`);
  await wait(180);
  if (await ev(`[...document.querySelectorAll('.toast')].some(el => el.textContent === '草稿已保存')`)) throw new Error('进行中的保存被误报为成功');
  await ev(`window.__smokeReleaseFirstPatch()`);
  await waitFor(async () => (await ev(`window.__smokePatchBodies.length`)) >= 2, 5000, '强制保存继续保存新修改');
  await waitFor(async () => (await ev(`document.querySelector('#save-status')?.textContent || ''`)).includes('已保存'), 5000, '第二版保存完成');
  if (!(await ev(`window.__smokePatchBodies[1].includes('保存期间第二版')`))) throw new Error('第二次保存没有携带最新草稿');
  await ev(`window.fetch = window.__smokeOriginalFetch`);

  await send('Page.navigate', { url: `${BASE}/?smoke=8#/meeting` });
  await wait(1200);
  if ((await ev(`document.querySelectorAll('.meeting-row').length`)) < 1) throw new Error('会议室日历没有渲染');
  if ((await ev(`document.querySelectorAll('.meeting-day').length`)) !== 7) throw new Error('会议室周视图不完整');
  await auditPage('会议室预订页');

  await send('Page.navigate', { url: `${BASE}/?smoke=9#/supplies` });
  await wait(1200);
  if ((await ev(`document.querySelectorAll('.supply-table tbody tr').length`)) < 1) throw new Error('办公用品目录没有渲染');
  await auditPage('办公用品页');
  await ev(`document.querySelector('[data-action="supply-tab"][data-value="manage"]')?.click()`);
  await wait(700);
  if ((await ev(`document.querySelectorAll('.supply-cat').length`)) < 1) throw new Error('用品管理没有渲染');
  await auditPage('用品管理页');

  await send('Page.navigate', { url: `${BASE}/?smoke=10#/help` });
  await wait(1400);
  if ((await ev(`document.querySelectorAll('.help-article').length`)) < 10) throw new Error('帮助知识库没有渲染');
  if (!(await ev(`Boolean(document.querySelector('a[href="/help/project-workflow.html"]'))`))) throw new Error('完整流程图入口没有渲染');
  await auditPage('帮助页');
  await ev(`(() => { const i=document.querySelector('#help-search'); i.value='办公用品'; i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  await wait(800);
  if ((await ev(`document.querySelectorAll('.help-article').length`)) < 1) throw new Error('帮助实时搜索没有结果');
  if (!/找到/.test(await ev(`document.querySelector('.help-search-meta')?.innerText || ''`))) throw new Error('帮助搜索没有显示结果数');
  await ev(`(() => { const i=document.querySelector('#help-search'); i.value='会议室'; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true; })()`);
  await wait(700);
  if (!(await ev(`document.querySelector('.help-article summary b')?.textContent || ''`)).includes('会议室')) throw new Error('帮助搜索 Enter 没有生效');
  await ev(`document.querySelector('[data-action="help-search-clear"]')?.click()`);
  await wait(500);
  if ((await ev(`document.querySelectorAll('.help-article').length`)) < 10) throw new Error('帮助搜索清空后没有恢复');
  await ev(`document.querySelector('[data-action="help-tab"][data-value="ai"]')?.click()`);
  await wait(500);
  if (!(await ev(`Boolean(document.querySelector('.help-ai-page'))`))) throw new Error('智能问答页签没有渲染');
  await auditPage('智能问答页');

  await send('Page.navigate', { url: `${BASE}/?smoke=8#/report` });
  await wait(1200);
  if ((await ev(`document.querySelectorAll('.report-warning').length`)) < 1) throw new Error('项目群周报没有显示数据缺口');
  if ((await ev(`document.querySelectorAll('.report-history-item').length`)) < 1) throw new Error('项目群周报没有历史快照');
  await ev(`document.querySelector('.report-history-item')?.click()`);
  await wait(700);
  if (!(await ev(`Boolean(document.querySelector('.report-snapshot-bar'))`))) throw new Error('历史周报没有打开快照');
  await ev(`document.querySelector('[data-action="report-history-back"]')?.click()`);
  await wait(700);
  if (await ev(`Boolean(document.querySelector('.report-snapshot-bar'))`)) throw new Error('返回本周后仍停留在历史快照');
  await auditPage('项目群周报页');

  await ev(`document.querySelector('[data-action="report-tab"][data-value="plan"]').click()`);
  await waitFor(async () => (await ev(`document.querySelector('.sheet-title')?.textContent || ''`)).includes('Q4'), 5000, 'Q4 项目群计划');
  await ev(`(() => {
    window.__smokePlanOriginalFetch = window.fetch;
    window.__smokeQ3Started = false;
    window.__smokeReleaseQ3 = null;
    window.fetch = async (input, opts = {}) => {
      const response = await window.__smokePlanOriginalFetch(input, opts);
      if (String(input).includes('/api/program-plan?') && String(input).includes('2026-Q3')) {
        window.__smokeQ3Started = true;
        await new Promise(resolve => { window.__smokeReleaseQ3 = resolve; });
      }
      return response;
    };
    document.querySelector('[data-action="plan-prev"]').click();
    return true;
  })()`);
  await waitFor(async () => await ev(`window.__smokeQ3Started`), 5000, '延迟的 Q3 计划请求');
  await ev(`document.querySelector('[data-action="plan-next"]').click()`);
  await wait(250);
  await ev(`window.__smokeReleaseQ3()`);
  await wait(450);
  if (!(await ev(`document.querySelector('.sheet-title')?.textContent.includes('Q4')`))) throw new Error('过期的 Q3 响应覆盖了当前 Q4 计划');
  await ev(`window.fetch = window.__smokePlanOriginalFetch`);

  const secondProgram = await ev(`(async () => {
    const created = await fetch('/api/programs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PMO-Program': '1' },
      body: JSON.stringify({ code: 'PGM-UI-SCOPE', name: '界面缓存隔离项目群', owner: '测试', objective: '验证缓存范围' })
    }).then(r => r.json());
    if (!created.id) return created;
    const moved = await fetch('/api/projects/9', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-PMO-Program': '1' },
      body: JSON.stringify({ program_id: created.id })
    });
    return { id: created.id, ok: moved.ok, error: moved.ok ? '' : await moved.text() };
  })()`);
  if (!secondProgram.id || !secondProgram.ok) throw new Error(`无法建立跨项目群缓存场景：${JSON.stringify(secondProgram)}`);
  await send('Page.navigate', { url: `${BASE}/?smoke=8-plan-scope#/report` });
  await wait(1200);
  await ev(`document.querySelector('[data-action="report-tab"][data-value="plan"]').click()`);
  await waitFor(async () => (await ev(`document.querySelector('.sheet-title')?.textContent || ''`)).includes('2026 数字化转型项目群'), 5000, '原项目群计划');
  await ev(`(() => {
    const select = document.querySelector('#program-select');
    select.value = '${secondProgram.id}';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor(async () => (await ev(`document.querySelector('.sheet-title')?.textContent || ''`)).includes('界面缓存隔离项目群'), 5000, '切换后的项目群计划');

  await send('Page.navigate', { url: `${BASE}/?smoke=8#/admin` });
  await wait(1200);
  if (!(await ev(`[...document.querySelectorAll('#user-role-filter option')].some(o => o.value === 'client_member')`))) throw new Error('用户角色筛选缺少甲方项目成员');
  if (!(await ev(`[...document.querySelectorAll('#user-role-filter option')].some(o => o.value === 'vendor_member')`))) throw new Error('用户角色筛选缺少乙方项目成员');
  await ev(`document.querySelector('[data-action="admin-tab"][data-value="ai"]')?.click()`);
  await wait(600);
  if (!(await ev(`Boolean(document.querySelector('#ai-base'))`))) throw new Error('AI 配置页没有渲染');
  await auditPage('AI 配置页');
  await ev(`document.querySelector('[data-action="admin-tab"][data-value="approval"]')?.click()`);
  await wait(600);
  if (!(await ev(`Boolean(document.querySelector('#approval-meeting'))`))) throw new Error('审批设置页没有渲染');
  await auditPage('审批设置页');

  await send('Page.navigate', { url: `${BASE}/?smoke=9#/ai` });
  await wait(1200);
  if (!(await ev(`Boolean(document.querySelector('#global-ai-thread'))`))) throw new Error('全局 AI 页没有渲染');
  if ((await ev(`Math.round(document.querySelector('#global-ai-thread').getBoundingClientRect().width)`)) < 900) throw new Error('AI 助手对话框没有放大');
  if ((await ev(`getComputedStyle(document.querySelector('#global-ai-thread')).borderRadius`)) === '0px') throw new Error('AI 助手对话框没有圆角');
  await ev(`document.querySelector('[data-action="global-ai-run"][data-mode="portfolio"]')?.click()`);
  await wait(900);
  if ((await ev(`document.querySelectorAll('.chat-msg').length`)) < 2) throw new Error('全局 AI 没有返回结果');
  await auditPage('全局 AI 页');

  await ev(`localStorage.setItem('pmo.rail.collapsed', '1')`);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: `${BASE}/?smoke=mobile#/overview` });
  await wait(1400);
  if ((await ev(`getComputedStyle(document.querySelector('.rail')).overflowX`)) !== 'auto') throw new Error('390px 下侧栏不能横向滚动');
  if ((await ev(`document.documentElement.scrollWidth`)) > 391) throw new Error('390px 总览出现页面级横向溢出');
  if ((await ev(`getComputedStyle(document.querySelector('#rail-program-switch')).display`)) === 'none') throw new Error('移动端无法切换项目群');
  if ((await ev(`document.querySelectorAll('#program-select option').length`)) < 2) throw new Error('移动端项目群切换选项不完整');
  await ev(`document.querySelector('#rail-nav .nav-item:last-of-type').scrollIntoView({ block: 'nearest', inline: 'end' })`);
  await wait(250);
  if (!(await ev(`(() => { const r = document.querySelector('#rail-nav .nav-item:last-of-type').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; })()`))) throw new Error('390px 下最后一个菜单不可达');
  await ev(`document.querySelector('#rail-nav .nav-item:last-of-type').click()`);
  await wait(900);
  if (!(await ev(`location.hash === '#/supplies'`))) throw new Error('移动端最后菜单无法打开');
  for (const action of ['password', 'logout']) {
    await ev(`document.querySelector('[data-action="${action}"]').scrollIntoView({ block: 'nearest', inline: 'end' })`);
    await wait(180);
    if (!(await ev(`(() => { const el = document.querySelector('[data-action="${action}"]'); const r = el.getBoundingClientRect(); return getComputedStyle(el).display !== 'none' && r.left >= 0 && r.right <= innerWidth + 1; })()`))) throw new Error(`移动端 ${action} 入口不可达`);
  }
  await ev(`document.querySelector('[data-action="password"]').click()`);
  await wait(250);
  if (!(await ev(`Boolean(document.querySelector('input[name="current"]'))`))) throw new Error('移动端无法打开修改密码');
  await ev(`document.querySelector('[data-action="modal-close"]').click()`);
  await ev(`document.querySelector('[data-action="logout"]').click()`);
  await waitFor(async () => await ev(`Boolean(document.querySelector('#login-form'))`), 5000, '移动端退出登录');

  await ev(`(() => { const f = document.querySelector('#login-form'); f.username.value = 'zhangwei'; f.password.value = 'pm123456'; f.requestSubmit(); return true; })()`);
  await waitFor(async () => await ev(`Boolean(document.querySelector('#rail-nav'))`), 5000, '乙方项目经理登录');
  await send('Page.navigate', { url: `${BASE}/?smoke=11#/deliverables` });
  await wait(1000);
  await ev(`document.querySelector('[data-action="dlv-next"]').click()`);
  await waitFor(async () => await ev(`Boolean(document.querySelector('[data-action="dlv-edit"]'))`), 5000, '乙方项目经理周报填写入口');
  await ev(`document.querySelector('[data-action="dlv-edit"]').click()`);
  await waitFor(async () => await ev(`Boolean(document.querySelector('#ef-markdown'))`), 5000, '乙方项目经理周报编辑器');
  await ev(`(() => {
    const field = document.querySelector('#ef-markdown');
    field.value += '\\n\\n乙方项目经理录入权限回归';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-action="editor-save"]').click();
    return true;
  })()`);
  await waitFor(async () => (await ev(`document.querySelector('#save-status')?.textContent || ''`)).includes('已保存'), 5000, '乙方项目经理保存周报');

  await send('Page.navigate', { url: `${BASE}/?smoke=12#/deliverables` });
  await wait(1000);
  await ev(`document.querySelector('[data-action="dlv-kind"][data-value="plan"]').click()`);
  await wait(500);
  await ev(`document.querySelector('[data-action="dlv-next"]').click()`);
  await waitFor(async () => await ev(`Boolean(document.querySelector('[data-action="dlv-edit"]'))`), 5000, '乙方项目经理计划填写入口');
  await ev(`document.querySelector('[data-action="dlv-edit"]').click()`);
  await waitFor(async () => await ev(`Boolean(document.querySelector('#ef-objective'))`), 5000, '乙方项目经理计划编辑器');
  await ev(`(() => {
    const field = document.querySelector('#ef-objective');
    field.value += '\\n乙方项目经理录入权限回归';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-action="editor-save"]').click();
    return true;
  })()`);
  await waitFor(async () => (await ev(`document.querySelector('#save-status')?.textContent || ''`)).includes('已保存'), 5000, '乙方项目经理保存计划');

  if (errors.length) throw new Error(`页面报错：${errors.slice(0, 3).join(' | ')}`);
  console.log(`UI smoke OK: nav=${navCount}, editor concurrency/failure, plan cache/race, escaping, mobile 390px and all main pages rendered`);
}

try {
  await main();
} catch (err) {
  console.error(`UI smoke failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { chrome?.kill('SIGTERM'); } catch { /* ignore */ }
  try { server?.kill('SIGTERM'); } catch { /* ignore */ }
  await sleep(300);
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}
