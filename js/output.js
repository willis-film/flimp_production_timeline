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

// ── Party name resolver — substitutes "Client" with the actual client name ─
function partyName(owner, client) {
  return owner === 'Client' ? (client || 'Client') : owner;
}

// ── Party display for milestone groups — blank for Kickoff and Distribution ─
const PARTY_BLANK_TASKS = new Set(['kickoff', 'distribution']);
function groupParty(group, client) {
  const tasks = group.items.map(m => m.task.trim().toLowerCase());
  if (tasks.every(t => PARTY_BLANK_TASKS.has(t))) return '';
  return partyName(group.owner, client);
}

// ── Deliverable display — child Distribution phases show their parent ──────
function fmtDeliverable(item) {
  if (
    item.task.trim().toLowerCase() === 'distribution' &&
    item.parentDeliverable
  ) {
    return `${item.deliverable} (via ${item.parentDeliverable})`;
  }
  return item.deliverable;
}
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
function buildChronTable({ milestoneGroups, projectEndDate, projectSpanDays, startDate, dueDate, project, client }) {
  let rows = buildTableHeader(project);

  milestoneGroups.forEach(group => {
    const dels  = [...new Set(group.items.map(m => fmtDeliverable(m)))].join(', ');
    const tasks = [...new Set(group.items.map(m => m.task))].join(', ');
    rows += buildDataRow(groupParty(group, client), dels, tasks, fmtDateShort(group.date), group.isPastDue);
  });

  rows += buildFooterRow(startDate, projectSpanDays, dueDate, projectEndDate);
  return `<table style="${E.table}"><tbody>${rows}</tbody></table>`;
}

// ── Build weekly table HTML ───────────────────────────────────────────────
function buildWeeklyTable({ milestoneGroups, projectEndDate, projectSpanDays, startDate, dueDate, project, client }) {
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
        const delLabel = fmtDeliverable(item);
        const key = `${delLabel}||${group.owner}`;
        if (!byKey.has(key)) byKey.set(key, {
          deliverable: delLabel,
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
      const isBlankParty = tasks.every(t => PARTY_BLANK_TASKS.has(t.trim().toLowerCase()));
      rows += buildDataRow(isBlankParty ? '' : partyName(owner, client), deliverable, tasks.join(', '), fmtDateShort(date), isPastDue);
    });
  });

  rows += buildFooterRow(startDate, projectSpanDays, dueDate, projectEndDate);
  return `<table style="${E.table}"><tbody>${rows}</tbody></table>`;
}

