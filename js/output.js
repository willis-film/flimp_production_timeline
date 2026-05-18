// ── output.js ─────────────────────────────────────────────────────────────
// All output format renderers.
// Formats 1 + 2: editable HTML email tables (chronological and weekly).
// Formats 3 + 4: PDF exports (to be built).
// ─────────────────────────────────────────────────────────────────────────

import { esc, fmtDateShort, toISO } from './engine.js';
import { saveTimelineToDb } from './database.js';

// ── Shared email table styles (Verdana, email-safe, max 550px) ────────────
const E = {
  table:   'width:100%;max-width:550px;border-collapse:collapse;font-family:Verdana,sans-serif;font-size:0.72rem;',
  title:   'padding:0.5rem 0.75rem 0.5rem 0;font-family:Verdana,sans-serif;font-size:0.85rem;font-weight:600;border-bottom:1px solid #ccc;',
  thFirst: 'text-align:left;padding:0.35rem 0.75rem 0.35rem 0;font-size:0.6rem;letter-spacing:0.1em;text-transform:uppercase;border-bottom:2px solid #000;width:18%;font-family:Verdana,sans-serif;',
  th:      'text-align:left;padding:0.35rem 0.75rem;font-size:0.6rem;letter-spacing:0.1em;text-transform:uppercase;border-bottom:2px solid #000;font-family:Verdana,sans-serif;',
  thDel:   'text-align:left;padding:0.35rem 0.75rem;font-size:0.6rem;letter-spacing:0.1em;text-transform:uppercase;border-bottom:2px solid #000;width:12%;font-family:Verdana,sans-serif;',
  thTask:  'text-align:left;padding:0.35rem 0.75rem;font-size:0.6rem;letter-spacing:0.1em;text-transform:uppercase;border-bottom:2px solid #000;width:40%;font-family:Verdana,sans-serif;',
  thLast:  'text-align:left;padding:0.35rem 0 0.35rem 0.5rem;font-size:0.6rem;letter-spacing:0.1em;text-transform:uppercase;border-bottom:2px solid #000;width:10%;font-family:Verdana,sans-serif;',
  tdFirst: 'padding:0.3rem 0.75rem 0.3rem 0;border-bottom:1px solid #ccc;font-size:0.72rem;font-family:Verdana,sans-serif;',
  td:      'padding:0.3rem 0.75rem;border-bottom:1px solid #ccc;font-size:0.68rem;font-family:Verdana,sans-serif;',
  tdTask:  'padding:0.3rem 0.75rem;border-bottom:1px solid #ccc;font-size:0.72rem;font-family:Verdana,sans-serif;max-width:180px;',
  tdDate:  'padding:0.3rem 0 0.3rem 0.5rem;border-bottom:1px solid #ccc;font-size:0.72rem;font-family:Verdana,sans-serif;white-space:nowrap;',
  footer:  'padding:0.6rem 0.75rem 0.4rem 0;border-top:2px solid #000;font-size:0.68rem;letter-spacing:0.04em;font-family:Verdana,sans-serif;font-weight:bold;',
  weekHdr: 'padding:0.45rem 0.75rem 0.45rem 0;font-size:0.65rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;border-bottom:1px solid #ccc;border-top:2px solid #000;font-family:Verdana,sans-serif;color:#333;background:#f5f5f5;',
};

// ── Shared header rows ────────────────────────────────────────────────────
function buildTableHeader(project) {
  return `
    <tr>
      <td colspan="4" contenteditable="true" style="${E.title}">${esc(project)}</td>
    </tr>
    <tr>
      <th style="${E.thFirst}">Party</th>
      <th style="${E.thDel}">Deliverable</th>
      <th style="${E.thTask}">Task</th>
      <th style="${E.thLast}">Due Date</th>
    </tr>`;
}

