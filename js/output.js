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

// ── Main render entry point ───────────────────────────────────────────────
export function renderTimelineTable(data) {
  const output = document.getElementById('timelineOutput');
  document.getElementById('outputDivider').style.display = 'block';
  output.style.display = 'block';

  // Net new note
  const nnWrap = document.getElementById('nnNoteWrap');
  nnWrap.innerHTML = data.isNetNew
    ? `<div class="nn-note"><strong>Net New Client</strong>This project involves a new client relationship with Flimp. Please allow additional time during the Kickoff and onboarding phases for account setup, portal access provisioning, and alignment on Flimp's production process and review expectations. All milestone dates assume timely client responsiveness — delays in content delivery or review rounds will push the schedule accordingly.</div>`
    : '';

  // Render both tables
  document.getElementById('chronTableWrap').innerHTML  = buildChronTable(data);
  document.getElementById('weeklyTableWrap').innerHTML = buildWeeklyTable(data);

  // Reset to chronological tab on each generate
  switchTab('chron');

  output.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Tab switcher ──────────────────────────────────────────────────────────
export function switchTab(tab) {
  const isChron = tab === 'chron';
  document.getElementById('panelChron').style.display  = isChron ? 'block' : 'none';
  document.getElementById('panelWeekly').style.display = isChron ? 'none'  : 'block';
  document.getElementById('tabChron').classList.toggle('active',  isChron);
  document.getElementById('tabWeekly').classList.toggle('active', !isChron);
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
