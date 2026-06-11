// ── ui.js ─────────────────────────────────────────────────────────────────
// All DOM-rendering functions for the timeline builder.
// Imports data from database.js and utilities from engine.js.
// Never writes to Supabase directly — delegates to output.js for that.
// ─────────────────────────────────────────────────────────────────────────

import {
  PRODUCTS, NA_PRODUCTS, PM_ELIGIBLE, ROUNDS_DEFAULTS, ALL_PHASES,
  ROUND_GROUPS, PRECONDITIONS, VALID_PARENTS, PRODUCT_META
} from './database.js';

import {
  toISO, isWorkDay, addBusinessDays, nextWorkDay, countBusinessDays,
  subtractBusinessDays, previousWorkDay, getDepth, fmtDateShort, esc,
  buildParentIdxMap, workDays, setDays
} from './engine.js';

// ── Exported for main.js ──────────────────────────────────────────────────
export { setDays };

// ── Date flag helper ──────────────────────────────────────────────────────
// Inserts a 🕶️ indicator next to a date input when the entered date falls on
// a weekend or holiday. The input must be inside a position:relative wrapper
// (class 'date-flag-wrap') — call wrapDateInput() to set that up, or ensure
// the wrapper exists in HTML. Safe to call repeatedly; idempotent.
// iconEl: the span element to show/hide. Created externally and passed in
// so placement in the DOM is fully controlled by the caller.
export function checkDateFlag(inputEl, iconEl) {
  if (!iconEl) return;
  const val = inputEl.value;
  if (!val) { iconEl.style.display = 'none'; return; }
  const d = new Date(val + 'T00:00:00');
  iconEl.style.display = !isWorkDay(d) ? 'block' : 'none';
}

// Creates the standard flag icon span. Caller appends it wherever they want.
export function createDateFlagIcon() {
  const icon = document.createElement('span');
  icon.className = 'date-flag-icon';
  icon.textContent = '🕶️';
  icon.title = 'This date is a weekend or holiday';
  icon.style.cssText = 'font-size:14px;cursor:default;line-height:1;display:none';
  return icon;
}

// Wraps a date input in a .date-flag-wrap div so layout context is preserved.
// Works whether the input is already in the DOM or still detached.
export function wrapDateInput(inputEl) {
  if (inputEl.closest('.date-flag-wrap')) return inputEl.closest('.date-flag-wrap');
  const wrap = document.createElement('div');
  wrap.className = 'date-flag-wrap';
  wrap.style.cssText = 'position:relative;width:100%';
  if (inputEl.parentNode) {
    inputEl.parentNode.insertBefore(wrap, inputEl);
  }
  wrap.appendChild(inputEl);
  return wrap;
}

// ── Product helpers ───────────────────────────────────────────────────────
export function getProductGroup(name) {
  return PRODUCTS.find(g => g.items.includes(name)) || null;
}

export function defaultRounds(product, isRenewal) {
  const r = ROUNDS_DEFAULTS[product];
  if (!r) return 2;
  return isRenewal ? (r.renewal || 2) : (r.new || 2);
}

// ── Compute fixedTotal for a product+isRenewal combination ───────────────
// Only counts fixed round groups whose phases survive the applies_to filter.
// bg initial is applies_to='new' only — so it contributes 0 for renewals.
function fixedRoundTotal(product, isRenewal) {
  return (ROUND_GROUPS[product] || [])
    .filter(rg => rg.is_user_adjustable === false)
    .filter(rg => {
      // Check whether this group has at least one phase that survives the filter
      const groupPhases = (ALL_PHASES[product] || []).filter(p => p.round_group_name === rg.group_name);
      return groupPhases.some(p => {
        if (p.applies_to === 'both')    return true;
        if (p.applies_to === 'new')     return !isRenewal;
        if (p.applies_to === 'renewal') return  isRenewal;
        return true;
      });
    })
    .reduce((s, rg) => s + rg.default_rounds, 0);
}

// ── Deliverable row builder ───────────────────────────────────────────────
export function buildSelect() {
  const sel = document.createElement('select');
  const blank = document.createElement('option');
  blank.value = ''; blank.textContent = 'Select product…';
  sel.appendChild(blank);

  PRODUCTS.forEach(g => {
    const og = document.createElement('optgroup');
    og.label = g.group; og.style.color = g.color;
    g.items.forEach(item => {
      const o = document.createElement('option');
      o.value = item; o.textContent = item; o.style.color = g.color;
      og.appendChild(o);
    });
    sel.appendChild(og);
  });

  sel.addEventListener('change', function () {
    const grp = getProductGroup(this.value);
    this.style.color = grp ? grp.color : 'var(--text)';
    const row = this.closest('.del-row');
    if (!row) return;
    const tog   = row.querySelector('.nr-toggle');
    const isNA  = NA_PRODUCTS.has(this.value);
    tog.classList.toggle('disabled', isNA);
    if (isNA) row.querySelectorAll('.nr-btn').forEach(b => { b.className = 'nr-btn'; });
    const parentWrap = row.querySelector('.parent-sel-wrap');
    if (parentWrap) parentWrap.style.display = VALID_PARENTS[this.value] ? 'block' : 'none';
    refreshParentSelectors();
    refreshPMSelectors();
    if (document.getElementById('pmCheckbox')?.checked) rebuildPMChecklist();
    const rdVal = row.querySelector('.rounds-val');
    if (rdVal) {
      const curIsRenewal = row.querySelector('.nr-btn.r-active') !== null;
      rdVal.textContent = defaultRounds(this.value, curIsRenewal);
    }
  });

  return sel;
}

// Exposed so main.js can include it in lastTimelineData for PDF export
export let lastEarliestStart = null;
// The Gantt computes the authoritative total project span (earliest start → anchor).
// updateFeasibility reads this for the "Days Needed" box instead of re-deriving it,
// so the boxes always agree with the Gantt and the timeline output.
export let lastTotalSpanDays = 0;

export function buildDelRow() {
  const row = document.createElement('div');
  row.className = 'del-row';
  row.appendChild(buildSelect());

  const cnt = document.createElement('input');
  cnt.type = 'number'; cnt.min = 1; cnt.max = 99; cnt.value = 1;
  cnt.style.cssText = 'font-family:Verdana,sans-serif;font-size:14px;height:36px;padding:0 8px;border:1px solid var(--border);border-radius:var(--radius);background:#fff;color:var(--text);text-align:center;width:100%';
  row.appendChild(cnt);

  const tog  = document.createElement('div');
  tog.className = 'nr-toggle';
  const btnN = document.createElement('button');
  btnN.textContent = 'New'; btnN.className = 'nr-btn n-active';
  const btnR = document.createElement('button');
  btnR.textContent = 'Renewal'; btnR.className = 'nr-btn';
  btnN.onclick = () => {
    btnN.className = 'nr-btn n-active'; btnR.className = 'nr-btn';
    const rv = row.querySelector('.rounds-val');
    const s  = row.querySelector('select');
    if (rv && s) rv.textContent = defaultRounds(s.value, false);
    refreshParentSelectors();
  };
  btnR.onclick = () => {
    btnR.className = 'nr-btn r-active'; btnN.className = 'nr-btn';
    const rv = row.querySelector('.rounds-val');
    const s  = row.querySelector('select');
    if (rv && s) rv.textContent = defaultRounds(s.value, true);
    refreshParentSelectors();
  };
  tog.appendChild(btnN); tog.appendChild(btnR);
  row.appendChild(tog);

  // Rounds stepper removed — rounds adjusted in phase review instead
  // Hidden rounds-val preserved so downstream reads don't break
  const rdVal = document.createElement('div');
  rdVal.className = 'rounds-val'; rdVal.style.display = 'none'; rdVal.textContent = '2';
  row.appendChild(rdVal);

  const rm = document.createElement('button');
  rm.className = 'rm-btn'; rm.innerHTML = '&times;'; rm.title = 'Remove deliverable';
  rm.onclick = () => {
    row.remove();
    updateRemove();
    refreshParentSelectors();
    refreshPMSelectors();
    if (document.getElementById('pmCheckbox')?.checked) rebuildPMChecklist();
  };
  row.appendChild(rm);

  const parentWrap = document.createElement('div');
  parentWrap.className = 'parent-sel-wrap';
  parentWrap.style.display = 'none';
  parentWrap.innerHTML = '<div class="ps-inner"><span class="ps-label">Appended to</span><select class="parent-sel"><option value="">Select parent…</option></select></div>';
  row.appendChild(parentWrap);

  return row;
}

export function updateRemove() {
  const rows = document.querySelectorAll('#delRows .del-row');
  rows.forEach(r => {
    r.querySelector('.rm-btn').style.visibility = rows.length > 1 ? 'visible' : 'hidden';
  });
}

export function addRow() {
  document.getElementById('delRows').appendChild(buildDelRow());
  updateRemove();
  if (document.getElementById('pmCheckbox')?.checked) rebuildPMChecklist();
}

// ── Print & Mail section ──────────────────────────────────────────────────
export function togglePMSection() {
  const cb  = document.getElementById('pmCheckbox');
  const sec = document.getElementById('pmSection');
  sec.style.display = cb.checked ? 'block' : 'none';
  if (cb.checked) rebuildPMChecklist();
}