// ── Single data row ───────────────────────────────────────────────────────
function buildDataRow(party, deliverable, task, date, isPastDue) {
  const rowBg   = isPastDue ? 'background:#fff0f0;' : '';
  const dateFmt = isPastDue ? `${E.tdDate}color:#c00;` : E.tdDate;
  return `
    <tr style="${rowBg}">
      <td contenteditable="true" style="${E.tdFirst}">${esc(party)}</td>
      <td contenteditable="true" style="${E.td}">${esc(deliverable)}</td>
      <td contenteditable="true" style="${E.tdTask}">${esc(task)}</td>
      <td contenteditable="true" style="${dateFmt}">${esc(date)}</td>
    </tr>`;
}

// ── Footer summary row ────────────────────────────────────────────────────
function buildFooterRow(startDate, projectSpanDays, dueDate, projectEndDate) {
  const parts = [
    `Project Start: ${fmtDateShort(startDate)}`,
    `Working Days: ${projectSpanDays}`,
    dueDate ? `Due Date: ${fmtDateShort(dueDate)}` : null,
    `Projected End: ${fmtDateShort(projectEndDate)}`
  ].filter(Boolean).join('\u00a0\u00a0\u00b7\u00a0\u00a0');

  return `
    <tr>
      <td colspan="4" contenteditable="true" style="${E.footer}">${parts}</td>
    </tr>`;
}

// ── Build chronological table HTML ────────────────────────────────────────
function buildChronTable({ milestoneGroups, projectEndDate, projectSpanDays, startDate, dueDate, project }) {
  let rows = buildTableHeader(project);

  milestoneGroups.forEach(group => {
    const dels  = [...new Set(group.items.map(m => m.deliverable))].join(', ');
    const tasks = [...new Set(group.items.map(m => m.task))].join(', ');
    rows += buildDataRow(group.owner, dels, tasks, fmtDateShort(group.date), group.isPastDue);
  });

  rows += buildFooterRow(startDate, projectSpanDays, dueDate, projectEndDate);
  return `<table style="${E.table}"><tbody>${rows}</tbody></table>`;
}

