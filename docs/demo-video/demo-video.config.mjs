import { fileURLToPath } from 'node:url';

const BASE_URL = process.env.DV_BASE_URL || 'http://127.0.0.1:5199';

function currentMonday() {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const pad = (n) => String(n).padStart(2, '0');
  return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
}

function dateAfter(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function nav(ctx, route) {
  const { page, bounded } = ctx;
  await bounded(page.goto(`${BASE_URL}/#/${route}`, { waitUntil: 'domcontentloaded', timeout: 12000 }), 15000, null);
  await bounded(page.locator('#view').waitFor({ state: 'visible', timeout: 6000 }), 8000, null);
}

async function fill(ctx, locator, value) {
  await ctx.bounded(locator.fill(value, { timeout: 5000 }), 7000, null);
}

async function reveal(ctx, locator) {
  await ctx.ensureInView(ctx.page, locator);
}

async function mustWait(ctx, locator, label, state = 'visible', timeout = 8000) {
  const result = await ctx.bounded(locator.waitFor({ state, timeout }), timeout + 2000, null);
  if (result === null) throw new Error(`${label} 未到达 ${state} 状态`);
}

export default {
  name: 'PMO 项目群控制台全功能完整演示',
  narration: 'narration.md',
  finalVideo: 'PMO项目群控制台-全功能完整演示.mp4',
  viewport: { width: 1920, height: 1080 },
  fps: 25,
  baseUrl: BASE_URL,
  browser: { channel: 'chrome', headless: true },
  auth: {
    storageState: '.auth-state.json',
    async login(page) {
      await page.locator('[data-action="demo-login"][data-user="pmo"]').click({ timeout: 8000 });
      await page.locator('#rail-nav').waitFor({ state: 'visible', timeout: 12000 });
    },
  },
  tts: {
    role: 'warm',
    rate: '-4%',
    proxy: process.env.DV_TTS_PROXY ? process.env.DV_TTS_PROXY.split(',') : [],
    defaultFixes: true,
  },
  compose: { crf: 18, preset: 'medium', audioBitrate: '192k', sampleRate: 44100, padSeconds: 6 },
  scenes: [
    { id: 'm00', title: '片头', overlay: 'overlay/title.html' },
    { id: 'm01', title: '项目群总览', auth: true, async run(ctx) {
      const { page, at, hoverText, clickLoc, bounded } = ctx;
      await nav(ctx, 'overview');
      await at(2.0);
      await hoverText(page, '在管项目', 500);
      await at(10.3);
      await hoverText(page, '本周填报', 600);
      await at(16.3);
      await reveal(ctx, page.getByRole('heading', { name: '01 组合健康' }));
      await at(22.9);
      await reveal(ctx, page.getByRole('heading', { name: '06 指标趋势' }));
      await at(28.0);
      await reveal(ctx, page.locator('.overview-ai'));
      await at(30.0);
      await clickLoc(page, page.locator('[data-action="overview-ai-run"][data-mode="summary"]'), 240, '总览生成项目摘要');
      await bounded(page.locator('.overview-ai-result-foot').waitFor({ timeout: 15000 }), 18000, null);
      await at(36.0);
      await reveal(ctx, page.getByRole('heading', { name: '08 高敞口风险' }));
    } },
    { id: 'm10', title: '角色视角与我的待办', auth: true, async run(ctx) {
      const { page, at, clickLoc, bounded } = ctx;
      const loginAs = async (user) => {
        await clickLoc(page, page.locator('[data-action="logout"]'), 180, '切换演示角色');
        await bounded(page.locator(`[data-action="demo-login"][data-user="${user}"]`).waitFor({ timeout: 8000 }), 10000, null);
        await clickLoc(page, page.locator(`[data-action="demo-login"][data-user="${user}"]`), 220, `登录 ${user}`);
        await bounded(page.locator('#rail-nav').waitFor({ timeout: 10000 }), 12000, null);
        await nav(ctx, 'my-tasks');
      };
      await nav(ctx, 'my-tasks');
      await at(6.0);
      await reveal(ctx, page.getByText('待审核', { exact: false }).first());
      await at(12.8);
      await loginAs('zhangwei');
      await at(18.7);
      await reveal(ctx, page.getByText('待提交', { exact: false }).first());
      await at(24.5);
      await loginAs('hejing');
      await at(30.5);
      await reveal(ctx, page.getByText('待查看', { exact: false }).first());
      await at(37.8);
      await loginAs('pmo');
      await page.context().storageState({ path: fileURLToPath(new URL('.auth-state.json', import.meta.url)) });
    } },
    { id: 'm02', title: '项目台账与执行', auth: true, async run(ctx) {
      const { page, at, clickLoc, bounded } = ctx;
      await nav(ctx, 'projects');
      await at(1.5);
      await clickLoc(page, page.locator('[data-action="new-project"]'), 240, '新建项目弹窗');
      await at(5.5);
      await clickLoc(page, page.locator('[data-action="modal-close"]').first(), 180, '关闭新建项目');
      await at(13.0);
      await fill(ctx, page.locator('#proj-search'), '核心业务');
      await clickLoc(page, page.getByText('核心业务中台重构', { exact: true }).first(), 240, '打开核心项目');
      await bounded(page.getByRole('heading', { name: '核心业务中台重构', exact: true }).waitFor({ timeout: 6000 }), 8000, null);
      await at(18.0);
      await clickLoc(page, page.locator('[data-action="edit-project"]'), 240, '编辑项目台账');
      await at(20.5);
      await clickLoc(page, page.locator('[data-action="modal-close"]').first(), 180, '关闭编辑台账');
      await at(23.5);
      await clickLoc(page, page.getByRole('link', { name: '整体计划', exact: true }), 240, '整体计划');
      await at(25.5);
      await clickLoc(page, page.getByRole('link', { name: '导出 CSV', exact: true }), 220, '导出计划');
      await at(29.5);
      await clickLoc(page, page.getByRole('link', { name: '收益与行动', exact: true }), 240, '收益与行动');
      await at(35.5);
      await clickLoc(page, page.getByRole('link', { name: '关口与依赖', exact: true }), 240, '关口与依赖');
    } },
    { id: 'm11', title: '时间轴、过程与资源', auth: true, async run(ctx) {
      const { page, at, clickLoc } = ctx;
      await nav(ctx, 'timeline');
      await at(6.5);
      await clickLoc(page, page.locator('[data-action="gantt-zoom"][data-value="week"]'), 200, '周视图');
      await at(8.5);
      await clickLoc(page, page.locator('[data-action="gantt-zoom"][data-value="month"]'), 200, '月视图');
      await at(10.0);
      await clickLoc(page, page.locator('[data-action="gantt-mine"]'), 200, '只看我的');
      await at(12.8);
      const depsButton = page.locator('[data-action="gantt-deps"]');
      if (await depsButton.getAttribute('aria-pressed') === 'true') await ctx.hoverText(page, '显示依赖', 500);
      else await clickLoc(page, depsButton, 220, '显示跨项目依赖');
      await at(16.5);
      await reveal(ctx, page.locator('[data-action="dep-open"]').first());
      await at(18.5);
      await nav(ctx, 'process');
      await at(20.5);
      await clickLoc(page, page.locator('[data-action="process-stage"][data-value="执行中"]'), 220, '筛选执行中项目');
      await at(25.0);
      await clickLoc(page, page.locator('[data-href$="/process"]').first(), 240, '打开项目过程明细');
      await at(27.5);
      await reveal(ctx, page.locator('.evm-strip'));
      await at(30.5);
      await nav(ctx, 'resources');
      await at(36.8);
      await reveal(ctx, page.getByText('未来 6 个月需求 vs 产能', { exact: false }));
    } },
    { id: 'm03', title: '里程碑、风险与关口', auth: true, async run(ctx) {
      const { page, at, clickLoc } = ctx;
      await nav(ctx, 'milestones');
      await at(5.5);
      await clickLoc(page, page.getByRole('button', { name: /已逾期/ }), 220, '逾期里程碑');
      await at(10.3);
      await nav(ctx, 'risks');
      await at(15.2);
      await clickLoc(page, page.locator('[data-action="risk-cell"][data-p="4"][data-i="4"]'), 220, '高敞口风险筛选');
      await at(20.7);
      await clickLoc(page, page.locator('[data-action="risk-open"][data-id="1"]'), 220, '风险详情');
      await at(24.2);
      await clickLoc(page, page.getByRole('button', { name: '关闭', exact: true }).first(), 180, '关闭风险详情');
      await at(26.0);
      await nav(ctx, 'projects/1/milestones');
      await at(28.5);
      await nav(ctx, 'projects/1/risks');
      await at(30.8);
      await nav(ctx, 'gates');
    } },
    { id: 'm12', title: '项目知识、AI 与团队', auth: true, async run(ctx) {
      const { page, at, clickLoc } = ctx;
      await nav(ctx, 'projects/1/kb');
      await at(12.8);
      await fill(ctx, page.locator('#kb-search'), '风险');
      await clickLoc(page, page.locator('[data-action="kb-search"]'), 200, '检索项目知识库');
      await at(15.0);
      await reveal(ctx, page.locator('details.kb-entry').first());
      await at(18.3);
      await reveal(ctx, page.locator('[data-action="kb-note-new"]'));
      await clickLoc(page, page.locator('[data-action="kb-note-new"]'), 220, '新增项目笔记');
      await mustWait(ctx, page.locator('#modal-title').filter({ hasText: '新增项目笔记' }), '项目笔记弹窗');
      await at(20.5);
      await clickLoc(page, page.locator('[data-action="modal-close"]').first(), 180, '关闭笔记弹窗');
      await mustWait(ctx, page.locator('#modal-form'), '项目笔记弹窗', 'hidden');
      await at(23.8);
      await nav(ctx, 'projects/1/ai');
      await at(31.6);
      await reveal(ctx, page.locator('[data-action="ai-run"][data-mode="actions"]').last());
      await clickLoc(page, page.locator('[data-action="ai-run"][data-mode="actions"]').last(), 240, '生成项目行动建议');
      await mustWait(ctx, page.locator('.ai-result-foot'), '项目 AI 结果', 'visible', 15000);
      await at(34.0);
      await reveal(ctx, page.locator('#ai-sources'));
      await at(37.9);
      await nav(ctx, 'projects/1/process');
      await at(39.5);
      await reveal(ctx, page.locator('.evm-strip'));
      await at(43.9);
      await reveal(ctx, page.locator('.change-row').first());
      await clickLoc(page, page.locator('.change-row').first(), 220, '打开变更详情');
      await mustWait(ctx, page.locator('#modal-form'), '变更详情弹窗');
      await at(47.0);
      await clickLoc(page, page.locator('[data-action="modal-close"]').first(), 180, '关闭变更详情');
      await mustWait(ctx, page.locator('#modal-form'), '变更详情弹窗', 'hidden');
      await at(48.0);
      await reveal(ctx, page.getByRole('heading', { name: '03 经验教训' }));
      await at(50.2);
      await nav(ctx, 'projects/1/team');
      await reveal(ctx, page.getByRole('heading', { name: '01 人员投入' }));
    } },
    { id: 'm13', title: '高级计划与关口评审', auth: true, async run(ctx) {
      const { page, at, clickLoc } = ctx;
      await nav(ctx, 'projects/1/plan');
      await at(7.2);
      await clickLoc(page, page.locator('.plan-row:not(.is-summary) [data-action="plan-task-edit"]').first(), 240, '编辑计划任务');
      await mustWait(ctx, page.locator('#plan-form'), '计划任务编辑弹窗', 'visible', 6000);
      await at(10.0);
      await reveal(ctx, page.locator('.plan-pred-grid'));
      await at(14.0);
      await clickLoc(page, page.locator('[data-action="modal-close"]').first(), 180, '关闭任务编辑');
      await at(15.0);
      await reveal(ctx, page.locator('[data-action="plan-baseline"]'));
      await at(20.5);
      await reveal(ctx, page.getByRole('link', { name: '导出 MS Project', exact: true }));
      await at(27.9);
      await nav(ctx, 'projects/1/reports');
      await at(30.5);
      await reveal(ctx, page.locator('.project-history').first());
      await at(35.2);
      await nav(ctx, 'gates');
      await at(36.5);
      await reveal(ctx, page.locator('[data-action="gate-checks"][title="查看检查清单"]').first());
      await clickLoc(page, page.locator('[data-action="gate-checks"][title="查看检查清单"]').first(), 220, '打开关口检查清单');
      await mustWait(ctx, page.locator('#modal-title').filter({ hasText: '检查清单' }), '关口检查清单');
      await at(41.0);
      await clickLoc(page, page.locator('[data-action="modal-close"]').first(), 180, '关闭检查清单');
      await mustWait(ctx, page.locator('#modal-form'), '关口检查清单', 'hidden');
      await at(42.0);
      await reveal(ctx, page.locator('button[data-action="gate-open"]').first());
      await clickLoc(page, page.locator('button[data-action="gate-open"]').first(), 220, '打开关口评审');
      await mustWait(ctx, page.locator('#modal-title').filter({ hasText: '关口评审' }), '关口评审弹窗');
      await at(44.5);
      await reveal(ctx, page.locator('#modal-form'));
      await at(48.0);
      await clickLoc(page, page.locator('[data-action="modal-close"]').first(), 180, '关闭关口评审');
      await mustWait(ctx, page.locator('#modal-form'), '关口评审弹窗', 'hidden');
      await nav(ctx, 'projects/1/governance');
      await reveal(ctx, page.getByRole('heading', { name: '02 跨项目依赖' }));
    } },
    { id: 'm04', title: '周报编辑与自动保存', auth: true, async run(ctx) {
      const { page, at, clickLoc, bounded } = ctx;
      const route = `write/weekly/5/${currentMonday()}`;
      await nav(ctx, route);
      await bounded(page.locator('#ef-markdown').waitFor({ timeout: 7000 }), 9000, null);
      await at(7.0);
      await clickLoc(page, page.getByRole('button', { name: '预览', exact: true }), 200, '预览周报');
      await at(8.8);
      await clickLoc(page, page.getByRole('button', { name: '分栏', exact: true }), 200, '分栏模式');
      await at(11.9);
      const original = await bounded(page.locator('#ef-markdown').inputValue({ timeout: 4000 }), 5000, '');
      const marker = '演示补充：已核对本周任务、风险与下周安排。';
      const next = original.includes(marker) ? original : `${original}\n\n${marker}`;
      await fill(ctx, page.locator('#ef-markdown'), next);
      await bounded(page.locator('#save-status').filter({ hasText: '已保存' }).waitFor({ timeout: 12000 }), 15000, null);
      await at(27.4);
      await reveal(ctx, page.locator('#editor-comment'));
      await fill(ctx, page.locator('#editor-comment'), '请继续跟踪供应商接口规范，并在下周周报更新结论。');
      await at(29.2);
      await clickLoc(page, page.getByRole('button', { name: '发送', exact: true }), 220, '发送沟通记录');
      await at(32.5);
      await clickLoc(page, page.locator('[data-action="editor-submit"]'), 240, '提交周报审核');
      await bounded(page.locator('#view').waitFor({ state: 'visible', timeout: 8000 }), 10000, null);
      await nav(ctx, route);
      await bounded(page.locator('#ef-markdown').waitFor({ timeout: 7000 }), 9000, null);
      await reveal(ctx, page.getByText('历史版本', { exact: true }));
    } },
    { id: 'm05', title: 'PMO 审核闭环', auth: true, async run(ctx) {
      const { page, at, clickLoc, bounded } = ctx;
      await nav(ctx, 'deliverables');
      await at(5.9);
      await clickLoc(page, page.locator('button[data-action="dlv-open"][data-project="1"]'), 240, '打开周报审核');
      await bounded(page.locator('#dlv-review-comment').waitFor({ timeout: 6000 }), 8000, null);
      await at(14.9);
      await fill(ctx, page.locator('#dlv-review-comment'), '已核对本周进展与风险，请按计划继续跟踪。');
      await at(18.9);
      await reveal(ctx, page.locator('[data-action="dlv-approve"]'));
      await at(22.6);
      await clickLoc(page, page.getByRole('button', { name: '关闭', exact: true }).first(), 180, '关闭审核弹窗');
      await at(24.2);
      await clickLoc(page, page.getByRole('tab', { name: '项目计划', exact: true }), 220, '项目计划审核');
    } },
    { id: 'm06', title: '项目群报表与历史', auth: true, async run(ctx) {
      const { page, at, clickLoc } = ctx;
      await nav(ctx, 'report');
      await at(3.0);
      await clickLoc(page, page.locator('[data-action="report-tab"][data-value="weekly"]'), 180, '项目群周报');
      await at(10.9);
      await ctx.hoverText(page, '更新本周快照', 500);
      await at(14.8);
      await reveal(ctx, page.locator('[data-action="report-history-open"]').first());
      await at(15.9);
      await clickLoc(page, page.locator('[data-action="report-history-open"]').first(), 240, '打开历史周报');
      await at(18.0);
      await clickLoc(page, page.getByRole('button', { name: '返回本周', exact: true }), 180, '返回本周');
      await at(20.0);
      await clickLoc(page, page.locator('[data-action="report-tab"][data-value="plan"]'), 220, '项目群计划');
      await at(25.3);
      await reveal(ctx, page.locator('[data-action="plan-download"]'));
    } },
    { id: 'm07', title: 'AI 项目群助手', auth: true, async run(ctx) {
      const { page, at, clickLoc, bounded } = ctx;
      await nav(ctx, 'ai');
      await at(6.0);
      await reveal(ctx, page.locator('[data-action="global-ai-run"][data-mode="risks"]'));
      await clickLoc(page, page.locator('[data-action="global-ai-run"][data-mode="risks"]'), 240, '风险与延期');
      await bounded(page.locator('#global-ai-thread .chat-meta').last().waitFor({ state: 'visible', timeout: 15000 }), 18000, null);
      await at(11.6);
      await reveal(ctx, page.locator('#global-ai-thread'));
      await at(13.0);
      await reveal(ctx, page.locator('#global-ai-thread .chat-sources').last());
    } },
    { id: 'm08', title: '帮助与管理运维', auth: true, async run(ctx) {
      const { page, at, clickLoc } = ctx;
      await nav(ctx, 'help');
      await at(6.5);
      await fill(ctx, page.locator('#help-search'), '白名单');
      await at(7.0);
      await clickLoc(page, page.locator('[data-action="help-search"]'), 180, '搜索帮助');
      await at(9.0);
      await reveal(ctx, page.locator('details.help-article').first());
      await at(11.6);
      await clickLoc(page, page.locator('[data-action="help-tab"][data-value="kb"]'), 220, '知识库');
      await at(15.8);
      await nav(ctx, 'admin');
      await at(21.4);
      await clickLoc(page, page.locator('[data-action="admin-tab"][data-value="ai"]'), 220, 'AI 配置');
      await at(26.9);
      await clickLoc(page, page.locator('[data-action="admin-tab"][data-value="audit"]'), 220, '审计日志');
      await at(29.2);
      await clickLoc(page, page.locator('[data-action="admin-tab"][data-value="data"]'), 220, '数据与运行');
    } },
    { id: 'm16', title: '智能问答与系统管理', auth: true, async run(ctx) {
      const { page, at, clickLoc, bounded } = ctx;
      await nav(ctx, 'help');
      await clickLoc(page, page.locator('[data-action="help-tab"][data-value="ai"]'), 220, '帮助智能问答');
      await at(2.0);
      await fill(ctx, page.locator('#help-question'), '周报被退回了怎么改？');
      await clickLoc(page, page.locator('[data-action="help-ask"]'), 220, '提问');
      await bounded(page.locator('#help-thread .chat-meta').last().waitFor({ timeout: 15000 }), 18000, null);
      await at(7.5);
      await reveal(ctx, page.locator('#help-thread .chat-sources').last());
      await at(11.8);
      await nav(ctx, 'admin');
      await clickLoc(page, page.locator('[data-action="admin-tab"][data-value="programs"]'), 220, '项目群管理');
      await at(14.5);
      await clickLoc(page, page.locator('[data-action="program-new"]'), 220, '新增项目群弹窗');
      await at(16.5);
      await clickLoc(page, page.locator('[data-action="modal-close"]').first(), 160, '关闭项目群弹窗');
      await at(17.9);
      await clickLoc(page, page.locator('[data-action="admin-tab"][data-value="vendors"]'), 220, '乙方供应商');
      await at(20.0);
      await clickLoc(page, page.locator('[data-action="vendor-new"]'), 220, '新增供应商弹窗');
      await at(22.5);
      await clickLoc(page, page.locator('[data-action="modal-close"]').first(), 160, '关闭供应商弹窗');
      await at(24.6);
      await clickLoc(page, page.locator('[data-action="admin-tab"][data-value="templates"]'), 220, '模板管理');
      await at(26.5);
      await clickLoc(page, page.locator('[data-action="template-new"]'), 220, '新增模板弹窗');
      await at(28.5);
      await clickLoc(page, page.locator('[data-action="modal-close"]').first(), 160, '关闭模板弹窗');
      await at(30.0);
      await clickLoc(page, page.locator('[data-action="admin-tab"][data-value="help"]'), 220, '知识库管理');
      await at(33.0);
      await clickLoc(page, page.locator('[data-action="admin-tab"][data-value="approval"]'), 220, '审批设置');
      await at(36.8);
      await clickLoc(page, page.locator('[data-action="admin-tab"][data-value="calendar"]'), 220, '工作日历');
      await at(39.0);
      await clickLoc(page, page.locator('[data-action="calendar-new"]'), 220, '工作日历设置');
      await at(44.0);
      await clickLoc(page, page.locator('[data-action="modal-close"]').first(), 160, '关闭日历设置');
      await at(49.5);
      await clickLoc(page, page.locator('[data-action="password"]'), 220, '个人账号修改密码');
      await bounded(page.locator('#modal-form').waitFor({ timeout: 6000 }), 8000, null);
      await at(53.5);
      await clickLoc(page, page.locator('[data-action="modal-close"]').first(), 160, '关闭密码弹窗');
      await at(57.0);
      await clickLoc(page, page.locator('[data-action="admin-tab"][data-value="data"]'), 220, '数据与运行');
    } },
    { id: 'm14', title: '会议室预订与审批', auth: true, async run(ctx) {
      const { page, at, clickLoc, bounded } = ctx;
      await nav(ctx, 'meeting');
      await at(6.7);
      await clickLoc(page, page.locator('[data-action="booking-new"]'), 240, '新增会议室预订');
      await bounded(page.locator('#f-title').waitFor({ timeout: 6000 }), 8000, null);
      await at(10.5);
      await fill(ctx, page.locator('#f-title'), '演示项目协调会');
      await fill(ctx, page.locator('#f-date'), dateAfter(21));
      await fill(ctx, page.locator('#f-start_time'), '16:00');
      await fill(ctx, page.locator('#f-end_time'), '17:00');
      await fill(ctx, page.locator('#f-purpose'), '核对演示项目进度、风险和后续安排');
      await at(13.4);
      await clickLoc(page, page.getByRole('button', { name: '提交预订', exact: true }), 240, '提交会议预订');
      await mustWait(ctx, page.locator('#modal-form'), '会议预订弹窗', 'hidden');
      await at(19.5);
      await clickLoc(page, page.locator('[data-action="meeting-tab"][data-value="mine"]'), 220, '我的预订');
      await mustWait(ctx, page.getByText('演示项目协调会', { exact: true }), '新会议预订记录');
      await at(22.0);
      await reveal(ctx, page.getByText('演示项目协调会', { exact: true }));
      await at(24.0);
      await clickLoc(page, page.locator('[data-action="meeting-tab"][data-value="pending"]'), 220, '待审批预订');
      await at(30.6);
      await clickLoc(page, page.locator('[data-action="meeting-tab"][data-value="rooms"]'), 220, '会议室维护');
      await at(35.7);
      await clickLoc(page, page.locator('[data-action="meeting-room-new"]'), 220, '新增会议室弹窗');
      await at(39.5);
      await clickLoc(page, page.locator('[data-action="modal-close"]').first(), 180, '关闭会议室弹窗');
    } },
    { id: 'm15', title: '办公用品领用与库存', auth: true, async run(ctx) {
      const { page, at, clickLoc, bounded } = ctx;
      await nav(ctx, 'supplies');
      await at(6.5);
      await clickLoc(page, page.locator('[data-action="supply-category"]:not([data-value="all"])').first(), 200, '按分类筛选用品');
      await at(12.3);
      await clickLoc(page, page.locator('[data-action="supply-request"]').first(), 240, '发起用品领用');
      await bounded(page.locator('#f-purpose').waitFor({ timeout: 6000 }), 8000, null);
      await fill(ctx, page.locator('#f-purpose'), '演示项目周会使用');
      await at(15.5);
      await clickLoc(page, page.getByRole('button', { name: '提交领用', exact: true }), 240, '提交用品领用');
      await mustWait(ctx, page.locator('#modal-form'), '用品领用弹窗', 'hidden');
      await at(18.0);
      await clickLoc(page, page.locator('[data-action="supply-tab"][data-value="mine"]'), 220, '我的领用');
      await at(23.2);
      await clickLoc(page, page.locator('[data-action="supply-tab"][data-value="pending"]'), 220, '待发放');
      await mustWait(ctx, page.getByText('演示项目周会使用', { exact: true }), '新用品领用记录');
      await mustWait(ctx, page.getByText('待他人审批', { exact: true }).last(), '用品自审限制');
      await at(29.4);
      await clickLoc(page, page.locator('[data-action="supply-tab"][data-value="manage"]'), 220, '用品与库存管理');
      await at(31.5);
      await clickLoc(page, page.locator('[data-action="supply-item-new"]'), 220, '新增物品弹窗');
      await at(34.0);
      await clickLoc(page, page.locator('[data-action="modal-close"]').first(), 180, '关闭物品弹窗');
      await at(35.5);
      await clickLoc(page, page.locator('[data-action="supply-tab"][data-value="pending"]'), 220, '核对自审限制');
    } },
    { id: 'm09', title: '片尾', overlay: 'overlay/outro.html' },
  ],
};
