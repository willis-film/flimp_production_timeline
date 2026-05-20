// ── ui.js ─────────────────────────────────────────────────────────────────
// All DOM-rendering functions for the timeline builder.
// Imports data from database.js and utilities from engine.js.
// Never writes to Supabase directly — delegates to output.js for that.
// ─────────────────────────────────────────────────────────────────────────

import {
  PRODUCTS, NA_PRODUCTS, PM_ELIGIBLE, ROUNDS_DEFAULTS, ALL_PHASES,
  ROUND_GROUPS, PRECONDITIONS, VALID_PARENTS
} from './database.js';

import {
  toISO, isWorkDay, addBusinessDays, nextWorkDay, countBusinessDays,
  subtractBusinessDays, previousWorkDay, getDepth, fmtDateShort, esc,
  buildParentIdxMap, workDays, setDays
} from './engine.js';

// ── Exported for main.js ──────────────────────────────────────────────────
export { setDays };

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
    const rdVal = row.querySelector('.rounds-val');
    if (rdVal) {
      const curIsRenewal = row.querySelector('.nr-btn.r-active') !== null;
      rdVal.textContent = defaultRounds(this.value, curIsRenewal);
    }
  });

  return sel;
}

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

  const stepper  = document.createElement('div');
  stepper.className = 'rounds-stepper';
  const rdMinus  = document.createElement('button');
  rdMinus.className = 'rounds-btn'; rdMinus.textContent = '−'; rdMinus.title = 'Decrease rounds';
  const rdVal    = document.createElement('div');
  rdVal.className = 'rounds-val'; rdVal.textContent = '2';
  const rdPlus   = document.createElement('button');
  rdPlus.className = 'rounds-btn'; rdPlus.textContent = '+'; rdPlus.title = 'Increase rounds';
  rdMinus.onclick = () => { const v = parseInt(rdVal.textContent); if (v > 1) rdVal.textContent = v - 1; };
  rdPlus.onclick  = () => { const v = parseInt(rdVal.textContent); if (v < 20) rdVal.textContent = v + 1; };
  stepper.appendChild(rdMinus); stepper.appendChild(rdVal); stepper.appendChild(rdPlus);
  row.appendChild(stepper);

  const rm = document.createElement('button');
  rm.className = 'rm-btn'; rm.innerHTML = '&times;'; rm.title = 'Remove deliverable';
  rm.onclick = () => { row.remove(); updateRemove(); refreshParentSelectors(); refreshPMSelectors(); };
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
}

// ── Print & Mail section ──────────────────────────────────────────────────
export function togglePMSection() {
  const cb  = document.getElementById('pmCheckbox');
  const sec = document.getElementById('pmSection');
  sec.style.display = cb.checked ? 'block' : 'none';
  if (cb.checked && document.getElementById('pmRows').children.length === 0) {
    addPMRow();
  }
  refreshPMSelectors();
}

export function buildPMRow() {
  const row = document.createElement('div');
  row.className = 'pm-row';
  row.style.cssText = 'display:grid;grid-template-columns:1fr 160px 28px;gap:.5rem;align-items:center;padding:.4rem .75rem;border-bottom:1px solid var(--border-light)';

  // Parent selector
  const sel = document.createElement('select');
  sel.className = 'pm-parent-sel';
  sel.style.cssText = 'font-family:Verdana,sans-serif;font-size:13px;height:34px;padding:0 8px;border:1px solid var(--border);border-radius:var(--radius);background:#fff;color:var(--text);width:100%';
  sel.innerHTML = '<option value="">Select deliverable…</option>';
  sel.onchange = () => refreshPMSelectors();
  row.appendChild(sel);

  // Delivery date input
  const dateInp = document.createElement('input');
  dateInp.type = 'date';
  dateInp.className = 'pm-delivery-date';
  dateInp.style.cssText = 'font-family:Verdana,sans-serif;font-size:13px;height:34px;padding:0 8px;border:1px solid var(--border);border-radius:var(--radius);background:#fff;color:var(--text);width:100%';
  // Default to project due date if set
  const projectDue = document.getElementById('dueDate')?.value;
  if (projectDue) dateInp.value = projectDue;
  dateInp.onchange = () => {
    refreshPMSelectors();
    // Re-run feasibility on the matched parent block
    const selVal = sel.value;
    if (!selVal) return;
    const [product, isRenewalStr] = selVal.split('||');
    const block = [...document.querySelectorAll('#pbBlocks .pb-block')].find(b =>
      b.dataset.product === product && (b.dataset.isrenewal === 'true') === (isRenewalStr === 'true')
    );
    if (block) recalcBlockFeasibility(block);
  };
  row.appendChild(dateInp);

  // Remove button
  const rm = document.createElement('button');
  rm.className = 'rm-btn'; rm.innerHTML = '&times;'; rm.title = 'Remove';
  rm.onclick = () => {
    row.remove();
    refreshPMSelectors();
    updateGenerateBtn();
  };
  row.appendChild(rm);

  return row;
}

