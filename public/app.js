/* ==========================================================================
   PMO 项目群控制台 — 前端应用
   无框架、无构建：hash 路由 + 模板渲染 + 事件委托
   ========================================================================== */

const TEMPLATE_CATEGORIES = { weekly: '项目周报', plan: '项目计划', milestone: '里程碑', risk: '风险', gate: '阶段关口', other: '其他' };

const PROJECT_TABS = [
  { id: 'overview', icon: 'overview', label: '概览' },
  { id: 'plan', label: '整体计划' },
  { id: 'value', label: '收益与行动' },
  { id: 'kb', label: '项目知识库' },
  { id: 'ai', label: 'AI 助手' },
  { id: 'process', icon: 'process', label: 'PMP 过程' },
  { id: 'reports', label: '计划与周报' },
  { id: 'milestones', icon: 'milestones', label: '里程碑' },
  { id: 'risks', icon: 'risks', label: '风险' },
  { id: 'governance', label: '关口与依赖' },
  { id: 'team', label: '投入' },
];

const state = {
  data: null,
  resources: null,
  report: null,
  me: null,
  route: 'overview',
  params: {},
  filters: { projectStage: '全部', projectPriority: '全部', q: '', msRange: 'all', riskStatus: '全部', riskCell: null, riskProject: '全部' },
  dlv: { kind: 'weekly', week: null, plan: null, planType: 'quarter', onlyMine: null },
  dlvData: null,
  dlvModal: null,
  editor: null,
  reportTab: 'weekly',
  planPeriod: null,
  programPlan: null,
  adminTab: 'users',
  gateFilter: '待评审',
  gantt: { zoom: 'month', stage: '全部', onlyMine: false, showDeps: true },
  ganttKey: null,
  ganttScrolledKey: null,
  processMatrix: null,
  processStage: '全部',
  pmUsers: null,
  adminUsers: null,
  userFilters: { q: '', role: '全部', party: '全部', status: '全部' },
  loginBusy: false,
  ai: null,
  reportSnapshot: null,
  projectAIBrief: null,
  help: { q: '', category: '全部', tab: 'kb', messages: [], draft: '' },
  projectKB: null,
  projectKBFilter: { q: '', kind: '' },
  aiGlobal: { scope: 'all', messages: [], draft: '' },
  meeting: { tab: 'calendar', date: null, roomId: 'all' },
  supplies: { tab: 'catalog', category: 'all' },
  programId: (() => { try { return Number(localStorage.getItem('pmo.program')) || null; } catch { return null; } })(),
};

const $ = (sel, root = document) => root.querySelector(sel);
let helpSearchTimer = null;
let helpSearchComposing = false;
let projectKBSearchTimer = null;
let projectKBSearchComposing = false;

/** 安全转义：所有来自数据库的文本都必须走这里 */
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------ markdown --- */

let mdFootnoteCtx = null;
let mdFootnoteSeq = 0;

function mdInline(text) {
  let out = esc(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|#[^\s)]+|\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');
  out = out.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  if (mdFootnoteCtx) {
    out = out.replace(/\[\^([^\]]+)\]/g, (whole, id) => {
      if (!mdFootnoteCtx.defs.has(id)) return whole;
      let idx = mdFootnoteCtx.order.indexOf(id);
      if (idx < 0) {
        mdFootnoteCtx.order.push(id);
        idx = mdFootnoteCtx.order.length - 1;
      }
      const n = idx + 1;
      const refKey = `${id}`;
      const refNo = (mdFootnoteCtx.refs.get(refKey) || 0) + 1;
      mdFootnoteCtx.refs.set(refKey, refNo);
      const rid = `fn-${mdFootnoteCtx.prefix}-${n}`;
      const back = `fnref-${mdFootnoteCtx.prefix}-${n}-${refNo}`;
      if (refNo === 1) mdFootnoteCtx.firstBack.set(id, back);
      return `<sup class="md-fn-ref" id="${back}"><a href="#${rid}" data-md-footnote="${rid}">[${n}]</a></sup>`;
    });
  }
  return out;
}

function markdownToPlain(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/[*_`>]/g, '')
    .replace(/\n+/g, ' ')
    .trim();
}

function markdownBodyPlain(md) {
  const body = String(md || '').split('\n')
    .filter((line) => !/^\s*#{1,6}\s+/.test(line))
    .join('\n');
  return markdownToPlain(body);
}

function sanitizeWeeklyTemplate(md) {
  return String(md || '')
    .split('\n')
    .filter((line) => !/^\s*[-*+]\s*$/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

function mdSplitTableRow(row) {
  let line = String(row || '').trim();
  if (line.startsWith('|')) line = line.slice(1);
  if (line.endsWith('|') && !line.endsWith('\\|')) line = line.slice(0, -1);
  const cells = [];
  let cur = '';
  let escaped = false;
  for (const ch of line) {
    if (escaped) { cur += ch; escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function mdIsTableSep(line) {
  const cells = mdSplitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));
}

function mdTableAligns(sep) {
  return mdSplitTableRow(sep).map((c) => {
    const v = c.trim();
    if (v.startsWith(':') && v.endsWith(':')) return 'center';
    if (v.endsWith(':')) return 'right';
    if (v.startsWith(':')) return 'left';
    return '';
  });
}

function mdParseNodeToken(token) {
  const raw = String(token || '').trim();
  const m = raw.match(/^([A-Za-z0-9_\u4e00-\u9fa5]+)\s*(\(\(.*?\)\)|\[.*?\]|\{.*?\}|\(.*?\)|>.*?\])?$/);
  if (!m) return null;
  const id = m[1];
  let shape = 'rect';
  let label = id;
  const bracket = m[2] || '';
  if (bracket.startsWith('[[')) { shape = 'sub'; label = bracket.slice(2, -2); }
  else if (bracket.startsWith('[')) { shape = 'rect'; label = bracket.slice(1, -1); }
  else if (bracket.startsWith('((')) { shape = 'circle'; label = bracket.slice(2, -2); }
  else if (bracket.startsWith('(')) { shape = 'round'; label = bracket.slice(1, -1); }
  else if (bracket.startsWith('{')) { shape = 'diamond'; label = bracket.slice(1, -1); }
  else if (bracket.startsWith('>')) { shape = 'flag'; label = bracket.slice(1, -1); }
  label = label.replace(/^["']|["']$/g, '').trim() || id;
  return { id, label, shape };
}

let mdFlowSeq = 0;

function renderFlowchart(code) {
  const lines = String(code || '').replace(/\r/g, '').split('\n');
  let direction = 'TD';
  const nodes = new Map();
  const edges = [];
  const addNode = (n) => {
    if (!n) return;
    if (!nodes.has(n.id)) nodes.set(n.id, n);
    else if (n.label !== n.id) nodes.set(n.id, n);
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('%%')) continue;
    const head = line.match(/^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)/i);
    if (head) { direction = /LR|RL/i.test(head[1]) ? 'LR' : 'TD'; continue; }
    if (/^(subgraph|end|classDef|class\s|style\s|linkStyle|click\s)/.test(line)) continue;
    const em = line.match(/^(.+?)\s*(-->|---|-.->|==>)\s*(?:\|([^|]*)\|\s*)?(.+)$/);
    if (em) {
      const left = mdParseNodeToken(em[1]);
      const right = mdParseNodeToken(em[4]);
      if (left && right) {
        addNode(left);
        addNode(right);
        edges.push({ from: left.id, to: right.id, label: (em[3] || '').trim() });
      }
      continue;
    }
    addNode(mdParseNodeToken(line));
  }
  if (!nodes.size) return null;

  const ids = [...nodes.keys()];
  const incoming = new Set(edges.map((e) => e.to));
  let roots = ids.filter((id) => !incoming.has(id));
  if (!roots.length) roots = [ids[0]];
  const level = new Map();
  const queue = [...roots];
  roots.forEach((id) => level.set(id, 0));
  while (queue.length) {
    const id = queue.shift();
    for (const e of edges.filter((x) => x.from === id)) {
      if (!level.has(e.to)) {
        level.set(e.to, (level.get(id) || 0) + 1);
        queue.push(e.to);
      }
    }
  }
  for (const id of ids) if (!level.has(id)) level.set(id, 0);
  const maxLevel = Math.max(...level.values());
  const groups = new Map();
  for (const id of ids) {
    const lv = level.get(id) || 0;
    if (!groups.has(lv)) groups.set(lv, []);
    groups.get(lv).push(id);
  }
  const levels = [...groups.keys()].sort((a, b) => a - b);
  const maxPerLevel = Math.max(...levels.map((lv) => groups.get(lv).length));
  const gapX = 34;
  const gapY = 68;
  const margin = 24;
  const height = 44;
  const widthOf = (n) => Math.max(120, Math.min(230, n.label.length * 13 + 36)) + (n.shape === 'diamond' ? 20 : 0);
  const maxWidth = Math.max(...ids.map((id) => widthOf(nodes.get(id))));
  const pos = new Map();

  if (direction === 'LR') {
    const maxRows = maxPerLevel;
    const canvasW = margin * 2 + (maxLevel + 1) * (maxWidth + gapX);
    const canvasH = Math.max(220, margin * 2 + maxRows * (height + gapY));
    for (const lv of levels) {
      const group = groups.get(lv);
      const total = group.length * height + (group.length - 1) * gapY;
      const startY = (canvasH - total) / 2;
      group.forEach((id, idx) => {
        const w = widthOf(nodes.get(id));
        pos.set(id, {
          x: margin + lv * (maxWidth + gapX) + (maxWidth - w) / 2,
          y: startY + idx * (height + gapY),
          w, h: height,
        });
      });
    }
    return mdFlowSvg(nodes, edges, pos, canvasW, canvasH, 'LR');
  }

  const canvasW = Math.max(360, margin * 2 + maxPerLevel * (maxWidth + gapX));
  const canvasH = margin * 2 + (maxLevel + 1) * (height + gapY);
  for (const lv of levels) {
    const group = groups.get(lv);
    const total = group.length * maxWidth + (group.length - 1) * gapX;
    const startX = (canvasW - total) / 2;
    group.forEach((id, idx) => {
      const node = nodes.get(id);
      const w = widthOf(node);
      pos.set(id, {
        x: startX + idx * (maxWidth + gapX) + (maxWidth - w) / 2,
        y: margin + lv * (height + gapY),
        w, h: height,
      });
    });
  }
  return mdFlowSvg(nodes, edges, pos, canvasW, canvasH, 'TD');
}

function mdFlowSvg(nodes, edges, pos, width, height, direction) {
  const seq = ++mdFlowSeq;
  const marker = `md-arrow-${seq}`;
  const parts = [];
  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    let d;
    if (e.from === e.to) {
      d = `M ${a.x + a.w} ${a.y + a.h / 2} C ${a.x + a.w + 46} ${a.y - 16}, ${a.x + a.w + 46} ${a.y + a.h + 16}, ${a.x + a.w} ${a.y + a.h / 2 + 4}`;
    } else if (direction === 'LR') {
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = b.x;
      const y2 = b.y + b.h / 2;
      if (x2 <= x1) {
        const lane = Math.max(10, Math.min(a.y, b.y) - 26);
        d = `M ${a.x + a.w / 2} ${a.y} L ${a.x + a.w / 2} ${lane} L ${b.x + b.w / 2} ${lane} L ${b.x + b.w / 2} ${b.y}`;
      } else {
        const dx = Math.max(28, Math.abs(x2 - x1) / 2);
        d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      }
    } else {
      const x1 = a.x + a.w / 2;
      const y1 = a.y + a.h;
      const x2 = b.x + b.w / 2;
      const y2 = b.y;
      if (y2 <= y1) {
        const lane = Math.max(10, Math.min(a.x, b.x) - 30);
        const sy = a.y + a.h / 2;
        const ty = b.y + b.h / 2;
        d = `M ${a.x} ${sy} L ${lane} ${sy} L ${lane} ${ty} L ${b.x} ${ty}`;
      } else {
        const dy = Math.max(28, Math.abs(y2 - y1) / 2);
        d = `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
      }
    }
    parts.push(`<path class="md-flow-edge" d="${d}" marker-end="url(#${marker})"/>`);
    if (e.label) {
      const a2 = pos.get(e.from);
      const b2 = pos.get(e.to);
      const lx = direction === 'LR'
        ? (a2.x + a2.w + b2.x) / 2
        : (a2.x + a2.w / 2 + b2.x + b2.w / 2) / 2;
      const ly = direction === 'LR'
        ? (a2.y + a2.h / 2 + b2.y + b2.h / 2) / 2 - 6
        : (a2.y + a2.h + b2.y) / 2 - 3;
      parts.push(`<text class="md-flow-edge-label" x="${lx}" y="${ly}" text-anchor="middle">${esc(e.label)}</text>`);
    }
  }
  for (const [id, n] of nodes) {
    const p = pos.get(id);
    if (!p) continue;
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    let shape;
    if (n.shape === 'diamond') {
      shape = `<polygon class="md-flow-node" points="${cx},${p.y} ${p.x + p.w},${cy} ${cx},${p.y + p.h} ${p.x},${cy}"/>`;
    } else if (n.shape === 'circle') {
      shape = `<ellipse class="md-flow-node" cx="${cx}" cy="${cy}" rx="${p.w / 2}" ry="${p.h / 2}"/>`;
    } else {
      const rx = n.shape === 'round' || n.shape === 'sub' ? 8 : 0;
      shape = `<rect class="md-flow-node" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${rx}"/>`;
    }
    const label = n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label;
    parts.push(`<g><title>${esc(n.label)}</title>${shape}<text class="md-flow-label" x="${cx}" y="${cy + 4}" text-anchor="middle">${esc(label)}</text></g>`);
  }
  return `<div class="md-flow" role="img" aria-label="流程图"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs><marker id="${marker}" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="var(--ink-4)"/></marker></defs>
    ${parts.join('')}
  </svg></div>`;
}

function renderMarkdown(md) {
  const rawLines = String(md || '').replace(/\r/g, '').split('\n');
  const defs = new Map();
  const lines = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const def = rawLines[i].match(/^\[\^([^\]]+)\]:\s*(.*)$/);
    if (def) {
      let text = def[2];
      while (i + 1 < rawLines.length && /^\s{2,}\S/.test(rawLines[i + 1])) {
        text += ` ${rawLines[++i].trim()}`;
      }
      defs.set(def[1], text);
      continue;
    }
    lines.push(rawLines[i]);
  }
  mdFootnoteCtx = defs.size ? {
    defs, prefix: `f${++mdFootnoteSeq}`, order: [], refs: new Map(), firstBack: new Map(),
  } : null;

  let html = '';
  let para = [];
  let list = null;
  const flushPara = () => {
    if (!para.length) return;
    html += `<p>${para.map(mdInline).join('<br>')}</p>`;
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    html += `<${list.tag}>${list.items.map((x) => `<li>${mdInline(x)}</li>`).join('')}</${list.tag}>`;
    list = null;
  };
  const flush = () => { flushPara(); flushList(); };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      flush();
      const lang = trimmed.slice(3).trim().toLowerCase();
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
      const source = code.join('\n');
      if (lang === 'mermaid' || lang === 'flow') {
        const flow = renderFlowchart(source);
        if (flow) { html += flow; continue; }
      }
      html += `<pre><code>${esc(source)}</code></pre>`;
      continue;
    }
    if (!trimmed) { flush(); continue; }

    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const level = h[1].length;
      html += `<h${level}>${mdInline(h[2])}</h${level}>`;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) { flush(); html += '<hr>'; continue; }
    if (/^>\s?/.test(trimmed)) { flush(); html += `<blockquote>${mdInline(trimmed.replace(/^>\s?/, ''))}</blockquote>`; continue; }

    if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
      list.items.push(line.replace(/^\s*[-*]\s+/, ''));
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
      list.items.push(line.replace(/^\s*\d+\.\s+/, ''));
      continue;
    }

    if (trimmed.includes('|') && i + 1 < lines.length && mdIsTableSep(lines[i + 1])) {
      flush();
      const head = mdSplitTableRow(line);
      const aligns = mdTableAligns(lines[i + 1]);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(mdSplitTableRow(lines[i]));
        i += 1;
      }
      i -= 1;
      const cellClass = (idx) => aligns[idx] ? ` class="md-align-${aligns[idx]}"` : '';
      html += `<div class="md-table-wrap"><table><thead><tr>${head.map((x, idx) => `<th${cellClass(idx)}>${mdInline(x)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, idx) => `<td${cellClass(idx)}>${mdInline(r[idx] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      continue;
    }

    flushList();
    para.push(trimmed);
  }
  flush();

  if (mdFootnoteCtx && mdFootnoteCtx.order.length) {
    const ctx = mdFootnoteCtx;
    const items = ctx.order.map((id, idx) => {
      const back = ctx.firstBack.get(id);
      return `<li id="fn-${ctx.prefix}-${idx + 1}">${mdInline(ctx.defs.get(id))}${back ? ` <a class="md-fn-back" href="#${back}" data-md-footnote="${back}" aria-label="回到正文">↩</a>` : ''}</li>`;
    }).join('');
    html += `<section class="md-footnotes"><h4>脚注</h4><ol>${items}</ol></section>`;
  }
  mdFootnoteCtx = null;
  return html || '<p class="md-empty">还没有正文。可以直接写 Markdown，也可以套用模板。</p>';
}


const ICONS = {
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 5v14M5 12h14"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="9" y="9" width="11" height="11"/><path d="M5 15V4h11"/></svg>',
  print: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 8V4h10v4M7 17H5V9h14v8h-2"/><rect x="7" y="14" width="10" height="6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12l4.5 4.5L19 7"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 20h4L20 8l-4-4L4 16v4z"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 4H5v16h4M15 8l4 4-4 4M9 12h10"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M15 5l-7 7 7 7"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l2 2M14 9l2 2"/></svg>',
};

const NAV_ICONS = {
  overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
  tasks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16"/><path d="M7 9l2 2 3-4M7 16l2 2 3-4M15 9h3M15 16h3"/></svg>',
  projects: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7h7l2 2h9v10H3z"/><path d="M3 7V5h7l2 2"/></svg>',
  timeline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6h16M4 12h16M4 18h16"/><rect x="6" y="5" width="5" height="2"/><rect x="12" y="11" width="6" height="2"/><rect x="8" y="17" width="8" height="2"/></svg>',
  process: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="6" height="6"/><rect x="15" y="15" width="6" height="6"/><path d="M9 6h6a3 3 0 013 3v3M15 18H9a3 3 0 01-3-3v-3"/></svg>',
  milestones: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 21V4M5 5h12l-2 4 2 4H5"/></svg>',
  risks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3l9 17H3z"/><path d="M12 9v5M12 17h.01"/></svg>',
  gates: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="M8 12l3 3 5-6"/></svg>',
  deliverables: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  resources: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 2.5-5 6-5s6 2 6 5M16 5a3 3 0 010 6M18 20c0-2-.8-3.5-2-4.5"/></svg>',
  report: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 20V4M4 20h16"/><path d="M8 16v-5M12 16V7M16 16v-8M20 16v-3"/></svg>',
  admin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 00-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 00-1.7-1L14.5 3h-4l-.4 2.1a7 7 0 00-1.7 1l-2.3-1-2 3.4L6 10a7 7 0 000 2l-2 1.5 2 3.4 2.3-1a7 7 0 001.7 1l.4 2.1h4l.4-2.1a7 7 0 001.7-1l2.3 1 2-3.4-2-1.5a7 7 0 00.1-1z"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.7 2.7 0 015.2 1c0 2-2.7 2-2.7 4M12 17h.01"/></svg>',
  ai: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7L12 3z"/><path d="M18.5 14l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z"/></svg>',
  meeting: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="18" height="15" rx="1.5"/><path d="M7 3v4M17 3v4M3 9h18M8 13h3M8 16h7"/></svg>',
  supply: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 8l8-4 8 4-8 4-8-4z"/><path d="M4 8v8l8 4 8-4V8M12 12v8"/></svg>',
};

/* --------------------------------------------------------------- format --- */

const MONTH_LABEL = { '01': '一月', '02': '二月', '03': '三月', '04': '四月', '05': '五月', '06': '六月', '07': '七月', '08': '八月', '09': '九月', 10: '十月', 11: '十一月', 12: '十二月' };
const WD = ['日', '一', '二', '三', '四', '五', '六'];

function today() { return state.data?.today || new Date().toISOString().slice(0, 10); }
function parse(d) { const [y, m, dd] = String(d).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, dd); }
function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function daysDiff(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }
function money(n) { return new Intl.NumberFormat('zh-CN').format(Math.round(n || 0)); }
function pct(n) { return `${Math.round((n || 0) * 100)}%`; }
function dShort(d) { return d ? d.slice(5).replace('-', '.') : '—'; }
function dFull(d) { return d || '—'; }
function weekday(d) { return `周${WD[parse(d).getDay()]}`; }
function monthKey(d) { return d.slice(0, 7); }
function monthText(key) { const [y, m] = key.split('-'); return `${y} 年 ${Number(m)} 月`; }
function relDays(d) {
  const n = daysDiff(today(), d);
  if (n === 0) return '今天';
  if (n === 1) return '明天';
  if (n === -1) return '昨天';
  return n > 0 ? `${n} 天后` : `逾期 ${Math.abs(n)} 天`;
}
function weekOfYear(d) {
  const date = new Date(d.getTime());
  const day = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - day + 3);
  const first = new Date(date.getFullYear(), 0, 4);
  return 1 + Math.round(((date - first) / 86400000 - 3 + ((first.getDay() + 6) % 7)) / 7);
}
function ragLabel(r) { return { green: '正常', amber: '关注', red: '预警' }[r] || r; }

function nextWorkdayClient(day) {
  const d = parse(day);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return isoDate(d);
}

function addDays(day, n) {
  const d = parse(day);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
function mondayOf(day) {
  const d = parse(day);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return isoDate(d);
}
function quarterOf(day) {
  const d = parse(day);
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
}
function quarterText(label) {
  return `${label.slice(0, 4)} 年第 ${Number(label.slice(6))} 季度`;
}
function shiftQuarter(label, n) {
  const y = Number(label.slice(0, 4));
  const q = Number(label.slice(6));
  const total = y * 4 + (q - 1) + n;
  return `${Math.floor(total / 4)}-Q${(total % 4) + 1}`;
}
function shiftMonth(label, n) {
  const y = Number(label.slice(0, 4));
  const m = Number(label.slice(5, 7)) - 1 + n;
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function fmtDateTime(v) {
  if (!v) return '—';
  return String(v).slice(0, 16).replace('T', ' ');
}
function shiftFromToday(n) {
  return addDays(today(), n);
}
function weekText(start) {
  return `${start.slice(5).replace('-', '.')} — ${addDays(start, 6).slice(5).replace('-', '.')}`;
}
function dlvStatusOf(item) {
  return item ? item.status : 'missing';
}
const DLV_STATUS = {
  draft: { label: '草稿', cls: 'chip--dashed' },
  submitted: { label: '待审核', cls: 'chip--ochre' },
  approved: { label: '已通过', cls: 'chip--jade' },
  rejected: { label: '已退回', cls: 'chip--oxblood' },
  missing: { label: '未提交', cls: '' },
};
function dlvChip(item) {
  if (item && item.restricted) return '<span class="chip chip--dashed">填报中</span>';
  const st = DLV_STATUS[dlvStatusOf(item)];
  return `<span class="chip ${st.cls}">${st.label}</span>`;
}
function roleText(role, party) {
  if (role === 'pmo') return 'PMO 管理员';
  if (role === 'approver') return '审批员';
  if (role === 'client_member') return '甲方项目成员';
  if (role === 'vendor_member') return '乙方项目成员';
  return party === '甲方' ? '甲方项目经理' : '乙方项目经理';
}

function canEditProject(p) {
  return Boolean(p) && (state.me.role === 'pmo' || p.vendor_pm_id === state.me.id);
}
function multiline(text) {
  return esc(text || '').replace(/\n/g, '<br>');
}
function sevOf(r) { return r.probability * r.impact; }
function sevClass(s) { return s >= 16 ? 'hi' : s >= 9 ? 'mid' : 'lo'; }

/* ------------------------------------------------------------------ api --- */

async function api(path, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(state.programId ? { 'X-PMO-Program': String(state.programId) } : {}),
    ...(opts.headers || {}),
  };
  const res = await fetch(path, {
    ...opts,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== '/api/auth/login') {
    if (state.me) {
      state.me = null;
      renderLogin('登录状态已失效，请重新登录');
    }
    throw new Error('未登录');
  }
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast${kind === 'err' ? ' toast--err' : ''}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 320);
  }, 2800);
}

let scrollMemory = 0;
async function reload({ keepScroll = true } = {}) {
  if (keepScroll) scrollMemory = window.scrollY;
  const [data, resources] = await Promise.all([api('/api/bootstrap'), api('/api/resources')]);
  state.data = data;
  state.resources = resources;
  if (data.currentProgramId) {
    state.programId = data.currentProgramId;
    try { localStorage.setItem('pmo.program', String(state.programId)); } catch { /* ignore */ }
  }
  state.report = null;
  state.pmUsers = null;
  state.me = data.me || state.me;
  if (data.workflow) {
    state.dlv.week = state.dlv.week || data.workflow.week;
    state.dlv.plan = state.dlv.plan || data.workflow.quarter;
    state.planPeriod = state.planPeriod || data.workflow.quarter;
  }
  await render();
  if (keepScroll) requestAnimationFrame(() => window.scrollTo(0, scrollMemory));
}

/* --------------------------------------------------------------- router --- */

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '') || 'overview';
  const seg = raw.split('/').filter(Boolean);
  if (seg[0] === 'write' && seg.length >= 4) {
    return { route: 'write', params: { kind: seg[1], projectId: Number(seg[2]), period: seg.slice(3).join('/') } };
  }
  const [head, id] = seg;
  const known = ['overview', 'my-tasks', 'projects', 'timeline', 'process', 'milestones', 'risks', 'gates', 'resources', 'report', 'settings', 'deliverables', 'admin', 'help', 'ai', 'meeting', 'supplies'];
  if (head === 'settings') return { route: 'admin', params: {} };
  if (!known.includes(head)) return { route: 'overview', params: {} };
  if (head === 'projects' && id) {
    const tab = seg[2] && PROJECT_TABS.some((t) => t.id === seg[2]) ? seg[2] : 'overview';
    return { route: 'project', params: { id: Number(id), tab } };
  }
  return { route: head, params: {} };
}

function navTo(hash) {
  if (location.hash === hash) return;
  location.hash = hash;
}

function renderNav() {
  const s = state.data?.stats;
  const wf = state.data?.workflow;
  const todo = state.me?.role === 'pmo' ? (wf?.pendingReviews || 0) : (wf?.myTodo || 0);
  const items = [
    { id: 'overview', icon: 'overview', label: '项目群总览', idx: '01' },
    { id: 'my-tasks', icon: 'tasks', label: '我的待办', idx: '02', count: todo || null, warn: todo > 0 },
    { id: 'projects', icon: 'projects', label: '项目台账', idx: '03', count: s?.total },
    { id: 'timeline', icon: 'timeline', label: '项目时间轴', idx: '04' },
    { id: 'process', icon: 'process', label: '过程管理', idx: '05' },
    { id: 'milestones', icon: 'milestones', label: '里程碑', idx: '06', count: s?.overdueMs.length || null, warn: true },
    { id: 'risks', icon: 'risks', label: '风险与问题', idx: '07', count: s?.openRisks },
    { id: 'gates', icon: 'gates', label: '阶段关口', idx: '08', count: s?.pendingGates || null, warn: s?.overdueGates?.length > 0 },
    { id: 'deliverables', icon: 'deliverables', label: '计划与周报', idx: '09' },
    { id: 'resources', icon: 'resources', label: '资源负载', idx: '10' },
    { sep: true },
    { id: 'report', icon: 'report', label: '报表输出', idx: '11' },
    { id: 'admin', icon: 'admin', label: '管理维护', idx: '12' },
    { id: 'help', icon: 'help', label: '帮助与知识库', idx: '13' },
    { id: 'ai', icon: 'ai', label: 'AI 助手', idx: '14' },
    { id: 'meeting', icon: 'meeting', label: '会议室预订', idx: '15' },
    { id: 'supplies', icon: 'supply', label: '办公用品', idx: '16' },
  ];
  $('#rail-nav').innerHTML = items.map((it) => {
    if (it.sep) return '<div class="nav-sep"></div>';
    const active = state.route === it.id
      || (state.route === 'project' && it.id === 'projects')
      || (state.route === 'write' && it.id === 'deliverables');
    return `<a class="nav-item${active ? ' is-active' : ''}" href="#/${it.id}" data-tip="${esc(it.label)}" aria-label="${esc(it.label)}" ${active ? 'aria-current="page"' : ''}>
      <span class="nav-ico" aria-hidden="true">${NAV_ICONS[it.icon] || ''}</span><span class="lbl">${it.label}</span>
      ${it.count ? `<span class="cnt${it.warn && it.count ? ' is-warn' : ''}">${it.count}</span>` : ''}
    </a>`;
  }).join('');

  const p = state.data?.program;
  $('#rail-program-name').textContent = p ? p.name : '—';
  const switchEl = document.getElementById('rail-program-switch');
  if (switchEl) {
    const programs = state.data?.programs || [];
    switchEl.innerHTML = programs.length > 1
      ? `<label class="rail-switch-label" for="program-select">项目群</label><select id="program-select" class="rail-switch-select" aria-label="切换项目群">${programs.map((x) => `<option value="${x.id}" ${x.id === state.programId ? 'selected' : ''}>${esc(x.code)} ${esc(x.name)}</option>`).join('')}</select>`
      : '';
    switchEl.style.display = programs.length > 1 ? '' : 'none';
  }
  $('#rail-date').textContent = today().replace(/-/g, '.');

  const me = state.me;
  const userEl = $('#rail-user');
  if (userEl && me) {
    userEl.innerHTML = `<span class="avatar avatar--sm">${esc(me.name.slice(0, 1))}</span>
      <div class="rail-user-info"><b>${esc(me.name)}</b><span>${esc(roleText(me.role, me.party))}</span></div>
      <button class="rail-logout" data-action="password" title="修改密码" aria-label="修改密码">${ICONS.key}</button>
      <button class="rail-logout" data-action="logout" title="退出登录" aria-label="退出登录">${ICONS.logout}</button>`;
  } else if (userEl) {
    userEl.innerHTML = '';
  }
}

/* ---------------------------------------------------------------- rail --- */

const RAIL_KEY = 'pmo.rail.collapsed';
let railTipEl = null;

function hideRailTip() {
  if (railTipEl) {
    railTipEl.remove();
    railTipEl = null;
  }
}

function showRailTip(item) {
  if (!document.body.classList.contains('is-rail-collapsed') || !item?.dataset.tip) return;
  hideRailTip();
  const tip = document.createElement('div');
  tip.className = 'rail-tip';
  tip.textContent = item.dataset.tip;
  document.body.append(tip);
  const r = item.getBoundingClientRect();
  const top = Math.max(8, Math.min(window.innerHeight - tip.offsetHeight - 8, r.top + r.height / 2 - tip.offsetHeight / 2));
  tip.style.left = `${r.right + 10}px`;
  tip.style.top = `${top}px`;
  railTipEl = tip;
}

document.addEventListener('pointerover', (e) => {
  const item = e.target.closest('.nav-item');
  if (item) showRailTip(item);
  else if (!e.target.closest('.rail-tip')) hideRailTip();
});
document.addEventListener('pointerout', (e) => {
  if (e.target.closest('.nav-item') && !e.relatedTarget?.closest?.('.nav-item')) hideRailTip();
});
window.addEventListener('scroll', hideRailTip, true);
window.addEventListener('resize', hideRailTip);

function setRailCollapsed(collapsed, persist = true) {
  hideRailTip();
  document.body.classList.toggle('is-rail-collapsed', Boolean(collapsed));
  const btn = document.getElementById('rail-toggle');
  if (btn) {
    const label = collapsed ? '展开侧栏' : '收起侧栏';
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }
  if (persist) {
    try { localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0'); } catch { /* 本地存储禁用时只影响记忆 */ }
  }
}

function initRail() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(RAIL_KEY) === '1'; } catch { collapsed = false; }
  setRailCollapsed(collapsed, false);
}

/* ------------------------------------------------------------- fragments --- */

function ragChip(rag, extra = '') {
  return `<span class="rag rag--${rag}"><i></i>${ragLabel(rag)}${extra}</span>`;
}

function track(value, { expected = null, tone = '', max = 100 } = {}) {
  const w = Math.max(0, Math.min(100, (value / max) * 100));
  return `<div class="track"><div class="track__fill ${tone}" style="width:${w}%"></div>
    ${expected != null ? `<div class="track__tick" style="left:${Math.max(0, Math.min(100, (expected / max) * 100))}%"></div>` : ''}
  </div>`;
}

function trackRow(value, opts = {}) {
  return `<div class="track-wrap">${track(value, opts)}<span class="track-val">${opts.label ?? `${Math.round(value)}%`}</span></div>`;
}

function scoreRing(score, rag) {
  const c = 2 * Math.PI * 50;
  const color = rag === 'green' ? 'var(--jade)' : rag === 'amber' ? 'var(--ochre)' : 'var(--oxblood)';
  return `<div class="score-ring" title="综合健康度 ${score} 分">
    <svg width="112" height="112" viewBox="0 0 112 112" aria-hidden="true">
      <circle cx="56" cy="56" r="50" fill="none" stroke="var(--rule-soft)" stroke-width="2"/>
      <circle cx="56" cy="56" r="50" fill="none" stroke="${color}" stroke-width="2"
        stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - score / 100)}" stroke-linecap="butt"/>
    </svg>
    <div class="val">${score}<small>健康度</small></div>
  </div>`;
}

function pageHead({ eyebrow, title, sub, actions = '' }) {
  return `<header class="page-head">
    <div>
      <div class="eyebrow">${eyebrow}</div>
      <h1 class="page-title">${title}</h1>
      ${sub ? `<p class="page-sub">${sub}</p>` : ''}
    </div>
    ${actions ? `<div class="page-actions">${actions}</div>` : ''}
  </header>`;
}

function emptyProgramView(eyebrow, title, sub, actions = '') {
  return `<div class="view-enter">
    ${pageHead({ eyebrow, title, sub, actions })}
    <div class="empty-program">
      <span class="eyebrow">EMPTY PROGRAM <span class="sep">/</span> 0 PROJECTS</span>
      <h2>项目群还是空的</h2>
      <p>演示数据已经清空，现在只剩当前管理员。先建一个项目，再补里程碑、风险和第一份周报。</p>
      <ol>
        <li><span>01</span><b>新建项目</b><p>填项目编号、名称、项目经理、预算和计划窗口。</p></li>
        <li><span>02</span><b>补基础数据</b><p>加里程碑、登记风险，给团队录投入。</p></li>
        <li><span>03</span><b>开始填报</b><p>提交本周周报和本季度计划，PMO 审核后进入项目群汇总。</p></li>
      </ol>
      <div class="empty-program-actions">
        <button class="btn btn--solid" data-action="new-project">新建第一个项目</button>
        <a class="btn btn--quiet" href="#/admin">管理账号</a>
      </div>
    </div>
  </div>`;
}

function emptyRow(cols, text = '没有符合条件的记录') {
  return `<tr><td colspan="${cols}"><div class="empty">${text}</div></td></tr>`;
}

function chipList(text) { return `<span class="chip">${esc(text)}</span>`; }

/* --------------------------------------------------------------- views --- */

function workflowBar() {
  const wf = state.data?.workflow;
  if (!wf || !state.me) return '';
  const w = wf.weekStats;
  const me = state.me;
  const cta = me.role === 'pmo'
    ? (wf.pendingReviews ? `待你审核 ${wf.pendingReviews} 份` : '查看填报情况')
    : (wf.myTodo ? `你还有 ${wf.myTodo} 个项目待提交` : '去填报');
  return `<a class="workflow-bar" href="#/deliverables">
    <span class="workflow-kicker">本周填报</span>
    <span class="workflow-nums">
      <span><b>${w.approved}</b>已通过</span><i></i>
      <span><b>${w.submitted}</b>待审核</span><i></i>
      <span><b>${w.rejected}</b>退回</span><i></i>
      <span><b>${w.missing + w.draft}</b>未提交</span>
      ${wf.slaOverdue ? `<i></i><span class="sla-inline"><b>${wf.slaOverdue}</b>审核超时</span>` : ''}
    </span>
    <span class="workflow-cta">${cta} →</span>
  </a>`;
}

function overviewAIHTML(brief, projects) {
  if (!brief) return '';
  const picked = [];
  const seen = new Set();
  for (const x of brief.items || []) {
    if (seen.has(x.project_id)) continue;
    seen.add(x.project_id);
    picked.push(x);
    if (picked.length >= 6) break;
  }
  const items = picked;
  return `<section class="panel overview-ai" aria-labelledby="overview-ai-title">
    <div class="panel-head">
      <h2 id="overview-ai-title"><span class="no">AI</span>项目群助手 · 当前要处理</h2>
      <span class="hint">${esc(brief.summary || '')}</span>
    </div>
    <div class="overview-ai-grid">
      <div>
        <div class="overview-ai-list">
          ${items.length ? items.map((x) => `<a class="overview-ai-item overview-ai-item--${esc(x.level)}" href="#/projects/${x.project_id}/ai">
            <span class="overview-ai-priority">${esc(x.priority)}</span>
            <span class="overview-ai-body">
              <span class="overview-ai-project">${esc(x.project_code)} · ${esc(x.project_name)}</span>
              <span class="overview-ai-meta">${esc(x.category)} · ${esc((x.audience || []).join(' / '))} · ${esc(briefDueLabel(x.due_date))}</span>
              <b>${esc(x.title)}</b>
              <span class="overview-ai-detail">${esc(x.detail)}</span>
              <span class="overview-ai-go">打开项目 AI →</span>
            </span>
          </a>`).join('') : '<div class="help-empty"><b>当前没有明显待办</b><p>各项目的周报、计划、关口和风险暂时没有需要立即处理的事项。</p></div>'}
        </div>
        <p class="dlv-note">按项目当前数据汇总 P0/P1 优先事项；点一条进入对应项目的 AI 助手。</p>
      </div>
      <div class="overview-ai-console">
        <div class="panel-head"><h3>就地提问</h3><span class="hint">选一个项目</span></div>
        <label class="overview-ai-select">项目
          <select id="overview-ai-project" aria-label="选择项目">
            ${projects.map((p) => `<option value="${p.id}">${esc(p.code)} ${esc(p.name)}</option>`).join('')}
          </select>
        </label>
        <div class="overview-ai-buttons">
          <button class="btn btn--sm btn--quiet" data-action="overview-ai-run" data-mode="actions">现在该做什么</button>
          <button class="btn btn--sm btn--quiet" data-action="overview-ai-run" data-mode="summary">项目摘要</button>
          <button class="btn btn--sm btn--quiet" data-action="overview-ai-run" data-mode="risks">风险建议</button>
          <button class="btn btn--sm btn--quiet" data-action="overview-ai-run" data-mode="weekly">周报草稿</button>
        </div>
        <textarea id="overview-ai-question" rows="3" aria-label="向项目 AI 提问" placeholder="问这个项目，例如：当前最该盯的三件事是什么？"></textarea>
        <button class="btn btn--sm btn--solid overview-ai-ask" data-action="overview-ai-ask">提问</button>
        <div id="overview-ai-result" class="md-preview overview-ai-result" aria-live="polite"><p class="md-empty">选一个项目，先看摘要、风险或直接提问。生成结果不会自动写入。</p></div>
      </div>
    </div>
  </section>`;
}

async function viewOverview() {
  const d = state.data;
  const s = d.stats;
  const projects = d.projects;
  const program = d.program;
  let overviewAI = null;
  try { overviewAI = await api('/api/overview/ai'); } catch { overviewAI = null; }
  const percent = (x) => Math.round(x * 100);

  const week = weekOfYear(parse(today()));
  const quarter = Math.floor(parse(today()).getMonth() / 3) + 1;

  if (!s.total) {
    return emptyProgramView(
      `PROGRAM CONTROL DESK <span class="sep">/</span> 2026 Q${quarter} <span class="sep">/</span> 第 ${week} 周 <span class="sep">/</span> ${program.code}`,
      '项目群<em>控制台</em>',
      `${esc(program.objective)}<br>数据截至 ${today()} ${weekday(today())} · 项目群负责人 ${esc(program.owner)}`
    );
  }

  const kpis = [
    {
      label: '在管项目',
      value: s.total,
      unit: '个',
      note: `执行中 ${s.active} · 规划中 ${s.planning} · 验收 ${s.closing}`,
      bar: 1,
    },
    {
      label: '预算加权进度',
      value: s.weightedProgress,
      unit: '%',
      note: `按预算加权，非简单平均`,
      bar: s.weightedProgress / 100,
    },
    {
      label: '预算执行率',
      value: percent(s.burnRate),
      unit: '%',
      note: `已支出 ${money(s.totalSpent)} / ${money(s.totalBudget)} 万元`,
      bar: s.burnRate,
    },
    {
      label: '健康度分布',
      value: `${s.ragCount.green}·${s.ragCount.amber}·${s.ragCount.red}`,
      unit: '',
      note: `绿 ${s.ragCount.green} · 黄 ${s.ragCount.amber} · 红 ${s.ragCount.red}`,
      bar: 1,
    },
    {
      label: '逾期里程碑',
      value: s.overdueMs.length,
      unit: '个',
      note: s.overdueMs.length ? `最久逾期 ${Math.max(...s.overdueMs.map((m) => Math.abs(daysDiff(m.due_date, today()))))} 天` : '全部按期',
      bar: 1,
    },
    {
      label: '风险敞口',
      value: s.exposure,
      unit: '点',
      note: `未关闭 ${s.openRisks} 项 · 高敞口 ${s.highRisks} 项`,
      bar: Math.min(1, s.exposure / 220),
    },
  ];

  const pulse = `<section class="pulse" aria-label="关键指标">
    ${kpis.map((k) => `<div class="pulse-cell">
      <span class="pulse-label">${k.label}</span>
      <div class="pulse-value">${k.value}<span class="unit">${k.unit}</span></div>
      <span class="pulse-note">${k.note}</span>
    </div>`).join('')}
  </section>`;

  const sorted = [...projects].sort((a, b) => a.health.score - b.health.score);
  const healthTable = `<table class="ledger ledger--fixed">
    <thead><tr>
      <th style="width:31%">项目</th><th style="width:9%">阶段</th><th style="width:23%">进度 / 计划应到</th>
      <th style="width:17%">预算执行</th><th style="width:17%">健康度</th><th style="width:3%"></th>
    </tr></thead>
    <tbody>
    ${sorted.map((p, i) => `<tr class="is-link fade-row" style="--i:${i}" data-href="#/projects/${p.id}">
      <td class="c-project">
        <span class="pcode">${esc(p.code)}${p.priority === 'P0' ? ' · P0' : ''}</span>
        <span class="pname">${esc(p.name)}</span>
      </td>
      <td class="c-stage cell-nowrap"><span class="muted" style="font-size:11.5px">${esc(p.stage)}</span></td>
      <td class="c-progress">${trackRow(p.progress, { expected: p.health.expected })}</td>
      <td class="c-budget">${trackRow(Math.round(p.burnRate * 100), { tone: 'track__fill--budget', label: pct(p.burnRate) })}</td>
      <td class="c-health"><div style="display:flex;align-items:center;gap:10px">
        ${ragChip(p.health.rag)}<span class="num" style="font-size:14px;margin-left:auto">${p.health.score}</span>
      </div></td>
      <td class="right c-arrow"><span class="row-arrow">→</span></td>
    </tr>`).join('')}
    </tbody>
  </table>
  <div class="track-legend">
    <span><i></i>已完成进度</span>
    <span><i class="tick"></i>计划应到位置</span>
    <span><i style="background:var(--ink-3)"></i>预算消耗</span>
  </div>`;

  const msItems = (s.upcoming || []).map((m) => ({
    type: 'ms', date: m.due_date, title: m.name, project: m.project?.name || '', owner: m.owner || '待定',
  }));
  const gateItems = (d.gates || [])
    .filter((g) => g.status === '待评审' && g.planned_date <= shiftFromToday(14))
    .map((g) => ({ type: 'gate', date: g.planned_date, title: g.name, project: g.project?.name || '', owner: g.reviewer || '待 PMO 评审' }));
  const upcomingMerged = [...msItems, ...gateItems].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 7);
  const upcomingList = upcomingMerged.length
    ? upcomingMerged.map((x) => `<div class="ms-item${x.date < today() ? ' ms-item--overdue' : ''}">
        <div class="ms-date"><span class="d">${x.date.slice(8, 10)}</span><span class="m">${Number(x.date.slice(5, 7))}月</span></div>
        <div class="ms-body">
          <p class="ms-title">${esc(x.title)}</p>
          <div class="ms-meta"><span class="type-tag">${x.type === 'gate' ? '关口' : '里程碑'}</span><span>${esc(x.project)}</span><i class="dot"></i><span>${esc(x.owner)}</span></div>
        </div>
        <span class="chip ${x.date < today() ? 'chip--oxblood' : 'chip--dashed'}">${relDays(x.date)}</span>
      </div>`).join('')
    : '<div class="empty">未来 14 天没有到期节点</div>';

  const danger = sorted.filter((p) => p.health.rag !== 'green').slice(0, 4);
  const scoreRanked = [...projects].sort((a, b) => b.score.score - a.score.score || a.code.localeCompare(b.code));
  const scorePanel = `<section class="panel score-panel">
    <div class="panel-head">
      <h2><span class="no">05</span>组合优先级</h2>
      <span class="hint">战略 30% · 收益 30% · 可行 20% · 风险 10% · 投入 10%</span>
    </div>
    <div class="score-list">
      ${scoreRanked.map((p, i) => `<div class="score-row">
        <span class="score-rank">${String(i + 1).padStart(2, '0')}</span>
        <div class="score-info"><b>${esc(p.code)} · ${esc(p.name)}</b><span>${esc(p.score.notes || '尚未填写评分说明')}</span></div>
        <div class="score-dims">战略 ${p.score.strategic} · 收益 ${p.score.benefit} · 可行 ${p.score.feasibility} · 风险 ${p.score.risk} · 投入 ${p.score.effort}</div>
        <div class="score-bar"><i style="width:${p.score.score}%"></i><b>${p.score.score}</b></div>
        ${state.me.role === 'pmo' ? `<button class="btn btn--sm btn--quiet" data-action="score-edit" data-id="${p.id}">调整</button>` : ''}
      </div>`).join('')}
    </div>
  </section>`;
  // renumber existing panels below
  const scoreInsert = scorePanel;
  const snaps = d.snapshots || [];
  const latest = snaps[snaps.length - 1] || null;
  const prev = snaps[snaps.length - 2] || null;
  const deltaText = (key, suffix = '', scale = 1) => {
    if (!latest || !prev) return '—';
    const diff = Math.round((latest[key] - prev[key]) * scale * 100) / 100;
    if (!diff) return '持平';
    return `${diff > 0 ? '+' : ''}${diff}${suffix}`;
  };
  const trendRows = snaps.slice(-8).map((x) => `<tr>
    <td class="mono-sm">${x.week_start.slice(5)}</td>
    <td class="mono-sm">${x.progress}%</td>
    <td class="mono-sm">${x.healthAvg}</td>
    <td class="mono-sm">${x.exposure}</td>
    <td class="mono-sm">${Math.round(x.burnRate * 100)}%</td>
    <td class="mono-sm">${x.benefitAvg}%</td>
    <td>${x.source === 'seed' ? '<span class="chip chip--dashed">演示</span>' : '<span class="chip chip--jade">实测</span>'}</td>
  </tr>`).join('');
  const snapshotPanel = `<section class="panel">
    <div class="panel-head">
      <h2><span class="no">06</span>指标趋势</h2>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="hint">${snaps.length ? `最近 ${snaps.length} 周` : '还没有快照'}</span>
        ${state.me.role === 'pmo' ? '<button class="btn btn--sm btn--quiet" data-action="snapshot-now">记录本周快照</button>' : ''}
      </div>
    </div>
    ${latest ? `<div class="trend-cards">
      <div><span>加权进度</span><b>${latest.progress}%</b><i>较上周 ${deltaText('progress', ' pt')}</i></div>
      <div><span>平均健康</span><b>${latest.healthAvg}</b><i>较上周 ${deltaText('healthAvg', ' 分')}</i></div>
      <div><span>风险敞口</span><b>${latest.exposure}</b><i>较上周 ${deltaText('exposure', ' 点')}</i></div>
      <div><span>预算执行</span><b>${Math.round(latest.burnRate * 100)}%</b><i>较上周 ${deltaText('burnRate', ' pt', 100)}</i></div>
    </div>
    <table class="ledger ledger--fixed">
      <thead><tr><th style="width:14%">周</th><th>加权进度</th><th>平均健康</th><th>风险敞口</th><th>预算执行</th><th>收益达成</th><th style="width:10%">来源</th></tr></thead>
      <tbody>${trendRows || emptyRow(7, '还没有趋势数据')}</tbody>
    </table>
    ${snaps.length < 3 ? '<p class="dlv-note">本周开始记录，后续每周会追加一个点；演示库预置了 6 周历史快照，主库从本周开始积累。</p>' : ''}` : '<div class="empty">还没有快照，点右上角记录本周快照</div>'}
  </section>`;

  const topRisks = [...d.risks]
    .filter((r) => r.status !== '已关闭')
    .sort((a, b) => sevOf(b) - sevOf(a))
    .slice(0, 5);

  const riskList = topRisks.length
    ? topRisks.map((r) => {
      const p = projects.find((x) => x.id === r.project_id);
      const sev = sevOf(r);
      return `<div class="risk-row">
        <div class="risk-sev risk-sev--${sevClass(sev)}"><b>${sev}</b><small>敞口</small></div>
        <div>
          <p class="risk-title">${esc(r.title)}</p>
          <div class="risk-meta"><span>${esc(p?.name || '')}</span><i class="dot"></i><span>${esc(r.owner)}</span><i class="dot"></i><span>${relDays(r.due_date)}</span></div>
        </div>
        <span class="chip">${esc(r.status)}</span>
      </div>`;
    }).join('')
    : '<div class="empty">暂无未关闭风险</div>';

  const events = (d.events || []).slice(0, 8).map((e) => `<div class="note-item">
      <div class="note-head"><b>${esc(e.project_name || '项目群')}</b><span>${esc(e.created_at.slice(5, 16).replace('T', ' '))}</span></div>
      <p class="note-body">${esc(e.message)}</p>
    </div>`).join('') || '<div class="empty">暂无操作记录</div>';

  const actions = `<button class="btn btn--quiet" data-action="export">${ICONS.download}导出备份</button>
    <button class="btn btn--solid" data-action="goto-report">生成本周周报${ICONS.arrow}</button>`;

  return `<div class="view-enter">
    ${pageHead({
      eyebrow: `PROGRAM CONTROL DESK <span class="sep">/</span> 2026 Q${quarter} <span class="sep">/</span> 第 ${week} 周 <span class="sep">/</span> ${program.code}`,
      title: '项目群<em>控制台</em>',
      sub: `${esc(program.objective)}<br>数据截至 ${today()} ${weekday(today())} · 项目群负责人 ${esc(program.owner)}`,
      actions,
    })}
    ${pulse}
    ${workflowBar()}
    ${overviewAIHTML(overviewAI, projects)}

    <div class="split">
      <section class="panel">
        <div class="panel-head">
          <h2><span class="no">01</span>组合健康</h2>
          <span class="hint">按健康度升序 · 点击查看项目</span>
        </div>
        ${healthTable}
      </section>

      <div>
        <section class="panel">
          <div class="panel-head">
            <h2><span class="no">02</span>两周内到期</h2>
            <span class="hint"><a href="#/milestones" style="text-decoration:none">里程碑</a> · <a href="#/gates" style="text-decoration:none">关口</a></span>
          </div>
          ${upcomingList}
        </section>

        <section class="panel">
          <div class="panel-head">
            <h2><span class="no">03</span>需关注</h2>
            <span class="hint">${danger.length} 个</span>
          </div>
          ${danger.length ? danger.map((p) => `<div class="note-item">
            <div class="note-head"><b>${esc(p.code)} ${esc(p.name)}</b><span>${p.health.score}</span></div>
            <p class="note-body">${esc(p.health.reasons[0])}</p>
          </div>`).join('') : '<div class="empty">全部项目处于正常区间</div>'}
        </section>
      </div>
    </div>

    ${scoreInsert}
    ${snapshotPanel}

    <section class="panel">
      <div class="panel-head">
        <h2><span class="no">07</span>项目群时间轴</h2>
        <span class="hint">浅色为计划窗口，实心为实际进度</span>
      </div>
      ${timeline(projects)}
    </section>

    <div class="split split--even">
      <section class="panel">
        <div class="panel-head">
          <h2><span class="no">08</span>高敞口风险</h2>
          <a class="hint" href="#/risks" style="text-decoration:none">风险台账 →</a>
        </div>
        ${riskList}
      </section>
      <section class="panel">
        <div class="panel-head">
          <h2><span class="no">09</span>近期动态</h2>
          <span class="hint">最近 8 条</span>
        </div>
        ${events}
      </section>
    </div>
  </div>`;
}

function timeline(projects) {
  if (!projects.length) return '<div class="empty">暂无项目</div>';
  const starts = projects.map((p) => p.plan_start).filter(Boolean).sort();
  const ends = projects.map((p) => p.plan_end).filter(Boolean).sort();
  let min = starts[0];
  let max = ends[ends.length - 1];
  if (!min || !max) return '<div class="empty">项目缺少计划日期</div>';

  const minD = parse(min);
  minD.setDate(1);
  const maxD = parse(max);
  maxD.setMonth(maxD.getMonth() + 1, 1);
  min = isoDate(minD);
  max = isoDate(maxD);
  const span = Math.max(1, daysDiff(min, max));
  const at = (d) => Math.max(0, Math.min(100, (daysDiff(min, d) / span) * 100));

  const ticks = [];
  const cur = new Date(minD);
  while (cur < maxD) {
    ticks.push({ pct: at(isoDate(cur)), label: `${cur.getMonth() + 1}月`, year: cur.getMonth() === 0 ? `${cur.getFullYear()}` : '' });
    cur.setMonth(cur.getMonth() + 1);
  }

  return `<div class="timeline">
    <div class="tl-scale" style="margin-left:186px">
      ${ticks.map((t) => `<span class="tl-tick" style="left:${t.pct}%"><i></i><b>${t.label}</b></span>`).join('')}
      <span class="tl-now" style="left:${at(today())}%"><em>今天</em></span>
    </div>
    ${projects.map((p) => {
    const left = at(p.plan_start);
    const width = Math.max(0.6, at(p.plan_end) - left);
    const done = p.stage === '已结项' ? 100 : Math.max(0, Math.min(100, p.progress));
    const tone = p.health.rag === 'green' ? 'var(--jade)' : p.health.rag === 'amber' ? 'var(--ochre)' : 'var(--oxblood)';
    return `<div class="tl-row" data-href="#/projects/${p.id}">
      <div class="tl-name"><span class="pcode">${esc(p.code)}</span> ${esc(p.name)}</div>
      <div class="tl-track">
        <span class="tl-bar" style="left:${left}%;width:${width}%"></span>
        <span class="tl-fill" style="left:${left}%;width:${(width * done) / 100}%;background:${tone}"></span>
        <span class="tl-dot" style="left:${at(today())}%"></span>
      </div>
    </div>`;
  }).join('')}
  </div>
  <div class="track-legend" style="margin-left:186px"><span><i class="tick"></i>今天</span><span>浅色为该项目的计划起止窗口，实心为实际进度</span></div>`;
}

/* ------------------------------------------------------------- timeline --- */

function ganttRange(projects) {
  const starts = projects.map((p) => p.plan_start).filter(Boolean).sort();
  const ends = projects.map((p) => p.plan_end).filter(Boolean).sort();
  const start = parse(starts[0]);
  start.setDate(1);
  const end = parse(ends[ends.length - 1]);
  end.setMonth(end.getMonth() + 1, 0);
  const startIso = isoDate(start);
  const endIso = isoDate(end);
  return { start: startIso, end: endIso, days: daysDiff(startIso, endIso) + 1 };
}

function ganttColor(rag) {
  return rag === 'green' ? 'var(--jade)' : rag === 'amber' ? 'var(--ochre)' : 'var(--oxblood)';
}

function viewTimeline() {
  const me = state.me;
  const g = state.gantt;
  const all = state.data.projects;
  let projects = all.filter((p) => g.stage === '全部' || p.stage === g.stage);
  if (g.onlyMine) projects = projects.filter((p) => me.projects.includes(p.id));
  projects = projects.slice().sort((a, b) => a.plan_start.localeCompare(b.plan_start));
  state.ganttKey = `${g.zoom}:${g.stage}:${g.onlyMine}`;

  const stages = ['全部', '执行中', '规划中', '验收中', '已结项'];
  const controls = `<div class="gantt-controls">
    <div class="gantt-zoom" role="group" aria-label="时间粒度">
      ${[['week', '周'], ['month', '月'], ['quarter', '季']].map(([v, l]) => `<button class="${g.zoom === v ? 'is-on' : ''}" data-action="gantt-zoom" data-value="${v}">${l}</button>`).join('')}
    </div>
    <div class="filters">${stages.map((x) => `<button class="filter${g.stage === x ? ' is-on' : ''}" data-action="gantt-stage" data-value="${x}">${x}</button>`).join('')}</div>
    <div class="gantt-toggles">
      <button class="dlv-mine ${g.onlyMine ? 'is-on' : ''}" data-action="gantt-mine" aria-pressed="${g.onlyMine}">只看我的</button>
      <button class="dlv-mine ${g.showDeps ? 'is-on' : ''}" data-action="gantt-deps" aria-pressed="${g.showDeps}">显示依赖</button>
      <button class="btn btn--sm btn--quiet" data-action="gantt-today">回到今天</button>
    </div>
  </div>`;

  if (!all.length) {
    return emptyProgramView('TIMELINE <span class="sep">/</span> GANTT', '项目时间轴', '按时间查看项目群的全部计划窗口、实际进度和依赖关系。');
  }
  if (!projects.length) {
    return `<div class="view-enter">
      ${pageHead({ eyebrow: 'TIMELINE <span class="sep">/</span> GANTT', title: '项目时间轴', sub: '按时间查看项目群的全部计划窗口、实际进度和依赖关系。' })}
      ${controls}
      <div class="empty" style="padding:70px 0">当前筛选下没有项目</div>
    </div>`;
  }

  const range = ganttRange(all);
  const dw = g.zoom === 'week' ? 15 : g.zoom === 'quarter' ? 3.4 : 7;
  const width = Math.max(680, Math.round(range.days * dw));
  const rowH = 44;
  const headH = 58;
  const at = (d) => Math.round(daysDiff(range.start, d) * dw);
  const todayX = Math.max(0, Math.min(width, at(today())));
  state.ganttTodayX = todayX;

  const months = [];
  let cursor = parse(range.start);
  while (isoDate(cursor) <= range.end) {
    const next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    const nextIso = isoDate(next) > range.end ? addDays(range.end, 1) : isoDate(next);
    months.push({
      label: `${cursor.getMonth() + 1} 月`,
      year: cursor.getMonth() === 0 ? String(cursor.getFullYear()) : '',
      left: at(isoDate(cursor)),
      width: Math.max(1, daysDiff(isoDate(cursor), nextIso) * dw),
    });
    cursor = next;
  }

  const ticks = [];
  let tickDate = parse(range.start);
  tickDate.setDate(tickDate.getDate() + ((1 - tickDate.getDay() + 7) % 7));
  while (isoDate(tickDate) <= range.end) {
    const iso = isoDate(tickDate);
    ticks.push({ left: at(iso), label: g.zoom === 'week' ? `${Number(iso.slice(5, 7))}.${iso.slice(8, 10)}` : '' });
    tickDate.setDate(tickDate.getDate() + 7);
  }

  const weekends = [];
  if (g.zoom === 'week') {
    const day = parse(range.start);
    while (isoDate(day) <= range.end) {
      const wd = day.getDay();
      if (wd === 0 || wd === 6) weekends.push(`<span class="gantt-weekend" style="left:${at(isoDate(day))}px;width:${dw}px"></span>`);
      day.setDate(day.getDate() + 1);
    }
  }

  const byId = new Map(projects.map((p, i) => [p.id, i]));
  const rows = projects.map((p, i) => {
    const left = at(p.plan_start);
    const barW = Math.max(4, at(p.plan_end) - left);
    const fillW = Math.max(0, (barW * p.progress) / 100);
    const marker = state.data.milestones
      .filter((m) => m.project_id === p.id && m.due_date >= range.start && m.due_date <= range.end)
      .map((m) => {
        const cls = m.status === '已完成' ? 'is-done' : m.due_date < today() ? 'is-late' : '';
        return `<span class="gantt-ms ${cls}" style="left:${at(m.due_date) - 4}px" title="${esc(m.name)} · ${m.due_date} · ${esc(m.status)}"></span>`;
      }).join('');
    return `<div class="gantt-row" data-href="#/projects/${p.id}">
      <span class="gantt-plan" style="left:${left}px;width:${barW}px"></span>
      <span class="gantt-fill" style="left:${left}px;width:${fillW}px;background:${ganttColor(p.health.rag)}"></span>
      <span class="gantt-label" style="left:${left + barW + 8}px">${p.progress}%</span>
      ${marker}
    </div>`;
  }).join('');

  const aside = projects.map((p) => `<div class="gantt-aside-row" data-href="#/projects/${p.id}">
    <span class="rag-dot" style="background:${ganttColor(p.health.rag)}"></span>
    <div class="gantt-pname"><b>${esc(p.name)}</b><span>${esc(p.code)} · ${esc(p.priority)}</span></div>
    <span class="gantt-pm">${esc(p.pm || '—')}</span>
  </div>`).join('');

  const depRows = (state.data.dependencies || []).filter((d) => byId.has(d.from_project_id) && byId.has(d.to_project_id));
  const depSvg = g.showDeps && depRows.length
    ? `<svg class="gantt-deps" width="${width}" height="${projects.length * rowH}" viewBox="0 0 ${width} ${projects.length * rowH}" aria-hidden="true">
        <defs>
          <marker id="dep-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8z" fill="var(--ink-4)"/></marker>
          <marker id="dep-arrow-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8z" fill="var(--oxblood)"/></marker>
        </defs>
        ${depRows.map((d) => {
          const y1 = byId.get(d.from_project_id) * rowH + rowH / 2;
          const y2 = byId.get(d.to_project_id) * rowH + rowH / 2;
          const x1 = at(d.due_date || d.from.plan_end);
          const targetDate = d.to.nextMilestone?.due_date || d.to.plan_end;
          const x2 = at(targetDate);
          const dx = Math.max(22, Math.min(70, Math.abs(x2 - x1) / 2));
          const color = d.status === '受阻' ? 'var(--oxblood)' : d.status === '已解除' ? 'var(--jade)' : 'var(--ink-4)';
          const path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
          return `<circle cx="${x1}" cy="${y1}" r="3" fill="var(--paper)" stroke="${color}" stroke-width="1.2"/>
            <path d="${path}" fill="none" stroke="var(--paper)" stroke-width="3.6" stroke-linecap="round" opacity=".85"/>
            <path d="${path}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linecap="round" marker-end="url(#${d.status === '受阻' ? 'dep-arrow-bad' : 'dep-arrow'})"><title>${esc(d.from.code)} → ${esc(d.to.code)} · ${esc(d.title)}（${esc(d.status)}）</title></path>`;
        }).join('')}
      </svg>`
    : '';

  const depList = depRows.length
    ? depRows.map((d) => `<div class="dep-row" data-action="dep-open" data-id="${d.id}">
        <div class="dep-path"><span class="pcode">${esc(d.from.code)}</span><i>→</i><span class="pcode">${esc(d.to.code)}</span></div>
        <div class="dep-name"><b>${esc(d.title)}</b><span>${esc(d.from.name)} → ${esc(d.to.name)}</span></div>
        <span class="chip ${d.status === '受阻' ? 'chip--oxblood' : d.status === '已解除' ? 'chip--jade' : 'chip--dashed'}">${esc(d.status)}</span>
        <span class="dep-meta">${esc(d.owner || '—')} · ${relDays(d.due_date)}</span>
      </div>`).join('')
    : '<div class="empty">暂无跨项目依赖</div>';

  const red = projects.filter((p) => p.health.rag === 'red').length;
  const avg = Math.round(projects.reduce((sum, p) => sum + p.progress, 0) / projects.length);

  return `<div class="view-enter">
    ${pageHead({
      eyebrow: 'TIMELINE <span class="sep">/</span> GANTT',
      title: '项目时间轴',
      sub: '按时间看项目群的计划窗口、实际进度和跨项目依赖。竖线是今天，菱形是里程碑；拖拽横向滚动可以看完整周期。',
      actions: `<span class="role-pill">${projects.length} 个项目 · 平均进度 ${avg}%${red ? ` · <b style="color:var(--oxblood)">${red} 个预警</b>` : ''}</span>`,
    })}
    ${controls}

    <div class="gantt-shell">
      <div class="gantt-aside">
        <div class="gantt-aside-head"><span>项目 / 负责人</span></div>
        ${aside}
      </div>
      <div class="gantt-scroll" id="gantt-scroll">
        <div class="gantt-canvas" style="width:${width}px">
          <div class="gantt-head" style="height:${headH}px">
            <div class="gantt-months">${months.map((m) => `<span class="gantt-month" style="left:${m.left}px;width:${m.width}px">${m.label}${m.year ? `<b>${m.year}</b>` : ''}</span>`).join('')}</div>
            <div class="gantt-ticks">${ticks.map((t) => `<span class="gantt-tick" style="left:${t.left}px">${t.label ? `<i>${t.label}</i>` : ''}</span>`).join('')}</div>
            <span class="gantt-today-flag" style="left:${todayX}px">今天 ${today().slice(5).replace('-', '.')}</span>
          </div>
          <div class="gantt-body" style="height:${projects.length * rowH}px">
            ${weekends.join('')}
            ${months.map((m) => `<span class="gantt-grid" style="left:${m.left}px"></span>`).join('')}
            ${rows}
            ${depSvg}
            <span class="gantt-today" style="left:${todayX}px"></span>
          </div>
        </div>
      </div>
    </div>

    <div class="gantt-legend">
      <span><i class="lg-plan"></i>计划窗口</span>
      <span><i class="lg-fill"></i>实际进度</span>
      <span><i class="lg-ms"></i>里程碑</span>
      <span><i class="lg-today"></i>今天</span>
      <span><i class="lg-dep"></i>依赖（红线表示受阻）</span>
      <span class="gantt-scale-note">${range.start} ~ ${range.end} · ${g.zoom === 'week' ? '周' : g.zoom === 'quarter' ? '季' : '月'}视图</span>
    </div>

    <section class="panel" style="margin-top:34px">
      <div class="panel-head">
        <h2><span class="no">01</span>跨项目依赖</h2>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="hint">${depRows.length} 条</span>
          ${state.me.role === 'pmo' ? '<button class="btn btn--sm btn--quiet" data-action="dep-new">新增依赖</button>' : ''}
        </div>
      </div>
      ${depList}
    </section>
  </div>`;
}

function scrollGanttToToday() {
  const el = $('#gantt-scroll');
  if (el && state.ganttTodayX != null) {
    el.scrollLeft = Math.max(0, state.ganttTodayX - el.clientWidth * 0.34);
  }
}

function openDependencyModal(dep) {
  const isEdit = Boolean(dep);
  const isPmo = state.me.role === 'pmo';
  const projects = state.data.projects;
  openModal({
    title: isEdit ? '编辑跨项目依赖' : '新增跨项目依赖',
    sub: '依赖描述的是「上游交付什么，下游才能开始」。受阻的依赖会在时间轴上画成红线。',
    wide: true,
    readOnly: !isPmo,
    submit: isEdit ? '保存修改' : '创建依赖',
    onDelete: isEdit && isPmo ? async () => {
      await api(`/api/dependencies/${dep.id}`, { method: 'DELETE' });
      await reload();
      toast('依赖已删除');
    } : null,
    fields: [
      { name: 'from_project_id', label: '上游项目', type: 'select', value: dep?.from_project_id || projects[0]?.id, options: projects.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` })) },
      { name: 'to_project_id', label: '下游项目', type: 'select', value: dep?.to_project_id || projects[1]?.id, options: projects.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` })) },
      { name: 'title', label: '依赖内容', value: dep?.title || '', required: true, placeholder: '如：客户指标口径冻结', full: true },
      { name: 'kind', label: '依赖类型', type: 'select', value: dep?.kind || '完成-开始', options: ['完成-开始', '开始-开始', '完成-完成'] },
      { name: 'status', label: '状态', type: 'select', value: dep?.status || '正常', options: ['正常', '受阻', '已解除'] },
      { name: 'owner', label: '责任人', value: dep?.owner || '' },
      { name: 'due_date', label: '要求完成日期', type: 'date', value: dep?.due_date || addDays(today(), 14) },
      { name: 'impact', label: '影响到什么', type: 'textarea', full: true, value: dep?.impact || '', placeholder: '如果这条依赖延期，下游哪个节点会受影响' },
    ],
    onSubmit: async (v) => {
      if (!isPmo) return;
      v.from_project_id = Number(v.from_project_id);
      v.to_project_id = Number(v.to_project_id);
      if (v.from_project_id === v.to_project_id) throw new Error('上下游不能是同一个项目');
      if (isEdit) await api(`/api/dependencies/${dep.id}`, { method: 'PATCH', body: v });
      else await api('/api/dependencies', { method: 'POST', body: v });
      await reload();
      toast(isEdit ? '依赖已更新' : '依赖已创建');
    },
  });
}

function viewMyTasks() {
  if (!state.data.projects.length) return emptyProgramView('MY WORK <span class="sep">/</span> PMO', '我的待办', '把要审核的、临近的关口和里程碑放在一页。');
  const me = state.me;
  const isPmo = me.role === 'pmo';
  const isClient = me.role === 'pm' && me.party === '甲方';
  const week = state.data.workflow.week;
  const quarter = state.data.workflow.quarter;
  const projects = state.data.projects.filter((p) => isPmo || me.projects.includes(p.id));
  const ids = new Set(projects.map((p) => p.id));
  const tasks = [];

  for (const p of projects) {
    const wr = p.weekReport;
    const plan = p.quarterPlan;
    if (isPmo) {
      if (wr && wr.status === 'submitted') {
        tasks.push({ group: 'review', type: '审核周报', title: `${p.name} · 本周周报`, project: p, due: addHours(wr.submitted_at, 48), submittedAt: wr.submitted_at, href: '#/deliverables', note: `提交人 ${wr.author_name || '—'}` });
      }
      if (plan && plan.status === 'submitted') {
        tasks.push({ group: 'review', type: '审核计划', title: `${p.name} · 季度计划`, project: p, due: addHours(plan.submitted_at, 48), submittedAt: plan.submitted_at, href: '#/deliverables', note: `提交人 ${plan.author_name || '—'}` });
      }
    } else if (isClient) {
      if (wr && ['submitted', 'approved'].includes(wr.status)) {
        tasks.push({ group: 'watch', type: '查看周报', title: `${p.name} · 本周周报`, project: p, due: wr.submitted_at, href: `#/write/weekly/${p.id}/${week}`, note: `${wr.status === 'approved' ? '已通过' : '待审核'} · 提交人 ${wr.author_name || '—'}`, watchStatus: wr.status === 'approved' ? '已通过' : '待审核' });
      }
      if (plan && ['submitted', 'approved'].includes(plan.status)) {
        tasks.push({ group: 'watch', type: '查看计划', title: `${p.name} · 季度计划`, project: p, due: plan.submitted_at, href: `#/write/plan/${p.id}/${quarter}`, note: `${plan.status === 'approved' ? '已通过' : '待审核'} · 提交人 ${plan.author_name || '—'}`, watchStatus: plan.status === 'approved' ? '已通过' : '待审核' });
      }
    } else {
      if (!wr || ['draft', 'rejected'].includes(wr.status)) {
        tasks.push({ group: 'submit', type: '提交周报', title: `${p.name} · 本周周报`, project: p, due: `${week}T23:59:00`, href: `#/write/weekly/${p.id}/${week}`, note: wr?.status === 'rejected' ? '已被退回，需修改重提' : '尚未提交' });
      }
      if (!plan || ['draft', 'rejected'].includes(plan.status)) {
        const due = `${shiftStrClient(quarterStart(quarter), 14)}T18:00:00`;
        tasks.push({ group: 'submit', type: '提交计划', title: `${p.name} · 季度计划`, project: p, due, href: `#/write/plan/${p.id}/${quarter}`, note: plan?.status === 'rejected' ? '已被退回，需修改重提' : '尚未提交' });
      }
    }
  }

  for (const g of state.data.gates) {
    if (!ids.has(g.project_id) || g.status !== '待评审') continue;
    if (g.planned_date > addDays(today(), 30)) continue;
    tasks.push({ group: 'node', type: '关口', title: `${g.project?.name || ''} · ${g.name}`, project: g.project, due: `${g.planned_date}T09:00:00`, href: '#/gates', note: `评审人 ${g.reviewer || '待安排'}` });
  }
  for (const m of state.data.milestones) {
    if (!ids.has(m.project_id) || m.status === '已完成') continue;
    if (m.due_date > addDays(today(), 14) || m.due_date < addDays(today(), -200)) continue;
    const project = state.data.projects.find((p) => p.id === m.project_id);
    tasks.push({ group: 'node', type: '里程碑', title: `${project?.name || ''} · ${m.name}`, project, due: `${m.due_date}T18:00:00`, href: `#/projects/${m.project_id}`, note: m.status });
  }
  for (const r of state.data.risks) {
    if (!ids.has(r.project_id) || r.status === '已关闭') continue;
    if (r.probability * r.impact < 16) continue;
    const project = state.data.projects.find((p) => p.id === r.project_id);
    tasks.push({ group: 'risk', type: '高风险', title: `${project?.name || ''} · ${r.title}`, project, due: `${r.due_date}T18:00:00`, href: `#/projects/${r.project_id}`, note: `敞口 ${r.probability * r.impact} · ${r.owner}` });
  }

  tasks.sort((a, b) => String(a.due).localeCompare(String(b.due)));
  const isLate = (t) => new Date(t.due).getTime() < Date.now();
  const submit = tasks.filter((t) => t.group === 'submit');
  const review = tasks.filter((t) => t.group === 'review');
  const watch = tasks.filter((t) => t.group === 'watch');
  const nodes = tasks.filter((t) => t.group === 'node');
  const risks = tasks.filter((t) => t.group === 'risk');
  const reviewLate = review.filter(isLate).length;
  const submitLate = submit.filter(isLate).length;
  const nodeLate = nodes.filter(isLate).length;

  const row = (t) => {
    const late = t.group !== 'watch' && new Date(t.due).getTime() < Date.now();
    const hours = t.submittedAt ? Math.max(0, Math.floor((Date.now() - new Date(t.submittedAt).getTime()) / 3600000)) : 0;
    const day = String(t.due).slice(0, 10);
    const diff = daysDiff(today(), day);
    const dueText = t.group === 'watch' ? (t.watchStatus || '已提交')
      : t.group === 'review'
        ? `已等待 ${hours}h${late ? ' · 超时' : ''}`
        : diff < 0 ? `逾期 ${Math.abs(diff)} 天` : diff === 0 ? '今天' : `${diff} 天后`;
    return `<a class="task-row" href="${t.href}">
      <span class="task-type">${esc(t.type)}</span>
      <div class="task-main"><b>${esc(t.title)}</b><span>${esc(t.note || '')}</span></div>
      <span class="task-due ${late ? 'is-late' : ''}">${dueText}</span>
      <span class="task-arrow">→</span>
    </a>`;
  };

  const section = (title, items, empty) => `<section class="panel">
    <div class="panel-head"><h2>${title}</h2><span class="hint">${items.length} 项</span></div>
    ${items.length ? items.map(row).join('') : `<div class="empty">${empty}</div>`}
  </section>`;

  return `<div class="view-enter">
    ${pageHead({
      eyebrow: `MY WORK <span class="sep">/</span> ${isPmo ? 'PMO' : isClient ? 'CLIENT PM' : 'VENDOR PM'}`,
      title: '我的待办',
      sub: isPmo
        ? '把要审核的、临近的关口和里程碑放在一页，按截止时间排序。'
        : isClient
          ? '查看乙方提交的周报和计划，关注临近的关口、里程碑和风险；填报由乙方项目经理维护。'
          : '你要提交的周报和计划、临近的关口与里程碑、需要盯的风险，都在这里。',
      actions: `<span class="role-pill">${esc(me.name)} · ${esc(roleText(me.role, me.party))}</span>`,
    })}

    <div class="pulse" style="grid-template-columns:repeat(4,1fr)">
      <div class="pulse-cell"><span class="pulse-label">${isPmo ? '待审核' : isClient ? '待查看' : '待提交'}</span><div class="pulse-value">${isPmo ? review.length : isClient ? watch.length : submit.length}<span class="unit">项</span></div><span class="pulse-note">${isPmo ? (reviewLate ? `${reviewLate} 项已超过 48 小时时限` : '审核都在时限内') : isClient ? (watch.length ? '乙方已提交，等待你查看' : '暂时没有新的提交') : (submitLate ? `${submitLate} 项已过截止时间` : '都在截止时间前')}</span></div>
      <div class="pulse-cell"><span class="pulse-label">临近节点</span><div class="pulse-value">${nodes.length}<span class="unit">项</span></div><span class="pulse-note">${nodeLate ? `${nodeLate} 项已逾期` : '未来 30 天关口与 14 天里程碑'}</span></div>
      <div class="pulse-cell"><span class="pulse-label">高风险</span><div class="pulse-value">${risks.length}<span class="unit">项</span></div><span class="pulse-note">敞口 ≥ 16</span></div>
      <div class="pulse-cell"><span class="pulse-label">涉及项目</span><div class="pulse-value">${projects.length}<span class="unit">个</span></div><span class="pulse-note">${isPmo ? '全项目群' : '你负责的项目'}</span></div>
    </div>

    ${isPmo ? section('待你审核', review, '没有待审核的周报或计划') : isClient ? section('待你查看', watch, '本周没有待查看的提交') : section('待你提交', submit, '本周的周报和计划都已提交')}
    ${section('临近节点', nodes, '未来一个月没有需要处理的关口或里程碑')}
    ${section('高敞口风险', risks, '没有敞口超过 16 的风险')}
  </div>`;
}

function quarterStart(label) {
  const y = Number(label.slice(0, 4));
  const q = Number(label.slice(6));
  return `${y}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
}

function shiftStrClient(day, n) {
  return addDays(day, n);
}

function addHours(iso, hours) {
  return new Date(new Date(iso).getTime() + hours * 3600000).toISOString();
}

function viewProjects() {
  const d = state.data;
  if (!d.projects.length) {
    return emptyProgramView('PORTFOLIO REGISTER <span class="sep">/</span> PROGRAM', '项目台账', '项目群内全部项目的进度、成本、风险与责任人的单一事实来源。');
  }
  const stages = ['全部', '规划中', '执行中', '验收中', '已结项'];
  const counts = {};
  stages.forEach((s) => { counts[s] = s === '全部' ? d.projects.length : d.projects.filter((p) => p.stage === s).length; });

  return `<div class="view-enter">
    ${pageHead({
      eyebrow: `PORTFOLIO REGISTER / ${d.program.code}`,
      title: '项目台账',
      sub: '项目群内全部项目的进度、成本、风险与责任人的单一事实来源。健康度由计划偏差、成本绩效、风险敞口和里程碑逾期综合计算。',
      actions: `<button class="btn btn--quiet" data-action="goto-report">${ICONS.copy}周报</button>
        ${state.me.role === 'pmo' ? `<button class="btn btn--solid" data-action="new-project">${ICONS.plus}新建项目</button>` : ''}`,
    })}

    <div class="toolbar">
      <div class="filters" role="group" aria-label="阶段筛选">
        ${stages.map((s) => `<button class="filter${state.filters.projectStage === s ? ' is-on' : ''}" data-filter="projectStage" data-value="${s}">${s}<span class="n">${counts[s]}</span></button>`).join('')}
      </div>
      <label class="search">
        <span class="sr-only">搜索项目</span>
        ${ICONS.search}
        <input id="proj-search" type="search" placeholder="搜索项目名称 / 编号 / 负责人" value="${esc(state.filters.q)}" />
      </label>
    </div>

    <table class="ledger ledger--fixed" style="margin-top:6px">
      <thead><tr>
        <th style="width:31%">项目 / 负责人</th><th style="width:9%">阶段</th><th style="width:16%">进度</th>
        <th style="width:14%">预算执行</th><th style="width:9%">风险敞口</th><th style="width:17%">健康度</th><th style="width:4%"></th>
      </tr></thead>
      <tbody id="proj-body">${projectRows()}</tbody>
    </table>
    <p class="hint" style="margin-top:14px;font-size:11px;color:var(--ink-3)" id="proj-count"></p>
  </div>`;
}

function filteredProjects() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  return state.data.projects.filter((p) => {
    if (f.projectStage !== '全部' && p.stage !== f.projectStage) return false;
    if (f.projectPriority !== '全部' && p.priority !== f.projectPriority) return false;
    if (!q) return true;
    return [p.name, p.code, p.pm, p.client_pm, p.sponsor, p.objective].some((v) => String(v || '').toLowerCase().includes(q));
  });
}

function projectRows() {
  const list = filteredProjects();
  if (!state.data.projects.length) return emptyRow(7, '还没有项目，点击右上角「新建项目」开始');
  if (!list.length) return emptyRow(7, '没有匹配的项目，换个关键词试试');
  return list.map((p, i) => `<tr class="is-link fade-row" style="--i:${i}" data-href="#/projects/${p.id}">
    <td class="c-project">
      <span class="pcode">${esc(p.code)} <span class="priority${p.priority === 'P0' ? ' priority--p0' : ''}">· ${esc(p.priority)}</span></span>
      <span class="pname">${esc(p.name)}</span>
      <span class="pcode" style="letter-spacing:.02em">乙方 ${esc(p.pm || '未指定')} · 甲方 ${esc(p.client_pm || '未指定')} · ${p.team_size} 人</span>
    </td>
    <td class="c-stage cell-nowrap"><span class="chip">${esc(p.stage)}</span></td>
    <td class="c-progress">${trackRow(p.progress, { expected: p.health.expected })}</td>
    <td class="c-budget">${trackRow(Math.round(p.burnRate * 100), { tone: 'track__fill--budget', label: pct(p.burnRate) })}</td>
    <td class="c-risk num" style="color:${p.riskExposure >= 24 ? 'var(--oxblood)' : 'var(--ink-2)'}">${p.riskExposure}</td>
    <td class="c-health"><div style="display:flex;align-items:center;gap:10px">
      ${ragChip(p.health.rag)}<span class="num" style="font-size:14px;margin-left:auto">${p.health.score}</span></div></td>
    <td class="right c-arrow"><span class="row-arrow">→</span></td>
  </tr>`).join('');
}

function projectTabsHTML(p, active) {
  return `<nav class="project-tabs" aria-label="项目视图">
    ${PROJECT_TABS.map((t) => `<a class="project-tab${active === t.id ? ' is-on' : ''}" href="#/projects/${p.id}/${t.id}">${t.label}</a>`).join('')}
  </nav>`;
}

function deliveryAction(p, kind, period, item, late = false) {
  const editable = !item || ['draft', 'rejected'].includes(item.status);
  const label = !item ? (late ? '补报' : '填写') : item.status === 'draft' ? '继续填写' : item.status === 'rejected' ? '修改重提' : '查看';
  return `<a class="btn btn--sm ${editable && !late ? 'btn--solid' : 'btn--quiet'}" href="#/write/${kind}/${p.id}/${period}">${label}</a>`;
}

function projectNowHTML(ws) {
  const p = ws.project;
  const week = ws.currentWeek;
  const quarter = ws.currentQuarter;
  const report = ws.reports.find((r) => r.week_start === week);
  const plan = ws.plans.find((x) => x.period_label === quarter);
  const nextGate = ws.gates.filter((g) => g.status === '待评审').sort((a, b) => a.planned_date.localeCompare(b.planned_date))[0];
  const high = ws.risks
    .filter((r) => r.status !== '已关闭' && r.probability * r.impact >= 16)
    .sort((a, b) => b.probability * b.impact - a.probability * a.impact);
  const card = (label, chipHtml, title, sub, action) => `<div class="now-card">
    <div class="now-head"><span>${label}</span>${chipHtml}</div>
    <b class="now-title">${esc(title)}</b>
    <span class="now-sub">${esc(sub)}</span>
    <div class="now-foot">${action}</div>
  </div>`;
  return `<div class="project-now">
    ${card('本周周报', dlvChip(report), weekText(week),
      `截止 ${fmtDue(ws.due.weekly)}${report?.progress != null ? ` · 进度 ${report.progress}%` : ''}`,
      deliveryAction(p, 'weekly', week, report))}
    ${card('本季度计划', dlvChip(plan), quarterText(quarter),
      `截止 ${fmtDue(ws.due.plan)}${plan ? ` · 第 ${plan.version_count || 1} 版` : ''}`,
      deliveryAction(p, 'plan', quarter, plan))}
    ${card('下一个关口', nextGate ? gateChip(nextGate.status) : '<span class="chip chip--dashed">无</span>',
      nextGate ? nextGate.name : '暂无待评审关口',
      nextGate ? `${nextGate.planned_date} · ${relDays(nextGate.planned_date)}` : '可在关口页新增',
      `<a class="btn btn--sm btn--quiet" href="#/gates">查看关口</a>`)}
    ${card('高敞口风险', high.length ? `<span class="chip chip--oxblood">${high.length} 项</span>` : '<span class="chip chip--jade">0 项</span>',
      high.length ? high[0].title : '没有高敞口风险',
      high.length ? `最大敞口 ${high[0].probability * high[0].impact} · ${high[0].owner}` : '继续保持',
      `<a class="btn btn--sm btn--quiet" href="#/projects/${p.id}/risks">查看风险</a>`)}
  </div>`;
}

function projectWeeklyHistoryHTML(ws) {
  const p = ws.project;
  const weeks = [];
  for (let i = 0; i < 8; i += 1) weeks.push(addDays(ws.currentWeek, -7 * i));
  const rows = weeks.map((w) => {
    const r = ws.reports.find((x) => x.week_start === w);
    const status = r ? r.status : 'missing';
    const due = `${addDays(w, 6)}T23:59:00`;
    const late = !['submitted', 'approved'].includes(status) && new Date(due).getTime() < Date.now();
    return `<tr>
      <td data-label="周期"><span class="mono-sm">${weekText(w)}</span><br><span class="muted" style="font-size:9.5px">第 ${weekOfYear(parse(w))} 周</span></td>
      <td data-label="状态">${dlvChip(r)}${late ? '<br><span class="sla-tag">逾期未交</span>' : ''}</td>
      <td data-label="进度">${r?.progress != null ? `${r.progress}%` : '—'}</td>
      <td class="col-submit" data-label="提交">${r?.submitted_at ? `${esc(r.author_name || '')}<br><span class="muted" style="font-size:9.5px">${fmtDateTime(r.submitted_at)}</span>` : '—'}</td>
      <td class="col-review" data-label="审核">${r?.reviewed_at ? `${esc(r.reviewer_name || '')}<br><span class="muted" style="font-size:9.5px">${fmtDateTime(r.reviewed_at)}</span>` : '—'}</td>
      <td class="col-version" data-label="版本">${r ? `v${r.version_count || 1}${r.comment_count ? `<br><span class="muted" style="font-size:9.5px">${r.comment_count} 条沟通</span>` : ''}` : '—'}</td>
      <td class="right" data-label="操作">${deliveryAction(p, 'weekly', w, r, late)}</td>
    </tr>`;
  }).join('');
  return `<table class="ledger ledger--fixed project-history">
    <thead><tr><th style="width:17%">周期</th><th style="width:12%">状态</th><th style="width:7%">进度</th><th style="width:20%">提交</th><th style="width:20%">审核</th><th style="width:12%">版本</th><th style="width:12%"></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function projectPlanHistoryHTML(ws) {
  const p = ws.project;
  const quarters = [ws.currentQuarter];
  for (let i = 1; i < 4; i += 1) quarters.push(shiftQuarter(ws.currentQuarter, -i));
  const rows = quarters.map((q) => {
    const item = ws.plans.find((x) => x.period_label === q);
    const status = item ? item.status : 'missing';
    const due = `${shiftStrClient(quarterStart(q), 14)}T18:00:00`;
    const late = !['submitted', 'approved'].includes(status) && new Date(due).getTime() < Date.now();
    return `<tr>
      <td data-label="周期"><span class="mono-sm">${quarterText(q)}</span></td>
      <td data-label="状态">${dlvChip(item)}${late ? '<br><span class="sla-tag">逾期未交</span>' : ''}</td>
      <td class="col-submit" data-label="提交">${item?.submitted_at ? `${esc(item.author_name || '')}<br><span class="muted" style="font-size:9.5px">${fmtDateTime(item.submitted_at)}</span>` : '—'}</td>
      <td class="col-review" data-label="审核">${item?.reviewed_at ? `${esc(item.reviewer_name || '')}<br><span class="muted" style="font-size:9.5px">${fmtDateTime(item.reviewed_at)}</span>` : '—'}</td>
      <td class="col-version" data-label="版本">${item ? `v${item.version_count || 1}${item.comment_count ? `<br><span class="muted" style="font-size:9.5px">${item.comment_count} 条沟通</span>` : ''}` : '—'}</td>
      <td class="right" data-label="操作">${deliveryAction(p, 'plan', q, item, late)}</td>
    </tr>`;
  }).join('');
  return `<table class="ledger ledger--fixed project-history">
    <thead><tr><th style="width:20%">周期</th><th style="width:12%">状态</th><th style="width:22%">提交</th><th style="width:22%">审核</th><th style="width:12%">版本</th><th style="width:12%"></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function projectRecentHTML(ws) {
  const items = [
    ...ws.reports.map((r) => ({
      kind: 'weekly', period: r.week_start, status: r.status, at: r.reviewed_at || r.submitted_at,
      title: `周报 · ${weekText(r.week_start)}`, href: `#/write/weekly/${ws.project.id}/${r.week_start}`,
    })),
    ...ws.plans.map((x) => ({
      kind: 'plan', period: x.period_label, status: x.status, at: x.reviewed_at || x.submitted_at,
      title: `计划 · ${/-Q/.test(x.period_label) ? quarterText(x.period_label) : x.period_label}`,
      href: `#/write/plan/${ws.project.id}/${x.period_label}`,
    })),
  ].filter((x) => x.at).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6);

  if (!items.length) return '<div class="empty">还没有提交记录，先填写本周周报或本季度计划</div>';
  return items.map((x) => `<a class="mini-row" href="${x.href}">
    <span class="mini-type">${x.kind === 'weekly' ? '周报' : '计划'}</span>
    <b>${esc(x.title)}</b>
    ${dlvChip({ status: x.status })}
    <span class="mini-time">${fmtDateTime(x.at)}</span>
    <span class="task-arrow">→</span>
  </a>`).join('');
}

function projectUpcomingHTML(ws) {
  const horizon = addDays(today(), 30);
  const nodes = [
    ...ws.milestones
      .filter((m) => m.status !== '已完成' && m.due_date >= today() && m.due_date <= horizon)
      .map((m) => ({ type: '里程碑', date: m.due_date, name: m.name, meta: m.owner || '待定' })),
    ...ws.gates
      .filter((g) => g.status === '待评审' && g.planned_date <= horizon)
      .map((g) => ({ type: '关口', date: g.planned_date, name: g.name, meta: g.reviewer || '待安排' })),
  ].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);

  if (!nodes.length) return '<div class="empty">未来 30 天没有到期节点</div>';
  return nodes.map((n) => `<div class="mini-row mini-row--static">
    <span class="mini-type">${n.type}</span>
    <b>${esc(n.name)}</b>
    <span class="mini-meta">${esc(n.meta)}</span>
    <span class="mini-time">${relDays(n.date)}</span>
  </div>`).join('');
}

/* --------------------------------------------------------------- process --- */

const CHARTER_STATUS = {
  draft: ['草稿', 'chip--dashed'],
  submitted: ['待审批', 'chip--ochre'],
  approved: ['已通过', 'chip--jade'],
  rejected: ['已退回', 'chip--oxblood'],
};

function charterChip(charter) {
  if (!charter) return '<span class="chip chip--dashed">未创建</span>';
  const st = CHARTER_STATUS[charter.status] || CHARTER_STATUS.draft;
  return `<span class="chip ${st[1]}">${st[0]}</span>`;
}

function processPctColor(pct) {
  return pct >= 90 ? 'var(--jade)' : pct >= 60 ? 'var(--ochre)' : 'var(--oxblood)';
}

async function viewProcessMatrix() {
  let data;
  try {
    data = await api('/api/process-matrix');
  } catch (e) {
    return `<div class="view-enter">${pageHead({ eyebrow: 'PROCESS COMPLIANCE', title: '过程管理', sub: esc(e.message) })}</div>`;
  }
  state.processMatrix = data;
  if (!data.projects.length) {
    return emptyProgramView('PROCESS COMPLIANCE <span class="sep">/</span> PMP', '过程管理', '按 PMP 五个过程组检查项目管理的完整性。');
  }
  const pool = data.projects.slice();
  const projects = (state.processStage === '全部' ? pool : pool.filter((p) => p.stage === state.processStage))
    .sort((a, b) => a.overall - b.overall);
  const s = data.summary;
  const total = Math.max(1, pool.length);
  const worst = projects.slice(0, 3);
  const stages = ['全部', '执行中', '规划中', '验收中', '已结项'];

  const rows = projects.map((p) => `<tr class="is-link" data-href="#/projects/${p.id}/process">
    <td><span class="pcode">${esc(p.code)} · ${esc(p.stage)}</span><span class="pname">${esc(p.name)}</span></td>
    ${p.groups.map((g) => `<td data-label="${esc(g.label)}"><div class="proc-cell">
      <span class="proc-bar"><i style="width:${g.pct}%;background:${processPctColor(g.pct)}"></i></span>
      <b>${g.pct}%</b>
    </div></td>`).join('')}
    <td data-label="整体"><div class="proc-cell proc-cell--overall">
      <span class="proc-bar"><i style="width:${p.overall}%;background:${processPctColor(p.overall)}"></i></span>
      <b>${p.overall}%</b>
    </div></td>
    <td class="right"><span class="row-arrow">→</span></td>
  </tr>`).join('');

  return `<div class="view-enter">
    ${pageHead({
      eyebrow: 'PROCESS COMPLIANCE <span class="sep">/</span> PMP',
      title: '过程管理',
      sub: '按 PMP 五个过程组检查项目管理的完整性：启动看章程和干系人，规划看计划与风险，执行看周报和投入，监控看 EVM 和变更控制，收尾看验收与经验教训。',
      actions: `<a class="btn btn--quiet" href="#/report">查看项目群周报</a>`,
    })}

    <div class="pulse" style="grid-template-columns:repeat(4,1fr)">
      <div class="pulse-cell"><span class="pulse-label">平均过程完整度</span><div class="pulse-value">${s.avgOverall}<span class="unit">%</span></div><span class="pulse-note">${projects.filter((p) => p.overall >= 90).length} 个项目达到 90%</span></div>
      <div class="pulse-cell"><span class="pulse-label">章程已批准</span><div class="pulse-value">${s.charterCoverage}<span class="unit">/ ${total}</span></div><span class="pulse-note">立项有据可查</span></div>
      <div class="pulse-cell"><span class="pulse-label">计划已批准</span><div class="pulse-value">${s.planCoverage}<span class="unit">/ ${total}</span></div><span class="pulse-note">规划阶段有基线</span></div>
      <div class="pulse-cell"><span class="pulse-label">待审变更</span><div class="pulse-value" style="color:${s.pendingChanges ? 'var(--oxblood)' : 'inherit'}">${s.pendingChanges}<span class="unit">条</span></div><span class="pulse-note">经验教训 ${s.lessons} 条</span></div>
    </div>

    <div class="process-matrix-head">
      <div class="filters">${stages.map((x) => `<button class="filter${state.processStage === x ? ' is-on' : ''}" data-action="process-stage" data-value="${x}">${x}</button>`).join('')}</div>
      <span class="hint">按整体完整度升序 · 点击进入项目过程页</span>
    </div>

    <div class="table-scroll"><table class="ledger ledger--fixed process-matrix">
      <thead><tr><th style="width:30%">项目</th><th>启动</th><th>规划</th><th>执行</th><th>监控</th><th>收尾</th><th>整体</th><th style="width:4%"></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" style="text-align:center;padding:40px 0;color:var(--ink-3)">该阶段暂无项目</td></tr>'}</tbody>
    </table></div>

    <div class="process-legend">
      <span><i style="background:var(--jade)"></i>≥90% 过程完整</span>
      <span><i style="background:var(--ochre)"></i>60–89% 有缺口</span>
      <span><i style="background:var(--oxblood)"></i>&lt;60% 需补齐</span>
    </div>

    <section class="panel" style="margin-top:34px">
      <div class="panel-head"><h2><span class="no">01</span>优先补齐</h2><span class="hint">缺口最多的三个项目</span></div>
      ${worst.map((p) => `<div class="note-item">
        <div class="note-head"><b>${esc(p.code)} ${esc(p.name)}</b><span>${p.overall}% · 缺 ${p.missing} 项</span></div>
        <p class="note-body">${p.groups.filter((g) => g.pct < 100).map((g) => `${g.label} ${g.pct}%`).join(' · ')}</p>
      </div>`).join('')}
    </section>
  </div>`;
}

function planPct(date, range) {
  const total = daysDiff(range.start, range.end) + 1;
  return clampNum((daysDiff(range.start, date) / total) * 100, 0, 100);
}

function planSpan(start, end, range) {
  const total = daysDiff(range.start, range.end) + 1;
  return clampNum(((daysDiff(start, end) + 1) / total) * 100, 0.6, 100);
}

function clampNum(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function planMonths(range) {
  const out = [];
  let cursor = parse(range.start);
  cursor = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const end = parse(range.end);
  while (cursor <= end) {
    const next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    const last = new Date(next.getTime() - 86400000);
    const s = isoDate(new Date(Math.max(cursor.getTime(), parse(range.start).getTime())));
    const e = isoDate(new Date(Math.min(last.getTime(), end.getTime())));
    if (e >= s) {
      out.push({
        key: `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`,
        label: `${cursor.getMonth() === 0 || out.length === 0 ? `${cursor.getFullYear()}年` : ''}${cursor.getMonth() + 1}月`,
        start: s, end: e,
      });
    }
    cursor = next;
  }
  return out;
}

function projectPlanHTML(p, plan, canManage) {
  const tasks = plan.tasks;
  if (!tasks.length) {
    return `<section class="panel">
      <div class="panel-head"><h2><span class="no">01</span>项目整体计划</h2>
        ${canManage ? '<button class="btn btn--sm btn--solid" data-action="plan-task-new">新建任务</button>' : ''}
      </div>
      <div class="empty" style="padding:50px 0">还没有任务级计划。先建一个阶段或任务，再用「缩进」把任务挂到阶段下面。</div>
    </section>`;
  }

  const range = plan.range;
  const months = planMonths(range);
  const index = new Map(tasks.map((t, i) => [t.id, i]));
  const rowHeight = 40;
  const rowsHeight = tasks.length * rowHeight;
  const totalTasks = tasks.filter((t) => !t.isSummary).length;

  const rowHTML = tasks.map((t) => {
    const isMs = t.kind === 'milestone';
    const barLeft = planPct(t.start_date, range);
    const barWidth = planSpan(t.start_date, t.end_date || t.start_date, range);
    const baseline = t.baseline_start
      ? `<span class="plan-baseline" style="left:${planPct(t.baseline_start, range)}%;width:${planSpan(t.baseline_start, t.baseline_end || t.baseline_start, range)}%" title="基线 ${t.baseline_start} ~ ${t.baseline_end || ''}"></span>` : '';
    const bar = isMs
      ? `<span class="plan-ms ${t.critical ? 'is-critical' : ''}" style="left:${barLeft}%" title="${t.name} · ${t.start_date}"></span>`
      : `<span class="plan-bar ${t.isSummary ? 'is-summary' : ''} ${t.critical ? 'is-critical' : ''}" style="left:${barLeft}%;width:${barWidth}%" title="${t.name} · ${t.start_date} ~ ${t.end_date} · ${t.duration} 个工作日 · ${t.progress}%"><i style="width:${t.progress}%"></i></span>`;
    const name = canManage
      ? `<button class="plan-name-btn" data-action="plan-task-edit" data-id="${t.id}">${esc(t.name)}</button>`
      : `<span>${esc(t.name)}</span>`;
    const actions = canManage ? `<span class="plan-actions">
        <button data-action="plan-indent" data-id="${t.id}" title="缩进为上一任务的子任务">缩进</button>
        <button data-action="plan-outdent" data-id="${t.id}" title="升级一层">升级</button>
        <button data-action="plan-task-delete" data-id="${t.id}" title="删除任务">删除</button>
      </span>` : '';
    return `<div class="plan-grid plan-row ${t.isSummary ? 'is-summary' : ''} ${t.critical ? 'is-critical' : ''}">
      <div class="plan-wbs">${esc(t.wbs)}</div>
      <div class="plan-name" style="padding-left:${t.level * 14}px">${name}${actions}
        ${(t.actual_start || t.actual_end || t.vendor_name) ? `<span class="plan-actual">${t.vendor_name ? esc(t.vendor_name) : ''}${t.actual_start ? ` · 实际 ${t.actual_start.slice(5)}${t.actual_end ? ` ~ ${t.actual_end.slice(5)}` : ' 起'}` : ''}</span>` : ''}
      </div>
      <div class="plan-num">${isMs ? '0' : t.duration}</div>
      <div class="plan-date">${t.start_date ? t.start_date.slice(5) : '—'}</div>
      <div class="plan-date">${t.end_date ? t.end_date.slice(5) : '—'}</div>
      <div class="plan-pred">${t.predecessors.length ? t.predecessors.map((x) => x.wbs).join(',') : '—'}</div>
      <div class="plan-owner">${esc(t.owner || '—')}</div>
      <div class="plan-progress"><i style="width:${t.progress}%"></i><span>${t.progress}%</span></div>
      <div class="plan-bar-cell">${baseline}${bar}</div>
    </div>`;
  }).join('');

  const links = [];
  for (const t of tasks) {
    for (const pred of t.predecessors) {
      const pt = tasks.find((x) => x.id === pred.id);
      if (!pt || !pt.end_date || !t.start_date) continue;
      links.push({ task: t, pred: pt, i: index.get(t.id), j: index.get(pt.id) });
    }
  }
  const linkPaths = links.map((l) => {
    const x1 = planPct(addDays(l.pred.end_date, 1), range) * 10;
    const x2 = planPct(l.task.start_date, range) * 10;
    const y1 = l.j * rowHeight + rowHeight / 2;
    const y2 = l.i * rowHeight + rowHeight / 2;
    const dx = Math.max(10, Math.min(40, Math.abs(x2 - x1) / 2));
    return `<path d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}" fill="none"
      stroke="${l.task.critical ? 'var(--oxblood)' : 'var(--ink-4)'}" stroke-width="1.2" opacity=".85"
      vector-effect="non-scaling-stroke" marker-end="url(#${l.task.critical ? 'plan-arrow-crit' : 'plan-arrow'})"><title>${esc(l.pred.wbs)} → ${esc(l.task.wbs)}</title></path>`;
  }).join('');
  const monthLines = months.slice(1).map((m) => `<line x1="${planPct(m.start, range) * 10}" y1="0" x2="${planPct(m.start, range) * 10}" y2="${rowsHeight}" stroke="var(--rule)" stroke-width="1" vector-effect="non-scaling-stroke" />`).join('');
  const todayX = planPct(today(), range);
  const todayLine = today() >= range.start && today() <= range.end
    ? `<line x1="${todayX * 10}" y1="0" x2="${todayX * 10}" y2="${rowsHeight}" stroke="var(--oxblood)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" />` : '';

  const summary = plan.summary;
  const deviation = summary.deviation > 0 ? `晚 ${summary.deviation} 个工作日` : summary.deviation < 0 ? `早 ${Math.abs(summary.deviation)} 个工作日` : '与基线一致';
  return `<div class="plan-toolbar">
      <div class="plan-summary">
        <div><span>任务</span><b>${totalTasks}</b></div>
        <div><span>总工期</span><b>${summary.duration}</b><small>工作日</small></div>
        <div><span>完成率</span><b>${summary.progress}%</b></div>
        <div><span>关键任务</span><b>${summary.critical}</b></div>
        <div><span>基线偏差</span><b class="${summary.deviation > 0 ? 'is-late' : ''}">${deviation}</b></div>
      </div>
      <div class="plan-actions-top">
        <button class="btn btn--quiet btn--sm" data-action="template-reference" data-category="plan">模板参考</button>
        <a class="btn btn--quiet btn--sm" href="/api/projects/${p.id}/plan/export.csv" download>导出 CSV</a>
        <a class="btn btn--quiet btn--sm" href="/api/projects/${p.id}/plan/export.xml" download>导出 MS Project</a>
        ${canManage ? `<button class="btn btn--quiet btn--sm" data-action="plan-import" data-id="${p.id}">导入计划</button>
        <button class="btn btn--solid btn--sm" data-action="plan-task-new">${ICONS.plus}新建任务</button>
        <button class="btn btn--quiet btn--sm" data-action="plan-baseline">设为基线</button>` : ''}
        <input type="file" id="plan-import-file" accept=".csv,.xml,text/csv,application/xml,text/xml" class="sr-only" aria-label="选择计划导入文件" data-id="${p.id}" />
      </div>
    </div>
    <div class="plan-scroll">
      <div class="plan-wrap">
        <div class="plan-grid plan-head">
          <div>WBS</div><div>任务名称</div><div>工期</div><div>开始</div><div>完成</div><div>前置</div><div>负责人</div><div>进度</div>
          <div class="plan-chart-head">${months.map((m) => `<span class="plan-month" style="left:${planPct(m.start, range)}%;width:${planSpan(m.start, m.end, range)}%">${m.label}</span>`).join('')}</div>
        </div>
        ${rowHTML}
        <svg class="plan-links" style="height:${rowsHeight}px" viewBox="0 0 1000 ${rowsHeight}" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <marker id="plan-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="var(--ink-4)"/></marker>
            <marker id="plan-arrow-crit" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="var(--oxblood)"/></marker>
          </defs>
          ${monthLines}${todayLine}${linkPaths}
        </svg>
      </div>
    </div>
    <div class="plan-legend">
      <span><i class="lg-summary"></i>阶段</span>
      <span><i class="lg-task"></i>任务</span>
      <span><i class="lg-ms"></i>里程碑</span>
      <span><i class="lg-crit"></i>关键路径</span>
      <span><i class="lg-base"></i>基线</span>
      <span class="plan-baseline-at">${summary.baselineAt ? `基线 ${summary.baselineAt} · ${summary.baselineBy || ''}` : '尚未设置基线'}</span>
    </div>`;
}

function openPlanTaskModal(project, task) {
  const plan = state.projectPlan;
  const isNew = !task;
  const isSummary = Boolean(task?.isSummary);
  const leaves = plan.tasks.filter((t) => !t.isSummary && (!task || t.id !== task.id));
  const selected = new Set((task?.predecessors || []).map((x) => x.id));
  $('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="modal-backdrop">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1" style="width:min(680px,100%)">
      <div class="modal-head">
        <div><h3 id="modal-title">${isNew ? '新建计划任务' : '编辑计划任务'}</h3>
          <p>${isSummary ? '阶段任务的工期和进度由子任务自动汇总。' : '工期按工作日计算，周末自动跳过；有前置任务时开始日期由系统排。'}</p></div>
        <button class="icon-btn" data-action="modal-close" aria-label="关闭">${ICONS.close}</button>
      </div>
      <form id="plan-form">
        <div class="modal-body">
          <div class="modal-fields">
            <div class="field field--full"><label for="pf-name">任务名称</label>
              <input id="pf-name" name="name" value="${esc(task?.name || '')}" required placeholder="例如：订单域改造" /></div>
            ${isSummary ? '' : `<div class="field"><label for="pf-kind">类型</label>
              <select id="pf-kind" name="kind">
                <option value="task" ${task?.kind !== 'milestone' ? 'selected' : ''}>任务</option>
                <option value="milestone" ${task?.kind === 'milestone' ? 'selected' : ''}>里程碑</option>
              </select></div>
            <div class="field"><label for="pf-duration">工期（工作日）</label>
              <input id="pf-duration" name="duration" type="number" min="1" value="${task?.kind === 'milestone' ? 1 : (task?.duration || 5)}" /></div>
            <div class="field"><label for="pf-start">开始日期</label>
              <input id="pf-start" name="start_date" type="date" value="${task?.start_date || nextWorkdayClient(project.plan_start || today())}" /></div>
            <div class="field"><label for="pf-owner">负责人</label>
              <input id="pf-owner" name="owner" value="${esc(task?.owner || project.pm || '')}" /></div>
            <div class="field"><label for="pf-vendor">乙方供应商</label>
              <select id="pf-vendor" name="vendor_id">
                <option value="">未指定</option>
                ${(state.data.vendors || []).filter((v) => v.status === '合作中' || v.id === task?.vendor_id).map((v) => `<option value="${v.id}" ${task?.vendor_id === v.id ? 'selected' : ''}>${esc(v.code)} ${esc(v.name)}</option>`).join('')}
              </select></div>
            <div class="field"><label for="pf-progress">进度（%）</label>
              <input id="pf-progress" name="progress" type="number" min="0" max="100" value="${task?.progress || 0}" /></div>
            <div class="field"><label for="pf-actual-start">实际开始</label>
              <input id="pf-actual-start" name="actual_start" type="date" value="${task?.actual_start || ''}" /></div>
            <div class="field"><label for="pf-actual-end">实际完成</label>
              <input id="pf-actual-end" name="actual_end" type="date" value="${task?.actual_end || ''}" /></div>
            <div class="field field--full"><label>前置任务</label>
              <div class="checkgrid plan-pred-grid">
                ${leaves.length ? leaves.map((t) => `<label class="checkitem"><input type="checkbox" name="predecessor_ids" value="${t.id}" ${selected.has(t.id) ? 'checked' : ''} /><span>${esc(t.wbs)} ${esc(t.name)}</span></label>`).join('') : '<span class="placeholder">还没有可选的同级任务</span>'}
              </div>
              <span class="help">完成-开始关系。选了前置任务后，开始日期会根据前置任务自动排。</span>
            </div>`}
            <div class="field field--full"><label for="pf-notes">备注</label>
              <textarea id="pf-notes" name="notes" placeholder="交付物、验收口径或注意事项">${esc(task?.notes || '')}</textarea></div>
          </div>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn btn--quiet" data-action="modal-close">取消</button>
          <button type="submit" class="btn btn--solid">${isNew ? '创建任务' : '保存'}</button>
        </div>
      </form>
    </div>
  </div>`;
  document.body.style.overflow = 'hidden';
  modalCloser = closeModal;
  activateFocusTrap();
  setTimeout(() => $('#pf-name')?.focus(), 60);
  $('#plan-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { name: String(fd.get('name') || '').trim(), owner: String(fd.get('owner') || ''), notes: String(fd.get('notes') || '') };
    if (!body.name) return toast('请填写任务名称', 'err');
    if (!isSummary) {
      body.kind = String(fd.get('kind') || 'task');
      body.duration = body.kind === 'milestone' ? 0 : Number(fd.get('duration')) || 1;
      body.start_date = String(fd.get('start_date') || '');
      body.progress = Number(fd.get('progress')) || 0;
      body.vendor_id = fd.get('vendor_id') ? Number(fd.get('vendor_id')) : null;
      body.actual_start = String(fd.get('actual_start') || '') || null;
      body.actual_end = String(fd.get('actual_end') || '') || null;
      body.predecessor_ids = fd.getAll('predecessor_ids').map(Number);
    }
    try {
      const res = isNew
        ? await api(`/api/projects/${project.id}/plan/tasks`, { method: 'POST', body })
        : await api(`/api/plan/tasks/${task.id}`, { method: 'PATCH', body });
      state.projectPlan = res;
      closeModal();
      await reload({ keepScroll: false });
      toast(isNew ? '任务已创建' : '任务已更新');
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

function benefitPct(b) {
  const base = Number(b.baseline_value) || 0;
  const target = Number(b.target_value) || 0;
  const current = Number(b.current_value) || 0;
  if (target === base) return current === target ? 100 : 0;
  const raw = b.direction === 'down' ? ((base - current) / (base - target)) * 100 : ((current - base) / (target - base)) * 100;
  return clampNum(Math.round(raw), 0, 100);
}

const ACTION_SOURCE = { gate: '关口', change: '变更', risk: '风险', meeting: '会议', other: '其他' };

function projectValueHTML(ws, p, canManage) {
  const benefits = ws.benefits || [];
  const actions = ws.actions || [];
  const acceptances = ws.acceptances || [];
  const canAccept = state.me.role === 'pmo' || p.client_pm_id === state.me.id;
  const avg = benefits.length
    ? Math.round(benefits.filter((b) => b.status !== '已放弃').reduce((sum, b) => sum + benefitPct(b), 0) / Math.max(1, benefits.filter((b) => b.status !== '已放弃').length))
    : 0;
  const overdueBenefits = benefits.filter((b) => b.due_date && b.due_date < today() && b.status !== '已达成' && b.status !== '已放弃').length;
  const openActions = actions.filter((a) => !['已完成', '已取消'].includes(a.status)).length;

  const benefitRows = benefits.length ? benefits.map((b) => {
    const pct = benefitPct(b);
    const late = b.due_date && b.due_date < today() && b.status !== '已达成' && b.status !== '已放弃';
    return `<tr>
      <td data-label="收益指标"><b class="value-name">${esc(b.name)}</b>${b.notes ? `<span class="value-note">${esc(b.notes)}</span>` : ''}</td>
      <td data-label="基线 → 目标" class="mono-sm">${b.baseline_value}${esc(b.unit || '')} → ${b.target_value}${esc(b.unit || '')}</td>
      <td data-label="当前" class="mono-sm">${b.current_value}${esc(b.unit || '')}</td>
      <td data-label="达成"><div class="value-track"><i style="width:${pct}%;background:${pct >= 100 ? 'var(--jade)' : pct >= 60 ? 'var(--ochre)' : 'var(--oxblood)'}"></i></div><span class="value-pct">${pct}%</span></td>
      <td data-label="责任人">${esc(b.owner || '—')}</td>
      <td data-label="要求时间" class="${late ? 'is-late' : ''}">${b.due_date || '—'}${late ? ' · 逾期' : ''}</td>
      <td data-label="状态"><span class="chip ${b.status === '已达成' ? 'chip--jade' : b.status === '已放弃' ? 'chip--dashed' : late ? 'chip--oxblood' : 'chip--ochre'}">${esc(b.status)}</span></td>
      <td class="right">${canManage ? `<button class="btn btn--sm btn--quiet" data-action="benefit-edit" data-id="${b.id}">编辑</button>` : ''}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="8" style="text-align:center;padding:30px 0;color:var(--ink-3)">还没有登记收益。先回答“项目做完得到什么”。</td></tr>`;

  const actionRows = actions.length ? actions.map((a) => {
    const done = a.status === '已完成' || a.status === '已取消';
    const late = a.due_date && a.due_date < today() && !done;
    return `<tr>
      <td data-label="优先级"><span class="chip ${a.priority === '高' ? 'chip--oxblood' : a.priority === '低' ? 'chip--dashed' : 'chip--ochre'}">${esc(a.priority)}</span></td>
      <td data-label="行动项"><b class="value-name">${esc(a.title)}</b>${a.notes ? `<span class="value-note">${esc(a.notes)}</span>` : ''}</td>
      <td data-label="来源"><span class="mini-type">${esc(ACTION_SOURCE[a.source_type] || '其他')}</span></td>
      <td data-label="责任人">${esc(a.owner || '—')}</td>
      <td data-label="截止" class="${late ? 'is-late' : ''}">${a.due_date || '—'}${late ? ' · 逾期' : ''}</td>
      <td data-label="状态"><span class="chip ${a.status === '已完成' ? 'chip--jade' : a.status === '已取消' ? 'chip--dashed' : late ? 'chip--oxblood' : 'chip--ochre'}">${esc(a.status)}</span></td>
      <td class="right"><div class="user-actions">
        ${canManage && !done ? `<button class="btn btn--sm btn--quiet" data-action="action-complete" data-id="${a.id}">完成</button>` : ''}
        ${canManage ? `<button class="btn btn--sm btn--quiet" data-action="action-edit" data-id="${a.id}">编辑</button>` : ''}
      </div></td>
    </tr>`;
  }).join('') : `<tr><td colspan="7" style="text-align:center;padding:30px 0;color:var(--ink-3)">还没有行动项。关口条件、变更遗留和风险应对都可以落到这里。</td></tr>`;

  const acceptanceRows = acceptances.length ? acceptances.map((a) => `<tr>
      <td data-label="范围">${a.scope === 'project' ? '项目' : a.scope === 'stage' ? '阶段' : `${a.ref_type === 'plan' ? '计划' : '周报'}`}</td>
      <td data-label="结论"><span class="chip ${a.conclusion === '通过' ? 'chip--jade' : a.conclusion === '不通过' ? 'chip--oxblood' : 'chip--ochre'}">${esc(a.conclusion)}</span></td>
      <td data-label="确认人">${esc(a.accepted_by || '—')}</td>
      <td data-label="时间">${a.accepted_at ? fmtDateTime(a.accepted_at) : '—'}</td>
      <td data-label="说明">${esc(a.notes || '—')}</td>
    </tr>`).join('') : `<tr><td colspan="5" style="text-align:center;padding:26px 0;color:var(--ink-3)">还没有甲方验收记录</td></tr>`;

  return `<div class="pulse" style="grid-template-columns:repeat(4,1fr)">
      <div class="pulse-cell"><span class="pulse-label">收益项</span><div class="pulse-value">${benefits.length}<span class="unit">项</span></div><span class="pulse-note">平均达成 ${avg}%</span></div>
      <div class="pulse-cell"><span class="pulse-label">逾期收益</span><div class="pulse-value" style="color:${overdueBenefits ? 'var(--oxblood)' : 'inherit'}">${overdueBenefits}<span class="unit">项</span></div><span class="pulse-note">要求时间已过、尚未达成</span></div>
      <div class="pulse-cell"><span class="pulse-label">未关闭行动</span><div class="pulse-value">${openActions}<span class="unit">项</span></div><span class="pulse-note">待处理 + 进行中</span></div>
      <div class="pulse-cell"><span class="pulse-label">行动逾期</span><div class="pulse-value" style="color:${actions.filter((a) => a.due_date && a.due_date < today() && !['已完成', '已取消'].includes(a.status)).length ? 'var(--oxblood)' : 'inherit'}">${actions.filter((a) => a.due_date && a.due_date < today() && !['已完成', '已取消'].includes(a.status)).length}<span class="unit">项</span></div><span class="pulse-note">需要在本周例会上过</span></div>
    </div>

    <section class="panel">
      <div class="panel-head"><h2><span class="no">01</span>收益台账</h2>
        <div style="display:flex;gap:8px;align-items:center"><span class="hint">${benefits.length} 项</span>
        ${canManage ? '<button class="btn btn--sm btn--quiet" data-action="benefit-new">登记收益</button>' : ''}</div>
      </div>
      <table class="ledger ledger--fixed value-table">
        <thead><tr><th style="width:24%">收益指标</th><th style="width:14%">基线 → 目标</th><th style="width:10%">当前</th><th style="width:18%">达成</th><th style="width:10%">责任人</th><th style="width:12%">要求时间</th><th style="width:8%">状态</th><th style="width:8%"></th></tr></thead>
        <tbody>${benefitRows}</tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-head"><h2><span class="no">02</span>行动项</h2>
        <div style="display:flex;gap:8px;align-items:center"><span class="hint">${openActions} 项未关闭</span>
        ${canManage ? '<button class="btn btn--sm btn--quiet" data-action="action-new">新增行动</button>' : ''}</div>
      </div>
      <table class="ledger ledger--fixed value-table">
        <thead><tr><th style="width:7%">优先级</th><th style="width:36%">行动项</th><th style="width:8%">来源</th><th style="width:11%">责任人</th><th style="width:12%">截止</th><th style="width:9%">状态</th><th style="width:17%"></th></tr></thead>
        <tbody>${actionRows}</tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-head"><h2><span class="no">03</span>甲方验收</h2>
        <div style="display:flex;gap:8px;align-items:center"><span class="hint">${acceptances.length} 条</span>
        ${canAccept ? '<button class="btn btn--sm btn--quiet" data-action="acceptance-new">登记验收</button>' : ''}</div>
      </div>
      <table class="ledger ledger--fixed value-table">
        <thead><tr><th style="width:12%">范围</th><th style="width:12%">结论</th><th style="width:14%">确认人</th><th style="width:20%">时间</th><th>说明</th></tr></thead>
        <tbody>${acceptanceRows}</tbody>
      </table>
      <p class="dlv-note">验收记录是正式结论，不是评论。交付物验收在周报/计划页面由甲方项目经理确认；这里登记项目级或阶段级验收。</p>
    </section>`;
}

function openBenefitModal(project, benefit) {
  const isEdit = Boolean(benefit);
  openModal({
    title: isEdit ? '编辑收益' : '登记收益',
    sub: '收益要能核实：基线是多少、目标是多少、现在到哪、谁负责、什么时候实现。',
    wide: true,
    submit: isEdit ? '保存' : '登记',
    fields: [
      { name: 'name', label: '收益指标', full: true, required: true, value: benefit?.name || '', placeholder: '例如：渠道接入覆盖率' },
      { name: 'baseline_value', label: '基线值', type: 'number', value: benefit?.baseline_value ?? 0, step: 'any' },
      { name: 'target_value', label: '目标值', type: 'number', value: benefit?.target_value ?? 0, step: 'any' },
      { name: 'current_value', label: '当前值', type: 'number', value: benefit?.current_value ?? 0, step: 'any' },
      { name: 'unit', label: '单位', value: benefit?.unit || '' },
      { name: 'direction', label: '方向', type: 'select', value: benefit?.direction || 'up', options: [{ value: 'up', label: '越高越好' }, { value: 'down', label: '越低越好' }] },
      { name: 'owner', label: '责任人', value: benefit?.owner || project.pm || '' },
      { name: 'due_date', label: '要求实现时间', type: 'date', value: benefit?.due_date || project.plan_end || '' },
      { name: 'status', label: '状态', type: 'select', value: benefit?.status || '跟踪中', options: ['跟踪中', '已达成', '已放弃'] },
      { name: 'notes', label: '口径说明', type: 'textarea', full: true, value: benefit?.notes || '', placeholder: '怎么算、数据从哪来、谁确认' },
    ],
    onDelete: isEdit ? async () => {
      await api(`/api/benefits/${benefit.id}`, { method: 'DELETE' });
      await reload({ keepScroll: false });
      toast('收益已删除');
    } : undefined,
    onSubmit: async (v) => {
      const body = { ...v, baseline_value: Number(v.baseline_value) || 0, target_value: Number(v.target_value) || 0, current_value: Number(v.current_value) || 0 };
      if (isEdit) await api(`/api/benefits/${benefit.id}`, { method: 'PATCH', body });
      else await api(`/api/projects/${project.id}/benefits`, { method: 'POST', body });
      await reload({ keepScroll: false });
      toast(isEdit ? '收益已更新' : '收益已登记');
    },
  });
}

function openActionModal(project, action) {
  const isEdit = Boolean(action);
  openModal({
    title: isEdit ? '编辑行动项' : '新增行动项',
    sub: '行动项要能落到人：谁、什么时候、从哪来。关口条件、变更遗留、风险应对都放这里。',
    wide: true,
    submit: isEdit ? '保存' : '新增',
    fields: [
      { name: 'title', label: '行动项', full: true, required: true, value: action?.title || '' },
      { name: 'source_type', label: '来源', type: 'select', value: action?.source_type || 'other', options: [{ value: 'gate', label: '关口' }, { value: 'change', label: '变更' }, { value: 'risk', label: '风险' }, { value: 'meeting', label: '会议' }, { value: 'other', label: '其他' }] },
      { name: 'priority', label: '优先级', type: 'select', value: action?.priority || '中', options: ['高', '中', '低'] },
      { name: 'owner', label: '责任人', value: action?.owner || '' },
      { name: 'due_date', label: '截止日期', type: 'date', value: action?.due_date || addDays(today(), 7) },
      { name: 'status', label: '状态', type: 'select', value: action?.status || '待处理', options: ['待处理', '进行中', '已完成', '已取消'] },
      { name: 'notes', label: '备注', type: 'textarea', full: true, value: action?.notes || '' },
    ],
    onDelete: isEdit ? async () => {
      await api(`/api/actions/${action.id}`, { method: 'DELETE' });
      await reload({ keepScroll: false });
      toast('行动项已删除');
    } : undefined,
    onSubmit: async (v) => {
      if (isEdit) await api(`/api/actions/${action.id}`, { method: 'PATCH', body: v });
      else await api(`/api/projects/${project.id}/actions`, { method: 'POST', body: v });
      await reload({ keepScroll: false });
      toast(isEdit ? '行动项已更新' : '行动项已新增');
    },
  });
}

function openAcceptanceModal(project, preset = {}) {
  const deliverable = preset.scope === 'deliverable';
  openModal({
    title: deliverable ? '甲方确认交付物' : '登记甲方验收',
    sub: deliverable ? '确认的是已审核通过的交付物，记录结论、时间和说明。' : '项目级或阶段级验收，记录甲方结论。',
    wide: true,
    submit: '保存确认',
    fields: [
      ...(deliverable ? [] : [{
        name: 'scope', label: '验收范围', type: 'select', value: 'project',
        options: [{ value: 'project', label: '项目级验收' }, { value: 'stage', label: '阶段验收' }],
      }]),
      { name: 'conclusion', label: '验收结论', type: 'select', value: '通过', options: ['通过', '有条件通过', '不通过'] },
      { name: 'notes', label: '说明', type: 'textarea', full: true, placeholder: '有条件通过或不通过时必填' },
    ],
    onSubmit: async (v) => {
      const body = {
        scope: deliverable ? 'deliverable' : v.scope,
        conclusion: v.conclusion,
        notes: v.notes,
      };
      if (deliverable) {
        body.ref_type = preset.ref_type;
        body.ref_id = preset.ref_id;
      }
      await api(`/api/projects/${project.id}/acceptances`, { method: 'POST', body });
      await reload({ keepScroll: false });
      toast('验收记录已保存');
    },
  });
}

function projectProcessHTML(ws, p) {
  const proc = ws.process;
  const charter = ws.charter;
  const content = charter?.content || {};
  const me = state.me;
  const canManage = me.role === 'pmo' || p.vendor_pm_id === me.id;
  const isPmo = me.role === 'pmo';
  const editable = canManage && (!charter || ['draft', 'rejected'].includes(charter.status) || isPmo);

  const charterFields = [
    ['purpose', '项目目的'], ['objectives', '目标'], ['scope', '范围'], ['outOfScope', '不在范围内'],
    ['successCriteria', '成功标准'], ['assumptions', '假设'], ['constraints', '约束'], ['keyStakeholders', '关键干系人'],
  ];

  const charterActions = [
    !charter && canManage ? '<button class="btn btn--sm btn--solid" data-action="charter-edit">创建章程</button>' : '',
    charter && editable ? '<button class="btn btn--sm btn--quiet" data-action="charter-edit">编辑</button>' : '',
    charter && ['draft', 'rejected'].includes(charter.status) && canManage ? '<button class="btn btn--sm btn--solid" data-action="charter-submit">提交审批</button>' : '',
    charter && charter.status === 'submitted' && isPmo ? '<button class="btn btn--sm btn--quiet" data-action="charter-reject">退回</button><button class="btn btn--sm btn--solid" data-action="charter-approve">通过</button>' : '',
  ].filter(Boolean).join('');

  const evmCells = [
    ['PV', '计划价值', money(proc.evm.pv), '万元'],
    ['EV', '挣值', money(proc.evm.ev), '万元'],
    ['AC', '实际成本', money(proc.evm.ac), '万元'],
    ['SPI', '进度绩效', proc.evm.spi, ''],
    ['CPI', '成本绩效', proc.evm.cpi, ''],
    ['EAC', '完工估算', money(proc.evm.eac), '万元'],
    ['VAC', '完工偏差', money(proc.evm.vac), '万元'],
  ].map(([k, label, v, unit]) => {
    const bad = (k === 'SPI' && proc.evm.spi < 0.9) || (k === 'CPI' && proc.evm.cpi < 0.9) || (k === 'VAC' && proc.evm.vac < 0);
    return `<div class="evm-cell${bad ? ' is-bad' : ''}"><span>${k} · ${label}</span><b>${v}</b><small>${unit}</small></div>`;
  }).join('');

  const changes = ws.changes.length ? ws.changes.map((c) => `<div class="change-row" data-action="change-open" data-id="${c.id}">
    <span class="chip">${esc(c.cr_type)}</span>
    <div class="change-main"><b>${esc(c.title)}</b><span>${esc(c.impact || c.description || '')}</span></div>
    <span class="change-impact">${c.cost_impact ? `+${c.cost_impact} 万` : '—'} / ${c.schedule_impact ? `+${c.schedule_impact} 天` : '—'}</span>
    <span class="chip ${c.status === '待审批' ? 'chip--ochre' : c.status === '已拒绝' ? 'chip--oxblood' : c.status === '已批准' || c.status === '已实施' ? 'chip--jade' : ''}">${esc(c.status)}</span>
  </div>`).join('') : '<div class="empty">还没有变更请求</div>';

  const lessons = ws.lessons.length ? ws.lessons.map((l) => `<div class="lesson-card">
    <div class="lesson-head"><span class="chip">${esc(l.category)}</span><b>${esc(l.title)}</b><i>${esc(l.author || '')}</i></div>
    ${l.context ? `<p>${esc(l.context)}</p>` : ''}
    ${l.lesson ? `<p class="lesson-why">${esc(l.lesson)}</p>` : ''}
    ${l.recommendation ? `<p class="lesson-rec">建议：${esc(l.recommendation)}</p>` : ''}
  </div>`).join('') : '<div class="empty">还没有经验教训，结项前至少补一条</div>';

  return `<div class="process-summary">
    ${proc.missing.length
      ? `<div class="process-tip">按 PMP 过程组还有 <b>${proc.missing.length}</b> 项待补齐：${proc.missing.slice(0, 5).map((m) => esc(m.label)).join('、')}${proc.missing.length > 5 ? ' 等' : ''}</div>`
      : '<div class="process-tip process-tip--ok">五个过程组的要求都已满足</div>'}
    <span class="process-score">过程完整度 <b>${proc.overall}%</b></span>
  </div>

  <div class="process-board">
    ${proc.groups.map((g) => `<section class="process-group">
      <header><span>${esc(g.label)}</span><b>${g.pct}%</b></header>
      <div class="pg-track"><i style="width:${g.pct}%;background:${processPctColor(g.pct)}"></i></div>
      <ul>${g.items.map((it) => `<li class="${it.done ? 'is-done' : ''}">
        <i></i><div><span>${esc(it.label)}</span><em>${esc(it.hint)}</em></div>
      </li>`).join('')}</ul>
    </section>`).join('')}
  </div>

  <div class="evm-strip">${evmCells}</div>
  ${proc.evm.pvBasis === 'baseline' ? `<div class="evm-note">PV 按任务基线计算：到今天应完成 ${proc.evm.plannedPct}%</div>` : '<div class="evm-note">暂无任务基线，PV 按项目计划时间估算</div>'}

  <section class="panel" style="margin-top:30px">
    <div class="panel-head"><h2><span class="no">01</span>项目章程</h2>
      <div style="display:flex;gap:8px;align-items:center">${charterChip(charter)}${charterActions}</div>
    </div>
    ${charter ? `<div class="charter-grid">${charterFields.map(([k, label]) => `<div class="charter-field">
      <span>${label}</span><p>${content[k] ? multiline(content[k]) : '<i class="placeholder">未填写</i>'}</p>
    </div>`).join('')}</div>
    ${charter.review_comment ? `<div class="note-box" style="margin-top:14px">审批意见：${esc(charter.review_comment)}</div>` : ''}`
    : '<div class="empty">还没有项目章程，启动阶段应先把目的、范围、成功标准和关键干系人写清楚</div>'}
  </section>

  <section class="panel">
    <div class="panel-head"><h2><span class="no">02</span>变更控制</h2>
      <div style="display:flex;gap:8px;align-items:center"><span class="hint">${ws.changes.length} 条</span>
      ${canManage ? '<button class="btn btn--sm btn--quiet" data-action="change-new">登记变更</button>' : ''}</div>
    </div>
    ${changes}
  </section>

  <section class="panel">
    <div class="panel-head"><h2><span class="no">03</span>经验教训</h2>
      ${canManage ? '<button class="btn btn--sm btn--quiet" data-action="lesson-new">记录经验</button>' : ''}
    </div>
    ${lessons}
  </section>`;
}

function openCharterModal(p, charter) {
  const content = charter?.content || {};
  const isPmo = state.me.role === 'pmo';
  const canManage = canEditProject(p);
  openModal({
    title: charter ? '编辑项目章程' : '创建项目章程',
    sub: '章程是启动阶段的核心文件，写清目的、范围边界、成功标准和关键干系人。保存后提交 PMO 审批。',
    wide: true,
    readOnly: !canManage,
    submit: '保存草稿',
    fields: [
      { name: 'purpose', label: '项目目的', type: 'textarea', full: true, required: true, value: content.purpose || '', placeholder: '为什么要做这个项目，解决什么问题' },
      { name: 'objectives', label: '目标', type: 'textarea', full: true, value: content.objectives || '', placeholder: '可衡量的目标，最好带时间点' },
      { name: 'scope', label: '范围', type: 'textarea', full: true, value: content.scope || '' },
      { name: 'outOfScope', label: '不在范围内', type: 'textarea', full: true, value: content.outOfScope || '' },
      { name: 'successCriteria', label: '成功标准', type: 'textarea', full: true, value: content.successCriteria || '' },
      { name: 'assumptions', label: '假设', type: 'textarea', full: true, value: content.assumptions || '' },
      { name: 'constraints', label: '约束', type: 'textarea', full: true, value: content.constraints || '' },
      { name: 'keyStakeholders', label: '关键干系人', type: 'textarea', full: true, value: content.keyStakeholders || '', placeholder: '姓名 / 角色 / 关注点' },
    ],
    onSubmit: async (v) => {
      if (!canManage) return;
      await api(`/api/projects/${p.id}/charter`, { method: 'POST', body: { content: v } });
      await reload();
      toast('章程草稿已保存');
    },
  });
}

function openCharterReject(p) {
  openModal({
    title: '退回项目章程',
    sub: '说明需要补充或修改的内容，项目经理改完可以重新提交。',
    submit: '确认退回',
    fields: [{ name: 'comment', label: '退回原因', type: 'textarea', full: true, required: true, placeholder: '例如：成功标准不可衡量，请补充验收口径' }],
    onSubmit: async (v) => {
      await api(`/api/projects/${p.id}/charter/review`, { method: 'POST', body: { decision: 'reject', comment: v.comment } });
      await reload();
      toast('章程已退回');
    },
  });
}

function openChangeModal(p) {
  openModal({
    title: '登记变更请求',
    sub: '变更要走整体变更控制：说明改什么、对范围/进度/成本的影响，由 PMO 审批。',
    wide: true,
    submit: '提交审批',
    fields: [
      { name: 'title', label: '变更内容', full: true, required: true, placeholder: '一句话说清要改什么' },
      { name: 'cr_type', label: '变更类型', type: 'select', options: ['范围', '进度', '成本', '质量', '资源', '风险', '采购', '干系人'] },
      { name: 'cost_impact', label: '成本影响（万元）', type: 'number', value: 0, min: 0 },
      { name: 'schedule_impact', label: '进度影响（天）', type: 'number', value: 0, min: 0 },
      { name: 'description', label: '变更说明', type: 'textarea', full: true },
      { name: 'impact', label: '影响分析', type: 'textarea', full: true, placeholder: '对范围、进度、成本、质量分别有什么影响' },
    ],
    onSubmit: async (v) => {
      v.cost_impact = Number(v.cost_impact) || 0;
      v.schedule_impact = Number(v.schedule_impact) || 0;
      await api(`/api/projects/${p.id}/changes`, { method: 'POST', body: v });
      await reload();
      toast('变更请求已提交');
    },
  });
}

function openChangeReview(change) {
  const isPmo = state.me.role === 'pmo';
  const canReview = isPmo && ['待审批', '已批准'].includes(change.status);
  const options = change.status === '待审批' ? ['已批准', '已拒绝', '已实施'] : ['已实施'];
  openModal({
    title: change.title,
    sub: `${change.cr_type}变更 · 提出人 ${change.requested_by || '—'} · 影响 +${change.cost_impact || 0} 万 / +${change.schedule_impact || 0} 天`,
    wide: true,
    readOnly: !canReview,
    submit: change.status === '已批准' ? '标记为已实施' : '保存审批结果',
    fields: [
      { name: 'description', label: '变更说明', type: 'textarea', full: true, value: change.description || '' },
      { name: 'impact', label: '影响分析', type: 'textarea', full: true, value: change.impact || '' },
      ...(canReview ? [
        { name: 'status', label: '审批结果', type: 'select', options },
        ...(change.status === '待审批' ? [{
          name: 'rebaseline', label: '批准后更新计划基线', type: 'select',
          options: [{ value: '0', label: '不更新' }, { value: '1', label: '更新，按当前任务计划重设基线' }],
          help: '只有批准时生效。适合变更已经反映到任务日期、需要重新锁定基线的情况。',
        }] : []),
        { name: 'decision', label: '审批意见', type: 'textarea', full: true, value: change.decision || '', placeholder: '拒绝时必须写明原因' },
      ] : [
        { name: 'decision', label: '审批意见', type: 'textarea', full: true, value: change.decision || '' },
      ]),
    ],
    onSubmit: async (v) => {
      if (!canReview) return;
      await api(`/api/changes/${change.id}`, { method: 'PATCH', body: { status: v.status, decision: v.decision, rebaseline: v.rebaseline === '1' } });
      await reload();
      toast('变更审批已保存');
    },
  });
}

function openLessonModal(p) {
  openModal({
    title: '记录经验教训',
    sub: '写下发生了什么、为什么、下次怎么做。结项前至少留一条。',
    wide: true,
    submit: '保存',
    fields: [
      { name: 'category', label: '知识领域', type: 'select', options: ['范围', '进度', '成本', '质量', '风险', '沟通', '资源', '采购', '干系人', '其他'] },
      { name: 'title', label: '标题', required: true, placeholder: '例如：整改证据要边改边归档' },
      { name: 'context', label: '背景', type: 'textarea', full: true },
      { name: 'lesson', label: '发生了什么', type: 'textarea', full: true },
      { name: 'recommendation', label: '下次怎么做', type: 'textarea', full: true },
    ],
    onSubmit: async (v) => {
      await api(`/api/projects/${p.id}/lessons`, { method: 'POST', body: v });
      await reload();
      toast('经验教训已记录');
    },
  });
}

async function viewProject(id) {
  const tab = state.params.tab || 'overview';
  state.projectAIBrief = null;
  let ws;
  try {
    ws = await api(`/api/projects/${id}/workspace`);
  } catch (e) {
    return `<div class="view-enter">
      ${pageHead({ eyebrow: 'PROJECT WORKSPACE', title: '无法打开项目', sub: esc(e.message) })}
      <a class="btn btn--quiet" href="#/projects" style="margin-top:20px">返回台账</a>
    </div>`;
  }
  state.workspace = ws;
  const p = ws.project;
  const canManage = canEditProject(p);
  let plan = null;
  if (tab === 'plan') {
    try { plan = await api(`/api/projects/${id}/plan`); } catch { plan = null; }
    state.projectPlan = plan;
  }
  if (tab === 'ai') {
    try { state.projectAIBrief = await api(`/api/projects/${id}/ai/brief`); } catch { state.projectAIBrief = null; }
  }
  let kb = null;
  if (tab === 'kb') {
    const f = state.projectKBFilter;
    try {
      kb = await api(`/api/projects/${id}/kb?q=${encodeURIComponent(f.q)}&kind=${encodeURIComponent(f.kind)}&limit=300`);
      state.projectKB = kb;
    } catch { kb = null; }
  }
  const d = state.data;
  const ms = ws.milestones;
  const risks = ws.risks.slice().sort((a, b) => sevOf(b) - sevOf(a));
  const allocs = ws.allocations;
  const updates = ws.updates;
  const doneMs = ms.filter((m) => m.status === '已完成').length;
  const budgetLeft = p.budget - p.spent;

  const msList = ms.length ? ms.map((m) => {
    const overdue = m.status !== '已完成' && m.due_date < today();
    return `<div class="ms-item${overdue ? ' ms-item--overdue' : ''}">
      <div class="ms-date"><span class="d">${m.due_date.slice(8, 10)}</span><span class="m">${Number(m.due_date.slice(5, 7))}月</span></div>
      <div class="ms-body">
        <p class="ms-title">${esc(m.name)}</p>
        <div class="ms-meta"><span>${esc(m.owner || '待定')}</span><i class="dot"></i><span>${m.status === '已完成' ? `完成于 ${m.completed_date || m.due_date}` : relDays(m.due_date)}</span>
        ${m.note ? `<i class="dot"></i><span>${esc(m.note)}</span>` : ''}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <span class="chip ${m.status === '已完成' ? 'chip--jade' : overdue ? 'chip--oxblood' : ''}">${esc(m.status)}</span>
        ${canManage && m.status !== '已完成' ? `<button class="btn btn--sm btn--quiet" data-action="ms-complete" data-id="${m.id}" title="标记为已完成" aria-label="将里程碑 ${esc(m.name)} 标记为已完成">${ICONS.check}</button>` : ''}
      </div>
    </div>`;
  }).join('') : '<div class="empty">尚未设置里程碑</div>';

  const riskList = risks.length ? risks.map((r) => {
    const sev = sevOf(r);
    return `<div class="risk-row">
      <div class="risk-sev risk-sev--${sevClass(sev)}"><b>${sev}</b><small>敞口</small></div>
      <div>
        <p class="risk-title">${esc(r.title)}</p>
        <div class="risk-meta"><span>${esc(r.kind)}</span><i class="dot"></i><span>${esc(r.owner)}</span><i class="dot"></i><span>要求 ${r.due_date} 前处理</span></div>
        ${r.response ? `<p class="risk-meta" style="margin-top:5px;color:var(--ink-2)">应对：${esc(r.response)}</p>` : ''}
      </div>
      <span class="chip ${r.status === '已关闭' ? 'chip--jade' : sev >= 16 ? 'chip--oxblood' : ''}">${esc(r.status)}</span>
    </div>`;
  }).join('') : '<div class="empty">暂无风险记录</div>';

  const totalPct = allocs.reduce((sum, a) => sum + a.pct, 0);
  const people = allocs.length ? allocs.map((a) => `<div class="note-item"${canManage ? ` data-action="edit-alloc" data-id="${a.id}" style="display:flex;justify-content:space-between;align-items:center;gap:10px;cursor:pointer" title="点击编辑投入"` : ' style="display:flex;justify-content:space-between;align-items:center;gap:10px"'}>
      <div><b style="font-weight:500;font-size:12.5px">${esc(a.person)}</b>
      <span class="pcode" style="display:block">${esc(a.role || '')}${a.vendor_name ? ` · ${esc(a.vendor_name)}` : ''}</span></div>
      <div style="display:flex;align-items:center;gap:8px;width:120px">
        ${track(a.pct, { tone: a.pct > 80 ? 'track__fill--oxblood' : 'track__fill--jade' })}
        <span class="track-val">${a.pct}%</span>
      </div>
    </div>`).join('') : '<div class="empty">尚未录入投入，点击「添加」录入</div>';

  const noteList = updates.length ? updates.map((u) => `<div class="note-item">
      <div class="note-head"><b>${esc(u.author)}</b><span>${esc(u.period)}</span><span>${esc(u.created_at)}</span></div>
      <p class="note-body">${esc(u.content)}</p>
    </div>`).join('') : '<div class="empty">还没有项目动态，点击「记录动态」写一条</div>';

  const scores = [
    ['进度绩效', p.health.scheduleScore, `${p.health.schedGap > 0 ? '+' : ''}${p.health.schedGap} pt`],
    ['成本绩效', p.health.budgetScore, `CPI ${p.health.cpi}`],
    ['风险控制', p.health.riskScore, `敞口 ${p.health.exposure}`],
    ['里程碑', p.health.milestoneScore, `逾期 ${p.health.overdue}`],
  ];

  const healthPanel = `<section class="panel">
    <div class="panel-head"><h2><span class="no">03</span>健康度构成</h2></div>
    ${scores.map(([k, v, dd]) => `<div style="padding:11px 0;border-bottom:1px solid var(--rule-soft)">
      <div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:7px">
        <span>${k}</span><span class="num" style="color:var(--ink-3)">${dd}</span>
      </div>
      ${track(v, { tone: v >= 78 ? 'track__fill--jade' : v >= 58 ? 'track__fill--ochre' : 'track__fill--oxblood' })}
    </div>`).join('')}
    <ul class="reasons" style="margin-top:14px">${p.health.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
  </section>`;

  const objectivePanel = `<section class="panel">
    <div class="panel-head"><h2><span class="no">04</span>项目目标</h2></div>
    <p style="font-size:12.5px;line-height:1.85;color:var(--ink-2);margin:0">${esc(p.objective || '未填写')}</p>
  </section>`;

  const tabContent = {
    overview: `${projectNowHTML(ws)}<div class="split">
      <div>
        <section class="panel">
          <div class="panel-head"><h2><span class="no">01</span>近期管理记录</h2><a class="hint" href="#/projects/${p.id}/reports" style="text-decoration:none">全部记录 →</a></div>
          ${projectRecentHTML(ws)}
        </section>
        <section class="panel">
          <div class="panel-head"><h2><span class="no">02</span>接下来 30 天</h2><span class="hint">里程碑与关口</span></div>
          ${projectUpcomingHTML(ws)}
        </section>
      </div>
      <div>${healthPanel}${objectivePanel}</div>
    </div>`,

    plan: plan ? projectPlanHTML(p, plan, canManage) : '<div class="empty">整体计划加载失败，请刷新重试</div>',

    value: projectValueHTML(ws, p, canManage),
    kb: projectKBHTML(p, kb, canManage),
    ai: projectAIHTML(p, ws),

    process: projectProcessHTML(ws, p),

    reports: `<div class="panel">
      <div class="panel-head"><h2><span class="no">01</span>周报记录</h2><span class="hint">最近 8 周 · 点「填写」可补报</span></div>
      ${projectWeeklyHistoryHTML(ws)}
    </div>
    <div class="panel">
      <div class="panel-head"><h2><span class="no">02</span>计划记录</h2><span class="hint">最近 4 个季度</span></div>
      ${projectPlanHistoryHTML(ws)}
    </div>
    <section class="panel">
      <div class="panel-head"><h2><span class="no">03</span>项目动态</h2>
        ${canManage ? `<button class="btn btn--sm btn--quiet" data-action="new-update" data-id="${p.id}">${ICONS.plus}记录动态</button>` : ''}
      </div>
      ${noteList}
    </section>`,

    milestones: `<section class="panel">
      <div class="panel-head"><h2><span class="no">01</span>里程碑</h2>
        <div style="display:flex;gap:8px;align-items:center"><span class="hint">${doneMs}/${ms.length} 完成</span>
        <button class="btn btn--sm btn--quiet" data-action="template-reference" data-category="milestone">模板参考</button>
        ${canManage ? `<button class="btn btn--sm btn--quiet" data-action="new-milestone" data-id="${p.id}">${ICONS.plus}新增</button>` : ''}</div>
      </div>
      ${msList}
    </section>`,

    risks: `<section class="panel">
      <div class="panel-head"><h2><span class="no">01</span>风险与问题</h2>
        ${canManage ? `<button class="btn btn--sm btn--quiet" data-action="new-risk" data-id="${p.id}">${ICONS.plus}登记</button>` : ''}</div>
      ${riskList}
    </section>`,

    governance: `<div class="split split--even">
      <section class="panel">
        <div class="panel-head"><h2><span class="no">01</span>阶段关口</h2><a class="hint" href="#/gates" style="text-decoration:none">关口页 →</a></div>
        ${ws.gates.length ? ws.gates.slice().sort((a, b) => a.planned_date.localeCompare(b.planned_date)).map((g) => `<div class="gate-mini">
          <span class="mono-sm">${g.planned_date}</span>
          <div><b>${esc(g.name)}</b><span>${esc(g.phase || '')} · ${esc(g.reviewer || '待安排')}</span></div>
          ${gateChip(g.status)}
        </div>`).join('') : '<div class="empty">还没有阶段关口</div>'}
      </section>
      <section class="panel">
        <div class="panel-head"><h2><span class="no">02</span>跨项目依赖</h2>
          ${state.me.role === 'pmo' ? '<button class="btn btn--sm btn--quiet" data-action="dep-new">新增依赖</button>' : ''}
        </div>
        ${ws.dependencies.length ? ws.dependencies.map((dep) => `<div class="dep-mini">
          <div class="dep-path"><span class="pcode">${esc(dep.from.code)}</span><i>→</i><span class="pcode">${esc(dep.to.code)}</span></div>
          <div><b>${esc(dep.title)}</b><span>${esc(dep.owner || '—')} · ${relDays(dep.due_date)}</span></div>
          <span class="chip ${dep.status === '受阻' ? 'chip--oxblood' : dep.status === '已解除' ? 'chip--jade' : 'chip--dashed'}">${esc(dep.status)}</span>
        </div>`).join('') : '<div class="empty">没有涉及本项目的依赖</div>'}
      </section>
    </div>`,

    team: `<div class="split split--even">
      <section class="panel">
        <div class="panel-head"><h2><span class="no">01</span>人员投入</h2>
          <div style="display:flex;gap:8px;align-items:center"><span class="hint">${allocs.length} 人 / ${totalPct}%</span>
          ${canManage ? '<button class="btn btn--sm btn--quiet" data-action="new-alloc">添加成员</button>' : ''}</div>
        </div>
        ${people}
      </section>
      <section class="panel">
        <div class="panel-head"><h2><span class="no">02</span>项目节奏</h2></div>
        <div class="side-facts">
          <div class="side-fact"><span>乙方项目经理</span><b>${esc(p.pm || '未指定')}</b></div>
          <div class="side-fact"><span>甲方项目经理</span><b>${esc(p.client_pm || '未指定')}</b></div>
          <div class="side-fact"><span>项目群负责人</span><b>${esc(p.sponsor || '—')}</b></div>
          <div class="side-fact"><span>团队规模</span><b>${p.team_size} 人</b></div>
          <div class="side-fact"><span>计划窗口</span><b>${p.plan_start} ~ ${p.plan_end}</b></div>
          <div class="side-fact"><span>周报记录</span><b>${ws.reports.length} 份</b></div>
          <div class="side-fact"><span>计划记录</span><b>${ws.plans.length} 份</b></div>
        </div>
      </section>
    </div>`,
  };

  return `<div class="view-enter">
    <a class="crumb" href="#/projects">← 项目台账 <span>/</span> ${esc(p.code)}</a>
    <header class="detail-head">
      <div>
        <div class="eyebrow">${esc(p.code)} <span class="sep">/</span> ${esc(p.stage)} <span class="sep">/</span> ${esc(p.priority)}</div>
        <h1 class="detail-title">${esc(p.name)}</h1>
        <div class="detail-meta">
          <span>乙方项目经理 <b>${esc(p.pm || '未指定')}</b></span>
          <span>甲方项目经理 <b>${esc(p.client_pm || '未指定')}</b></span>
          <span>项目群负责人 <b>${esc(p.sponsor || '—')}</b></span>
          <span>团队 <b>${p.team_size} 人</b></span>
          <span>计划 <b>${dShort(p.plan_start)} — ${dShort(p.plan_end)}</b></span>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:22px">
        ${scoreRing(p.health.score, p.health.rag)}
        ${canManage ? `<button class="btn btn--quiet" data-action="edit-project" data-id="${p.id}">${ICONS.edit}编辑台账</button>` : ''}
      </div>
    </header>

    <div class="facts">
      <div class="fact"><div class="k">风险敞口</div><div class="v" style="color:${p.riskExposure >= 24 ? 'var(--oxblood)' : 'inherit'}">${p.riskExposure}<small>点 / ${p.openRisks} 项</small></div></div>
      <div class="fact"><div class="k">进度 / 计划应到</div><div class="v">${p.progress}<small>%</small> <span style="font-size:12px;color:var(--ink-3)">/ ${p.health.expected}%</span></div></div>
      <div class="fact"><div class="k">预算执行</div><div class="v">${money(p.spent)}<small>/ ${money(p.budget)} 万元</small></div></div>
      <div class="fact"><div class="k">预算余量</div><div class="v" style="color:${budgetLeft < 0 ? 'var(--oxblood)' : 'inherit'}">${money(budgetLeft)}<small>万元</small></div></div>
    </div>

    ${projectTabsHTML(p, tab)}

    <div class="project-tab-body">
      ${tab === 'reports' ? projectNowHTML(ws) : ''}
      ${tabContent[tab] || tabContent.overview}
    </div>
  </div>`;
}

function viewMilestones() {
  const d = state.data;
  if (!d.projects.length) return emptyProgramView('MILESTONE LEDGER', '里程碑', '项目群所有关键节点的统一视图。');
  const all = [...d.milestones].sort((a, b) => a.due_date.localeCompare(b.due_date));
  const overdue = all.filter((m) => m.status !== '已完成' && m.due_date < today());
  const week = all.filter((m) => m.status !== '已完成' && m.due_date >= today() && m.due_date <= isoDate(new Date(parse(today()).getTime() + 7 * 86400000)));
  const next30 = all.filter((m) => m.status !== '已完成' && m.due_date >= today() && m.due_date <= isoDate(new Date(parse(today()).getTime() + 30 * 86400000)));

  let list = all;
  if (state.filters.msRange === 'overdue') list = overdue;
  else if (state.filters.msRange === 'week') list = week;
  else if (state.filters.msRange === 'next30') list = next30;
  else if (state.filters.msRange === 'open') list = all.filter((m) => m.status !== '已完成');

  const groups = new Map();
  for (const m of list) {
    const key = monthKey(m.due_date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  const body = [...groups.entries()].map(([key, items]) => `<div class="month-group">
    <div class="month-head"><h3>${monthText(key)}</h3><span class="n">${items.length} 个节点</span></div>
    ${items.map((m) => {
    const p = d.projects.find((x) => x.id === m.project_id);
    const isOverdue = m.status !== '已完成' && m.due_date < today();
    return `<div class="ms-item${isOverdue ? ' ms-item--overdue' : ''}">
        <div class="ms-date"><span class="d">${m.due_date.slice(8, 10)}</span><span class="m">${weekday(m.due_date)}</span></div>
        <div class="ms-body">
          <p class="ms-title">${esc(m.name)}</p>
          <div class="ms-meta">
            <a href="#/projects/${p?.id || ''}" style="text-decoration:none;color:var(--ink-2)">${esc(p?.name || '—')}</a>
            <i class="dot"></i><span>${esc(m.owner || '待定')}</span>
            ${m.note ? `<i class="dot"></i><span>${esc(m.note)}</span>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="chip ${m.status === '已完成' ? 'chip--jade' : isOverdue ? 'chip--oxblood' : ''}">${esc(m.status)}</span>
          ${m.status !== '已完成' ? `<button class="btn btn--sm btn--quiet" data-action="ms-complete" data-id="${m.id}">完成</button>` : ''}
        </div>
      </div>`;
  }).join('')}
  </div>`).join('');

  const filters = [
    ['all', '全部', all.length],
    ['open', '未完成', all.filter((m) => m.status !== '已完成').length],
    ['overdue', '已逾期', overdue.length],
    ['week', '7 天内', week.length],
    ['next30', '30 天内', next30.length],
  ];

  return `<div class="view-enter">
    ${pageHead({
      eyebrow: 'MILESTONE LEDGER',
      title: '里程碑',
      sub: '项目群所有关键节点的统一视图。逾期节点按红色标记，可在此直接标记完成或补充备注。',
      actions: state.me.party === '甲方' ? '' : `<button class="btn btn--solid" data-action="new-milestone">${ICONS.plus}新增里程碑</button>`,
    })}
    <div class="toolbar">
      <div class="filters">${filters.map(([k, l, n]) => `<button class="filter${state.filters.msRange === k ? ' is-on' : ''}" data-filter="msRange" data-value="${k}">${l}<span class="n">${n}</span></button>`).join('')}</div>
      <div class="hint" style="margin-left:auto;font-size:11px;color:var(--ink-3)">共 ${list.length} 个节点</div>
    </div>
    <div style="margin-top:22px">${list.length ? body : '<div class="empty" style="padding:60px 0">该范围内没有里程碑</div>'}</div>
  </div>`;
}

function viewRisks() {
  const d = state.data;
  if (!d.projects.length) return emptyProgramView('RAID LOG <span class="sep">/</span> RISK &amp; ISSUE', '风险与问题', '按概率 × 影响评估敞口，红色象限需在项目群例会中裁决。');
  const open = d.risks.filter((r) => r.status !== '已关闭');
  const filtered = d.risks.filter((r) => {
    if (state.filters.riskStatus === '开放' && r.status !== '开放') return false;
    if (state.filters.riskStatus === '缓解中' && r.status !== '缓解中') return false;
    if (state.filters.riskStatus === '已关闭' && r.status !== '已关闭') return false;
    if (state.filters.riskCell) {
      const { p, i } = state.filters.riskCell;
      if (r.probability !== p || r.impact !== i) return false;
    }
    return true;
  }).sort((a, b) => sevOf(b) - sevOf(a));

  const cellCount = (prob, imp) => open.filter((r) => r.probability === prob && r.impact === imp).length;
  const cells = [];
  for (let imp = 5; imp >= 1; imp--) {
    for (let prob = 1; prob <= 5; prob++) {
      const n = cellCount(prob, imp);
      const sev = prob * imp;
      const on = state.filters.riskCell && state.filters.riskCell.p === prob && state.filters.riskCell.i === imp;
      cells.push(`<button class="matrix-cell" data-action="risk-cell" data-p="${prob}" data-i="${imp}"
        data-sev="${n === 0 ? 'none' : sev >= 16 ? 'hi' : sev >= 9 ? 'mid' : 'lo'}"
        aria-label="概率 ${prob} 影响 ${imp}，${n} 项风险" ${on ? 'aria-pressed="true"' : ''}
        style="${on ? 'box-shadow:inset 0 0 0 2px var(--ink)' : ''}"><span class="n">${n || ''}</span></button>`);
    }
  }

  const counts = {
    全部: d.risks.length,
    开放: d.risks.filter((r) => r.status === '开放').length,
    缓解中: d.risks.filter((r) => r.status === '缓解中').length,
    已关闭: d.risks.filter((r) => r.status === '已关闭').length,
  };

  const rows = filtered.length ? filtered.map((r) => {
    const p = d.projects.find((x) => x.id === r.project_id);
    const sev = sevOf(r);
    return `<div class="risk-row" data-action="risk-open" data-id="${r.id}" style="cursor:pointer">
      <div class="risk-sev risk-sev--${sevClass(sev)}"><b>${sev}</b><small>${esc(r.kind)}</small></div>
      <div>
        <p class="risk-title">${esc(r.title)}</p>
        <div class="risk-meta">
          <span>${esc(p?.name || '')}</span><i class="dot"></i><span>${esc(r.owner || '未指定')}</span>
          <i class="dot"></i><span>P${r.probability} × I${r.impact}</span><i class="dot"></i><span>${relDays(r.due_date)}</span>
        </div>
      </div>
      <span class="chip ${r.status === '已关闭' ? 'chip--jade' : sev >= 16 ? 'chip--oxblood' : r.status === '缓解中' ? 'chip--ochre' : ''}">${esc(r.status)}</span>
    </div>`;
  }).join('') : '<div class="empty" style="padding:50px 0">没有符合条件的风险</div>';

  return `<div class="view-enter">
    ${pageHead({
      eyebrow: 'RAID LOG / RISK & ISSUE',
      title: '风险与问题',
      sub: '按概率 × 影响评估敞口。红色象限（≥16 分）需在项目群例会中裁决；点击矩阵可筛选。',
      actions: state.me.party === '甲方' ? '' : `<button class="btn btn--solid" data-action="new-risk">${ICONS.plus}登记风险</button>`,
    })}

    <div class="split">
      <div>
        <div class="toolbar" style="padding-top:22px">
          <div class="filters">${['全部', '开放', '缓解中', '已关闭'].map((s) => `<button class="filter${state.filters.riskStatus === s ? ' is-on' : ''}" data-filter="riskStatus" data-value="${s}">${s}<span class="n">${counts[s]}</span></button>`).join('')}</div>
          ${state.filters.riskCell ? `<button class="btn btn--sm btn--quiet" data-action="risk-cell-clear">清除矩阵筛选</button>` : ''}
        </div>
        <div>${rows}</div>
      </div>

      <div style="padding-top:22px">
        <div class="panel-head"><h2><span class="no">01</span>敞口矩阵</h2><span class="hint">未关闭风险</span></div>
        <div class="matrix-wrap">
          <div class="matrix-y">
            <span class="matrix-axis" style="writing-mode:vertical-rl;transform:rotate(180deg);padding:4px 0">影响 IMPACT</span>
            <div class="matrix-nums"><span>5</span><span>4</span><span>3</span><span>2</span><span>1</span></div>
          </div>
          <div>
            <div class="matrix">${cells.join('')}</div>
            <div class="matrix-xnums"><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span></div>
            <div class="matrix-axis" style="margin-top:9px">概率 PROBABILITY →</div>
          </div>
        </div>
        <div class="matrix-legend" style="margin-top:18px">
          <span><i style="background:#d9b3a8"></i>高敞口 ≥ 16：需项目群决策</span>
          <span><i style="background:#e3d3ac"></i>中敞口 9–15：项目经理跟踪</span>
          <span><i style="background:#d5e0d5"></i>低敞口 ≤ 8：常规监控</span>
        </div>
        <div class="note-box" style="margin-top:24px">
          当前未关闭风险合计敞口 <b>${d.stats.exposure}</b> 点，其中高敞口 <b>${d.stats.highRisks}</b> 项。
          ${d.stats.highRisks ? '建议在本周项目群例会逐项确认责任人与关闭时间。' : '敞口处于可控范围。'}
        </div>
      </div>
    </div>
  </div>`;
}

const GATE_STATUSES = ['待评审', '已通过', '有条件通过', '未通过'];

function gateChip(status) {
  const cls = status === '已通过' ? 'chip--jade'
    : status === '未通过' ? 'chip--oxblood'
    : status === '有条件通过' ? 'chip--ochre'
    : 'chip--ochre';
  return `<span class="chip ${cls}">${esc(status)}</span>`;
}

function viewGates() {
  if (!state.data.projects.length) return emptyProgramView('GOVERNANCE <span class="sep">/</span> STAGE GATES', '阶段关口', '项目进入下一阶段前，由 PMO 对照交付标准做一次明确结论。');
  const all = state.data.gates || [];
  const t = today();
  const horizon = addDays(t, 30);
  const filter = state.gateFilter;
  const overdue = (g) => g.status === '待评审' && g.planned_date < t;
  const list = (filter === '全部' ? all : all.filter((g) => g.status === filter))
    .slice()
    .sort((a, b) => a.planned_date.localeCompare(b.planned_date));

  const pending = all.filter((g) => g.status === '待评审');
  const stats = {
    pending: pending.length,
    overdue: pending.filter(overdue).length,
    upcoming: pending.filter((g) => g.planned_date >= t && g.planned_date <= horizon).length,
    passed: all.filter((g) => g.status === '已通过').length,
    failed: all.filter((g) => g.status === '未通过').length,
    conditional: all.filter((g) => g.status === '有条件通过').length,
  };
  const isPmo = state.me.role === 'pmo';

  const rows = list.map((g) => {
    const late = overdue(g);
    const decision = String(g.decision || '').trim();
    return `<tr class="is-link${late ? ' is-overdue' : ''}" data-action="gate-open" data-id="${g.id}">
      <td class="mono-sm" data-label="计划日期" style="white-space:nowrap">${g.planned_date}<br><span class="muted">${weekday(g.planned_date)}</span></td>
      <td data-label="项目"><span class="pcode">${esc(g.project?.code || '')}</span><span class="pname" style="font-size:12.5px">${esc(g.project?.name || '—')}</span></td>
      <td data-label="关口">${esc(g.name)}</td>
      <td data-label="阶段" class="muted">${esc(g.phase || '—')}</td>
      <td data-label="状态">${gateChip(g.status)}${late ? '<br><span class="sla-tag">逾期 ' + Math.abs(daysDiff(g.planned_date, t)) + ' 天</span>' : ''}</td>
      <td data-label="评审人">${esc(g.reviewer || '—')}</td>
      <td data-label="清单">${g.checkTotal ? `<button class="btn btn--sm btn--quiet" data-action="gate-checks" data-id="${g.id}" title="查看检查清单">${g.checkDone}/${g.checkTotal}</button>` : (isPmo ? `<button class="btn btn--sm btn--quiet" data-action="gate-checks" data-id="${g.id}" title="生成检查清单">生成</button>` : '<span class="muted">—</span>')}</td>
      <td data-label="结论" class="muted" style="font-size:11.5px;max-width:320px">${decision ? esc(decision.slice(0, 60)) + (decision.length > 60 ? '…' : '') : '—'}</td>
      <td class="right" data-label="操作">${isPmo && g.status === '待评审'
        ? `<button class="btn btn--sm btn--solid" data-action="gate-open" data-id="${g.id}">评审</button>`
        : `<button class="btn btn--sm btn--quiet" data-action="gate-open" data-id="${g.id}">查看</button>`}</td>
    </tr>`;
  }).join('');

  return `<div class="view-enter">
    ${pageHead({
      eyebrow: 'GOVERNANCE <span class="sep">/</span> STAGE GATES',
      title: '阶段关口',
      sub: '关口是项目群层面的治理动作：项目在进入下一阶段前，由 PMO 对照交付标准做一次明确结论。未通过和有条件通过的关口会保留条件，作为下次评审的输入。',
      actions: isPmo ? `<button class="btn btn--solid" data-action="gate-new">${ICONS.plus}新增关口</button>` : '',
    })}

    <div class="pulse" style="grid-template-columns:repeat(4,1fr)">
      <div class="pulse-cell"><span class="pulse-label">待评审</span><div class="pulse-value">${stats.pending}<span class="unit">个</span></div><span class="pulse-note">${stats.overdue ? `其中 ${stats.overdue} 个已过计划日期` : '全部在计划日期内'}</span></div>
      <div class="pulse-cell"><span class="pulse-label">30 天内</span><div class="pulse-value">${stats.upcoming}<span class="unit">个</span></div><span class="pulse-note">需要提前准备评审材料</span></div>
      <div class="pulse-cell"><span class="pulse-label">已通过</span><div class="pulse-value">${stats.passed}<span class="unit">个</span></div><span class="pulse-note">含历史关口</span></div>
      <div class="pulse-cell"><span class="pulse-label">未通过 / 有条件</span><div class="pulse-value">${stats.failed + stats.conditional}<span class="unit">个</span></div><span class="pulse-note">未通过 ${stats.failed} · 有条件 ${stats.conditional}</span></div>
    </div>

    <div class="toolbar">
      <div class="filters">${['全部', ...GATE_STATUSES].map((x) => `<button class="filter${filter === x ? ' is-on' : ''}" data-action="gate-filter" data-value="${x}">${x}<span class="n">${x === '全部' ? all.length : all.filter((g) => g.status === x).length}</span></button>`).join('')}</div>
      <span class="hint" style="margin-left:auto;font-size:11px;color:var(--ink-3)">共 ${list.length} 个关口 · 点击行查看或评审</span>
    </div>

    <table class="ledger ledger--fixed gate-table">
      <thead><tr><th style="width:9%">计划日期</th><th style="width:22%">项目</th><th style="width:13%">关口</th><th style="width:7%">阶段</th><th style="width:10%">状态</th><th style="width:8%">评审人</th><th style="width:8%">清单</th><th>结论 / 条件</th><th style="width:7%"></th></tr></thead>
      <tbody>${rows || emptyRow(9, '没有符合条件的关口')}</tbody>
    </table>
    <p class="dlv-note">关口结论、条件和评审人会写入审计日志。项目经理可以查看本项目的关口，但不能自行修改结论。</p>
  </div>`;
}

function openGateModal(gate) {
  const isEdit = Boolean(gate);
  const isPmo = state.me.role === 'pmo';
  const projects = state.data.projects;
  const todayStr = today();
  openModal({
    title: isEdit ? '关口评审' : '新增阶段关口',
    sub: isEdit
      ? `${gate.project?.name || ''} · ${gate.name} · ${gate.checkTotal ? `检查清单 ${gate.checkDone}/${gate.checkTotal}` : '未生成检查清单'} · ${isPmo ? '填写结论后保存' : '仅 PMO 可修改评审结论'}`
      : '关口应由 PMO 在阶段转换前安排，计划日期尽量避开发版与业务高峰。',
    submit: isEdit ? '保存评审结论' : '创建关口',
    wide: true,
    readOnly: !isPmo,
    fields: [
      { name: 'project_id', label: '所属项目', type: 'select', value: gate?.project_id || projects[0]?.id, disabled: isEdit,
        options: projects.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` })) },
      { name: 'name', label: '关口名称', value: gate?.name || '', required: true, placeholder: '如：上线评审 / 验收评审' },
      { name: 'phase', label: '阶段', type: 'select', value: gate?.phase || '执行', options: ['立项', '规划', '执行', '验收', '结项'] },
      { name: 'planned_date', label: '计划评审日期', type: 'date', value: gate?.planned_date || todayStr, required: true },
      { name: 'status', label: '评审结论', type: 'select', value: gate?.status || '待评审', options: GATE_STATUSES },
      { name: 'actual_date', label: '实际评审日期', type: 'date', value: gate?.actual_date || '' },
      { name: 'reviewer', label: '评审人', value: gate?.reviewer || '', placeholder: '默认当前 PMO' },
      { name: 'decision', label: '结论', type: 'textarea', full: true, value: gate?.decision || '', placeholder: '通过/有条件通过/未通过的具体理由' },
      { name: 'conditions', label: '条件与后续动作', type: 'textarea', full: true, value: gate?.conditions || '', placeholder: '有条件通过或未通过时，列出必须补齐的事项和时间点' },
    ],
    onSubmit: async (v) => {
      if (!isPmo) return;
      if (v.status !== '待评审' && !String(v.decision || '').trim()) {
        throw new Error('请先填写评审结论');
      }
      if (isEdit) {
        await api(`/api/gates/${gate.id}`, { method: 'PATCH', body: v });
      } else {
        await api('/api/gates', { method: 'POST', body: v });
      }
      await reload();
      toast(isEdit ? '关口评审已保存' : '关口已创建');
    },
  });
}

async function openGateChecklist(gate) {
  const isPmo = state.me.role === 'pmo';
  let data;
  try {
    data = await api(`/api/gates/${gate.id}/checks`);
  } catch (e) {
    toast(e.message, 'err');
    return;
  }
  if (!data.checks.length) {
    openModal({
      title: `检查清单 · ${gate.name}`,
      sub: '这个关口还没有检查项。生成默认模板后，逐项确认；必检项没完成时不能判“通过”。',
      readOnly: !isPmo,
      submit: '生成默认清单',
      fields: [],
      onSubmit: async () => {
        await api(`/api/gates/${gate.id}/checks/default`, { method: 'POST' });
        await reload();
        toast('检查清单已生成');
      },
    });
    return;
  }
  openModal({
    title: `检查清单 · ${gate.name}`,
    sub: `必检 ${data.done}/${data.required} 完成${data.incomplete ? `，还有 ${data.incomplete} 项未完成` : '，已满足通过条件'}`,
    wide: true,
    readOnly: !isPmo,
    submit: '保存清单',
    fields: data.checks.map((c) => ({
      name: `check_${c.id}`,
      label: `${c.required ? '[必检] ' : ''}${c.item}`,
      type: 'select',
      value: c.status,
      options: ['未完成', '已完成', '不适用'],
    })),
    onSubmit: async (v) => {
      if (!isPmo) return;
      for (const c of data.checks) {
        await api(`/api/gates/checks/${c.id}`, { method: 'PATCH', body: { status: v[`check_${c.id}`] } });
      }
      await reload();
      toast('检查清单已保存');
    },
  });
}

function viewResources() {
  if (!state.data.projects.length) return emptyProgramView('RESOURCE LOAD <span class="sep">/</span> FTE', '资源负载', '按人员汇总跨项目投入，发现重复承诺。');
  const r = state.resources;
  const people = r.people;
  const s = r.summary;
  const cap = r.capacity || { months: [], people: [], capacity: 100 };

  const rows = people.map((p, i) => {
    const cls = p.total > 100 ? 'over' : p.total >= 85 ? 'warn' : 'ok';
    return `<tr class="fade-row" style="--i:${i}">
      <td><div style="display:flex;align-items:center;gap:10px"><span class="avatar">${esc(p.person.slice(0, 1))}</span><b style="font-weight:500">${esc(p.person)}</b></div></td>
      <td><div class="load-cell">
        <div class="load-bar"><span class="${cls}" style="width:${Math.min(100, p.total)}%"></span></div>
        <span class="load-val">${p.total}%</span>
      </div></td>
      <td><span class="chip ${p.total > 100 ? 'chip--oxblood' : p.total >= 85 ? 'chip--ochre' : 'chip--jade'}">${p.total > 100 ? '过载' : p.total >= 85 ? '饱和' : '正常'}</span></td>
      <td><div style="display:flex;flex-wrap:wrap;gap:5px">${p.items.map((it) => `<span class="chip" title="${esc(it.role || '')}">${esc(it.code)} · ${it.pct}%</span>`).join('')}</div></td>
    </tr>`;
  }).join('');

  return `<div class="view-enter">
    ${pageHead({
      eyebrow: 'RESOURCE LOAD / FTE',
      title: '资源负载',
      sub: '按人员汇总跨项目投入。负载超过 100% 意味着该成员在同一时期被重复承诺，是项目群层面最常见的隐性风险。',
    })}
    <div class="pulse" style="grid-template-columns:repeat(4,1fr)">
      <div class="pulse-cell"><span class="pulse-label">投入人数</span><div class="pulse-value">${s.headcount}<span class="unit">人</span></div><span class="pulse-note">去重后参与项目群的人员</span></div>
      <div class="pulse-cell"><span class="pulse-label">平均负载</span><div class="pulse-value">${s.avgLoad}<span class="unit">%</span></div><span class="pulse-note">按 FTE 百分比计算</span></div>
      <div class="pulse-cell"><span class="pulse-label">过载人员</span><div class="pulse-value" style="color:${s.overloaded ? 'var(--oxblood)' : 'inherit'}">${s.overloaded}<span class="unit">人</span></div><span class="pulse-note">负载 > 100%</span></div>
      <div class="pulse-cell"><span class="pulse-label">低负载</span><div class="pulse-value">${s.idle}<span class="unit">人</span></div><span class="pulse-note">负载 < 60%，可承接新任务</span></div>
    </div>

    <table class="ledger">
      <thead><tr><th style="width:22%">成员</th><th style="width:26%">总负载</th><th style="width:10%">状态</th><th>所属项目 / 投入比例</th></tr></thead>
      <tbody>${rows || emptyRow(4, '暂无投入记录')}</tbody>
    </table>

    <section class="panel" style="margin-top:28px">
      <div class="panel-head">
        <h2><span class="no">02</span>未来 6 个月需求 vs 产能</h2>
        <span class="hint">按计划任务工期折算 · 每人每月产能 100%</span>
      </div>
      <div class="cap-scroll">
        <table class="ledger cap-table">
          <thead><tr><th style="width:18%">成员</th><th style="width:16%">乙方</th>${cap.months.map((m) => `<th>${m.label}</th>`).join('')}<th style="width:9%">峰值</th></tr></thead>
          <tbody>${cap.people.length ? cap.people.map((p) => `<tr>
            <td><div style="display:flex;align-items:center;gap:8px"><span class="avatar avatar--sm">${esc(p.person.slice(0, 1))}</span><b style="font-weight:500;font-size:12.5px">${esc(p.person)}</b></div></td>
            <td class="muted" style="font-size:11px">${esc(p.vendor || '—')}</td>
            ${cap.months.map((m) => {
              const v = p.months[m.key] || 0;
              const cls = v > 100 ? 'is-over' : v >= 80 ? 'is-warn' : v > 0 ? 'is-ok' : 'is-zero';
              return `<td class="cap-cell ${cls}"><span>${v ? `${v}%` : '—'}</span></td>`;
            }).join('')}
            <td class="cap-cell ${p.peak > 100 ? 'is-over' : ''}"><b>${p.peak}%</b></td>
          </tr>`).join('') : emptyRow(3 + cap.months.length, '还没有任务负责人数据')}</tbody>
        </table>
      </div>
      <p class="dlv-note">需求按任务与月份的工期重叠折算：一个人整月投入一个任务算 100%。同一人多个任务重叠会累加；超过 100% 说明这一个月被重复承诺。</p>
    </section>
  </div>`;
}

/* -------------------------------------------------------------- editor --- */

const EDITOR_FIELDS = {
  weekly: [
    { key: 'markdown', label: '周报正文', rows: 24, placeholder: '# 本周周报\n\n## 本周进展\n...', hint: () => '全部用 Markdown 写；进度、风险和计划任务可从右侧参考，不要重复抄一遍' },
  ],
  plan: [
    { key: 'objective', label: '目标与范围', required: true, rows: 5, placeholder: '本周期要交付什么、不做什么' },
    { key: 'keyResults', label: '关键结果（每行一条）', rows: 5, placeholder: '12 月底前完成 50% 渠道切换\n核心接口 P99 低于 200ms' },
    { key: 'resources', label: '资源需求', rows: 4, placeholder: '需要的人、角色、投入比例、环境或采购' },
    { key: 'risks', label: '风险与应对', rows: 4, placeholder: '主要风险、触发条件、应对措施' },
    { key: 'support', label: '需协调事项', rows: 3, placeholder: '需要项目群层面拍板或协调的事' },
  ],
};

function periodLabelOf(kind, period) {
  if (kind === 'weekly') return weekText(period);
  return /-Q/.test(period) ? quarterText(period) : `${period.slice(0, 4)} 年 ${Number(period.slice(5, 7))} 月`;
}

function fmtDue(v) {
  if (!v) return '—';
  return v.slice(5, 16).replace('T', ' ');
}

function editorFieldHTML(f, ed, project) {
  const locked = f.key === 'progress' && ed.planLocked;
  const val = locked ? (ed.planContext?.projectProgress ?? ed.content[f.key] ?? '') : (ed.content[f.key] ?? '');
  const dis = (ed.canEdit && !locked) ? '' : 'disabled';
  const control = f.type === 'number'
    ? `<input id="ef-${f.key}" data-editor-field="${f.key}" type="number" min="${f.min ?? 0}" max="${f.max ?? 100}" value="${esc(val)}" ${dis} />`
    : `<textarea id="ef-${f.key}" data-editor-field="${f.key}" rows="${f.rows || 4}" placeholder="${esc(f.placeholder || '')}" ${dis}>${esc(val)}</textarea>`;
  return `<div class="field ${f.half ? 'field--half' : 'field--full'}">
    <label for="ef-${f.key}">${esc(f.label)}${f.required ? ' *' : ''}</label>
    ${control}
    ${locked
      ? '<span class="help">由项目整体计划自动汇总，不能手改</span>'
      : (f.hint ? `<span class="help">${esc(f.hint(project))}</span>` : '')}
  </div>`;
}

function versionPreviewHTML(kind, content) {
  if (kind === 'weekly') {
    return `<div class="version-item"><span>周报正文</span><div class="md-preview">${renderMarkdown(content.markdown || weeklyContentToMarkdown(content))}</div></div>`;
  }
  return EDITOR_FIELDS[kind].map((f) => `<div class="version-item">
    <span>${esc(f.label)}</span><p>${content[f.key] ? multiline(content[f.key]) : '—'}</p>
  </div>`).join('');
}

async function viewWrite() {
  const { kind, projectId, period } = state.params;
  if (!EDITOR_FIELDS[kind] || !projectId || !period) {
    return `<div class="view-enter"><div class="empty" style="padding:80px 0">填报参数不完整。<br><br><a class="btn btn--quiet" href="#/deliverables">返回列表</a></div></div>`;
  }
  let data;
  try {
    data = await api(`/api/deliverables/${kind}/by-project/${projectId}?period=${encodeURIComponent(period)}`);
  } catch (e) {
    return `<div class="view-enter">
      ${pageHead({ eyebrow: 'DELIVERY WORKFLOW', title: '无法打开填报页', sub: esc(e.message) })}
      <a class="btn btn--quiet" href="#/deliverables" style="margin-top:20px">返回列表</a>
    </div>`;
  }
  const project = state.data.projects.find((p) => p.id === projectId) || data.project;
  const key = `${kind}:${projectId}:${period}`;
  if (!state.editor || state.editor.key !== key) {
    const initial = data.item ? { ...data.item.content } : defaultDlvContent(kind, project);
    if (kind === 'weekly') initial.markdown = weeklyContentToMarkdown(initial);
    if (!data.item && data.template?.content_md) initial.markdown = sanitizeWeeklyTemplate(data.template.content_md);
    state.editor = {
      key, kind, projectId, period,
      item: data.item,
      content: initial,
      versions: data.versions || [],
      comments: data.comments || [],
      dueAt: data.dueAt,
      canEdit: data.canEdit,
      planContext: data.planContext || null,
      planLocked: Boolean(data.planContext?.locked),
      acceptance: data.acceptance || null,
      template: data.template || null,
      mdView: (() => { try { return localStorage.getItem('pmo.mdview') || 'split'; } catch { return 'split'; } })(),
      dirty: false,
      saving: false,
      lastSaved: data.item?.updated_at || null,
      timer: null,
    };
  } else {
    const ed = state.editor;
    ed.versions = data.versions || [];
    ed.comments = data.comments || [];
    ed.dueAt = data.dueAt;
    ed.canEdit = data.canEdit;
    ed.planContext = data.planContext || null;
    ed.planLocked = Boolean(data.planContext?.locked);
    ed.acceptance = data.acceptance || null;
    ed.template = data.template || null;
    ed.item = data.item;
    if (!ed.dirty) {
      ed.content = data.item ? { ...data.item.content } : ed.content;
      if (ed.kind === 'weekly') ed.content.markdown = weeklyContentToMarkdown(ed.content);
    }
    if (ed.planLocked && ed.planContext) ed.content.progress = ed.planContext.projectProgress;
  }
  return editorHTML(project);
}

function editorHTML(project) {
  const ed = state.editor;
  const me = state.me;
  const isPmo = me.role === 'pmo';
  const kindLabel = ed.kind === 'weekly' ? '项目周报' : '项目计划';
  const status = ed.item ? ed.item.status : 'missing';
  const frozen = !ed.canEdit;
  const duePast = ed.dueAt && new Date(ed.dueAt).getTime() < Date.now() && !['submitted', 'approved'].includes(status);

  const banner = status === 'rejected'
    ? `<div class="editor-banner editor-banner--bad"><b>已被 PMO 退回</b><p>${esc(ed.item.review_comment || '请根据审核意见修改后重新提交')}</p></div>`
    : status === 'approved'
      ? `<div class="editor-banner editor-banner--ok"><b>已通过审核</b><p>${esc(ed.item.reviewer_name || 'PMO')} 于 ${fmtDateTime(ed.item.reviewed_at)} 确认，内容已锁定。</p></div>`
      : status === 'submitted'
        ? `<div class="editor-banner"><b>已提交，等待 PMO 审核</b><p>审核期间不能修改。如有补充，可在右侧沟通记录里留言。</p></div>`
        : '';

  const canAccept = isPmo || project.client_pm_id === me.id;
  const acceptanceBox = status === 'approved'
    ? (ed.acceptance
      ? `<div class="acceptance-banner"><b>甲方确认：${esc(ed.acceptance.conclusion)}</b><span>${esc(ed.acceptance.accepted_by || '')} · ${fmtDateTime(ed.acceptance.accepted_at)}${ed.acceptance.notes ? ` · ${esc(ed.acceptance.notes)}` : ''}</span></div>`
      : (canAccept && ed.item ? `<div class="acceptance-banner acceptance-banner--pending"><b>待甲方确认</b><span>交付物已由 PMO 审核通过，可以登记正式验收结论。</span><button class="btn btn--sm btn--quiet" data-action="editor-accept">甲方确认</button></div>` : ''))
    : '';
  const fields = ed.kind === 'weekly'
    ? markdownEditorHTML(ed)
    : EDITOR_FIELDS[ed.kind].map((f) => editorFieldHTML(f, ed, project)).join('');
  const planPanel = ed.kind === 'weekly' && ed.planContext?.hasPlan ? `<div class="editor-plan-context">
      <div class="editor-plan-head"><b>本周计划任务</b><span>${ed.planContext.tasks.length} 项 · 项目进度 ${ed.planContext.projectProgress}%</span></div>
      <div class="editor-plan-list">
        ${ed.planContext.tasks.length ? ed.planContext.tasks.map((t) => `<div class="editor-plan-row">
          <span class="mono-sm">${t.start_date?.slice(5) || '—'} ~ ${t.end_date?.slice(5) || '—'}</span>
          <b>${esc(t.name)}</b>
          <span class="plan-pill ${t.progress >= 100 ? 'is-done' : ''}">${t.progress}%</span>
        </div>`).join('') : '<span class="placeholder">本周没有计划任务</span>'}
      </div>
      ${ed.canEdit ? `<button class="btn btn--sm btn--quiet" data-action="editor-plan-fill">把本周任务带入正文</button>` : ''}
    </div>` : '';

  const checks = (ed.kind === 'weekly'
    ? [
      ['markdown', '周报正文', Boolean(markdownBodyPlain(ed.content.markdown || '').trim())],
      ['progress', '项目进度已同步', Number(ed.content.progress) > 0],
      ['plan', '本周计划任务', Boolean(ed.planContext?.tasks?.length)],
    ]
    : [['objective', '目标与范围'], ['keyResults', '关键结果'], ['resources', '资源需求'], ['risks', '风险与应对']])
    .map(([key, label, preset]) => {
      const val = ed.content[key];
      const done = preset !== undefined ? preset : String(val || '').trim().length > 0;
      return `<li data-check="${key}" class="${done ? 'is-done' : ''}"><i></i>${label}</li>`;
    }).join('');

  const facts = [
    ['健康度', `${project.health?.score ?? '—'} / 100`],
    ['当前进度', `${project.progress}%`],
    ['下个里程碑', project.nextMilestone ? `${project.nextMilestone.name} · ${project.nextMilestone.due_date}` : '—'],
    ['未关闭风险', `${project.openRisks ?? 0} 项`],
  ].map(([k, v]) => `<div class="side-fact"><span>${k}</span><b>${esc(v)}</b></div>`).join('');

  const comments = ed.comments.length
    ? ed.comments.map((c) => `<div class="comment ${c.role === 'pmo' ? 'comment--pmo' : ''}">
        <div class="comment-head"><b>${esc(c.author_name)}</b>${c.role === 'pmo' ? '<span class="role-tag">PMO</span>' : ''}<i>${fmtDateTime(c.created_at)}</i></div>
        <p>${multiline(c.body)}</p>
      </div>`).join('')
    : '<p class="side-empty">还没有沟通记录。</p>';

  const versions = ed.versions.length
    ? ed.versions.map((v) => `<details class="version">
        <summary><b>第 ${v.version} 版</b><span>${esc(v.author_name || '')}</span><i>${fmtDateTime(v.created_at)}</i></summary>
        <div class="version-body">${versionPreviewHTML(ed.kind, v.content)}</div>
      </details>`).join('')
    : '<p class="side-empty">提交后生成版本记录，便于对比修改内容。</p>';

  const canComment = Boolean(ed.item) && (ed.canEdit || isPmo);

  return `<div class="view-enter editor${ed.kind === 'weekly' ? ' editor--weekly' : ''}">
    <a class="crumb" href="#/deliverables">← 计划与周报 <span>/</span> ${kindLabel}</a>
    <header class="editor-head">
      <div>
        <div class="eyebrow">${kindLabel} <span class="sep">/</span> ${esc(periodLabelOf(ed.kind, ed.period))}</div>
        <h1 class="detail-title">${esc(project.name)}</h1>
        <div class="detail-meta">
          <span>${esc(project.code)} · 乙方 <b>${esc(project.pm || '未指定')}</b> · 甲方 <b>${esc(project.client_pm || '未指定')}</b></span>
          <span>截止 <b>${fmtDue(ed.dueAt)}</b></span>
          ${duePast ? '<span class="overdue-text">已逾期</span>' : ''}
        </div>
      </div>
      <div class="editor-status" id="editor-status">
        <span data-status-chip>${dlvChip(ed.item)}</span>
        <span class="due-note">${status === 'missing' ? '尚未提交' : status === 'draft' ? '草稿' : status === 'submitted' ? '等待 PMO' : status === 'approved' ? '已确认' : '待修改'}</span>
      </div>
    </header>

    <div class="editor-grid">
      <main class="editor-main">
        ${banner}
        ${acceptanceBox}
        <div class="editor-form-head">
          <h2>${ed.kind === 'weekly' ? '周报内容' : '计划内容'}</h2>
          <div style="display:flex;gap:7px;flex-wrap:wrap">
            ${ed.canEdit ? `<button class="btn btn--sm btn--quiet" data-action="editor-prefill">${ed.kind === 'weekly' ? '插入项目现状' : '复制上期计划'}</button>` : ''}
            ${ed.canEdit && ed.kind === 'weekly' ? '<button class="btn btn--sm btn--quiet" data-action="editor-template">套用周报模板</button>' : ''}
          </div>
        </div>
        ${planPanel}
        <div class="editor-fields">${fields}</div>
        <div class="editor-actions">
          <button class="btn btn--quiet" data-action="dlv-back">返回</button>
          <div class="editor-actions-right">
            ${ed.canEdit ? `<button class="btn btn--quiet" data-action="editor-save">保存草稿</button>
              <button class="btn btn--solid" data-action="editor-submit">提交审核</button>` : ''}
            ${isPmo && status === 'approved' ? '<button class="btn btn--quiet" data-action="editor-reopen">撤回审核</button>' : ''}
          </div>
        </div>
      </main>

      <aside class="editor-side">
        <div class="side-block">
          <span class="side-label">保存状态</span>
          <div class="save-state" id="save-status">${ed.dirty ? '未保存' : ed.lastSaved ? `已保存 ${fmtDateTime(ed.lastSaved)}` : '尚未保存'}</div>
          <span class="side-hint">${ed.canEdit ? '停止输入 1.5 秒后自动保存草稿' : '当前内容不可编辑'}</span>
        </div>

        <div class="side-block">
          <span class="side-label">提交检查</span>
          <ul class="editor-checks">${checks}</ul>
        </div>

        <div class="side-block">
          <span class="side-label">项目现状</span>
          <div class="side-facts">${facts}</div>
        </div>

        <div class="side-block">
          <span class="side-label">沟通记录</span>
          <div class="comment-list">${comments}</div>
          ${canComment ? `<div class="comment-box">
            <textarea id="editor-comment" rows="3" aria-label="沟通记录留言" placeholder="回复审核意见或补充说明"></textarea>
            <button class="btn btn--sm btn--quiet" data-action="editor-comment">发送</button>
          </div>` : ''}
        </div>

        <div class="side-block">
          <span class="side-label">历史版本</span>
          <div class="version-list">${versions}</div>
        </div>
      </aside>
    </div>
  </div>`;
}

function setSaveStatus(text) {
  const el = $('#save-status');
  if (el) el.textContent = text;
}

function updateEditorChip() {
  const ed = state.editor;
  const wrap = document.querySelector('#editor-status [data-status-chip]');
  if (wrap && ed?.item) {
    wrap.outerHTML = `<span data-status-chip>${dlvChip(ed.item)}</span>`;
  }
}

function updateEditorChecklist() {
  const ed = state.editor;
  if (!ed) return;
  document.querySelectorAll('.editor-checks [data-check]').forEach((li) => {
    const key = li.dataset.check;
    let done;
    if (ed.kind === 'weekly') {
      done = key === 'markdown' ? Boolean(markdownBodyPlain(ed.content.markdown || '').trim())
        : key === 'progress' ? Number(ed.content.progress) > 0
          : key === 'plan' ? Boolean(ed.planContext?.tasks?.length) : false;
    } else {
      done = String(ed.content[key] || '').trim().length > 0;
    }
    li.classList.toggle('is-done', done);
  });
}

function syncEditorForm() {
  const ed = state.editor;
  if (!ed) return;
  if (ed.kind === 'weekly') {
    const ta = document.getElementById('ef-markdown');
    if (ta) ta.value = ed.content.markdown || '';
    const preview = document.getElementById('md-preview');
    if (preview) preview.innerHTML = renderMarkdown(ed.content.markdown || '');
    const count = document.getElementById('md-count');
    if (count) count.textContent = markdownCount(ed.content.markdown || '');
  } else {
    EDITOR_FIELDS[ed.kind].forEach((f) => {
      const el = document.querySelector(`[data-editor-field="${f.key}"]`);
      if (el) el.value = ed.content[f.key] ?? '';
    });
  }
  updateEditorChecklist();
}

function markEditorDirty() {
  const ed = state.editor;
  if (!ed || !ed.canEdit) return;
  ed.dirty = true;
  setSaveStatus('未保存');
  clearTimeout(ed.timer);
  ed.timer = setTimeout(() => { saveEditor(); }, 1500);
}

async function saveEditor(force = false) {
  const ed = state.editor;
  if (!ed || !ed.canEdit) return ed?.item || null;
  if (ed.saving) return ed.item;
  if (!ed.dirty && !force) return ed.item;
  ed.saving = true;
  clearTimeout(ed.timer);
  const payload = JSON.stringify(ed.content);
  setSaveStatus('保存中…');
  try {
    let item = ed.item;
    if (item) {
      const r = await api(`/api/deliverables/${ed.kind}/${item.id}`, { method: 'PATCH', body: { content: JSON.parse(payload) } });
      item = r.item;
    } else {
      const r = await api('/api/deliverables', {
        method: 'POST',
        body: { kind: ed.kind, project_id: ed.projectId, period: ed.period, content: JSON.parse(payload) },
      });
      item = r.item;
    }
    ed.item = item;
    const stillDirty = JSON.stringify(ed.content) !== payload;
    ed.dirty = stillDirty;
    ed.lastSaved = new Date().toISOString();
    setSaveStatus(`已保存 ${fmtDateTime(ed.lastSaved)}${stillDirty ? '（有新修改）' : ''}`);
    updateEditorChip();
    if (stillDirty) ed.timer = setTimeout(() => { saveEditor(); }, 800);
    return item;
  } catch (e) {
    setSaveStatus('保存失败');
    toast(e.message, 'err');
    return null;
  } finally {
    ed.saving = false;
  }
}

function openHelpArticleModal(article) {
  const isEdit = Boolean(article);
  openModal({
    title: isEdit ? '编辑知识库文章' : '新增知识库文章',
    sub: '文章会进入帮助中心，也会参与智能问答的检索。正文用 Markdown。',
    wide: true,
    submit: isEdit ? '保存' : '新增',
    fields: [
      { name: 'slug', label: 'Slug', required: true, value: article?.slug || '', placeholder: '如 weekly-report' },
      { name: 'title', label: '标题', required: true, value: article?.title || '' },
      { name: 'category', label: '分类', value: article?.category || '入门', placeholder: '入门 / 流程 / 数据 / AI' },
      { name: 'published', label: '状态', type: 'select', value: article?.published === 0 ? '0' : '1', options: [{ value: '1', label: '发布' }, { value: '0', label: '草稿' }] },
      { name: 'summary', label: '摘要', full: true, value: article?.summary || '' },
      { name: 'content_md', label: '正文（Markdown）', type: 'textarea', full: true, rows: 16, value: article?.content_md || '' },
    ],
    onDelete: isEdit ? async () => {
      await api(`/api/admin/help/${article.id}`, { method: 'DELETE' });
      await reload({ keepScroll: false });
      toast('文章已删除');
    } : undefined,
    onSubmit: async (v) => {
      const body = { ...v, published: v.published === '1' };
      if (isEdit) await api(`/api/admin/help/${article.id}`, { method: 'PATCH', body });
      else await api('/api/admin/help', { method: 'POST', body });
      await reload({ keepScroll: false });
      toast(isEdit ? '文章已更新' : '文章已新增');
    },
  });
}

function openScoreModal(p) {
  const score = p.score || { strategic: 3, benefit: 3, feasibility: 3, risk: 3, effort: 3, notes: '' };
  const opts = [1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }));
  openModal({
    title: `组合评分 · ${p.code}`,
    sub: '战略契合和收益越高越好；风险和投入越高，组合分越低。评分只影响排序，不改项目健康度。',
    fields: [
      { name: 'strategic', label: '战略契合（1–5）', type: 'select', value: score.strategic, options: opts },
      { name: 'benefit', label: '收益（1–5）', type: 'select', value: score.benefit, options: opts },
      { name: 'feasibility', label: '可行性（1–5）', type: 'select', value: score.feasibility, options: opts },
      { name: 'risk', label: '风险（1–5，越高越差）', type: 'select', value: score.risk, options: opts },
      { name: 'effort', label: '投入（1–5，越高越差）', type: 'select', value: score.effort, options: opts },
      { name: 'notes', label: '评分说明', type: 'textarea', full: true, value: score.notes || '' },
    ],
    submit: '保存评分',
    onSubmit: async (v) => {
      await api(`/api/projects/${p.id}/score`, { method: 'PATCH', body: v });
      await reload({ keepScroll: false });
      toast('组合评分已更新');
    },
  });
}

async function openTemplateReference(category) {
  const label = TEMPLATE_CATEGORIES[category] || '项目';
  let data;
  try { data = await api(`/api/templates?category=${category}`); } catch (e) { toast(e.message, 'err'); return; }
  if (!data.templates.length) { toast(`还没有${label}模板，请 PMO 先在模板管理里新增`, 'err'); return; }
  openModal({
    title: `${label}模板`,
    sub: '模板来自 PMO 维护的模板库，仅供参照，不会改动当前项目内容。',
    fields: [{
      name: 'template_id',
      label: '选择模板',
      type: 'select',
      options: data.templates.map((t) => ({ value: t.id, label: `${t.name}${t.is_default ? '（默认）' : ''}` })),
    }],
    submit: '查看模板',
    onSubmit: async (v) => {
      const t = data.templates.find((x) => x.id === Number(v.template_id));
      if (t) setTimeout(() => openTemplateView(t), 80);
    },
  });
}

function openTemplateView(t) {
  openModal({
    title: t.name,
    sub: '参考模板。需要修改时，请 PMO 到「管理维护 → 模板管理」里编辑。',
    readOnly: true,
    fields: [{
      name: 'content_md', label: '正文（Markdown）', type: 'textarea', rows: 18, value: t.content_md || '',
    }],
  });
}

async function openTemplatePicker() {
  const ed = state.editor;
  if (!ed?.canEdit) return;
  let data;
  try { data = await api('/api/templates?category=weekly'); } catch (e) { toast(e.message, 'err'); return; }
  if (!data.templates.length) { toast('还没有周报模板，请 PMO 先在模板管理里新增', 'err'); return; }
  openModal({
    title: '套用周报模板',
    sub: '模板来自 PMO 维护的模板库。套用会覆盖当前 Markdown 正文，请确认后再操作。',
    fields: [{
      name: 'template_id',
      label: '选择模板',
      type: 'select',
      options: data.templates.map((t) => ({ value: t.id, label: `${t.name}${t.is_default ? '（默认）' : ''}` })),
    }],
    submit: '套用',
    onSubmit: async (v) => {
      const t = data.templates.find((x) => x.id === Number(v.template_id));
      if (!t) return;
      setMarkdownValue(sanitizeWeeklyTemplate(t.content_md || ''));
      toast(`已套用「${t.name}」`);
    },
  });
}

async function prefillEditor() {
  const ed = state.editor;
  if (!ed || !ed.canEdit) return;
  if (ed.kind === 'weekly') {
    const project = state.data.projects.find((p) => p.id === ed.projectId);
    const risks = state.data.risks.filter((r) => r.project_id === ed.projectId && r.status !== '已关闭');
    const ms = state.data.milestones
      .filter((m) => m.project_id === ed.projectId && m.status !== '已完成')
      .sort((a, b) => a.due_date.localeCompare(b.due_date))
      .slice(0, 3);
    const tasks = ed.planContext?.tasks || [];
    const taskLines = tasks.map((t) => `- ${t.name}：${t.progress >= 100 ? '已完成' : `进行中 ${t.progress}%`}（${t.start_date || ''} ~ ${t.end_date || ''}）`);
    const riskLines = risks.map((r) => `- ${r.title}（敞口 ${r.probability * r.impact}，${r.owner || '待定'}，${r.due_date || '未定'}）`);
    const msLines = ms.map((m) => `- ${m.name}（${m.due_date}）`);
    const current = String(ed.content.markdown || '');
    if (current.includes('## 项目现状参考')) {
      toast('正文里已经有项目现状，没有重复插入');
      return;
    }
    if (!markdownBodyPlain(current).trim()) {
      const md = `# ${project.name} 周报\n\n## 本周进展\n\n- 当前项目进度 ${project.progress}%，阶段「${project.stage}」。\n${taskLines.join('\n')}\n\n## 关键成果\n\n- 待补充本周实际完成的交付物。\n\n## 下周计划\n\n${msLines.length ? msLines.join('\n') : '- 按整体计划推进下一批任务。'}\n\n## 风险与问题\n\n${riskLines.length ? riskLines.join('\n') : '- 当前没有未关闭风险。'}\n\n## 需协调事项\n\n- 待补充需要 PMO 或项目群协调的事项。\n`;
      setMarkdownValue(md);
      toast('已生成周报初稿，按实际情况修改');
      return;
    }
    const block = `\n\n## 项目现状参考\n\n- 当前项目进度 ${project.progress}%，阶段「${project.stage}」。\n${taskLines.length ? `${taskLines.join('\n')}\n` : ''}${riskLines.length ? `- 未关闭风险：\n${riskLines.join('\n')}\n` : ''}${msLines.length ? `- 近期里程碑：\n${msLines.join('\n')}\n` : ''}`;
    setMarkdownValue(`${current.trimEnd()}${block}`);
    toast('已在正文末尾插入项目现状，不需要可以直接删掉');
    return;
  }


  const prev = /-Q/.test(ed.period) ? shiftQuarter(ed.period, -1) : shiftMonth(ed.period, -1);
  const data = await api(`/api/deliverables?kind=plan&period=${encodeURIComponent(prev)}`);
  const row = data.projects.find((p) => p.id === ed.projectId);
  if (!row || !row.item || !row.item.content) {
    toast('上期没有可复制的计划');
    return;
  }
  let changed = 0;
  for (const key of ['objective', 'keyResults', 'resources', 'risks', 'support']) {
    if (!String(ed.content[key] || '').trim() && row.item.content[key]) {
      ed.content[key] = row.item.content[key];
      changed += 1;
    }
  }
  syncEditorForm();
  if (changed) {
    markEditorDirty();
    toast('已复制上期计划，未覆盖已填内容');
  } else {
    toast('已有内容，没有覆盖');
  }
}

async function submitEditorComment() {
  const ed = state.editor;
  if (!ed || !ed.item) {
    toast('请先保存草稿再留言');
    return;
  }
  const box = $('#editor-comment');
  const body = box ? box.value.trim() : '';
  if (!body) return;
  if (ed.dirty) await saveEditor(true);
  await api(`/api/deliverables/${ed.kind}/${ed.item.id}/comments`, { method: 'POST', body: { body } });
  box.value = '';
  await render();
  toast('留言已发送');
}

/* ------------------------------------------------------- deliverables --- */

function weeklyContentToMarkdown(content) {
  const c = content || {};
  if (String(c.markdown || '').trim()) return c.markdown;
  const parts = [];
  const add = (title, value) => {
    if (!String(value || '').trim()) return;
    parts.push(`## ${title}`, '', String(value).trim(), '');
  };
  add('本周进展', c.summary);
  add('关键成果', c.achievements);
  add('下周计划', c.next);
  add('风险与问题', c.issues);
  add('需协调事项', c.support);
  return parts.length ? `# 周报\n\n${parts.join('\n')}` : '';
}

function weeklyMarkdownScaffold(project) {
  return `# ${project?.name || '项目'} 周报\n\n## 本周进展\n\n\n## 关键成果\n\n\n## 下周计划\n\n\n## 风险与问题\n\n\n## 需协调事项\n`;
}

function markdownCount(value) {
  const text = String(value || '');
  const chars = text.replace(/\s/g, '').length;
  const lines = text ? text.split('\n').length : 0;
  return `${chars} 字 · ${lines} 行`;
}

function setMarkdownValue(value, { dirty = true } = {}) {
  const ed = state.editor;
  if (!ed) return;
  const text = String(value ?? '');
  ed.content.markdown = text;
  const ta = document.getElementById('ef-markdown');
  if (ta) ta.value = text;
  const preview = document.getElementById('md-preview');
  if (preview) preview.innerHTML = renderMarkdown(text);
  const count = document.getElementById('md-count');
  if (count) count.textContent = markdownCount(text);
  updateEditorChecklist();
  if (dirty) markEditorDirty();
}

function markdownEditorHTML(ed) {
  const value = ed.content.markdown || '';
  const dis = ed.canEdit ? '' : 'disabled';
  const tools = [
    ['h1', 'H1', '一级标题'], ['h2', 'H2', '二级标题'], ['h3', 'H3', '三级标题'], ['|', '', ''],
    ['bold', 'B', '加粗'], ['italic', 'I', '斜体'], ['strike', 'S', '删除线'], ['code', '`', '行内代码'],
    ['|', '', ''],
    ['ul', '• 列表', '无序列表'], ['ol', '1. 列表', '有序列表'], ['quote', '引用', '引用'],
    ['|', '', ''],
    ['link', '链接', '插入链接'], ['table', '表格', '插入表格'], ['footnote', '脚注', '插入脚注'], ['codeblock', '代码块', '代码块'],
    ['|', '', ''], ['hr', '分割线', '分割线'],
  ];
  const view = ed.mdView || 'split';
  return `<div class="md-editor md-editor--${view}" id="md-editor">
    <div class="md-toolbar" role="toolbar" aria-label="Markdown 编辑工具">
      ${tools.map(([key, label, title]) => key === '|'
        ? '<span class="md-toolbar-sep" aria-hidden="true"></span>'
        : `<button type="button" class="md-tool" data-action="md-insert" data-md="${key}" title="${esc(title)}" aria-label="${esc(title)}" ${dis}>${esc(label)}</button>`).join('')}
      <span class="md-toolbar-spacer"></span>
      <span class="md-view-switch" role="group" aria-label="编辑视图">
        <button type="button" class="md-view${view === 'write' ? ' is-on' : ''}" data-action="md-view" data-value="write">写作</button>
        <button type="button" class="md-view${view === 'split' ? ' is-on' : ''}" data-action="md-view" data-value="split">分栏</button>
        <button type="button" class="md-view${view === 'preview' ? ' is-on' : ''}" data-action="md-view" data-value="preview">预览</button>
      </span>
      <button type="button" class="md-tool md-tool--wide" data-action="md-fullscreen" title="全屏编辑" ${dis}>全屏</button>
    </div>
    <div class="md-split">
      <div class="md-pane md-pane--write">
        <span class="md-pane-label">Markdown</span>
        <textarea id="ef-markdown" data-editor-field="markdown" aria-label="周报正文 Markdown 编辑器" rows="24" placeholder="${esc(ed.kind === 'weekly' ? '# 本周周报\n\n## 本周进展\n...' : '')}" ${dis}>${esc(value)}</textarea>
      </div>
      <div class="md-pane md-pane--preview">
        <span class="md-pane-label">预览</span>
        <div class="md-preview" id="md-preview">${renderMarkdown(value || '*还没有内容*')}</div>
      </div>
    </div>
    <div class="md-editor-foot">
      <span id="md-count">${markdownCount(value)}</span>
      <span>支持标题、列表、表格、脚注、流程图 · Ctrl/⌘ + B/I/K</span>
    </div>
  </div>`;
}

function applyMarkdownSelection(transform) {
  const ta = document.getElementById('ef-markdown');
  if (!ta || !state.editor) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const value = ta.value;
  const selected = value.slice(start, end);
  const result = transform({ value, start, end, selected });
  if (!result) return;
  setMarkdownValue(result.value);
  requestAnimationFrame(() => {
    ta.focus();
    ta.setSelectionRange(result.start, result.end);
  });
}

function insertMarkdown(kind) {
  const wrap = (before, after, placeholder) => applyMarkdownSelection(({ value, start, end, selected }) => {
    const text = selected || placeholder;
    const valueNext = value.slice(0, start) + before + text + after + value.slice(end);
    return { value: valueNext, start: start + before.length, end: start + before.length + text.length };
  });
  const prefixLines = (prefix) => applyMarkdownSelection(({ value, start, end, selected }) => {
    const from = value.lastIndexOf('\n', start - 1) + 1;
    const to = end === start ? value.indexOf('\n', start) : end;
    const blockEnd = to === -1 ? value.length : to;
    const block = value.slice(from, blockEnd) || '内容';
    const lines = block.split('\n').map((line) => `${prefix}${line}`).join('\n');
    return { value: value.slice(0, from) + lines + value.slice(blockEnd), start: from, end: from + lines.length };
  });
  const insertBlock = (text) => applyMarkdownSelection(({ value, start, end }) => {
    const lead = start === 0 || value[start - 1] === '\n' ? '' : '\n\n';
    const tail = end < value.length && value[end] !== '\n' ? '\n' : '';
    return { value: value.slice(0, start) + lead + text + tail + value.slice(end), start: start + lead.length, end: start + lead.length + text.length };
  });
  if (kind === 'bold') wrap('**', '**', '加粗文字');
  else if (kind === 'italic') wrap('*', '*', '斜体文字');
  else if (kind === 'strike') wrap('~~', '~~', '删除文字');
  else if (kind === 'code') wrap('`', '`', '代码');
  else if (kind === 'link') wrap('[', '](https://)', '链接文字');
  else if (kind === 'h1') prefixLines('# ');
  else if (kind === 'h2') prefixLines('## ');
  else if (kind === 'h3') prefixLines('### ');
  else if (kind === 'ul') prefixLines('- ');
  else if (kind === 'ol') prefixLines('1. ');
  else if (kind === 'quote') prefixLines('> ');
  else if (kind === 'codeblock') insertBlock('```\n代码\n```\n');
  else if (kind === 'table') insertBlock('| 项目 | 内容 | 状态 |\n| --- | --- | --- |\n|  |  |  |\n');
  else if (kind === 'footnote') insertBlock('[^1]\n\n[^1]: 说明');
  else if (kind === 'hr') insertBlock('---\n');
}

function defaultDlvContent(kind, project) {
  if (kind === 'weekly') {
    return { progress: project.progress, markdown: weeklyMarkdownScaffold(project) };
  }
  return { objective: project.objective || '', keyResults: '', resources: '', risks: '', support: '' };
}

async function viewDeliverables() {
  if (!state.data.projects.length) return emptyProgramView('DELIVERY WORKFLOW <span class="sep">/</span> PMO REVIEW', '计划与周报', '项目提交的周报与计划在这里汇总，审核后进入项目群报表。');
  const kind = state.dlv.kind;
  const period = kind === 'weekly' ? state.dlv.week : state.dlv.plan;
  const me = state.me;
  const isPmo = me.role === 'pmo';
  let data;
  try {
    data = await api(`/api/deliverables?kind=${kind}&period=${encodeURIComponent(period)}`);
  } catch (e) {
    return `<div class="view-enter">${pageHead({
      eyebrow: 'DELIVERY WORKFLOW',
      title: '计划与周报',
      sub: esc(e.message),
    })}</div>`;
  }
  state.dlvData = data;
  if (state.dlv.onlyMine == null) state.dlv.onlyMine = me.role === 'pm';
  const onlyMine = state.dlv.onlyMine;
  const scope = onlyMine ? data.projects.filter((p) => me.projects.includes(p.id)) : data.projects;
  const st = { total: scope.length, draft: 0, submitted: 0, approved: 0, rejected: 0, missing: 0, slaOverdue: 0, overdueSubmission: 0 };
  for (const row of scope) {
    const status = row.item ? row.item.status : 'missing';
    st[status] += 1;
    if (row.item?.slaOverdue) st.slaOverdue += 1;
    if (row.submissionOverdue) st.overdueSubmission += 1;
  }
  const total = Math.max(1, st.total);
  const current = kind === 'weekly' ? state.data.workflow?.week : state.data.workflow?.quarter;
  const isCurrent = period === current;

  const periodTitle = kind === 'weekly'
    ? weekText(period)
    : (state.dlv.planType === 'quarter'
      ? quarterText(period)
      : `${period.slice(0, 4)} 年 ${Number(period.slice(5, 7))} 月`);
  const periodSub = kind === 'weekly'
    ? `第 ${weekOfYear(parse(period))} 周${isCurrent ? ' · 本周' : ''}`
    : `${data.range.start} ~ ${data.range.end}`;

  const segs = [
    ['approved', 'var(--jade)'],
    ['submitted', 'var(--ochre)'],
    ['rejected', 'var(--oxblood)'],
    ['draft', 'var(--ink-4)'],
    ['missing', 'var(--rule)'],
  ].filter(([k]) => st[k] > 0)
    .map(([k, c]) => `<span style="width:${(st[k] / total) * 100}%;background:${c}"></span>`).join('');

  const legendRows = [
    ['已通过', st.approved, 'var(--jade)'],
    ['待审核', st.submitted, 'var(--ochre)'],
    ['已退回', st.rejected, 'var(--oxblood)'],
    ['草稿', st.draft, 'var(--ink-4)'],
    ['未提交', st.missing, 'var(--rule)'],
  ];
  if (st.slaOverdue) legendRows.push(['审核超时', st.slaOverdue, 'var(--oxblood)']);
  if (st.overdueSubmission) legendRows.push(['逾期未交', st.overdueSubmission, 'var(--oxblood)']);
  const legend = legendRows.map(([label, n, c]) => `<span><i style="background:${c}"></i>${label}<b>${n}</b></span>`).join('');

  const rows = scope.map((p) => {
    const item = p.item;
    const mine = canEditProject(p);
    const status = dlvStatusOf(item);
    const editHref = `data-action="dlv-edit" data-project="${p.id}" data-kind="${kind}" data-period="${period}"`;
    let action;
    if (!item) {
      action = mine
        ? `<button class="btn btn--sm btn--quiet" ${editHref}>填写</button>`
        : '<span class="placeholder">—</span>';
    } else if (isPmo && status === 'submitted') {
      action = `<button class="btn btn--sm btn--solid" data-action="dlv-open" data-project="${p.id}">审核</button>`;
    } else if (item.restricted) {
      action = '<span class="placeholder">—</span>';
    } else if (mine && ['draft', 'rejected'].includes(status)) {
      action = `<button class="btn btn--sm btn--quiet" ${editHref}>修改</button>`;
    } else {
      action = `<button class="btn btn--sm btn--quiet" data-action="dlv-open" data-project="${p.id}">查看</button>`;
    }
    const dueTag = `<span class="due-tag">截止 ${fmtDue(p.dueAt)}</span>`;
    const overdueTag = p.submissionOverdue ? '<span class="sla-tag">逾期未交</span>' : '';
    return `<tr class="is-link" data-action="dlv-open" data-project="${p.id}">
      <td class="dlv-project" data-label="项目">
        <span class="pcode">${esc(p.code)} · ${esc(p.stage)}</span>
        <span class="pname">${esc(p.name)}</span>
      </td>
      <td data-label="负责人">${esc(p.pm || '—')}</td>
      <td data-label="状态">${dlvChip(item)}${item?.slaOverdue ? `<br><span class="sla-tag">超 ${item.reviewAgeHours}h</span>` : ''}${overdueTag}<br>${dueTag}</td>
      <td data-label="提交">${item && item.submitted_at
        ? `<span class="mono-sm">${esc(item.author_name || '—')}</span><br><span class="mono-sm muted">${fmtDateTime(item.submitted_at)}</span>`
        : '<span class="placeholder">—</span>'}</td>
      <td data-label="审核">${item && item.reviewed_at
        ? `<span class="mono-sm">${esc(item.reviewer_name || '—')}</span><br><span class="mono-sm muted">${fmtDateTime(item.reviewed_at)}</span>`
        : '<span class="placeholder">—</span>'}</td>
      <td class="right" data-label="操作">${action}</td>
    </tr>`;
  }).join('');

  const planTypeSwitch = kind === 'plan'
    ? `<div class="dlv-type">
        <button class="${state.dlv.planType === 'quarter' ? 'is-on' : ''}" data-action="dlv-plan-type" data-value="quarter">季度</button>
        <button class="${state.dlv.planType === 'month' ? 'is-on' : ''}" data-action="dlv-plan-type" data-value="month">月度</button>
      </div>`
    : '';

  return `<div class="view-enter">
    ${pageHead({
      eyebrow: `DELIVERY WORKFLOW <span class="sep">/</span> ${isPmo ? 'PMO REVIEW' : 'PROJECT SUBMISSION'}`,
      title: '计划与周报',
      sub: isPmo
        ? '各项目提交的周报与计划在这里汇总。审核通过的内容会进入项目群周报和项目群工作计划的自动汇总，退回时必须写明原因。'
        : '维护你负责项目的周报与计划，提交后由 PMO 审核。被退回的内容修改后可重新提交，已提交的内容不能直接改动。',
      actions: `<span class="role-pill">${isPmo ? ICONS.shield : ''}${esc(roleText(me.role, me.party))} · ${esc(me.name)}</span>`,
    })}

    <div class="dlv-bar">
      <div class="dlv-tabs" role="tablist">
        <button class="dlv-tab ${kind === 'weekly' ? 'is-on' : ''}" data-action="dlv-kind" data-value="weekly" role="tab" aria-selected="${kind === 'weekly'}">项目周报</button>
        <button class="dlv-tab ${kind === 'plan' ? 'is-on' : ''}" data-action="dlv-kind" data-value="plan" role="tab" aria-selected="${kind === 'plan'}">项目计划</button>
        <button class="dlv-mine ${onlyMine ? 'is-on' : ''}" data-action="dlv-mine" aria-pressed="${onlyMine}">只看我的</button>
      </div>
      <div class="period-nav">
        ${planTypeSwitch}
        <button class="icon-btn period-arrow" data-action="dlv-prev" aria-label="上一个周期">${ICONS.chevron}</button>
        <div class="period-text"><b>${esc(periodTitle)}</b><span>${esc(periodSub)}</span></div>
        <button class="icon-btn period-arrow period-arrow--next" data-action="dlv-next" aria-label="下一个周期">${ICONS.chevron}</button>
        ${!isCurrent ? '<button class="btn btn--sm btn--quiet" data-action="dlv-today">回到当前</button>' : ''}
      </div>
    </div>

    <div class="dlv-progress">
      <div class="dlv-seg">${segs}</div>
      <div class="dlv-legend">${legend}</div>
    </div>

    <table class="ledger dlv-table">
      <thead><tr>
        <th style="width:30%">项目</th><th style="width:11%">负责人</th><th style="width:11%">状态</th>
        <th style="width:19%">提交</th><th style="width:19%">审核</th><th style="width:10%"></th>
      </tr></thead>
      <tbody>${rows || emptyRow(6, '暂无项目')}</tbody>
    </table>

    <p class="dlv-note">${isPmo
      ? `共 ${st.total} 个项目，已通过 ${st.approved} 个，待审核 ${st.submitted} 个。审核通过的操作会写入审计日志。`
      : `共 ${st.total} 个项目。你负责 ${me.projects.length} 个，完成提交后状态会变为「待审核」。`}${st.overdueSubmission ? ` 有 ${st.overdueSubmission} 个未在截止时间前提交。` : ''}${st.slaOverdue ? ` 有 ${st.slaOverdue} 个已超过 48 小时审核时限。` : ''}</p>
  </div>`;
}

function readDlvForm(kind) {
  const form = $('#dlv-form');
  if (!form) return state.dlvModal?.item?.content || {};
  const fd = new FormData(form);
  const content = {};
  for (const [k, v] of fd.entries()) {
    if (k === 'reviewComment') continue;
    content[k] = k === 'progress' ? Number(v) : v;
  }
  return content;
}

async function openDeliverableModal(project, item, kind, period) {
  const me = state.me;
  const mine = canEditProject(project);
  const status = dlvStatusOf(item);
  const canEdit = mine && !item?.restricted && (!item || ['draft', 'rejected'].includes(status));
  const canReview = me.role === 'pmo' && status === 'submitted';
  const canReopen = me.role === 'pmo' && status === 'approved';
  const content = item ? item.content : defaultDlvContent(kind, project);

  let versions = [];
  let comments = [];
  if (item && !item.restricted) {
    try {
      const extra = await api(`/api/deliverables/${kind}/${item.id}`);
      versions = extra.versions || [];
      comments = extra.comments || [];
    } catch { /* 历史记录获取失败不影响审核 */ }
  }
  state.dlvModal = { project, item, kind, period };

  const kindLabel = kind === 'weekly' ? '项目周报' : '项目计划';
  const periodLabel = kind === 'weekly'
    ? weekText(period)
    : (state.dlv.planType === 'quarter' ? quarterText(period) : period.replace('-', ' 年 ') + ' 月');

  const meta = `<div class="dlv-meta">
    <div><span>提交人</span><b>${esc(item?.author_name || '—')}</b></div>
    <div><span>提交时间</span><b>${fmtDateTime(item?.submitted_at)}</b></div>
    <div><span>审核人</span><b>${esc(item?.reviewer_name || '—')}</b></div>
    <div><span>审核时间</span><b>${fmtDateTime(item?.reviewed_at)}</b></div>
  </div>
  ${item?.review_comment ? `<div class="note-box" style="margin:0 26px 4px">审核意见：${esc(item.review_comment)}</div>` : ''}`;

  let body;
  if (item?.restricted) {
    body = `<div class="note-box">该项目尚未提交或被退回修改，内容仅项目负责人与 PMO 可见。当前进度 ${content.progress ?? project.progress}%。</div>`;
  } else if (canEdit) {
    const fields = kind === 'weekly'
      ? `<div class="dlv-fields">
          <div class="field"><label for="dv-progress">项目进度（%）</label><input id="dv-progress" name="progress" type="number" min="0" max="100" value="${esc(content.progress ?? 0)}" /></div>
          <div class="field field--full"><label for="dv-summary">本周进展 *</label><textarea id="dv-summary" name="summary" placeholder="完成了什么，做到什么程度，用可核实的结果说话">${esc(content.summary || '')}</textarea></div>
          <div class="field field--full"><label for="dv-achievements">关键成果</label><textarea id="dv-achievements" name="achievements" placeholder="本周期交付物、达成的指标">${esc(content.achievements || '')}</textarea></div>
          <div class="field field--full"><label for="dv-next">下周计划</label><textarea id="dv-next" name="next" placeholder="下周要推进的事和时间点">${esc(content.next || '')}</textarea></div>
          <div class="field field--full"><label for="dv-issues">风险与问题</label><textarea id="dv-issues" name="issues" placeholder="卡点、偏差、需要谁配合">${esc(content.issues || '')}</textarea></div>
          <div class="field field--full"><label for="dv-support">需协调事项</label><textarea id="dv-support" name="support" placeholder="需要 PMO 或项目群层面协调的事">${esc(content.support || '')}</textarea></div>
        </div>`
      : `<div class="dlv-fields">
          <div class="field field--full"><label for="dv-objective">目标与范围 *</label><textarea id="dv-objective" name="objective" placeholder="本周期要交付什么、不做什么">${esc(content.objective || '')}</textarea></div>
          <div class="field field--full"><label for="dv-keyResults">关键结果（每行一条）</label><textarea id="dv-keyResults" name="keyResults" placeholder="12 月底前完成 50% 渠道切换&#10;核心接口 P99 低于 200ms">${esc(content.keyResults || '')}</textarea></div>
          <div class="field field--full"><label for="dv-resources">资源需求</label><textarea id="dv-resources" name="resources" placeholder="需要的人、角色、投入比例、环境或采购">${esc(content.resources || '')}</textarea></div>
          <div class="field field--full"><label for="dv-risks">风险与应对</label><textarea id="dv-risks" name="risks" placeholder="主要风险、触发条件、应对措施">${esc(content.risks || '')}</textarea></div>
          <div class="field field--full"><label for="dv-support">需协调事项</label><textarea id="dv-support" name="support" placeholder="需要项目群层面拍板或协调的事">${esc(content.support || '')}</textarea></div>
        </div>`;
    body = `<form id="dlv-form">${fields}</form>`;
  } else {
    const blocks = kind === 'weekly'
      ? [['本周进展', content.summary], ['关键成果', content.achievements], ['下周计划', content.next], ['风险与问题', content.issues], ['需协调事项', content.support]]
      : [['目标与范围', content.objective], ['关键结果', content.keyResults], ['资源需求', content.resources], ['风险与应对', content.risks], ['需协调事项', content.support]];
    body = `<div class="dlv-read">
      ${kind === 'weekly' ? `<div class="dlv-read-progress"><span>项目进度</span><b>${content.progress ?? '—'}%</b></div>` : ''}
      ${blocks.map(([label, value]) => `<div class="dlv-read-item"><span>${label}</span><p>${value ? multiline(value) : '<i class="placeholder">未填写</i>'}</p></div>`).join('')}
    </div>`;
  }

  const reviewBox = canReview
    ? `<div class="dlv-review">
        <div class="field"><label for="dlv-review-comment">审核意见${canReview ? '（退回必填）' : ''}</label>
        <textarea id="dlv-review-comment" placeholder="通过可不填；退回请说明具体修改要求">${esc(item?.review_comment || '')}</textarea></div>
        <p class="dlv-review-hint">通过后，本项目周报中填报的进度 ${content.progress ?? '—'}% 会同步更新到项目台账。${item?.reviewAgeHours != null ? `当前已等待 ${item.reviewAgeHours} 小时${item.slaOverdue ? '，已超过 48 小时审核时限' : ''}。` : ''}</p>
      </div>`
    : '';

  $('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="modal-backdrop">
    <div class="modal modal--dlv" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">
      <div class="modal-head">
        <div>
          <div class="eyebrow">${kindLabel} <span class="sep">/</span> ${esc(periodLabel)}</div>
          <h3 id="modal-title">${esc(project.name)}</h3>
          <p>${esc(project.code)} · ${esc(project.pm || '')} · ${dlvChip(item)}</p>
        </div>
        <button class="icon-btn" data-action="modal-close" aria-label="关闭">${ICONS.close}</button>
      </div>
      ${meta}
      <div class="modal-body">${body}${reviewBox}
        ${comments.length ? `<div class="dlv-extra">
          <h4>沟通记录 <span>${comments.length}</span></h4>
          <div class="comment-list">${comments.map((c) => `<div class="comment ${c.role === 'pmo' ? 'comment--pmo' : ''}">
            <div class="comment-head"><b>${esc(c.author_name)}</b>${c.role === 'pmo' ? '<span class="role-tag">PMO</span>' : ''}<i>${fmtDateTime(c.created_at)}</i></div>
            <p>${multiline(c.body)}</p>
          </div>`).join('')}</div>
        </div>` : ''}
        ${versions.length ? `<details class="dlv-extra dlv-versions">
          <summary>历史版本 <span>${versions.length}</span></summary>
          <div class="version-list">${versions.map((v) => `<details class="version">
            <summary><b>第 ${v.version} 版</b><span>${esc(v.author_name || '')}</span><i>${fmtDateTime(v.created_at)}</i></summary>
            <div class="version-body">${versionPreviewHTML(kind, v.content)}</div>
          </details>`).join('')}</div>
        </details>` : ''}
      </div>
      <div class="modal-foot dlv-foot">
        <button type="button" class="btn btn--quiet" data-action="modal-close">关闭</button>
        <div class="dlv-foot-actions">
          ${canEdit ? `<button type="button" class="btn btn--quiet" data-action="dlv-save">保存草稿</button>
            <button type="button" class="btn btn--solid" data-action="dlv-submit">提交审核</button>` : ''}
          ${canReview ? `<button type="button" class="btn btn--danger" data-action="dlv-reject">退回</button>
            <button type="button" class="btn btn--solid" data-action="dlv-approve">通过</button>` : ''}
          ${canReopen ? '<button type="button" class="btn btn--quiet" data-action="dlv-reopen">撤回审核</button>' : ''}
        </div>
      </div>
    </div>
  </div>`;
  document.body.style.overflow = 'hidden';
  modalCloser = closeModal;
  activateFocusTrap();
  setTimeout(() => {
    const first = $('#dv-summary, #dv-objective, #dlv-review-comment');
    if (first) first.focus();
  }, 80);
}

async function saveDeliverable(submit) {
  const ctx = state.dlvModal;
  if (!ctx) return;
  const content = readDlvForm(ctx.kind);
  let item = ctx.item;
  if (item) {
    const r = await api(`/api/deliverables/${ctx.kind}/${item.id}`, { method: 'PATCH', body: { content } });
    item = r.item;
  } else {
    const r = await api('/api/deliverables', {
      method: 'POST',
      body: { kind: ctx.kind, project_id: ctx.project.id, period: ctx.period, content },
    });
    item = r.item;
  }
  if (submit) {
    await api(`/api/deliverables/${ctx.kind}/${item.id}/submit`, { method: 'POST' });
  }
  closeModal();
  await reload();
  toast(submit ? '已提交，等待 PMO 审核' : '草稿已保存');
}

async function reviewDeliverable(decision) {
  const ctx = state.dlvModal;
  if (!ctx || !ctx.item) return;
  const comment = String($('#dlv-review-comment')?.value || '').trim();
  if (decision === 'reject' && !comment) {
    toast('退回时必须写明原因', 'err');
    return;
  }
  await api(`/api/deliverables/${ctx.kind}/${ctx.item.id}/review`, {
    method: 'POST',
    body: { decision, comment },
  });
  closeModal();
  await reload();
  toast(decision === 'approve' ? '已通过审核，进度已同步到台账' : '已退回项目组');
}

async function viewProgramPlan() {
  const period = state.planPeriod || state.data.workflow.quarter;
  if (!state.programPlan || state.programPlan.label !== period) {
    try {
      state.programPlan = await api(`/api/program-plan?period=${encodeURIComponent(period)}`);
    } catch (e) {
      return `<div class="view-enter">${pageHead({ eyebrow: 'PROGRAM PLAN', title: '项目群计划', sub: esc(e.message) })}</div>`;
    }
  }
  const r = state.programPlan;
  const sections = r.sections.map((sec, i) => `<section class="sheet-section" id="plan-sec-${i}">
    <h3>${esc(sec.heading)}</h3>
    ${(sec.paragraphs || []).map((p) => `<p>${esc(p)}</p>`).join('')}
    ${(sec.bullets || []).length ? `<ul>${sec.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
  </section>`).join('');

  return `<div class="view-enter">
    ${pageHead({
      eyebrow: 'PROGRAM PLAN <span class="sep">/</span> AUTO-GENERATED',
      title: '项目群计划',
      sub: '依据各项目已审核通过的项目计划自动汇总。未通过审核的内容不会进入项目群计划，避免把未经确认的口径带到项目群层面。',
      actions: `<button class="btn btn--quiet" data-action="plan-copy">${ICONS.copy}复制 Markdown</button>
        <button class="btn btn--quiet" data-action="plan-download">${ICONS.download}下载 .md</button>
        <button class="btn btn--solid" data-action="plan-print">${ICONS.print}打印</button>`,
    })}

    <div class="report-tabs">
      <div class="dlv-tabs">
        <button class="dlv-tab" data-action="report-tab" data-value="weekly">项目群周报</button>
        <button class="dlv-tab is-on" data-action="report-tab" data-value="plan">项目群计划</button>
      </div>
      <div class="period-nav">
        <button class="icon-btn period-arrow" data-action="plan-prev" aria-label="上季度">${ICONS.chevron}</button>
        <div class="period-text"><b>${esc(quarterText(period))}</b><span>${esc(r.range.start)} ~ ${esc(r.range.end)}</span></div>
        <button class="icon-btn period-arrow period-arrow--next" data-action="plan-next" aria-label="下季度">${ICONS.chevron}</button>
      </div>
    </div>

    <div class="plan-coverage">
      <span>已确认项目计划 <b>${r.coverage.approved}</b> / ${r.coverage.total}</span>
      <span class="plan-coverage-bar"><i style="width:${Math.round((r.coverage.approved / Math.max(1, r.coverage.total)) * 100)}%"></i></span>
      <span class="hint">未确认计划的 ${r.coverage.total - r.coverage.approved} 个项目不出现在第二、六部分</span>
    </div>

    <div class="report-layout" style="margin-top:20px">
      <nav class="report-nav" aria-label="计划目录">
        <span class="no">CONTENTS</span>
        ${r.sections.map((sec, i) => `<a href="#/report" data-action="plan-sec" data-idx="${i}">${esc(sec.heading)}</a>`).join('')}
        <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--rule)">
          <span class="no">STATUS</span>
          <div style="font-size:11px;color:var(--ink-3);line-height:1.8">
            周期 ${esc(r.range.start)} ~ ${esc(r.range.end)}<br>生成于 ${esc(r.generatedAt)}
          </div>
        </div>
      </nav>

      <article class="paper-sheet">
        <header class="sheet-head">
          <span class="sheet-kicker">PROGRAM PLAN · CONFIDENTIAL</span>
          <h1 class="sheet-title">${esc(r.title)}</h1>
          <div class="sheet-meta">
            <span>周期 ${esc(r.range.start)} ~ ${esc(r.range.end)}</span>
            <span>编制 PMO</span>
            <span>数据截至 ${today()}</span>
          </div>
        </header>
        ${sections}
        <footer class="sheet-foot">
          <span>本计划依据已审核的项目计划自动汇总</span>
          <span>${esc(state.data.program.code)} / ${today()}</span>
        </footer>
      </article>
    </div>

      </div>`;
}

async function viewReport() {
  if (!state.data.projects.length) return emptyProgramView('WEEKLY REPORT <span class="sep">/</span> AUTO-GENERATED', '项目群周报', '依据台账实时数据生成项目群周报。');
  if (state.reportTab === 'plan') { state.reportSnapshot = null; return viewProgramPlan(); }
  if (!state.reportSnapshot && !state.report) state.report = await api('/api/report');
  const r = state.reportSnapshot || state.report;
  const isPmo = state.me.role === 'pmo';
  const viewingSnapshot = Boolean(state.reportSnapshot);
  const sections = r.sections.map((s, i) => `<section class="sheet-section" id="sec-${i}">
    <h3>${esc(s.heading)}</h3>
    ${(s.paragraphs || []).map((p) => `<p>${esc(p)}</p>`).join('')}
    ${s.table ? `<table class="sheet-table"><thead><tr>${s.table.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${s.table.rows.map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : ''}
    ${(s.bullets || []).length ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
  </section>`).join('');

  return `<div class="view-enter">
    ${pageHead({
      eyebrow: 'WEEKLY REPORT / AUTO-GENERATED',
      title: '项目群周报',
      sub: '依据台账实时数据生成，包含进度、逾期节点、主要风险与需协调事项。可直接复制或导出 Markdown 进入公文流程。',
      actions: `${viewingSnapshot ? '' : (isPmo ? `<button class="btn btn--quiet" data-action="report-snapshot">${ICONS.refresh || ''}更新本周快照</button>` : '')}
        <button class="btn btn--quiet" data-action="report-copy">${ICONS.copy}复制 Markdown</button>
        <button class="btn btn--quiet" data-action="report-download">${ICONS.download}下载 .md</button>
        <button class="btn btn--solid" data-action="report-print">${ICONS.print}打印</button>`,
    })}

    ${viewingSnapshot ? `<div class="report-snapshot-bar"><span>正在查看历史快照：${esc(r.coverage?.weekStart || r.period || '')}，生成于 ${esc(fmtDateTime(r.generated_at || ''))}</span><button class="btn btn--sm btn--quiet" data-action="report-history-back">返回本周</button></div>` : ''}
    ${r.warnings?.length ? `<div class="report-warning"><b>生成时有 ${r.warnings.length} 项数据缺口</b><ul>${r.warnings.map((w) => `<li><strong>${esc(w.title)}</strong>：${esc(w.detail || '')}</li>`).join('')}</ul></div>` : ''}
    <div class="report-tabs">
      <div class="dlv-tabs">
        <button class="dlv-tab is-on" data-action="report-tab" data-value="weekly">项目群周报</button>
        <button class="dlv-tab" data-action="report-tab" data-value="plan">项目群计划</button>
      </div>
      <div class="report-coverage">
        ${r.coverage ? `<span>本周提交 <b>${r.coverage.submitted}</b> / ${r.coverage.total}</span>
        <i></i><span>已审核 <b>${r.coverage.approved}</b></span>` : ''}
        <a href="#/deliverables">去审核 →</a>
      </div>
    </div>

    <div class="report-layout" style="margin-top:26px">
      <nav class="report-nav" aria-label="报告目录">
        <span class="no">CONTENTS</span>
        ${r.sections.map((s, i) => `<a href="#/report" data-action="scroll-sec" data-idx="${i}">${esc(s.heading)}</a>`).join('')}
        <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--rule)">
          <span class="no">STATUS</span>
          <div style="font-size:11px;color:var(--ink-3);line-height:1.8">
            周期 ${esc(r.period)}<br>生成于 ${esc(r.generatedAt)}<br>
            绿 ${r.stats.ragCount.green} · 黄 ${r.stats.ragCount.amber} · 红 ${r.stats.ragCount.red}
          </div>
        </div>
      </nav>

      <article class="paper-sheet" id="report-sheet">
        <header class="sheet-head">
          <span class="sheet-kicker">PMO WEEKLY REPORT · CONFIDENTIAL</span>
          <h1 class="sheet-title">${esc(r.title)}</h1>
          <div class="sheet-meta">
            <span>周期 ${esc(r.period)}</span>
            <span>编制 PMO</span>
            <span>数据截至 ${today()}</span>
          </div>
        </header>
        ${sections}
        <footer class="sheet-foot">
          <span>本报告由项目群管理台依据台账数据自动生成</span>
          <span>${esc(state.data.program.code)} / ${today()}</span>
        </footer>
      </article>
    </div>

    ${isPmo && (r.history || []).length ? `<section class="panel report-history">
      <div class="panel-head"><h2><span class="no">HISTORY</span>历史周报</h2><span class="hint">每周自动保存一份，当前 ${r.history.length} 份</span></div>
      <div class="report-history-list">
        ${r.history.map((h) => `<button class="report-history-item${h.id === r.id ? ' is-current' : ''}" data-action="report-history-open" data-id="${h.id}">
          <span class="report-history-week">${esc(h.week_start)}</span>
          <span class="report-history-main"><b>${esc(h.title)}</b><i>${esc(h.period)} · ${h.trigger === 'manual' ? '手动更新' : h.trigger === 'scheduled' ? '定时生成' : '自动生成'} · ${esc(fmtDateTime(h.generated_at))}</i></span>
          <span class="report-history-warn">${h.warnings?.length ? `${h.warnings.length} 项缺口` : '数据完整'}</span>
        </button>`).join('')}
      </div>
    </section>` : ''}
  </div>`;
}

function resetPasswordValue() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(12);
  if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

function filteredAdminUsers() {
  const users = state.adminUsers || [];
  const f = state.userFilters;
  const q = f.q.trim().toLowerCase();
  return users.filter((u) => {
    if (f.role !== '全部' && u.role !== f.role) return false;
    if (f.party !== '全部' && (u.party || '乙方') !== f.party) return false;
    if (f.status === 'active' && !u.active) return false;
    if (f.status === 'inactive' && u.active) return false;
    if (!q) return true;
    return [u.name, u.username, ...(u.projectRoles || []).map((p) => `${p.code} ${p.name}`)]
      .some((v) => String(v || '').toLowerCase().includes(q));
  });
}

function adminUserRowsHTML() {
  const me = state.me;
  const users = filteredAdminUsers();
  if (!users.length) return '<tr><td colspan="6" style="text-align:center;padding:36px 0;color:var(--ink-3)">没有匹配的账号</td></tr>';
  return users.map((u) => {
    const roles = u.projectRoles || [];
    const shown = roles.slice(0, 3).map((p) => `<span class="chip ${p.side === '甲方' ? 'chip--ochre' : 'chip--jade'}" title="${esc(p.name)}">${esc(p.code)} · ${esc(p.side)}</span>`);
    if (roles.length > 3) shown.push(`<span class="chip chip--dashed">+${roles.length - 3}</span>`);
    const projects = u.role === 'pmo'
      ? '<span class="chip chip--dashed">全部项目</span>'
      : shown.length
        ? shown.join('')
        : (u.projects?.length ? u.projects.slice(0, 3).map((p) => `<span class="chip">${esc(p.code)}</span>`).join('') : '<span class="placeholder">未分配项目</span>');
    return `<tr>
      <td class="c-project" data-label="账号">
        <span class="pname">${esc(u.name)}</span>
        <span class="pcode">${esc(u.username)}</span>
      </td>
      <td data-label="角色"><span class="chip ${u.role === 'pmo' ? 'chip--ink' : ''}">${roleText(u.role, u.party)}</span>${u.vendor_name ? `<span class="user-vendor">${esc(u.vendor_name)}</span>` : u.party === '乙方' ? '<span class="user-vendor user-vendor--none">未挂供应商</span>' : ''}</td>
      <td data-label="负责项目"><div class="user-projects">${projects}</div></td>
      <td data-label="最近登录"><span class="user-last">${u.last_login_at ? fmtDateTime(u.last_login_at) : '从未登录'}</span><span class="user-sessions ${u.sessions ? 'is-on' : ''}">${u.sessions ? `${u.sessions} 个会话` : '无在线会话'}</span></td>
      <td data-label="状态">${u.active ? '<span class="rag rag--green"><i></i>启用</span>' : '<span class="rag rag--red"><i></i>停用</span>'}</td>
      <td data-label="操作" class="right">
        <div class="user-actions">
          <button class="btn btn--sm btn--quiet" data-action="admin-user-edit" data-id="${u.id}">编辑</button>
          ${u.id !== me.id ? `<button class="btn btn--sm btn--quiet" data-action="admin-user-reset" data-id="${u.id}">重置密码</button>` : ''}
          ${u.id !== me.id && u.sessions ? `<button class="btn btn--sm btn--quiet" data-action="admin-user-logout" data-id="${u.id}">强制下线</button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

function refreshAdminUserRows() {
  const body = document.getElementById('user-body');
  if (body) body.innerHTML = adminUserRowsHTML();
  const count = document.getElementById('user-count');
  if (count) count.textContent = `显示 ${filteredAdminUsers().length} / ${state.adminUsers?.length || 0} 个账号`;
}

function aiConfigHTML(cfg) {
  const env = cfg.source === 'env';
  return `<div class="ai-config-grid">
    <section class="panel">
      <div class="panel-head"><h2><span class="no">01</span>AI 接入</h2><span class="hint">${cfg.enabled ? '已启用' : '未启用'} · ${env ? '环境变量' : '前端配置'}</span></div>
      ${env ? `<div class="note-box" style="margin-bottom:16px">当前由服务端环境变量 <span class="kbd">PMO_LLM_BASE_URL</span> 管理，前端只读。要在这里修改，先去掉环境变量并重启服务。</div>` : ''}
      ${cfg.keyBroken ? `<div class="note-box" style="margin-bottom:16px;border-color:var(--oxblood);color:var(--oxblood)">已保存的 Key 无法解密（可能换过服务器或密钥文件）。请重新填写 Key。</div>` : ''}
      <div class="ai-form">
        <label>服务地址
          <input id="ai-base" type="url" value="${esc(cfg.baseUrl || '')}" placeholder="https://api.openai.com/v1 或 http://127.0.0.1:11434/v1" ${env ? 'disabled' : ''} />
          <small>OpenAI 兼容接口，填到 /v1 为止，不要带 /chat/completions。</small>
        </label>
        <label>模型名
          <input id="ai-model" type="text" value="${esc(cfg.model || '')}" placeholder="gpt-4o-mini" ${env ? 'disabled' : ''} />
        </label>
        <label>API Key
          <input id="ai-key" type="password" autocomplete="new-password" placeholder="${cfg.hasKey ? '已保存，留空不修改' : '本地 Ollama 可留空'}" ${env ? 'disabled' : ''} />
          <small>${cfg.hasKey ? '已保存 Key。前端不会回显；留空保持不变。' : 'Key 只在服务端保存，不下发浏览器。'}</small>
        </label>
        ${env ? '' : `<label class="ai-clear"><input id="ai-clear-key" type="checkbox" /> 清除已保存的 Key</label>`}
      </div>
      ${env ? '' : `<div class="ai-form-actions">
        <button class="btn btn--solid btn--sm" data-action="ai-config-save">保存配置</button>
        <button class="btn btn--quiet btn--sm" data-action="ai-config-test">测试连接</button>
      </div>`}
      <div id="ai-test-result" class="ai-test-result"></div>
      <p class="dlv-note">Key 用本机密钥加密后写入数据库；没有服务器文件权限的人看不到。配置外部模型后，项目摘要、风险、周报和知识库片段会发送到该服务，敏感项目请用内网模型。</p>
    </section>
    <aside class="panel">
      <div class="panel-head"><h2><span class="no">02</span>当前状态</h2></div>
      <div class="side-facts">
        <div class="side-fact"><span>状态</span><b>${cfg.enabled ? '已启用' : '未启用'}</b></div>
        <div class="side-fact"><span>来源</span><b>${env ? '环境变量' : '管理界面'}</b></div>
        <div class="side-fact"><span>模型</span><b>${esc(cfg.model || '—')}</b></div>
        <div class="side-fact"><span>API Key</span><b>${cfg.hasKey ? '已保存' : '未保存'}</b></div>
        <div class="side-fact"><span>地址</span><b style="word-break:break-all">${esc(cfg.baseUrl || '—')}</b></div>
        <div class="side-fact"><span>更新时间</span><b>${cfg.updatedAt ? fmtDateTime(cfg.updatedAt) : '—'}</b></div>
      </div>
      <div class="note-box" style="margin-top:16px">
        <b>本地 Ollama 示例</b><br />
        地址：http://127.0.0.1:11434/v1<br />
        模型：qwen2.5:7b<br />
        Key 可以留空。
      </div>
      <p class="dlv-note">保存后立即生效，不用重启。测试连接会真的发一次很短的消息。</p>
    </aside>
  </div>`;
}

function approvalSettingsHTML(cfg) {
  const approvers = cfg.approvers || [];
  return `<div class="ai-config-grid">
    <section class="panel">
      <div class="panel-head"><h2><span class="no">01</span>审批角色</h2><span class="hint">申请人不能审批自己的申请</span></div>
      <p style="font-size:12px;color:var(--ink-3);line-height:1.8;margin:0 0 16px">会议室预订和办公用品领用可以分别指定审批角色。默认是 PMO：PMO 可以审批别人的申请，但不能审批自己的；如果希望 PMO 的申请也由别人审批，请把角色改成「审批员」，并创建至少一个审批员账号。</p>
      <div class="ai-form">
        <label>会议室预订审批
          <select id="approval-meeting" aria-label="会议室预订审批角色">
            ${(cfg.roles || []).map((r) => `<option value="${r.value}" ${cfg.meeting_role === r.value ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
          </select>
        </label>
        <label>办公用品领用审批
          <select id="approval-supply" aria-label="办公用品领用审批角色">
            ${(cfg.roles || []).map((r) => `<option value="${r.value}" ${cfg.supply_role === r.value ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="ai-form-actions"><button class="btn btn--solid btn--sm" data-action="approval-settings-save">保存审批设置</button></div>
      <p class="dlv-note">审批人不能是申请人。PMO 自己提交的会议室/用品申请，必须由另一个符合角色的账号审批。</p>
    </section>
    <aside class="panel">
      <div class="panel-head"><h2><span class="no">02</span>审批员账号</h2><span class="hint">${approvers.length} 个</span></div>
      ${approvers.length ? `<div class="supply-cat-list">${approvers.map((u) => `<div class="supply-cat"><span><b>${esc(u.name)}</b><i>${esc(u.username)} · ${u.active ? '启用' : '停用'}</i></span></div>`).join('')}</div>` : '<div class="note-box" style="border-color:var(--ochre)">还没有审批员账号。到「用户与权限」新增账号，角色选「审批员」。</div>'}
      <p class="dlv-note">审批员只负责审批，不自动拥有项目或管理权限。创建后回到这里确认账号已出现。</p>
    </aside>
  </div>`;
}

async function viewAdmin() {
  const me = state.me;
  if (me.role !== 'pmo') return viewAdminSelfService();
  const tab = state.adminTab;

  let overview = { users: 0, plans: 0, reports: 0, audits: 0, sessions: 0 };
  try { overview = await api('/api/admin/overview'); } catch { /* ignore */ }

  let content = '';
  if (tab === 'users') {
    const data = await api('/api/admin/users');
    state.adminUsers = data.users;
    const f = state.userFilters;
    content = `<div class="panel">
      <div class="panel-head">
        <h2><span class="no">01</span>账号维护</h2>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="hint">${data.users.length} 个账号 · ${overview.users} 个启用 · ${overview.sessions || 0} 个在线会话</span>
          <button class="btn btn--sm btn--solid" data-action="admin-user-new">${ICONS.plus}新建账号</button>
        </div>
      </div>
      <div class="admin-toolbar">
        <label class="search">
          <span class="sr-only">搜索账号</span>
          ${ICONS.search}
          <input id="user-search" type="search" placeholder="搜索姓名 / 账号 / 项目" value="${esc(f.q)}" />
        </label>
        <select class="admin-select" id="user-role-filter" data-user-filter="role" aria-label="按角色筛选">
          ${[['全部', '全部角色'], ['pmo', 'PMO 管理员'], ['approver', '审批员'], ['pm', '项目经理'], ['client_member', '甲方项目成员'], ['vendor_member', '乙方项目成员']].map(([v, l]) => `<option value="${v}" ${f.role === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <select class="admin-select" id="user-party-filter" data-user-filter="party" aria-label="按归属筛选">
          ${[['全部', '全部归属'], ['甲方', '甲方'], ['乙方', '乙方']].map(([v, l]) => `<option value="${v}" ${f.party === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <select class="admin-select" id="user-status-filter" data-user-filter="status" aria-label="按状态筛选">
          ${[['全部', '全部状态'], ['active', '启用'], ['inactive', '停用']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <span class="hint" id="user-count">显示 ${filteredAdminUsers().length} / ${data.users.length} 个账号</span>
      </div>
      <table class="ledger ledger--fixed admin-table">
        <thead><tr><th>成员</th><th>角色 / 供应商</th><th>负责项目</th><th>最近登录 / 会话</th><th>状态</th><th></th></tr></thead>
        <tbody id="user-body">${adminUserRowsHTML()}</tbody>
      </table>
      <p class="dlv-note">重置密码会立即踢掉该账号的所有会话，新密码只在提交前显示，提交后不再回显。强制下线不会停用账号。仍有项目职责的账号不能直接删除，要先在项目台账更换项目经理。</p>
    </div>`;
  } else if (tab === 'programs') {
    const data = await api('/api/programs');
    state.programs = data.programs;
    const rows = data.programs.map((p) => `<tr>
      <td data-label="项目群"><span class="pcode">${esc(p.code)}</span><span class="pname" style="font-size:12.5px">${esc(p.name)}</span></td>
      <td data-label="负责人">${esc(p.owner || '—')}</td>
      <td data-label="目标">${esc((p.objective || '').slice(0, 70))}${(p.objective || '').length > 70 ? '…' : ''}</td>
      <td data-label="项目数">${p.project_count} 个</td>
      <td data-label="周期">${p.start_date || '—'} ~ ${p.end_date || '—'}</td>
      <td class="right"><button class="btn btn--sm btn--quiet" data-action="program-edit" data-id="${p.id}">编辑</button></td>
    </tr>`).join('');
    content = `<div class="panel">
      <div class="panel-head">
        <h2><span class="no">01</span>项目群</h2>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="hint">${data.programs.length} 个 · 切换项目群在左侧</span>
          <button class="btn btn--sm btn--solid" data-action="program-new">${ICONS.plus}新增项目群</button>
        </div>
      </div>
      <table class="ledger ledger--fixed admin-table">
        <thead><tr><th style="width:20%">项目群</th><th style="width:12%">负责人</th><th>目标</th><th style="width:9%">项目数</th><th style="width:18%">周期</th><th style="width:8%"></th></tr></thead>
        <tbody>${rows || emptyRow(6, '还没有项目群')}</tbody>
      </table>
      <p class="dlv-note">有项目的项目群不能删除；先把项目迁走。新建项目时可以选择所属项目群。</p>
    </div>`;
  } else if (tab === 'vendors') {
    const data = await api('/api/vendors');
    state.vendors = data.vendors;
    const rows = data.vendors.map((v) => `<tr>
      <td data-label="编码"><span class="pcode">${esc(v.code)}</span><span class="pname" style="font-size:12.5px">${esc(v.name)}</span></td>
      <td data-label="联系人">${esc(v.contact || '—')}<span class="pcode">${esc(v.phone || '')}</span></td>
      <td data-label="挂接">${v.user_count} 个账号 · ${v.project_count} 个项目</td>
      <td data-label="状态"><span class="chip ${v.status === '合作中' ? 'chip--jade' : v.status === '已退出' ? 'chip--dashed' : 'chip--ochre'}">${esc(v.status)}</span></td>
      <td data-label="备注" class="muted" style="font-size:11.5px">${esc(v.notes || '—')}</td>
      <td class="right"><button class="btn btn--sm btn--quiet" data-action="vendor-edit" data-id="${v.id}">编辑</button></td>
    </tr>`).join('');
    content = `<div class="panel">
      <div class="panel-head">
        <h2><span class="no">02</span>乙方供应商</h2>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="hint">${data.vendors.length} 家 · ${data.vendors.filter((v) => v.status === '合作中').length} 家合作中</span>
          <button class="btn btn--sm btn--solid" data-action="vendor-new">${ICONS.plus}新增供应商</button>
        </div>
      </div>
      <table class="ledger ledger--fixed admin-table">
        <thead><tr><th style="width:20%">供应商</th><th style="width:20%">联系人</th><th style="width:18%">挂接</th><th style="width:10%">状态</th><th>备注</th><th style="width:8%"></th></tr></thead>
        <tbody>${rows || emptyRow(6, '还没有供应商，先新增一家')}</tbody>
      </table>
      <p class="dlv-note">供应商是主数据：账号和项目成员都挂到同一家供应商。已被引用的供应商不能删除，改成“已退出”即可保留历史。</p>
    </div>`;
  } else if (tab === 'templates') {
    const data = await api('/api/templates?all=1');
    state.templates = data.templates;
    const rows = data.templates.map((t) => `<tr>
      <td data-label="模板"><span class="pcode">${esc(t.code)}</span><span class="pname" style="font-size:12.5px">${esc(t.name)}</span>${t.description ? `<span class="value-note">${esc(t.description)}</span>` : ''}</td>
      <td data-label="分类"><span class="chip">${esc(TEMPLATE_CATEGORIES[t.category] || t.category)}</span></td>
      <td data-label="默认">${t.is_default ? '<span class="chip chip--jade">默认</span>' : '<span class="muted">—</span>'}</td>
      <td data-label="状态">${t.active ? '<span class="rag rag--green"><i></i>启用</span>' : '<span class="rag rag--red"><i></i>停用</span>'}</td>
      <td data-label="更新时间" class="mono-sm">${fmtDateTime(t.updated_at || t.created_at)}</td>
      <td class="right"><button class="btn btn--sm btn--quiet" data-action="template-edit" data-id="${t.id}">编辑</button></td>
    </tr>`).join('');
    content = `<div class="panel">
      <div class="panel-head">
        <h2><span class="no">03</span>模板管理</h2>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="hint">${data.templates.length} 个模板 · 周报模板会在填报页自动带出</span>
          <button class="btn btn--sm btn--solid" data-action="template-new">${ICONS.plus}新增模板</button>
        </div>
      </div>
      <table class="ledger ledger--fixed admin-table">
        <thead><tr><th style="width:38%">模板</th><th style="width:12%">分类</th><th style="width:9%">默认</th><th style="width:10%">状态</th><th style="width:18%">更新时间</th><th style="width:8%"></th></tr></thead>
        <tbody>${rows || emptyRow(6, '还没有模板，先新增一个')}</tbody>
      </table>
      <p class="dlv-note">模板正文用 Markdown 维护：标题、列表、表格、代码块都支持。每个分类只能有一个默认模板；周报填报时会自动带出默认模板。</p>
    </div>`;
  } else if (tab === 'ai') {
    const cfg = await api('/api/admin/ai');
    state.adminAi = cfg;
    content = aiConfigHTML(cfg);
  } else if (tab === 'approval') {
    const cfg = await api('/api/admin/approval-settings');
    state.adminApproval = cfg;
    content = approvalSettingsHTML(cfg);
  } else if (tab === 'help') {
    const data = await api('/api/admin/help');
    state.helpArticles = data.articles;
    const rows = data.articles.map((a) => `<tr>
      <td data-label="文章"><span class="pcode">${esc(a.slug)}</span><span class="pname" style="font-size:12.5px">${esc(a.title)}</span><span class="value-note">${esc(a.summary || '')}</span></td>
      <td data-label="分类"><span class="chip">${esc(a.category)}</span></td>
      <td data-label="状态">${a.published ? '<span class="rag rag--green"><i></i>已发布</span>' : '<span class="rag rag--red"><i></i>草稿</span>'}</td>
      <td data-label="更新时间" class="mono-sm">${fmtDateTime(a.updated_at || a.created_at)}</td>
      <td class="right"><button class="btn btn--sm btn--quiet" data-action="help-article-edit" data-id="${a.id}">编辑</button></td>
    </tr>`).join('');
    content = `<div class="panel">
      <div class="panel-head">
        <h2><span class="no">03</span>知识库</h2>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="hint">${data.articles.length} 篇 · 帮助页实时检索</span>
          <button class="btn btn--sm btn--solid" data-action="help-article-new">${ICONS.plus}新增文章</button>
        </div>
      </div>
      <table class="ledger ledger--fixed admin-table">
        <thead><tr><th style="width:48%">文章</th><th style="width:12%">分类</th><th style="width:12%">状态</th><th style="width:18%">更新时间</th><th style="width:10%"></th></tr></thead>
        <tbody>${rows || emptyRow(5, '还没有知识库文章')}</tbody>
      </table>
      <p class="dlv-note">知识库文章会出现在「帮助与知识库」页；支持 Markdown，可被智能问答检索。未配置大模型时，问答直接返回最相关的文章内容。</p>
    </div>`;
  } else if (tab === 'calendar') {
    const data = await api('/api/calendar');
    state.calendar = data.days;
    const rows = data.days.map((d) => `<tr>
      <td data-label="日期" class="mono-sm">${d.date}<br><span class="muted">${weekday(d.date)}</span></td>
      <td data-label="说明">${esc(d.name || '—')}</td>
      <td data-label="类型"><span class="chip ${d.kind === 'workday' ? 'chip--jade' : 'chip--ochre'}">${d.kind === 'workday' ? '调休上班' : '休息日'}</span></td>
      <td class="right"><button class="btn btn--sm btn--quiet" data-action="calendar-delete" data-date="${d.date}">删除</button></td>
    </tr>`).join('');
    content = `<div class="panel">
      <div class="panel-head">
        <h2><span class="no">04</span>工作日历</h2>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="hint">${data.days.length} 天特殊设置 · 修改后自动重算所有项目计划</span>
          <button class="btn btn--sm btn--solid" data-action="calendar-new">${ICONS.plus}添加日期</button>
        </div>
      </div>
      <table class="ledger ledger--fixed admin-table">
        <thead><tr><th style="width:20%">日期</th><th>说明</th><th style="width:16%">类型</th><th style="width:10%"></th></tr></thead>
        <tbody>${rows || emptyRow(4, '没有特殊日期，按周一至周五排期')}</tbody>
      </table>
      <p class="dlv-note">“休息日”会把工作日跳过，“调休上班”会把周末算成工作日。修改日历会立即重算所有项目的任务日期和基线偏差。</p>
    </div>`;
  } else if (tab === 'audit') {
    const data = await api('/api/admin/audit?limit=120');
    const rows = data.entries.map((a) => `<tr>
      <td class="mono-sm" data-label="时间" style="white-space:nowrap">${fmtDateTime(a.created_at)}</td>
      <td data-label="操作人">${esc(a.actor_name || '系统')}</td>
      <td data-label="动作"><span class="chip">${esc(a.action)}</span></td>
      <td data-label="项目">${a.project_code ? `${esc(a.project_code)} · ${esc(a.project_name || '')}` : '—'}</td>
      <td data-label="详情" class="muted" style="font-size:12px">${esc(a.detail || '')}</td>
    </tr>`).join('');
    content = `<div class="panel">
      <div class="panel-head">
        <h2><span class="no">05</span>操作留痕</h2>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="hint">最近 ${data.entries.length} 条 · 共 ${overview.audits} 条</span>
          <a class="btn btn--sm btn--quiet" href="/api/admin/audit.csv">导出 CSV</a>
        </div>
      </div>
      <table class="ledger ledger--fixed">
        <thead><tr><th style="width:15%">时间</th><th style="width:11%">操作人</th><th style="width:14%">动作</th><th style="width:22%">项目</th><th>详情</th></tr></thead>
        <tbody>${rows || emptyRow(5, '还没有操作记录')}</tbody>
      </table>
    </div>`;
  } else {
    content = `<div class="grid-2">
      <section>
        <div class="panel-head"><h2><span class="no">06</span>数据备份</h2></div>
        <p style="font-size:12.5px;color:var(--ink-3);line-height:1.8;margin:0 0 16px">
          导出包含项目、里程碑、风险、投入、项目周报与项目计划的完整快照。导入会覆盖当前业务数据，账号与密码不受影响。
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn--solid" data-action="export">${ICONS.download}导出 JSON</button>
          <button class="btn btn--quiet" data-action="import">导入备份</button>
          <button class="btn btn--danger" data-action="reset">重置演示数据</button>
          <button class="btn btn--danger" data-action="clear-demo">清空业务数据</button>
          <input type="file" id="import-file" accept="application/json" class="sr-only" />
        </div>
        <p style="font-size:11px;color:var(--ink-4);margin-top:10px;line-height:1.7">
          「清空业务数据」用于正式上线前：删除全部项目、周报、计划、关口、风险、章程、变更、经验教训和其他账号，只保留当前管理员，项目群重置为默认空群。
        </p>
        <p style="font-size:11px;color:var(--ink-4);margin-top:14px">数据库：data/pmo.db · ${state.data.stats.total} 个项目 / ${overview.reports} 份周报 / ${overview.plans} 份计划</p>
      </section>
      <section>
        <div class="panel-head"><h2><span class="no">04</span>健康度算法</h2></div>
        <table class="ledger" style="font-size:12px">
          <tbody>
            <tr><td style="width:42%">进度绩效</td><td class="muted">35% · 实际进度与计划应到进度之差</td></tr>
            <tr><td>成本绩效</td><td class="muted">30% · 进度完成率 ÷ 预算消耗率（CPI）</td></tr>
            <tr><td>风险控制</td><td class="muted">25% · 未关闭风险敞口（概率×影响）</td></tr>
            <tr><td>里程碑</td><td class="muted">10% · 按逾期节点数量扣减</td></tr>
          </tbody>
        </table>
        <p style="font-size:11.5px;color:var(--ink-3);margin-top:12px;line-height:1.7">分级：≥78 正常、58–77 关注、&lt;58 预警。所有分数在每次请求时实时重算。</p>
      </section>
    </div>
    <section style="margin-top:34px;border-top:1px solid var(--rule);padding-top:26px">
      <div class="panel-head"><h2><span class="no">07</span>运行与部署</h2></div>
      <div class="grid-3">
        <div><span class="mini-label" style="color:var(--ink-4)">启动</span><p style="font-size:12px;color:var(--ink-2);line-height:1.8;margin:0"><span class="kbd">node server.js</span> 或 <span class="kbd">./start.sh</span>，默认 5177 端口。</p></div>
        <div><span class="mini-label" style="color:var(--ink-4)">数据</span><p style="font-size:12px;color:var(--ink-2);line-height:1.8;margin:0">SQLite 单文件，位于 <span class="kbd">data/pmo.db</span>，备份即拷走该文件或导出 JSON。</p></div>
        <div><span class="mini-label" style="color:var(--ink-4)">安全</span><p style="font-size:12px;color:var(--ink-2);line-height:1.8;margin:0">默认仅监听本机；密码 scrypt 加盐存储，会话 7 天过期。</p></div>
      </div>
    </section>`;
  }

  return `<div class="view-enter">
    ${pageHead({
      eyebrow: 'ADMINISTRATION <span class="sep">/</span> ACCESS CONTROL',
      title: '管理维护',
      sub: '账号、项目授权与操作留痕。所有审核与提交动作都会记录操作人、时间和对象，用于事后追溯。',
      actions: `<span class="role-pill">${ICONS.shield}${esc(roleText(me.role, me.party))} · ${esc(me.name)}</span>`,
    })}

    <div class="pulse" style="grid-template-columns:repeat(4,1fr)">
      <div class="pulse-cell"><span class="pulse-label">启用账号</span><div class="pulse-value">${overview.users}<span class="unit">个</span></div><span class="pulse-note">含 PMO 与项目经理</span></div>
      <div class="pulse-cell"><span class="pulse-label">项目周报</span><div class="pulse-value">${overview.reports}<span class="unit">份</span></div><span class="pulse-note">含草稿与历史版本记录</span></div>
      <div class="pulse-cell"><span class="pulse-label">项目计划</span><div class="pulse-value">${overview.plans}<span class="unit">份</span></div><span class="pulse-note">按季度维护</span></div>
      <div class="pulse-cell"><span class="pulse-label">审计记录</span><div class="pulse-value">${overview.audits}<span class="unit">条</span></div><span class="pulse-note">登录、提交、审核、台账变更</span></div>
    </div>

    <div class="dlv-tabs admin-tabs">
      <button class="dlv-tab ${tab === 'users' ? 'is-on' : ''}" data-action="admin-tab" data-value="users">用户与权限</button>
      <button class="dlv-tab ${tab === 'programs' ? 'is-on' : ''}" data-action="admin-tab" data-value="programs">项目群</button>
      <button class="dlv-tab ${tab === 'vendors' ? 'is-on' : ''}" data-action="admin-tab" data-value="vendors">乙方供应商</button>
      <button class="dlv-tab ${tab === 'templates' ? 'is-on' : ''}" data-action="admin-tab" data-value="templates">模板管理</button>
      <button class="dlv-tab ${tab === 'help' ? 'is-on' : ''}" data-action="admin-tab" data-value="help">知识库</button>
      <button class="dlv-tab ${tab === 'ai' ? 'is-on' : ''}" data-action="admin-tab" data-value="ai">AI 配置</button>
      <button class="dlv-tab ${tab === 'approval' ? 'is-on' : ''}" data-action="admin-tab" data-value="approval">审批设置</button>
      <button class="dlv-tab ${tab === 'calendar' ? 'is-on' : ''}" data-action="admin-tab" data-value="calendar">工作日历</button>
      <button class="dlv-tab ${tab === 'audit' ? 'is-on' : ''}" data-action="admin-tab" data-value="audit">审计日志</button>
      <button class="dlv-tab ${tab === 'data' ? 'is-on' : ''}" data-action="admin-tab" data-value="data">数据与运行</button>
    </div>

    ${content}
  </div>`;
}

function viewAdminSelfService() {
  const me = state.me;
  return `<div class="view-enter">
    ${pageHead({
      eyebrow: 'ADMINISTRATION <span class="sep">/</span> LIMITED',
      title: '管理维护',
      sub: '账号与权限由 PMO 统一维护。项目经理可以导出本项目群的数据备份，导入与重置需要 PMO 权限。',
      actions: `<span class="role-pill">${esc(roleText(me.role, me.party))} · ${esc(me.name)}</span>`,
    })}
    <div class="grid-2" style="margin-top:30px">
      <section>
        <div class="panel-head"><h2><span class="no">01</span>数据导出</h2></div>
        <p style="font-size:12.5px;color:var(--ink-3);line-height:1.8;margin:0 0 16px">导出当前项目群的完整快照，可用于归档或迁移。</p>
        <button class="btn btn--solid" data-action="export">${ICONS.download}导出 JSON</button>
      </section>
      <section>
        <div class="panel-head"><h2><span class="no">02</span>账号</h2></div>
        <div class="note-box">当前登录：${esc(me.name)}（${esc(me.username)}），负责 ${me.projects.length} 个项目。如需调整授权，请联系 PMO。</div>
      </section>
    </div>
  </div>`;
}

function openPasswordModal() {
  openModal({
    title: '修改密码',
    sub: '新密码至少 8 位。保存后其他设备的登录会话会立即失效，当前会话保持登录。',
    submit: '保存新密码',
    fields: [
      { name: 'current', label: '当前密码', type: 'password', required: true },
      { name: 'next', label: '新密码（至少 8 位）', type: 'password', required: true },
      { name: 'confirm', label: '确认新密码', type: 'password', required: true, full: true },
    ],
    onSubmit: async (v) => {
      if (v.next !== v.confirm) throw new Error('两次输入的新密码不一致');
      await api('/api/auth/password', { method: 'POST', body: { current: v.current, next: v.next } });
      toast('密码已修改，其他设备已退出');
    },
  });
}

function openResetPassword(user) {
  const pwd = resetPasswordValue();
  openModal({
    title: `重置密码 · ${user.name}`,
    sub: '提交后该账号所有会话立即失效。新密码只在提交前显示，请先复制再提交。',
    submit: '确认重置',
    fields: [
      { name: 'password', label: '新密码', value: pwd, required: true, help: '至少 8 位，建议重置后让本人立即修改' },
    ],
    onSubmit: async (v) => {
      await api(`/api/admin/users/${user.id}/reset-password`, { method: 'POST', body: { password: v.password } });
      await reload();
      toast(`密码已重置：${v.password}`);
    },
  });
}

function confirmForceLogout(user) {
  openModal({
    title: '强制下线',
    sub: `${user.name}（${user.username}）当前有 ${user.sessions} 个在线会话。确认后所有会话立即失效，账号不会被停用。`,
    submit: '确认下线',
    fields: [],
    onSubmit: async () => {
      const r = await api(`/api/admin/users/${user.id}/logout`, { method: 'POST' });
      await reload();
      toast(`已下线 ${r.count} 个会话`);
    },
  });
}

function confirmDeleteUser(user) {
  openModal({
    title: '删除账号',
    sub: `将永久删除 ${user.name}（${user.username}）。如果该账号仍是某些项目的甲方或乙方经理，系统会拒绝删除，请先到项目台账更换。`,
    submit: '确认删除',
    fields: [],
    onSubmit: async () => {
      await api(`/api/admin/users/${user.id}`, { method: 'DELETE' });
      await reload();
      toast('账号已删除');
    },
  });
}

function openUserModal(user) {
  const isEdit = Boolean(user);
  const all = state.data.projects;
  const assigned = new Set((user?.projects || []).map((p) => p.id));
  $('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="modal-backdrop">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">
      <div class="modal-head">
        <div><h3 id="modal-title">${isEdit ? '编辑账号' : '新建账号'}</h3>
          <p>${isEdit ? `${esc(user.username)} · 创建于 ${esc(user.created_at || '')}` : '新账号创建后即可登录，请把初始密码告知本人并提醒修改。'}</p></div>
        <button class="icon-btn" data-action="modal-close" aria-label="关闭">${ICONS.close}</button>
      </div>
      <form id="user-form">
        <div class="modal-body">
          <div class="modal-fields">
            <div class="field"><label for="uf-username">账号</label>
              <input id="uf-username" name="username" value="${esc(user?.username || '')}" ${isEdit ? 'disabled' : 'required'} placeholder="如 zhangwei" /></div>
            <div class="field"><label for="uf-name">姓名</label>
              <input id="uf-name" name="name" value="${esc(user?.name || '')}" required /></div>
            <div class="field"><label for="uf-role">角色</label>
              <select id="uf-role" name="role">
                <option value="pm" ${user?.role === 'pm' ? 'selected' : ''}>项目经理</option>
                <option value="client_member" ${user?.role === 'client_member' ? 'selected' : ''}>甲方项目成员</option>
                <option value="vendor_member" ${user?.role === 'vendor_member' ? 'selected' : ''}>乙方项目成员</option>
                <option value="pmo" ${user?.role === 'pmo' ? 'selected' : ''}>PMO 管理员</option>
                <option value="approver" ${user?.role === 'approver' ? 'selected' : ''}>审批员</option>
              </select></div>
            <div class="field"><label for="uf-party">归属</label>
              <select id="uf-party" name="party">
                <option value="乙方" ${!user || user.party !== '甲方' ? 'selected' : ''}>乙方（供应商）</option>
                <option value="甲方" ${user?.party === '甲方' ? 'selected' : ''}>甲方（业主）</option>
              </select></div>
            <div class="field"><label for="uf-vendor">乙方供应商</label>
              <select id="uf-vendor" name="vendor_id">
                <option value="">未指定</option>
                ${(state.data.vendors || []).map((v) => `<option value="${v.id}" ${user?.vendor_id === v.id ? 'selected' : ''}>${esc(v.code)} ${esc(v.name)}${v.status !== '合作中' ? `（${esc(v.status)}）` : ''}</option>`).join('')}
              </select>
              <span class="help">只有乙方账号需要挂供应商；甲方和 PMO 会忽略此项。</span></div>
            <div class="field"><label for="uf-password">${isEdit ? '重置密码（留空不改）' : '初始密码'}</label>
              <input id="uf-password" name="password" type="password" placeholder="至少 6 位" ${isEdit ? '' : 'required'} /></div>
            <div class="field field--full"><label for="uf-active">账号状态</label>
              <select id="uf-active" name="active">
                <option value="1" ${!user || user.active ? 'selected' : ''}>启用</option>
                <option value="0" ${user && !user.active ? 'selected' : ''}>停用（立即失效）</option>
              </select></div>
            <div class="field field--full"><label>负责项目</label>
              <div class="checkgrid">
                ${all.map((p) => `<label class="checkitem"><input type="checkbox" name="project_ids" value="${p.id}" ${assigned.has(p.id) ? 'checked' : ''} /><span>${esc(p.code)} ${esc(p.name)}</span></label>`).join('')}
              </div>
              <span class="help">PMO 账号默认拥有全部项目权限。项目经理和项目成员都要勾选项目：项目经理按项目台账里的乙方/甲方经理身份维护或验收，项目成员只读。周报 / 计划的维护权限仍由项目台账里的乙方项目经理决定。</span>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          ${isEdit && user.id !== state.me.id ? `<button type="button" class="btn btn--danger btn--sm" data-action="admin-user-delete" data-id="${user.id}" style="margin-right:auto">删除账号</button>` : ''}
          <button type="button" class="btn btn--quiet" data-action="modal-close">取消</button>
          <button type="button" class="btn btn--solid" data-action="admin-user-save" data-id="${user?.id || ''}">${isEdit ? '保存修改' : '创建账号'}</button>
        </div>
      </form>
    </div>
  </div>`;
  document.body.style.overflow = 'hidden';
  modalCloser = closeModal;
  activateFocusTrap();
  setTimeout(() => $('#uf-name')?.focus(), 80);
}

function openProgramModal(program) {
  const isEdit = Boolean(program);
  openModal({
    title: isEdit ? '编辑项目群' : '新增项目群',
    sub: '项目群是项目台账、周报、关口和报表的上层边界。切换项目群后，列表和汇总会跟着变。',
    wide: true,
    submit: isEdit ? '保存' : '新增',
    fields: [
      { name: 'code', label: '项目群编码', required: true, value: program?.code || '', placeholder: '如 PGM-2027' },
      { name: 'name', label: '项目群名称', required: true, value: program?.name || '' },
      { name: 'owner', label: '项目群负责人', value: program?.owner || '' },
      { name: 'start_date', label: '开始日期', type: 'date', value: program?.start_date || '' },
      { name: 'end_date', label: '结束日期', type: 'date', value: program?.end_date || '' },
      { name: 'objective', label: '项目群目标', type: 'textarea', full: true, value: program?.objective || '' },
    ],
    onDelete: isEdit ? async () => {
      await api(`/api/programs/${program.id}`, { method: 'DELETE' });
      await reload({ keepScroll: false });
      toast('项目群已删除');
    } : undefined,
    onSubmit: async (v) => {
      if (isEdit) await api(`/api/programs/${program.id}`, { method: 'PATCH', body: v });
      else await api('/api/programs', { method: 'POST', body: v });
      await reload({ keepScroll: false });
      toast(isEdit ? '项目群已更新' : '项目群已新增');
    },
  });
}

function openTemplateModal(template) {
  const isEdit = Boolean(template);
  openModal({
    title: isEdit ? '编辑模板' : '新增模板',
    sub: '模板正文用 Markdown 维护。默认模板会在对应填报页自动带出。',
    wide: true,
    submit: isEdit ? '保存' : '新增',
    fields: [
      { name: 'code', label: '模板编码', required: true, value: template?.code || '', placeholder: '如 TPL-WEEKLY-02' },
      { name: 'name', label: '模板名称', required: true, value: template?.name || '' },
      { name: 'category', label: '分类', type: 'select', value: template?.category || 'weekly',
        options: Object.entries(TEMPLATE_CATEGORIES).map(([value, label]) => ({ value, label })) },
      { name: 'is_default', label: '设为该分类默认', type: 'select', value: template?.is_default ? '1' : '0',
        options: [{ value: '0', label: '否' }, { value: '1', label: '是' }] },
      { name: 'active', label: '状态', type: 'select', value: template?.active === 0 ? '0' : '1',
        options: [{ value: '1', label: '启用' }, { value: '0', label: '停用' }] },
      { name: 'description', label: '说明', full: true, value: template?.description || '' },
      { name: 'content_md', label: '正文（Markdown）', type: 'textarea', full: true, rows: 16, value: template?.content_md || '', placeholder: '# 标题\\n\\n## 一、本周进展\\n- ' },
    ],
    onDelete: isEdit ? async () => {
      await api(`/api/templates/${template.id}`, { method: 'DELETE' });
      await reload({ keepScroll: false });
      toast('模板已删除');
    } : undefined,
    onSubmit: async (v) => {
      const body = { ...v, is_default: v.is_default === '1', active: v.active === '1' };
      if (isEdit) await api(`/api/templates/${template.id}`, { method: 'PATCH', body });
      else await api('/api/templates', { method: 'POST', body });
      await reload({ keepScroll: false });
      toast(isEdit ? '模板已更新' : '模板已新增');
    },
  });
}

function openCalendarModal() {
  openModal({
    title: '添加工作日历设置',
    sub: '休息日会跳过排期，调休上班会把周末算成工作日。保存后会重算所有项目计划。',
    fields: [
      { name: 'date', label: '日期', type: 'date', required: true, value: today() },
      { name: 'kind', label: '类型', type: 'select', value: 'holiday', options: [{ value: 'holiday', label: '休息日（法定假日等）' }, { value: 'workday', label: '调休上班' }] },
      { name: 'name', label: '说明', value: '', placeholder: '如：国庆节 / 调休上班' },
    ],
    submit: '保存并重算',
    onSubmit: async (v) => {
      await api('/api/calendar', { method: 'POST', body: v });
      await reload({ keepScroll: false });
      toast('日历已更新，计划已重算');
    },
  });
}

function openVendorModal(vendor) {
  const isEdit = Boolean(vendor);
  openModal({
    title: isEdit ? '编辑供应商' : '新增供应商',
    sub: '供应商是主数据。账号和项目成员都挂到同一家供应商，改名不会丢历史关联。',
    wide: true,
    submit: isEdit ? '保存' : '新增',
    fields: [
      { name: 'code', label: '供应商编码', required: true, value: vendor?.code || '', placeholder: '如 V-06' },
      { name: 'name', label: '供应商名称', required: true, value: vendor?.name || '', placeholder: '公司全称' },
      { name: 'contact', label: '联系人', value: vendor?.contact || '' },
      { name: 'phone', label: '联系电话', value: vendor?.phone || '' },
      { name: 'status', label: '合作状态', type: 'select', value: vendor?.status || '合作中', options: ['合作中', '暂停合作', '已退出'] },
      { name: 'notes', label: '备注', type: 'textarea', full: true, value: vendor?.notes || '' },
    ],
    onDelete: isEdit ? async () => {
      await api(`/api/vendors/${vendor.id}`, { method: 'DELETE' });
      await reload({ keepScroll: false });
      toast('供应商已删除');
    } : undefined,
    onSubmit: async (v) => {
      if (isEdit) await api(`/api/vendors/${vendor.id}`, { method: 'PATCH', body: v });
      else await api('/api/vendors', { method: 'POST', body: v });
      await reload({ keepScroll: false });
      toast(isEdit ? '供应商已更新' : '供应商已新增');
    },
  });
}

async function saveUser(userId) {
  const form = $('#user-form');
  if (!form) return;
  const fd = new FormData(form);
  const projectIds = [...form.querySelectorAll('input[name="project_ids"]:checked')].map((x) => Number(x.value));
  const body = {
    name: String(fd.get('name') || '').trim(),
    role: String(fd.get('role') || 'pm'),
    party: String(fd.get('party') || '乙方'),
    active: String(fd.get('active') || '1') === '1',
    vendor_id: fd.get('vendor_id') ? Number(fd.get('vendor_id')) : null,
    project_ids: projectIds,
  };
  const password = String(fd.get('password') || '');
  if (password) body.password = password;
  if (userId) {
    await api(`/api/admin/users/${userId}`, { method: 'PATCH', body });
    toast('账号已更新');
  } else {
    body.username = String(fd.get('username') || '').trim();
    body.password = password;
    await api('/api/admin/users', { method: 'POST', body });
    toast('账号已创建');
  }
  closeModal();
  await reload();
}

/* --------------------------------------------------------------- render --- */

function renderGlobalAIMessages() {
  const messages = state.aiGlobal.messages || [];
  if (!messages.length) {
    return `<div class="help-thread-empty">
      <span class="eyebrow">GLOBAL ASSISTANT</span>
      <h3>问整个项目群，或选一个项目</h3>
      <p>默认对当前项目群里你有权限看的项目回答。可以让我汇总进度、找跨项目风险、从项目知识库里找依据，也可以直接问某件事。</p>
    </div>`;
  }
  return messages.map((m) => {
    if (m.role === 'user') {
      return `<div class="chat-msg chat-msg--user"><span class="chat-avatar">你</span><div class="chat-bubble chat-bubble--user">${esc(m.content)}</div></div>`;
    }
    return `<div class="chat-msg chat-msg--ai"><span class="chat-avatar">AI</span><div class="chat-main">
      <div class="chat-bubble md-preview">${m.pending ? '<span class="chat-loading"><i></i><i></i><i></i></span>' : (m.error ? `<p class="md-empty">${esc(m.content)}</p>` : renderMarkdown(m.content))}</div>
      ${!m.pending ? `<div class="chat-meta"><span>${m.fallback ? '本地规则结果' : `模型 ${esc(m.model || '')}`}${m.scope?.project_code ? ` · ${esc(m.scope.project_code)}` : ` · ${m.scope?.project_count || 0} 个项目`}</span>${m.sources?.length ? `<span class="chat-sources">引用：${m.sources.slice(0, 8).map((s) => `<span class="chip">${esc(s.project_code)} · ${esc(s.title)}</span>`).join(' ')}</span>` : ''}</div>` : ''}
    </div></div>`;
  }).join('');
}

function viewAIAssistant() {
  const ai = state.data?.ai || { enabled: false, model: '' };
  const projects = state.data?.projects || [];
  if (state.aiGlobal.scope !== 'all' && !projects.some((p) => String(p.id) === String(state.aiGlobal.scope))) state.aiGlobal.scope = 'all';
  const scope = state.aiGlobal.scope;
  const examples = [
    '用三句话总结当前项目群',
    '哪些项目最需要 PMO 关注？',
    '跨项目的主要风险是什么？',
    '周报里反复出现的问题有哪些？',
  ];
  return `<div class="view-enter global-ai-page">
    ${pageHead({
      eyebrow: 'AI ASSISTANT <span class="sep">/</span> GLOBAL',
      title: 'AI 助手',
      sub: '对当前项目群或指定项目提问；回答会带项目上下文和知识库引用，生成内容仍需人工核对。',
    })}
    <div class="global-ai-scope">
      <label>回答范围
        <select id="global-ai-scope" aria-label="选择 AI 回答范围">
          <option value="all" ${scope === 'all' ? 'selected' : ''}>当前项目群全部项目（${projects.length} 个）</option>
          ${projects.map((p) => `<option value="${p.id}" ${String(scope) === String(p.id) ? 'selected' : ''}>${esc(p.code)} ${esc(p.name)}</option>`).join('')}
        </select>
      </label>
      <span class="help-ai-badge ${ai.enabled ? 'is-on' : ''}"><i></i>${ai.enabled ? `已接入 ${esc(ai.model)}` : '知识库 + 本地规则'}</span>
    </div>
    <div class="help-examples" aria-label="示例问题">
      ${examples.map((x) => `<button class="help-example" data-action="global-ai-example" data-q="${esc(x)}">${esc(x)}</button>`).join('')}
    </div>
    <div id="global-ai-thread" class="help-thread">${renderGlobalAIMessages()}</div>
    <div class="help-composer">
      <textarea id="global-ai-question" rows="3" aria-label="向全局 AI 提问" placeholder="例如：P-04 和 P-02 的依赖关系会不会影响本月交付？">${esc(state.aiGlobal.draft || '')}</textarea>
      <div class="help-composer-foot">
        <span>Ctrl / ⌘ + Enter 发送</span>
        <div>
          <button class="btn btn--sm btn--quiet" data-action="global-ai-run" data-mode="portfolio">项目群摘要</button>
          <button class="btn btn--sm btn--quiet" data-action="global-ai-run" data-mode="risks">风险与延期</button>
          <button class="btn btn--sm btn--quiet" data-action="global-ai-clear">清空</button>
          <button class="btn btn--sm btn--solid" data-action="global-ai-ask">发送</button>
        </div>
      </div>
    </div>
    <p class="dlv-note">${ai.enabled ? '问题会发送到配置的模型服务；不要输入账号、密码、密钥或合同金额。' : '当前未配置大模型：使用本地规则汇总和项目知识库检索；配置后同一页会自动走模型。'}</p>
  </div>`;
}

async function askGlobalAI(mode, question = '') {
  if ((state.aiGlobal.messages || []).some((m) => m.pending)) return;
  const q = String(question || '').trim();
  if (mode === 'ask' && !q) { toast('先写一个问题', 'err'); return; }
  const scope = state.aiGlobal.scope;
  const label = q || (mode === 'portfolio' ? '生成项目群摘要' : '汇总跨项目风险与延期');
  state.aiGlobal.messages = state.aiGlobal.messages || [];
  state.aiGlobal.messages.push({ role: 'user', content: label });
  const pending = { role: 'assistant', pending: true, content: '' };
  state.aiGlobal.messages.push(pending);
  state.aiGlobal.draft = '';
  const input = document.getElementById('global-ai-question');
  if (input) input.value = '';
  const thread = document.getElementById('global-ai-thread');
  if (thread) { thread.innerHTML = renderGlobalAIMessages(); thread.scrollTop = thread.scrollHeight; }
  try {
    const r = await api('/api/ai/assistant', {
      method: 'POST',
      body: { mode, question: q, project_id: scope === 'all' ? null : Number(scope) },
    });
    Object.assign(pending, { pending: false, content: r.answer, sources: r.sources || [], fallback: r.fallback, model: r.model, scope: r.scope });
  } catch (e) {
    Object.assign(pending, { pending: false, error: true, content: e.message });
  }
  if (thread) {
    thread.innerHTML = renderGlobalAIMessages();
    const msgs = thread.querySelectorAll('.chat-msg--ai');
    const last = msgs[msgs.length - 1];
    thread.scrollTop = last ? Math.max(0, last.offsetTop - 8) : 0;
  }
  if (input) input.focus();
}

async function viewHelp() {
  const q = state.help.q || '';
  const category = state.help.category || '全部';
  const tab = state.help.tab || 'kb';
  let data;
  try {
    data = await api(`/api/help?q=${encodeURIComponent(q)}`);
  } catch (e) {
    return `<div class="view-enter">${pageHead({ eyebrow: 'HELP / KNOWLEDGE', title: '帮助与知识库', sub: esc(e.message) })}</div>`;
  }
  const ai = state.data?.ai || { enabled: false, model: '' };
  const articles = category === '全部' ? data.articles : data.articles.filter((a) => a.category === category);
  const artHtml = articles.length ? articles.map((a, i) => `<details class="help-article" ${i === 0 && q ? 'open' : ''}>
    <summary><span class="chip">${esc(a.category)}</span><b>${esc(a.title)}</b><i>${esc(a.summary || '')}</i></summary>
    <div class="md-preview">${renderMarkdown(a.content_md)}</div>
  </details>`).join('') : '<div class="empty">没有找到匹配的文章。换个关键词，或切到「智能问答」直接问。</div>';

  const tabs = `<div class="dlv-tabs help-tabs" role="tablist" aria-label="帮助视图">
    <button class="dlv-tab${tab === 'kb' ? ' is-on' : ''}" role="tab" aria-selected="${tab === 'kb'}" data-action="help-tab" data-value="kb">知识库<span class="n">${data.total ?? data.articles.length}</span></button>
    <button class="dlv-tab${tab === 'ai' ? ' is-on' : ''}" role="tab" aria-selected="${tab === 'ai'}" data-action="help-tab" data-value="ai">智能问答</button>
  </div>`;

  const kb = `<div class="help-layout help-layout--single">
    <main>
      <div class="help-search">
        ${ICONS.search}
        <input id="help-search" type="search" autocomplete="off" value="${esc(q)}" placeholder="搜索：周报、关口、供应商、会议室、办公用品……" aria-label="搜索帮助" />
        <button class="btn btn--solid btn--sm" data-action="help-search">搜索</button>
      </div>
      <div class="help-search-meta" aria-live="polite">
        ${q ? `<span>“${esc(q)}” 找到 <b>${articles.length}</b> 篇</span><button class="help-search-clear" data-action="help-search-clear">清空搜索</button>` : `<span>共 <b>${articles.length}</b> 篇帮助；输入关键词后按 Enter 或点搜索</span>`}
      </div>
      <div class="filters" style="margin:14px 0 18px">
        ${['全部', ...(data.categories || [])].map((c) => `<button class="filter${category === c ? ' is-on' : ''}" data-action="help-category" data-value="${esc(c)}">${esc(c)}</button>`).join('')}
      </div>
      <div class="help-list">${artHtml || `<div class="help-empty"><b>没有找到“${esc(q)}”</b><p>换一个词试试，比如“周报”“会议室”“办公用品”“审批”。</p><button class="btn btn--sm btn--quiet" data-action="help-search-clear">清空搜索</button></div>`}</div>
    </main>
  </div>`;

  return `<div class="view-enter">
    ${pageHead({
      eyebrow: 'HELP <span class="sep">/</span> KNOWLEDGE BASE',
      title: '帮助与知识库',
      sub: '系统怎么用、流程怎么走、AI 怎么配。查文章，或者直接问。',
    })}
    ${tabs}
    ${tab === 'ai' ? helpAIHTML(ai) : kb}
  </div>`;
}

function renderHelpMessages() {
  const messages = state.help.messages || [];
  if (!messages.length) {
    return `<div class="help-thread-empty">
      <span class="eyebrow">ASK THE KNOWLEDGE BASE</span>
      <h3>问一句，直接给步骤</h3>
      <p>不知道菜单在哪、流程为什么被卡、周报怎么改，都可以问。没配模型时，会从知识库里找最相关的文章回答。</p>
    </div>`;
  }
  return messages.map((m) => {
    if (m.role === 'user') {
      return `<div class="chat-msg chat-msg--user"><span class="chat-avatar">你</span><div class="chat-bubble chat-bubble--user">${esc(m.content)}</div></div>`;
    }
    return `<div class="chat-msg chat-msg--ai"><span class="chat-avatar">AI</span><div class="chat-main">
      <div class="chat-bubble md-preview">${m.pending ? '<span class="chat-loading"><i></i><i></i><i></i></span>' : (m.error ? `<p class="md-empty">${esc(m.content)}</p>` : renderMarkdown(m.content))}</div>
      ${!m.pending ? `<div class="chat-meta"><span>${m.fallback ? '知识库检索' : `模型 ${esc(m.model || '')}`}</span>${m.sources?.length ? `<span class="chat-sources">参考：${m.sources.map((s) => `<span class="chip">${esc(s.title)}</span>`).join(' ')}</span>` : ''}</div>` : ''}
    </div></div>`;
  }).join('');
}

function focusHelpSearch() {
  const input = document.getElementById('help-search');
  if (!input) return;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function helpAIHTML(ai) {
  const examples = [
    '周报被退回了怎么改？',
    '整体计划和基线怎么用？',
    '关口为什么不能判通过？',
    '怎么配置 AI 助手？',
    '多项目群切换后数据范围是什么？',
  ];
  return `<div class="help-ai-page">
    <header class="help-ai-hero">
      <div>
        <span class="eyebrow">KNOWLEDGE ASSISTANT</span>
        <h2>问系统怎么用</h2>
        <p>基于帮助知识库回答，给出菜单路径和操作步骤。没有配置模型时也能用。</p>
      </div>
      <div class="help-ai-badge ${ai.enabled ? 'is-on' : ''}"><i></i>${ai.enabled ? `已接入 ${esc(ai.model)}` : '知识库检索模式'}</div>
    </header>
    <div class="help-examples" aria-label="示例问题">
      ${examples.map((x) => `<button class="help-example" data-action="help-example" data-q="${esc(x)}">${esc(x)}</button>`).join('')}
    </div>
    <div id="help-thread" class="help-thread">${renderHelpMessages()}</div>
    <div class="help-composer">
      <textarea id="help-question" rows="3" aria-label="向知识库提问" placeholder="把问题写具体一点，例如：PMO 审核周报时为什么不能改进度？">${esc(state.help.draft || '')}</textarea>
      <div class="help-composer-foot">
        <span>Ctrl / ⌘ + Enter 发送</span>
        <div>
          <button class="btn btn--sm btn--quiet" data-action="help-clear">清空对话</button>
          <button class="btn btn--sm btn--solid" data-action="help-ask">发送</button>
        </div>
      </div>
    </div>
    <p class="dlv-note">${ai.enabled ? '问题会发送到配置的模型服务；不要输入账号、密码、密钥或合同金额。' : '未配置大模型，当前返回知识库检索结果；配置 PMO_LLM_BASE_URL 后可用模型回答。'}</p>
  </div>`;
}

async function askHelp(question) {
  const q = String(question || '').trim();
  if (!q) { toast('先写一个问题', 'err'); return; }
  if ((state.help.messages || []).some((m) => m.pending)) return;
  state.help.messages = state.help.messages || [];
  state.help.messages.push({ role: 'user', content: q });
  const pending = { role: 'assistant', pending: true, content: '' };
  state.help.messages.push(pending);
  state.help.draft = '';
  const input = document.getElementById('help-question');
  if (input) input.value = '';
  const thread = document.getElementById('help-thread');
  if (thread) {
    thread.innerHTML = renderHelpMessages();
    thread.scrollTop = thread.scrollHeight;
  }
  try {
    const r = await api('/api/help/ask', { method: 'POST', body: { question: q } });
    Object.assign(pending, { pending: false, content: r.answer, sources: r.sources || [], fallback: r.fallback, model: r.model });
  } catch (e) {
    Object.assign(pending, { pending: false, error: true, content: e.message });
  }
  if (thread) {
    thread.innerHTML = renderHelpMessages();
    thread.scrollTop = thread.scrollHeight;
  }
  if (input) input.focus();
}


function projectKBHTML(p, kb, canManage) {
  if (!kb) return '<div class="empty">项目知识库加载失败，请刷新重试</div>';
  const f = state.projectKBFilter;
  const labels = kb.kind_labels || {};
  const kinds = Object.keys(kb.counts || {}).sort((a, b) => (labels[a] || a).localeCompare(labels[b] || b));
  const entries = kb.entries || [];
  const list = entries.length ? entries.map((e, i) => `<details class="kb-entry" ${i === 0 && f.q ? 'open' : ''}>
    <summary>
      <span class="kb-kind kb-kind--${esc(e.kind)}">${esc(e.kind_label)}</span>
      <b>${esc(e.title)}</b>
      <span class="kb-date">${esc(e.date || '—')}</span>
      <i>${esc(e.summary || '')}</i>
    </summary>
    <div class="md-preview">${renderMarkdown(e.content)}</div>
    <div class="kb-entry-foot">
      <span>${e.source === 'manual' ? `手工笔记 · ${esc(e.category || '项目笔记')}` : '自动索引'}${e.status ? ` · ${esc(e.status)}` : ''}</span>
      <span class="kb-entry-actions">
        ${e.url ? `<a class="btn btn--sm btn--quiet" href="${e.url}">打开来源</a>` : ''}
        ${e.editable && canManage ? `<button class="btn btn--sm btn--quiet" data-action="kb-note-edit" data-id="${e.id}">编辑</button><button class="btn btn--sm btn--quiet" data-action="kb-note-del" data-id="${e.id}">删除</button>` : ''}
      </span>
    </div>
  </details>`).join('') : '';

  return `<div class="kb-page">
    <header class="kb-hero">
      <div>
        <span class="eyebrow">PROJECT KNOWLEDGE <span class="sep">/</span> AUTO INDEX</span>
        <h2>项目知识库</h2>
        <p>计划、周报、里程碑、风险、关口、变更、经验教训、收益、行动项和验收会自动汇总；项目 AI 助手会先检索这里。当前 ${kb.total} 条。</p>
      </div>
      <div class="kb-stats">
        ${kinds.slice(0, 5).map((k) => `<span><b>${kb.counts[k]}</b>${esc(labels[k] || k)}</span>`).join('')}
      </div>
    </header>
    <div class="kb-toolbar">
      <div class="help-search">
        ${ICONS.search}
        <input id="kb-search" type="search" value="${esc(f.q)}" placeholder="搜任务、周报、风险、里程碑、笔记……" aria-label="搜索项目知识库" />
        <button class="btn btn--solid btn--sm" data-action="kb-search">搜索</button>
      </div>
      ${canManage ? `<button class="btn btn--quiet btn--sm" data-action="kb-note-new">${ICONS.plus}新增笔记</button>` : ''}
    </div>
    <div class="help-search-meta" aria-live="polite">
      ${f.q ? `<span>“${esc(f.q)}” 找到 <b>${entries.length}</b> 条</span><button class="help-search-clear" data-action="kb-search-clear">清空搜索</button>` : `<span>共 <b>${kb.total}</b> 条知识；输入关键词后按 Enter 或点搜索</span>`}
    </div>
    <div class="filters kb-filters">
      <button class="filter${!f.kind ? ' is-on' : ''}" data-action="kb-kind" data-value="">全部 ${kb.total}</button>
      ${kinds.map((k) => `<button class="filter${f.kind === k ? ' is-on' : ''}" data-action="kb-kind" data-value="${k}">${esc(labels[k] || k)} ${kb.counts[k]}</button>`).join('')}
    </div>
    <div class="kb-list">${list || `<div class="help-empty"><b>${f.q ? `没有找到“${esc(f.q)}”` : '这个分类下还没有内容'}</b><p>${f.q ? '换一个词试试，或切回“全部”类别。' : '切回“全部”，或者等计划、周报、风险等数据产生后自动索引。'}</p>${f.q ? '<button class="btn btn--sm btn--quiet" data-action="kb-search-clear">清空搜索</button>' : ''}</div>`}</div>
    <p class="dlv-note">自动索引在打开页面时按当前数据生成，不额外维护副本。手工笔记只有 PMO 和乙方项目经理能编辑，甲方只读。生成时间：${fmtDateTime(kb.generated_at)}</p>
  </div>`;
}

function openProjectKBNote(note = null) {
  const p = state.workspace?.project;
  if (!p) return;
  const isEdit = Boolean(note);
  const noteId = isEdit ? Number(String(note.id).split(':')[1]) : null;
  openModal({
    title: isEdit ? '编辑项目笔记' : '新增项目笔记',
    sub: '手工笔记会进入项目知识库，也会被项目 AI 助手检索。适合记录会议结论、切换注意事项、外部依赖等系统里没有单独字段的内容。',
    wide: true,
    submit: isEdit ? '保存' : '新增',
    fields: [
      { name: 'title', label: '标题', required: true, value: note?.title || '', placeholder: '如：上线切换注意事项' },
      { name: 'category', label: '分类', value: note?.category || '项目笔记', placeholder: '实施 / 会议 / 决策 / 项目笔记' },
      { name: 'content_md', label: '正文（Markdown）', type: 'textarea', full: true, rows: 14, value: note?.content || '' },
    ],
    onDelete: isEdit ? async () => {
      await api(`/api/projects/${p.id}/kb/notes/${noteId}`, { method: 'DELETE' });
      await render();
      toast('笔记已删除');
    } : undefined,
    onSubmit: async (v) => {
      if (isEdit) await api(`/api/projects/${p.id}/kb/notes/${noteId}`, { method: 'PATCH', body: v });
      else await api(`/api/projects/${p.id}/kb/notes`, { method: 'POST', body: v });
      state.projectKBFilter.q = '';
      state.projectKBFilter.kind = '';
      await render();
      toast(isEdit ? '笔记已更新' : '笔记已新增');
    },
  });
}

function focusProjectKBSearch() {
  const input = document.getElementById('kb-search');
  if (!input) return;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function projectAISourcesHTML(result) {
  if (!result?.sources?.length) return '';
  return `<div class="ai-sources"><span>知识库引用</span>${result.sources.map((s) => `<span class="chip">${esc(s.kind_label)} · ${esc(s.title)}</span>`).join('')}</div>`;
}

async function runOverviewAI(mode, question = '') {
  const sel = document.getElementById('overview-ai-project');
  const projectId = Number(sel?.value || 0);
  const box = document.getElementById('overview-ai-result');
  if (!projectId || !box) { toast('先选一个项目', 'err'); return; }
  box.innerHTML = '<p class="md-empty">生成中…</p>';
  try {
    const r = await api(`/api/projects/${projectId}/ai`, { method: 'POST', body: { mode, question } });
    box.innerHTML = `${renderMarkdown(r.answer)}<div class="overview-ai-result-foot"><span>${r.fallback ? '本地规则结果' : `模型 ${esc(r.model || '')}`}</span><button class="btn btn--sm btn--quiet" data-action="overview-ai-open" data-id="${projectId}">打开项目 AI →</button></div>`;
  } catch (e) {
    box.innerHTML = `<p class="md-empty">${esc(e.message)}</p>`;
    toast(e.message, 'err');
  }
}

function briefDueLabel(date) {
  if (!date) return '无明确截止';
  const base = state.data?.today || new Date().toISOString().slice(0, 10);
  const n = Math.round((new Date(`${date}T00:00:00`) - new Date(`${base}T00:00:00`)) / 86400000);
  if (Number.isNaN(n)) return date;
  if (n < 0) return `逾期 ${Math.abs(n)} 天`;
  if (n === 0) return '今天';
  if (n <= 7) return `${n} 天后`;
  return date.slice(5);
}

function projectAIBriefHTML(p, brief) {
  if (!brief) return '';
  const items = (brief.items || []).slice(0, 10);
  const c = brief.counts || {};
  return `<section class="panel ai-brief">
    <div class="ai-brief-head">
      <div>
        <span class="eyebrow">PROJECT PULSE / ${esc(brief.date || '')}</span>
        <h2>当前要处理 <span class="ai-brief-count">${c.high || 0} 项优先</span></h2>
        <p>${esc(brief.summary || '')}</p>
      </div>
      <button class="btn btn--sm btn--solid" data-action="ai-run" data-mode="actions">生成行动建议</button>
    </div>
    ${items.length ? `<div class="ai-brief-list">
      ${items.map((x) => `<a class="ai-brief-item ai-brief-item--${esc(x.level)}" href="#/projects/${p.id}/${esc(x.tab)}">
        <span class="ai-brief-priority">${esc(x.priority)}</span>
        <span class="ai-brief-body">
          <span class="ai-brief-meta">${esc(x.category)} · ${esc((x.audience || []).join(' / '))} · ${esc(briefDueLabel(x.due_date))}</span>
          <b>${esc(x.title)}</b>
          <span class="ai-brief-detail">${esc(x.detail)}</span>
          <span class="ai-brief-action">${esc(x.action || '打开处理')} →</span>
        </span>
      </a>`).join('')}
    </div>` : '<div class="ai-brief-empty">当前没有明显待办。建议检查计划、周报和关口材料是否齐全。</div>'}
    <p class="dlv-note">根据项目当前数据自动判断，按优先级排序；处理完刷新页面即可更新。AI 生成的是解释和建议，不替代 PMO 判断。</p>
  </section>`;
}

function projectAIHTML(p, ws) {
  const ai = state.data?.ai || { enabled: false, model: '' };
  const result = state.ai && state.ai.projectId === p.id ? state.ai : null;
  return `${projectAIBriefHTML(p, state.projectAIBrief)}
    <div class="ai-layout">
    <section class="panel">
      <div class="panel-head"><h2><span class="no">01</span>项目 AI 助手</h2><span class="hint">${ai.enabled ? esc(ai.model) : '本地规则模式'}</span></div>
      <div class="ai-banner ${ai.enabled ? '' : 'ai-banner--off'}">${ai.enabled
        ? '会读取当前项目的进度、风险、里程碑、关口、最新周报和计划摘要，并检索项目知识库。生成内容需要人工核对。'
        : '未配置大模型，先使用本地规则摘要。设置 PMO_LLM_BASE_URL / PMO_LLM_MODEL 后启用。'}</div>
      <div class="ai-actions">
        <button class="btn btn--quiet btn--sm" data-action="ai-run" data-mode="actions">现在该做什么</button>
        <button class="btn btn--quiet btn--sm" data-action="ai-run" data-mode="summary">项目摘要</button>
        <button class="btn btn--quiet btn--sm" data-action="ai-run" data-mode="weekly">生成周报草稿</button>
        <button class="btn btn--quiet btn--sm" data-action="ai-run" data-mode="risks">风险建议</button>
      </div>
      <div class="ai-ask">
        <textarea id="ai-question" rows="3" aria-label="向项目 AI 提问" placeholder="针对这个项目提问，例如：当前最该盯的三件事是什么？"></textarea>
        <button class="btn btn--solid btn--sm" data-action="ai-ask">提问</button>
      </div>
      <div id="ai-sources">${result ? projectAISourcesHTML(result) : ''}</div>
      <div id="ai-result" class="md-preview ai-result">${result ? renderMarkdown(result.answer) : '<p class="md-empty">选一个动作，或直接提问。生成结果不会自动写入周报。</p>'}</div>
      ${result ? `<div class="ai-result-foot"><span>${result.fallback ? '本地规则结果' : `模型 ${esc(result.model || '')}`}</span><button class="btn btn--sm btn--quiet" data-action="ai-copy">复制结果</button></div>` : ''}
    </section>
    <aside class="panel">
      <div class="panel-head"><h2><span class="no">02</span>会带上的上下文</h2></div>
      <div class="side-facts">
        <div class="side-fact"><span>项目</span><b>${esc(p.code)} ${esc(p.name)}</b></div>
        <div class="side-fact"><span>进度</span><b>${p.progress}% · ${esc(p.stage)}</b></div>
        <div class="side-fact"><span>未关闭风险</span><b>${ws.risks.filter((r) => r.status !== '已关闭').length} 项</b></div>
        <div class="side-fact"><span>未完成里程碑</span><b>${ws.milestones.filter((m) => m.status !== '已完成').length} 项</b></div>
        <div class="side-fact"><span>最新周报</span><b>${ws.reports?.[0]?.week_start || '—'}</b></div>
        <div class="side-fact"><span>知识库</span><b>计划 / 周报 / 里程碑 / 笔记</b></div>
      </div>
      <p class="dlv-note">AI 生成的是草稿，不替代 PMO 审核。配置外部模型后，项目内容会发送到该服务，敏感项目请用内网模型。</p>
    </aside>
  </div>`;
}

async function runProjectAI(mode, question = '') {
  const p = state.workspace?.project;
  if (!p) return;
  const box = document.getElementById('ai-result');
  if (box) box.innerHTML = '<p class="md-empty">生成中…</p>';
  try {
    const r = await api(`/api/projects/${p.id}/ai`, { method: 'POST', body: { mode, question } });
    state.ai = { projectId: p.id, ...r };
    if (box) {
      const srcBox = document.getElementById('ai-sources');
      if (srcBox) srcBox.innerHTML = projectAISourcesHTML(r);
      box.innerHTML = renderMarkdown(r.answer);
      document.querySelectorAll('.ai-result-foot').forEach((x) => x.remove());
      box.insertAdjacentHTML('afterend', `<div class="ai-result-foot"><span>${r.fallback ? '本地规则结果' : `模型 ${esc(r.model || '')}`}</span><button class="btn btn--sm btn--quiet" data-action="ai-copy">复制结果</button></div>`);
    }
  } catch (e) {
    if (box) box.innerHTML = `<p class="md-empty">${esc(e.message)}</p>`;
    toast(e.message, 'err');
  }
}

const MEETING_HOURS = Array.from({ length: 15 }, (_, i) => i + 7);
const MEETING_DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function meetingTimeText(v) {
  return String(v || '').slice(11, 16);
}

function meetingStatusChip(status) {
  const cls = status === '已批准' ? 'chip--jade' : status === '待审批' ? 'chip--ochre' : status === '已拒绝' ? 'chip--oxblood' : '';
  return `<span class="chip ${cls}">${esc(status)}</span>`;
}

function meetingBookingBlock(b) {
  const start = b.start_at.slice(11, 16);
  const end = b.end_at.slice(11, 16);
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const left = ((sh + sm / 60 - 7) / 15) * 100;
  const width = (((eh + em / 60) - (sh + sm / 60)) / 15) * 100;
  const cls = b.status === '待审批' ? 'is-pending' : b.status === '已拒绝' ? 'is-rejected' : '';
  return `<button class="meeting-block ${cls}" data-action="booking-open" data-id="${b.id}" style="left:calc(${left}% + 2px);width:calc(${Math.max(4, width)}% - 4px)" title="${esc(b.title)} · ${start}–${end} · ${esc(b.status)}">
    <b>${esc(b.title)}</b><span>${start}–${end} · ${esc(b.requested_by_name || '')}</span>
  </button>`;
}

function meetingCalendarHTML(rooms, bookings, date) {
  const weekStart = mondayOf(date);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const counts = {};
  for (const b of bookings) counts[b.start_at.slice(0, 10)] = (counts[b.start_at.slice(0, 10)] || 0) + 1;
  const visibleRooms = rooms.filter((r) => r.status === '可用' && (state.meeting.roomId === 'all' || String(r.id) === String(state.meeting.roomId)));
  const dayBookings = bookings.filter((b) => b.start_at.slice(0, 10) === date);
  const slots = MEETING_HOURS.map((h) => `<span>${String(h).padStart(2, '0')}:00</span>`).join('');
  const rows = visibleRooms.map((room) => {
    const list = dayBookings.filter((b) => b.room_id === room.id);
    const blocks = list.map(meetingBookingBlock).join('');
    const cells = MEETING_HOURS.map((h) => `<button class="meeting-slot" data-action="booking-new" data-room="${room.id}" data-date="${date}" data-hour="${h}" aria-label="预订 ${esc(room.name)} ${date} ${String(h).padStart(2, '0')}:00"></button>`).join('');
    return `<div class="meeting-row">
      <div class="meeting-room-info">
        <span class="mono-sm">${esc(room.code)}</span>
        <b>${esc(room.name)}</b>
        <span>${esc(room.location || '')} · ${room.capacity} 人</span>
        <i>${esc(room.features || '')}</i>
      </div>
      <div class="meeting-track">${cells}${blocks}</div>
    </div>`;
  }).join('');
  return `<div class="meeting-calendar">
    <div class="meeting-weekbar">
      <div class="meeting-weeknav">
        <button class="icon-btn" data-action="meeting-prev" aria-label="上一周">${ICONS.chevron}</button>
        <b>${weekText(weekStart)}</b>
        <button class="icon-btn period-arrow--next" data-action="meeting-next" aria-label="下一周">${ICONS.chevron}</button>
        <button class="btn btn--sm btn--quiet" data-action="meeting-today">今天</button>
      </div>
      <label class="meeting-filter">会议室
        <select id="meeting-room-filter" aria-label="按会议室筛选">
          <option value="all">全部会议室</option>
          ${rooms.filter((r) => r.status === '可用').map((r) => `<option value="${r.id}" ${String(state.meeting.roomId) === String(r.id) ? 'selected' : ''}>${esc(r.code)} ${esc(r.name)}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="meeting-weekstrip">
      ${days.map((d, i) => `<button class="meeting-day${d === date ? ' is-on' : ''}" data-action="meeting-date" data-date="${d}">
        <span>${MEETING_DAY_NAMES[i]}</span><b>${d.slice(8)}</b><i>${counts[d] || 0} 场</i>
      </button>`).join('')}
    </div>
    <div class="meeting-timeline">
      <div class="meeting-cal-head"><span>会议室</span><div class="meeting-hours">${slots}</div></div>
      ${rows || '<div class="empty">当前没有可用会议室，请先在「会议室」里添加或启用。</div>'}
    </div>
    <p class="dlv-note">点击空白时段直接预订；点击已有预订查看详情。显示已批准和本人待审批的预订。</p>
  </div>`;
}

async function viewMeetingRooms() {
  const me = state.me;
  const isPmoUser = me.role === 'pmo';
  const canApproveMeeting = Boolean(me.canApprove?.meeting);
  if (!state.meeting.date) state.meeting.date = today();
  if (!canApproveMeeting && state.meeting.tab === 'pending') state.meeting.tab = 'calendar';
  if (!isPmoUser && state.meeting.tab === 'rooms') state.meeting.tab = 'calendar';
  const roomsData = await api('/api/meeting-rooms');
  const rooms = roomsData.rooms || [];
  if (state.meeting.roomId !== 'all' && !rooms.some((r) => String(r.id) === String(state.meeting.roomId))) state.meeting.roomId = 'all';
  let bookings = [];
  let summary = {};
  if (state.meeting.tab === 'calendar') {
    const weekStart = mondayOf(state.meeting.date);
    const data = await api(`/api/meeting-bookings?from=${weekStart}&to=${addDays(weekStart, 6)}`);
    bookings = data.bookings || [];
    summary = data.summary || {};
  } else if (state.meeting.tab === 'mine') {
    const data = await api(`/api/meeting-bookings?from=${addDays(today(), -30)}&to=${addDays(today(), 90)}&scope=mine`);
    bookings = data.bookings || [];
    summary = data.summary || {};
  } else if (state.meeting.tab === 'pending') {
    const data = await api(`/api/meeting-bookings?from=${addDays(today(), -7)}&to=${addDays(today(), 90)}&scope=pending`);
    bookings = data.bookings || [];
    summary = data.summary || {};
  }
  state.meeting.rooms = rooms;
  state.meeting.bookings = bookings;
  state.meeting.summary = summary;

  const tabs = [
    ['calendar', '会议日历'],
    ['mine', '我的预订'],
    ...(canApproveMeeting ? [['pending', `待审批${summary.pending ? ` ${summary.pending}` : ''}`]] : []),
    ...(isPmoUser ? [['rooms', '会议室']] : []),
  ];
  const tabBar = `<div class="dlv-tabs meeting-tabs" role="tablist">
    ${tabs.map(([id, label]) => `<button class="dlv-tab${state.meeting.tab === id ? ' is-on' : ''}" role="tab" aria-selected="${state.meeting.tab === id}" data-action="meeting-tab" data-value="${id}">${label}</button>`).join('')}
  </div>`;

  let body = '';
  if (state.meeting.tab === 'calendar') {
    body = meetingCalendarHTML(rooms, bookings, state.meeting.date);
  } else if (state.meeting.tab === 'mine') {
    const rows = bookings.map((b) => `<tr>
      <td data-label="时间"><b class="mono-sm">${esc(b.start_at.slice(0, 10))}</b><span class="value-note">${esc(meetingTimeText(b.start_at))}–${esc(meetingTimeText(b.end_at))}</span></td>
      <td data-label="会议室">${esc(b.room_code)} · ${esc(b.room_name)}</td>
      <td data-label="主题">${esc(b.title)}${b.project_code ? `<span class="value-note">${esc(b.project_code)} ${esc(b.project_name)}</span>` : ''}</td>
      <td data-label="状态">${meetingStatusChip(b.status)}</td>
      <td class="right">${['待审批', '已批准'].includes(b.status) ? `<button class="btn btn--sm btn--quiet" data-action="booking-cancel" data-id="${b.id}">取消</button>` : ''}</td>
    </tr>`).join('');
    body = `<div class="panel"><div class="panel-head"><h2><span class="no">01</span>我的预订</h2><span class="hint">最近 30 天到未来 90 天</span></div>
      <table class="ledger meeting-table"><thead><tr><th style="width:20%">时间</th><th style="width:24%">会议室</th><th style="width:32%">主题</th><th style="width:12%">状态</th><th style="width:12%"></th></tr></thead>
      <tbody>${rows || emptyRow(5, '还没有预订记录，去会议日历选一个时段。')}</tbody></table></div>`;
  } else if (state.meeting.tab === 'pending') {
    const rows = bookings.map((b) => `<tr>
      <td data-label="时间"><b class="mono-sm">${esc(b.start_at.slice(0, 10))}</b><span class="value-note">${esc(meetingTimeText(b.start_at))}–${esc(meetingTimeText(b.end_at))}</span></td>
      <td data-label="会议室">${esc(b.room_code)} · ${esc(b.room_name)}</td>
      <td data-label="主题">${esc(b.title)}${b.purpose ? `<span class="value-note">${esc(b.purpose)}</span>` : ''}</td>
      <td data-label="发起人">${esc(b.requested_by_name || '—')}</td>
      <td data-label="人数">${b.attendees} 人</td>
      <td class="right">${b.requested_by === me.id ? '<span class="placeholder">待他人审批</span>' : `<button class="btn btn--sm btn--solid" data-action="booking-approve" data-id="${b.id}">通过</button> <button class="btn btn--sm btn--quiet" data-action="booking-reject" data-id="${b.id}">拒绝</button>`}</td>
    </tr>`).join('');
    body = `<div class="panel"><div class="panel-head"><h2><span class="no">01</span>待审批预订</h2><span class="hint">${bookings.length} 条</span></div>
      <table class="ledger meeting-table"><thead><tr><th style="width:18%">时间</th><th style="width:24%">会议室</th><th style="width:28%">主题</th><th style="width:14%">发起人</th><th style="width:8%">人数</th><th style="width:12%"></th></tr></thead>
      <tbody>${rows || emptyRow(6, '没有待审批的预订。')}</tbody></table></div>`;
  } else {
    const rows = rooms.map((r) => `<tr>
      <td data-label="会议室"><span class="pcode">${esc(r.code)}</span><span class="pname">${esc(r.name)}</span></td>
      <td data-label="位置">${esc(r.location || '—')}</td>
      <td data-label="容量">${r.capacity} 人</td>
      <td data-label="设施">${esc(r.features || '—')}</td>
      <td data-label="状态">${r.status === '可用' ? '<span class="rag rag--green"><i></i>可用</span>' : '<span class="rag rag--red"><i></i>停用</span>'}</td>
      <td class="right"><button class="btn btn--sm btn--quiet" data-action="meeting-room-edit" data-id="${r.id}">编辑</button></td>
    </tr>`).join('');
    body = `<div class="panel"><div class="panel-head"><h2><span class="no">01</span>会议室</h2><button class="btn btn--sm btn--solid" data-action="meeting-room-new">${ICONS.plus}新增会议室</button></div>
      <table class="ledger meeting-table"><thead><tr><th style="width:28%">会议室</th><th style="width:18%">位置</th><th style="width:10%">容量</th><th style="width:24%">设施</th><th style="width:10%">状态</th><th style="width:10%"></th></tr></thead>
      <tbody>${rows || emptyRow(6, '还没有会议室')}</tbody></table>
      <p class="dlv-note">有预订记录的会议室不能删除，改成「停用」保留历史。</p></div>`;
  }

  return `<div class="view-enter meeting-page">
    ${pageHead({
      eyebrow: 'WORKSPACE <span class="sep">/</span> MEETING ROOMS',
      title: '会议室预订',
      sub: '按会议室和时间看占用，选空档直接预订；预订由配置的审批角色审批，任何人都不能审批自己的申请。',
      actions: `<button class="btn btn--solid" data-action="booking-new">${ICONS.plus}新增预订</button>`,
    })}
    <div class="meeting-stats">
      <span><b>${summary.total || 0}</b>${state.meeting.tab === 'calendar' ? ' 本周预订' : ' 条记录'}</span>
      <span><b>${summary.pending || 0}</b>待审批</span>
      <span><b>${rooms.filter((r) => r.status === '可用').length}</b>可用会议室</span>
    </div>
    ${tabBar}
    ${body}
  </div>`;
}

function openMeetingBookingModal(prefill = {}) {
  const rooms = (state.meeting.rooms || []).filter((r) => r.status === '可用');
  if (!rooms.length) { toast('没有可用会议室，请先到「会议室」添加', 'err'); return; }
  const date = prefill.date || state.meeting.date || today();
  const hour = prefill.hour != null ? Number(prefill.hour) : 10;
  const roomId = prefill.roomId || (state.meeting.roomId !== 'all' ? state.meeting.roomId : rooms[0].id);
  const projects = state.data.projects || [];
  openModal({
    title: '新增会议室预订',
    sub: '选择会议室和时段；同一会议室同一时段只能有一条有效预订。',
    wide: true,
    submit: '提交预订',
    fields: [
      { name: 'room_id', label: '会议室', type: 'select', value: roomId, options: rooms.map((r) => ({ value: r.id, label: `${r.code} ${r.name}（${r.capacity} 人）` })) },
      { name: 'title', label: '会议主题', required: true, placeholder: '如：P-04 周例会' },
      { name: 'project_id', label: '关联项目（可选）', type: 'select', value: '', options: [{ value: '', label: '不关联项目' }, ...projects.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }))] },
      { name: 'date', label: '日期', type: 'date', required: true, value: date },
      { name: 'start_time', label: '开始', type: 'time', required: true, value: `${String(hour).padStart(2, '0')}:00` },
      { name: 'end_time', label: '结束', type: 'time', required: true, value: `${String(Math.min(hour + 1, 22)).padStart(2, '0')}:00` },
      { name: 'attendees', label: '参会人数', type: 'number', min: 1, max: 200, value: 4 },
      { name: 'purpose', label: '用途 / 备注', type: 'textarea', full: true, rows: 3, placeholder: '会议目的、需要的设备等' },
    ],
    onSubmit: async (v) => {
      await api('/api/meeting-bookings', {
        method: 'POST',
        body: {
          room_id: Number(v.room_id), title: v.title, project_id: v.project_id || null,
          start_at: `${v.date}T${v.start_time}`, end_at: `${v.date}T${v.end_time}`,
          attendees: Number(v.attendees), purpose: v.purpose,
        },
      });
      await render();
      toast('预订已提交');
    },
  });
}

function openMeetingReview(id, action) {
  const b = (state.meeting.bookings || []).find((x) => x.id === Number(id));
  if (!b) return;
  openModal({
    title: action === 'approve' ? '批准会议室预订' : '拒绝会议室预订',
    sub: `${b.room_name} · ${b.start_at.slice(0, 10)} ${meetingTimeText(b.start_at)}–${meetingTimeText(b.end_at)} · ${b.requested_by_name}`,
    submit: action === 'approve' ? '确认通过' : '确认拒绝',
    fields: [{ name: 'comment', label: '审核意见', type: 'textarea', full: true, rows: 3, placeholder: action === 'approve' ? '可填使用要求或备注' : '建议写明拒绝原因' }],
    onSubmit: async (v) => {
      await api(`/api/meeting-bookings/${id}/${action === 'approve' ? 'approve' : 'reject'}`, { method: 'POST', body: { comment: v.comment } });
      await render();
      toast(action === 'approve' ? '已批准' : '已拒绝');
    },
  });
}

function openMeetingRoomModal(room) {
  const isEdit = Boolean(room);
  openModal({
    title: isEdit ? '编辑会议室' : '新增会议室',
    sub: '停用后不再出现在预订日历，但历史预订保留。',
    wide: true,
    submit: isEdit ? '保存' : '新增',
    fields: [
      { name: 'code', label: '编码', required: true, value: room?.code || '', placeholder: 'MR-05' },
      { name: 'name', label: '名称', required: true, value: room?.name || '' },
      { name: 'location', label: '位置', value: room?.location || '' },
      { name: 'capacity', label: '容量（人）', type: 'number', min: 1, value: room?.capacity || 6 },
      { name: 'features', label: '设施（逗号分隔）', value: room?.features || '', placeholder: '投屏,白板,视频会议' },
      { name: 'status', label: '状态', type: 'select', value: room?.status || '可用', options: ['可用', '停用'] },
      { name: 'notes', label: '备注', type: 'textarea', full: true, rows: 3, value: room?.notes || '' },
    ],
    onDelete: isEdit ? async () => {
      await api(`/api/meeting-rooms/${room.id}`, { method: 'DELETE' });
      await render();
      toast('会议室已删除');
    } : undefined,
    onSubmit: async (v) => {
      if (isEdit) await api(`/api/meeting-rooms/${room.id}`, { method: 'PATCH', body: v });
      else await api('/api/meeting-rooms', { method: 'POST', body: v });
      await render();
      toast(isEdit ? '会议室已更新' : '会议室已新增');
    },
  });
}

function supplyStatusChip(status) {
  const cls = status === '已发放' ? 'chip--jade' : status === '待发放' ? 'chip--ochre' : status === '已拒绝' ? 'chip--oxblood' : '';
  return `<span class="chip ${cls}">${esc(status)}</span>`;
}

async function viewSupplies() {
  const me = state.me;
  const isPmoUser = me.role === 'pmo';
  const canApproveSupply = Boolean(me.canApprove?.supply);
  if (!canApproveSupply && state.supplies.tab === 'pending') state.supplies.tab = 'catalog';
  if (!isPmoUser && state.supplies.tab === 'manage') state.supplies.tab = 'catalog';
  const stock = await api('/api/supplies');
  const categories = stock.categories || [];
  const items = stock.items || [];
  let requests = [];
  let reqSummary = {};
  if (state.supplies.tab === 'mine' || state.supplies.tab === 'pending') {
    const scope = state.supplies.tab === 'pending' ? 'pending' : 'mine';
    const data = await api(`/api/supply-requests?scope=${scope}`);
    requests = data.requests || [];
    reqSummary = data.summary || {};
  }
  state.supplies.categories = categories;
  state.supplies.items = items;
  state.supplies.requests = requests;
  state.supplies.summary = stock.summary || {};
  const tabs = [
    ['catalog', '用品目录'],
    ['mine', '我的领用'],
    ...(canApproveSupply ? [['pending', `待发放${reqSummary.pending ? ` ${reqSummary.pending}` : ''}`]] : []),
    ...(isPmoUser ? [['manage', '用品管理']] : []),
  ];
  const tabBar = `<div class="dlv-tabs supply-tabs" role="tablist">
    ${tabs.map(([id, label]) => `<button class="dlv-tab${state.supplies.tab === id ? ' is-on' : ''}" role="tab" aria-selected="${state.supplies.tab === id}" data-action="supply-tab" data-value="${id}">${label}</button>`).join('')}
  </div>`;

  let body = '';
  if (state.supplies.tab === 'catalog') {
    const filtered = state.supplies.category === 'all' ? items : items.filter((i) => String(i.category_id) === String(state.supplies.category));
    const rows = filtered.map((i) => {
      const low = i.stock <= i.safety_stock;
      return `<tr>
        <td data-label="物品"><span class="pcode">${esc(i.code)}</span><span class="pname">${esc(i.name)}</span>${i.notes ? `<span class="value-note">${esc(i.notes)}</span>` : ''}</td>
        <td data-label="分类">${esc(i.category_name)}</td>
        <td data-label="库存"><b class="mono-sm ${low ? 'supply-low' : ''}">${i.stock} ${esc(i.unit)}</b><span class="value-note">安全库存 ${i.safety_stock}</span></td>
        <td data-label="状态">${i.status === '可用' ? '<span class="rag rag--green"><i></i>可用</span>' : '<span class="rag rag--red"><i></i>停用</span>'}</td>
        <td class="right">${i.status === '可用' && i.stock > 0 ? `<button class="btn btn--sm btn--quiet" data-action="supply-request" data-id="${i.id}">领用</button>` : '<span class="placeholder">—</span>'}</td>
      </tr>`;
    }).join('');
    body = `<div class="panel">
      <div class="panel-head"><h2><span class="no">01</span>用品目录</h2><span class="hint">库存实时扣减，低库存标红</span></div>
      <div class="filters supply-filters">
        <button class="filter${state.supplies.category === 'all' ? ' is-on' : ''}" data-action="supply-category" data-value="all">全部</button>
        ${categories.map((c) => `<button class="filter${String(state.supplies.category) === String(c.id) ? ' is-on' : ''}" data-action="supply-category" data-value="${c.id}">${esc(c.name)}</button>`).join('')}
      </div>
      <table class="ledger supply-table"><thead><tr><th style="width:40%">物品</th><th style="width:18%">分类</th><th style="width:18%">库存</th><th style="width:12%">状态</th><th style="width:12%"></th></tr></thead>
      <tbody>${rows || emptyRow(5, '这个分类下还没有物品，等管理员补充。')}</tbody></table>
    </div>`;
  } else if (state.supplies.tab === 'mine') {
    const rows = requests.map((r) => `<tr>
      <td data-label="时间">${esc(r.requested_at?.slice(0, 10) || '—')}</td>
      <td data-label="物品">${esc(r.item_code)} · ${esc(r.item_name)}<span class="value-note">${r.quantity} ${esc(r.unit || r.item_unit)}</span></td>
      <td data-label="项目">${r.project_code ? `${esc(r.project_code)} ${esc(r.project_name)}` : '不关联'}</td>
      <td data-label="状态">${supplyStatusChip(r.status)}${r.review_comment ? `<span class="value-note">${esc(r.review_comment)}</span>` : ''}</td>
      <td class="right">${r.status === '待发放' ? `<button class="btn btn--sm btn--quiet" data-action="supply-cancel" data-id="${r.id}">取消</button>` : ''}</td>
    </tr>`).join('');
    body = `<div class="panel"><div class="panel-head"><h2><span class="no">01</span>我的领用</h2></div>
      <table class="ledger supply-table"><thead><tr><th style="width:14%">时间</th><th style="width:34%">物品</th><th style="width:24%">项目</th><th style="width:18%">状态</th><th style="width:10%"></th></tr></thead>
      <tbody>${rows || emptyRow(5, '还没有领用记录，去用品目录挑一件。')}</tbody></table></div>`;
  } else if (state.supplies.tab === 'pending') {
    const rows = requests.map((r) => `<tr>
      <td data-label="申请人">${esc(r.requested_by_name || '—')}<span class="value-note">${esc(r.requested_at?.slice(0, 16).replace('T', ' ') || '')}</span></td>
      <td data-label="物品">${esc(r.item_name)}<span class="value-note">× ${r.quantity} ${esc(r.unit || r.item_unit)}</span></td>
      <td data-label="库存"><b class="mono-sm">${r.item_stock} ${esc(r.item_unit)}</b></td>
      <td data-label="项目">${r.project_code ? `${esc(r.project_code)} ${esc(r.project_name)}` : '不关联'}</td>
      <td data-label="用途">${esc(r.purpose || '—')}</td>
      <td class="right">${r.requested_by === me.id ? '<span class="placeholder">待他人审批</span>' : `<button class="btn btn--sm btn--solid" data-action="supply-issue" data-id="${r.id}">发放</button> <button class="btn btn--sm btn--quiet" data-action="supply-reject" data-id="${r.id}">拒绝</button>`}</td>
    </tr>`).join('');
    body = `<div class="panel"><div class="panel-head"><h2><span class="no">01</span>待发放</h2><span class="hint">发放时扣库存</span></div>
      <table class="ledger supply-table"><thead><tr><th style="width:16%">申请人</th><th style="width:22%">物品</th><th style="width:10%">库存</th><th style="width:18%">项目</th><th style="width:24%">用途</th><th style="width:10%"></th></tr></thead>
      <tbody>${rows || emptyRow(6, '没有待发放的领用申请。')}</tbody></table></div>`;
  } else {
    const catList = categories.map((c) => `<div class="supply-cat">
      <span><b>${esc(c.name)}</b><i>${items.filter((i) => i.category_id === c.id).length} 个物品</i></span>
      <button class="btn btn--sm btn--quiet" data-action="supply-category-edit" data-id="${c.id}">编辑</button>
    </div>`).join('');
    const rows = items.map((i) => `<tr>
      <td data-label="物品"><span class="pcode">${esc(i.code)}</span><span class="pname">${esc(i.name)}</span></td>
      <td data-label="分类">${esc(i.category_name)}</td>
      <td data-label="单位">${esc(i.unit)}</td>
      <td data-label="库存"><b class="mono-sm ${i.stock <= i.safety_stock ? 'supply-low' : ''}">${i.stock}</b><span class="value-note">安全 ${i.safety_stock}</span></td>
      <td data-label="状态">${i.status === '可用' ? '可用' : '停用'}</td>
      <td class="right"><button class="btn btn--sm btn--quiet" data-action="supply-item-edit" data-id="${i.id}">编辑</button></td>
    </tr>`).join('');
    body = `<div class="grid-2 supply-manage">
      <div class="panel"><div class="panel-head"><h2><span class="no">01</span>用品分类</h2><button class="btn btn--sm btn--solid" data-action="supply-category-new">${ICONS.plus}新增分类</button></div>
        <div class="supply-cat-list">${catList || '<div class="empty">还没有分类</div>'}</div></div>
      <div class="panel"><div class="panel-head"><h2><span class="no">02</span>物品与库存</h2><button class="btn btn--sm btn--solid" data-action="supply-item-new">${ICONS.plus}新增物品</button></div>
        <table class="ledger supply-table"><thead><tr><th style="width:30%">物品</th><th style="width:16%">分类</th><th style="width:9%">单位</th><th style="width:15%">库存</th><th style="width:10%">状态</th><th style="width:10%"></th></tr></thead>
        <tbody>${rows || emptyRow(6, '还没有物品')}</tbody></table></div>
    </div>`;
  }

  return `<div class="view-enter supply-page">
    ${pageHead({
      eyebrow: 'WORKSPACE <span class="sep">/</span> OFFICE SUPPLIES',
      title: '办公用品',
      sub: '管理员维护分类、物品和库存；员工领用，配置的审批角色发放时扣库存，不能审批自己的申请。',
      actions: `<button class="btn btn--solid" data-action="supply-request">${ICONS.plus}发起领用</button>`,
    })}
    <div class="meeting-stats">
      <span><b>${items.length}</b>用品</span>
      <span><b>${(stock.summary?.low_stock || 0)}</b>低库存</span>
      <span><b>${reqSummary.pending || 0}</b>待发放</span>
    </div>
    ${tabBar}
    ${body}
  </div>`;
}

function openSupplyRequestModal(itemId = null) {
  const items = (state.supplies.items || []).filter((i) => i.status === '可用' && i.stock > 0);
  if (!items.length) { toast('当前没有可领用的物品', 'err'); return; }
  const selected = items.find((i) => String(i.id) === String(itemId)) || items[0];
  openModal({
    title: '办公用品领用',
    sub: '提交后由 PMO 发放；PMO 自己领用会直接发放并扣库存。',
    submit: '提交领用',
    wide: true,
    fields: [
      { name: 'item_id', label: '物品', type: 'select', value: selected.id, options: items.map((i) => ({ value: i.id, label: `${i.name}（库存 ${i.stock} ${i.unit}）` })) },
      { name: 'quantity', label: '数量', type: 'number', min: 1, max: selected.stock, value: 1 },
      { name: 'project_id', label: '关联项目（可选）', type: 'select', value: '', options: [{ value: '', label: '不关联项目' }, ...(state.data.projects || []).map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }))] },
      { name: 'purpose', label: '用途 / 备注', type: 'textarea', full: true, rows: 3, placeholder: '例如：项目周会使用' },
    ],
    onSubmit: async (v) => {
      await api('/api/supply-requests', {
        method: 'POST',
        body: { item_id: Number(v.item_id), quantity: Number(v.quantity), project_id: v.project_id || null, purpose: v.purpose },
      });
      await render();
      toast('领用申请已提交');
    },
  });
}

function openSupplyReview(id, action) {
  const r = (state.supplies.requests || []).find((x) => x.id === Number(id));
  if (!r) return;
  openModal({
    title: action === 'issue' ? '发放办公用品' : '拒绝领用',
    sub: `${r.requested_by_name || '—'} · ${r.item_name} × ${r.quantity} ${r.unit || r.item_unit}`,
    submit: action === 'issue' ? '确认发放' : '确认拒绝',
    fields: [{ name: 'comment', label: '备注', type: 'textarea', full: true, rows: 3, placeholder: action === 'issue' ? '可填发放说明' : '建议写明拒绝原因' }],
    onSubmit: async (v) => {
      await api(`/api/supply-requests/${id}/${action === 'issue' ? 'issue' : 'reject'}`, { method: 'POST', body: { comment: v.comment } });
      await render();
      toast(action === 'issue' ? '已发放，库存已扣减' : '已拒绝');
    },
  });
}

function openSupplyCategoryModal(cat) {
  const isEdit = Boolean(cat);
  openModal({
    title: isEdit ? '编辑用品分类' : '新增用品分类',
    submit: isEdit ? '保存' : '新增',
    fields: [
      { name: 'name', label: '分类名称', required: true, value: cat?.name || '' },
      { name: 'sort_order', label: '排序', type: 'number', value: cat?.sort_order || 0 },
    ],
    onDelete: isEdit ? async () => {
      await api(`/api/supply-categories/${cat.id}`, { method: 'DELETE' });
      await render();
      toast('分类已删除');
    } : undefined,
    onSubmit: async (v) => {
      if (isEdit) await api(`/api/supply-categories/${cat.id}`, { method: 'PATCH', body: v });
      else await api('/api/supply-categories', { method: 'POST', body: v });
      await render();
      toast(isEdit ? '分类已更新' : '分类已新增');
    },
  });
}

function openSupplyItemModal(item) {
  const isEdit = Boolean(item);
  const categories = state.supplies.categories || [];
  openModal({
    title: isEdit ? '编辑办公用品' : '新增办公用品',
    sub: '库存由管理员维护；发放时自动扣减。',
    wide: true,
    submit: isEdit ? '保存' : '新增',
    fields: [
      { name: 'code', label: '编码', required: true, value: item?.code || '', placeholder: 'SUP-009' },
      { name: 'name', label: '名称', required: true, value: item?.name || '' },
      { name: 'category_id', label: '分类', type: 'select', value: item?.category_id || categories[0]?.id, options: categories.map((c) => ({ value: c.id, label: c.name })) },
      { name: 'unit', label: '单位', value: item?.unit || '件' },
      { name: 'stock', label: '当前库存', type: 'number', min: 0, value: item?.stock ?? 0 },
      { name: 'safety_stock', label: '安全库存', type: 'number', min: 0, value: item?.safety_stock ?? 0 },
      { name: 'status', label: '状态', type: 'select', value: item?.status || '可用', options: ['可用', '停用'] },
      { name: 'notes', label: '备注', type: 'textarea', full: true, rows: 3, value: item?.notes || '' },
    ],
    onDelete: isEdit ? async () => {
      await api(`/api/supply-items/${item.id}`, { method: 'DELETE' });
      await render();
      toast('物品已删除');
    } : undefined,
    onSubmit: async (v) => {
      if (isEdit) await api(`/api/supply-items/${item.id}`, { method: 'PATCH', body: v });
      else await api('/api/supply-items', { method: 'POST', body: v });
      await render();
      toast(isEdit ? '物品已更新' : '物品已新增');
    },
  });
}

async function render() {
  renderNav();
  const v = $('#view');
  let html = '';
  switch (state.route) {
    case 'overview': html = await viewOverview(); break;
    case 'my-tasks': html = viewMyTasks(); break;
    case 'projects': html = viewProjects(); break;
    case 'timeline': html = viewTimeline(); break;
    case 'process': html = await viewProcessMatrix(); break;
    case 'project': html = await viewProject(state.params.id); break;
    case 'milestones': html = viewMilestones(); break;
    case 'gates': html = viewGates(); break;
    case 'risks': html = viewRisks(); break;
    case 'resources': html = viewResources(); break;
    case 'deliverables': html = await viewDeliverables(); break;
    case 'write': html = await viewWrite(); break;
    case 'report': html = await viewReport(); break;
    case 'admin': html = await viewAdmin(); break;
    case 'help': html = await viewHelp(); break;
    case 'ai': html = viewAIAssistant(); break;
    case 'meeting': html = await viewMeetingRooms(); break;
    case 'supplies': html = await viewSupplies(); break;
    default: html = viewOverview();
  }
  v.innerHTML = html;
  v.querySelectorAll('thead th').forEach((th) => {
    if (!th.hasAttribute('scope')) th.setAttribute('scope', 'col');
  });

  const titles = {
    overview: '项目群总览', 'my-tasks': '我的待办', projects: '项目台账', timeline: '项目时间轴',
    process: '过程管理', milestones: '里程碑', risks: '风险与问题', gates: '阶段关口', deliverables: '计划与周报',
    resources: '资源负载', report: '报表输出', admin: '管理维护', help: '帮助与知识库', ai: 'AI 助手', meeting: '会议室预订', supplies: '办公用品',
  };
  let title = titles[state.route] || '';
  if (state.route === 'project') {
    const proj = state.data?.projects.find((p) => p.id === state.params.id);
    title = proj ? proj.name : '项目';
  } else if (state.route === 'write') {
    const proj = state.data?.projects.find((p) => p.id === state.params.projectId);
    title = `${state.params.kind === 'plan' ? '项目计划' : '项目周报'}${proj ? ` · ${proj.name}` : ''}`;
  }
  document.title = title ? `${title} · PMO 项目群控制台` : 'PMO 项目群控制台';

  if (state.route === 'projects') updateProjCount();
  if (state.route === 'help' && state.help.tab === 'ai') {
    const thread = document.getElementById('help-thread');
    if (thread) thread.scrollTop = thread.scrollHeight;
  }
  if (state.route === 'ai') {
    const thread = document.getElementById('global-ai-thread');
    if (thread) {
      const msgs = thread.querySelectorAll('.chat-msg--ai');
      const last = msgs[msgs.length - 1];
      thread.scrollTop = last ? Math.max(0, last.offsetTop - 8) : 0;
    }
  }
  if (state.route === 'timeline' && state.ganttKey && state.ganttKey !== state.ganttScrolledKey) {
    state.ganttScrolledKey = state.ganttKey;
    requestAnimationFrame(() => scrollGanttToToday());
  }
}

function updateProjCount() {
  const n = filteredProjects().length;
  const el = $('#proj-count');
  if (el) el.textContent = `显示 ${n} / ${state.data.stats.total} 个项目 · 健康度与预算数据实时计算`;
}

/* --------------------------------------------------------------- modal --- */

let modalCloser = null;
let modalDeleteHandler = null;
let modalReturnFocus = null;
let focusTrapHandler = null;

function activateFocusTrap() {
  const modal = document.querySelector('.modal');
  if (!modal) return;
  modalReturnFocus = document.activeElement;
  focusTrapHandler = (e) => {
    if (e.key !== 'Tab') return;
    const nodes = [...modal.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      .filter((el) => el.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (!modal.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', focusTrapHandler);
}

function releaseFocusTrap() {
  if (focusTrapHandler) {
    document.removeEventListener('keydown', focusTrapHandler);
    focusTrapHandler = null;
  }
  if (modalReturnFocus && document.contains(modalReturnFocus)) {
    try { modalReturnFocus.focus(); } catch { /* ignore */ }
  }
  modalReturnFocus = null;
}

function closeModal() {
  $('#modal-root').innerHTML = '';
  document.body.style.overflow = '';
  modalCloser = null;
  modalDeleteHandler = null;
  releaseFocusTrap();
}

function openModal({ title, sub, fields = [], submit = '保存', onSubmit, onDelete, wide = false, readOnly = false }) {
  const grouped = fields.map((f) => {
  const cls = f.full ? 'field field--full' : 'field';
    const val = f.value ?? '';
    let control = '';
    const dis = (f.disabled || readOnly) ? 'disabled' : '';
    if (f.type === 'select') {
      control = `<select id="f-${f.name}" name="${f.name}" ${f.required ? 'required' : ''} ${dis}>${f.options.map((o) => {
        const value = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? o : o.label;
        return `<option value="${esc(value)}" ${String(value) === String(val) ? 'selected' : ''}>${esc(label)}</option>`;
      }).join('')}</select>`;
    } else if (f.type === 'textarea') {
      control = `<textarea id="f-${f.name}" name="${f.name}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''} ${dis}>${esc(val)}</textarea>`;
    } else {
      control = `<input id="f-${f.name}" name="${f.name}" type="${f.type || 'text'}" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''} ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} ${f.step ? `step="${f.step}"` : ''} ${dis} />`;
    }
    return `<div class="${cls}">
      <label for="f-${f.name}">${esc(f.label)}${f.required ? ' *' : ''}</label>
      ${control}
      ${f.help ? `<span class="help">${esc(f.help)}</span>` : ''}
    </div>`;
  }).join('');

  $('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="modal-backdrop">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1" style="${wide ? 'width:min(680px,100%)' : ''}">
      <div class="modal-head">
        <div><h3 id="modal-title">${esc(title)}</h3>${sub ? `<p>${esc(sub)}</p>` : ''}</div>
        <button class="icon-btn" data-action="modal-close" aria-label="关闭">${ICONS.close}</button>
      </div>
      <form id="modal-form">
        <div class="modal-body"><div class="modal-fields">${grouped}</div></div>
        <div class="modal-foot">
          ${onDelete ? '<button type="button" class="btn btn--danger btn--sm" data-action="modal-delete" style="margin-right:auto">删除</button>' : ''}
          <button type="button" class="btn btn--quiet" data-action="modal-close">${readOnly ? '关闭' : '取消'}</button>
          ${readOnly ? '' : `<button type="submit" class="btn btn--solid">${esc(submit)}</button>`}
        </div>
      </form>
    </div>
  </div>`;

  const form = $('#modal-form');
  const first = form.querySelector('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)')
    || document.querySelector('.modal');
  if (first) setTimeout(() => first.focus(), 60);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (readOnly) return;
    const fd = new FormData(form);
    const values = {};
    for (const [k, v] of fd.entries()) values[k] = v;
    try {
      await onSubmit(values);
      closeModal();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  modalCloser = closeModal;
  modalDeleteHandler = onDelete || null;
  activateFocusTrap();
  document.body.style.overflow = 'hidden';
}

/* --------------------------------------------------------------- forms --- */

async function loadPmUsers() {
  if (state.pmUsers) return state.pmUsers;
  try {
    const data = await api('/api/admin/users');
    state.pmUsers = data.users.filter((u) => u.role === 'pm' && u.active);
  } catch {
    state.pmUsers = [];
  }
  return state.pmUsers;
}

function pmOptions(users, party) {
  return [{ value: '', label: '未指定' }].concat(
    users.filter((u) => u.party === party).map((u) => ({ value: u.id, label: `${u.name}（${party}）` }))
  );
}

async function newProjectForm() {
  const users = await loadPmUsers();
  openModal({
    title: '新建项目',
    sub: '一个项目配两位项目经理：乙方项目经理负责周报、计划等日常维护，甲方项目经理负责查看和留言。',
    submit: '创建项目',
    wide: true,
    fields: [
      { name: 'program_id', label: '所属项目群', type: 'select', value: state.programId || state.data.programs?.[0]?.id || '', options: (state.data.programs || []).map((x) => ({ value: x.id, label: `${x.code} ${x.name}` })) },
      { name: 'code', label: '项目编号', required: true, placeholder: 'P-10' },
      { name: 'name', label: '项目名称', required: true, placeholder: '例如：统一支付网关' },
      { name: 'vendor_pm_id', label: '乙方项目经理', type: 'select', options: pmOptions(users, '乙方') },
      { name: 'client_pm_id', label: '甲方项目经理', type: 'select', options: pmOptions(users, '甲方'), help: '没有可选项时，先到管理维护创建甲方项目经理账号' },
      { name: 'sponsor', label: '项目群负责人', value: state.data.program.owner },
      { name: 'stage', label: '阶段', type: 'select', value: '规划中', options: ['规划中', '执行中', '验收中', '已结项'] },
      { name: 'priority', label: '优先级', type: 'select', value: 'P1', options: ['P0', 'P1', 'P2'] },
      { name: 'plan_start', label: '计划开始', type: 'date', value: today() },
      { name: 'plan_end', label: '计划结束', type: 'date', value: isoDate(new Date(parse(today()).getTime() + 120 * 86400000)) },
      { name: 'budget', label: '预算（万元）', type: 'number', value: 0, min: 0 },
      { name: 'team_size', label: '团队规模（人）', type: 'number', value: 0, min: 0 },
      { name: 'objective', label: '项目目标', type: 'textarea', full: true, placeholder: '一句话说明交付什么、支撑谁' },
    ],
    onSubmit: async (v) => {
      await api('/api/projects', { method: 'POST', body: v });
      await reload();
      toast('项目已创建');
    },
  });
}

async function editProjectForm(p) {
  const isPmo = state.me.role === 'pmo';
  const users = isPmo ? await loadPmUsers() : [];
  openModal({
    title: '编辑项目台账',
    sub: '项目经理的调整会影响填报权限：乙方项目经理可维护周报和计划，甲方项目经理只读。',
    submit: '保存',
    wide: true,
    fields: [
      ...(isPmo ? [{ name: 'program_id', label: '所属项目群', type: 'select', value: p.program_id, options: (state.data.programs || []).map((x) => ({ value: x.id, label: `${x.code} ${x.name}` })) }] : []),
      { name: 'name', label: '项目名称', value: p.name, required: true },
      isPmo
        ? { name: 'vendor_pm_id', label: '乙方项目经理', type: 'select', value: p.vendor_pm_id || '', options: pmOptions(users, '乙方') }
        : { name: 'vendor_pm_name', label: '乙方项目经理', value: p.pm || '未指定', disabled: true },
      isPmo
        ? { name: 'client_pm_id', label: '甲方项目经理', type: 'select', value: p.client_pm_id || '', options: pmOptions(users, '甲方') }
        : { name: 'client_pm_name', label: '甲方项目经理', value: p.client_pm || '未指定', disabled: true },
      { name: 'sponsor', label: '项目群负责人', value: p.sponsor || '' },
      { name: 'stage', label: '阶段', type: 'select', value: p.stage, options: ['规划中', '执行中', '验收中', '已结项'] },
      { name: 'priority', label: '优先级', type: 'select', value: p.priority, options: ['P0', 'P1', 'P2'] },
      { name: 'progress', label: '进度（%）', type: 'number', value: p.progress, min: 0, max: 100, disabled: Boolean(p.hasPlan), help: p.hasPlan ? '已有整体计划，进度由任务自动汇总' : '' },
      { name: 'plan_start', label: '计划开始', type: 'date', value: p.plan_start },
      { name: 'plan_end', label: '计划结束', type: 'date', value: p.plan_end },
      { name: 'actual_start', label: '实际开始', type: 'date', value: p.actual_start || '' },
      { name: 'actual_end', label: '实际结束', type: 'date', value: p.actual_end || '' },
      { name: 'budget', label: '预算（万元）', type: 'number', value: p.budget, min: 0 },
      { name: 'spent', label: '已支出（万元）', type: 'number', value: p.spent, min: 0 },
      { name: 'team_size', label: '团队规模（人）', type: 'number', value: p.team_size, min: 0 },
      { name: 'objective', label: '项目目标', type: 'textarea', full: true, value: p.objective || '' },
    ],
    onSubmit: async (v) => {
      await api(`/api/projects/${p.id}`, { method: 'PATCH', body: v });
      await reload();
      toast('台账已更新');
    },
  });
}

function newMilestoneForm(projectId) {
  const projects = state.data.projects;
  openModal({
    title: '新增里程碑',
    sub: '里程碑是项目群层面可交付、可验收的节点，避免拆得过细。',
    fields: [
      { name: 'project_id', label: '所属项目', type: 'select', value: projectId || projects[0]?.id, options: projects.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` })) },
      { name: 'name', label: '节点名称', required: true, placeholder: '例如：UAT 完成' },
      { name: 'due_date', label: '计划日期', type: 'date', required: true, value: isoDate(new Date(parse(today()).getTime() + 14 * 86400000)) },
      { name: 'owner', label: '责任人', placeholder: '姓名' },
      { name: 'status', label: '状态', type: 'select', value: '未开始', options: ['未开始', '进行中', '已完成', '延期'] },
      { name: 'note', label: '备注', type: 'textarea', full: true },
    ],
    onSubmit: async (v) => {
      v.project_id = Number(v.project_id);
      await api('/api/milestones', { method: 'POST', body: v });
      await reload();
      toast('里程碑已新增');
    },
  });
}

function newRiskForm(projectId) {
  const projects = state.data.projects;
  openModal({
    title: '登记风险 / 问题',
    sub: '敞口 = 概率 × 影响，1–5 分。≥16 分的项目将在项目群例会中讨论。',
    wide: true,
    fields: [
      { name: 'project_id', label: '所属项目', type: 'select', value: projectId || projects[0]?.id, options: projects.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` })) },
      { name: 'kind', label: '类型', type: 'select', options: ['风险', '问题', '变更', '依赖'] },
      { name: 'title', label: '标题', full: true, required: true, placeholder: '一句话说清是什么风险，不要只写「进度风险」' },
      { name: 'detail', label: '详情', type: 'textarea', full: true, placeholder: '触发条件、已造成的影响、涉及范围' },
      { name: 'probability', label: '概率 1–5', type: 'number', value: 3, min: 1, max: 5 },
      { name: 'impact', label: '影响 1–5', type: 'number', value: 3, min: 1, max: 5 },
      { name: 'owner', label: '责任人', placeholder: '姓名' },
      { name: 'due_date', label: '要求关闭日期', type: 'date', value: isoDate(new Date(parse(today()).getTime() + 14 * 86400000)) },
      { name: 'response', label: '应对措施', type: 'textarea', full: true, placeholder: '具体动作、时间点、责任人' },
    ],
    onSubmit: async (v) => {
      v.project_id = Number(v.project_id);
      v.probability = Number(v.probability);
      v.impact = Number(v.impact);
      await api('/api/risks', { method: 'POST', body: v });
      await reload();
      toast('风险已登记');
    },
  });
}

function riskDetailForm(r) {
  const p = state.data.projects.find((x) => x.id === r.project_id);
  openModal({
    title: r.title,
    sub: `${p?.name || ''} · 当前敞口 ${sevOf(r)}`,
    wide: true,
    submit: '保存更新',
    fields: [
      { name: 'status', label: '状态', type: 'select', value: r.status, options: ['开放', '缓解中', '已关闭'] },
      { name: 'owner', label: '责任人', value: r.owner },
      { name: 'probability', label: '概率 1–5', type: 'number', value: r.probability, min: 1, max: 5 },
      { name: 'impact', label: '影响 1–5', type: 'number', value: r.impact, min: 1, max: 5 },
      { name: 'due_date', label: '要求关闭日期', type: 'date', value: r.due_date },
      { name: 'response', label: '应对措施', type: 'textarea', full: true, value: r.response },
    ],
    onSubmit: async (v) => {
      v.probability = Number(v.probability);
      v.impact = Number(v.impact);
      await api(`/api/risks/${r.id}`, { method: 'PATCH', body: v });
      await reload();
      toast('风险状态已更新');
    },
  });
}

function allocForm(alloc, projectId) {
  const isEdit = Boolean(alloc);
  openModal({
    title: isEdit ? '编辑投入' : '添加项目成员',
    sub: isEdit ? '调整该成员在本项目的投入比例。' : '按 FTE 百分比录入；同一成员跨项目累计超过 100% 即为过载。',
    fields: [
      { name: 'person', label: '成员', value: alloc?.person || '', required: true, placeholder: '姓名' },
      { name: 'role', label: '项目角色', value: alloc?.role || '', placeholder: '例如：开发 / 测试 / 产品' },
      { name: 'vendor_id', label: '乙方供应商', type: 'select', value: alloc?.vendor_id || '',
        options: [{ value: '', label: '未指定' }, ...(state.data.vendors || []).filter((v) => v.status === '合作中' || v.id === alloc?.vendor_id).map((v) => ({ value: v.id, label: `${v.code} ${v.name}` }))],
        help: '成员属于哪家乙方供应商；供应商主数据在管理维护里维护。' },
      { name: 'pct', label: '投入比例（%）', type: 'number', value: alloc?.pct ?? 50, min: 0, max: 200 },
    ],
    onDelete: isEdit ? async () => {
      await api(`/api/allocations/${alloc.id}`, { method: 'DELETE' });
      await reload();
      toast('已移除该成员');
    } : null,
    onSubmit: async (v) => {
      v.pct = Number(v.pct);
      v.vendor_id = v.vendor_id ? Number(v.vendor_id) : null;
      if (isEdit) {
        await api(`/api/allocations/${alloc.id}`, { method: 'PATCH', body: v });
      } else {
        await api('/api/allocations', { method: 'POST', body: { ...v, project_id: projectId } });
      }
      await reload();
      toast(isEdit ? '投入已更新' : '已添加成员');
    },
  });
}

function newUpdateForm(projectId) {
  const p = state.data.projects.find((x) => x.id === projectId);
  openModal({
    title: '记录项目动态',
    sub: `${p?.name || ''} · 仅作为项目内部动态，正式周报请到「计划与周报」提交`,
    fields: [
      { name: 'author', label: '提交人', value: p?.pm || '' },
      { name: 'period', label: '周期', type: 'select', value: '本周', options: ['本周', '上周'] },
      { name: 'content', label: '更新内容', type: 'textarea', full: true, required: true, placeholder: '完成了什么、偏差多少、需要谁支持。三句话以内。' },
    ],
    onSubmit: async (v) => {
      await api('/api/updates', { method: 'POST', body: { ...v, project_id: projectId } });
      await reload();
      toast('更新已提交');
    },
  });
}

/* --------------------------------------------------------------- actions --- */

async function handleAction(action, el) {
  const id = Number(el.dataset.id);
  switch (action) {
    case 'goto-report':
      navTo('#/report');
      break;
    case 'approval-settings-save': {
      try {
        await api('/api/admin/approval-settings', {
          method: 'PUT',
          body: {
            meeting_role: document.getElementById('approval-meeting')?.value || 'pmo',
            supply_role: document.getElementById('approval-supply')?.value || 'pmo',
          },
        });
        toast('审批设置已保存');
        await render();
      } catch (e) { toast(e.message, 'err'); }
      break;
    }
    case 'ai-config-save': {
      const body = {
        base_url: document.getElementById('ai-base')?.value.trim() || '',
        model: document.getElementById('ai-model')?.value.trim() || '',
        api_key: document.getElementById('ai-key')?.value || '',
        clear_key: Boolean(document.getElementById('ai-clear-key')?.checked),
      };
      try {
        await api('/api/admin/ai', { method: 'PUT', body });
        toast('AI 配置已保存');
        await render();
      } catch (e) { toast(e.message, 'err'); }
      break;
    }
    case 'ai-config-test': {
      const box = document.getElementById('ai-test-result');
      if (box) box.innerHTML = '<span class="ai-testing">测试中…</span>';
      const body = {
        base_url: document.getElementById('ai-base')?.value.trim() || '',
        model: document.getElementById('ai-model')?.value.trim() || '',
        api_key: document.getElementById('ai-key')?.value || '',
      };
      try {
        const r = await api('/api/admin/ai/test', { method: 'POST', body });
        if (box) box.innerHTML = `<span class="ai-test-ok">连接成功 · ${esc(r.model)} · ${r.latency_ms}ms · 返回 ${esc(r.reply)}</span>`;
      } catch (e) {
        if (box) box.innerHTML = `<span class="ai-test-err">${esc(e.message)}</span>`;
      }
      break;
    }
    case 'supply-tab':
      state.supplies.tab = el.dataset.value || 'catalog';
      await render();
      break;
    case 'supply-category':
      state.supplies.category = el.dataset.value || 'all';
      await render();
      break;
    case 'supply-request':
      openSupplyRequestModal(el.dataset.id ? Number(el.dataset.id) : null);
      break;
    case 'supply-cancel': {
      const r = (state.supplies.requests || []).find((x) => x.id === Number(el.dataset.id));
      if (!r) break;
      if (!window.confirm(`取消「${r.item_name}」的领用申请？`)) break;
      try {
        await api(`/api/supply-requests/${r.id}/cancel`, { method: 'POST', body: { comment: '申请人取消' } });
        await render();
        toast('领用申请已取消');
      } catch (e) { toast(e.message, 'err'); }
      break;
    }
    case 'supply-issue':
      openSupplyReview(el.dataset.id, 'issue');
      break;
    case 'supply-reject':
      openSupplyReview(el.dataset.id, 'reject');
      break;
    case 'supply-category-new':
      openSupplyCategoryModal(null);
      break;
    case 'supply-category-edit': {
      const c = (state.supplies.categories || []).find((x) => x.id === Number(el.dataset.id));
      if (c) openSupplyCategoryModal(c);
      break;
    }
    case 'supply-item-new':
      if (!(state.supplies.categories || []).length) { toast('请先新增一个用品分类', 'err'); break; }
      openSupplyItemModal(null);
      break;
    case 'supply-item-edit': {
      const i = (state.supplies.items || []).find((x) => x.id === Number(el.dataset.id));
      if (i) openSupplyItemModal(i);
      break;
    }
    case 'meeting-tab':
      state.meeting.tab = el.dataset.value || 'calendar';
      await render();
      break;
    case 'meeting-date':
      state.meeting.date = el.dataset.date || today();
      await render();
      break;
    case 'meeting-prev':
      state.meeting.date = addDays(state.meeting.date || today(), -7);
      await render();
      break;
    case 'meeting-next':
      state.meeting.date = addDays(state.meeting.date || today(), 7);
      await render();
      break;
    case 'meeting-today':
      state.meeting.date = today();
      await render();
      break;
    case 'booking-new':
      openMeetingBookingModal({
        date: el.dataset.date || state.meeting.date,
        roomId: el.dataset.room ? Number(el.dataset.room) : null,
        hour: el.dataset.hour != null ? Number(el.dataset.hour) : null,
      });
      break;
    case 'booking-open': {
      const b = (state.meeting.bookings || []).find((x) => x.id === Number(el.dataset.id));
      if (!b) break;
      openModal({
        title: b.title,
        sub: `${b.room_code} ${b.room_name} · ${b.start_at.slice(0, 10)} ${meetingTimeText(b.start_at)}–${meetingTimeText(b.end_at)}`,
        readOnly: true,
        fields: [
          { name: 'room', label: '会议室', value: `${b.room_code} ${b.room_name}` },
          { name: 'requester', label: '发起人', value: b.requested_by_name || '—' },
          { name: 'project', label: '关联项目', value: b.project_code ? `${b.project_code} ${b.project_name}` : '不关联项目' },
          { name: 'attendees', label: '参会人数', value: `${b.attendees} 人` },
          { name: 'status', label: '状态', value: b.status },
          { name: 'purpose', label: '用途 / 备注', type: 'textarea', full: true, value: b.purpose || '—' },
        ],
      });
      break;
    }
    case 'booking-cancel': {
      const b = (state.meeting.bookings || []).find((x) => x.id === Number(el.dataset.id));
      if (!b) break;
      if (!window.confirm(`取消「${b.title}」的预订？`)) break;
      try {
        await api(`/api/meeting-bookings/${b.id}/cancel`, { method: 'POST', body: { comment: '发起人取消' } });
        await render();
        toast('预订已取消');
      } catch (e) { toast(e.message, 'err'); }
      break;
    }
    case 'booking-approve':
      openMeetingReview(el.dataset.id, 'approve');
      break;
    case 'booking-reject':
      openMeetingReview(el.dataset.id, 'reject');
      break;
    case 'meeting-room-new':
      openMeetingRoomModal(null);
      break;
    case 'meeting-room-edit': {
      const r = (state.meeting.rooms || []).find((x) => x.id === Number(el.dataset.id));
      if (r) openMeetingRoomModal(r);
      break;
    }
    case 'global-ai-run':
      await askGlobalAI(el.dataset.mode || 'portfolio');
      break;
    case 'global-ai-ask': {
      const q = document.getElementById('global-ai-question')?.value.trim();
      if (!q) { toast('先写一个问题', 'err'); break; }
      await askGlobalAI('ask', q);
      break;
    }
    case 'global-ai-example': {
      const input = document.getElementById('global-ai-question');
      if (input) {
        input.value = el.dataset.q || '';
        state.aiGlobal.draft = input.value;
        input.focus();
      }
      break;
    }
    case 'global-ai-clear':
      state.aiGlobal.messages = [];
      await render();
      break;
    case 'kb-search':
      if (projectKBSearchTimer) { clearTimeout(projectKBSearchTimer); projectKBSearchTimer = null; }
      state.projectKBFilter.q = document.getElementById('kb-search')?.value.trim() || '';
      await render();
      focusProjectKBSearch();
      break;
    case 'kb-search-clear':
      if (projectKBSearchTimer) { clearTimeout(projectKBSearchTimer); projectKBSearchTimer = null; }
      state.projectKBFilter.q = '';
      await render();
      focusProjectKBSearch();
      break;
    case 'kb-kind':
      if (projectKBSearchTimer) { clearTimeout(projectKBSearchTimer); projectKBSearchTimer = null; }
      state.projectKBFilter.kind = el.dataset.value || '';
      await render();
      break;
    case 'kb-note-new':
      openProjectKBNote(null);
      break;
    case 'kb-note-edit': {
      const entry = (state.projectKB?.entries || []).find((x) => x.id === el.dataset.id);
      if (entry) openProjectKBNote(entry);
      break;
    }
    case 'kb-note-del': {
      const entry = (state.projectKB?.entries || []).find((x) => x.id === el.dataset.id);
      if (!entry) break;
      const p = state.workspace?.project;
      if (!p) break;
      if (!window.confirm(`删除笔记「${entry.title}」？`)) break;
      try {
        await api(`/api/projects/${p.id}/kb/notes/${Number(String(entry.id).split(':')[1])}`, { method: 'DELETE' });
        await render();
        toast('笔记已删除');
      } catch (err) { toast(err.message, 'err'); }
      break;
    }
    case 'ai-run':
      await runProjectAI(el.dataset.mode || 'summary');
      break;
    case 'ai-ask': {
      const q = document.getElementById('ai-question')?.value.trim();
      if (!q) { toast('先写一个问题', 'err'); break; }
      await runProjectAI('ask', q);
      break;
    }
    case 'ai-copy': {
      if (state.ai?.answer) {
        try { await navigator.clipboard.writeText(state.ai.answer); toast('已复制'); }
        catch { toast('复制失败，请手动选择文本', 'err'); }
      }
      break;
    }
    case 'help-tab':
      state.help.draft = document.getElementById('help-question')?.value || '';
      state.help.tab = el.dataset.value === 'ai' ? 'ai' : 'kb';
      await render();
      break;
    case 'help-search':
      if (helpSearchTimer) { clearTimeout(helpSearchTimer); helpSearchTimer = null; }
      state.help.q = document.getElementById('help-search')?.value.trim() || '';
      state.help.tab = 'kb';
      await render();
      focusHelpSearch();
      break;
    case 'help-search-clear':
      if (helpSearchTimer) { clearTimeout(helpSearchTimer); helpSearchTimer = null; }
      state.help.q = '';
      state.help.tab = 'kb';
      await render();
      focusHelpSearch();
      break;
    case 'help-category':
      state.help.category = el.dataset.value || '全部';
      state.help.tab = 'kb';
      await render();
      break;
    case 'help-example': {
      const input = document.getElementById('help-question');
      if (input) {
        input.value = el.dataset.q || '';
        state.help.draft = input.value;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
      break;
    }
    case 'help-clear':
      state.help.messages = [];
      await render();
      break;
    case 'help-ask': {
      const q = document.getElementById('help-question')?.value.trim();
      if (!q) { toast('先写一个问题', 'err'); break; }
      await askHelp(q);
      break;
    }
    case 'snapshot-now': {
      try {
        await api('/api/admin/snapshot', { method: 'POST' });
        await reload({ keepScroll: false });
        toast('本周快照已记录');
      } catch (err) { toast(err.message, 'err'); }
      break;
    }
    case 'score-edit': {
      const p = state.data.projects.find((x) => x.id === Number(el.dataset.id));
      if (p) openScoreModal(p);
      break;
    }
    case 'rail-toggle':
      setRailCollapsed(!document.body.classList.contains('is-rail-collapsed'));
      break;
    case 'export':
      window.location.href = '/api/export';
      toast('备份文件已开始下载');
      break;
    case 'acceptance-new': {
      const w = state.workspace;
      if (w) openAcceptanceModal(w.project, { scope: 'project' });
      break;
    }
    case 'editor-accept': {
      const ed = state.editor;
      const project = state.workspace?.project || state.data.projects.find((p) => p.id === ed?.projectId);
      if (ed?.item && project) {
        openAcceptanceModal(project, { scope: 'deliverable', ref_type: ed.kind, ref_id: ed.item.id });
      }
      break;
    }
    case 'benefit-new': {
      const w = state.workspace;
      if (w) openBenefitModal(w.project, null);
      break;
    }
    case 'benefit-edit': {
      const w = state.workspace;
      const b = w?.benefits.find((x) => x.id === Number(el.dataset.id));
      if (w && b) openBenefitModal(w.project, b);
      break;
    }
    case 'action-new': {
      const w = state.workspace;
      if (w) openActionModal(w.project, null);
      break;
    }
    case 'action-edit': {
      const w = state.workspace;
      const a = w?.actions.find((x) => x.id === Number(el.dataset.id));
      if (w && a) openActionModal(w.project, a);
      break;
    }
    case 'action-complete': {
      const id = Number(el.dataset.id);
      try {
        await api(`/api/actions/${id}`, { method: 'PATCH', body: { status: '已完成' } });
        await reload({ keepScroll: false });
        toast('行动项已完成');
      } catch (err) { toast(err.message, 'err'); }
      break;
    }
    case 'plan-import': {
      const input = document.getElementById('plan-import-file');
      if (input) {
        input.dataset.id = el.dataset.id || '';
        input.click();
      }
      break;
    }
    case 'plan-task-new': {
      const w = state.workspace;
      if (w) openPlanTaskModal(w.project, null);
      break;
    }
    case 'plan-task-edit': {
      const w = state.workspace;
      const t = state.projectPlan?.tasks.find((x) => x.id === Number(el.dataset.id));
      if (w && t) openPlanTaskModal(w.project, t);
      break;
    }
    case 'plan-indent':
    case 'plan-outdent': {
      const t = state.projectPlan?.tasks.find((x) => x.id === Number(el.dataset.id));
      if (!t) break;
      try {
        await api(`/api/plan/tasks/${t.id}/${action === 'plan-indent' ? 'indent' : 'outdent'}`, { method: 'POST' });
        await reload({ keepScroll: false });
        toast(action === 'plan-indent' ? '已缩进' : '已升级');
      } catch (err) { toast(err.message, 'err'); }
      break;
    }
    case 'plan-task-delete': {
      const t = state.projectPlan?.tasks.find((x) => x.id === Number(el.dataset.id));
      if (!t) break;
      openModal({
        title: '删除计划任务',
        sub: `确认删除「${t.name}」${t.isSummary ? '及其全部子任务' : ''}？此操作不可撤销。`,
        submit: '确认删除',
        fields: [],
        onSubmit: async () => {
          await api(`/api/plan/tasks/${t.id}`, { method: 'DELETE' });
          await reload({ keepScroll: false });
          toast('任务已删除');
        },
      });
      break;
    }
    case 'plan-baseline': {
      const w = state.workspace;
      if (!w) break;
      openModal({
        title: '设置计划基线',
        sub: '将当前所有任务的开始、完成日期保存为基线。后续调整计划时，甘特图会保留基线作为对比。',
        submit: '设为基线',
        fields: [],
        onSubmit: async () => {
          await api(`/api/projects/${w.project.id}/plan/baseline`, { method: 'POST' });
          await reload({ keepScroll: false });
          toast('基线已更新');
        },
      });
      break;
    }
    case 'new-project':
      await newProjectForm();
      break;
    case 'edit-project': {
      const p = state.data.projects.find((x) => x.id === id);
      if (p) await editProjectForm(p);
      break;
    }
    case 'new-milestone':
      newMilestoneForm(id || null);
      break;
    case 'ms-complete': {
      await api(`/api/milestones/${id}`, { method: 'PATCH', body: { status: '已完成' } });
      await reload();
      toast('已标记完成');
      break;
    }
    case 'new-risk':
      newRiskForm(id || null);
      break;
    case 'risk-open': {
      const r = state.data.risks.find((x) => x.id === id);
      if (r) riskDetailForm(r);
      break;
    }
    case 'new-update':
      newUpdateForm(id);
      break;
    case 'dlv-edit': {
      const pid = Number(el.dataset.project);
      const kind = el.dataset.kind;
      const period = el.dataset.period;
      state.editor = null;
      navTo(`#/write/${kind}/${pid}/${period}`);
      break;
    }
    case 'editor-save': {
      const saved = await saveEditor(true);
      if (saved) toast('草稿已保存');
      break;
    }
    case 'editor-submit': {
      const ed = state.editor;
      if (!ed) break;
      if (ed.kind === 'weekly') {
        if (!markdownBodyPlain(ed.content.markdown || '').trim()) {
          toast('请先写周报正文再提交', 'err');
          break;
        }
      } else if (!String(ed.content.objective || '').trim()) {
        toast('请先填写目标与范围', 'err');
        break;
      }
      const item = await saveEditor(true);
      if (!item) break;
      await api(`/api/deliverables/${ed.kind}/${item.id}/submit`, { method: 'POST' });
      state.editor = null;
      state.route = 'deliverables';
      location.hash = '#/deliverables';
      await reload({ keepScroll: false });
      toast('已提交，等待 PMO 审核');
      break;
    }
    case 'editor-prefill':
      await prefillEditor();
      break;
    case 'editor-template':
      await openTemplatePicker();
      break;
    case 'md-insert':
      insertMarkdown(el.dataset.md);
      break;
    case 'md-view': {
      const ed = state.editor;
      const box = document.getElementById('md-editor');
      if (!ed || !box) break;
      const view = ['write', 'split', 'preview'].includes(el.dataset.value) ? el.dataset.value : 'split';
      ed.mdView = view;
      try { localStorage.setItem('pmo.mdview', view); } catch { /* ignore */ }
      box.className = `md-editor md-editor--${view}`;
      box.querySelectorAll('.md-view').forEach((b) => b.classList.toggle('is-on', b.dataset.value === view));
      break;
    }
    case 'md-fullscreen': {
      const box = document.getElementById('md-editor');
      if (!box) break;
      const on = box.classList.toggle('is-fullscreen');
      el.textContent = on ? '退出全屏' : '全屏';
      el.setAttribute('aria-label', on ? '退出全屏' : '全屏编辑');
      if (on) document.getElementById('ef-markdown')?.focus();
      break;
    }
    case 'editor-plan-fill': {
      const ed = state.editor;
      if (!ed?.planContext?.tasks.length) break;
      const lines = ed.planContext.tasks.map((t) => `- ${t.name}：${t.progress >= 100 ? '已完成' : `进行中 ${t.progress}%`}（${t.start_date || ''} ~ ${t.end_date || ''}）`);
      const block = lines.join('\n');
      const md = String(ed.content.markdown || '');
      const match = md.match(/^##+\s*(?:[一二三四五六七八九十]+、|\d+[.、]\s*)?本周进展.*$/m);
      let next;
      if (match) {
        const at = match.index + match[0].length;
        next = `${md.slice(0, at)}\n\n${block}${md.slice(at)}`;
      } else {
        next = `${md}${md.trim() ? '\n\n' : ''}## 本周进展\n\n${block}\n`;
      }
      setMarkdownValue(next);
      toast('已把本周计划任务写入正文');
      break;
    }
    case 'editor-comment':
      await submitEditorComment();
      break;
    case 'editor-reopen': {
      const ed = state.editor;
      if (ed && ed.item) {
        await api(`/api/deliverables/${ed.kind}/${ed.item.id}/reopen`, { method: 'POST' });
        state.editor = null;
        await render();
        toast('已撤回为草稿，可修改后重新提交');
      }
      break;
    }
    case 'dlv-back':
      if (state.editor?.dirty) await saveEditor(true);
      state.editor = null;
      navTo('#/deliverables');
      break;
    case 'dlv-open': {
      const projectId = Number(el.dataset.project);
      const project = state.dlvData?.projects.find((x) => x.id === projectId);
      if (!project) break;
      const mine = canEditProject(project);
      if (!project.item && mine) {
        state.editor = null;
        navTo(`#/write/${state.dlvData.kind}/${project.id}/${state.dlvData.period}`);
        break;
      }
      await openDeliverableModal(project, project.item, state.dlvData.kind, state.dlvData.period);
      break;
    }
    case 'dlv-kind':
      state.dlv.kind = el.dataset.value;
      render();
      break;
    case 'dlv-mine':
      state.dlv.onlyMine = !state.dlv.onlyMine;
      render();
      break;
    case 'dlv-plan-type':
      state.dlv.planType = el.dataset.value;
      state.dlv.plan = state.dlv.planType === 'quarter' ? state.data.workflow.quarter : today().slice(0, 7);
      render();
      break;
    case 'dlv-prev':
    case 'dlv-next': {
      const dir = action === 'dlv-prev' ? -1 : 1;
      if (state.dlv.kind === 'weekly') state.dlv.week = addDays(state.dlv.week, dir * 7);
      else if (state.dlv.planType === 'quarter') state.dlv.plan = shiftQuarter(state.dlv.plan, dir);
      else state.dlv.plan = shiftMonth(state.dlv.plan, dir);
      render();
      break;
    }
    case 'dlv-today':
      state.dlv.week = state.data.workflow.week;
      state.dlv.plan = state.data.workflow.quarter;
      state.dlv.planType = 'quarter';
      render();
      break;
    case 'dlv-save':
      await saveDeliverable(false);
      break;
    case 'dlv-submit':
      await saveDeliverable(true);
      break;
    case 'dlv-approve':
      await reviewDeliverable('approve');
      break;
    case 'dlv-reject':
      await reviewDeliverable('reject');
      break;
    case 'gantt-zoom':
      state.gantt.zoom = el.dataset.value;
      render();
      break;
    case 'gantt-stage':
      state.gantt.stage = el.dataset.value;
      render();
      break;
    case 'gantt-mine':
      state.gantt.onlyMine = !state.gantt.onlyMine;
      render();
      break;
    case 'gantt-deps':
      state.gantt.showDeps = !state.gantt.showDeps;
      render();
      break;
    case 'gantt-today':
      scrollGanttToToday();
      break;
    case 'process-stage':
      state.processStage = el.dataset.value;
      render();
      break;
    case 'charter-edit': {
      const w = state.workspace;
      if (w) openCharterModal(w.project, w.charter);
      break;
    }
    case 'charter-submit': {
      const w = state.workspace;
      if (!w) break;
      try {
        await api(`/api/projects/${w.project.id}/charter/submit`, { method: 'POST', body: {} });
        await reload();
        toast('章程已提交审批');
      } catch (err) { toast(err.message); }
      break;
    }
    case 'charter-approve': {
      const w = state.workspace;
      if (!w) break;
      try {
        await api(`/api/projects/${w.project.id}/charter/review`, { method: 'POST', body: { decision: 'approve', comment: '同意。' } });
        await reload();
        toast('章程已通过');
      } catch (err) { toast(err.message); }
      break;
    }
    case 'charter-reject': {
      const w = state.workspace;
      if (w) openCharterReject(w.project);
      break;
    }
    case 'change-new': {
      const w = state.workspace;
      if (w) openChangeModal(w.project);
      break;
    }
    case 'change-open': {
      const w = state.workspace;
      const c = w?.changes.find((x) => x.id === Number(el.dataset.id));
      if (c) openChangeReview(c);
      break;
    }
    case 'lesson-new': {
      const w = state.workspace;
      if (w) openLessonModal(w.project);
      break;
    }
    case 'dep-new':
      openDependencyModal(null);
      break;
    case 'dep-open': {
      const dep = (state.data.dependencies || []).find((d) => d.id === Number(el.dataset.id));
      if (dep) openDependencyModal(dep);
      break;
    }
    case 'gate-checks': {
      const g = state.data.gates.find((x) => x.id === Number(el.dataset.id));
      if (g) openGateChecklist(g);
      break;
    }
    case 'gate-open': {
      const gate = (state.data.gates || []).find((g) => g.id === Number(el.dataset.id));
      if (gate) openGateModal(gate);
      break;
    }
    case 'gate-new':
      openGateModal(null);
      break;
    case 'gate-filter':
      state.gateFilter = el.dataset.value;
      render();
      break;
    case 'admin-tab':
      state.adminTab = el.dataset.value;
      render();
      break;
    case 'template-reference':
      await openTemplateReference(el.dataset.category || 'plan');
      break;
    case 'calendar-new':
      openCalendarModal();
      break;
    case 'calendar-delete': {
      try {
        await api(`/api/calendar/${el.dataset.date}`, { method: 'DELETE' });
        await reload({ keepScroll: false });
        toast('日历设置已删除');
      } catch (err) { toast(err.message, 'err'); }
      break;
    }
    case 'help-article-new':
      openHelpArticleModal(null);
      break;
    case 'help-article-edit': {
      const a = (state.helpArticles || []).find((x) => x.id === Number(el.dataset.id));
      if (a) openHelpArticleModal(a);
      break;
    }
    case 'program-new':
      openProgramModal(null);
      break;
    case 'program-edit': {
      const p = (state.programs || []).find((x) => x.id === Number(el.dataset.id));
      if (p) openProgramModal(p);
      break;
    }
    case 'template-new':
      openTemplateModal(null);
      break;
    case 'template-edit': {
      const t = (state.templates || []).find((x) => x.id === Number(el.dataset.id));
      if (t) openTemplateModal(t);
      break;
    }
    case 'vendor-new':
      openVendorModal(null);
      break;
    case 'vendor-edit': {
      const v = (state.vendors || state.data.vendors || []).find((x) => x.id === Number(el.dataset.id));
      if (v) openVendorModal(v);
      break;
    }
    case 'admin-user-new':
      openUserModal(null);
      break;
    case 'admin-user-reset': {
      const u = state.adminUsers?.find((x) => x.id === Number(el.dataset.id));
      if (u) openResetPassword(u);
      break;
    }
    case 'admin-user-logout': {
      const u = state.adminUsers?.find((x) => x.id === Number(el.dataset.id));
      if (u) confirmForceLogout(u);
      break;
    }
    case 'admin-user-delete': {
      const u = state.adminUsers?.find((x) => x.id === Number(el.dataset.id));
      if (u) confirmDeleteUser(u);
      break;
    }
    case 'admin-user-edit': {
      const data = await api('/api/admin/users');
      const u = data.users.find((x) => x.id === Number(el.dataset.id));
      if (u) openUserModal(u);
      break;
    }
    case 'admin-user-save':
      await saveUser(Number(el.dataset.id) || null);
      break;
    case 'dlv-reopen': {
      const ctx = state.dlvModal;
      if (ctx && ctx.item) {
        await api(`/api/deliverables/${ctx.kind}/${ctx.item.id}/reopen`, { method: 'POST' });
        closeModal();
        await reload();
        toast('已撤回为草稿，需项目组修改后重新提交');
      }
      break;
    }
    case 'new-alloc':
      allocForm(null, id);
      break;
    case 'edit-alloc': {
      const a = state.data.allocations.find((x) => x.id === id);
      if (a) allocForm(a, a.project_id);
      break;
    }
    case 'modal-delete':
      if (modalDeleteHandler) {
        await modalDeleteHandler();
        closeModal();
      }
      break;
    case 'risk-cell': {
      const p = Number(el.dataset.p);
      const i = Number(el.dataset.i);
      const cur = state.filters.riskCell;
      state.filters.riskCell = cur && cur.p === p && cur.i === i ? null : { p, i };
      render();
      break;
    }
    case 'risk-cell-clear':
      state.filters.riskCell = null;
      render();
      break;
    case 'overview-ai-run':
      await runOverviewAI(el.dataset.mode || 'summary');
      break;
    case 'overview-ai-ask': {
      const q = String(document.getElementById('overview-ai-question')?.value || '').trim();
      if (!q) { toast('先写一个问题', 'err'); break; }
      await runOverviewAI('ask', q);
      break;
    }
    case 'overview-ai-open':
      window.location.hash = `#/projects/${el.dataset.id}/ai`;
      break;
    case 'report-copy': {
      const text = state.reportSnapshot?.markdown || state.report?.markdown || '';
      try {
        await navigator.clipboard.writeText(text);
        toast('周报 Markdown 已复制');
      } catch {
        toast('浏览器拒绝了剪贴板访问，请改用下载', 'err');
      }
      break;
    }
    case 'report-download': {
      const snap = state.reportSnapshot;
      if (snap?.markdown) {
        const blob = new Blob([snap.markdown], { type: 'text/markdown;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `pmo-weekly-${snap.week_start || snap.coverage?.weekStart || 'snapshot'}.md`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      } else {
        window.location.href = '/api/report.md';
      }
      break;
    }
    case 'report-snapshot':
      try {
        const r = await api('/api/report/snapshot', { method: 'POST' });
        state.report = null;
        state.reportSnapshot = null;
        await render();
        toast(`本周快照已更新${r.warnings?.length ? `，有 ${r.warnings.length} 项缺口` : ''}`);
      } catch (e) { toast(e.message, 'err'); }
      break;
    case 'report-history-open':
      try {
        state.reportSnapshot = await api(`/api/report/history/${el.dataset.id}`);
        await render();
        window.scrollTo(0, 0);
      } catch (e) { toast(e.message, 'err'); }
      break;
    case 'report-history-back':
      state.reportSnapshot = null;
      state.report = null;
      await render();
      window.scrollTo(0, 0);
      break;
    case 'report-print':
      window.print();
      break;
    case 'report-tab':
      state.reportTab = el.dataset.value;
      render();
      break;
    case 'plan-prev':
      state.planPeriod = shiftQuarter(state.planPeriod || state.data.workflow.quarter, -1);
      state.programPlan = null;
      render();
      break;
    case 'plan-next':
      state.planPeriod = shiftQuarter(state.planPeriod || state.data.workflow.quarter, 1);
      state.programPlan = null;
      render();
      break;
    case 'plan-sec': {
      const target = document.getElementById(`plan-sec-${el.dataset.idx}`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    }
    case 'plan-copy': {
      try {
        await navigator.clipboard.writeText(state.programPlan?.markdown || '');
        toast('计划 Markdown 已复制');
      } catch {
        toast('浏览器拒绝了剪贴板访问，请改用下载', 'err');
      }
      break;
    }
    case 'plan-download':
      window.location.href = `/api/program-plan.md?period=${encodeURIComponent(state.planPeriod || state.data.workflow.quarter)}`;
      break;
    case 'plan-print':
      window.print();
      break;
    case 'scroll-sec': {
      const target = document.getElementById(`sec-${el.dataset.idx}`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    }
    case 'import': {
      const input = $('#import-file');
      if (input) input.click();
      break;
    }
    case 'clear-demo': {
      openModal({
        title: '清空业务数据',
        sub: '将删除全部项目、周报、计划、关口、风险、依赖、章程、变更、经验教训以及其他账号，只保留当前管理员。此操作不可撤销，建议先导出备份。',
        submit: '确认清空',
        fields: [
          { name: 'confirm', label: '确认口令', required: true, placeholder: '输入“清空”两个字' },
        ],
        onSubmit: async (v) => {
          if (v.confirm.trim() !== '清空') throw new Error('请输入“清空”两个字');
          const r = await api('/api/admin/clear-demo', { method: 'POST', body: { confirm: '清空' } });
          await reload({ keepScroll: false });
          location.hash = '#/overview';
          toast(r.message || '已清空');
        },
      });
      break;
    }
    case 'reset': {
      openModal({
        title: '重置为演示数据',
        sub: '当前全部项目、里程碑、风险与更新将被删除，并重新写入 9 个示例项目。此操作不可撤销。',
        submit: '确认重置',
        fields: [],
        onSubmit: async () => {
          await api('/api/reset', { method: 'POST' });
          await reload({ keepScroll: false });
          state.report = null;
          toast('已重置为演示数据');
        },
      });
      break;
    }
    case 'password':
      openPasswordModal();
      break;
    case 'logout':
      await fetch('/api/auth/logout', { method: 'POST' });
      state.me = null;
      state.data = null;
      state.report = null;
      state.dlvData = null;
      state.programPlan = null;
      state.dlv.onlyMine = null;
      renderLogin();
      break;
    case 'demo-login':
      await doLogin(el.dataset.user, el.dataset.user === 'pmo' ? 'pmo123456' : 'pm123456');
      break;
    case 'modal-close':
      closeModal();
      break;
    case 'modal-backdrop':
      if (el === document.querySelector('.modal-backdrop')) closeModal();
      break;
    default:
      break;
  }
}

/* --------------------------------------------------------------- events --- */

document.addEventListener('click', (e) => {
  const fn = e.target.closest('[data-md-footnote]');
  if (!fn) return;
  e.preventDefault();
  const target = document.getElementById(fn.dataset.mdFootnote);
  if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
}, true);

document.addEventListener('click', async (e) => {
  const actionEl = e.target.closest('[data-action]');
  if (actionEl) {
    const action = actionEl.dataset.action;
    if (action === 'modal-backdrop' && e.target !== actionEl) return;
    e.preventDefault();
    try {
      await handleAction(action, actionEl);
    } catch (err) {
      toast(err.message || '操作失败', 'err');
    }
    return;
  }

  const link = e.target.closest('[data-href]');
  if (link) {
    navTo(link.dataset.href);
    return;
  }

  const filter = e.target.closest('[data-filter]');
  if (filter) {
    state.filters[filter.dataset.filter] = filter.dataset.value;
    render();
  }
});

document.addEventListener('input', (e) => {
  const editorField = e.target.closest('[data-editor-field]');
  if (editorField && state.editor) {
    const key = editorField.dataset.editorField;
    state.editor.content[key] = editorField.type === 'number' ? Number(editorField.value) : editorField.value;
    if (key === 'markdown') {
      const preview = document.getElementById('md-preview');
      if (preview) preview.innerHTML = renderMarkdown(editorField.value);
      const count = document.getElementById('md-count');
      if (count) count.textContent = markdownCount(editorField.value);
    }
    updateEditorChecklist();
    markEditorDirty();
    return;
  }
  if (e.target.id === 'proj-search') {
    state.filters.q = e.target.value;
    const body = $('#proj-body');
    if (body) body.innerHTML = projectRows();
    updateProjCount();
  }
  if (e.target.id === 'user-search') {
    state.userFilters.q = e.target.value;
    refreshAdminUserRows();
  }
  if (e.target.id === 'help-search') {
    if (helpSearchComposing) return;
    state.help.q = e.target.value.trim();
    if (helpSearchTimer) clearTimeout(helpSearchTimer);
    helpSearchTimer = setTimeout(async () => {
      helpSearchTimer = null;
      if (state.route !== 'help' || state.help.tab !== 'kb') return;
      await render();
      focusHelpSearch();
    }, 420);
  }
  if (e.target.id === 'kb-search') {
    if (projectKBSearchComposing) return;
    state.projectKBFilter.q = e.target.value.trim();
    if (projectKBSearchTimer) clearTimeout(projectKBSearchTimer);
    projectKBSearchTimer = setTimeout(async () => {
      projectKBSearchTimer = null;
      if (state.route !== 'project' || state.params.tab !== 'kb') return;
      await render();
      focusProjectKBSearch();
    }, 420);
  }
});

document.addEventListener('compositionstart', (e) => {
  if (e.target.id === 'help-search') helpSearchComposing = true;
  if (e.target.id === 'kb-search') projectKBSearchComposing = true;
});
document.addEventListener('compositionend', (e) => {
  if (e.target.id === 'help-search') {
    helpSearchComposing = false;
    state.help.q = e.target.value.trim();
    if (helpSearchTimer) clearTimeout(helpSearchTimer);
    helpSearchTimer = setTimeout(async () => {
      helpSearchTimer = null;
      if (state.route !== 'help' || state.help.tab !== 'kb') return;
      await render();
      focusHelpSearch();
    }, 80);
  }
  if (e.target.id === 'kb-search') {
    projectKBSearchComposing = false;
    state.projectKBFilter.q = e.target.value.trim();
    if (projectKBSearchTimer) clearTimeout(projectKBSearchTimer);
    projectKBSearchTimer = setTimeout(async () => {
      projectKBSearchTimer = null;
      if (state.route !== 'project' || state.params.tab !== 'kb') return;
      await render();
      focusProjectKBSearch();
    }, 80);
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'uf-role') {
    const party = document.getElementById('uf-party');
    if (party) {
      if (e.target.value === 'client_member') party.value = '甲方';
      if (e.target.value === 'vendor_member') party.value = '乙方';
    }
    return;
  }
  if (e.target.id === 'overview-ai-project') {
    const box = document.getElementById('overview-ai-result');
    if (box) box.innerHTML = '<p class="md-empty">选一个动作用这个项目生成，或直接输入问题。</p>';
    return;
  }
  if (e.target.id === 'meeting-room-filter') {
    state.meeting.roomId = e.target.value || 'all';
    await render();
    return;
  }
  if (e.target.id === 'global-ai-scope') {
    state.aiGlobal.scope = e.target.value || 'all';
    state.aiGlobal.messages = [];
    await render();
    return;
  }
  if (e.target.id === 'program-select') {
    state.programId = Number(e.target.value) || null;
    try { localStorage.setItem('pmo.program', String(state.programId || '')); } catch { /* ignore */ }
    await reload({ keepScroll: false });
    return;
  }
  if (e.target.id === 'plan-import-file') {
    const file = e.target.files?.[0];
    const projectId = Number(e.target.dataset.id);
    e.target.value = '';
    if (!file || !projectId) return;
    try {
      const text = await file.text();
      const isXml = /\.xml$/i.test(file.name);
      const replace = window.confirm(`导入方式：确定 = 替换全部现有任务；取消 = 追加到现有计划。\n文件：${file.name}`);
      const plan = await api(`/api/projects/${projectId}/plan/${isXml ? 'import.xml' : 'import'}`, {
        method: 'POST', body: isXml ? { xml: text, mode: replace ? 'replace' : 'append' } : { csv: text, mode: replace ? 'replace' : 'append' },
      });
      state.projectPlan = plan;
      await reload({ keepScroll: false });
      toast(replace ? '计划已替换导入' : '计划已追加导入');
    } catch (err) {
      toast(err.message, 'err');
    }
    return;
  }
  if (e.target.dataset?.userFilter) {
    state.userFilters[e.target.dataset.userFilter] = e.target.value;
    refreshAdminUserRows();
    return;
  }
  if (e.target.id === 'import-file') {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await api('/api/import', { method: 'POST', body: data });
      await reload({ keepScroll: false });
      toast('备份已导入');
    } catch (err) {
      toast(err.message || '导入失败', 'err');
    }
    e.target.value = '';
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.editor?.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (modalCloser) closeModal();
  }
  if (e.key === 'Enter' && e.target?.id === 'help-search' && !e.isComposing) {
    e.preventDefault();
    if (helpSearchTimer) { clearTimeout(helpSearchTimer); helpSearchTimer = null; }
    document.querySelector('[data-action="help-search"]')?.click();
  }
  if (e.key === 'Enter' && e.target?.id === 'kb-search' && !e.isComposing) {
    e.preventDefault();
    if (projectKBSearchTimer) { clearTimeout(projectKBSearchTimer); projectKBSearchTimer = null; }
    document.querySelector('[data-action="kb-search"]')?.click();
  }
});

window.addEventListener('hashchange', async () => {
  if (state.editor?.dirty) await saveEditor(true);
  if (state.editor?.timer) clearTimeout(state.editor.timer);
  state.editor = null;
  const r = parseRoute();
  state.route = r.route;
  state.params = r.params;
  if (r.route !== 'report') state.reportSnapshot = null;
  window.scrollTo(0, 0);
  await render();
});

/* ---------------------------------------------------------------- boot --- */

function renderLogin(message = '') {
  document.body.classList.add('is-login');
  state.data = null;
  state.dlvData = null;
  $('#rail-user').innerHTML = '';
  $('#view').innerHTML = `
    <div class="login">
      <section class="login-brand">
        <div class="login-mark">P</div>
        <div class="login-kicker">PROGRAM CONTROL OFFICE</div>
        <h1>项目群<br><em>控制台</em></h1>
        <p class="login-lede">项目团队在这里维护计划、提交周报；PMO 在这里审核确认，并自动汇总成项目群层面的周报与计划。</p>
        <div class="login-steps">
          <div><span>01</span><b>项目填报</b><i>计划 · 周报 · 风险 · 进度</i></div>
          <div><span>02</span><b>PMO 审核</b><i>通过 / 退回 / 留痕</i></div>
          <div><span>03</span><b>自动汇总</b><i>项目群周报 · 工作计划</i></div>
        </div>
        <div class="login-foot">本地部署 · 数据不出内网 · 全部操作留痕</div>
      </section>

      <section class="login-panel">
        <form id="login-form">
          <div class="login-title">登录</div>
          <p class="login-sub">不同角色进入各自的工作界面。</p>
          <div class="field">
            <label for="login-username">账号</label>
            <input id="login-username" name="username" autocomplete="username" placeholder="请输入账号" required />
          </div>
          <div class="field">
            <label for="login-password">密码</label>
            <input id="login-password" name="password" type="password" autocomplete="current-password" placeholder="请输入密码" required />
          </div>
          <div class="login-error" id="login-error">${esc(message)}</div>
          <button class="btn btn--solid login-submit" type="submit">进入控制台 ${ICONS.arrow}</button>
        </form>

        <div class="login-demo">
          <span class="mini-label">演示账号 · 一键登录</span>
          <div class="login-demo-grid">
            <button type="button" data-action="demo-login" data-user="pmo"><b>PMO 管理员</b><i>查看全部项目并审核</i></button>
            <button type="button" data-action="demo-login" data-user="zhangwei"><b>张伟 · 乙方项目经理</b><i>负责核心业务中台重构</i></button>
            <button type="button" data-action="demo-login" data-user="hejing"><b>何静 · 甲方项目经理</b><i>中台项目的业主侧负责人</i></button>
          </div>
        </div>
        <p class="login-hint">pmo / pmo123456　·　甲方 / 乙方项目经理 / pm123456</p>
      </section>
    </div>`;
  setTimeout(() => $('#login-username')?.focus(), 80);
}

async function doLogin(username, password) {
  if (state.loginBusy) return;
  state.loginBusy = true;
  const err = $('#login-error');
  if (err) err.textContent = '';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const j = await res.json();
    if (!res.ok) {
      if (err) err.textContent = j.error || '登录失败';
      return;
    }
    state.me = j.user;
    state.dlv.onlyMine = null;
    document.body.classList.remove('is-login');
    await reload({ keepScroll: false });
    const r = parseRoute();
    state.route = r.route === 'overview' ? 'overview' : r.route;
    state.params = r.params;
    await render();
    toast(`已登录：${j.user.name}`);
  } catch (e) {
    if (err) err.textContent = e.message || '无法连接服务端';
  } finally {
    state.loginBusy = false;
  }
}

async function boot() {
  try {
    const res = await fetch('/api/me');
    if (res.status === 401) {
      renderLogin();
      return;
    }
    const j = await res.json();
    state.me = j.user;
    state.dlv.onlyMine = null;
    document.body.classList.remove('is-login');
    await reload({ keepScroll: false });
    const r = parseRoute();
    state.route = r.route;
    state.params = r.params;
    await render();
  } catch (err) {
    $('#view').innerHTML = `<div class="empty" style="padding:100px 0">无法连接服务端：${esc(err.message)}<br><br>请确认已执行 <span class="kbd">node server.js</span></div>`;
  }
}

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'login-form') return;
  e.preventDefault();
  const fd = new FormData(e.target);
  await doLogin(String(fd.get('username') || '').trim(), String(fd.get('password') || ''));
});

document.addEventListener('keydown', (e) => {
  if (e.target?.id === 'ef-markdown' && (e.metaKey || e.ctrlKey)) {
    const key = e.key.toLowerCase();
    if (['b', 'i', 'k'].includes(key)) {
      e.preventDefault();
      insertMarkdown(key === 'b' ? 'bold' : key === 'i' ? 'italic' : 'link');
      return;
    }
  }
  if (e.target?.id === 'ef-markdown' && e.key === 'Tab') {
    e.preventDefault();
    const ta = e.target;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = `${ta.value.slice(0, start)}  ${ta.value.slice(end)}`;
    ta.setSelectionRange(start + 2, start + 2);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  if (e.key === 'Escape') {
    const box = document.getElementById('md-editor');
    if (box?.classList.contains('is-fullscreen')) {
      box.classList.remove('is-fullscreen');
      const btn = box.querySelector('[data-action="md-fullscreen"]');
      if (btn) { btn.textContent = '全屏'; btn.setAttribute('aria-label', '全屏编辑'); }
    }
  }
  if (e.target?.id === 'help-question' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    document.querySelector('[data-action="help-ask"]')?.click();
  }
  if (e.target?.id === 'global-ai-question' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    document.querySelector('[data-action="global-ai-ask"]')?.click();
  }
});

initRail();
boot();