// ── Rebuild the P&M checklist ─────────────────────────────────────────────
// Replaces the old add-row model. Shows one row per eligible deliverable
// currently in section 2. Each row has a checkbox + label + greyed date input.
// The date input only activates when the checkbox is checked.
export function rebuildPMChecklist() {
  const container = document.getElementById('pmRows');
  if (!container) return;

  const delRows      = [...document.querySelectorAll('#delRows .del-row')];
  const parentIdxMap = buildParentIdxMap(delRows);

  // Collect eligible items currently in section 2
  const eligibleItems = [];
  delRows.forEach((row, idx) => {
    const sel = row.querySelector('select');
    if (!sel || !sel.value) return;
    if (!PM_ELIGIBLE.has(sel.value)) return;
    const isRenewal    = row.querySelector('.nr-btn.r-active') !== null;
    const parIdx       = parentIdxMap[idx];
    const parentProduct = parIdx !== null ? delRows[parIdx]?.querySelector('select')?.value : null;
    const label = parentProduct
      ? `${parentProduct} — ${sel.value}${isRenewal ? ' (Renewal)' : ' (New)'}`
      : `${sel.value}${isRenewal ? ' (Renewal)' : ' (New)'}`;
    const value = `${sel.value}||${isRenewal}||${idx}`;
    eligibleItems.push({ label, value, delIdx: idx });
  });

  // Preserve currently checked values and dates before rebuilding
  const prevState = {};
  [...container.querySelectorAll('.pm-check-row')].forEach(row => {
    const cb  = row.querySelector('input[type=checkbox]');
    const dt  = row.querySelector('.pm-delivery-date');
    if (cb?.value) prevState[cb.value] = { checked: cb.checked, date: dt?.value || '' };
  });

  container.innerHTML = '';

  if (!eligibleItems.length) {
    container.innerHTML = '<div style="padding:.5rem .75rem;font-size:12px;color:var(--text-tertiary)">No P&M-eligible deliverables in section 2.</div>';
    refreshPMSelectors();
    return;
  }

  const projectDue = document.getElementById('dueDate')?.value || '';
  const colStyle   = 'display:grid;grid-template-columns:1fr 80px 160px 20px;gap:.5rem;align-items:center;';

  // Header row
  const header = document.createElement('div');
  header.style.cssText = colStyle + 'padding:.3rem .75rem;border-bottom:2px solid var(--border);';
  header.innerHTML = `
    <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-secondary);font-family:Calibri,sans-serif">Deliverable</span>
    <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-secondary);font-family:Calibri,sans-serif;text-align:center">Include P&amp;M</span>
    <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-secondary);font-family:Calibri,sans-serif;text-align:center">Delivery Date</span>
    <span></span>`;
  container.appendChild(header);

  eligibleItems.forEach(({ label, value, delIdx }) => {
    const prev    = prevState[value] || {};
    const checked = prev.checked || false;
    const date    = prev.date || projectDue;

    const row = document.createElement('div');
    row.className = 'pm-check-row';
    row.style.cssText = colStyle + 'padding:.35rem .75rem;border-bottom:1px solid var(--border-light)';

    const lbl = document.createElement('span');
    lbl.textContent = label;
    lbl.style.cssText = 'font-size:13px;color:var(--text);font-family:Calibri,sans-serif';

    const cbWrap = document.createElement('div');
    cbWrap.style.cssText = 'display:flex;justify-content:center;align-items:center';
    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.value   = value;
    cb.checked = checked;
    cb.style.cursor = 'pointer';
    cbWrap.appendChild(cb);

    const dateInp = document.createElement('input');
    dateInp.type       = 'date';
    dateInp.className  = 'pm-delivery-date';
    dateInp.value      = date;
    dateInp.style.cssText = `font-family:Verdana,sans-serif;font-size:13px;height:34px;padding:0 8px;border:1px solid var(--border);border-radius:var(--radius);background:#fff;color:var(--text);width:100%;opacity:${checked ? '1' : '0.35'};pointer-events:${checked ? 'auto' : 'none'}`;

    // Wrap in a relative container for layout consistency
    const dateWrap = wrapDateInput(dateInp);

    // Flag icon — 4th grid cell, shown when date is a weekend or holiday
    const flagIcon = createDateFlagIcon();

    cb.onchange = () => {
      dateInp.style.opacity       = cb.checked ? '1' : '0.35';
      dateInp.style.pointerEvents = cb.checked ? 'auto' : 'none';
      refreshPMSelectors();
      if (document.querySelectorAll('#pbBlocks .pb-block').length) {
        applyPMPostPass();
      }
    };

    dateInp.onchange = () => {
      checkDateFlag(dateInp, flagIcon);
      refreshPMSelectors();
      if (document.querySelectorAll('#pbBlocks .pb-block').length) {
        applyPMPostPass();
      }
    };

    // Check immediately in case the pre-filled date is a weekend/holiday
    checkDateFlag(dateInp, flagIcon);

    row.appendChild(lbl);
    row.appendChild(cbWrap);
    row.appendChild(dateWrap);
    row.appendChild(flagIcon);
    container.appendChild(row);
  });

  refreshPMSelectors();
}

// ── Stub kept for backwards compat — replaced by rebuildPMChecklist ───────
export function buildPMRow() { return document.createElement('div'); }
export function addPMRow()    { rebuildPMChecklist(); }

// ── Refresh PM state — stamps data-pm-delivery on del-rows ────────────────
// Called after checklist changes and after section 2 changes.
export function refreshPMSelectors() {
  const delRows = [...document.querySelectorAll('#delRows .del-row')];

  // Enable/disable PM checkbox based on whether any eligible products exist
  const pmCb    = document.getElementById('pmCheckbox');
  const pmLabel = pmCb?.nextElementSibling;
  const hasEligible = delRows.some(r => {
    const sel = r.querySelector('select');
    return sel?.value && PM_ELIGIBLE.has(sel.value);
  });
  if (pmCb) {
    pmCb.disabled = !hasEligible;
    pmCb.style.opacity = hasEligible ? '1' : '0.35';
    pmCb.style.cursor  = hasEligible ? 'pointer' : 'not-allowed';
  }
  if (pmLabel) {
    pmLabel.style.opacity = hasEligible ? '1' : '0.35';
    pmLabel.style.cursor  = hasEligible ? 'pointer' : 'not-allowed';
  }

  // Stamp data-pm-delivery on del-rows from checked checklist items
  delRows.forEach(r => delete r.dataset.pmDelivery);
  [...document.querySelectorAll('#pmRows .pm-check-row')].forEach(row => {
    const cb      = row.querySelector('input[type=checkbox]');
    const dateInp = row.querySelector('.pm-delivery-date');
    if (!cb?.checked || !dateInp?.value) return;
    const parts  = cb.value.split('||');
    const delIdx = parts[2] !== undefined ? parseInt(parts[2], 10) : null;
    const delRow = delIdx !== null ? delRows[delIdx] : null;
    if (delRow) {
      let deliveryDate = new Date(dateInp.value + 'T00:00:00');
      while (!isWorkDay(deliveryDate)) deliveryDate.setDate(deliveryDate.getDate() - 1);
      delRow.dataset.pmDelivery = toISO(deliveryDate);
    }
  });
}

// Returns array of {product, isRenewal, deliveryDate} for all checked PM items
export function readPMConfig() {
  const cb = document.getElementById('pmCheckbox');
  if (!cb || !cb.checked) return [];
  const delRows = [...document.querySelectorAll('#delRows .del-row')];
  return [...document.querySelectorAll('#pmRows .pm-check-row')]
    .map(row => {
      const checkEl  = row.querySelector('input[type=checkbox]');
      const dateInp  = row.querySelector('.pm-delivery-date');
      if (!checkEl?.checked || !dateInp?.value) return null;
      const parts    = checkEl.value.split('||');
      const delIdx   = parts[2] !== undefined ? parseInt(parts[2], 10) : null;
      const delRow   = delIdx !== null ? delRows[delIdx] : null;
      const product  = delRow?.querySelector('select')?.value || parts[0];
      const isRenewal = delRow
        ? delRow.querySelector('.nr-btn.r-active') !== null
        : parts[1] === 'true';
      return { product, isRenewal, deliveryDate: dateInp.value };
    })
    .filter(Boolean);
}

