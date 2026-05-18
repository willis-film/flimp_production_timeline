// ── engine.js ─────────────────────────────────────────────────────────────
// Pure computation — no DOM access anywhere in this file.
// Date utilities, dependency graph, and timeline scheduling engine.
// ui.js and output.js import from here.
// ─────────────────────────────────────────────────────────────────────────

import { VALID_PARENTS } from './database.js';

// ── US Federal Holidays ───────────────────────────────────────────────────
export const HOLIDAYS = new Set([
  '2025-01-01','2025-01-20','2025-02-17','2025-05-26','2025-06-19',
  '2025-07-04','2025-09-01','2025-10-13','2025-11-11','2025-11-27','2025-12-25',
  '2026-01-01','2026-01-19','2026-02-16','2026-05-25','2026-06-19',
  '2026-07-04','2026-09-07','2026-10-12','2026-11-11','2026-11-26','2026-12-25',
  '2027-01-01','2027-01-18','2027-02-15','2027-05-31','2027-06-19',
  '2027-07-05','2027-09-06','2027-10-11','2027-11-11','2027-11-25','2027-12-24',
  '2027-12-31'
]);

export let workDays = 5;
export function setDays(n) { workDays = parseInt(n, 10) || 5; }

// ── Date utilities ────────────────────────────────────────────────────────

