// ── main.js ───────────────────────────────────────────────────────────────
// Entry point for the timeline builder (index.html).
// Imports from all modules and wires up init, event listeners, and bootstrap.
// This is the only file referenced in index.html's <script> tag.
// ─────────────────────────────────────────────────────────────────────────

import { loadReferenceData, PM_NAMES } from './database.js';
import { setDays, toISO, nextWorkDay, scheduleTimeline, buildParentIdxMap, isWorkDay } from './engine.js';
import {
  buildDelRow, buildSelect, addRow, updateRemove,
  previewPhases, updateFeasibility, recalcPhaseDates,
  recalcBlockFeasibility, togglePMSection,
  refreshPMSelectors, rebuildPMChecklist, applyPMPostPass, readPMConfig, lastEarliestStart,
  wrapDateInput, checkDateFlag, createDateFlagIcon, resetFeasibilityState
} from './ui.js';
import {
  renderTimelineTable, copyEmailTable, switchTab,
  previewPdf, downloadPdf, saveTimeline
} from './output.js';

// ── Read phases from preview blocks ──────────────────────────────────────
// Shared between generateTimeline() and the save handler.
function readPhasesFromDOM() {
  return [...document.querySelectorAll('#pbBlocks .pb-block')].map(block =>
    [...block.querySelectorAll('.phase-table tbody tr')].map(tr => {
      const endDateStr = tr.querySelector('.phase-end-date')?.dataset.endDate || '';
      return {
        name:         tr.querySelector('.pt-name')?.value.trim() || '',
        dur:          Math.max(1, parseInt(tr.querySelector('.pt-dur')?.value || 1) || 1),
        owner:        tr.querySelector('.owner-badge')?.textContent.trim() || 'Flimp',
        endDate:      endDateStr ? new Date(endDateStr + 'T00:00:00') : null,
        is_milestone: tr.dataset.isMilestone === 'true'
      };
    }).filter(p => p.name)
  );
}

function readDeliverablesFromDOM() {
  return [...document.querySelectorAll('#delRows .del-row')]
    .map(r => ({
      product:   r.querySelector('select').value,
      // Display alias, set via the pencil in the review block header. Lives on the
      // del-row (not the block) so it survives block re-renders, which regenerate
      // #pbBlocks wholesale on rounds/precondition changes. Empty string when unset,
      // and consumers fall back to `product`.
      label:     r.dataset.label || '',
      count:     parseInt(r.querySelector('input[type=number]').value) || 1,
      isRenewal: r.querySelector('.nr-btn.r-active') !== null,
      rounds:    parseInt(r.querySelector('.rounds-val').textContent) || 2
    }))
    .filter(d => d.product);
}

// ── Last generated timeline data — used by PDF renderers ─────────────────
let lastTimelineData = null;

// ── Staleness tracking ────────────────────────────────────────────────────
// After a timeline is generated, any edit in the review section (durations,
// phase add/remove/reorder, owner toggles, preconditions, rounds) or upstream
// (dates, deliverables, P&M config) makes the displayed output wrong.
//
// Rather than dirty-flagging every mutation site — brittle, and easy to miss one —
// we fingerprint the inputs that actually feed scheduleTimeline and compare. This
// means an edit that's undone (duration 3→4→3, an owner toggled twice) correctly
// clears the warning instead of leaving it stuck on.
//
// Phase endDate is included deliberately: recalcPhaseDates stamps it from the
// authoritative gate logic, so it absorbs upstream changes (due date, parent
// production end, P&M delivery) without us having to enumerate them.
let lastFingerprint = null;

function computeFingerprint() {
  return JSON.stringify({
    client:  document.getElementById('clientName').value.trim(),
    project: document.getElementById('projectName').value.trim(),
    start:   document.getElementById('startDate').value,
    due:     document.getElementById('dueDate').value,
    dels:    readDeliverablesFromDOM(),
    parents: buildParentIdxMap([...document.querySelectorAll('#delRows .del-row')]),
    pm:      readPMConfig(),
    phases:  readPhasesFromDOM().map(block =>
               block.map(p => [
                 p.name,
                 p.dur,
                 p.owner,
                 p.endDate ? toISO(p.endDate) : '',
                 p.is_milestone
               ])
             )
  });
}

