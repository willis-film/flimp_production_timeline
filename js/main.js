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
  recalcBlockFeasibility, togglePMSection, addPMRow,
  refreshPMSelectors, rebuildPMChecklist, applyPMPostPass, readPMConfig, lastEarliestStart,
  wrapDateInput, checkDateFlag, createDateFlagIcon
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
      count:     parseInt(r.querySelector('input[type=number]').value) || 1,
      isRenewal: r.querySelector('.nr-btn.r-active') !== null,
      rounds:    parseInt(r.querySelector('.rounds-val').textContent) || 2
    }))
    .filter(d => d.product);
}

// ── Last generated timeline data — used by PDF renderers ─────────────────
let lastTimelineData = null;

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
    const wrap = wrapDateInput(inputEl);
    const icon = createDateFlagIcon();
    const row  = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px';
    wrap.parentNode.insertBefore(row, wrap);
    row.appendChild(wrap);
    row.appendChild(icon);
    // width:100% from .field input rule applies to the input itself; wrap and row
    // need explicit 100% to fill the field column
    wrap.style.width = '100%';
    row.style.width  = '100%';
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

  // Wire global onclick handlers used by inline HTML attributes
  window.previewPhases    = previewPhases;
  window.addRow           = addRow;
  window.togglePMSection    = togglePMSection;
  window.addPMRow           = addPMRow;
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
