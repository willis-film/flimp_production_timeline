// ── output.js ─────────────────────────────────────────────────────────────
// All output format renderers. Consumes the structured data object returned
// by scheduleTimeline() in engine.js — never calls scheduleTimeline itself.
//
// Each renderer is a pure function or a DOM-writing function that targets
// a specific container. Adding a new format means adding a new export here
// with no changes to engine.js, ui.js, or main.js.
// ─────────────────────────────────────────────────────────────────────────

import { esc, fmtDateShort, toISO } from './engine.js';
import { saveTimelineToDb } from './database.js';

// ── Render the HTML timeline table into #timelineOutput ───────────────────
export function renderTimelineTable({ milestoneGroups, projectEndDate, projectSpanDays, deliverables, startDate, dueDate, project, isNetNew }) {
  const output = document.getElementById('timelineOutput');
  document.getElementById('outputDivider').style.display = 'block';
  output.style.display = 'block';

  // Net new note
  const nnWrap = document.getElementById('nnNoteWrap');
  nnWrap.innerHTML = isNetNew
    ? `<div class="nn-note"><strong>Net New Client</strong>This project involves a new client relationship with Flimp. Please allow additional time during the Kickoff and onboarding phases for account setup, portal access provisioning, and alignment on Flimp's production process and review expectations. All milestone dates assume timely client responsiveness — delays in content delivery or review rounds will push the schedule accordingly.</div>`
    : '';

  document.getElementById('tlTitle').textContent = project;

  const tbody = document.getElementById('tlTableBody');
  tbody.innerHTML = '';
  let hasWarning = false;

  milestoneGroups.forEach(group => {
    if (group.isPastDue) hasWarning = true;
    const tr = document.createElement('tr');
    if (group.isPastDue) tr.style.background = 'var(--red-bg)';

    const deliverables_str = [...new Set(group.items.map(m => m.deliverable))].join(', ');
    const tasks_str        = [...new Set(group.items.map(m => m.task))].join(', ');

    const tdParty = document.createElement('td');
    tdParty.textContent = group.owner;

    const tdDel = document.createElement('td');
    tdDel.className = 'td-deliverable';
    tdDel.textContent = deliverables_str;

    const tdTask = document.createElement('td');
    tdTask.textContent = tasks_str;

    const tdDate = document.createElement('td');
    tdDate.className = 'td-date';
    tdDate.textContent = fmtDateShort(group.date);
    if (group.isPastDue) tdDate.style.color = 'var(--red)';

    tr.appendChild(tdParty); tr.appendChild(tdDel);
    tr.appendChild(tdTask);  tr.appendChild(tdDate);
    tbody.appendChild(tr);
  });

  if (hasWarning) {
    const warnTr = document.createElement('tr');
    const warnTd = document.createElement('td');
    warnTd.colSpan = 4;
    warnTd.style.cssText = 'background:var(--red-bg);color:var(--red);font-size:12px;padding:.5rem 1rem;font-weight:600';
    warnTd.textContent = 'One or more phases extend past the due date. Consider compressing durations in the phase review step.';
    warnTr.appendChild(warnTd);
    tbody.appendChild(warnTr);
  }

  const footer = document.getElementById('tlFooter');
  footer.innerHTML = '';
  [
    ['Project Start',  fmtDateShort(startDate)],
    ['Working Days',   projectSpanDays],
    ...(dueDate ? [['Due Date', fmtDateShort(dueDate)]] : []),
    ['Projected End',  fmtDateShort(projectEndDate)],
    ['Deliverables',   deliverables.reduce((a, d) => a + d.count, 0)]
  ].forEach(([label, value]) => {
    const span = document.createElement('span');
    span.innerHTML = `<strong>${esc(label)}:</strong> ${esc(String(value))}`;
    footer.appendChild(span);
  });

  output.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Copy tab-separated table to clipboard (paste into Excel / Sheets) ─────
export function copyTableToClipboard() {
  const rows   = [...document.querySelectorAll('#tlTableBody tr')];
  const header = 'Party\tDeliverable\tTask\tDue Date';
  const lines  = rows.map(r => {
    const cells = [...r.querySelectorAll('td')];
    if (cells.length < 4) return null;
    return cells.slice(0, 4).map(c => c.textContent.trim()).join('\t');
  }).filter(Boolean);

  navigator.clipboard.writeText([header, ...lines].join('\n')).then(() => {
    const btn  = document.querySelector('.tl-action-btn:last-child');
    const orig = btn.innerHTML;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.innerHTML = orig; }, 1500);
  });
}

// ── Plain-text email format ───────────────────────────────────────────────
// Returns a formatted string suitable for pasting into an email body.
export function renderEmailText({ milestoneGroups, projectEndDate, projectSpanDays, startDate, dueDate, project, client }) {
  const lines = [
    `Timeline: ${project}`,
    `Client: ${client}`,
    `Start: ${fmtDateShort(startDate)}`,
    dueDate ? `Due: ${fmtDateShort(dueDate)}` : null,
    `Projected End: ${fmtDateShort(projectEndDate)}`,
    `Total Working Days: ${projectSpanDays}`,
    '',
    'MILESTONE SCHEDULE',
    '─'.repeat(48)
  ].filter(l => l !== null);

  let lastDate = null;
  milestoneGroups.forEach(group => {
    const dateStr = fmtDateShort(group.date);
    if (dateStr !== lastDate) {
      lines.push('');
      lines.push(dateStr);
      lastDate = dateStr;
    }
    const tasks = [...new Set(group.items.map(m => m.task))].join(', ');
    const dels  = [...new Set(group.items.map(m => m.deliverable))].join(', ');
    lines.push(`  [${group.owner}] ${tasks} — ${dels}`);
  });

  return lines.join('\n');
}

// ── Copy email-format text to clipboard ───────────────────────────────────
export async function copyEmailFormat(data) {
  const text = renderEmailText(data);
  await navigator.clipboard.writeText(text);
}

// ── Print / PDF via browser print dialog ──────────────────────────────────
// The @media print CSS in styles.css hides non-output elements automatically.
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