export function addPMRow() {
  document.getElementById('pmRows').appendChild(buildPMRow());
  refreshPMSelectors();
}

// Rebuild all PM parent selectors — shows only PM_ELIGIBLE products currently
// in section 2, greys out products already selected in another PM row.
export function refreshPMSelectors() {
  const pmRows   = [...document.querySelectorAll('#pmRows .pm-row')];
  const delRows  = [...document.querySelectorAll('#delRows .del-row')];

  // Collect eligible products currently in section 2
  const eligibleInSection = [];
  delRows.forEach((row, idx) => {
    const sel = row.querySelector('select');
    if (!sel || !sel.value) return;
    if (!PM_ELIGIBLE.has(sel.value)) return;
    const isRenewal = row.querySelector('.nr-btn.r-active') !== null;
    eligibleInSection.push({ product: sel.value, isRenewal, delIdx: idx });
  });

  // Collect currently selected values across all PM rows
  const selectedValues = new Set(
    pmRows.map(r => r.querySelector('.pm-parent-sel')?.value).filter(Boolean)
  );

  pmRows.forEach(row => {
    const sel      = row.querySelector('.pm-parent-sel');
    const curVal   = sel.value;
    sel.innerHTML  = '<option value="">Select deliverable…</option>';

    eligibleInSection.forEach(({ product, isRenewal }) => {
      const label  = `${product}${isRenewal ? ' (Renewal)' : ' (New)'}`;
      const value  = `${product}||${isRenewal}`;
      const opt    = document.createElement('option');
      opt.value    = value;
      opt.textContent = label;
      // Grey out if selected in another row
      if (value !== curVal && selectedValues.has(value)) {
        opt.disabled = true;
        opt.style.color = '#aaa';
      }
      sel.appendChild(opt);
    });

    // Restore previously selected value if still available
    if (curVal) sel.value = curVal;
  });

  // Stamp data-pm-delivery on del-rows so recalcBlockFeasibility can use it
  // First clear all
  delRows.forEach(r => delete r.dataset.pmDelivery);
  pmRows.forEach(row => {
    const selVal  = row.querySelector('.pm-parent-sel')?.value;
    const dateVal = row.querySelector('.pm-delivery-date')?.value;
    if (!selVal || !dateVal) return;
    const [product, isRenewalStr] = selVal.split('||');
    const matchRow = delRows.find(r => {
      const s = r.querySelector('select');
      const renewal = r.querySelector('.nr-btn.r-active') !== null;
      return s && s.value === product && String(renewal) === isRenewalStr;
    });
    if (matchRow) matchRow.dataset.pmDelivery = dateVal;
  });
}

// Returns array of {product, isRenewal, deliveryDate} for all configured PM rows
export function readPMConfig() {
  const cb = document.getElementById('pmCheckbox');
  if (!cb || !cb.checked) return [];
  return [...document.querySelectorAll('#pmRows .pm-row')]
    .map(row => {
      const selVal  = row.querySelector('.pm-parent-sel')?.value;
      const dateVal = row.querySelector('.pm-delivery-date')?.value;
      if (!selVal || !dateVal) return null;
      const [product, isRenewalStr] = selVal.split('||');
      return { product, isRenewal: isRenewalStr === 'true', deliveryDate: dateVal };
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
    allRows.forEach(otherRow => {
      if (otherRow === row) return;
      const info = getRowLabel(otherRow);
      if (!info || !validParentSet.has(info.product)) return;
      labelCounts[info.label] = (labelCounts[info.label] || 0) + 1;
      options.push({ product: info.product, label: info.label, idx: labelCounts[info.label] });
    });
    const finalOptions = options.map(o => ({
      ...o,
      label: labelCounts[o.label] > 1 ? o.label + ' ' + o.idx : o.label
    }));

    parentSel.innerHTML = '<option value="">Select parent deliverable…</option>';
    finalOptions.forEach((o, i) => {
      const opt = document.createElement('option');
      opt.value = i; opt.textContent = o.label; opt.dataset.product = o.product;
      if (String(i) === curVal) opt.selected = true;
      parentSel.appendChild(opt);
    });
    if (finalOptions.length === 1) parentSel.value = '0';
  });
}