// ── Build by-product table HTML ───────────────────────────────────────────
// Each deliverable gets its own section header, then its phases in order
// with the actual computed end date pulled from milestoneGroups.
function buildByProductTable({ phasesPerDeliverable, deliverables, milestoneGroups, projectEndDate, projectSpanDays, startDate, dueDate, project, client }) {
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
          <td contenteditable="true" style="${E.tdFirst}">${esc(partyName(phase.owner, client))}</td>
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
const FLIMP_LOGO_SVG = `<svg viewBox="0 0 656 254" xmlns="http://www.w3.org/2000/svg" style="height:24px;width:auto"><g fill="#67E74E"><path class="cls-1" d="M275.94,74.58h44.55v19.86c.41-.58.6-.81.75-1.07,7.19-12.2,17.95-19.24,31.77-21.66,8.3-1.46,16.49-.91,24.42,2.06,9.71,3.64,16.8,10.23,21.51,19.44.25.49.49.98.87,1.73.49-.77.86-1.38,1.24-1.98,7.27-11.23,17.15-18.81,30.54-21.05,15.03-2.52,29.07-.17,41.09,9.88,8.44,7.07,13.19,16.37,15.09,27.07.74,4.11,1.07,8.34,1.09,12.53.09,28.64.05,57.28.05,85.92v1.89h-45.64c-.03-.61-.09-1.24-.09-1.87v-71.62c0-4.4-.61-8.65-2.85-12.55-3.3-5.74-8.39-8.62-14.86-9.13-5.05-.38-9.79.67-13.81,3.94-4.36,3.56-6.23,8.39-6.8,13.82-.17,1.63-.18,3.27-.18,4.89v72.51h-44.65v-74.49c0-3.79-.66-7.44-2.35-10.85-3.51-7.1-11.32-10.98-19.57-9.74-9.4,1.41-15.4,7.72-16.28,17.21-.15,1.63-.23,3.27-.23,4.89v72.96h-45.65V74.57l-.02.02Z"/>
    <path class="cls-1" d="M552.95,194.08v60.01h-45.65V74.58h43.09v18.62c.34-.28.54-.37.63-.54,5.46-8.68,13.41-14.19,22.89-17.58,20.31-7.27,43.96-2.42,59.9,12.12,10.49,9.59,16.87,21.54,19.94,35.27,3.94,17.7,2.9,35.11-4.37,51.85-7.26,16.7-19.21,28.69-36.71,34.45-14.91,4.91-29.7,4.48-44.04-2.32-6.03-2.85-11.26-6.8-15.66-12.41l-.02.03ZM610.18,141.8c0-15.98-12.55-28.36-28.79-28.39-16.28-.03-29.31,12.58-29.3,28.35.02,15.88,12.89,28.35,29.27,28.35s28.82-12.56,28.82-28.3h0Z"/>
    <path class="cls-1" d="M0,18.7h1.93c16.35,0,32.72.03,49.07,0,20.69-.06,39.53-6.03,56.48-17.9.34-.25.69-.48,1.15-.8,9.05,12.44,18.09,24.85,27.2,37.38-12.66,9.2-26.34,16.15-41.17,20.86-14.8,4.69-30,6.86-45.64,6.7v26.92h76.38v46.23H48.98v71.08H.02V18.7h-.02Z"/>
    <path class="cls-1" d="M147.4,18.78h45.54v190.4h-45.54V18.78Z"/>
    <path class="cls-1" d="M257.34,209.2h-45.71V75.09c0-1.86.05-1.89,1.81-1.23,8.11,2.98,16.52,3.79,25.1,3.33,6-.32,11.87-1.33,17.49-3.54.89-.35,1.35-.14,1.3.87v134.7l.02-.02Z"/>
    <path class="cls-1" d="M235.59,12.38c10.4.55,19.33,5.41,24.42,15.86,5.34,10.94,1.99,23.15-7.9,30.89-14.07,11.01-35.3,6.35-43.15-9.46-5.25-10.54-2.24-23.24,7.29-30.85,5.34-4.26,11.46-6.35,19.33-6.44h.02Z"/></g></svg>`;

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
            ${pdfMilestoneTable(milestoneGroups, dueDate, client)}
          </div>
        </div>` : ''}

      <div>
        ${pdfSection('Phases by Deliverable')}
        <div style="padding-top:12px">
          ${pdfPhasesByProduct(deliverables, phasesPerDeliverable, milestoneGroups, client)}
        </div>
      </div>

    </div>`;

  return pdfPage(pageContent, 1, 1);
}
function pdfMilestoneTable(milestoneGroups, dueDate, client) {
  const milestones = milestoneGroups.filter(g => g.items.some(m => m.isMilestone));

  if (!milestones.length) return '';

  const rows = milestones.map(group => {
    const tasks = [...new Set(group.items.filter(m => m.isMilestone).map(m => m.task))].join(', ');
    const dels  = [...new Set(group.items.filter(m => m.isMilestone).map(m => fmtDeliverable(m)))].join(', ');
    const isPastDue = group.isPastDue;
    return `
      <tr>
        <td style="padding:7px 10px 7px 0;border-bottom:1px solid ${PDF.border};font-size:10px;color:${isPastDue ? PDF.red : PDF.textLight};font-family:${PDF.font};white-space:nowrap;width:70px">${fmtDateShort(group.date)}</td>
        <td style="padding:7px 10px;border-bottom:1px solid ${PDF.border};font-size:10px;color:${PDF.textMuted};font-family:${PDF.font};width:60px">${esc(groupParty(group, client))}</td>
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
function pdfPhasesByProduct(deliverables, phasesPerDeliverable, milestoneGroups, client) {
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
          <td style="padding:5px 10px 5px 0;border-bottom:1px solid ${PDF.border};font-size:9px;color:${PDF.textMuted};font-family:${PDF.font};width:55px">${esc(partyName(phase.owner, client))}</td>
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