// Show/hide the warning. No-op until a timeline has actually been generated.
function refreshStaleState() {
  const warning = document.getElementById('staleWarning');
  if (!warning || lastFingerprint === null) return;
  const stale = computeFingerprint() !== lastFingerprint;
  warning.classList.toggle('visible', stale);
}

// Relabel the green button once a timeline exists. updateGenerateBtn (ui.js) owns
// the disabled state and tooltip; it never touches textContent, so this is safe.
function updateGenerateBtnLabel() {
  const btn = document.getElementById('generateBtn');
  if (btn && lastFingerprint !== null) btn.textContent = 'Regenerate Timeline';
}

// ── Generate timeline ─────────────────────────────────────────────────────
function generateTimeline() {
  const client   = document.getElementById('clientName').value.trim() || 'Client';
  const project  = document.getElementById('projectName').value.trim() || 'Untitled Project';
  const startVal = document.getElementById('startDate').value;
  const dueVal   = document.getElementById('dueDate').value;

  if (!startVal) { alert('Please enter a start date.'); return; }

  const startDate = nextWorkDay(new Date(startVal + 'T00:00:00'));
  const dueDate   = dueVal ? new Date(dueVal + 'T00:00:00') : null;

  const deliverables         = readDeliverablesFromDOM();
  const phasesPerDeliverable = readPhasesFromDOM();
  if (!deliverables.length) { alert('Please select at least one product.'); return; }

  const delRows      = [...document.querySelectorAll('#delRows .del-row')];
  const parentIdxMap = buildParentIdxMap(delRows);
  const pmConfig     = readPMConfig();
  const result       = scheduleTimeline({ deliverables, phasesPerDeliverable, parentIdxMap, startDate, dueDate, pmConfig });

  lastTimelineData = { ...result, startDate, dueDate, project, client, earliestStart: lastEarliestStart };

  renderTimelineTable(lastTimelineData);

  // Snapshot the inputs this output was built from — subsequent edits are compared
  // against this to decide whether the displayed timeline has gone stale.
  lastFingerprint = computeFingerprint();
  document.getElementById('staleWarning')?.classList.remove('visible');
  updateGenerateBtnLabel();
}