// ── Appended days helper ──────────────────────────────────────────────────
function getAppendedDays(parentProduct, parentIsRenewal) {
  const allRows = [...document.querySelectorAll('#delRows .del-row')];
  let total = 0;
  allRows.forEach(row => {
    const sel = row.querySelector('select');
    if (!sel || !sel.value || !VALID_PARENTS[sel.value]) return;
    const parentSel = row.querySelector('.parent-sel');
    if (!parentSel || parentSel.value === '') return;
    const opt = parentSel.options[parentSel.selectedIndex];
    if (!opt) return;
    const expectedLabel = parentProduct + (parentIsRenewal ? ' (Renewal)' : ' (New)');
    if (opt.textContent.replace(/ \d+$/, '') === expectedLabel) {
      const blocks = [...document.querySelectorAll('#pbBlocks .pb-block')];
      const matchBlock = blocks.find(b => {
        const rowIsRenewal = row.querySelector('.nr-btn.r-active') !== null;
        return b.dataset.product === sel.value && (b.dataset.isrenewal === 'true') === rowIsRenewal;
      });
      if (matchBlock) {
        const durs = [...matchBlock.querySelectorAll('.pt-dur')].map(i => parseInt(i.value) || 1);
        total += durs.reduce((a, b) => a + b, 0);
      }
    }
  });
  return total;
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

  updateFeasibility();
  recalcPhaseDates(block);
  recalcBlockFeasibility(block);
}