// ── Build weekly table HTML ───────────────────────────────────────────────
function buildWeeklyTable({ milestoneGroups, projectEndDate, projectSpanDays, startDate, dueDate, project }) {
  // Get Monday of the week containing a date
  function weekStart(date) {
    const d   = new Date(date);
    const dow = d.getDay();
    d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // Bucket milestones by week, preserving order
  const weekMap = new Map();
  milestoneGroups.forEach(group => {
    const ws  = weekStart(group.date);
    const key = toISO(ws);
    if (!weekMap.has(key)) weekMap.set(key, { weekDate: ws, groups: [] });
    weekMap.get(key).groups.push(group);
  });

  let rows = buildTableHeader(project);

  weekMap.forEach(({ weekDate, groups }) => {
    // Week header spanning all columns
    const weekEnd = new Date(weekDate);
    weekEnd.setDate(weekEnd.getDate() + 4); // Friday
    const weekLabel = `Week of ${fmtDateShort(weekDate)} – ${fmtDateShort(weekEnd)}`;
    rows += `<tr><td colspan="4" style="${E.weekHdr}">${weekLabel}</td></tr>`;

    // Within the week, group tasks by deliverable + owner so related items batch together
    const byKey = new Map();
    groups.forEach(group => {
      group.items.forEach(item => {
        const key = `${item.deliverable}||${group.owner}`;
        if (!byKey.has(key)) byKey.set(key, {
          deliverable: item.deliverable,
          owner:       group.owner,
          tasks:       [],
          date:        group.date,
          isPastDue:   group.isPastDue
        });
        byKey.get(key).tasks.push(item.task);
        // Use the latest date within the group
        if (group.date > byKey.get(key).date) byKey.get(key).date = group.date;
      });
    });

    byKey.forEach(({ deliverable, owner, tasks, date, isPastDue }) => {
      rows += buildDataRow(owner, deliverable, tasks.join(', '), fmtDateShort(date), isPastDue);
    });
  });

  rows += buildFooterRow(startDate, projectSpanDays, dueDate, projectEndDate);
  return `<table style="${E.table}"><tbody>${rows}</tbody></table>`;
}

// ── Build by-product table HTML ───────────────────────────────────────────
// Each deliverable gets its own section header, then its phases in order
// with the actual computed end date pulled from milestoneGroups.
function buildByProductTable({ phasesPerDeliverable, deliverables, milestoneGroups, projectEndDate, projectSpanDays, startDate, dueDate, project }) {
  const sectionHdr = (label) =>
    `<tr><td colspan="3" style="${E.weekHdr}">${esc(label)}</td></tr>`;

  const thRow = `
    <tr>
      <th style="${E.thFirst}">Owner</th>
      <th style="text-align:left;padding:0.35rem 0.75rem;font-size:0.6rem;letter-spacing:0.1em;text-transform:uppercase;border-bottom:2px solid #000;width:50%;font-family:Verdana,sans-serif;">Phase</th>
      <th style="${E.thLast}">Due Date</th>
    </tr>`;

  // Build a lookup: deliverable name + task name → date
  // (milestoneGroups items carry both)
  const dateByKey = new Map();
  milestoneGroups.forEach(group => {
    group.items.forEach(item => {
      dateByKey.set(`${item.deliverable}||${item.task}`, { date: group.date, isPastDue: group.isPastDue });
    });
  });

  let rows = `<tr><td colspan="3" contenteditable="true" style="${E.title}">${esc(project)}</td></tr>`;

  deliverables.forEach((del, idx) => {
    const phases = phasesPerDeliverable[idx] || [];
    if (!phases.length) return;

    const label = `${del.product}${del.isRenewal ? ' — Renewal' : ' — New'}`;
    rows += sectionHdr(label);
    rows += thRow;

    phases.forEach(phase => {
      const key    = `${del.product}||${phase.name}`;
      const entry  = dateByKey.get(key);
      const dateStr = entry ? fmtDateShort(entry.date) : '—';
      const dateSty = entry?.isPastDue ? `${E.tdDate}color:#c00;` : E.tdDate;
      const rowBg   = entry?.isPastDue ? 'background:#fff0f0;' : '';
      rows += `
        <tr style="${rowBg}">
          <td contenteditable="true" style="${E.tdFirst}">${esc(phase.owner)}</td>
          <td contenteditable="true" style="${E.tdTask}">${esc(phase.name)}</td>
          <td contenteditable="true" style="${dateSty}">${esc(dateStr)}</td>
        </tr>`;
    });
  });

  rows += buildFooterRow(startDate, projectSpanDays, dueDate, projectEndDate);
  return `<table style="${E.table}"><tbody>${rows}</tbody></table>`;
}

// ── Main render entry point ───────────────────────────────────────────────
export function renderTimelineTable(data) {
  const output = document.getElementById('timelineOutput');
  document.getElementById('outputDivider').style.display = 'block';
  output.style.display = 'block';

  // Render all three email tables
  document.getElementById('chronTableWrap').innerHTML     = buildChronTable(data);
  document.getElementById('weeklyTableWrap').innerHTML    = buildWeeklyTable(data);
  document.getElementById('byProductTableWrap').innerHTML = buildByProductTable(data);

  // Reset to chronological tab on each generate
  switchTab('chron');

  output.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Tab switcher ──────────────────────────────────────────────────────────
export function switchTab(tab) {
  const tabs = ['chron', 'weekly', 'byProduct', 'basicPdf', 'expandedPdf', 'netNewPdf'];
  tabs.forEach(t => {
    const panel = document.getElementById(`panel${t.charAt(0).toUpperCase() + t.slice(1)}`);
    const btn   = document.getElementById(`tab${t.charAt(0).toUpperCase() + t.slice(1)}`);
    if (panel) panel.style.display = t === tab ? 'block' : 'none';
    if (btn)   btn.classList.toggle('active', t === tab);
  });
}

// ── PDF logo placeholder ──────────────────────────────────────────────────
// Replace the content of FLIMP_LOGO_SVG with your actual SVG markup.
// Paste everything between (and including) the <svg ...> and </svg> tags.
const FLIMP_LOGO_SVG = `
  <!-- PASTE FLIMP LOGO SVG HERE -->
  <svg viewBox="0 0 120 32" xmlns="http://www.w3.org/2000/svg" style="height:28px;width:auto">
    <text x="0" y="24" font-family="Calibri,sans-serif" font-size="28" font-weight="700" fill="#67E74E">flimp</text>
  </svg>`;

// ── PDF shared design tokens ──────────────────────────────────────────────
const PDF = {
  dark:       '#08212D',
  lime:       '#67E74E',
  text:       '#08212D',
  textLight:  '#3d5a68',
  textMuted:  '#7a96a3',
  border:     '#dde3ec',
  borderDark: '#08212D',
  warm:       '#FEFBF5',
  red:        '#D83A31',
  font:       'Verdana, Geneva, sans-serif',
  pageW:      '816px',   // letter at 96dpi
  pageH:      '1056px',
  margin:     '48px',
};

// ── PDF page wrapper ──────────────────────────────────────────────────────
function pdfPage(content, pageNum, totalPages) {
  return `
    <div style="
      width:${PDF.pageW};
      min-height:${PDF.pageH};
      background:#fff;
      font-family:${PDF.font};
      color:${PDF.text};
      position:relative;
      page-break-after:always;
      box-sizing:border-box;
    ">
      ${content}
      <div style="
        position:absolute;
        bottom:24px;
        left:${PDF.margin};
        right:${PDF.margin};
        display:flex;
        justify-content:space-between;
        align-items:center;
        border-top:1px solid ${PDF.border};
        padding-top:10px;
        font-size:9px;
        color:${PDF.textMuted};
        font-family:${PDF.font};
      ">
        <span>Prepared by Flimp Communications · ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
        <span>Page ${pageNum} of ${totalPages}</span>
      </div>
    </div>`;
}

// ── PDF hero section — dark band + overlapping summary card ──────────────
// Mirrors the Flimp Canvas reference layout: full-bleed dark header with
// a white rounded card overlapping it from below, containing project stats.
function pdfHero(client, project, startDate, dueDate, projectSpanDays, projectEndDate, deliverables) {
  const stats = [
    ['Project Start',  fmtDateShort(startDate)],
    ['Working Days',   String(projectSpanDays)],
    ['Projected End',  fmtDateShort(projectEndDate)],
    dueDate ? ['Due Date', fmtDateShort(dueDate)] : null,
    ['Deliverables',   String(deliverables.reduce((a, d) => a + d.count, 0))],
  ].filter(Boolean);

  const statCell = ([label, value]) => `
    <div style="flex:1;padding:16px 16px;border-right:1px solid ${PDF.border};min-width:0">
      <div style="font-size:7px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:${PDF.textMuted};margin-bottom:6px;font-family:${PDF.font}">${label}</div>
      <div style="font-size:13px;font-weight:700;color:${PDF.text};font-family:${PDF.font};line-height:1;white-space:nowrap">${value}</div>
    </div>`;

  return `
    <!-- Dark hero band -->
    <div style="
      position:relative;
      background:${PDF.dark};
      height:140px;
      padding:24px ${PDF.margin} 0;
      box-sizing:border-box;
      display:flex;
      justify-content:space-between;
      align-items:flex-start;
      -webkit-print-color-adjust:exact;
      print-color-adjust:exact;
    ">
      <!-- Client + project left -->
      <div style="text-align:left">
        <div style="font-size:20px;font-weight:700;color:#fff;line-height:1.2;font-family:${PDF.font}">${esc(client)}</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-top:4px;font-family:${PDF.font}">${esc(project)}</div>
      </div>

      <!-- Logo right -->
      <div style="display:flex;align-items:center;padding-top:4px">
        ${FLIMP_LOGO_SVG}
      </div>
    </div>

    <!-- Summary card overlapping the dark band — all stats in one row -->
    <div style="
      margin:-40px ${PDF.margin} 28px;
      background:#fff;
      border-radius:10px;
      box-shadow:0 4px 20px rgba(0,0,0,0.15);
      position:relative;
      z-index:1;
      border:1px solid ${PDF.border};
    ">
      <!-- Grommets — one in each corner -->
      <div style="position:absolute;top:5px;left:5px;width:5px;height:5px;border-radius:50%;background:#888888;z-index:2"></div>
      <div style="position:absolute;top:5px;right:5px;width:5px;height:5px;border-radius:50%;background:#888888;z-index:2"></div>
      <div style="position:absolute;bottom:5px;left:5px;width:5px;height:5px;border-radius:50%;background:#888888;z-index:2"></div>
      <div style="position:absolute;bottom:5px;right:5px;width:5px;height:5px;border-radius:50%;background:#888888;z-index:2"></div>
      <div style="display:flex;border-radius:10px;overflow:hidden">
        ${stats.map(statCell).join('')}
      </div>
    </div>`;
}
function pdfSection(title) {
  return `
    <div style="
      display:block;
      background:${PDF.dark};
      color:#fff;
      font-size:8px;
      font-weight:700;
      letter-spacing:0.1em;
      text-transform:uppercase;
      padding:7px 14px;
      border-radius:6px;
      margin-bottom:12px;
      font-family:${PDF.font};
      -webkit-print-color-adjust:exact;
      print-color-adjust:exact;
    ">${title}</div>`;
}

// ── Build Basic PDF HTML ──────────────────────────────────────────────────
function buildBasicPdf(data) {
  const { milestoneGroups, projectEndDate, projectSpanDays, deliverables,
          phasesPerDeliverable, startDate, dueDate, project, client } = data;

  const hasMilestones = milestoneGroups.some(g => g.items.some(m => m.isMilestone));

  const pageContent = `
    ${pdfHero(client, project, startDate, dueDate, projectSpanDays, projectEndDate, deliverables)}

    <div style="padding:0 ${PDF.margin} 80px">

      ${hasMilestones ? `
        <div style="margin-bottom:28px">
          ${pdfSection('Key Milestones')}
          <div style="padding-top:8px">
            ${pdfMilestoneTable(milestoneGroups, dueDate)}
          </div>
        </div>` : ''}

      <div>
        ${pdfSection('Phases by Deliverable')}
        <div style="padding-top:12px">
          ${pdfPhasesByProduct(deliverables, phasesPerDeliverable, milestoneGroups)}
        </div>
      </div>

    </div>`;

  return pdfPage(pageContent, 1, 1);
}
function pdfMilestoneTable(milestoneGroups, dueDate) {
  const milestones = milestoneGroups.filter(g => g.items.some(m => m.isMilestone));

  if (!milestones.length) return '';

  const rows = milestones.map(group => {
    const tasks = [...new Set(group.items.filter(m => m.isMilestone).map(m => m.task))].join(', ');
    const dels  = [...new Set(group.items.filter(m => m.isMilestone).map(m => m.deliverable))].join(', ');
    const isPastDue = group.isPastDue;
    return `
      <tr>
        <td style="padding:7px 10px 7px 0;border-bottom:1px solid ${PDF.border};font-size:10px;color:${isPastDue ? PDF.red : PDF.textLight};font-family:${PDF.font};white-space:nowrap;width:70px">${fmtDateShort(group.date)}</td>
        <td style="padding:7px 10px;border-bottom:1px solid ${PDF.border};font-size:10px;color:${PDF.textMuted};font-family:${PDF.font};width:60px">${esc(group.owner)}</td>
        <td style="padding:7px 10px;border-bottom:1px solid ${PDF.border};font-size:10px;font-weight:600;color:${isPastDue ? PDF.red : PDF.text};font-family:${PDF.font}">${esc(tasks)}</td>
        <td style="padding:7px 0 7px 10px;border-bottom:1px solid ${PDF.border};font-size:9px;color:${PDF.textMuted};font-family:${PDF.font}">${esc(dels)}</td>
      </tr>`;
  }).join('');

  return `
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr>
          <th style="text-align:left;padding:0 10px 6px 0;font-size:8px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${PDF.textMuted};border-bottom:1px solid ${PDF.border};font-family:${PDF.font}">Date</th>
          <th style="text-align:left;padding:0 10px 6px;font-size:8px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${PDF.textMuted};border-bottom:1px solid ${PDF.border};font-family:${PDF.font}">Party</th>
          <th style="text-align:left;padding:0 10px 6px;font-size:8px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${PDF.textMuted};border-bottom:1px solid ${PDF.border};font-family:${PDF.font}">Milestone</th>
          <th style="text-align:left;padding:0 0 6px 10px;font-size:8px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${PDF.textMuted};border-bottom:1px solid ${PDF.border};font-family:${PDF.font}">Deliverable</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ── PDF phases-by-deliverable section ────────────────────────────────────
function pdfPhasesByProduct(deliverables, phasesPerDeliverable, milestoneGroups) {
  const dateByKey = new Map();
  milestoneGroups.forEach(group => {
    group.items.forEach(item => {
      dateByKey.set(`${item.deliverable}||${item.task}`, { date: group.date, isPastDue: group.isPastDue });
    });
  });

  return deliverables.map((del, idx) => {
    const phases = phasesPerDeliverable[idx] || [];
    if (!phases.length) return '';

    const label = `${del.product} — ${del.isRenewal ? 'Renewal' : 'New'}`;
    const rows = phases.map(phase => {
      const key   = `${del.product}||${phase.name}`;
      const entry = dateByKey.get(key);
      const dateStr = entry ? fmtDateShort(entry.date) : '—';
      const isPastDue = entry?.isPastDue || false;
      return `
        <tr>
          <td style="padding:5px 10px 5px 0;border-bottom:1px solid ${PDF.border};font-size:9px;color:${PDF.textMuted};font-family:${PDF.font};width:55px">${esc(phase.owner)}</td>
          <td style="padding:5px 10px;border-bottom:1px solid ${PDF.border};font-size:10px;color:${phase.is_milestone ? PDF.text : PDF.textLight};font-weight:${phase.is_milestone ? '600' : '400'};font-family:${PDF.font}">${esc(phase.name)}${phase.is_milestone ? ' ●' : ''}</td>
          <td style="padding:5px 0 5px 10px;border-bottom:1px solid ${PDF.border};font-size:10px;color:${isPastDue ? PDF.red : PDF.textLight};font-family:${PDF.font};white-space:nowrap;text-align:right">${esc(dateStr)}</td>
        </tr>`;
    }).join('');

    return `
      <div style="margin-bottom:20px;break-inside:avoid">
        <div style="font-size:10px;font-weight:700;color:${PDF.text};padding:7px 0;border-bottom:1.5px solid ${PDF.dark};margin-bottom:0;font-family:${PDF.font}">${esc(label)}</div>
        <table style="width:100%;border-collapse:collapse">${rows}</table>
      </div>`;
  }).join('');
}

// ── PDF preview — renders scaled paper view inline in the tab ─────────────
export function previewPdf(type, data) {
  const previewIds = {
    basic:    'basicPdfPreview',
    expanded: 'expandedPdfPreview',
    netNew:   'netNewPdfPreview'
  };
  const container = document.getElementById(previewIds[type]);
  if (!container || !data) return;

  let html = '';
  if (type === 'basic') {
    html = buildBasicPdf(data);
  } else {
    container.innerHTML = '<div class="pdf-coming-soon">This PDF format is coming soon.</div>';
    return;
  }

  // Scale the 816px page to fit the container width with some padding
  const containerWidth = container.clientWidth - 40; // 20px padding each side
  const scale = Math.min(1, containerWidth / 816);

  container.innerHTML = `
    <div class="pdf-page-preview" style="
      width:816px;
      transform:scale(${scale});
      transform-origin:top center;
      margin-bottom:${-(816 * (1 - scale))}px;
    ">
      ${html}
    </div>`;
}

// ── PDF download entry point ──────────────────────────────────────────────
export function downloadPdf(type, data) {
  const canvas = document.getElementById('pdfCanvas');
  if (!canvas || !data) return;

  let html = '';
  if (type === 'basic') {
    html = buildBasicPdf(data);
  } else {
    // expanded and netNew to be built
    alert(`${type === 'expanded' ? 'Expanded' : 'Net New Expanded'} PDF coming soon.`);
    return;
  }

  canvas.innerHTML = html;
  canvas.style.display = 'block';

  // Small delay lets the browser render before print dialog opens
  setTimeout(() => {
    window.print();
    setTimeout(() => {
      canvas.style.display = 'none';
    }, 500);
  }, 150);
}

// ── Copy email table as HTML to clipboard ─────────────────────────────────
// Uses ClipboardItem with text/html MIME type so Outlook and Gmail
// preserve table formatting when pasted. Falls back to plain text
// if ClipboardItem isn't supported (Firefox, some mobile browsers).
export async function copyEmailTable(tab) {
  const wrapperId = tab === 'chron' ? 'chronTableWrap' : 'weeklyTableWrap';
  const tableEl   = document.querySelector(`#${wrapperId} table`);
  if (!tableEl) return;

  const btnSel = tab === 'chron'
    ? '#panelChron .tl-action-btn'
    : '#panelWeekly .tl-action-btn';
  const btn = document.querySelector(btnSel);
  const origHTML = btn ? btn.innerHTML : '';

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html':  new Blob([tableEl.outerHTML],     { type: 'text/html' }),
        'text/plain': new Blob([tableEl.innerText || ''], { type: 'text/plain' })
      })
    ]);
    if (btn) {
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.innerHTML = origHTML; }, 1800);
    }
  } catch {
    // Fallback to plain text (tab-separated)
    const plain = [...tableEl.querySelectorAll('tr')]
      .map(r => [...r.querySelectorAll('td,th')].map(c => c.textContent.trim()).join('\t'))
      .join('\n');
    await navigator.clipboard.writeText(plain);
    if (btn) {
      btn.textContent = 'Copied (plain text)';
      setTimeout(() => { btn.innerHTML = origHTML; }, 1800);
    }
  }
}