// ── Clear All — reset the tool to a fresh state ───────────────────────────
// Mirrors the DOMContentLoaded bootstrap rather than reloading the page, so the
// Supabase reference data (PRODUCTS, ALL_PHASES, …) stays in memory and the user
// doesn't sit through the loading overlay again.
//
// PM name is deliberately preserved: it's persisted to localStorage and behaves as
// a user setting, not project data. Everything else is cleared.
function clearAll() {
  if (!confirm('Clear all inputs and start over?\n\nThis discards the current timeline and cannot be undone.')) return;

  // Project info
  document.getElementById('clientName').value  = '';
  document.getElementById('projectName').value = '';
  document.getElementById('startDate').value   = toISO(new Date());
  document.getElementById('dueDate').value     = '';

  // Deliverables — rebuild the default 3 empty rows
  const dr = document.getElementById('delRows');
  dr.innerHTML = '';
  for (let i = 0; i < 3; i++) dr.appendChild(buildDelRow());
  updateRemove();

  // P&M — uncheck, then let togglePMSection collapse the section so its show/hide
  // logic stays in one place. Rows are dropped explicitly.
  const pmCheckbox = document.getElementById('pmCheckbox');
  if (pmCheckbox) pmCheckbox.checked = false;
  const pmRows = document.getElementById('pmRows');
  if (pmRows) pmRows.innerHTML = '';
  togglePMSection();
  refreshPMSelectors();

  // Review phases — drop all blocks and hide the Gantt
  document.getElementById('pbBlocks').innerHTML = '';
  const ganttWrap = document.getElementById('ganttWrap');
  if (ganttWrap) ganttWrap.style.display = 'none';

  // Generated output — hide, and clear the staleness state so the banner and the
  // button label return to their pre-generate condition.
  document.getElementById('timelineOutput').style.display = 'none';
  document.getElementById('staleWarning')?.classList.remove('visible');
  lastTimelineData = null;
  lastFingerprint  = null;

  const genBtn = document.getElementById('generateBtn');
  if (genBtn) { genBtn.textContent = 'Generate Timeline'; genBtn.disabled = true; }

  // Reset ui.js's module-scoped feasibility state, then recompute. updateFeasibility
  // early-returns with no blocks present, which is why the explicit reset is needed.
  resetFeasibilityState();
  updateFeasibility();

  // Re-flag the start date — it was just set to today, which may be a weekend.
  const startInput = document.getElementById('startDate');
  const startIcon  = startInput.parentElement?.querySelector('.date-flag-icon');
  if (startIcon) checkDateFlag(startInput, startIcon);
  const dueInput = document.getElementById('dueDate');
  const dueIcon  = dueInput.parentElement?.querySelector('.date-flag-icon');
  if (dueIcon) checkDateFlag(dueInput, dueIcon);

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Build initial deliverable rows (selects will be empty and rebuilt after loadReferenceData)
  const dr = document.getElementById('delRows');
  for (let i = 0; i < 3; i++) dr.appendChild(buildDelRow());
  updateRemove();
  refreshPMSelectors(); // Set initial disabled state on PM checkbox

  // Default start date to today
  document.getElementById('startDate').value = toISO(new Date());

  // For each date field, wrap the input then nest wrap+icon inside a flex row
  // so the icon sits to the right of the input within the .field column layout.
  function setupDateFlag(inputEl) {
    // wrapDateInput gives us a position:relative wrapper at full field width.
    // Place the icon absolutely just past the wrapper's right edge so the date
    // input fills the column exactly like the text inputs — the icon overhangs
    // into the gutter rather than narrowing the field.
    const wrap = wrapDateInput(inputEl);
    wrap.style.width = '100%';
    const icon = createDateFlagIcon();
    icon.style.cssText += ';position:absolute;left:calc(100% + 6px);top:50%;transform:translateY(-50%)';
    wrap.appendChild(icon);
    return icon;
  }
  const startFlagIcon = setupDateFlag(document.getElementById('startDate'));
  const dueFlagIcon   = setupDateFlag(document.getElementById('dueDate'));

  // Date change listeners
  document.getElementById('startDate').addEventListener('change', () => {
    checkDateFlag(document.getElementById('startDate'), startFlagIcon);
    updateFeasibility();
    document.querySelectorAll('#pbBlocks .pb-block').forEach(b => recalcBlockFeasibility(b));
  });
  document.getElementById('dueDate').addEventListener('change', () => {
    checkDateFlag(document.getElementById('dueDate'), dueFlagIcon);
    updateFeasibility();
    document.querySelectorAll('#pbBlocks .pb-block').forEach(b => {
      recalcPhaseDates(b);
      recalcBlockFeasibility(b);
    });
  });

  // Check start date immediately — it was just set to today, which could be a weekend
  checkDateFlag(document.getElementById('startDate'), startFlagIcon);

  // PM localStorage restore handled after Supabase populates the dropdown
  document.getElementById('pmName').addEventListener('change', function () {
    if (this.value) localStorage.setItem('flimp_pm', this.value);
  });

  // Duration input → live feasibility update
  document.addEventListener('input', e => {
    if (e.target.classList.contains('pt-dur')) updateFeasibility();
  });

  // ── Staleness detection ────────────────────────────────────────────────
  // Rather than hooking each of the ~10 mutation sites in the review section
  // (duration change, phase add/remove, drag reorder, owner toggle, precondition,
  // rounds stepper, del-row edits, P&M checklist, dates) — where missing one means
  // a silently stale table — we re-fingerprint after any interaction and let the
  // comparison decide. computeFingerprint only reads the DOM, so this is cheap.
  //
  // These run on the bubble phase, after the app's own handlers have updated the
  // DOM. Drag-reorder is the exception: 'dragend' doesn't bubble to document
  // reliably across browsers, so it's captured explicitly.
  ['change', 'click', 'input'].forEach(evt => {
    document.addEventListener(evt, () => setTimeout(refreshStaleState, 0));
  });
  document.addEventListener('dragend', () => setTimeout(refreshStaleState, 0), true);

  // Wire global onclick handlers used by inline HTML attributes
  window.previewPhases    = previewPhases;
  window.addRow           = addRow;
  window.togglePMSection    = togglePMSection;
  window.rebuildPMChecklist = rebuildPMChecklist;
  window.applyPMPostPass    = applyPMPostPass;
  window.setDays          = setDays;
  window.generateTimeline = generateTimeline;
  window.copyEmailTable   = copyEmailTable;
  window.switchTab        = switchTab;
  window.previewPdf       = (type) => previewPdf(type, lastTimelineData);
  window.downloadPdf      = (type) => downloadPdf(type, lastTimelineData);

  // Save button
  document.querySelector('[data-action="save-timeline"]')?.addEventListener('click', async () => {
    // The save path re-reads the DOM and re-runs scheduleTimeline, so if the review
    // section has changed since generate, it would save data that doesn't match the
    // table the user is looking at. Make that explicit rather than silent.
    if (lastFingerprint !== null && computeFingerprint() !== lastFingerprint) {
      const proceed = confirm(
        'The review section has changed since this timeline was generated, so the table above is out of date.\n\n' +
        'Saving now will store the CURRENT phase data, not what is displayed.\n\n' +
        'Regenerate first for these to match. Save anyway?'
      );
      if (!proceed) return;
    }

    const startVal = document.getElementById('startDate').value;
    const dueVal   = document.getElementById('dueDate').value;
    const startDate = nextWorkDay(new Date(startVal + 'T00:00:00'));
    const dueDate   = dueVal ? new Date(dueVal + 'T00:00:00') : null;

    const deliverables         = readDeliverablesFromDOM();
    const phasesPerDeliverable = readPhasesFromDOM();
    const delRows              = [...document.querySelectorAll('#delRows .del-row')];
    const parentIdxMap         = buildParentIdxMap(delRows);
    const result               = scheduleTimeline({ deliverables, phasesPerDeliverable, parentIdxMap, startDate, dueDate });

    await saveTimeline({
      pm:      document.getElementById('pmName').value,
      client:  document.getElementById('clientName').value.trim(),
      project: document.getElementById('projectName').value.trim(),
      startDate, dueDate,
      ...result
    });
  });

  // Clear All
  document.getElementById('clearAllBtn')?.addEventListener('click', clearAll);

  // Bootstrap: load Supabase data then unlock UI
  const ok = await loadReferenceData();
  document.getElementById('loadingOverlay').style.display = 'none';
  if (!ok) {
    document.getElementById('loadingError').style.display = 'flex';
    return;
  }

  // Populate PM name dropdown from Supabase
  const pmSel = document.getElementById('pmName');
  const savedPmVal = localStorage.getItem('flimp_pm') || pmSel.value;
  pmSel.innerHTML = '<option value="">Select PM…</option>';
  PM_NAMES.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    pmSel.appendChild(opt);
  });
  if (savedPmVal) pmSel.value = savedPmVal;

  // Rebuild product selects now that PRODUCTS is populated
  document.querySelectorAll('#delRows .del-row').forEach(r => {
    const sel    = r.querySelector('select');
    const cur    = sel ? sel.value : '';
    const newSel = buildSelect();
    if (cur) newSel.value = cur;
    sel.replaceWith(newSel);
  });
});