/** Local ISO string yyyy-mm-dd — avoids UTC offset issues */
export function toISO(d) {
  const y   = d.getFullYear();
  const m   = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function isWorkDay(d) {
  const dow = d.getDay();
  if (workDays === 5 && (dow === 0 || dow === 6)) return false;
  if (workDays === 6 && dow === 0) return false;
  return !HOLIDAYS.has(toISO(d));
}

export function addBusinessDays(startDate, days) {
  const dur = Math.max(0, Math.round(days));
  let d = new Date(startDate);
  let added = 0, safety = 0;
  while (added < dur && safety < 1000) {
    d.setDate(d.getDate() + 1);
    if (isWorkDay(d)) added++;
    safety++;
  }
  return d;
}

export function nextWorkDay(d) {
  let nd = new Date(d), safety = 0;
  while (!isWorkDay(nd) && safety < 30) { nd.setDate(nd.getDate() + 1); safety++; }
  return nd;
}

export function countBusinessDays(start, end) {
  if (!start || !end || end <= start) return 0;
  let count = 0;
  let d = new Date(start);
  d.setDate(d.getDate() + 1);
  let safety = 0;
  while (d <= end && safety < 3000) {
    if (isWorkDay(d)) count++;
    d.setDate(d.getDate() + 1);
    safety++;
  }
  return count;
}

export function subtractBusinessDays(endDate, days) {
  if (!days || days <= 0) return new Date(endDate);
  let d = new Date(endDate);
  let count = 0, safety = 0;
  while (count < days && safety < 2000) {
    d.setDate(d.getDate() - 1);
    if (isWorkDay(d)) count++;
    safety++;
  }
  return d;
}

export function previousWorkDay(d) {
  let pd = new Date(d), safety = 0;
  do { pd.setDate(pd.getDate() - 1); safety++; } while (!isWorkDay(pd) && safety < 30);
  return pd;
}

/** Depth of node in dependency graph (0 = root) */
export function getDepth(idx, parentIdxMap) {
  let depth = 0, cur = idx, safety = 0;
  while (parentIdxMap[cur] !== null && parentIdxMap[cur] !== undefined && safety++ < 20) {
    depth++; cur = parentIdxMap[cur];
  }
  return depth;
}

export function fmtDateShort(d) {
  if (!d || isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Sanitize a string for safe insertion into HTML */
export function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Parent-index map builder ──────────────────────────────────────────────
// Builds parentIdxMap[i] = rowIdx of parent del-row, or null.
//
// refreshParentSelectors() (ui.js) assigns opt.value = 0,1,2... as the
// position in the filtered valid-parent list for each child row.
// We walk delRows in the same DOM order to map that position back to a
// row index — this must stay in sync with refreshParentSelectors().
export function buildParentIdxMap(delRows) {
  const map = {};
  delRows.forEach((row, i) => {
    const childSel = row.querySelector('select');
    if (!childSel || !childSel.value || !VALID_PARENTS[childSel.value]) {
      map[i] = null; return;
    }
    const parentSel = row.querySelector('.parent-sel');
    if (!parentSel || parentSel.value === '') { map[i] = null; return; }
    const parentOpt = parentSel.options[parentSel.selectedIndex];
    if (!parentOpt || !parentOpt.dataset.product) { map[i] = null; return; }

    const targetPosition = parseInt(parentSel.value, 10);
    const validParentSet = VALID_PARENTS[childSel.value];

    let position = 0, matchedRowIdx = null;
    for (let j = 0; j < delRows.length; j++) {
      if (j === i) continue;
      const otherSel = delRows[j].querySelector('select');
      if (!otherSel || !otherSel.value) continue;
      if (!validParentSet.has(otherSel.value)) continue;
      if (position === targetPosition) { matchedRowIdx = j; break; }
      position++;
    }
    map[i] = matchedRowIdx;
  });
  return map;
}

// ── Timeline scheduling engine ────────────────────────────────────────────
// Pure function — takes phase data and returns a structured data object.
// output.js consumes this to render any format. dashboard.js can call it
// when re-rendering a saved timeline.
//
// `phasesPerDeliverable` — array aligned to deliverables:
//   [{name, dur, owner}, ...]  (already read from DOM or loaded from DB)
//
// Returns: { milestoneGroups, projectEndDate, projectSpanDays, deliverables }
export function scheduleTimeline({ deliverables, phasesPerDeliverable, parentIdxMap, startDate, dueDate }) {
  const allMilestones = [];
  let projectEndDate  = new Date(startDate);
  const endDates      = {};

  // Kahn's topo sort — roots first, children after their parent resolves
  const resolved   = new Set();
  const sortedIdxs = [];
  let safety = 0;
  while (sortedIdxs.length < deliverables.length && safety++ < 200) {
    const ready = deliverables
      .map((_, i) => i)
      .filter(i => !resolved.has(i) && (parentIdxMap[i] === null || resolved.has(parentIdxMap[i])));
    if (!ready.length) break;
    ready.forEach(i => { sortedIdxs.push(i); resolved.add(i); });
  }

  sortedIdxs.forEach(idx => {
    const del    = deliverables[idx];
    const parIdx = parentIdxMap[idx];

    const startFrom = parIdx !== null && endDates[parIdx]
      ? nextWorkDay(new Date(endDates[parIdx]))
      : new Date(startDate);

    let vDate    = new Date(startFrom);
    let trackEnd = new Date(startFrom);
    const phases = phasesPerDeliverable[idx] || [];

    phases.forEach(phase => {
      const endDate = addBusinessDays(vDate, phase.dur);
      allMilestones.push({
        date:        endDate,
        owner:       phase.owner,
        deliverable: del.product,
        task:        phase.name,
        isMilestone: phase.is_milestone || false
      });
      if (endDate > projectEndDate) projectEndDate = new Date(endDate);
      trackEnd = new Date(endDate);
      vDate    = nextWorkDay(new Date(endDate));
    });

    endDates[idx] = new Date(trackEnd);
  });

  allMilestones.sort((a, b) => a.date - b.date);

  // Group by date + owner — Client and Flimp are never combined
  const groups = [];
  const groupIndex = {};
  allMilestones.forEach(m => {
    const key = toISO(m.date) + '|' + m.owner;
    if (groupIndex[key] === undefined) {
      groupIndex[key] = groups.length;
      groups.push({ date: m.date, owner: m.owner, items: [], isPastDue: false });
    }
    groups[groupIndex[key]].items.push(m);
    if (dueDate && m.date > dueDate) groups[groupIndex[key]].isPastDue = true;
  });
  groups.sort((a, b) => a.date - b.date || a.owner.localeCompare(b.owner));

  const projectSpanDays = countBusinessDays(startDate, projectEndDate);

  return { milestoneGroups: groups, projectEndDate, projectSpanDays, deliverables, phasesPerDeliverable };
}