// ── Print / PDF ───────────────────────────────────────────────────────────
export function printTimeline() {
  window.print();
}

// ── Save timeline to Supabase ─────────────────────────────────────────────
export async function saveTimeline({ pm, client, project, startDate, dueDate, milestoneGroups, deliverables, projectSpanDays }) {
  if (!pm)      { alert('Please select a PM before saving.'); return; }
  if (!client)  { alert('Please enter a client name before saving.'); return; }
  if (!project) { alert('Please enter a project name before saving.'); return; }

  localStorage.setItem('flimp_pm', pm);

  const btn = document.querySelector('[data-action="save-timeline"]');
  try {
    if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }

    const { timelineId } = await saveTimelineToDb({
      pm, client, project,
      startDate: toISO(startDate),
      dueDate:   dueDate ? toISO(dueDate) : null,
      milestoneGroups,
      deliverables,
      projectSpanDays
    });

    if (btn) {
      btn.textContent = '✓ Saved!';
      btn.style.background = 'var(--green)';
      setTimeout(() => {
        btn.textContent = 'Save timeline';
        btn.style.background = 'var(--dark)';
        btn.disabled = false;
      }, 2000);
    }

    return timelineId;
  } catch (err) {
    console.error('saveTimeline failed:', err);
    alert('Failed to save timeline. Please try again.');
    if (btn) { btn.textContent = 'Save timeline'; btn.disabled = false; }
  }
}