// ── New phase row builder ─────────────────────────────────────────────────
function buildNewPhaseRow() {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="phase-drag-handle" title="Drag to reorder">⠿</td>
    <td><input class="pt-name" type="text" value="New phase"></td>
    <td style="text-align:center"><span class="owner-badge owner-flimp">Flimp</span></td>
    <td style="text-align:center"><input class="pt-dur" type="number" min="1" max="120" value="3"></td>
    <td class="phase-end-date" style="text-align:center;font-size:11px;color:var(--text-muted);white-space:nowrap">—</td>
    <td style="text-align:center"><button class="phase-rm-btn" title="Remove phase">&times;</button></td>`;
  return tr;
}

// ── Parent selector ───────────────────────────────────────────────────────
function getRowLabel(row) {
  const sel = row.querySelector('select');
  if (!sel || !sel.value) return null;
  const isRenewal = row.querySelector('.nr-btn.r-active') !== null;
  return { product: sel.value, label: sel.value + (isRenewal ? ' (Renewal)' : ' (New)') };
}

export function refreshParentSelectors() {
  const allRows = [...document.querySelectorAll('#delRows .del-row')];
  allRows.forEach(row => {
    const parentWrap = row.querySelector('.parent-sel-wrap');
    if (!parentWrap) return;
    const sel = row.querySelector('select');
    if (!sel || !sel.value || !VALID_PARENTS[sel.value]) {
      parentWrap.style.display = 'none'; return;
    }
    parentWrap.style.display = 'block';
    const validParentSet = VALID_PARENTS[sel.value];
    const parentSel = parentWrap.querySelector('.parent-sel');
    const curVal    = parentSel.value;

    const options = [], labelCounts = {};
    allRows.forEach((otherRow, rowIndex) => {
      if (otherRow === row) return;
      const info = getRowLabel(otherRow);
      if (!info || !validParentSet.has(info.product)) return;
      labelCounts[info.label] = (labelCounts[info.label] || 0) + 1;
      options.push({ product: info.product, label: info.label, idx: labelCounts[info.label], rowIndex });
    });
    const finalOptions = options.map(o => ({
      ...o,
      label: labelCounts[o.label] > 1 ? o.label + ' ' + o.idx : o.label
    }));

    parentSel.innerHTML = '<option value="">Select parent deliverable…</option>';
    finalOptions.forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.rowIndex; opt.textContent = o.label; opt.dataset.product = o.product;
      if (String(o.rowIndex) === curVal) opt.selected = true;
      parentSel.appendChild(opt);
    });
    if (finalOptions.length === 1) parentSel.value = String(finalOptions[0].rowIndex);
  });
}

// ── Appended days helper ──────────────────────────────────────────────────
// Returns the longest child chain (in business days) hanging off parentDelIdx.
// Children run in parallel after the parent ends, so the offset is the MAX
// child chain length, not the sum. Recurses into grandchildren.
function getAppendedDays(parentDelIdx) {
  const allDelRows   = [...document.querySelectorAll('#delRows .del-row')];
  const allBlocks    = [...document.querySelectorAll('#pbBlocks .pb-block')];
  const parentIdxMap = buildParentIdxMap(allDelRows);

  // Longest sequential chain starting from block at idx (production days only — excludes P&M rows)
  function longestChainFrom(idx) {
    const block = allBlocks.find(b => parseInt(b.dataset.delIdx) === idx);
    if (!block) return 0;
    const days = [...block.querySelectorAll('.phase-table tbody tr')]
      .filter(tr => !tr.querySelector('.pt-name')?.value.startsWith('Print & Mail'))
      .reduce((s, tr) => s + Math.max(0, parseInt(tr.querySelector('.pt-dur')?.value) || 0), 0);
    const children = allDelRows.map((_, j) => j).filter(j => parentIdxMap[j] === idx);
    if (!children.length) return days;
    return days + Math.max(...children.map(j => longestChainFrom(j)));
  }

  const directChildren = allDelRows.map((_, j) => j).filter(j => parentIdxMap[j] === parentDelIdx);
  if (!directChildren.length) return 0;
  return Math.max(...directChildren.map(j => longestChainFrom(j)));
}

// ── Phase row drag-and-drop ───────────────────────────────────────────────
// Drag only initiates from the ⠿ handle cell — grabbing anywhere else on
// the row (name input, duration field, etc.) does not trigger reorder.
function makePhaseTbodyDraggable(tbody, block) {
  let dragSrc = null;

  tbody.querySelectorAll('tr').forEach(row => {
    // draggable starts as false; the handle enables it on mousedown only
    row.draggable = false;

    const handle = row.querySelector('.phase-drag-handle');
    if (handle) {
      handle.addEventListener('mousedown', () => { row.draggable = true; });
      handle.addEventListener('mouseup',   () => { row.draggable = false; });
    }

    row.addEventListener('dragstart', e => {
      if (!row.draggable) { e.preventDefault(); return; }
      dragSrc = row;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    row.addEventListener('dragend', () => {
      row.draggable = false;
      row.classList.remove('dragging');
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));
      dragSrc = null;
      recalcPhaseDates(block);
      recalcBlockFeasibility(block);
    });

    row.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));
      if (row !== dragSrc) row.classList.add('drag-over');
    });

    row.addEventListener('drop', e => {
      e.preventDefault();
      if (!dragSrc || dragSrc === row) return;
      row.classList.remove('drag-over');
      const rect = row.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        tbody.insertBefore(dragSrc, row);
      } else {
        tbody.insertBefore(dragSrc, row.nextSibling);
      }
    });
  });
}

// ── Rebuild phase table ───────────────────────────────────────────────────
export function rebuildPhaseTable(block, skipPhases) {
  const product   = block.dataset.product;
  const isRenewal = block.dataset.isrenewal === 'true';
  const rounds    = parseInt(block.dataset.rounds) || 2;
  const isNA      = NA_PRODUCTS.has(product);

  let phases = (ALL_PHASES[product] || []).map(p => ({ ...p }));

  phases = phases
    .filter(p => {
      if (p.applies_to === 'both')    return true;
      if (p.applies_to === 'new')     return !isRenewal;
      if (p.applies_to === 'renewal') return  isRenewal;
      return true;
    })
    .map(p => {
      if (isRenewal && p.renewal_phase_name && p.renewal_phase_name.trim()) {
        return { ...p, name: p.renewal_phase_name.trim() };
      }
      return p;
    });

  if (skipPhases && skipPhases.size > 0) {
    phases = phases.filter(p => !skipPhases.has(p.name));
  }

  // Expand round groups — rounds is the outer loop, phases inner,
  // so output is: Rd1Phase1, Rd1Phase2, Rd2Phase1, Rd2Phase2 (interleaved)
  const expanded = [];
  const roundGroupDefs = ROUND_GROUPS[product] || [];
  const usedGroups = new Set();

  phases.forEach(p => {
    if (!p.round_group_name) { expanded.push(p); return; }
    if (usedGroups.has(p.round_group_name)) return; // already expanded this group
    usedGroups.add(p.round_group_name);

    const rgDef = roundGroupDefs.find(rg => rg.group_name === p.round_group_name);
    const fixedTotal = fixedRoundTotal(product, isRenewal);
    const rCount = (rgDef && rgDef.is_user_adjustable === false)
      ? rgDef.default_rounds
      : Math.max(1, rounds - fixedTotal);

    const groupPhases = phases.filter(gp => gp.round_group_name === p.round_group_name);
    for (let r = 1; r <= rCount; r++) {
      groupPhases.forEach(gp => {
        const baseName = rCount > 1 ? `${gp.name} Rd ${r}` : gp.name;
        expanded.push({ ...gp, name: baseName });
      });
    }
  });

  const tbody = block.querySelector('.phase-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  // Update table header to include drag handle column
  const thead = block.querySelector('.phase-table thead');
  if (thead) thead.innerHTML = '<tr><th style="width:22px"></th><th>Phase</th><th style="text-align:center">Owner</th><th style="text-align:center">Days</th><th style="text-align:center">Ends</th><th></th></tr>';

  expanded.forEach(phase => {
    const tr = document.createElement('tr');
    const ownerClass = phase.owner === 'Client' ? 'owner-client' : 'owner-flimp';
    tr.dataset.isMilestone = phase.is_milestone ? 'true' : 'false';
    tr.innerHTML = `
      <td class="phase-drag-handle" title="Drag to reorder">⠿</td>
      <td><input class="pt-name" type="text" value="${esc(phase.name)}"></td>
      <td style="text-align:center"><span class="owner-badge ${ownerClass}">${esc(phase.owner)}</span></td>
      <td style="text-align:center"><input class="pt-dur" type="number" min="1" max="120" value="${phase.dur}"></td>
      <td class="phase-end-date" style="text-align:center;font-size:11px;color:var(--text-secondary);white-space:nowrap">—</td>
      <td style="text-align:center"><button class="phase-rm-btn" title="Remove phase">&times;</button></td>`;

    const durInp = tr.querySelector('.pt-dur');
    durInp.addEventListener('change', () => { updateFeasibility(); recalcPhaseDates(block); recalcBlockFeasibility(block); });

    const rmBtn = document.createElement('button');
    rmBtn.className = 'phase-rm-btn'; rmBtn.textContent = '×';
    rmBtn.onclick = () => { tr.remove(); updateFeasibility(); recalcPhaseDates(block); recalcBlockFeasibility(block); };
    tr.querySelector('.phase-rm-btn').replaceWith(rmBtn);

    tbody.appendChild(tr);
  });

  makePhaseTbodyDraggable(tbody, block);

  const subtitle = block.querySelector('.pb-title-sub');
  if (subtitle) {
    const grp = getProductGroup(product);
    const variantLabel = isNA ? '' : (isRenewal ? ' &bull; Renewal' : ' &bull; New');
    subtitle.innerHTML = `${esc(grp ? grp.group : '')}${variantLabel} &middot; ${expanded.length} phases`;
  }

  // rebuildPhaseTable regenerates phases from ALL_PHASES, which does NOT include the
  // appended Print & Mail row (that's added by applyPMPostPass). If this block is in a
  // PM chain, the rebuild just dropped its P&M row — re-run the post-pass to re-append
  // it, otherwise recalcPhaseDates can't find the P&M row and the production/P&M gate
  // separation is lost. applyPMPostPass handles recalc + feasibility + Gantt itself.
  if (block.dataset.pmChain === 'true') {
    applyPMPostPass();
    return;
  }

  updateFeasibility();
  recalcPhaseDates(block);
  recalcBlockFeasibility(block);
}

// ── Phase preview ─────────────────────────────────────────────────────────
export function previewPhases() {
  const sdVal = document.getElementById('startDate').value;

  // Due date is mandatory — the whole schedule anchors backward from it.
  const ddEl  = document.getElementById('dueDate');
  if (!ddEl.value) {
    alert('Please enter a due date before previewing phases.');
    ddEl.focus();
    return;
  }

  const rows  = [...document.querySelectorAll('#delRows .del-row')];
  const deliverables = rows.map((r, rowIdx) => ({
    product:   r.querySelector('select').value,
    count:     parseInt(r.querySelector('input[type=number]').value) || 1,
    isRenewal: r.querySelector('.nr-btn.r-active') !== null,
    rounds:    parseInt(r.querySelector('.rounds-val').textContent) || 2,
    delIdx:    rowIdx
  })).filter(d => d.product);

  if (!deliverables.length) { alert('Please select at least one product.'); return; }

  const container = document.getElementById('pbBlocks');
  container.innerHTML = '';
  let blockIndex = 0;

  deliverables.forEach(del => {
    const grp = getProductGroup(del.product);
    const dot = grp ? grp.color : '#888';
    const isRenewal = del.isRenewal;
    const isNA      = NA_PRODUCTS.has(del.product);

    let phases = JSON.parse(JSON.stringify(ALL_PHASES[del.product] || []));
    phases = phases
      .filter(p => {
        if (p.applies_to === 'both') return true;
        if (p.applies_to === 'new')     return !isRenewal;
        if (p.applies_to === 'renewal') return  isRenewal;
        return true;
      })
      .map(p => {
        if (isRenewal && p.renewal_phase_name && p.renewal_phase_name.trim()) {
          return { ...p, name: p.renewal_phase_name.trim() };
        }
        return p;
      });

    // Expand round groups — rounds outer, phases inner for correct interleaving
    const roundGroupDefs = ROUND_GROUPS[del.product] || [];
    const expanded = [];
    const usedGroups = new Set();

    phases.forEach(p => {
      if (!p.round_group_name) { expanded.push(p); return; }
      if (usedGroups.has(p.round_group_name)) return;
      usedGroups.add(p.round_group_name);

      const rgDef = roundGroupDefs.find(rg => rg.group_name === p.round_group_name);
      const fixedTotal = fixedRoundTotal(del.product, del.isRenewal);
      const rCount = (rgDef && rgDef.is_user_adjustable === false)
        ? rgDef.default_rounds
        : Math.max(1, del.rounds - fixedTotal);

      const groupPhases = phases.filter(gp => gp.round_group_name === p.round_group_name);
      const OFFSET_GROUPS   = ['bground', 'cust bg round'];
      const OFFSET_PRODUCTS = ['Premium Guide', 'Custom Guide'];
      const startRound = (OFFSET_GROUPS.includes(p.round_group_name) && OFFSET_PRODUCTS.includes(del.product)) ? 3 : 1;
      for (let r = startRound; r < startRound + rCount; r++) {
        groupPhases.forEach(gp => {
          const baseName = (rCount > 1 || startRound > 1) ? `${gp.name} Rd ${r}` : gp.name;
          expanded.push({ ...gp, name: baseName });
        });
      }
    });

    const block = document.createElement('div');
    block.className = 'pb-block';
    block.dataset.product   = del.product;
    block.dataset.isrenewal = del.isRenewal;
    block.dataset.rounds    = del.rounds;
    block.dataset.delIdx    = del.delIdx;
    block.dataset.confirmed = 'false';

    // Header
    const hdr = document.createElement('div');
    hdr.className = 'pb-header';

    // Rounds stepper (for phase-group products)
    const roundGroupDef = (ROUND_GROUPS[del.product] || []).find(rg => rg.is_user_adjustable);
    let blockRoundsStepper = null;
    if (roundGroupDef && !isNA) {
      const rsWrap = document.createElement('div');
      rsWrap.className = 'pb-rounds-wrap';
      const rsLabel = document.createElement('span');
      rsLabel.className = 'pb-rounds-label'; rsLabel.textContent = 'Rounds';
      const rsStepper = document.createElement('div');
      rsStepper.className = 'rounds-stepper pb-rounds-stepper';
      const rsMinus = document.createElement('button');
      rsMinus.className = 'rounds-btn'; rsMinus.textContent = '−';
      const rsVal = document.createElement('div');
      rsVal.className = 'rounds-val'; rsVal.textContent = del.rounds;
      const rsPlus = document.createElement('button');
      rsPlus.className = 'rounds-btn'; rsPlus.textContent = '+';
      rsMinus.onclick = e => {
        e.stopPropagation();
        const cur = parseInt(block.dataset.rounds) || 2;
        if (cur <= 1) return;
        const next = cur - 1;
        rsVal.textContent = next; block.dataset.rounds = next;
        const checkedPhases = new Set([...block.querySelectorAll('.pb-preconditions input[type=checkbox]:checked')].map(c => c.dataset.phaseName));
        rebuildPhaseTable(block, checkedPhases);
      };
      rsPlus.onclick = e => {
        e.stopPropagation();
        const cur = parseInt(block.dataset.rounds) || 2;
        if (cur >= 20) return;
        const next = cur + 1;
        rsVal.textContent = next; block.dataset.rounds = next;
        const checkedPhases = new Set([...block.querySelectorAll('.pb-preconditions input[type=checkbox]:checked')].map(c => c.dataset.phaseName));
        rebuildPhaseTable(block, checkedPhases);
      };
      rsStepper.appendChild(rsMinus); rsStepper.appendChild(rsVal); rsStepper.appendChild(rsPlus);
      rsWrap.appendChild(rsLabel); rsWrap.appendChild(rsStepper);
      blockRoundsStepper = rsWrap;
    }

    // Confirm toggle
    const confirmWrap = document.createElement('div');
    confirmWrap.className = 'confirm-wrap';
    const confirmBox = document.createElement('div');
    confirmBox.className = 'pb-confirm';
    const confirmLabel = document.createElement('span');
    confirmLabel.className = 'confirm-label'; confirmLabel.textContent = 'Confirmed';
    confirmBox.addEventListener('click', e => {
      e.stopPropagation();
      const confirmed = block.dataset.confirmed !== 'true';
      block.dataset.confirmed = confirmed ? 'true' : 'false';
      confirmBox.classList.toggle('confirmed', confirmed);
      const body = block.querySelector('.pb-body');
      if (confirmed) {
        body.classList.remove('open');
        chevron.classList.remove('open');
      } else {
        body.classList.add('open');
        chevron.classList.add('open');
      }
      updateGenerateBtn();
    });
    confirmWrap.appendChild(confirmBox); confirmWrap.appendChild(confirmLabel);

    // Title wrap
    const titleWrap = document.createElement('div');
    titleWrap.className = 'pb-title-wrap';
    const isLeaf = !!VALID_PARENTS[del.product];

    // For child/grandchild blocks, show which parent they are attached to
    const _allDelRows   = [...document.querySelectorAll('#delRows .del-row')];
    const _parentIdxMap = buildParentIdxMap(_allDelRows);
    const _parentIdx    = _parentIdxMap[del.delIdx];
    const _parentProduct = (_parentIdx !== null && _parentIdx !== undefined)
      ? _allDelRows[_parentIdx]?.querySelector('select')?.value
      : null;
    const parentLabel = _parentProduct ? `: ${esc(_parentProduct)}` : '';
    const renewalLabel = isNA ? '' : (isRenewal ? ' (Renewal)' : ' (New)');

    titleWrap.innerHTML = `
      <div class="pb-title">
        <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${esc(dot)};margin-right:6px;vertical-align:middle"></span>${esc(del.product)}<span class="pb-title-sub">${parentLabel}${renewalLabel}, ${expanded.length} phases</span>
      </div>
      <div class="pb-dates" style="min-height:16px"><span class="pb-total-days" style="font-size:13px;font-weight:700;color:var(--text-secondary);margin-right:8px"></span><span class="pb-date-starts"></span><span class="pb-date-sep" style="display:none">→</span><span class="pb-date-ends"></span></div>
      <div class="pb-feas"${isLeaf ? ' style="display:none"' : ''}><div class="pb-feas-bar-track"><div class="pb-feas-bar-fill"></div></div><div class="pb-feas-diff"></div></div>`;

    const chevron = document.createElement('div');
    chevron.className = 'pb-chevron open';
    chevron.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M4 6l4 4 4-4"/></svg>`;

    hdr.appendChild(titleWrap);
    hdr.appendChild(chevron);
    if (blockRoundsStepper) hdr.appendChild(blockRoundsStepper);
    hdr.appendChild(confirmWrap);
    hdr.addEventListener('click', () => {
      const body = block.querySelector('.pb-body');
      const open = body.classList.toggle('open');
      chevron.classList.toggle('open', open);
    });

    // Body
    const body = document.createElement('div');
    body.className = 'pb-body open';

    // Preconditions checklist
    const precondList = (PRECONDITIONS[del.product] || []).filter(pc => {
      if (!pc.applies_to || pc.applies_to === 'both') return true;
      if (pc.applies_to === 'new')     return !isRenewal;
      if (pc.applies_to === 'renewal') return  isRenewal;
      return true;
    });
    if (precondList.length > 0) {
      const pcStrip = document.createElement('div');
      pcStrip.className = 'pb-preconditions';
      const pcLabel = document.createElement('span');
      pcLabel.className = 'pb-preconditions-label'; pcLabel.textContent = 'Already done:';
      pcStrip.appendChild(pcLabel);

      precondList.forEach(pc => {
        const item = document.createElement('label');
        item.className = 'pc-item';
        item.title = `Check if "${pc.checklist_label}" is already complete — removes "${pc.phase_name}" phase`;
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.dataset.phaseName = pc.phase_name;
        cb.addEventListener('change', e => {
          e.stopPropagation();
          item.classList.toggle('pc-checked', cb.checked);
          const checkedPhases = new Set([...pcStrip.querySelectorAll('input[type=checkbox]:checked')].map(c => c.dataset.phaseName));
          rebuildPhaseTable(block, checkedPhases);
        });
        const cbText = document.createElement('span');
        cbText.textContent = pc.checklist_label;
        item.appendChild(cb); item.appendChild(cbText);
        pcStrip.appendChild(item);
      });
      body.appendChild(pcStrip);
    }

    // Phase table
    const table   = document.createElement('table');
    table.className = 'phase-table';
    const thead   = document.createElement('thead');
    thead.innerHTML = '<tr><th style="width:22px"></th><th>Phase</th><th style="text-align:center">Owner</th><th style="text-align:center">Days</th><th style="text-align:center">Ends</th><th></th></tr>';
    const tbody   = document.createElement('tbody');

    expanded.forEach(phase => {
      const tr = document.createElement('tr');
      tr.dataset.isMilestone = phase.is_milestone ? 'true' : 'false';
      const ownerClass = phase.owner === 'Client' ? 'owner-client' : 'owner-flimp';
      tr.innerHTML = `
        <td class="phase-drag-handle" title="Drag to reorder">⠿</td>
        <td><input class="pt-name" type="text" value="${esc(phase.name)}"></td>
        <td style="text-align:center"><span class="owner-badge ${ownerClass}">${esc(phase.owner)}</span></td>
        <td style="text-align:center"><input class="pt-dur" type="number" min="1" max="120" value="${phase.dur}"></td>
        <td class="phase-end-date" style="text-align:center;font-size:11px;color:var(--text-secondary);white-space:nowrap">—</td>
        <td style="text-align:center"><button class="phase-rm-btn" title="Remove phase">&times;</button></td>`;

      const durInp = tr.querySelector('.pt-dur');
      durInp.addEventListener('change', () => { updateFeasibility(); recalcPhaseDates(block); recalcBlockFeasibility(block); });

      const rmBtn2 = tr.querySelector('.phase-rm-btn');
      rmBtn2.onclick = () => { tr.remove(); updateFeasibility(); recalcPhaseDates(block); recalcBlockFeasibility(block); };

      tbody.appendChild(tr);
    });

    table.appendChild(thead); table.appendChild(tbody);
    body.appendChild(table);
    makePhaseTbodyDraggable(tbody, block);

    // Add phase button
    const addPhaseBtn = document.createElement('button');
    addPhaseBtn.className = 'add-phase-btn'; addPhaseBtn.textContent = '+ Add phase';
    addPhaseBtn.onclick = () => {
      const newRow = buildNewPhaseRow();
      tbody.appendChild(newRow);
      newRow.querySelector('.pt-dur').addEventListener('change', () => { updateFeasibility(); recalcPhaseDates(block); recalcBlockFeasibility(block); });
      newRow.querySelector('.phase-rm-btn').onclick = () => { newRow.remove(); updateFeasibility(); recalcPhaseDates(block); recalcBlockFeasibility(block); };
      newRow.querySelector('.pt-name').focus();
      newRow.querySelector('.pt-name').select();
      // Re-wire all rows for drag since new row was appended
      makePhaseTbodyDraggable(tbody, block);
      updateFeasibility(); recalcPhaseDates(block); recalcBlockFeasibility(block);
    };
    body.appendChild(addPhaseBtn);

    block.appendChild(hdr); block.appendChild(body);
    container.appendChild(block);
    recalcPhaseDates(block); recalcBlockFeasibility(block);
    blockIndex++;
  });

  // Second pass: recalculate all blocks now that the full chain is in the DOM.
  // The first pass above may have produced wrong dates because sibling/child
  // blocks didn't exist yet — getAppendedDays and the translation gate both
  // need all blocks present to resolve correctly.
  [...container.querySelectorAll('.pb-block')].forEach(block => {
    recalcPhaseDates(block);
    recalcBlockFeasibility(block);
  });

  // Post-pass: remove Distribution from parents that have appended items
  refreshParentSelectors();
  refreshPMSelectors(); // stamp data-pm-delivery on del-rows before the timeout reads them
  setTimeout(() => applyPMPostPass(), 50);

  document.getElementById('phasePreviewSection').style.display = 'block';
  updateGenerateBtn();
  // If PM is active, skip the Gantt render here — applyPMPostPass (above) will call
  // updateGantt after stamping pmChain/pmDelivery on blocks, ensuring a single correct render.
  // Without PM, render immediately so the Gantt appears without any delay.
  if (!document.getElementById('pmCheckbox')?.checked) updateGantt();
  document.getElementById('phasePreviewSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── PM post-pass — callable independently of previewPhases ───────────────
// Appends P&M phase rows to all blocks in a PM-configured chain and stamps
// block.dataset.pmDelivery. Safe to call multiple times (idempotent via
// existingPM check). Called by previewPhases (via setTimeout) and by the
// checklist checkbox onchange.
export function applyPMPostPass() {
  const allDelRows   = [...document.querySelectorAll('#delRows .del-row')];
  const parentIdxMap = buildParentIdxMap(allDelRows);
  const blocks       = [...document.querySelectorAll('#pbBlocks .pb-block')];

  function stripDistribution(block) {
    const rows2 = [...block.querySelectorAll('tbody tr')];
    for (let i = rows2.length - 1; i >= 0; i--) {
      const nameInput = rows2[i].querySelector('.pt-name');
      if (nameInput && nameInput.value.toLowerCase().includes('distribution')) {
        rows2[i].remove(); recalcPhaseDates(block); recalcBlockFeasibility(block); break;
      }
    }
  }

  // Strip Distribution from parent blocks
  const parentIndicesWithAppended = new Set();
  allDelRows.forEach((row, i) => {
    if (parentIdxMap[i] !== null && parentIdxMap[i] !== undefined) {
      parentIndicesWithAppended.add(parentIdxMap[i]);
    }
  });
  parentIndicesWithAppended.forEach(parentIdx => {
    const parentRow = allDelRows[parentIdx];
    if (!parentRow) return;
    const parentProduct   = parentRow.querySelector('select')?.value;
    const parentIsRenewal = parentRow.querySelector('.nr-btn.r-active') !== null;
    if (!parentProduct) return;
    const block = blocks.find(b => parseInt(b.dataset.delIdx) === parentIdx);
    if (block) stripDistribution(block);
  });

  // ── PM chain post-pass ──────────────────────────────────────────────────
  function getChainRootIdx(idx) {
    let cur = idx, safety = 0;
    while (parentIdxMap[cur] !== null && parentIdxMap[cur] !== undefined && safety++ < 20) {
      cur = parentIdxMap[cur];
    }
    return cur;
  }

  // Collect delivery dates per chain root from checked items only.
  // If all checked items in a chain share the same date, use that date for all.
  // If checked items have different dates, each item uses its own date.
  const pmDeliveryByRoot = {};   // rootIdx → date string (only set when all dates agree)
  const pmDatesPerRoot   = {};   // rootIdx → Set of date strings
  allDelRows.forEach((row, i) => {
    if (!row.dataset.pmDelivery) return;
    const rootIdx = getChainRootIdx(i);
    if (!pmDatesPerRoot[rootIdx]) pmDatesPerRoot[rootIdx] = new Set();
    pmDatesPerRoot[rootIdx].add(row.dataset.pmDelivery);
  });
  // Only populate pmDeliveryByRoot when all checked items share a single date
  Object.entries(pmDatesPerRoot).forEach(([rootIdx, dates]) => {
    if (dates.size === 1) pmDeliveryByRoot[rootIdx] = [...dates][0];
    // size > 1 → dates differ → each item will use its own row.dataset.pmDelivery
  });

  allDelRows.forEach((row, i) => {
    // Only apply P&M to rows that were individually checked in section 2.1
    if (!row.dataset.pmDelivery) return;
    const rootIdx = getChainRootIdx(i);
    // Use shared chain date if all items agree, otherwise fall back to this item's own date
    const pmDelivery = pmDeliveryByRoot[rootIdx] || row.dataset.pmDelivery;
    if (!pmDelivery) return;

    const product   = row.querySelector('select')?.value;
    const isRenewal = row.querySelector('.nr-btn.r-active') !== null;
    if (!product) return;
    if (product === 'Print & Mail') return;

    const block = blocks.find(b => parseInt(b.dataset.delIdx) === i);
    if (!block) return;

    block.dataset.pmChain    = 'true';
    block.dataset.pmDelivery = pmDelivery;

    stripDistribution(block);

    const existingPM = [...block.querySelectorAll('.pt-name')]
      .find(inp => inp.value.startsWith('Print & Mail'));
    if (!existingPM) {
      const tbody = block.querySelector('.phase-table tbody');
      if (tbody) {
        const tr = document.createElement('tr');
        tr.dataset.isPmPhase = 'true';
        tr.innerHTML = `
          <td class="phase-drag-handle" title="Drag to reorder">⠿</td>
          <td><input class="pt-name" type="text" value="Print &amp; Mail"></td>
          <td style="text-align:center"><span class="owner-badge owner-flimp">Flimp</span></td>
          <td style="text-align:center"><input class="pt-dur" type="number" min="1" max="120" value="10"></td>
          <td class="phase-end-date" style="text-align:center;font-size:11px;color:var(--text-secondary);white-space:nowrap">—</td>
          <td style="text-align:center"><button class="phase-rm-btn" title="Remove phase">&times;</button></td>`;
        tr.querySelector('.pt-dur').addEventListener('change', () => {
          updateFeasibility(); recalcPhaseDates(block); recalcBlockFeasibility(block);
        });
        tr.querySelector('.phase-rm-btn').onclick = () => {
          tr.remove();
          delete block.dataset.pmChain;
          delete block.dataset.pmDelivery;
          updateFeasibility(); recalcPhaseDates(block); recalcBlockFeasibility(block);
        };
        tbody.appendChild(tr);
      }
    }

    recalcPhaseDates(block);
    recalcBlockFeasibility(block);
  });

  updateFeasibility();
  updateGantt();
}

// ── Per-block feasibility ─────────────────────────────────────────────────
// ── Get the pb-block that is the parent of a given block (or null) ────────
function getParentBlock(block) {
  const allDelRows = [...document.querySelectorAll('#delRows .del-row')];
  const allBlocks  = [...document.querySelectorAll('#pbBlocks .pb-block')];
  const parentIdxMap = buildParentIdxMap(allDelRows);

  // Use the stamped delIdx — unambiguous even when duplicate products exist
  const blockDelIdx = parseInt(block.dataset.delIdx);
  if (isNaN(blockDelIdx)) return null;

  const parentDelIdx = parentIdxMap[blockDelIdx];
  if (parentDelIdx === null || parentDelIdx === undefined) return null;

  return allBlocks.find(b => parseInt(b.dataset.delIdx) === parentDelIdx) || null;
}

// ── Shared helper: get effective due date for a block ────────────────────
// ── Production-end date of a block, for gating its children ────────────────
// A child must start when its parent's PRODUCTION completes — not when the
// parent's P&M ships. For a PM parent, getEffectiveDue() returns pmDelivery
// (correct for the parent's own phases, which end at the mail date), but using
// that to gate a child would push the child past the delivery date.
//
// This returns the same productionDue that recalcPhaseDates uses to end the
// block's production phases:
//   PM block      → chainPmStart - appendedDays
//                   where chainPmStart = (latest delivery in chain) - pmDur,
//                   and appendedDays is the longest child chain. The appendedDays
//                   gap is exactly the window the children run in, so gating a
//                   child here lands it after production and finishing by chainPmStart.
//   non-PM block  → its effective due (unchanged)
// Returns a Date or null.
function productionEndOf(block) {
  const pmDelivery = block.dataset.pmDelivery
    || (() => {
      const r = [...document.querySelectorAll('#delRows .del-row')][parseInt(block.dataset.delIdx)];
      return r?.dataset.pmDelivery;
    })();
  if (pmDelivery) {
    const pmInp = [...block.querySelectorAll('.pt-name')].find(x => x.value.startsWith('Print & Mail'));
    const pmDur = pmInp ? (Math.max(1, parseInt(pmInp.closest('tr')?.querySelector('.pt-dur')?.value) || 10)) : 10;

    // Chain-wide latest delivery (mirrors recalcPhaseDates) so siblings sharing a
    // chain use one production anchor even when their delivery dates differ.
    const allBlocks    = [...document.querySelectorAll('#pbBlocks .pb-block')];
    const allDelRows   = [...document.querySelectorAll('#delRows .del-row')];
    const parentIdxMap = buildParentIdxMap(allDelRows);
    const thisDelIdx   = parseInt(block.dataset.delIdx);
    const chainRootOf  = idx => { let c = idx, n = 0; while (parentIdxMap[c] !== null && parentIdxMap[c] !== undefined && n++ < 20) c = parentIdxMap[c]; return c; };
    const chainRoot    = chainRootOf(thisDelIdx);
    let latestDelivery = new Date(pmDelivery + 'T00:00:00');
    allBlocks.forEach(b => {
      if (!b.dataset.pmDelivery || !b.dataset.pmChain) return;
      if (chainRootOf(parseInt(b.dataset.delIdx)) !== chainRoot) return;
      const d = new Date(b.dataset.pmDelivery + 'T00:00:00');
      if (d > latestDelivery) latestDelivery = d;
    });

    const chainPmStart = subtractBusinessDays(latestDelivery, pmDur);
    const appendedDays = getAppendedDays(thisDelIdx);
    return appendedDays > 0 ? subtractBusinessDays(chainPmStart, appendedDays) : chainPmStart;
  }
  return getEffectiveDue(block);
}

// For PM chain blocks: pmDelivery is the hard ceiling (stamped on block in post-pass)
// For regular parents/standalones: project due date - appended child days
// For child blocks: parent's effective due + child's own days, so counting
// backward by child days always lands on the parent's end date regardless
// of child duration. This ensures parallel children share the same start date.
// Returns a Date or null.
function getEffectiveDue(block) {
  const bp  = block.dataset.product;
  const bir = block.dataset.isrenewal === 'true';
  const dueVal = document.getElementById('dueDate').value;

  // PM chain blocks have pmDelivery stamped directly on block.dataset by post-pass
  const blockPmDelivery = block.dataset.pmDelivery;
  if (blockPmDelivery) {
    return new Date(blockPmDelivery + 'T00:00:00');
  }

  // Fall back to del-row pmDelivery for the initial render window (before applyPMPostPass
  // has stamped block.dataset.pmDelivery). Use delIdx for an exact row lookup — matching
  // by product+isRenewal would pick the wrong row if the same product appears twice.
  const allDelRows = [...document.querySelectorAll('#delRows .del-row')];
  const matchedRow = allDelRows[parseInt(block.dataset.delIdx)];
  const pmDelivery = matchedRow?.dataset.pmDelivery;
  if (pmDelivery) {
    return new Date(pmDelivery + 'T00:00:00');
  }

  if (!dueVal) return null;

  // Child blocks: effective due = gateBlock's effective due + this block's own days.
  // Counting backward by blockDays from that date lands exactly on the gate's end date.
  // For most blocks the gate is the direct parent. For translations, it may be an
  // alternate sibling — mirroring the engine's latestAlternateEndInChain logic:
  // if any alternate sibling has translation children, all translations in the chain
  // wait for the latest such alternate to complete before starting.
  const parentBlock = getParentBlock(block);
  if (parentBlock) {
    let gateBlock = parentBlock;

    if (PRODUCT_META[block.dataset.product]?.scheduleType === 'translation') {
      const allDelRows   = [...document.querySelectorAll('#delRows .del-row')];
      const allBlocks    = [...document.querySelectorAll('#pbBlocks .pb-block')];
      const parentIdxMap = buildParentIdxMap(allDelRows);
      const thisIdx      = parseInt(block.dataset.delIdx);
      const parentIdx    = parentIdxMap[thisIdx];

      allDelRows.forEach((_, j) => {
        if (j === thisIdx || parentIdxMap[j] !== parentIdx) return; // must be a sibling
        const sibBlock = allBlocks.find(b => parseInt(b.dataset.delIdx) === j);
        if (!sibBlock) return;
        if (PRODUCT_META[sibBlock.dataset.product]?.scheduleType !== 'alternate') return;
        // Only gate if this alternate sibling has at least one translation child
        const hasTransChild = allDelRows.some((_, k) => {
          if (parentIdxMap[k] !== j) return false;
          const cb = allBlocks.find(b => parseInt(b.dataset.delIdx) === k);
          return cb && PRODUCT_META[cb.dataset.product]?.scheduleType === 'translation';
        });
        if (!hasTransChild) return;
        // Among qualifying alternates, keep the one whose production ends latest.
        // Compare on production end (not pmDelivery) to match the final gate basis.
        const sibDue     = productionEndOf(sibBlock);
        const currentDue = gateBlock === parentBlock ? null : productionEndOf(gateBlock);
        if (!currentDue || (sibDue && sibDue > currentDue)) gateBlock = sibBlock;
      });
    }

    // Gate on the parent's PRODUCTION end, not its P&M delivery date. For a PM
    // parent these differ by pmDur — using pmDelivery here would push the child
    // (e.g. a chatbot) past the mail date instead of starting it when production
    // completes.
    const gateDue = productionEndOf(gateBlock);
    if (!gateDue) return null;
    return addBusinessDays(gateDue, getBlockDays(block));
  }

  // Root block: project due date minus the longest child chain
  let due = new Date(dueVal + 'T00:00:00');
  while (!isWorkDay(due)) due.setDate(due.getDate() - 1);
  if (!VALID_PARENTS[bp]) {
    const delIdx  = parseInt(block.dataset.delIdx);
    const appDays = !isNaN(delIdx) ? getAppendedDays(delIdx) : 0;
    if (appDays > 0) due = subtractBusinessDays(due, appDays);
  }
  return due;
}

// ── Sum of all phase durations in a block ─────────────────────────────────
function getBlockDays(block) {
  return [...block.querySelectorAll('.pt-dur')]
    .reduce((s, inp) => s + (Math.max(0, parseInt(inp.value) || 0)), 0);
}

export function recalcBlockFeasibility(block) {
  const startVal = document.getElementById('startDate').value;
  if (!startVal) return;

  const start = nextWorkDay(new Date(startVal + 'T00:00:00'));

  // Judge feasibility against the block's OWN stamped dates (set by recalcPhaseDates,
  // the same authoritative logic that drives the Gantt and timeline output) rather than
  // re-deriving a window with naive parent-day subtraction. A block is feasible when its
  // production can start on or after the project start date.
  //
  //   productionEnd   = latest non-P&M phase end date (the production deadline)
  //   requiredStart   = productionEnd - production days
  //   buffer/overage  = business days between project start and requiredStart
  //
  // This is uniform for roots, children, PM and non-PM: the stamped dates already encode
  // every gate (parent production end, translation gate, P&M carve-out), so we don't
  // re-implement that here — and a P&M block whose delivery aligns with the due date
  // reads as "exactly on time", not over.
  const rows      = [...block.querySelectorAll('.phase-table tbody tr')];
  const prodRows  = rows.filter(tr => !(tr.querySelector('.pt-name')?.value || '').startsWith('Print & Mail'));
  if (!prodRows.length) return;

  const prodDays = prodRows.reduce((s, tr) => s + Math.max(0, parseInt(tr.querySelector('.pt-dur')?.value) || 0), 0);

  // Latest stamped production end date among non-P&M rows
  let productionEnd = null;
  prodRows.forEach(tr => {
    const iso = tr.querySelector('.phase-end-date')?.dataset.endDate;
    if (iso) {
      const d = new Date(iso + 'T00:00:00');
      if (!productionEnd || d > productionEnd) productionEnd = d;
    }
  });
  if (!productionEnd) return;

  const requiredStart = subtractBusinessDays(productionEnd, prodDays);

  const fill = block.querySelector('.pb-feas-bar-fill');
  const diff = block.querySelector('.pb-feas-diff');
  if (!fill || !diff) return;

  // delta > 0: requiredStart is after project start (buffer). delta < 0: must start before
  // project start (overage). countBusinessDays returns 0 when start >= requiredStart.
  const delta = requiredStart >= start
    ? countBusinessDays(start, requiredStart)
    : -countBusinessDays(requiredStart, start);

  // Bar fill: proportion of the available window the production consumes
  const windowDays = countBusinessDays(start, productionEnd) || prodDays;
  const pct = Math.min(100, (prodDays / windowDays) * 100);

  if (delta > 5)       { fill.style.cssText = `width:${pct}%;background:var(--green)`; diff.className = 'pb-feas-diff ok';   diff.textContent = `+${delta} days buffer`; }
  else if (delta >= 0) { fill.style.cssText = `width:${pct}%;background:var(--amber)`; diff.className = 'pb-feas-diff warn'; diff.textContent = delta === 0 ? 'Exactly on time' : `+${delta} days`; }
  else                 { fill.style.cssText = 'width:100%;background:var(--red)';       diff.className = 'pb-feas-diff over'; diff.textContent = `${Math.abs(delta)} days over`; }

  // Re-evaluate generate button — over state may have changed
  const generateBtn = document.getElementById('generateBtn');
  if (generateBtn) {
    const blocks  = [...document.querySelectorAll('#pbBlocks .pb-block')];
    const total   = blocks.length;
    const confirmed = blocks.filter(b => b.dataset.confirmed === 'true').length;
    const anyOver = blocks.some(b => b.querySelector('.pb-feas-diff.over') !== null);
    generateBtn.disabled = total === 0 || confirmed < total || anyOver;
    const warn = document.getElementById('overScopeWarning');
    if (warn) warn.style.display = anyOver ? 'block' : 'none';
    if (anyOver) {
      generateBtn.title = 'One or more deliverables exceed the available time — reduce durations or extend the due date.';
    } else if (confirmed < total) {
      generateBtn.title = 'Confirm all deliverables before generating.';
    } else {
      generateBtn.title = '';
    }
  }

  // Cascade: when this block's days change, its parent and children need re-evaluation
  // too since their effectiveAvailable depends on this block's duration.
  // _cascading flag prevents infinite recursion.
  if (!block._feasCascading) {
    block._feasCascading = true;
    const allBlocks = [...document.querySelectorAll('#pbBlocks .pb-block')];

    // Re-run on parent block (its effectiveAvailable = available - ourDays)
    const parent = getParentBlock(block);
    if (parent && !parent._feasCascading) recalcBlockFeasibility(parent);

    // Re-run on child blocks (their effectiveAvailable = available - ourDays)
    allBlocks.forEach(b => {
      if (b === block || b._feasCascading) return;
      const bp = getParentBlock(b);
      if (bp === block) recalcBlockFeasibility(b);
    });

    block._feasCascading = false;
  }
}

// ── Phase date recalculation ──────────────────────────────────────────────
export function recalcPhaseDates(block, blockEndDate) {
  const due = blockEndDate || getEffectiveDue(block);
  if (!due) return;

  const durInputs = [...block.querySelectorAll('.pt-dur')];
  const dateCells = [...block.querySelectorAll('.phase-end-date')];
  const nameInputs = [...block.querySelectorAll('.pt-name')];
  const parseDur  = inp => Math.max(0, parseInt(inp.value) || 0);

  // Detect if this block has a P&M phase and is part of a PM chain
  const pmChain    = block.dataset.pmChain === 'true';
  const pmDelivery = block.dataset.pmDelivery;
  const pmRowIdx   = pmChain
    ? nameInputs.findIndex(inp => inp.value.startsWith('Print & Mail'))
    : -1;
  const hasPMRow   = pmRowIdx !== -1;

  if (hasPMRow && pmDelivery) {
    // ── PM-chain block: two independent date segments ──────────────────
    // Segment 1: production phases (all rows except the P&M row)
    //   — count backward from pmDelivery - pmDur (the production deadline)
    // Segment 2: P&M phase
    //   — pins to pmDelivery regardless of production phase timing
    //   — this creates a visible gap in the date column between production end
    //     and P&M start when the gate pushes P&M later than production

    const pmDate    = new Date(pmDelivery + 'T00:00:00');
    const pmDur     = parseDur(durInputs[pmRowIdx]);

    // Use the LATEST P&M delivery date across all PM blocks in this chain as
    // the shared production anchor. When delivery dates differ (e.g. root has
    // an earlier date than children), each block independently computing from
    // its own pmStart breaks the hierarchy — children would start after the
    // root's P&M ends rather than running concurrently. A single chain-wide
    // anchor keeps all production dates consistent with each other.
    const allScanBlocks = [...document.querySelectorAll('#pbBlocks .pb-block')];
    const allScanRows   = [...document.querySelectorAll('#delRows .del-row')];
    const scanParentMap = buildParentIdxMap(allScanRows);
    const thisDelIdx    = parseInt(block.dataset.delIdx);
    function chainRootOf_pm(idx) {
      let cur = idx, n = 0;
      while (scanParentMap[cur] !== null && scanParentMap[cur] !== undefined && n++ < 20) cur = scanParentMap[cur];
      return cur;
    }
    const chainRoot = chainRootOf_pm(thisDelIdx);
    let latestDelivery = pmDate;
    allScanBlocks.forEach(b => {
      if (!b.dataset.pmDelivery || !b.dataset.pmChain) return;
      if (chainRootOf_pm(parseInt(b.dataset.delIdx)) !== chainRoot) return;
      const d = new Date(b.dataset.pmDelivery + 'T00:00:00');
      if (d > latestDelivery) latestDelivery = d;
    });
    const chainPmStart  = subtractBusinessDays(latestDelivery, pmDur);
    const appendedDays  = getAppendedDays(thisDelIdx);
    const productionDue = appendedDays > 0 ? subtractBusinessDays(chainPmStart, appendedDays) : chainPmStart;

    // Production phases: all rows except pmRowIdx
    const prodDurs = durInputs
      .map((inp, i) => i === pmRowIdx ? 0 : parseDur(inp));
    const prodTotal = prodDurs.reduce((s, d) => s + d, 0);

    let remaining = prodTotal;
    durInputs.forEach((inp, i) => {
      if (i === pmRowIdx) return; // handled separately below
      const dur = parseDur(inp);
      remaining -= dur;
      const phaseEnd = remaining === 0
        ? new Date(productionDue)
        : subtractBusinessDays(productionDue, remaining);
      if (dateCells[i]) {
        dateCells[i].textContent     = dur > 0 ? fmtDateShort(phaseEnd) : '—';
        dateCells[i].dataset.endDate = dur > 0 ? toISO(phaseEnd) : '';
      }
    });

    // P&M phase: always pins to pmDelivery
    if (dateCells[pmRowIdx]) {
      dateCells[pmRowIdx].textContent     = fmtDateShort(pmDate);
      dateCells[pmRowIdx].dataset.endDate = toISO(pmDate);
      dateCells[pmRowIdx].style.color     = 'var(--color-text-warning, #854F0B)';
    }

    // Update block header dates
    const startsEl = block.querySelector('.pb-date-starts');
    const endsEl   = block.querySelector('.pb-date-ends');
    const sepEl    = block.querySelector('.pb-date-sep');
    const totalEl  = block.querySelector('.pb-total-days');
    if (totalEl) totalEl.textContent = prodTotal > 0 ? `${prodTotal}d + ${pmDur}d P&M` : '';
    if (startsEl && endsEl) {
      const starts = prodTotal > 0 ? subtractBusinessDays(productionDue, prodTotal) : productionDue;
      startsEl.innerHTML = `<span class="pb-date-label">Starts</span> ${fmtDateShort(starts)}`;
      endsEl.innerHTML   = `<span class="pb-date-label">End</span> ${fmtDateShort(productionDue)}. <span class="pb-date-label">P&amp;M Delivers</span> ${fmtDateShort(pmDate)}`;
      if (sepEl) sepEl.style.display = '';
    }

  } else {
    // ── Standard block: all phases chain sequentially end-to-end ──────
    const total = durInputs.reduce((s, inp) => s + parseDur(inp), 0);
    if (total === 0) return;

    const durs  = durInputs.map(parseDur);
    let remaining = total;
    durs.forEach((dur, i) => {
      remaining -= dur;
      const phaseEnd = remaining === 0 ? new Date(due) : subtractBusinessDays(due, remaining);
      if (dateCells[i]) {
        dateCells[i].textContent     = dur > 0 ? fmtDateShort(phaseEnd) : '—';
        dateCells[i].dataset.endDate = dur > 0 ? toISO(phaseEnd) : '';
      }
    });

    const startsEl = block.querySelector('.pb-date-starts');
    const endsEl   = block.querySelector('.pb-date-ends');
    const sepEl    = block.querySelector('.pb-date-sep');
    const totalEl  = block.querySelector('.pb-total-days');
    if (totalEl) totalEl.textContent = total > 0 ? `${total}d` : '';
    if (startsEl && endsEl) {
      const starts = subtractBusinessDays(due, total);
      startsEl.innerHTML = `<span class="pb-date-label">Starts</span> ${fmtDateShort(starts)}`;

      // Use delIdx for an exact row lookup — matching by product+isRenewal would pick
      // the wrong row if the same product appears twice with the same new/renewal setting.
      const allDelRows  = [...document.querySelectorAll('#delRows .del-row')];
      const matchedRow  = allDelRows[parseInt(block.dataset.delIdx)];
      const rowPmDelivery = matchedRow?.dataset.pmDelivery;
      if (rowPmDelivery) {
        const deliveryDate = new Date(rowPmDelivery + 'T00:00:00');
        endsEl.innerHTML = `<span class="pb-date-label">P&amp;M Delivery</span> ${fmtDateShort(deliveryDate)}`;
      } else {
        endsEl.innerHTML = `<span class="pb-date-label">Completes</span> ${fmtDateShort(due)}`;
      }
      if (sepEl) sepEl.style.display = '';
    }
  }
}

// ── Global feasibility panel ──────────────────────────────────────────────
export function updateFeasibility() {
  const panel = document.getElementById('feasibilityPanel');
  if (!panel) return;

  const startVal = document.getElementById('startDate').value;
  const dueVal   = document.getElementById('dueDate').value;
  if (!startVal) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';

  const startDate = nextWorkDay(new Date(startVal + 'T00:00:00'));
  const dueDate   = dueVal ? (() => { let d = new Date(dueVal + 'T00:00:00'); while (!isWorkDay(d)) d.setDate(d.getDate() - 1); return d; })() : null;
  const available = dueDate ? countBusinessDays(startDate, dueDate) : null;

  document.getElementById('feasAvailable').textContent = available !== null ? available : '—';
  document.getElementById('feasDates').textContent = dueDate
    ? `${fmtDateShort(startDate)} → ${fmtDateShort(dueDate)}`
    : 'No due date set';

  const blocks = [...document.querySelectorAll('#pbBlocks .pb-block')];
  if (!blocks.length) {
    ['feasNeeded','feasDiff'].forEach(id => document.getElementById(id).textContent = '—');
    document.getElementById('feasMsg').textContent = '—';
    document.getElementById('feasFill').style.width = '0%';
    return;
  }

  // Run the Gantt first — it computes blockStart/blockEnd from the authoritative
  // stamped phase dates and writes both "Latest Possible Start" (feasLatestStart)
  // and the total project span (lastTotalSpanDays). Reading that here keeps the
  // four feasibility boxes in lockstep with the Gantt and the timeline output,
  // instead of re-deriving the schedule with separate (and drift-prone) math.
  updateGantt();
  const needed = lastTotalSpanDays;
  document.getElementById('feasNeeded').textContent = needed;

  if (available === null) {
    document.getElementById('feasDiff').textContent = '—';
    document.getElementById('feasMsg').textContent  = 'Set a due date to check feasibility';
    document.getElementById('feasFill').style.cssText = 'width:0%;background:var(--border)';
    document.getElementById('feasDiff').style.color   = 'var(--text)';
    return;
  }

  const diff  = available - needed;
  const pct   = Math.min(100, Math.round((needed / Math.max(available, needed)) * 100));
  const diffEl = document.getElementById('feasDiff');
  const msgEl  = document.getElementById('feasMsg');
  const fillEl = document.getElementById('feasFill');

  diffEl.textContent = (diff >= 0 ? '+' : '') + diff + ' days';
  if (diff >= 6)      { diffEl.style.color = '#2e8b4a'; msgEl.style.color = '#2e8b4a'; msgEl.textContent = 'Timeline fits with buffer';                               fillEl.style.cssText = `width:${pct}%;background:#44A55D`; }
  else if (diff >= 1) { diffEl.style.color = '#b5920a'; msgEl.style.color = '#b5920a'; msgEl.textContent = `Tight — only ${diff} day${diff===1?'':'s'} buffer`;        fillEl.style.cssText = `width:${pct}%;background:var(--amber)`; }
  else if (diff === 0){ diffEl.style.color = '#b5920a'; msgEl.style.color = '#b5920a'; msgEl.textContent = 'Exactly on time — no buffer';                             fillEl.style.cssText = 'width:100%;background:var(--amber)'; }
  else               { diffEl.style.color = 'var(--red)'; msgEl.style.color = 'var(--red)'; msgEl.textContent = `${Math.abs(diff)} days over — compress`; fillEl.style.cssText = 'width:100%;background:var(--red)'; }
}

// ── Gantt chart ───────────────────────────────────────────────────────────
export function updateGantt() {
  const wrap     = document.getElementById('ganttWrap');
  const chart    = document.getElementById('ganttChart');
  const startVal = document.getElementById('startDate').value;
  const dueVal   = document.getElementById('dueDate').value;
  const blocks   = [...document.querySelectorAll('#pbBlocks .pb-block')];

  if (!startVal || !blocks.length) { wrap.style.display = 'none'; return; }
  document.getElementById('feasibilityPanel').style.display = 'block';

  const startDate = nextWorkDay(new Date(startVal + 'T00:00:00'));
  const delRows   = [...document.querySelectorAll('#delRows .del-row')];
  const parentIdxMap = buildParentIdxMap(delRows);

  const sortedIdxs = [];
  function dfsVisit(idx) {
    sortedIdxs.push(idx);
    blocks.forEach((_, j) => { if (parentIdxMap[j] === idx) dfsVisit(j); });
  }
  blocks.forEach((_, i) => { if (parentIdxMap[i] === null) dfsVisit(i); });

  // ── Ensure all phase dates are fresh before reading them ─────────────────
  // The Gantt now reads blockStart/blockEnd directly from each block's stamped
  // phase dates (dataset.endDate), which are produced by recalcPhaseDates — the
  // same logic that drives the email/PDF output. Recalc every block in DFS
  // parent-first order so children read fresh parent dates, guaranteeing the
  // Gantt can never disagree with the timeline output.
  sortedIdxs.forEach(i => recalcPhaseDates(blocks[i]));

  const dueDate = dueVal ? (() => { let d = new Date(dueVal + 'T00:00:00'); while (!isWorkDay(d)) d.setDate(d.getDate() - 1); return d; })() : null;

  const blockDays = {};
  blocks.forEach((block, i) => {
    // Exclude P&M phase rows from production day count —
    // P&M segments are positioned independently using pmDelivery,
    // so including them in blockDays inflates chainDays/daysAfter
    // and breaks the backward-anchor gate logic.
    const durs = [...block.querySelectorAll('tbody tr')]
      .filter(tr => {
        const name = tr.querySelector('.pt-name')?.value || '';
        return !name.startsWith('Print & Mail');
      })
      .map(tr => Math.max(1, parseInt(tr.querySelector('.pt-dur')?.value) || 1));
    blockDays[i] = Math.max(1, durs.reduce((a, b) => a + b, 0));
  });

  function chainDays(idx) {
    const children = blocks.map((_, j) => j).filter(j => parentIdxMap[j] === idx);
    if (!children.length) return blockDays[idx];
    return blockDays[idx] + Math.max(...children.map(j => chainDays(j)));
  }
  const longestChainDays = Math.max(...blocks.map((_, i) => parentIdxMap[i] !== null ? 0 : chainDays(i)));

  const chainEndDate = addBusinessDays(startDate, longestChainDays);
  // Consider PM delivery dates from both del-rows and stamped block datasets
  const allPMDates = [
    ...delRows.filter(r => r.dataset.pmDelivery).map(r => new Date(r.dataset.pmDelivery + 'T00:00:00')),
    ...blocks.filter(b => b.dataset.pmDelivery).map(b => new Date(b.dataset.pmDelivery + 'T00:00:00'))
  ];
  const maxPMDate = allPMDates.length ? allPMDates.reduce((m, d) => d > m ? d : m) : null;
  const anchorDate   = [dueDate, chainEndDate, maxPMDate]
    .filter(Boolean)
    .reduce((m, d) => d > m ? d : m, chainEndDate);
  const scaleDays    = Math.max(1, countBusinessDays(startDate, anchorDate));
  const availableDays = dueDate ? countBusinessDays(startDate, dueDate) : 0;
  const duePct        = dueDate ? Math.min(100, (availableDays / scaleDays) * 100) : null;

  // ── Read blockStart/blockEnd directly from stamped phase dates ───────────
  // recalcPhaseDates (run above for every block) stamps dataset.endDate on each
  // phase row using the authoritative scheduling logic — the same logic that
  // produces the email/PDF output. The Gantt reads those dates directly instead
  // of re-deriving positions, so the chart can never disagree with the timeline.
  //
  // For a block:
  //   blockEnd   = latest non-P&M phase end date (production end)
  //   blockStart = blockEnd - blockDays (production span backward from end)
  //   P&M segment is rendered separately, pinned to pmDelivery (see render loop)
  const blockStart = {}, blockEnd = {};
  sortedIdxs.forEach(i => {
    const block = blocks[i];
    const cells = [...block.querySelectorAll('.phase-end-date')];
    const names = [...block.querySelectorAll('.pt-name')];

    // Collect end dates from production rows only (exclude the P&M row)
    const prodEndDates = cells
      .map((cell, ci) => {
        const isPM = names[ci]?.value.startsWith('Print & Mail');
        const iso  = cell.dataset.endDate;
        return (!isPM && iso) ? new Date(iso + 'T00:00:00') : null;
      })
      .filter(Boolean);

    if (prodEndDates.length) {
      blockEnd[i]   = prodEndDates.reduce((m, d) => d > m ? d : m);
      blockStart[i] = subtractBusinessDays(blockEnd[i], blockDays[i]);
    } else {
      // No stamped dates — happens when recalcPhaseDates bailed (e.g. no project
      // due date and no P&M delivery, so getEffectiveDue returned null). Don't
      // collapse the bar to zero width; reconstruct position from the dependency:
      // a child starts when its parent ends. sortedIdxs is DFS parent-first, so
      // the parent's blockEnd is already set. Roots with no dates fall back to start.
      const parIdx = parentIdxMap[i];
      const start  = (parIdx !== null && blockEnd[parIdx])
        ? nextWorkDay(new Date(blockEnd[parIdx]))
        : new Date(startDate);
      blockStart[i] = start;
      blockEnd[i]   = addBusinessDays(start, blockDays[i]);
    }
  });

  // Axis ticks
  const ticks = [];
  const tickCur = new Date(startDate);
  tickCur.setDate(1); tickCur.setMonth(tickCur.getMonth() + 1);
  while (tickCur < anchorDate) {
    const bd = countBusinessDays(startDate, tickCur);
    const pct = (bd / scaleDays) * 100;
    // Skip ticks too close to either edge (avoids overlap with fixed start/end labels)
    if (pct > 5 && pct < 92) {
      ticks.push({ label: tickCur.toLocaleDateString('en-US', { month: 'short' }) + ' ' + tickCur.getDate(), pct });
    }
    tickCur.setMonth(tickCur.getMonth() + 1);
  }

  let html = '';
  html += `<div class="gantt-axis-row"><div style="width:150px;flex-shrink:0"></div><div class="gantt-axis-track">`;
  html += `<span class="gantt-axis-tick" style="left:0;transform:none">${fmtDateShort(startDate)}</span>`;
  ticks.forEach(t => html += `<span class="gantt-axis-tick" style="left:${t.pct}%">${t.label}</span>`);
  html += `<span class="gantt-axis-tick" style="right:0;left:auto;transform:none">${fmtDateShort(anchorDate)}</span>`;
  html += `</div></div>`;

  // Total bar: span from earliest root blockStart to anchorDate (handles PM parents pushing left)
  const rootIdxs = sortedIdxs.filter(i => parentIdxMap[i] === null);
  const earliestStart = rootIdxs.reduce((e, i) => blockStart[i] < e ? blockStart[i] : e, blockStart[rootIdxs[0]]);
  lastEarliestStart = earliestStart;
  // Total span: earliest blockStart → anchorDate, same convention as scaleDays
  const totalSpanDays = countBusinessDays(earliestStart, anchorDate);
  lastTotalSpanDays = totalSpanDays;
  const latestStartEl = document.getElementById('feasLatestStart');
  if (latestStartEl) latestStartEl.textContent = earliestStart ? fmtDateShort(earliestStart) : '—';
  const totalWidthPct = Math.min(100, (totalSpanDays / scaleDays) * 100);
  const totalLeftPct  = Math.max(0, (countBusinessDays(startDate, earliestStart) / scaleDays) * 100);
  html += `<div class="gantt-row">
    <div class="gantt-label" style="color:rgba(255,255,255,.45);font-style:italic">Total project</div>
    <div class="gantt-track">
      <div class="gantt-bar total-bar" style="left:${totalLeftPct}%;width:${totalWidthPct}%" title="Total project: ${totalSpanDays} days">
        ${totalWidthPct > 10 ? totalSpanDays + 'd' : ''}
      </div>
    </div>
    <div class="gantt-enddate">${fmtDateShort(anchorDate)}</div>
  </div>`;
  html += `<div style="border-top:1px solid rgba(255,255,255,.07);margin:6px 0 8px"></div>`;

  sortedIdxs.forEach(i => {
    const block    = blocks[i];
    const product  = block.dataset.product || '';
    const grp      = getProductGroup(product);
    const color    = grp ? grp.color : '#888';
    const parIdx   = parentIdxMap[i];
    const depth    = getDepth(i, parentIdxMap);

    // PM chain: separate production days from P&M days for bar rendering
    const isPMChain   = block.dataset.pmChain === 'true';
    const pmDelivery  = block.dataset.pmDelivery;
    const pmDur       = isPMChain
      ? (() => {
          const pmInp = [...block.querySelectorAll('.pt-name')]
            .find(inp => inp.value.startsWith('Print & Mail'));
          return pmInp ? (Math.max(1, parseInt(pmInp.closest('tr')?.querySelector('.pt-dur')?.value) || 10)) : 10;
        })()
      : 0;

    const leftPct  = Math.max(0, (countBusinessDays(startDate, blockStart[i]) / scaleDays) * 100);
    const rightPct = Math.max(0, (countBusinessDays(startDate, blockEnd[i])   / scaleDays) * 100);
    const widthPct = Math.max(0.5, rightPct - leftPct);
    const productionSpanDays = countBusinessDays(blockStart[i], blockEnd[i]);

    const isChild  = parIdx !== null;
    const rowClass = isChild ? 'gantt-nested-row' : 'gantt-row';
    let connectorHtml = '';
    if (isChild) {
      let pipes = '';
      for (let d = 1; d < depth; d++) {
        pipes += `<span style="display:inline-block;width:10px;text-align:center;color:rgba(255,255,255,.2)">│</span>`;
      }
      connectorHtml = `${pipes}<span style="color:rgba(255,255,255,.3)">└─</span> `;
    }

    // Whether the P&M segment butts directly against production (no gate gap).
    // Drives the border-radius on both bars so they connect flush when adjacent
    // and each round independently when there's a gap.
    const pmAdjacent = (() => {
      if (!isPMChain || !pmDelivery || pmDur <= 0) return false;
      const pmStart = subtractBusinessDays(new Date(pmDelivery + 'T00:00:00'), pmDur);
      return countBusinessDays(blockEnd[i], pmStart) <= 0;
    })();

    // P&M segment: anchored to its actual delivery date, not appended to production.
    // recalcPhaseDates pins the P&M row's end to pmDelivery exactly, so the segment
    // spans (pmDelivery - pmDur) → pmDelivery. When production ends earlier than that
    // (child-chain gate gap), this correctly shows the P&M block at the delivery date
    // with a visible gap, rather than floating right after the production bar.
    const pmSegmentHtml = (() => {
      if (!isPMChain || !pmDelivery || pmDur <= 0) return '';
      const pmDate     = new Date(pmDelivery + 'T00:00:00');
      const pmStart    = subtractBusinessDays(pmDate, pmDur);
      const pmLeftPct  = Math.max(0, (countBusinessDays(startDate, pmStart) / scaleDays) * 100);
      const pmWidthPct = Math.max(1, (pmDur / scaleDays) * 100);
      // Square left edge only when flush against production; round it when gapped
      const pmRadius   = pmAdjacent ? '0 4px 4px 0' : '4px';
      return `<div style="left:${pmLeftPct.toFixed(2)}%;width:${pmWidthPct.toFixed(2)}%;background:#534AB7;position:absolute;top:0;bottom:0;border-radius:${pmRadius};display:flex;align-items:center;justify-content:center;font-size:${isChild?'9':'10'}px;font-weight:700;color:rgba(255,255,255,.9);opacity:.9" title="P&amp;M: ${pmDur}d, ships ${fmtDateShort(pmDate)}">
        ${pmWidthPct > 5 ? 'P&amp;M' : ''}
      </div>`;
    })();

    // End date display
    const endDateHtml = (() => {
      if (isPMChain && pmDelivery) {
        const pmDate  = new Date(pmDelivery + 'T00:00:00');
        const pmFmt   = pmDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const prodEnd = subtractBusinessDays(pmDate, pmDur);
        return fmtDateShort(prodEnd) + `<br><span style="color:rgba(180,140,255,.85);font-size:8px">P&amp;M: ${pmFmt}</span>`;
      }
      if (parIdx !== null) return fmtDateShort(blockEnd[i]);
      // Pre-post-pass window: block doesn't have isPMChain yet but del-row may have pmDelivery.
      // Use delIdx for exact row lookup; read PM duration from the P&M phase row if it exists,
      // otherwise fall back to the default 10.
      const pmR = delRows[parseInt(block.dataset.delIdx)];
      if (!pmR?.dataset.pmDelivery) return fmtDateShort(blockEnd[i]);
      const pmD   = new Date(pmR.dataset.pmDelivery + 'T00:00:00');
      const pmFmt = pmD.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const pmPhaseInp = [...block.querySelectorAll('.pt-name')].find(x => x.value.startsWith('Print & Mail'));
      const pmDurFallback = pmPhaseInp ? (Math.max(1, parseInt(pmPhaseInp.closest('tr')?.querySelector('.pt-dur')?.value) || 10)) : 10;
      const prodDue = subtractBusinessDays(pmD, pmDurFallback);
      return fmtDateShort(prodDue) + `<br><span style="color:rgba(180,140,255,.85);font-size:8px">P&amp;M: ${pmFmt}</span>`;
    })();

    // Production bar: square the right edge only when the P&M segment butts
    // directly against it (no gate gap). When there's a gap, round normally.
    const prodRadius = pmAdjacent ? '4px 0 0 4px' : '4px';

    html += `<div class="${rowClass}">
      <div style="width:150px;flex-shrink:0;font-size:${isChild?'10':'11'}px;color:rgba(255,255,255,${isChild?'.6':'.75'});font-family:Verdana,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;" title="${esc(product)}">${connectorHtml}<span style="overflow:hidden;text-overflow:ellipsis">${esc(product)}</span></div>
      <div class="${isChild?'gantt-nested-track':'gantt-track'}" style="position:relative">
        <div style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;background:${color};position:absolute;top:0;bottom:0;border-radius:${prodRadius};display:flex;align-items:center;justify-content:center;font-size:${isChild?'9':'10'}px;font-weight:700;color:rgba(255,255,255,.9)" title="${esc(product)}: ${productionSpanDays}d">
          ${widthPct > 8 ? productionSpanDays + 'd' : ''}
        </div>
        ${pmSegmentHtml}
        ${(() => {
          if (parIdx !== null || isPMChain) return '';
          // Pre-post-pass window: use delIdx for exact row lookup.
          const pmR = delRows[parseInt(block.dataset.delIdx)];
          if (!pmR?.dataset.pmDelivery) return '';
          const pmD = new Date(pmR.dataset.pmDelivery + 'T00:00:00');
          const pmPhaseInp = [...block.querySelectorAll('.pt-name')].find(x => x.value.startsWith('Print & Mail'));
          const pmDurFallback = pmPhaseInp ? (Math.max(1, parseInt(pmPhaseInp.closest('tr')?.querySelector('.pt-dur')?.value) || 10)) : 10;
          const prodDue = subtractBusinessDays(pmD, pmDurFallback);
          const dividerPct = (countBusinessDays(startDate, prodDue) / scaleDays) * 100;
          return `<div style="position:absolute;left:${dividerPct}%;top:-2px;bottom:-2px;width:2px;background:rgba(255,255,255,.4);z-index:5;transform:translateX(-1px);pointer-events:none"></div>`;
        })()}
      </div>
      <div class="gantt-enddate" style="font-size:${isChild?'9':'10'}px;color:rgba(255,255,255,${isChild?'.4':'.55'});line-height:1.3">${endDateHtml}</div>
    </div>`;
  });

  chart.innerHTML = html;
  chart.style.cssText = 'position:relative;overflow:hidden';

  if (duePct !== null) {
    const axisTrack = chart.querySelector('.gantt-axis-track');
    if (axisTrack) {
      axisTrack.style.cssText = 'position:relative;overflow:visible';
      const dueLine = document.createElement('div');
      dueLine.style.cssText = `position:absolute;top:-9999px;bottom:-9999px;left:${duePct}%;width:2px;background:rgba(255,80,80,.8);z-index:10;pointer-events:none`;
      const dueLabel = document.createElement('span');
      dueLabel.textContent = 'Due';
      dueLabel.style.cssText = 'position:absolute;top:4px;left:50%;transform:translateX(-50%);font-size:9px;font-weight:700;color:rgba(255,100,100,.95);white-space:nowrap;font-family:Verdana,sans-serif;letter-spacing:.04em';
      dueLine.appendChild(dueLabel);
      axisTrack.appendChild(dueLine);
    }
  }
  wrap.style.display = 'block';
}

// ── Generate button state ─────────────────────────────────────────────────
export function updateGenerateBtn() {
  const psCount     = document.getElementById('psCount');
  const generateBtn = document.getElementById('generateBtn');
  if (!psCount || !generateBtn) return;
  const blocks    = [...document.querySelectorAll('#pbBlocks .pb-block')];
  const total     = blocks.length;
  const confirmed = blocks.filter(b => b.dataset.confirmed === 'true').length;
  psCount.textContent  = `${confirmed} / ${total}`;

  // Block generation if any block (confirmed or not) is over its available time
  const anyOver = blocks.some(b => b.querySelector('.pb-feas-diff.over') !== null);

  generateBtn.disabled = total === 0 || confirmed < total || anyOver;

  const warn = document.getElementById('overScopeWarning');
  if (warn) warn.style.display = anyOver ? 'block' : 'none';

  // Tooltip hint so the user knows why the button is blocked
  if (anyOver) {
    generateBtn.title = 'One or more deliverables exceed the available time — reduce durations or extend the due date.';
  } else if (confirmed < total) {
    generateBtn.title = 'Confirm all deliverables before generating.';
  } else {
    generateBtn.title = '';
  }

  updateFeasibility();
}
