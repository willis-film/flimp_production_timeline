// ── engine.js ─────────────────────────────────────────────────────────────
// Pure computation — no DOM access anywhere in this file.
// Date utilities, dependency graph, and timeline scheduling engine.
// ui.js and output.js import from here.
// ─────────────────────────────────────────────────────────────────────────

import { VALID_PARENTS, PRODUCT_META } from './database.js';

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
    if (!parentSel || parentSel.value === '') {
        map[i] = null; return;
    }
    const parentOpt = parentSel.options[parentSel.selectedIndex];
    if (!parentOpt || !parentOpt.dataset.product) {
        map[i] = null; return;
    }

    // The parent <option> value IS the parent's absolute row index — that's what
    // refreshParentSelectors writes (opt.value = o.rowIndex). Use it directly.
    // (A prior version treated this as an ordinal position among valid-parent
    // candidates and re-counted rows, which resolved to the wrong row whenever
    // the valid-parent set contained more than one matching row — e.g. a chatbot
    // whose valid parents include both an alternate and a translation.)
    const parentRowIdx   = parseInt(parentSel.value, 10);
    const validParentSet = VALID_PARENTS[childSel.value];

    // Validate the referenced row exists, isn't self, and is actually a valid parent
    const parentRow    = delRows[parentRowIdx];
    const parentRowSel = parentRow?.querySelector('select');
    if (
      isNaN(parentRowIdx) ||
      parentRowIdx === i ||
      !parentRowSel?.value ||
      !validParentSet.has(parentRowSel.value)
    ) {
      map[i] = null; return;
    }
    map[i] = parentRowIdx;
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
// `pmConfig` — array of {product, isRenewal, deliveryDate} for P&M rows
//
// Returns: { milestoneGroups, projectEndDate, projectSpanDays, deliverables }
export function scheduleTimeline({ deliverables, phasesPerDeliverable, parentIdxMap, startDate, dueDate, pmConfig = [] }) {

  // ── P&M delivery dates — for export phase name labelling ────────────────
  const pmDeliveryDates = {};
  pmConfig.forEach(({ product, isRenewal, deliveryDate }) => {
    const delIdx = deliverables.findIndex(d => d.product === product && d.isRenewal === isRenewal);
    if (delIdx === -1) return;
    pmDeliveryDates[delIdx] = new Date(deliveryDate + 'T00:00:00');
  });

  // ── Resolve scheduleType for each deliverable index ──────────────────────
  // Falls back to null (root) if PRODUCT_META isn't populated yet.
  function scheduleTypeOf(idx) {
    return PRODUCT_META[deliverables[idx]?.product]?.scheduleType || null;
  }

  // ── Walk up parentIdxMap to find the chain root index ───────────────────
  function chainRootOf(idx) {
    let cur = idx, safety = 0;
    while (parentIdxMap[cur] !== null && parentIdxMap[cur] !== undefined && safety++ < 20) {
      cur = parentIdxMap[cur];
    }
    return cur;
  }

  // ── Kahn's topo sort — roots first, children after parent resolves ───────
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

  // ── Forward-schedule each deliverable to get its start date ─────────────
  // This pass computes startDates[] and endDates[] using type-aware gate logic.
  // phasesPerDeliverable end dates (backward-scheduled from due date) are
  // applied in the milestone-building pass below.
  const endDates   = {};  // idx → Date (end of last phase)
  const startDates = {};  // idx → Date (start of first phase)

  // Resolve the P&M anchor date for a given delivery anchor (ISO string or null).
  // All chains sharing the same resolved anchor share one P&M gate.
  // anchorKey: toISO(pmDelivery) if set, else toISO(dueDate) if set, else 'none'.
  function anchorKeyOf(idx) {
    const root = chainRootOf(idx);
    const pmD  = pmDeliveryDates[root];
    if (pmD) return toISO(pmD);
    if (dueDate) return toISO(dueDate);
    return 'none';
  }

  sortedIdxs.forEach(idx => {
    const parIdx = parentIdxMap[idx];
    const type   = scheduleTypeOf(idx);

    let startFrom;

    if (type === null) {
      // Root — always starts from project start date
      startFrom = new Date(startDate);

    } else if (type === 'alternate' || type === 'chatbot') {
      // Starts immediately after direct parent completes
      startFrom = parIdx !== null && endDates[parIdx]
        ? nextWorkDay(new Date(endDates[parIdx]))
        : new Date(startDate);

    } else if (type === 'translation') {
      // Waits for the latest ALTERNATE end in the same chain.
      // If no alternates exist in the chain, falls back to direct parent end.
      const root = chainRootOf(idx);
      let gate = parIdx !== null && endDates[parIdx]
        ? new Date(endDates[parIdx])
        : new Date(startDate);

      sortedIdxs.forEach(j => {
        if (scheduleTypeOf(j) === 'alternate' && chainRootOf(j) === root) {
          if (endDates[j] && endDates[j] > gate) gate = new Date(endDates[j]);
        }
      });
      startFrom = nextWorkDay(gate);

    } else {
      // Unknown type — fall back to parent end or project start
      startFrom = parIdx !== null && endDates[parIdx]
        ? nextWorkDay(new Date(endDates[parIdx]))
        : new Date(startDate);
    }

    // Store start; end will be updated phase-by-phase in the milestone pass
    startDates[idx] = new Date(startFrom);
    // Seed endDates so children can reference it; overwritten below
    endDates[idx]   = new Date(startFrom);
  });

  // ── Compute per-anchor P&M gate dates ────────────────────────────────────
  // For each anchor group, pmGateDate = max end date of all translations in that group.
  // If no translations, falls back to max end of all alternates.
  // If no alternates either, falls back to max end of all roots.
  const pmGateByAnchor = {};

  function updatePmGate(anchorKey, candidate) {
    if (!pmGateByAnchor[anchorKey] || candidate > pmGateByAnchor[anchorKey]) {
      pmGateByAnchor[anchorKey] = new Date(candidate);
    }
  }

  // First pass: collect translation ends per anchor
  const translationEndsByAnchor = {};
  sortedIdxs.forEach(idx => {
    if (scheduleTypeOf(idx) !== 'translation') return;
    const key = anchorKeyOf(idx);
    if (!translationEndsByAnchor[key]) translationEndsByAnchor[key] = [];
    // endDates[idx] at this point is just startDates — we'll refine after phase pass
    // Store idx for later resolution
    translationEndsByAnchor[key] = translationEndsByAnchor[key] || [];
    translationEndsByAnchor[key].push(idx);
  });

  // ── Milestone building pass ──────────────────────────────────────────────
  const allMilestones = [];
  let projectEndDate  = new Date(startDate);

  sortedIdxs.forEach(idx => {
    const del    = deliverables[idx];
    const parIdx = parentIdxMap[idx];
    const type   = scheduleTypeOf(idx);

    // P&M items (eligible_PM deliverables with a pmDelivery date set) use
    // the pmGate start — computed after all phases are known. They are handled
    // in a second pass below; skip them here.
    // P&M in this context means the del-row has a pmDelivery date attached
    // (dataset.pmDelivery), not that the product itself is a P&M product.
    // The scheduleType handles all product-level gate logic above.

    const startFrom = startDates[idx] || new Date(startDate);
    let vDate    = new Date(startFrom);
    let trackEnd = new Date(startFrom);
    const phases = phasesPerDeliverable[idx] || [];

    phases.forEach(phase => {
      const endDate = phase.endDate instanceof Date && !isNaN(phase.endDate)
        ? phase.endDate
        : addBusinessDays(vDate, phase.dur);
      allMilestones.push({
        date:              endDate,
        owner:             phase.owner,
        deliverable:       del.product,
        // Display alias. `deliverable` stays the canonical product name — it's the
        // grouping key for milestone demotion and the Kickoff/Distribution rollup,
        // so overwriting it would merge two blocks of the same product that carry
        // different aliases. Output reads label ?? deliverable.
        deliverableLabel:  del.label || del.product,
        parentDeliverable: parIdx !== null ? deliverables[parIdx].product : null,
        parentDeliverableLabel: parIdx !== null
          ? (deliverables[parIdx].label || deliverables[parIdx].product)
          : null,
        task:              phase.name,
        isMilestone:       phase.is_milestone || false
      });
      if (endDate > projectEndDate) projectEndDate = new Date(endDate);
      trackEnd = new Date(endDate);
      vDate    = nextWorkDay(new Date(endDate));
    });

    endDates[idx] = new Date(trackEnd);
  });

  // ── Recompute P&M gate now that endDates are final ───────────────────────
  // Group by anchor key. Gate = max translation end in group,
  // falling back to max alternate end, then max root end.
  const anchorKeys = [...new Set(sortedIdxs.map(i => anchorKeyOf(i)))];

  anchorKeys.forEach(key => {
    const inGroup = sortedIdxs.filter(i => anchorKeyOf(i) === key);

    const translationEnds = inGroup
      .filter(i => scheduleTypeOf(i) === 'translation')
      .map(i => endDates[i]).filter(Boolean);

    const alternateEnds = inGroup
      .filter(i => scheduleTypeOf(i) === 'alternate')
      .map(i => endDates[i]).filter(Boolean);

    const rootEnds = inGroup
      .filter(i => scheduleTypeOf(i) === null)
      .map(i => endDates[i]).filter(Boolean);

    const candidates = translationEnds.length ? translationEnds
      : alternateEnds.length ? alternateEnds
      : rootEnds;

    if (candidates.length) {
      pmGateByAnchor[key] = candidates.reduce((m, d) => d > m ? d : m);
    }
  });

  // For phases marked is_milestone that repeat per deliverable (e.g. round reviews),
  // only the last occurrence per deliverable should be a milestone.
  // Strip " Rd N" suffix before grouping so "Client Review Rd 1" and "Client Review Rd 2"
  // are treated as the same phase family.
  function baseTaskName(task) {
    return task.trim().toLowerCase().replace(/\s+rd\s+\d+$/i, '');
  }
  const milestoneBaseNames = new Set(
    allMilestones.filter(m => m.isMilestone).map(m => baseTaskName(m.task))
  );
  milestoneBaseNames.forEach(baseName => {
    const matches = allMilestones.filter(m => m.isMilestone && baseTaskName(m.task) === baseName);
    // Group by deliverable
    const byDel = {};
    matches.forEach(m => {
      if (!byDel[m.deliverable]) byDel[m.deliverable] = [];
      byDel[m.deliverable].push(m);
    });
    // Demote all but the last per deliverable
    Object.values(byDel).forEach(group => {
      group.sort((a, b) => a.date - b.date);
      group.slice(0, -1).forEach(m => { m.isMilestone = false; });
    });
  });

  allMilestones.sort((a, b) => a.date - b.date);

  // ── Kickoff: one entry at the earliest date, listing all deliverables ─────
  // ── Distribution: one entry at the latest date, listing all deliverables ──
  const SINGLETON_FIRST = new Set(['kickoff']);
  const SINGLETON_LAST  = new Set(['distribution']);

  ['kickoff', 'distribution'].forEach(key => {
    const isFirst = SINGLETON_FIRST.has(key);
    const matches = allMilestones.filter(m => m.task.trim().toLowerCase() === key);
    if (matches.length <= 1) return;

    // Pick the anchor date — earliest for Kickoff, latest for Distribution
    const anchorDate = isFirst
      ? matches.reduce((a, b) => a.date <= b.date ? a : b).date
      : matches.reduce((a, b) => a.date >= b.date ? a : b).date;

    // Collect all deliverable names across all instances
    const allDeliverables = [...new Set(matches.map(m => m.deliverable))];
    // …and their display labels, so an aliased product shows its alias in the
    // rolled-up Kickoff/Distribution row rather than reverting to the product name.
    const allLabels = [...new Set(matches.map(m => m.deliverableLabel || m.deliverable))];

    // Keep the first match as the surviving entry, update it with merged data
    const keeper = matches[0];
    keeper.date             = anchorDate;
    keeper.deliverable      = allDeliverables.join(', ');
    keeper.deliverableLabel = allLabels.join(', ');

    // Remove all other instances
    for (let i = matches.length - 1; i >= 1; i--) {
      const idx = allMilestones.indexOf(matches[i]);
      if (idx !== -1) allMilestones.splice(idx, 1);
    }
  });

  // ── Kickoff + Distribution are always milestones regardless of DB flag ───
  const ALWAYS_MILESTONE = new Set(['kickoff', 'distribution']);
  allMilestones.forEach(m => {
    if (ALWAYS_MILESTONE.has(m.task.trim().toLowerCase())) m.isMilestone = true;
  });

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

  return { milestoneGroups: groups, projectEndDate, projectSpanDays, deliverables, phasesPerDeliverable, pmGateByAnchor };
}