// ── Phase preview ─────────────────────────────────────────────────────────
export function previewPhases() {
  const sdVal = document.getElementById('startDate').value;
  const rows  = [...document.querySelectorAll('#delRows .del-row')];
  const deliverables = rows.map(r => ({
    product:   r.querySelector('select').value,
    count:     parseInt(r.querySelector('input[type=number]').value) || 1,
    isRenewal: r.querySelector('.nr-btn.r-active') !== null,
    rounds:    parseInt(r.querySelector('.rounds-val').textContent) || 2
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
      for (let r = 1; r <= rCount; r++) {
        groupPhases.forEach(gp => {
          const baseName = rCount > 1 ? `${gp.name} Rd ${r}` : gp.name;
          expanded.push({ ...gp, name: baseName });
        });
      }
    });

    const block = document.createElement('div');
    block.className = 'pb-block';
    block.dataset.product   = del.product;
    block.dataset.isrenewal = del.isRenewal;
    block.dataset.rounds    = del.rounds;
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
    const variantLabel = isNA ? '' : (isRenewal ? ' &bull; Renewal' : ' &bull; New');
    const isLeaf = !!VALID_PARENTS[del.product];
    titleWrap.innerHTML = `
      <div class="pb-title">
        <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${esc(dot)};margin-right:6px;vertical-align:middle"></span>${esc(del.product)}<span class="pb-title-sub">${esc(grp ? grp.group : '')}${variantLabel} &middot; ${expanded.length} phases</span>
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

  // Post-pass: remove Distribution from parents that have appended items
  refreshParentSelectors();
  refreshPMSelectors(); // stamp data-pm-delivery on del-rows before the timeout reads them
  setTimeout(() => {
    const allDelRows = [...document.querySelectorAll('#delRows .del-row')];
    const parentIdxMap = buildParentIdxMap(allDelRows);
    const blocks = [...document.querySelectorAll('#pbBlocks .pb-block')];

    // Helper: strip Distribution from a pb-block
    function stripDistribution(block) {
      const rows2 = [...block.querySelectorAll('tbody tr')];
      for (let i = rows2.length - 1; i >= 0; i--) {
        const nameInput = rows2[i].querySelector('.pt-name');
        if (nameInput && nameInput.value.toLowerCase().includes('distribution')) {
          rows2[i].remove(); recalcPhaseDates(block); recalcBlockFeasibility(block); break;
        }
      }
    }

    // Regular append parents (via parentIdxMap)
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
      const block = blocks.find(b =>
        b.dataset.product === parentProduct &&
        (b.dataset.isrenewal === 'true') === parentIsRenewal
      );
      if (block) stripDistribution(block);
    });

    // PM parents — strip Distribution, append Print & Mail phase row
    allDelRows.forEach(row => {
      if (!row.dataset.pmDelivery) return;
      const product   = row.querySelector('select')?.value;
      const isRenewal = row.querySelector('.nr-btn.r-active') !== null;
      if (!product) return;
      const block = blocks.find(b =>
        b.dataset.product === product &&
        (b.dataset.isrenewal === 'true') === isRenewal
      );
      if (!block) return;

      stripDistribution(block);

      // Only append P&M row if not already present
      const existingPM = [...block.querySelectorAll('.pt-name')]
        .find(inp => inp.value.startsWith('Print & Mail'));
      if (!existingPM) {
        const tbody = block.querySelector('.phase-table tbody');
        if (tbody) {
          const tr = document.createElement('tr');
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
            tr.remove(); updateFeasibility(); recalcPhaseDates(block); recalcBlockFeasibility(block);
          };
          tbody.appendChild(tr);
        }
      }

      recalcPhaseDates(block);
      recalcBlockFeasibility(block);
    });

    updateFeasibility(); // recalc global panel now that P&M rows are in DOM
  }, 50);

  document.getElementById('phasePreviewSection').style.display = 'block';
  updateGenerateBtn();
  updateGantt();
  document.getElementById('phasePreviewSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Per-block feasibility ─────────────────────────────────────────────────
// ── Get the pb-block that is the parent of a given block (or null) ────────
function getParentBlock(block) {
  const allDelRows = [...document.querySelectorAll('#delRows .del-row')];
  const allBlocks  = [...document.querySelectorAll('#pbBlocks .pb-block')];
  const parentIdxMap = buildParentIdxMap(allDelRows);

  // Find the del-row index that corresponds to this block
  const blockProduct   = block.dataset.product;
  const blockIsRenewal = block.dataset.isrenewal === 'true';
  const blockDelIdx    = allDelRows.findIndex(row => {
    const sel = row.querySelector('select');
    const renewal = row.querySelector('.nr-btn.r-active') !== null;
    return sel && sel.value === blockProduct && renewal === blockIsRenewal;
  });
  if (blockDelIdx === -1) return null;

  const parentDelIdx = parentIdxMap[blockDelIdx];
  if (parentDelIdx === null || parentDelIdx === undefined) return null;

  const parentRow       = allDelRows[parentDelIdx];
  const parentProduct   = parentRow?.querySelector('select')?.value;
  const parentIsRenewal = parentRow?.querySelector('.nr-btn.r-active') !== null;
  if (!parentProduct) return null;

  return allBlocks.find(b =>
    b.dataset.product === parentProduct &&
    (b.dataset.isrenewal === 'true') === parentIsRenewal
  ) || null;
}

// ── Shared helper: get effective due date for a block ────────────────────
// For PM parents: delivery date - 10 biz days
// For regular parents/standalones: project due date - appended child days
// Returns a Date or null.
function getEffectiveDue(block) {
  const bp  = block.dataset.product;
  const bir = block.dataset.isrenewal === 'true';
  const dueVal = document.getElementById('dueDate').value;

  const allDelRows = [...document.querySelectorAll('#delRows .del-row')];
  const matchedRow = allDelRows.find(r => {
    const s = r.querySelector('select');
    const renewal = r.querySelector('.nr-btn.r-active') !== null;
    return s && s.value === bp && renewal === bir;
  });
  const pmDelivery = matchedRow?.dataset.pmDelivery;

  if (pmDelivery) {
    // PM parent — delivery date is the hard ceiling; the P&M phase (10 days)
    // is now a real row in the block so the full chain counts back from here.
    return new Date(pmDelivery + 'T00:00:00');
  }

  if (!dueVal) return null;
  let due = new Date(dueVal + 'T00:00:00');
  if (!VALID_PARENTS[bp]) {
    const appDays = getAppendedDays(bp, bir);
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

  const start       = nextWorkDay(new Date(startVal + 'T00:00:00'));
  const parentBlock = getParentBlock(block);

  let effectiveDue;
  if (parentBlock) {
    // Child block: judged against project due date minus parent days
    const dueVal = document.getElementById('dueDate').value;
    effectiveDue = dueVal ? new Date(dueVal + 'T00:00:00') : null;
  } else {
    // Root block: PM parent uses delivery-10, regular uses due-appended
    effectiveDue = getEffectiveDue(block);
  }
  if (!effectiveDue) return;

  const available = countBusinessDays(start, effectiveDue);
  const needed    = getBlockDays(block);

  const effectiveAvailable = parentBlock
    ? available - getBlockDays(parentBlock)
    : available;

  const fill = block.querySelector('.pb-feas-bar-fill');
  const diff = block.querySelector('.pb-feas-diff');
  if (!fill || !diff || effectiveAvailable <= 0) return;

  const pct   = Math.min(100, (needed / effectiveAvailable) * 100);
  const delta = effectiveAvailable - needed;

  if (delta > 5)     { fill.style.cssText = `width:${pct}%;background:var(--green)`; diff.className = 'pb-feas-diff ok';   diff.textContent = `+${delta} days buffer`; }
  else if (delta >= 0) { fill.style.cssText = `width:${pct}%;background:var(--amber)`; diff.className = 'pb-feas-diff warn';  diff.textContent = delta === 0 ? 'Exactly on time' : `+${delta} days`; }
  else               { fill.style.cssText = 'width:100%;background:var(--red)';      diff.className = 'pb-feas-diff over';  diff.textContent = `${delta} days over`; }

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
  const parseDur  = inp => Math.max(0, parseInt(inp.value) || 0);
  const total     = durInputs.reduce((s, inp) => s + parseDur(inp), 0);
  if (total === 0) return;

  const durs  = durInputs.map(parseDur);
  let remaining = total;
  durs.forEach((dur, i) => {
    remaining -= dur;
    const phaseEnd = remaining === 0 ? new Date(due) : subtractBusinessDays(due, remaining);
    if (dateCells[i]) {
      dateCells[i].textContent = dur > 0 ? fmtDateShort(phaseEnd) : '—';
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

    // For PM parents, show both the parent completion date and the delivery date
    const bp  = block.dataset.product;
    const bir = block.dataset.isrenewal === 'true';
    const allDelRows = [...document.querySelectorAll('#delRows .del-row')];
    const matchedRow = allDelRows.find(r => {
      const s = r.querySelector('select');
      const renewal = r.querySelector('.nr-btn.r-active') !== null;
      return s && s.value === bp && renewal === bir;
    });
    const pmDelivery = matchedRow?.dataset.pmDelivery;
    if (pmDelivery) {
      const deliveryDate = new Date(pmDelivery + 'T00:00:00');
      endsEl.innerHTML = `<span class="pb-date-label">P&amp;M Delivery</span> ${fmtDateShort(deliveryDate)}`;
    } else {
      endsEl.innerHTML = `<span class="pb-date-label">Completes</span> ${fmtDateShort(due)}`;
    }
    if (sepEl) sepEl.style.display = '';
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
  const dueDate   = dueVal ? new Date(dueVal + 'T00:00:00') : null;
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

  const feasDelRows    = [...document.querySelectorAll('#delRows .del-row')];
  const blockDaysByIdx = {};
  blocks.forEach((block, i) => {
    blockDaysByIdx[i] = [...block.querySelectorAll('.pt-dur')]
      .reduce((sum, inp) => sum + (Math.max(1, parseInt(inp.value) || 1)), 0);
  });

  const feasParentMap = buildParentIdxMap(feasDelRows);

  function feasChainDays(idx) {
    const children = blocks.map((_, j) => j).filter(j => feasParentMap[j] === idx);
    if (!children.length) return blockDaysByIdx[idx] || 0;
    return (blockDaysByIdx[idx] || 0) + Math.max(...children.map(j => feasChainDays(j)));
  }

  // For the global panel, needed = longest chain judged against project due date.
  // PM parent chains are bounded by their delivery window, so we compute their
  // effective days as: pmWindow - ownDays (available slack for chain).
  // For simplicity, we report the longest non-PM chain against project due date,
  // and flag if any PM parent chain exceeds its window.
  let needed = 0;
  blocks.forEach((block, i) => {
    if (feasParentMap[i] !== null) return; // not a root
    const chain = feasChainDays(i);
    // Use PM window if this is a PM parent
    const effDue = getEffectiveDue(block);
    const effAvailable = effDue ? countBusinessDays(startDate, effDue) : available;
    // For the global "needed" number, use project due date baseline for non-PM chains
    const isPM = !!feasDelRows.find(r => {
      const s = r.querySelector('select');
      const renewal = r.querySelector('.nr-btn.r-active') !== null;
      return s && s.value === block.dataset.product &&
             (renewal) === (block.dataset.isrenewal === 'true') &&
             r.dataset.pmDelivery;
    });
    if (!isPM && chain > needed) needed = chain;
    // For PM blocks, count against their own window
    if (isPM && chain > needed) needed = chain;
  });
  document.getElementById('feasNeeded').textContent = needed;

  if (available === null) {
    document.getElementById('feasDiff').textContent = '—';
    document.getElementById('feasMsg').textContent  = 'Set a due date to check feasibility';
    document.getElementById('feasFill').style.cssText = 'width:0%;background:var(--border)';
    document.getElementById('feasDiff').style.color   = 'var(--text)';
    updateGantt(); return;
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
  else               { diffEl.style.color = 'var(--red)'; msgEl.style.color = 'var(--red)'; msgEl.textContent = `${Math.abs(diff)} days over — consider compressing`; fillEl.style.cssText = 'width:100%;background:var(--red)'; }

  updateGantt();
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

  const dueDate = dueVal ? new Date(dueVal + 'T00:00:00') : null;

  const blockDays = {};
  blocks.forEach((block, i) => {
    const durs = [...block.querySelectorAll('.pt-dur')].map(inp => Math.max(1, parseInt(inp.value) || 1));
    blockDays[i] = durs.reduce((a, b) => a + b, 0);
  });

  function chainDays(idx) {
    const children = blocks.map((_, j) => j).filter(j => parentIdxMap[j] === idx);
    if (!children.length) return blockDays[idx];
    return blockDays[idx] + Math.max(...children.map(j => chainDays(j)));
  }
  const longestChainDays = Math.max(...blocks.map((_, i) => parentIdxMap[i] !== null ? 0 : chainDays(i)));

  const chainEndDate = addBusinessDays(startDate, longestChainDays);
  // Also consider PM delivery dates when computing the overall scale anchor
  const allPMDates = delRows
    .filter(r => r.dataset.pmDelivery)
    .map(r => new Date(r.dataset.pmDelivery + 'T00:00:00'));
  const maxPMDate = allPMDates.length ? allPMDates.reduce((m, d) => d > m ? d : m) : null;
  const anchorDate   = [dueDate, chainEndDate, maxPMDate]
    .filter(Boolean)
    .reduce((m, d) => d > m ? d : m, chainEndDate);
  const scaleDays    = Math.max(1, countBusinessDays(startDate, anchorDate));
  const availableDays = dueDate ? countBusinessDays(startDate, dueDate) : 0;
  const duePct        = dueDate ? Math.min(100, (availableDays / scaleDays) * 100) : null;

  const rootAnchor = {};
  blocks.forEach((block, i) => {
    if (parentIdxMap[i] !== null) return;
    const thisChainEnd = addBusinessDays(startDate, chainDays(i));
    // For PM parent blocks, anchor to PM delivery date instead of project due date
    const matchedDelRow = delRows.find(r => {
      const s = r.querySelector('select');
      const renewal = r.querySelector('.nr-btn.r-active') !== null;
      return s && s.value === block.dataset.product &&
             renewal === (block.dataset.isrenewal === 'true') &&
             r.dataset.pmDelivery;
    });
    const pmDelivery = matchedDelRow?.dataset.pmDelivery;
    if (pmDelivery) {
      const pmDate = new Date(pmDelivery + 'T00:00:00');
      rootAnchor[i] = thisChainEnd > pmDate ? thisChainEnd : pmDate;
    } else {
      rootAnchor[i] = dueDate ? (thisChainEnd > dueDate ? thisChainEnd : dueDate) : thisChainEnd;
    }
  });
  function getAnchor(idx) {
    let cur = idx;
    while (parentIdxMap[cur] !== null) cur = parentIdxMap[cur];
    return rootAnchor[cur];
  }

  const blockStart = {}, blockEnd = {};
  const reverseSorted = [...sortedIdxs].reverse();
  reverseSorted.forEach(i => {
    const children = sortedIdxs.filter(j => parentIdxMap[j] === i);
    if (!children.length) {
      const anchor  = getAnchor(i);
      blockEnd[i]   = new Date(anchor);
      blockStart[i] = subtractBusinessDays(anchor, blockDays[i]);
    } else {
      const earliest = children.reduce((e, j) => blockStart[j] < e ? blockStart[j] : e, blockStart[children[0]]);
      blockEnd[i]    = previousWorkDay(earliest);
      blockStart[i]  = subtractBusinessDays(blockEnd[i], blockDays[i]);
    }
  });

  // Axis ticks
  const ticks = [];
  const tickCur = new Date(startDate);
  tickCur.setDate(1); tickCur.setMonth(tickCur.getMonth() + 1);
  while (tickCur <= anchorDate) {
    const bd = countBusinessDays(startDate, tickCur);
    ticks.push({ label: tickCur.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }), pct: Math.min(100, (bd / scaleDays) * 100) });
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
  const totalSpanDays = countBusinessDays(earliestStart, anchorDate);
  const totalStartOffsetDays = countBusinessDays(startDate, earliestStart);
  const totalWidthPct = Math.min(100, (totalSpanDays / scaleDays) * 100);
  const totalLeftPct  = Math.max(0, (totalStartOffsetDays / scaleDays) * 100);
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

    const totalDays = blockDays[i];
    const widthPct  = Math.max(1, (totalDays / scaleDays) * 100);

    function daysAfter(idx) {
      const ch = sortedIdxs.filter(j => parentIdxMap[j] === idx);
      if (!ch.length) return 0;
      return Math.max(...ch.map(j => blockDays[j] + daysAfter(j)));
    }
    const thisAnchor      = getAnchor(i);
    const anchorGapDays   = countBusinessDays(thisAnchor, anchorDate);
    const rightOffsetPct  = ((daysAfter(i) + anchorGapDays) / scaleDays) * 100;
    const leftPct         = Math.max(0, 100 - widthPct - rightOffsetPct);

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

    html += `<div class="${rowClass}">
      <div style="width:150px;flex-shrink:0;font-size:${isChild?'10':'11'}px;color:rgba(255,255,255,${isChild?'.6':'.75'});font-family:Verdana,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;" title="${esc(product)}">${connectorHtml}<span style="overflow:hidden;text-overflow:ellipsis">${esc(product)}</span></div>
      <div class="${isChild?'gantt-nested-track':'gantt-track'}" style="position:relative">
        <div style="left:${leftPct}%;width:${widthPct}%;background:${color};position:absolute;top:0;bottom:0;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:${isChild?'9':'10'}px;font-weight:700;color:rgba(255,255,255,.9)" title="${esc(product)}: ${totalDays}d">
          ${widthPct > 8 ? totalDays + 'd' : ''}
        </div>
      </div>
      <div class="gantt-enddate" style="font-size:${isChild?'9':'10'}px;color:rgba(255,255,255,${isChild?'.4':'.55'});line-height:1.3">${(() => {
        if (parIdx !== null) return fmtDateShort(blockEnd[i]);
        const pmR = delRows.find(r => {
          const s = r.querySelector('select');
          const renewal = r.querySelector('.nr-btn.r-active') !== null;
          return s && s.value === product &&
                 renewal === (block.dataset.isrenewal === 'true') &&
                 r.dataset.pmDelivery;
        });
        if (!pmR) return fmtDateShort(blockEnd[i]);
        const pmD = new Date(pmR.dataset.pmDelivery + 'T00:00:00');
        const pmFmt = (pmD.getMonth()+1) + '/' + pmD.getDate();
        const prodDue = subtractBusinessDays(pmD, 10);
        return fmtDateShort(prodDue) + '<br><span style="color:rgba(255,160,80,.85);font-size:8px">Del: ' + pmFmt + '</span>';
      })()}</div>
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
